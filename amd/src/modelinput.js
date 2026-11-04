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
 * Mouse, touch and keyboard polygon modelling on a desktop or a phone.
 *
 * A click (or tap) selects, Shift adds, Alt+click selects an edge loop. With a tool chosen, a drag that
 * starts on the mesh uses the tool on the selection; a drag that starts beside the mesh, a modified drag,
 * the right and middle buttons, the wheel and pinches stay with the view (desktopinput's OrbitControls).
 *
 * Keys are the 'modelshortcuts' string. G, R, S, E, I, Ctrl+B and Ctrl+R start a gesture with no button
 * held: the pointer drives it, X, Y and Z lock the axis, a click or Enter confirms, Esc or a right click
 * cancels.
 *
 * Tools get sculpture-local points. The pointer is cast onto a plane through the selection's centre that
 * faces the camera, so the selection follows it at its own depth. A locked axis, or an extrusion's normal,
 * is followed along its line on screen; straight at the viewer, where the line has no length on screen, an
 * upward drag goes towards the viewer.
 *
 * The pointer and key listeners run in the capture phase, so they come before OrbitControls and
 * desktopinput (both listen on the same elements in the bubble phase) and can stop what is theirs.
 *
 * @module     mod_vrmakerspace/modelinput
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {isTyping} from 'mod_vrmakerspace/desktopinput';
import {pickRay} from 'mod_vrmakerspace/polypick';

/** How far a mouse may move (px) and it is still a click. */
const CLICK_SLOP = 5;

/** How far a finger may move (px) and it is still a tap. */
const TAP_SLOP = 10;

/** Pick tolerance of a mouse: distance from the ray per metre from the camera. */
const MOUSE_TOLERANCE = 0.02;

/** Pick tolerance of a finger. */
const TOUCH_TOLERANCE = 0.04;

/** Tolerance when an edge is wanted anywhere on the surface (loop cut, edge loop): the closest one wins. */
const EDGE_TOLERANCE = 0.15;

/** Radius of the marker on the mesh under the pointer (m). */
const MARKER_RADIUS = 0.004;

/** Below this share of its length on screen (squared), a line is treated as pointing at the viewer. */
const MIN_LINE_ON_SCREEN = 0.04;

/** Below this (cosine of the view and the axis) a turn about a locked axis is taken from a sideways drag. */
const MIN_AXIS_FACING = 0.2;

/** A sideways drag of this much (m) is one radian when the locked axis lies across the view. */
const TURN_RADIUS = 0.05;

/** Longest distance along a line one gesture goes (m): the mesh's whole extent. */
const MAX_LINE_TRAVEL = 0.8;

/** Unit vectors of the axis locks. */
const AXES = {x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]};

/** Key of each axis lock. */
const AXIS_KEYS = ['x', 'y', 'z'];

/** Actions a locked axis means something for. */
const AXIS_ACTIONS = ['move', 'rotate', 'scale', 'extrude'];

/** Actions that cancel cleanly and start again when the lock changes (undoing them keeps the selection). */
const RESTART_ACTIONS = ['move', 'rotate', 'scale'];

/** Keys that start a gesture with no button held. */
const GESTURE_KEYS = {g: 'move', r: 'rotate', s: 'scale', e: 'extrude', i: 'inset'};

/** Ctrl (or Cmd) keys that start a gesture with no button held. */
const COMMAND_GESTURE_KEYS = {b: 'bevel', r: 'loopcut'};

/** Keys that choose the select mode. */
const MODE_KEYS = {'1': 'v', '2': 'e', '3': 'f'};

/** Keys that run a one-shot command. */
const ONESHOT_KEYS = {'m': 'merge', 'x': 'delete', 'delete': 'delete', 'f': 'fill'};

/**
 * The dot product.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number}
 */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The cross product.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]}
 */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * A point moved along a vector.
 *
 * @param {number[]} p Point.
 * @param {number[]} v Vector.
 * @param {number} s How much of the vector.
 * @returns {number[]}
 */
const along = (p, v, s) => [p[0] + v[0] * s, p[1] + v[1] * s, p[2] + v[2] * s];

/**
 * The difference of two vectors.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]} a - b.
 */
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * A vector of length one.
 *
 * @param {number[]} v Vector.
 * @returns {number[]|null} Null for a vector of no length.
 */
