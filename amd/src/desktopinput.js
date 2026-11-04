// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Mouse, touch and keyboard sculpting on a desktop or a phone.
 *
 * A left-button drag (or one finger) that starts on the sculpture sculpts with the current tool; one
 * that starts beside it turns the view, as do the right button and the arrow keys. The middle button
 * pans and the wheel (or a pinch) zooms (three.js OrbitControls). The brushes (add, carve, smooth,
 * inflate, pinch, flatten) follow the surface under the pointer, grab moves the grabbed clay in the
 * plane facing the camera, twist turns it about the view axis by dragging sideways. A click with a
 * shape tool places the shape on the surface (or, beside the sculpture, in the plane through the
 * view's centre facing the camera). A see-through sphere of the brush radius shows where the tool
 * works.
 *
 * Keyboard shortcuts (the 'shortcuts' string) work while the focus is anywhere in the studio except
 * in a text field, so typing elsewhere on the page is never taken over.
 *
 * @module     mod_vrmakerspace/desktopinput
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {SHAPE_TOOLS, TOOLS} from 'mod_vrmakerspace/tools';

/** Twist angle per pixel of sideways drag (rad). */
const TWIST_PER_PIXEL = 0.01;

/** Brush size step of the [ and ] keys (factor). */
const SIZE_STEP = 1.2;

/** Strength step of the comma and full stop keys. */
const STRENGTH_STEP = 0.1;

/** Colour of the tool cursor per tool. */
const CURSOR_COLOURS = {
    grab: 0x1f6feb,
    twist: 0x8250df,
    add: 0x1a7f37,
    carve: 0xcf222e,
    smooth: 0x9a6700,
    inflate: 0x1b7c83,
    pinch: 0xbf3989,
    flatten: 0x57606a,
    shape: 0x1a7f37,
    cutshape: 0xcf222e,
};

/** Input types that take typed text (keys pressed there are never shortcuts). */
const TEXT_INPUTS = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local',
    'month', 'time', 'week'];

/**
 * Whether a key event comes from a place where the user types text.
 *
 * @param {EventTarget} target The event target.
 * @returns {boolean}
 */
const isTyping = (target) => {
    if (!target || !target.tagName) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') {
        return true;
    }
    return tag === 'input' && TEXT_INPUTS.includes(String(target.type || 'text').toLowerCase());
};

/**
 * Attach desktop input to the studio.
 *
 * @param {Object} options {THREE, canvas, camera, sculptureRoot, engine, tools (null when read-only),
 *     keyroot: the element whose keys are shortcuts, target: [x, y, z] the view turns around}
 * @returns {Object} {controls, update(dt), setEnabled(enabled), cursorPose(), detach()}
 */
