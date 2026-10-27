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
 * Sculpting in WebXR: immersive VR with two controllers or tracked hands.
 *
 * Controls (right hand sculpts, left hand holds):
 * - right trigger (value above 0.1): sculpt with the current tool at the tool tip, a cursor sphere
 *   6 cm ahead of the grip whose radius is the brush radius; the strength follows the trigger;
 * - right thumbstick: up and down change the size, left and right the strength (while held);
 * - A and B (right buttons 4 and 5): previous and next tool;
 * - X and Y (left buttons 4 and 5): undo and redo;
 * - left grip (squeeze): holds the sculpture and moves and turns it with the controller (only for
 *   this person: the sculpture's placement is never shared);
 * - twist turns the clay round the controller's forward axis by the controller's roll; grab pulls
 *   the clay along with the tool tip;
 * - hands: an index-thumb pinch (below 1.5 cm) of the right hand sculpts at the index tip, a pinch
 *   of the left hand holds the sculpture, and the right index tip touches the palette;
 * - the wrist palette (mod_vrsculpt/vrpalette) above the left hand: point the right controller at
 *   it and pull the trigger, or touch it with the right index tip.
 *
 * View only: no cursor and no tools; the sculpture can still be moved, and the palette offers
 * Exit VR.
 *
 * The update runs in the render loop and allocates no objects per frame: vectors, matrices, the
 * point and options handed to the tools and the pose handed out are all reused.
 *
 * Controller models are drawn here (a small grip box), not loaded: XRControllerModelFactory would
 * fetch models from a CDN; hands use XRHandModelFactory's 'spheres' profile, which is procedural.
 * The controller set-up follows vrroomruntime_builtin/xrinput (itself after mod_gear's viewer).
 *
 * @module     mod_vrsculpt/xrsculpt
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';
import {createXr, detect} from 'vrroomruntime_builtin/xr';
import {createPalette, TOOLS, SIZE_MIN, SIZE_MAX} from 'mod_vrsculpt/vrpalette';

/** Distance of the tool tip ahead of the grip (m). */
const TIP = 0.06;

/** On entering VR the sculpture is placed this far in front of the head (m) … */
const PLACE_DISTANCE = 0.45;

/** … and this far below the eyes (m), but never lower than PLACE_LOWEST above the floor. */
const PLACE_DROP = 0.25;
const PLACE_LOWEST = 0.3;

/** Trigger value that starts a stroke, and the value below which it ends. */
const TRIGGER_ON = 0.1;
const TRIGGER_OFF = 0.05;

/** Squeeze value that holds the sculpture, and the value below which it lets go. */
const SQUEEZE_ON = 0.5;
const SQUEEZE_OFF = 0.35;

/** Index-thumb distance that is a pinch, and the distance that ends it (m). */
const PINCH_ON = 0.015;
const PINCH_OFF = 0.025;

/** Thumbstick deflection below which it does nothing. */
const STICK_DEAD = 0.2;

/** Size change: e-folds per second at full deflection. */
const SIZE_RATE = 1.2;

/** Strength change per second at full deflection. */
const STRENGTH_RATE = 0.6;

/** Furthest the controller ray selects on the palette (m). */
const PALETTE_REACH = 0.8;

/** A fingertip this close to the palette's plane touches it (m). */
const TOUCH_DEPTH = 0.012;

/** Largest twist angle handed over per update (rad), as the op format allows per op. */
const TWIST_MAX = 0.5;

/** Gamepad button indices (xr-standard mapping). */
const BUTTON_TRIGGER = 0;
const BUTTON_SQUEEZE = 1;
const BUTTON_LOWER = 4;
const BUTTON_UPPER = 5;

/** Cursor colour of each tool. */
const TOOL_COLOURS = Object.freeze({
    grab: 0xf2c94c,
    twist: 0xb07cd8,
    add: 0x6fcf97,
    carve: 0xeb5757,
    smooth: 0x56ccf2,
});

/**
 * A raycast that never hits (the XR visuals must not be picked by the desktop input).
 *
 * @returns {undefined}
 */
const noRaycast = () => undefined;

/**
 * A number limited to a range.
 *
 * @param {number} value Value.
 * @param {number} min Smallest.
 * @param {number} max Largest.
 * @returns {number}
 */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * A thumbstick deflection with the dead zone taken out, rescaled to -1..1.
 *
 * @param {number} value Raw axis value.
 * @returns {number}
 */
const deflection = (value) => {
    const v = Number(value) || 0;
    const magnitude = Math.abs(v);
    if (magnitude <= STICK_DEAD) {
        return 0;
    }
    return Math.sign(v) * Math.min(1, (magnitude - STICK_DEAD) / (1 - STICK_DEAD));
};

/**
 * Whether a gamepad button is pressed.
 *
 * @param {Object|null} gamepad Gamepad.
 * @param {number} index Button index.
 * @returns {boolean}
 */
const buttonPressed = (gamepad, index) => !!(gamepad && gamepad.buttons && gamepad.buttons[index] &&
    gamepad.buttons[index].pressed);

/**
 * The analogue value of a gamepad button.
 *
 * @param {Object|null} gamepad Gamepad.
 * @param {number} index Button index.
 * @returns {number} 0..1
 */
const buttonValue = (gamepad, index) => {
    const button = gamepad && gamepad.buttons ? gamepad.buttons[index] : null;
    if (!button) {
        return 0;
    }
    const value = Number(button.value);
    if (Number.isFinite(value) && value > 0) {
        return clamp(value, 0, 1);
    }
    return button.pressed ? 1 : 0;
};

/**
 * Create the VR sculpting controller.
 *
 * Options: THREE (namespace with XRHandModelFactory), renderer (WebGLRenderer with xr.enabled),
 * scene (no transform of its own), camera, sculptureRoot (Group holding the sculpture),
 * tools (mod_vrsculpt/tools, ignored when readonly), readonly, strings (the mod_vrsculpt strings
 * by key), onStart() and onEnd() (optional, when a VR session starts and ends).
 *
 * getPose() returns one reused object whose arrays change every frame; it is meant to be encoded
 * at once (session.sendPose()).
 *
 * @param {Object} options Options.
 * @returns {Object} XrSculpt {available: Promise<boolean>, enter(), exit(), active, update(dt, frame), getPose(), dispose()}
 */
export const createXrSculpt = (options = {}) => {
    const THREE = options.THREE;
    const renderer = options.renderer;
    const scene = options.scene;
    const root = options.sculptureRoot;
    const tools = options.readonly ? null : (options.tools || null);

    // Reused maths objects.
    const yaxis = new THREE.Vector3(0, 1, 0);
    const rootinverse = new THREE.Matrix4();
    const parentinverse = new THREE.Matrix4();
    const moveoffset = new THREE.Matrix4();
    const target = new THREE.Matrix4();
    const relative = new THREE.Matrix4();
    const rootquatinverse = new THREE.Quaternion();
    const tipoffset = new THREE.Vector3(0, 0, -TIP);
    const tipworld = new THREE.Vector3();
    const tiplocal = new THREE.Vector3();
    const thumbworld = new THREE.Vector3();
    const rayorigin = new THREE.Vector3();
    const raydirection = new THREE.Vector3();
    const axisworld = new THREE.Vector3();
    const axislocal = new THREE.Vector3();
    const headposition = new THREE.Vector3();
    const headquaternion = new THREE.Quaternion();
    const forward = new THREE.Vector3();
    const tmpposition = new THREE.Vector3();
    const tmpquaternion = new THREE.Quaternion();
    const tmpscale = new THREE.Vector3();
    const toolquaternion = new THREE.Quaternion();
    const previousquaternion = new THREE.Quaternion();
    const deltaquaternion = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const gripoffset = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.07, 0.07),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 3, 0, 0)), one);
    // The wrist joint's -z points to the fingers and +y out of the back of the hand.
    const wristoffset = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.06, 0.02),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 3, 0, 0)), one);

    // The desktop placement of the sculpture, put back when VR ends.
    const saved = {position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), valid: false};

    // The pose handed out by getPose().
    const pose = {h: [0, 0, 0, 0, 0, 0, 1], l: null, r: null};
    // What is handed to the tools during a stroke.
    const strokepoint = [0, 0, 0];
    const strokeaxis = [0, 0, -1];
    const strokeoptions = {pressure: 1, axis: strokeaxis, angle: 0};
    const leftpose = [0, 0, 0, 0, 0, 0, 1];
    const rightpose = [0, 0, 0, 0, 0, 0, 1];

    // Visuals.
    const linegeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const gripgeometry = new THREE.BoxGeometry(0.035, 0.035, 0.12);
    const cursorgeometry = new THREE.SphereGeometry(1, 24, 16);
    const cursormaterial = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false});
    const cursor = new THREE.Mesh(cursorgeometry, cursormaterial);
    cursor.name = 'vrsculpt-xr-cursor';
    cursor.visible = false;
    cursor.renderOrder = 25;
    cursor.raycast = noRaycast;
    scene.add(cursor);

    const palette = createPalette(THREE, {strings: options.strings || {}, readonly: !tools});
    scene.add(palette.object);
    if (!tools) {
        palette.setState('', SIZE_MIN, 0, false, false);
    }

    const handfactory = typeof THREE.XRHandModelFactory === 'function' ? new THREE.XRHandModelFactory() : null;
    const entries = [];
    const removers = [];

    // Right hand: trigger state, stroke, palette capture, buttons; left hand: hold and buttons.
    const right = {pressed: false, stroking: false, capture: null, pinching: false, touching: false, roll: 0,
        lower: false, upper: false};
    const left = {holding: false, moving: false, pinching: false, lower: false, upper: false};
    let cursortool = '';
    let active = false;
    let placing = false;
    let disposed = false;

    /**
     * Listen to an event and remember how to stop.
     *
     * @param {Object} targetobject Event target.
     * @param {string} type Event type.
     * @param {Function} handler Handler.
     */
    const listen = (targetobject, type, handler) => {
        targetobject.addEventListener(type, handler);
        removers.push(() => targetobject.removeEventListener(type, handler));
    };

    for (let i = 0; i < 2; i++) {
        const controller = renderer.xr.getController(i);
        const grip = renderer.xr.getControllerGrip(i);
        const hand = renderer.xr.getHand(i);

        const line = new THREE.Line(linegeometry, new THREE.LineBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.7}));
        line.name = 'vrsculpt-xr-ray';
        line.visible = false;
        line.raycast = noRaycast;
        controller.add(line);

        const gripmesh = new THREE.Mesh(gripgeometry, new THREE.MeshStandardMaterial({color: 0x495057, roughness: 0.6}));
        gripmesh.name = 'vrsculpt-xr-grip';
        gripmesh.visible = false;
        gripmesh.raycast = noRaycast;
        grip.add(gripmesh);

        let handmodel = null;
        if (handfactory) {
            handmodel = handfactory.createHandModel(hand, 'spheres');
            hand.add(handmodel);
        }

        scene.add(controller);
        scene.add(grip);
        scene.add(hand);

        const entry = {controller, grip, hand, line, gripmesh, handmodel, source: null};
        entries.push(entry);

        listen(controller, 'connected', (e) => {
            const source = e.data || null;
            entry.source = source;
            gripmesh.visible = !!source && source.targetRayMode === 'tracked-pointer' && !source.hand;
        });
        listen(controller, 'disconnected', () => {
            entry.source = null;
            line.visible = false;
            gripmesh.visible = false;
        });
    }

    /**
     * The connected entry of a hand.
     *
     * @param {string} handedness 'left' or 'right'.
     * @returns {Object|null}
     */
    const entryOf = (handedness) => {
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].source && entries[i].source.handedness === handedness) {
                return entries[i];
            }
        }
        return null;
    };

    /**
     * A tracked joint of a hand entry.
     *
     * @param {Object} entry Entry.
     * @param {string} name Joint name.
     * @returns {Object|null} The joint (Group) when tracked this frame.
     */
    const jointOf = (entry, name) => {
        const joints = entry.hand.joints;
        const joint = joints ? joints[name] : null;
        return joint && joint.visible ? joint : null;
    };

    /**
     * The object that stands for a hand: the grip of a controller, the wrist of a tracked hand.
     *
     * @param {Object|null} entry Entry.
     * @returns {Object|null} Object3D with a current matrixWorld, or null when not tracked.
     */
    const holderOf = (entry) => {
        if (!entry || !entry.source) {
            return null;
        }
        if (entry.source.hand) {
            return jointOf(entry, 'wrist');
        }
        return entry.grip.visible ? entry.grip : null;
    };

    /**
     * Refresh the sculpture's world matrix (not its children's) and its inverse.
     */
    const refreshRoot = () => {
        root.updateMatrix();
        root.updateWorldMatrix(true, false);
        rootinverse.copy(root.matrixWorld).invert();
        root.matrixWorld.decompose(tmpposition, rootquatinverse, tmpscale);
        rootquatinverse.invert();
    };

    /**
     * Move the sculpture to a world transform (its scale is kept).
     *
     * @param {Object} world THREE.Matrix4
     */
    const setRootWorld = (world) => {
        if (root.parent) {
            root.parent.updateWorldMatrix(true, false);
            parentinverse.copy(root.parent.matrixWorld).invert();
            relative.multiplyMatrices(parentinverse, world);
        } else {
            relative.copy(world);
        }
        relative.decompose(root.position, root.quaternion, tmpscale);
        refreshRoot();
    };

    /**
     * Place the sculpture in front of the head (once, when the viewer pose is first known).
     *
     * @param {Object|null} frame XRFrame.
     * @returns {boolean} Whether it was placed.
     */
    const place = (frame) => {
        const space = renderer.xr.getReferenceSpace();
        if (!frame || !space || typeof frame.getViewerPose !== 'function') {
            return false;
        }
        const viewer = frame.getViewerPose(space);
        if (!viewer) {
            return false;
        }
        const p = viewer.transform.position;
        const o = viewer.transform.orientation;
        headposition.set(p.x, p.y, p.z);
        headquaternion.set(o.x, o.y, o.z, o.w);
        forward.set(0, 0, -1).applyQuaternion(headquaternion);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) {
            forward.set(0, 0, -1);
        }
        forward.normalize();
        tmpposition.copy(headposition).addScaledVector(forward, PLACE_DISTANCE);
        tmpposition.y = Math.max(PLACE_LOWEST, headposition.y - PLACE_DROP);
        // The sculpture's front (+z) faces the person.
        tmpquaternion.setFromAxisAngle(yaxis, Math.atan2(-forward.x, -forward.z));
        target.compose(tmpposition, tmpquaternion, root.scale);
        setRootWorld(target);
        return true;
    };

    /**
     * The tool tip in the sculpture's frame (one reused array: the tools copy what they keep).
     *
     * @returns {number[]} [x, y, z]
     */
    const tipPoint = () => {
        tiplocal.copy(tipworld).applyMatrix4(rootinverse);
        strokepoint[0] = tiplocal.x;
        strokepoint[1] = tiplocal.y;
        strokepoint[2] = tiplocal.z;
        return strokepoint;
    };

    /**
     * The options of a stroke step (one reused object: the tools copy what they keep).
     *
     * pressure scales the tool's strength (the trigger value), axis is the twist axis (the
     * controller's forward axis) in the sculpture's frame, angle the controller's roll about it
     * since the stroke began (radians).
     *
     * @param {number} value Trigger value 0..1.
     * @returns {Object} {pressure, axis, angle}
     */
    const strokeOptions = (value) => {
        axislocal.copy(axisworld).applyQuaternion(rootquatinverse);
        strokeaxis[0] = axislocal.x;
        strokeaxis[1] = axislocal.y;
        strokeaxis[2] = axislocal.z;
        strokeoptions.pressure = clamp(value, 0, 1);
        strokeoptions.angle = right.roll;
        return strokeoptions;
    };

    /**
     * End the running stroke, if any.
     */
    const stopStroke = () => {
        if (right.stroking && tools) {
            right.stroking = false;
            try {
                tools.end();
            } catch (error) {
                Log.debug(error);
            }
        }
        right.stroking = false;
    };

    /**
     * Start a stroke at the tool tip.
     *
     * @param {number} value Trigger value.
     */
    const beginStroke = (value) => {
        if (!tools) {
            return;
        }
        previousquaternion.copy(toolquaternion);
        right.roll = 0;
        axisworld.set(0, 0, -1).applyQuaternion(toolquaternion);
        const result = tools.begin(tipPoint(), strokeOptions(value));
        right.stroking = result !== false;
    };

    /**
     * Continue the stroke at the tool tip, adding the roll since the previous step.
     *
     * @param {number} value Trigger value.
     */
    const moveStroke = (value) => {
        axisworld.set(0, 0, -1).applyQuaternion(toolquaternion);
        // The rotation since the previous step, and its part about the forward axis.
        deltaquaternion.copy(previousquaternion).invert().premultiply(toolquaternion);
        if (deltaquaternion.w < 0) {
            deltaquaternion.set(-deltaquaternion.x, -deltaquaternion.y, -deltaquaternion.z, -deltaquaternion.w);
        }
        const along = deltaquaternion.x * axisworld.x + deltaquaternion.y * axisworld.y + deltaquaternion.z * axisworld.z;
        const angle = clamp(2 * Math.atan2(along, deltaquaternion.w), -TWIST_MAX, TWIST_MAX);
        previousquaternion.copy(toolquaternion);
        right.roll += angle;
        tools.move(tipPoint(), strokeOptions(value));
    };

    /**
     * A short buzz of a controller, when it has one.
     *
     * @param {Object|null} entry Entry.
     */
    const pulse = (entry) => {
        const gamepad = entry && entry.source ? entry.source.gamepad : null;
        const actuator = gamepad && gamepad.hapticActuators ? gamepad.hapticActuators[0] : null;
        if (actuator && typeof actuator.pulse === 'function') {
            Promise.resolve().then(() => actuator.pulse(0.4, 25)).catch(() => null);
        }
    };

    /**
     * Change the tool by a step in palette order.
     *
     * @param {number} step 1 or -1.
     */
    const stepTool = (step) => {
        if (!tools) {
            return;
        }
        const index = TOOLS.indexOf(tools.tool);
        const next = TOOLS[((index < 0 ? 0 : index) + step + TOOLS.length) % TOOLS.length];
        stopStroke();
        tools.setTool(next);
    };

    /**
     * Undo or redo the own last stroke.
     *
     * @param {boolean} redo Whether to redo.
     */
    const history = (redo) => {
        if (!tools) {
            return;
        }
        stopStroke();
        if (redo ? tools.canRedo() : tools.canUndo()) {
            if (redo) {
                tools.redo();
            } else {
                tools.undo();
            }
        }
    };

    /**
     * Use a palette control.
     *
     * @param {Object} hit Palette hit.
     * @param {boolean} dragging Whether the pointer stays on a bar (only bars react).
     */
    const usePalette = (hit, dragging) => {
        if (hit.region === 'exit') {
            if (!dragging) {
                api.exit();
            }
            return;
        }
        if (!tools) {
            return;
        }
        if (hit.region === 'size') {
            tools.setSize(SIZE_MIN + hit.value * (SIZE_MAX - SIZE_MIN));
        } else if (hit.region === 'strength') {
            tools.setStrength(hit.value);
        } else if (dragging) {
            return;
        } else if (hit.region === 'tool') {
            stopStroke();
            tools.setTool(hit.tool);
        } else if (hit.region === 'undo') {
            history(false);
        } else if (hit.region === 'redo') {
            history(true);
        } else if (hit.region === 'mirror') {
            tools.setMirror(!tools.mirror);
        }
    };

    /**
     * Thumbstick size and strength changes, and A and B for the tool.
     *
     * @param {Object|null} gamepad Right gamepad.
     * @param {number} dt Seconds since the last frame.
     */
    const rightButtons = (gamepad, dt) => {
        const lower = buttonPressed(gamepad, BUTTON_LOWER);
        const upper = buttonPressed(gamepad, BUTTON_UPPER);
        if (lower && !right.lower) {
            stepTool(-1);
        }
        if (upper && !right.upper) {
            stepTool(1);
        }
        right.lower = lower;
        right.upper = upper;
        if (!tools || !gamepad || !gamepad.axes || !gamepad.axes.length) {
            return;
        }
        const axes = gamepad.axes;
        const x = deflection(axes.length >= 4 ? axes[2] : axes[0]);
        const y = deflection(axes.length >= 4 ? axes[3] : axes[1]);
        if (y !== 0) {
            // Pushing the stick forward (negative y) makes the brush bigger.
            const size = clamp(Number(tools.size) * Math.exp(-y * SIZE_RATE * dt), SIZE_MIN, SIZE_MAX);
            if (size !== tools.size) {
                tools.setSize(size);
            }
        }
        if (x !== 0) {
            const strength = clamp(Number(tools.strength) + x * STRENGTH_RATE * dt, 0, 1);
            if (strength !== tools.strength) {
                tools.setStrength(strength);
            }
        }
    };

    /** This frame's reading of the right hand, reused every frame (no allocation). */
    const rightinput = {tracked: false, value: 0, pointing: null, hover: null};

    /**
     * Read a tracked right hand: the index tip, pinch, palette touch.
     *
     * @param {Object} entry The right input entry.
     */
    const readRightHand = (entry) => {
        entry.line.visible = false;
        const index = jointOf(entry, 'index-finger-tip');
        const thumb = jointOf(entry, 'thumb-tip');
        if (!index || !thumb) {
            return;
        }
        rightinput.tracked = true;
        tipworld.setFromMatrixPosition(index.matrixWorld);
        thumbworld.setFromMatrixPosition(thumb.matrixWorld);
        const distance = tipworld.distanceTo(thumbworld);
        right.pinching = right.pinching ? distance < PINCH_OFF : distance < PINCH_ON;
        rightinput.value = right.pinching ? 1 : 0;
        const wrist = jointOf(entry, 'wrist') || index;
        wrist.matrixWorld.decompose(tmpposition, toolquaternion, tmpscale);
        const touch = palette.hitPoint(tipworld, TOUCH_DEPTH);
        if (touch) {
            rightinput.hover = touch.key;
            usePalette(touch, right.touching);
        }
        right.touching = !!touch;
        if (right.touching) {
            // A touch is not a stroke.
            rightinput.value = 0;
        }
    };

    /**
     * Read the right controller: the tool tip, the trigger, the palette ray, the buttons.
     *
     * @param {Object} entry The right input entry.
     * @param {number} dt Seconds since the last frame.
     */
    const readRightController = (entry, dt) => {
        right.touching = false;
        right.pinching = false;
        const gamepad = entry.source.gamepad || null;
        if (entry.grip.visible) {
            rightinput.tracked = true;
            tipworld.copy(tipoffset).applyMatrix4(entry.grip.matrixWorld);
            entry.grip.matrixWorld.decompose(tmpposition, toolquaternion, tmpscale);
        }
        rightinput.value = buttonValue(gamepad, BUTTON_TRIGGER);
        if (entry.controller.visible) {
            rayorigin.setFromMatrixPosition(entry.controller.matrixWorld);
            raydirection.set(0, 0, -1).transformDirection(entry.controller.matrixWorld);
            rightinput.pointing = palette.hitRay(rayorigin, raydirection, PALETTE_REACH);
        }
        const pointing = rightinput.pointing;
        entry.line.visible = !!pointing;
        if (pointing) {
            rightinput.hover = pointing.key;
            entry.line.scale.z = pointing.distance;
        }
        rightButtons(gamepad, dt);
        rightinput.tracked = rightinput.tracked || !!pointing;
    };

    /**
     * Act on the trigger or pinch: press, hold and release, on the palette or as a stroke.
     *
     * @param {Object} entry The right input entry.
     */
    const applyRightPress = (entry) => {
        const value = rightinput.value;
        const pointing = rightinput.pointing;
        const pressed = right.pressed ? value > TRIGGER_OFF : value > TRIGGER_ON;
        if (pressed && !right.pressed) {
            if (pointing) {
                right.capture = pointing.region;
                usePalette(pointing, false);
                pulse(entry);
            } else if (tools) {
                beginStroke(value);
            }
        } else if (pressed && right.capture) {
            if (pointing && pointing.region === right.capture) {
                usePalette(pointing, true);
            }
        } else if (pressed && right.stroking) {
            moveStroke(value);
        } else if (!pressed && right.pressed) {
            right.capture = null;
            stopStroke();
        }
        right.pressed = pressed;
    };

    /**
     * Place and colour the tool cursor at the tip.
     */
    const updateCursor = () => {
        if (!tools) {
            cursor.visible = false;
            return;
        }
        const radius = Number(tools.cursorRadius()) || SIZE_MIN;
        cursor.position.copy(tipworld);
        cursor.scale.setScalar(radius * root.matrixWorld.getMaxScaleOnAxis());
        if (tools.tool !== cursortool) {
            cursortool = tools.tool;
            cursormaterial.color.setHex(TOOL_COLOURS[cursortool] || 0xffffff);
        }
        cursormaterial.opacity = right.stroking ? 0.45 : 0.3;
        cursor.visible = !rightinput.pointing && !right.touching;
    };

    /**
     * The right hand: tool tip, trigger or pinch, palette pointing or touching, stroke.
     *
     * @param {number} dt Seconds since the last frame.
     */
    const updateRight = (dt) => {
        const entry = entryOf('right');
        rightinput.tracked = false;
        rightinput.value = 0;
        rightinput.pointing = null;
        rightinput.hover = null;
        for (let i = 0; i < entries.length; i++) {
            if (entries[i] !== entry) {
                entries[i].line.visible = false;
            }
        }
        if (entry && entry.source && entry.source.hand) {
            readRightHand(entry);
        } else if (entry && entry.source) {
            readRightController(entry, dt);
        }
        if (!rightinput.tracked) {
            stopStroke();
            right.pressed = false;
            right.capture = null;
            cursor.visible = false;
            palette.setHover(null);
            return;
        }
        applyRightPress(entry);
        palette.setHover(rightinput.hover);
        updateCursor();
    };

    /**
     * The left hand: palette placement, holding and moving the sculpture, X and Y.
     */
    const updateLeft = () => {
        const entry = entryOf('left');
        const holder = holderOf(entry);
        let holding = false;
        if (entry && entry.source && entry.source.hand) {
            const index = jointOf(entry, 'index-finger-tip');
            const thumb = jointOf(entry, 'thumb-tip');
            if (index && thumb) {
                tipworld.setFromMatrixPosition(index.matrixWorld);
                thumbworld.setFromMatrixPosition(thumb.matrixWorld);
                const distance = tipworld.distanceTo(thumbworld);
                left.pinching = left.pinching ? distance < PINCH_OFF : distance < PINCH_ON;
            } else {
                left.pinching = false;
            }
            holding = left.pinching;
        } else if (entry && entry.source) {
            left.pinching = false;
            const gamepad = entry.source.gamepad || null;
            const squeeze = buttonValue(gamepad, BUTTON_SQUEEZE);
            holding = left.holding ? squeeze > SQUEEZE_OFF : squeeze > SQUEEZE_ON;
            const lower = buttonPressed(gamepad, BUTTON_LOWER);
            const upper = buttonPressed(gamepad, BUTTON_UPPER);
            if (lower && !left.lower) {
                history(false);
            }
            if (upper && !left.upper) {
                history(true);
            }
            left.lower = lower;
            left.upper = upper;
        }
        left.holding = holding;

        if (holding && holder) {
            if (!left.moving) {
                // Keep the sculpture where it is relative to the hand.
                left.moving = true;
                relative.copy(holder.matrixWorld).invert();
                moveoffset.multiplyMatrices(relative, root.matrixWorld);
            } else {
                target.multiplyMatrices(holder.matrixWorld, moveoffset);
                setRootWorld(target);
            }
        } else {
            left.moving = false;
        }

        const board = palette.object;
        if (holder) {
            board.matrix.multiplyMatrices(holder.matrixWorld, entry.source.hand ? wristoffset : gripoffset);
            board.matrixWorld.copy(board.matrix);
            board.matrixWorldNeedsUpdate = true;
            board.visible = true;
        } else {
            board.visible = false;
        }
    };

    /**
     * Write an object's pose in the sculpture's frame into an array.
     *
     * @param {number[]} out Array of 7.
     * @param {Object} matrixworld THREE.Matrix4 of the object.
     * @returns {number[]} out
     */
    const writePose = (out, matrixworld) => {
        relative.multiplyMatrices(rootinverse, matrixworld);
        relative.decompose(tmpposition, tmpquaternion, tmpscale);
        out[0] = tmpposition.x;
        out[1] = tmpposition.y;
        out[2] = tmpposition.z;
        out[3] = tmpquaternion.x;
        out[4] = tmpquaternion.y;
        out[5] = tmpquaternion.z;
        out[6] = tmpquaternion.w;
        return out;
    };

    /**
     * Hide the XR visuals and let go of everything.
     */
    const reset = () => {
        stopStroke();
        right.pressed = false;
        right.capture = null;
        right.pinching = false;
        right.touching = false;
        left.holding = false;
        left.moving = false;
        left.pinching = false;
        cursor.visible = false;
        palette.object.visible = false;
        palette.setHover(null);
        entries.forEach((e) => {
            e.line.visible = false;
        });
    };

    /**
     * A VR session started: remember the desktop placement and place the sculpture anew.
     */
    const onStart = () => {
        if (disposed) {
            return;
        }
        saved.position.copy(root.position);
        saved.quaternion.copy(root.quaternion);
        saved.valid = true;
        active = true;
        placing = true;
        reset();
        if (typeof options.onStart === 'function') {
            options.onStart();
        }
    };

    /**
     * The VR session ended: put the sculpture back where the desktop view has it.
     */
    const onEnd = () => {
        active = false;
        placing = false;
        reset();
        if (saved.valid) {
            root.position.copy(saved.position);
            root.quaternion.copy(saved.quaternion);
            saved.valid = false;
            refreshRoot();
        }
        if (typeof options.onEnd === 'function' && !disposed) {
            options.onEnd();
        }
    };

    const xr = createXr(renderer, {onStart: onStart, onEnd: onEnd});

    const api = {
        /** Whether this device can enter immersive VR. */
        available: detect().then((info) => !!info.vr).catch(() => false),

        /** @returns {boolean} Whether a VR session runs. */
        get active() {
            return active;
        },

        /**
         * Enter immersive VR.
         *
         * @returns {Promise<string>} 'vr' once the session runs.
         */
        enter() {
            if (disposed) {
                return Promise.reject(new Error('The VR sculpting controller was disposed'));
            }
            return xr.enter('vr');
        },

        /**
         * Leave immersive VR.
         *
         * @returns {Promise}
         */
        exit() {
            return xr.exit();
        },

        /**
         * Read the controllers and hands and sculpt; called once per animation frame.
         *
         * @param {number} dt Seconds since the last frame.
         * @param {Object|null} frame XRFrame of the animation frame.
         */
        update(dt, frame) {
            if (disposed || !active) {
                return;
            }
            const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
            for (let i = 0; i < entries.length; i++) {
                entries[i].controller.updateMatrixWorld(true);
                entries[i].grip.updateMatrixWorld(true);
                entries[i].hand.updateMatrixWorld(true);
            }
            refreshRoot();
            if (placing && place(frame)) {
                placing = false;
            }
            updateLeft();
            refreshRoot();
            if (tools) {
                palette.setState(tools.tool, tools.size, tools.strength, tools.canUndo(), tools.canRedo(), tools.mirror);
            }
            updateRight(step);
        },

        /**
         * The own head and hands in the sculpture's frame.
         *
         * @returns {Object|null} {h, l, r} ([x, y, z, qx, qy, qz, qw] each, l and r null when not
         *     tracked; one reused object), or null outside VR.
         */
        getPose() {
            if (disposed || !active) {
                return null;
            }
            refreshRoot();
            writePose(pose.h, renderer.xr.getCamera().matrixWorld);
            const lefthand = holderOf(entryOf('left'));
            const righthand = holderOf(entryOf('right'));
            pose.l = lefthand ? writePose(leftpose, lefthand.matrixWorld) : null;
            pose.r = righthand ? writePose(rightpose, righthand.matrixWorld) : null;
            return pose;
        },

        /** End VR and remove the controllers, hands, cursor and palette. */
        dispose() {
            if (disposed) {
                return;
            }
            if (active) {
                xr.exit();
            }
            disposed = true;
            reset();
            removers.forEach((remove) => remove());
            removers.length = 0;
            entries.forEach((entry) => {
                entry.controller.remove(entry.line);
                entry.grip.remove(entry.gripmesh);
                if (entry.handmodel) {
                    entry.hand.remove(entry.handmodel);
                    entry.handmodel.traverse((object) => {
                        if (object.geometry) {
                            object.geometry.dispose();
                        }
                        if (object.material) {
                            object.material.dispose();
                        }
                    });
                }
                [entry.controller, entry.grip, entry.hand].forEach((object) => {
                    if (object.parent) {
                        object.parent.remove(object);
                    }
                });
                entry.line.material.dispose();
                entry.gripmesh.material.dispose();
            });
            entries.length = 0;
            scene.remove(cursor);
            cursorgeometry.dispose();
            cursormaterial.dispose();
            linegeometry.dispose();
            gripgeometry.dispose();
            palette.dispose();
        },
    };
    return api;
};