const unit = (v) => {
    const length = Math.sqrt(dot(v, v));
    return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : null;
};

/**
 * Where a ray meets a plane.
 *
 * @param {Object} ray {origin, dir}
 * @param {number[]} point A point of the plane.
 * @param {number[]} normal The plane's normal.
 * @returns {number[]|null} Null when the ray runs along the plane or the plane is behind it.
 */
const planeHit = (ray, point, normal) => {
    const facing = dot(ray.dir, normal);
    if (Math.abs(facing) < 1e-6) {
        return null;
    }
    const t = dot(minus(point, ray.origin), normal) / facing;
    return t > 0 ? along(ray.origin, ray.dir, t) : null;
};

/**
 * The vertex indices (into data.vertIds) a selection names.
 *
 * @param {Object} data renderData.
 * @param {Object} selection {md, items}
 * @returns {Set<number>}
 */
const selectedIndices = (data, selection) => {
    const found = new Set();
    const wanted = new Set(selection.items);
    if (selection.md === 'f') {
        data.faceIds.forEach((id, face) => {
            if (wanted.has(id)) {
                for (let i = data.faceStart[face]; i < data.faceStart[face + 1]; i++) {
                    found.add(data.faceVerts[i]);
                }
            }
        });
    } else {
        data.vertIds.forEach((id, index) => {
            if (wanted.has(id)) {
                found.add(index);
            }
        });
    }
    return found;
};

/**
 * The centre of the selected vertices.
 *
 * @param {Object|null} data renderData.
 * @param {Object|null} selection {md, items}
 * @returns {number[]|null} Null when nothing selected is on show.
 */
export const selectionPivot = (data, selection) => {
    if (!data || !selection || !selection.items || !selection.items.length) {
        return null;
    }
    const indices = selectedIndices(data, selection);
    if (!indices.size) {
        return null;
    }
    const sum = [0, 0, 0];
    indices.forEach((index) => {
        sum[0] += data.vertPos[index * 3];
        sum[1] += data.vertPos[index * 3 + 1];
        sum[2] += data.vertPos[index * 3 + 2];
    });
    return [sum[0] / indices.size, sum[1] / indices.size, sum[2] / indices.size];
};

/**
 * The mean normal of the selected faces.
 *
 * @param {Object|null} data renderData.
 * @param {Object|null} selection {md, items}
 * @returns {number[]|null} Unit vector; null unless faces are selected and their normals do not cancel out.
 */
export const selectionNormal = (data, selection) => {
    if (!data || !selection || selection.md !== 'f' || !selection.items || !selection.items.length) {
        return null;
    }
    const wanted = new Set(selection.items);
    const faces = new Set();
    data.faceIds.forEach((id, face) => {
        if (wanted.has(id)) {
            faces.add(face);
        }
    });
    const sum = [0, 0, 0];
    data.triFace.forEach((face, triangle) => {
        if (faces.has(face)) {
            sum[0] += data.triNormal[triangle * 9];
            sum[1] += data.triNormal[triangle * 9 + 1];
            sum[2] += data.triNormal[triangle * 9 + 2];
        }
    });
    return unit(sum);
};

/**
 * Attach modelling input to the studio.
 *
 * @param {Object} options {THREE, canvas, camera, sculptureRoot, engine, model (modeltools), keyroot: the
 *     element whose keys are shortcuts}
 * @returns {Object} {setEnabled(on), update(dt), armLoop(), cursorPose(), detach()}
 */