export const attach = (options) => {
    const {THREE, canvas, camera, sculptureRoot, engine} = options;
    const tools = options.tools || null;
    const keyroot = options.keyroot || canvas;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hits = [];
    const world = new THREE.Vector3();
    const local = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const rootquat = new THREE.Quaternion();
    const plane = new THREE.Plane();
    const normal = new THREE.Vector3();
    const normalmatrix = new THREE.Matrix3();
    let enabled = true;
    let pointer = null;
    let pointerdirty = false;
    /** @type {Object|null} the stroke the pointer drives */
    let drag = null;
    let cursorvisible = false;
    /** @type {Object|null} the view controls (OrbitControls), made once the listeners are in place */
    let controls = null;

    // The tool cursor.
    const cursor = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({color: CURSOR_COLOURS.add, wireframe: true, transparent: true, opacity: 0.4,
            depthWrite: false})
    );
    cursor.name = 'vrmakerspace-cursor';
    cursor.visible = false;
    cursor.renderOrder = 2;
    sculptureRoot.add(cursor);

    /**
     * Put the pointer's position into normalised device coordinates.
     *
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @returns {boolean} Whether the canvas has a size.
     */
    const toNdc = (x, y) => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }
        ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
        return true;
    };

    /**
     * Raycast the sculpture at a client position.
     *
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @returns {boolean} Whether it was hit; the hit is in `world` and, sculpture-local, in `local`.
     */
    const pick = (x, y) => {
        if (!toNdc(x, y)) {
            return false;
        }
        raycaster.setFromCamera(ndc, camera);
        hits.length = 0;
        raycaster.intersectObjects(engine.meshes(), false, hits);
        if (hits.length === 0) {
            return false;
        }
        world.copy(hits[0].point);
        local.copy(world);
        sculptureRoot.worldToLocal(local);
        // The face normal, from the chunk mesh's frame to the world's, then to the sculpture's.
        if (hits[0].face) {
            normalmatrix.getNormalMatrix(hits[0].object.matrixWorld);
            normal.copy(hits[0].face.normal).applyMatrix3(normalmatrix);
            sculptureRoot.getWorldQuaternion(rootquat);
            normal.applyQuaternion(rootquat.invert()).normalize();
        } else {
            normal.set(0, 0, 0);
        }
        return true;
    };

    /**
     * Where a click beside the sculpture places a shape: the plane through the view's centre facing
     * the camera.
     *
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @returns {boolean} Whether the point was found; it is in `world` and `local`, `normal` faces the viewer.
     */
    const pickInSpace = (x, y) => {
        if (!toNdc(x, y)) {
            return false;
        }
        raycaster.setFromCamera(ndc, camera);
        camera.getWorldDirection(direction);
        if (!controls) {
            return false;
        }
        plane.setFromNormalAndCoplanarPoint(direction, controls.target);
        if (!raycaster.ray.intersectPlane(plane, world)) {
            return false;
        }
        local.copy(world);
        sculptureRoot.worldToLocal(local);
        const axis = viewAxis();
        normal.set(axis[0], axis[1], axis[2]).normalize();
        return true;
    };

    /**
     * The view direction in the sculpture-local frame, pointing at the viewer.
     *
     * @returns {number[]} [x, y, z]
     */
    const viewAxis = () => {
        camera.getWorldDirection(direction);
        sculptureRoot.getWorldQuaternion(rootquat);
        rootquat.invert();
        direction.applyQuaternion(rootquat).negate();
        return [direction.x, direction.y, direction.z];
    };

    /**
     * Show the cursor at a sculpture-local point.
     *
     * @param {Object} at THREE.Vector3, sculpture-local.
     */
    const showCursor = (at) => {
        if (!tools) {
            return;
        }
        cursor.position.copy(at);
        cursor.scale.setScalar(Math.max(0.001, tools.cursorRadius()));
        cursor.material.color.setHex(CURSOR_COLOURS[tools.tool] || CURSOR_COLOURS.add);
        cursor.visible = true;
        cursorvisible = true;
    };

    /** Hide the cursor. */
    const hideCursor = () => {
        cursor.visible = false;
        cursorvisible = false;
    };

    /**
     * End the stroke the pointer drives.
     */
    const endDrag = () => {
        if (!drag) {
            return;
        }
        const id = drag.pointerId;
        drag = null;
        if (tools) {
            tools.end();
        }
        try {
            if (canvas.hasPointerCapture(id)) {
                canvas.releasePointerCapture(id);
            }
        } catch (e) {
            // The pointer may be gone already.
        }
    };

    /**
     * Start sculpting where the pointer went down, when it is on the sculpture.
     *
     * Registered before OrbitControls, so a stroke stops the event before the controls see it.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerDown = (event) => {
        canvas.focus({preventScroll: true});
        if (!enabled || !tools) {
            return;
        }
        if (drag) {
            // A second finger: stop sculpting and let the view controls have the gesture.
            endDrag();
            return;
        }
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
            // Modified left drags pan or turn the view (OrbitControls).
            return;
        }
        const tool = tools.tool;
        const shapetool = SHAPE_TOOLS.includes(tool);
        if (!pick(event.clientX, event.clientY) && !(shapetool && pickInSpace(event.clientX, event.clientY))) {
            return;
        }
        const opts = tool === 'twist' ? {axis: viewAxis()} : {};
        if (normal.lengthSq() > 0) {
            opts.normal = [normal.x, normal.y, normal.z];
        }
        if (!tools.begin([local.x, local.y, local.z], opts)) {
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        camera.getWorldDirection(direction);
        plane.setFromNormalAndCoplanarPoint(direction, world);
        drag = {
            pointerId: event.pointerId,
            tool: tool,
            startx: event.clientX,
            start: local.clone(),
            axis: opts.axis || null,
            x: event.clientX,
            y: event.clientY,
        };
        pointer = {x: event.clientX, y: event.clientY};
        pointerdirty = true;
        try {
            canvas.setPointerCapture(event.pointerId);
        } catch (e) {
            // Capture is a nicety: strokes still end on pointerup.
        }
        showCursor(local);
    };

    /**
     * Remember where the pointer is; the frame update does the raycasting.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerMove = (event) => {
        if (drag && event.pointerId !== drag.pointerId) {
            return;
        }
        pointer = {x: event.clientX, y: event.clientY};
        pointerdirty = true;
        if (drag) {
            drag.x = event.clientX;
            drag.y = event.clientY;
        }
    };

    /**
     * End a stroke when its pointer is released.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerUp = (event) => {
        if (drag && event.pointerId === drag.pointerId) {
            endDrag();
        }
    };

    /** Hide the cursor when the pointer leaves the canvas (and no stroke is going on). */
    const onPointerLeave = () => {
        if (!drag) {
            pointer = null;
            hideCursor();
        }
    };

    /**
     * A Ctrl (or Cmd) shortcut: undo and redo.
     *
     * @param {KeyboardEvent} event The event.
     * @returns {boolean} Whether it was one of ours.
     */
    const commandKey = (event) => {
        const key = event.key.toLowerCase();
        if (key === 'z' && event.shiftKey) {
            tools.redo();
        } else if (key === 'z' || key === 'y') {
            if (key === 'y') {
                tools.redo();
            } else {
                tools.undo();
            }
        } else {
            return false;
        }
        return true;
    };

    /** Plain shortcut keys: key -> action. */
    const PLAIN_KEYS = {
        '[': () => tools.setSize(tools.size / SIZE_STEP),
        ']': () => tools.setSize(tools.size * SIZE_STEP),
        ',': () => tools.setStrength(tools.strength - STRENGTH_STEP),
        '.': () => tools.setStrength(tools.strength + STRENGTH_STEP),
        'm': () => tools.setMirror(!tools.mirror),
        'M': () => tools.setMirror(!tools.mirror),
    };

    /**
     * A shortcut without Ctrl: a tool number, size, strength or Escape.
     *
     * @param {string} key The key.
     * @returns {boolean} Whether it was one of ours.
     */
    const plainKey = (key) => {
        if (key.length === 1 && key >= '0' && key <= '9' && TOOLS[(Number(key) + 9) % 10]) {
            // 1–9 are the first nine tools, 0 the tenth.
            tools.setTool(TOOLS[(Number(key) + 9) % 10]);
        } else if (PLAIN_KEYS[key]) {
            PLAIN_KEYS[key]();
        } else if (key === 'Escape' && drag) {
            endDrag();
        } else {
            return false;
        }
        return true;
    };

    /**
     * Keyboard shortcuts.
     *
     * @param {KeyboardEvent} event The event.
     */
    const onKeyDown = (event) => {
        if (!enabled || !tools || event.defaultPrevented || event.altKey || isTyping(event.target)) {
            return;
        }
        const handled = (event.ctrlKey || event.metaKey) ? commandKey(event) : plainKey(event.key);
        if (handled) {
            event.preventDefault();
            if (cursorvisible) {
                cursor.scale.setScalar(Math.max(0.001, tools.cursorRadius()));
                cursor.material.color.setHex(CURSOR_COLOURS[tools.tool] || CURSOR_COLOURS.add);
            }
        }
    };

    // Our pointerdown listener must come first: it stops the events of a stroke before OrbitControls.
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    keyroot.addEventListener('keydown', onKeyDown);

    controls = new THREE.OrbitControls(camera, canvas);
    const target = Array.isArray(options.target) ? options.target : [0, 1, 0];
    controls.target.set(target[0], target[1], target[2]);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 0.15;
    controls.maxDistance = 3;
    controls.zoomSpeed = 0.8;
    controls.mouseButtons = {LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE};
    controls.touches = {ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN};
    controls.listenToKeyEvents(canvas);
    controls.update();

    return {
        controls: controls,

        /**
         * Per frame: view damping, then the raycast of the last pointer position (one per frame).
         *
         * @param {number} dt Seconds since the last frame.
         */
        update: (dt) => {
            if (!enabled) {
                return;
            }
            controls.update(dt);
            if (!tools || !pointer || !pointerdirty) {
                return;
            }
            pointerdirty = false;
            if (!drag) {
                if (pick(pointer.x, pointer.y)) {
                    showCursor(local);
                } else {
                    hideCursor();
                }
                return;
            }
            if (drag.tool === 'grab') {
                if (!toNdc(drag.x, drag.y)) {
                    return;
                }
                raycaster.setFromCamera(ndc, camera);
                if (raycaster.ray.intersectPlane(plane, world)) {
                    local.copy(world);
                    sculptureRoot.worldToLocal(local);
                    tools.move([local.x, local.y, local.z]);
                    showCursor(local);
                }
            } else if (drag.tool === 'twist') {
                const angle = -(drag.x - drag.startx) * TWIST_PER_PIXEL;
                tools.move([drag.start.x, drag.start.y, drag.start.z], {axis: drag.axis, angle: angle});
                showCursor(drag.start);
            } else if (pick(drag.x, drag.y)) {
                tools.move([local.x, local.y, local.z]);
                showCursor(local);
            }
            if (!tools.active) {
                // The tools refused to go on (someone else's region): drop the stroke.
                endDrag();
            }
        },

        /**
         * Turn desktop input on or off (off while in VR).
         *
         * @param {boolean} on Whether it is on.
         */
        setEnabled: (on) => {
            const value = !!on;
            if (value === enabled) {
                return;
            }
            enabled = value;
            controls.enabled = value;
            if (!value) {
                endDrag();
                hideCursor();
            }
        },

        /**
         * The tool cursor as a pose for presence, sculpture-local.
         *
         * @returns {number[]|null} [x, y, z, qx, qy, qz, qw], or null when the cursor is hidden.
         */
        cursorPose: () => (cursorvisible
            ? [cursor.position.x, cursor.position.y, cursor.position.z, 0, 0, 0, 1] : null),

        /** Remove every listener and the cursor. */
        detach: () => {
            endDrag();
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('pointercancel', onPointerUp);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            keyroot.removeEventListener('keydown', onKeyDown);
            controls.dispose();
            sculptureRoot.remove(cursor);
            cursor.geometry.dispose();
            cursor.material.dispose();
        },
    };
};