export const attach = (options) => {
    const {THREE, canvas, camera, sculptureRoot, engine, model} = options;
    const keyroot = options.keyroot || canvas;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const work = new THREE.Vector3();
    const rootquat = new THREE.Quaternion();
    const cameraquat = new THREE.Quaternion();
    let enabled = true;
    let tolerance = MOUSE_TOLERANCE;
    let pointer = null;
    let pointerdirty = false;
    /** @type {boolean} whether the next click selects an edge loop */
    let looparmed = false;
    /** @type {Object|null} a button or finger that went down and may yet be a click */
    let press = null;
    /** @type {Object|null} the tool gesture going on: a held drag, or modal (no button held) */
    let gesture = null;
    let markervisible = false;

    // A small marker on the mesh under the pointer; its position is also the presence pose's tool cursor.
    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(MARKER_RADIUS, 12, 8),
        new THREE.MeshBasicMaterial({color: 0x1f6feb, depthTest: false, transparent: true, opacity: 0.8})
    );
    marker.name = 'vrmakerspace-modelcursor';
    marker.visible = false;
    marker.renderOrder = 3;
    // Never in the way of the sculpture's own picking.
    marker.raycast = () => undefined;
    sculptureRoot.add(marker);

    /**
     * Show the marker at a sculpture-local point, or hide it.
     *
     * @param {number[]|null} at The point.
     */
    const placeMarker = (at) => {
        markervisible = !!at;
        marker.visible = markervisible;
        if (at) {
            marker.position.set(at[0], at[1], at[2]);
        }
    };

    /**
     * The ray through a client position in the sculpture-local frame.
     *
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @returns {Object|null} {origin, dir}, or null when the canvas has no size.
     */
    const localRay = (x, y) => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        work.copy(raycaster.ray.origin);
        sculptureRoot.worldToLocal(work);
        const origin = [work.x, work.y, work.z];
        sculptureRoot.getWorldQuaternion(rootquat);
        rootquat.invert();
        work.copy(raycaster.ray.direction).applyQuaternion(rootquat).normalize();
        return {origin: origin, dir: [work.x, work.y, work.z]};
    };

    /**
     * A camera direction in the sculpture-local frame.
     *
     * @param {number} x Camera-frame x.
     * @param {number} y Camera-frame y.
     * @param {number} z Camera-frame z.
     * @returns {number[]}
     */
    const cameraDirection = (x, y, z) => {
        camera.getWorldQuaternion(cameraquat);
        sculptureRoot.getWorldQuaternion(rootquat);
        rootquat.invert();
        work.set(x, y, z).applyQuaternion(cameraquat).applyQuaternion(rootquat).normalize();
        return [work.x, work.y, work.z];
    };

    /**
     * Pick the mesh at a client position.
     *
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @param {string} mode 'v', 'e' or 'f'.
     * @param {number} [tol] Tolerance; the pointer's by default.
     * @returns {Object|null} polypick's result.
     */
    const pickAt = (x, y, mode, tol = tolerance) => {
        const data = engine.polydata();
        const ray = data ? localRay(x, y) : null;
        return ray ? pickRay(ray.origin, ray.dir, data, mode, tol) : null;
    };

    /**
     * Release a captured pointer.
     *
     * @param {number|null|undefined} id Pointer id.
     */
    const release = (id) => {
        if (id === null || id === undefined) {
            return;
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
     * Capture a pointer. A nicety: gestures also end when the document says the pointer went.
     *
     * @param {number} id Pointer id.
     */
    const capture = (id) => {
        try {
            canvas.setPointerCapture(id);
        } catch (e) {
            // Without capture the gesture still ends on pointerup over the canvas.
        }
    };

    /**
     * Work out how the pointer drives a gesture, for the tool and the axis lock in force now.
     *
     * @param {Object} g The gesture.
     */
    const setUpFrame = (g) => {
        g.view = cameraDirection(0, 0, 1);
        g.up = cameraDirection(0, 1, 0);
        const axis = model.axis ? AXES[model.axis] : null;
        const action = model.action;
        g.planenormal = g.view;
        g.line = null;
        g.turn = null;
        if (action === 'rotate' && axis) {
            if (Math.abs(dot(g.view, axis)) >= MIN_AXIS_FACING) {
                g.planenormal = axis;
            } else {
                const side = unit(cross(g.view, axis)) || g.up;
                const u = unit(cross(axis, side)) || g.view;
                g.turn = {side: side, u: u, w: cross(axis, u)};
            }
        } else if (action === 'move' || action === 'extrude') {
            g.line = axis || (action === 'extrude' ? g.normal : null);
        }
        const ray = localRay(g.startx, g.starty);
        g.anchor = (ray && planeHit(ray, g.pivot, g.planenormal)) || g.pivot;
    };

    /**
     * Where a point on a line goes for a point the pointer reached in the plane facing the camera.
     *
     * @param {Object} g The gesture.
     * @param {number[]} q The point in the plane.
     * @returns {number[]}
     */
    const onLine = (g, q) => {
        const moved = minus(q, g.anchor);
        const facing = dot(g.line, g.view);
        const onscreen = along(g.line, g.view, -facing);
        const length = dot(onscreen, onscreen);
        const travel = length >= MIN_LINE_ON_SCREEN ? dot(moved, onscreen) / length : dot(moved, g.up) * (facing < 0 ? -1 : 1);
        return along(g.anchor, g.line, Math.max(-MAX_LINE_TRAVEL, Math.min(MAX_LINE_TRAVEL, travel)));
    };

    /**
     * The sculpture-local point a gesture's pointer stands for.
     *
     * @param {Object} g The gesture.
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @returns {number[]|null} Null when the pointer is nowhere useful (keep the last point).
     */
    const gesturePoint = (g, x, y) => {
        const ray = localRay(x, y);
        const q = ray ? planeHit(ray, g.pivot, g.planenormal) : null;
        if (!q) {
            return null;
        }
        if (g.turn) {
            const angle = dot(minus(q, g.anchor), g.turn.side) / TURN_RADIUS;
            return along(along(g.pivot, g.turn.u, TURN_RADIUS * Math.cos(angle)), g.turn.w, TURN_RADIUS * Math.sin(angle));
        }
        return g.line ? onLine(g, q) : q;
    };

    /**
     * What goes with every point given to the tools.
     *
     * @param {Object} g The gesture.
     * @param {number} x Client x.
     * @param {number} y Client y.
     * @param {Object|null} hit The element under the pointer, when the tool wants one.
     * @returns {Object} {hit, ray, view}
     */
    const gestureOptions = (g, x, y, hit) => ({hit: hit || undefined, ray: localRay(x, y) || undefined, view: g.view});

    /**
     * Follow the pointer through the rest of the document while no button is held.
     *
     * @param {PointerEvent} event The event.
     */
    const onDocumentMove = (event) => {
        if (gesture) {
            gesture.x = event.clientX;
            gesture.y = event.clientY;
            pointerdirty = true;
        }
    };

    /**
     * A press anywhere but the canvas during a modal gesture calls it off.
     *
     * @param {PointerEvent} event The event.
     */
    const onDocumentDown = (event) => {
        if (gesture && gesture.modal && event.target !== canvas) {
            finishGesture(false);
        }
    };

    /** Leaving the window calls a modal gesture off: its keys could no longer reach it. */
    const onWindowBlur = () => {
        if (gesture && gesture.modal) {
            finishGesture(false);
        }
    };

    /** Stop following the document. */
    const stopFollowing = () => {
        document.removeEventListener('pointermove', onDocumentMove);
        document.removeEventListener('pointerdown', onDocumentDown, true);
        window.removeEventListener('blur', onWindowBlur);
    };

    /**
     * End the gesture going on.
     *
     * @param {boolean} confirm Whether it takes effect.
     */
    const finishGesture = (confirm) => {
        const g = gesture;
        if (!g) {
            return;
        }
        gesture = null;
        stopFollowing();
        release(g.pointerid);
        if (g.begun && model.active) {
            if (confirm) {
                model.end();
            } else {
                model.cancel();
            }
        }
        if (model.axis !== g.previousaxis) {
            model.setAxis(g.previousaxis);
        }
        if (model.action !== g.previousaction) {
            model.setAction(g.previousaction);
        }
        pointerdirty = true;
    };

    /**
     * Tell the tools to begin, for a gesture that was set up.
     *
     * @param {Object} g The gesture.
     * @returns {boolean} Whether the tools went ahead.
     */
    const beginTool = (g) => {
        const p = gesturePoint(g, g.startx, g.starty) || g.anchor;
        model.begin(p, gestureOptions(g, g.startx, g.starty, null));
        g.begun = !!model.active;
        return g.begun;
    };

    /**
     * Start a tool gesture.
     *
     * @param {string} action The tool.
     * @param {number} x Client x it starts from.
     * @param {number} y Client y it starts from.
     * @param {Object} how {modal: boolean, pointerid: number|null, surface: the mesh hit there or null}
     * @returns {boolean} Whether it runs.
     */
    const startGesture = (action, x, y, how) => {
        const previousaction = model.action;
        if (previousaction !== action) {
            model.setAction(action);
        }
        const data = engine.polydata();
        const selection = model.selection();
        const surface = how.surface || null;
        const g = {
            modal: !!how.modal,
            pointerid: how.pointerid === undefined ? null : how.pointerid,
            startx: x,
            starty: y,
            x: x,
            y: y,
            previousaction: previousaction,
            previousaxis: model.axis,
            pivot: selectionPivot(data, selection) || (surface ? surface.point : null) || [0, 0, 0],
            normal: action === 'extrude' ? selectionNormal(data, selection) : null,
            begun: false,
        };
        setUpFrame(g);
        gesture = g;
        if (action === 'loopcut') {
            // A loop cut begins once an edge is under the pointer: here, or on the way in for a key.
            driveGesture(g);
        } else if (!beginTool(g)) {
            finishGesture(false);
            return false;
        }
        if (g.modal) {
            document.addEventListener('pointermove', onDocumentMove);
            document.addEventListener('pointerdown', onDocumentDown, true);
            window.addEventListener('blur', onWindowBlur);
        }
        pointerdirty = true;
        return true;
    };

    /**
     * Change the axis lock during a gesture (the same key again frees it).
     *
     * Move, rotate and scale start over under the new lock, so what was done under the last one does not
     * stay. An extrusion keeps its new faces and goes on.
     *
     * @param {string} name 'x', 'y' or 'z'.
     */
    const changeAxis = (name) => {
        const g = gesture;
        const action = model.action;
        if (!g || !AXIS_ACTIONS.includes(action)) {
            return;
        }
        const next = model.axis === name ? null : name;
        const restart = g.begun && RESTART_ACTIONS.includes(action);
        if (restart) {
            model.cancel();
            g.begun = false;
        }
        model.setAxis(next);
        setUpFrame(g);
        if (restart && !beginTool(g)) {
            finishGesture(false);
            return;
        }
        pointerdirty = true;
    };

    /**
     * Feed the pointer's latest position to the tools.
     *
     * @param {Object} g The gesture.
     */
    const driveGesture = (g) => {
        if (model.action === 'loopcut') {
            const surface = pickAt(g.x, g.y, 'f');
            const edge = surface ? pickAt(g.x, g.y, 'e', EDGE_TOLERANCE) : null;
            if (!edge) {
                return;
            }
            placeMarker(surface.point);
            if (g.begun) {
                model.move(surface.point, gestureOptions(g, g.x, g.y, edge));
            } else {
                model.begin(surface.point, gestureOptions(g, g.x, g.y, edge));
                g.begun = !!model.active;
            }
            return;
        }
        const p = gesturePoint(g, g.x, g.y);
        if (p) {
            model.move(p, gestureOptions(g, g.x, g.y, null));
        }
    };

    /**
     * A click or tap: select, add to the selection, select a loop, or let go of the selection.
     *
     * @param {Object} click {x, y, add, loop}
     */
    const onClickAt = (click) => {
        if (click.loop || looparmed) {
            looparmed = false;
            const edge = pickAt(click.x, click.y, 'e', EDGE_TOLERANCE);
            if (edge) {
                model.selectLoop(edge);
            }
            return;
        }
        const hit = pickAt(click.x, click.y, model.selectMode);
        if (hit) {
            model.selectHit(hit, {add: click.add});
            return;
        }
        // On the mesh between elements nothing happens; only a click beside it lets go of the selection.
        if (!click.add && !pickAt(click.x, click.y, 'f')) {
            const selection = model.selection();
            if (selection && selection.items && selection.items.length) {
                model.selectNone();
            }
        }
    };

    /**
     * Turn a held press into a tool drag, once it has moved far enough to be one.
     *
     * With nothing selected, what the drag started on is selected first, so a first drag does something.
     *
     * @param {Object} held The press.
     */
    const dragFromPress = (held) => {
        const selection = model.selection();
        if (!selection || !selection.items || !selection.items.length) {
            const hit = pickAt(held.x, held.y, model.selectMode);
            if (hit) {
                model.selectHit(hit, {add: false});
            }
        }
        if (!startGesture(model.action, held.x, held.y, {pointerid: held.pointerid, surface: held.surface})) {
            release(held.pointerid);
        }
    };

    /**
     * Stop an event from reaching the view controls and the sculpting input.
     *
     * @param {Event} event The event.
     */
    const keepEvent = (event) => {
        event.stopImmediatePropagation();
        event.preventDefault();
    };

    /**
     * A button or finger went down.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerDown = (event) => {
        if (!enabled) {
            return;
        }
        canvas.focus({preventScroll: true});
        tolerance = event.pointerType === 'touch' ? TOUCH_TOLERANCE : MOUSE_TOLERANCE;
        if (gesture && gesture.modal) {
            keepEvent(event);
            finishGesture(event.button === 0);
            return;
        }
        if (gesture || press) {
            // A second finger: call off what the first one started and leave the view controls the gesture.
            if (press) {
                release(press.pointerid);
                press = null;
            }
            finishGesture(false);
            return;
        }
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        const plain = !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey);
        press = {
            pointerid: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            slop: event.pointerType === 'touch' ? TAP_SLOP : CLICK_SLOP,
            add: event.shiftKey,
            loop: event.altKey,
            held: false,
            surface: null,
        };
        const action = model.action;
        if (!plain || looparmed || action === 'select') {
            return;
        }
        const surface = pickAt(event.clientX, event.clientY, 'f', 0);
        if (!surface) {
            return;
        }
        keepEvent(event);
        capture(event.pointerId);
        if (action === 'loopcut') {
            press = null;
            startGesture(action, event.clientX, event.clientY, {pointerid: event.pointerId, surface: surface});
            return;
        }
        press.held = true;
        press.surface = surface;
    };

    /**
     * Remember where the pointer is; the frame update does the raycasting.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerMove = (event) => {
        if (!enabled) {
            return;
        }
        if (gesture) {
            if (gesture.pointerid === null || gesture.pointerid === event.pointerId) {
                pointer = {x: event.clientX, y: event.clientY};
                gesture.x = event.clientX;
                gesture.y = event.clientY;
                pointerdirty = true;
            }
            return;
        }
        pointer = {x: event.clientX, y: event.clientY};
        pointerdirty = true;
        if (press && press.pointerid === event.pointerId) {
            const dx = event.clientX - press.x;
            const dy = event.clientY - press.y;
            if (dx * dx + dy * dy > press.slop * press.slop) {
                const moved = press;
                press = null;
                if (moved.held) {
                    dragFromPress(moved);
                }
            }
        }
    };

    /**
     * A button or finger came up.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerUp = (event) => {
        if (!enabled) {
            return;
        }
        if (gesture && !gesture.modal && gesture.pointerid === event.pointerId) {
            finishGesture(true);
            return;
        }
        if (press && press.pointerid === event.pointerId) {
            const click = press;
            press = null;
            release(click.pointerid);
            onClickAt(click);
        }
    };

    /**
     * The browser took a pointer away: nothing it started takes effect.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerCancel = (event) => {
        if (gesture && !gesture.modal && gesture.pointerid === event.pointerId) {
            finishGesture(false);
        }
        if (press && press.pointerid === event.pointerId) {
            release(press.pointerid);
            press = null;
        }
    };

    /** Hide the marker when the pointer leaves the canvas (and no gesture is going on). */
    const onPointerLeave = () => {
        if (!gesture && !press) {
            pointer = null;
            placeMarker(null);
        }
    };

    /**
     * Keys while a gesture goes on: axis locks, confirm and cancel. Nothing else reaches the studio.
     *
     * @param {KeyboardEvent} event The event.
     */
    const gestureKey = (event) => {
        const key = event.key.toLowerCase();
        event.stopPropagation();
        const command = event.ctrlKey || event.metaKey;
        if (key === 'escape') {
            finishGesture(false);
        } else if (key === 'enter' && gesture.modal) {
            finishGesture(true);
        } else if (!command && !event.altKey && !event.repeat && AXIS_KEYS.includes(key)) {
            changeAxis(key);
        } else if (!(key === 'tab' || (command && (key === 'z' || key === 'y')))) {
            return;
        }
        event.preventDefault();
    };

    /**
     * Run a Ctrl (or Cmd) shortcut.
     *
     * @param {string} key The key, lower case.
     * @returns {boolean} Whether it was one of ours.
     */
    const commandKey = (key) => {
        const action = COMMAND_GESTURE_KEYS[key];
        if (!action) {
            return false;
        }
        startKeyGesture(action);
        return true;
    };

    /**
     * Start a gesture from the keyboard, from where the pointer is (the canvas's middle when it is elsewhere).
     *
     * @param {string} action The tool.
     */
    const startKeyGesture = (action) => {
        let at = pointer;
        if (!at) {
            const rect = canvas.getBoundingClientRect();
            at = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        }
        startGesture(action, at.x, at.y, {modal: true, pointerid: null, surface: pickAt(at.x, at.y, 'f', 0)});
    };

    /**
     * Run a shortcut without Ctrl.
     *
     * @param {string} key The key, lower case.
     * @returns {boolean} Whether it was one of ours.
     */
    const plainKey = (key) => {
        if (GESTURE_KEYS[key]) {
            startKeyGesture(GESTURE_KEYS[key]);
        } else if (MODE_KEYS[key]) {
            model.setSelectMode(MODE_KEYS[key]);
        } else if (ONESHOT_KEYS[key]) {
            model.runOneShot(ONESHOT_KEYS[key]);
        } else if (key === 'a') {
            model.selectAll();
        } else if (key === 'l') {
            model.selectLinked();
        } else if (key === 'escape' && looparmed) {
            looparmed = false;
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
        if (!enabled || event.defaultPrevented || isTyping(event.target)) {
            return;
        }
        if (event.target.closest && event.target.closest('[role="alertdialog"]')) {
            return;
        }
        if (gesture) {
            gestureKey(event);
            return;
        }
        if (event.shiftKey) {
            return;
        }
        const key = event.key.toLowerCase();
        let handled = false;
        if (event.ctrlKey || event.metaKey) {
            handled = !event.altKey && commandKey(key);
        } else if (event.altKey) {
            if (key === 'a') {
                model.selectNone();
                handled = true;
            }
        } else if (event.repeat) {
            // Holding a key down never repeats a command; it still counts as ours when the key is.
            handled = !!(GESTURE_KEYS[key] || MODE_KEYS[key] || ONESHOT_KEYS[key] || key === 'a' || key === 'l');
        } else {
            handled = plainKey(key);
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    };

    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('pointermove', onPointerMove, true);
    canvas.addEventListener('pointerup', onPointerUp, true);
    canvas.addEventListener('pointercancel', onPointerCancel, true);
    canvas.addEventListener('pointerleave', onPointerLeave);
    keyroot.addEventListener('keydown', onKeyDown, true);

    /** Let go of whatever is going on. */
    const reset = () => {
        if (press) {
            release(press.pointerid);
            press = null;
        }
        finishGesture(false);
        looparmed = false;
        pointer = null;
        placeMarker(null);
    };

    return {
        /**
         * Per frame: the gesture's pointer position, or the marker under the pointer (one raycast per frame).
         */
        update: () => {
            if (!enabled) {
                return;
            }
            if (gesture) {
                if (gesture.begun && !model.active) {
                    // The tools refused to go on (someone else's selection): drop the gesture.
                    finishGesture(false);
                } else if (pointerdirty) {
                    pointerdirty = false;
                    driveGesture(gesture);
                }
                return;
            }
            if (pointerdirty) {
                pointerdirty = false;
                const surface = pointer ? pickAt(pointer.x, pointer.y, 'f', 0) : null;
                placeMarker(surface ? surface.point : null);
            }
        },

        /**
         * Turn modelling input on or off (off in the Sculpt method and in VR).
         *
         * @param {boolean} on Whether it is on.
         */
        setEnabled: (on) => {
            const value = !!on;
            if (value === enabled) {
                return;
            }
            if (!value) {
                reset();
            }
            enabled = value;
        },

        /** The next click or tap selects the edge loop at that place (for the toolbar's button). */
        armLoop: () => {
            looparmed = true;
        },

        /**
         * The tool cursor as a pose for presence, sculpture-local.
         *
         * @returns {number[]|null} [x, y, z, qx, qy, qz, qw], or null when it is hidden.
         */
        cursorPose: () => (markervisible
            ? [marker.position.x, marker.position.y, marker.position.z, 0, 0, 0, 1] : null),

        /** Remove every listener and the marker. */
        detach: () => {
            reset();
            canvas.removeEventListener('pointerdown', onPointerDown, true);
            canvas.removeEventListener('pointermove', onPointerMove, true);
            canvas.removeEventListener('pointerup', onPointerUp, true);
            canvas.removeEventListener('pointercancel', onPointerCancel, true);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            keyroot.removeEventListener('keydown', onKeyDown, true);
            sculptureRoot.remove(marker);
            marker.geometry.dispose();
            marker.material.dispose();
        },
    };
};
