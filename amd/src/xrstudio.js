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
 * Making in WebXR: immersive VR with two controllers or tracked hands, by either method.
 *
 * Controls when sculpting (right hand sculpts, left hand holds):
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
 * - the wrist palette (mod_vrmakerspace/vrpalette) above the left hand: point the right controller at
 *   it and pull the trigger, or touch it with the right index tip.
 *
 * Controls when modelling (only through mod_vrmakerspace/modeltools), the left hand as above:
 * - a small sphere at the tip marks the reach, a dot its centre, and a label above it names the
 *   method, the action and the select mode; what the trigger would pick is drawn in bright green
 *   before it is pulled;
 * - with Select: the right trigger picks within 2.5 cm of the tip, or along the controller beyond
 *   arm's reach (not with hands: a hand's ray is too unsteady to aim with), and paints while held. A fresh
 *   press starts a new selection unless it starts on something selected or the left trigger is held;
 * - with an action: the right trigger drags (begin, move, end), handing over the hand's rotation;
 * - right thumbstick up and down: the width while dragging Inset or Bevel, otherwise the segments of
 *   Bevel and Loop cut; left and right change Bevel's segments while dragging;
 * - A and B: previous and next action; X and Y undo and redo, and cancel a drag in progress;
 * - hands: a pinch is the trigger;
 * - a shape from the palette appears at the hand.
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
 * @module     mod_vrmakerspace/xrstudio
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';
import {createXr, detect} from 'vrroomruntime_builtin/xr';
import {pickNear, pickRay} from 'mod_vrmakerspace/polypick';
import {createPalette, ACTIONS, TOOLS, SIZE_MIN, SIZE_MAX} from 'mod_vrmakerspace/vrpalette';

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

/** Cursor colour of each modelling action. */
const ACTION_COLOURS = Object.freeze({
    select: 0xffffff,
    move: 0x6fcf97,
    rotate: 0xb07cd8,
    scale: 0xf2c94c,
    extrude: 0xf2994a,
    inset: 0x56ccf2,
    bevel: 0xeb5757,
    loopcut: 0x2f80ed,
});

/** The colour of what the trigger would pick: apart from the mesh's blue-grey and the selection's orange. */
const CANDIDATE_COLOUR = 0x7cff6b;

/** How far from the tip an element can be picked, the radius of the modelling cursor (m, in the room). */
const REACH = 0.025;

/** Radius of the dot at the centre of the modelling cursor (m, in the room). */
const DOT_RADIUS = 0.003;

/** Beyond arm's reach: how far from the controller's ray an element is picked, per metre along it. */
const RAY_TOLERANCE = 0.02;

/** Length of the aiming ray when it reaches nothing (m). */
const RAY_LENGTH = 1.5;

/** Seconds between hover picks while the mesh does not change: 20 a second. */
const PICK_INTERVAL = 0.05;

/** Radius of the mark on a candidate vertex and of the bar on a candidate edge (m, sculpture-local). */
const VERTEX_MARK = 0.006;
const EDGE_MARK = 0.0025;

/** Most vertices of a face (polymesh MAX_FACE_SIZE). */
const FACE_MAX = 64;

/** Half-extent or radius of a shape added from the palette (m). */
const SHAPE_SIZE = 0.06;

/** Largest coordinate of a mesh vertex (polymesh MAX_COORD_MESH, m). */
const COORD_MAX = 0.4;

/** Width change by the stick at full deflection (m per second), and its largest total (m). */
const WIDTH_RATE = 0.04;
const WIDTH_LIMIT = 0.2;

/** Segment steps per second at full deflection. */
const SEGMENT_RATE = 4;

/** Seconds the second press of Turn into clay may follow the first. */
const BAKE_WINDOW = 5;

/** Seconds a message stays on the label, and the method's name after a switch while sculpting. */
const MESSAGE_TIME = 4;
const METHOD_TIME = 2.5;

/** Label over the tip: canvas size (px), width in the room (m), height above the tip (m). */
const LABEL_WIDTH = 640;
const LABEL_HEIGHT = 208;
const LABEL_SIZE = 0.15;
const LABEL_RISE = 0.07;

/** The string of each select mode. */
const MODE_KEYS = Object.freeze({v: 'select_vertex', e: 'select_edge', f: 'select_face'});

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
 * The index of an id in a typed array of ids.
 *
 * @param {Float64Array} ids Ids.
 * @param {number} id Id looked for.
 * @returns {number} Index, or -1.
 */
const indexOfId = (ids, id) => {
    for (let i = 0; i < ids.length; i++) {
        if (ids[i] === id) {
            return i;
        }
    }
    return -1;
};

/**
 * Whether two picks name the same element.
 *
 * @param {Object|null} a A pick of mod_vrmakerspace/polypick.
 * @param {Object|null} b Another.
 * @returns {boolean}
 */
const sameHit = (a, b) => {
    if (a === b) {
        return true;
    }
    return !!a && !!b && a.kind === b.kind && a.id === b.id && a.a === b.a && a.b === b.b;
};

/**
 * Whether a pick names something in a selection.
 *
 * @param {Object} hit A pick of mod_vrmakerspace/polypick.
 * @param {Object|null} selection {md, items}
 * @returns {boolean}
 */
const inSelection = (hit, selection) => {
    if (!selection || selection.md !== hit.kind || !Array.isArray(selection.items)) {
        return false;
    }
    const items = selection.items;
    if (hit.kind !== 'e') {
        return items.includes(hit.id);
    }
    for (let i = 0; i + 1 < items.length; i += 2) {
        if (items[i] === hit.a && items[i + 1] === hit.b) {
            return true;
        }
    }
    return false;
};

/**
 * Create the mark on the candidate, the element the trigger would pick: a ball on a vertex, a bar on an
 * edge, a filled outline on a face. It lives under the sculpture, draws through the mesh so a hidden
 * candidate still shows, and its buffers are fixed, so a change allocates nothing.
 *
 * @param {Object} THREE three.js namespace.
 * @param {Object} parent The sculpture's group.
 * @returns {Object} {show(hit, data): boolean, hide(), anchor: Vector3 sculpture-local, dispose()}
 */
const createCandidateMark = (THREE, parent) => {
    const group = new THREE.Group();
    group.name = 'vrmakerspace-xr-candidate';
    const up = new THREE.Vector3(0, 1, 0);
    const first = new THREE.Vector3();
    const second = new THREE.Vector3();
    const anchor = new THREE.Vector3();

    /**
     * Make an object of the mark.
     *
     * @param {Object} object THREE.Object3D with its material set.
     * @returns {Object} The object.
     */
    const prepare = (object) => {
        object.visible = false;
        object.raycast = noRaycast;
        object.renderOrder = 26;
        object.frustumCulled = false;
        group.add(object);
        return object;
    };

    const solid = new THREE.MeshBasicMaterial({color: CANDIDATE_COLOUR, depthTest: false, depthWrite: false, transparent: true});
    const ballgeometry = new THREE.SphereGeometry(1, 12, 8);
    const ball = prepare(new THREE.Mesh(ballgeometry, solid));
    ball.scale.setScalar(VERTEX_MARK);
    const bargeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    const bar = prepare(new THREE.Mesh(bargeometry, solid));

    const filldata = new THREE.BufferAttribute(new Float32Array((FACE_MAX - 2) * 9), 3);
    filldata.setUsage(THREE.DynamicDrawUsage);
    const fillgeometry = new THREE.BufferGeometry();
    fillgeometry.setAttribute('position', filldata);
    const fillmaterial = new THREE.MeshBasicMaterial({color: CANDIDATE_COLOUR, depthTest: false, depthWrite: false,
        transparent: true, opacity: 0.35, side: THREE.DoubleSide});
    const fill = prepare(new THREE.Mesh(fillgeometry, fillmaterial));

    const outlinedata = new THREE.BufferAttribute(new Float32Array(FACE_MAX * 3), 3);
    outlinedata.setUsage(THREE.DynamicDrawUsage);
    const outlinegeometry = new THREE.BufferGeometry();
    outlinegeometry.setAttribute('position', outlinedata);
    const outlinematerial = new THREE.LineBasicMaterial({color: CANDIDATE_COLOUR, depthTest: false, depthWrite: false,
        transparent: true});
    const outline = prepare(new THREE.LineLoop(outlinegeometry, outlinematerial));

    parent.add(group);

    /**
     * Hide every part of the mark.
     */
    const hide = () => {
        ball.visible = false;
        bar.visible = false;
        fill.visible = false;
        outline.visible = false;
    };

    /**
     * Mark a vertex.
     *
     * @param {Object} data Render data.
     * @param {number} id Vertex id.
     * @returns {boolean} Whether it exists.
     */
    const showVertex = (data, id) => {
        const v = indexOfId(data.vertIds, id);
        if (v < 0) {
            return false;
        }
        anchor.fromArray(data.vertPos, v * 3);
        ball.position.copy(anchor);
        ball.visible = true;
        return true;
    };

    /**
     * Mark an edge.
     *
     * @param {Object} data Render data.
     * @param {number} a Vertex id.
     * @param {number} b Vertex id.
     * @returns {boolean} Whether both ends exist.
     */
    const showEdge = (data, a, b) => {
        const va = indexOfId(data.vertIds, a);
        const vb = indexOfId(data.vertIds, b);
        if (va < 0 || vb < 0) {
            return false;
        }
        first.fromArray(data.vertPos, va * 3);
        second.fromArray(data.vertPos, vb * 3);
        anchor.addVectors(first, second).multiplyScalar(0.5);
        second.sub(first);
        const length = second.length();
        if (length < 1e-6) {
            // Two vertices in one place: nothing to lay a bar along.
            ball.position.copy(anchor);
            ball.visible = true;
            return true;
        }
        bar.position.copy(anchor);
        bar.quaternion.setFromUnitVectors(up, second.divideScalar(length));
        bar.scale.set(EDGE_MARK, length, EDGE_MARK);
        bar.visible = true;
        return true;
    };

    /**
     * Mark a face.
     *
     * @param {Object} data Render data.
     * @param {number} id Face id.
     * @param {Object} hit The pick, whose point is used as the anchor.
     * @returns {boolean} Whether it exists.
     */
    const showFace = (data, id, hit) => {
        const f = indexOfId(data.faceIds, id);
        if (f < 0) {
            return false;
        }
        const start = data.faceStart[f];
        const corners = Math.min(FACE_MAX, data.faceStart[f + 1] - start);
        anchor.set(0, 0, 0);
        for (let c = 0; c < corners; c++) {
            const v = data.faceVerts[start + c] * 3;
            outlinedata.setXYZ(c, data.vertPos[v], data.vertPos[v + 1], data.vertPos[v + 2]);
            anchor.x += data.vertPos[v];
            anchor.y += data.vertPos[v + 1];
            anchor.z += data.vertPos[v + 2];
        }
        anchor.divideScalar(corners || 1);
        if (Array.isArray(hit.point) && hit.point.length === 3) {
            anchor.fromArray(hit.point);
        }
        outlinedata.needsUpdate = true;
        outlinegeometry.setDrawRange(0, corners);
        // The triangles of a face are consecutive in the render data.
        const triangles = data.triFace.length;
        let t = 0;
        while (t < triangles && data.triFace[t] !== f) {
            t++;
        }
        let count = 0;
        const room = FACE_MAX - 2;
        const out = filldata.array;
        while (t < triangles && data.triFace[t] === f && count < room) {
            for (let k = 0; k < 9; k++) {
                out[count * 9 + k] = data.triPos[t * 9 + k];
            }
            t++;
            count++;
        }
        filldata.needsUpdate = true;
        fillgeometry.setDrawRange(0, count * 3);
        fill.visible = true;
        outline.visible = true;
        return true;
    };

    return {
        anchor: anchor,
        hide: hide,

        /**
         * Mark what a pick names.
         *
         * @param {Object|null} hit A pick of mod_vrmakerspace/polypick.
         * @param {Object|null} data The render data it came from.
         * @returns {boolean} Whether it is marked: false when nothing was picked or it no longer exists.
         */
        show(hit, data) {
            hide();
            if (!hit || !data) {
                return false;
            }
            if (hit.kind === 'v') {
                return showVertex(data, hit.id);
            }
            if (hit.kind === 'e') {
                return showEdge(data, hit.a, hit.b);
            }
            return hit.kind === 'f' ? showFace(data, hit.id, hit) : false;
        },

        /** Remove the mark and release its resources. */
        dispose() {
            parent.remove(group);
            solid.dispose();
            ballgeometry.dispose();
            bargeometry.dispose();
            fillgeometry.dispose();
            fillmaterial.dispose();
            outlinegeometry.dispose();
            outlinematerial.dispose();
        },
    };
};

/**
 * Create the label over the tip, which says which method and action are active and shows messages.
 * It is drawn with fillText (plain text, never HTML) and only when its words change.
 *
 * @param {Object} THREE three.js namespace.
 * @param {Object} scene The scene.
 * @returns {Object} {sprite, setLines(top, bottom), dispose()}
 */
const createTipLabel = (THREE, scene) => {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_WIDTH;
    canvas.height = LABEL_HEIGHT;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({map: texture, transparent: true, depthTest: false, depthWrite: false});
    const sprite = new THREE.Sprite(material);
    sprite.name = 'vrmakerspace-xr-label';
    sprite.raycast = noRaycast;
    sprite.renderOrder = 28;
    sprite.visible = false;
    sprite.scale.set(LABEL_SIZE, LABEL_SIZE * LABEL_HEIGHT / LABEL_WIDTH, 1);
    scene.add(sprite);

    return {
        sprite: sprite,

        /**
         * Change the words on the label.
         *
         * @param {string} status The method and action, on the bottom line.
         * @param {string} note A message over it, on up to three lines ('' for none).
         */
        setLines(status, note) {
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return;
            }
            const space = LABEL_WIDTH - 24;
            ctx.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const lines = [];
            if (note) {
                ctx.font = '500 28px sans-serif';
                String(note).split(/\s+/).forEach((word) => {
                    const last = lines.length - 1;
                    if (last >= 0 && ctx.measureText(lines[last] + ' ' + word).width <= space) {
                        lines[last] += ' ' + word;
                    } else {
                        lines.push(word);
                    }
                });
            }
            const shown = lines.slice(0, 3);
            const top = LABEL_HEIGHT - 64 - shown.length * 38;
            ctx.fillStyle = 'rgba(20, 24, 28, 0.82)';
            ctx.fillRect(0, top, LABEL_WIDTH, LABEL_HEIGHT - top);
            ctx.fillStyle = '#ffd479';
            shown.forEach((line, i) => ctx.fillText(line, LABEL_WIDTH / 2, top + 22 + i * 38, space));
            ctx.font = '600 38px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(status, LABEL_WIDTH / 2, LABEL_HEIGHT - 32, space);
            texture.needsUpdate = true;
        },

        /** Remove the label and release its resources. */
        dispose() {
            scene.remove(sprite);
            texture.dispose();
            material.dispose();
        },
    };
};

/**
 * Whether the activity's setting allows a method.
 *
 * @param {string|string[]|undefined} setting An array of method names, or 'both', 'sculpt' or 'model' (nothing: both).
 * @param {string} name 'sculpt' or 'model'.
 * @returns {boolean}
 */
const methodAllowed = (setting, name) => {
    if (Array.isArray(setting)) {
        return setting.includes(name);
    }
    return setting !== (name === 'model' ? 'sculpt' : 'model');
};

/**
 * Which tools and methods a person has in VR. Modelling needs the shared undo of the tools; a sculpt-only
 * activity has none of it.
 *
 * @param {Object} options The options of createXrStudio.
 * @returns {{tools: (Object|null), model: (Object|null), methods: string, method: string}}
 */
const xrMethods = (options) => {
    const tools = options.readonly ? null : (options.tools || null);
    const model = tools && methodAllowed(options.methods, 'model') ? (options.model || null) : null;
    let methods = 'sculpt';
    if (model) {
        methods = methodAllowed(options.methods, 'sculpt') ? 'both' : 'model';
    }
    const method = methods === 'model' || (model && options.method === 'model') ? 'model' : 'sculpt';
    return {tools, model, methods, method};
};

/**
 * Create the VR controller of the studio.
 *
 * Options: THREE (namespace with XRHandModelFactory), renderer (WebGLRenderer with xr.enabled),
 * scene (no transform of its own), camera, sculptureRoot (Group holding the sculpture),
 * tools (mod_vrmakerspace/tools, ignored when readonly), readonly, strings (the mod_vrmakerspace strings
 * by key), onStart() and onEnd() (optional, when a VR session starts and ends).
 *
 * For modelling, optional: model (mod_vrmakerspace/modeltools), engine (the engine client), methods
 * (what the activity allows: an array of 'sculpt' and 'model', or 'both', the default, 'sculpt' or
 * 'model'), method ('sculpt' or 'model', the person's method now), onMethod(name) (the person chose a
 * method on the palette). Without model only sculpting exists, and everything works as it always did.
 *
 * getPose() returns one reused object whose arrays change every frame; it is meant to be encoded
 * at once (session.sendPose()).
 *
 * @param {Object} options Options.
 * @returns {Object} XrStudio {available: Promise<boolean>, enter(), exit(), active, method, setMethod(name),
 *     showMessage(text), update(dt, frame), getPose(), dispose()}
 */
export const createXrStudio = (options = {}) => {
    const THREE = options.THREE;
    const renderer = options.renderer;
    const scene = options.scene;
    const root = options.sculptureRoot;
    const {tools, model, methods, method: firstmethod} = xrMethods(options);
    const engine = options.engine || null;
    const strings = options.strings || {};
    let method = firstmethod;

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
    cursor.name = 'vrmakerspace-xr-cursor';
    cursor.visible = false;
    cursor.renderOrder = 25;
    cursor.raycast = noRaycast;
    scene.add(cursor);

    const dotmaterial = model ? new THREE.MeshBasicMaterial({color: 0xffffff, depthTest: false, depthWrite: false,
        transparent: true}) : null;
    const dot = model ? new THREE.Mesh(cursorgeometry, dotmaterial) : null;
    if (dot) {
        dot.name = 'vrmakerspace-xr-dot';
        dot.visible = false;
        dot.renderOrder = 26;
        dot.raycast = noRaycast;
        dot.scale.setScalar(DOT_RADIUS);
        scene.add(dot);
    }
    const mark = model ? createCandidateMark(THREE, root) : null;
    const label = model ? createTipLabel(THREE, scene) : null;

    const palette = createPalette(THREE, {strings: strings, readonly: !tools, methods: methods, method: method});
    scene.add(palette.object);
    if (!tools) {
        palette.setState('', SIZE_MIN, 0, false, false);
    }

    const handfactory = typeof THREE.XRHandModelFactory === 'function' ? new THREE.XRHandModelFactory() : null;
    const entries = [];
    const removers = [];

    // Right hand: trigger state, stroke, palette capture, buttons; left hand: hold and buttons.
    const right = {pressed: false, stroking: false, capture: null, pinching: false, touching: false, roll: 0,
        lower: false, upper: false, modelling: ''};
    const left = {holding: false, moving: false, pinching: false, lower: false, upper: false};
    let cursortool = '';
    let active = false;
    let placing = false;
    let disposed = false;

    // Modelling: what would be picked, the running gesture and what the palette and the label show.
    const localray = {origin: [0, 0, 0], dir: [0, 0, -1]};
    const localquat = [0, 0, 0, 1];
    const dragorigin = [0, 0, 0];
    const dragoptions = {quat: localquat, hit: null, ray: null};
    const addoptions = {add: true};
    const modelstate = {selectmode: '', action: '', axis: 'free', segments: 1, looparmed: false, bakearmed: false};
    const rayoriginlocal = new THREE.Vector3();
    const raydirectionlocal = new THREE.Vector3();
    const handlocal = new THREE.Quaternion();
    const anchorworld = new THREE.Vector3();
    let candidate = null;
    let candidatedata = null;
    let candidatebyray = false;
    let painted = null;
    let pickclock = 0;
    let stickwidth = 0;
    let stickstep = 0;
    let looparmed = false;
    let bakeclock = 0;
    let message = '';
    let messageclock = 0;
    let methodclock = 0;
    let shownmethod = '';
    let shownaction = '';
    let shownmode = '';
    let shownloop = false;
    let shownmessage = '';

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
        line.name = 'vrmakerspace-xr-ray';
        line.visible = false;
        line.raycast = noRaycast;
        controller.add(line);

        const gripmesh = new THREE.Mesh(gripgeometry, new THREE.MeshStandardMaterial({color: 0x495057, roughness: 0.6}));
        gripmesh.name = 'vrmakerspace-xr-grip';
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
     * Whether the person is modelling now.
     *
     * @returns {boolean}
     */
    const isModelling = () => !!model && method === 'model';

    /**
     * The render data of the mesh now.
     *
     * @returns {Object|null}
     */
    const meshData = () => (engine && typeof engine.polydata === 'function' ? engine.polydata() || null : null);

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
     * @param {number} [strength] 0..1, by default 0.4.
     * @param {number} [length] Milliseconds, by default 25.
     */
    const pulse = (entry, strength = 0.4, length = 25) => {
        const gamepad = entry && entry.source ? entry.source.gamepad : null;
        const actuator = gamepad && gamepad.hapticActuators ? gamepad.hapticActuators[0] : null;
        if (actuator && typeof actuator.pulse === 'function') {
            Promise.resolve().then(() => actuator.pulse(strength, length)).catch(() => null);
        }
    };

    /**
     * Put a message on the label over the tip, replacing the one there (the toolbar cannot be seen in VR).
     *
     * @param {string} text Plain text.
     */
    const showMessage = (text) => {
        message = String(text || '');
        messageclock = message ? MESSAGE_TIME : 0;
    };

    /**
     * Change what would be picked and what marks it.
     *
     * @param {Object|null} hit The new pick.
     * @param {Object|null} data The render data it came from.
     * @param {boolean} byray Whether it came along the controller's ray.
     * @param {Object|null} entry The right input entry, which buzzes when it reaches something new.
     */
    const setCandidate = (hit, data, byray, entry) => {
        if (!mark) {
            return;
        }
        const changed = !sameHit(hit, candidate);
        let next = hit;
        if (changed || data !== candidatedata) {
            if (!mark.show(hit, data)) {
                next = null;
            }
            if (changed && next) {
                pulse(entry, 0.12, 8);
            }
        }
        candidate = next;
        candidatedata = data;
        candidatebyray = !!next && byray;
    };

    /**
     * Whether the trigger would pick something with the current action.
     *
     * @returns {boolean}
     */
    const actionPicks = () => model.action === 'select' || model.action === 'loopcut';

    /**
     * Copy the controller's ray into the sculpture's frame.
     */
    const writeLocalRay = () => {
        rayoriginlocal.copy(rayorigin).applyMatrix4(rootinverse);
        raydirectionlocal.copy(raydirection).applyQuaternion(rootquatinverse).normalize();
        rayoriginlocal.toArray(localray.origin);
        raydirectionlocal.toArray(localray.dir);
    };

    /**
     * Pick what the tip reaches or, beyond that, what the controller points at.
     *
     * @param {Object|null} entry The right input entry.
     */
    const pickNow = (entry) => {
        const data = meshData();
        let hit = null;
        let byray = false;
        if (data && data.vertIds && data.vertIds.length > 0) {
            const mode = looparmed || model.action === 'loopcut' ? 'e' : model.selectMode;
            try {
                const scale = root.matrixWorld.getMaxScaleOnAxis() || 1;
                hit = pickNear(tipPoint(), REACH / scale, data, mode);
                if (!hit && rightinput.rayok) {
                    writeLocalRay();
                    hit = pickRay(localray.origin, localray.dir, data, mode, RAY_TOLERANCE);
                    byray = !!hit;
                }
            } catch (error) {
                Log.debug(error);
                hit = null;
            }
        }
        setCandidate(hit, data, byray, entry);
    };

    /**
     * Keep the candidate current while nothing is pressed or a selection is painted. Picks at most 20 times a
     * second unless the mesh changed: a pick looks at the whole mesh, and its result is the only thing allocated.
     *
     * @param {Object|null} entry The right input entry.
     * @param {number} dt Seconds since the last frame.
     */
    const updateCandidate = (entry, dt) => {
        const busy = rightinput.pointing || right.touching || right.capture;
        const dragging = right.modelling === 'drag' && model.action !== 'loopcut';
        if (busy || dragging || !actionPicks()) {
            setCandidate(null, null, false, null);
            pickclock = 0;
            return;
        }
        pickclock -= dt;
        if (pickclock <= 0 || meshData() !== candidatedata) {
            pickclock = PICK_INTERVAL;
            pickNow(entry);
        }
    };

    /**
     * The aiming ray of the controller while the action picks: up to the candidate, or at full length.
     *
     * @param {Object|null} entry The right input entry.
     */
    const updateAimLine = (entry) => {
        if (!entry || rightinput.pointing || !rightinput.rayok) {
            return;
        }
        const aiming = actionPicks() && right.modelling !== 'drag' && (!candidate || candidatebyray);
        entry.line.visible = aiming;
        if (aiming) {
            let length = RAY_LENGTH;
            if (candidatebyray) {
                anchorworld.copy(mark.anchor).applyMatrix4(root.matrixWorld);
                length = anchorworld.distanceTo(rayorigin);
            }
            entry.line.scale.z = Math.max(0.01, length);
        }
    };

    /**
     * End the running modelling gesture, if any.
     */
    const stopModel = () => {
        if (!model) {
            return;
        }
        const was = right.modelling;
        right.modelling = '';
        painted = null;
        if (was === 'drag') {
            try {
                model.end();
            } catch (error) {
                Log.debug(error);
            }
        }
    };

    /**
     * The drag options of this frame (one reused object: modeltools copies what it keeps).
     *
     * @returns {Object} {quat, hit, ray}
     */
    const dragOptions = () => {
        handlocal.copy(rootquatinverse).multiply(toolquaternion);
        localquat[0] = handlocal.x;
        localquat[1] = handlocal.y;
        localquat[2] = handlocal.z;
        localquat[3] = handlocal.w;
        if (rightinput.rayok) {
            writeLocalRay();
            dragoptions.ray = localray;
        } else {
            dragoptions.ray = null;
        }
        // A cut keeps the last edge it was on while the tip leaves it.
        dragoptions.hit = candidate || (model.action === 'loopcut' ? dragoptions.hit : null);
        return dragoptions;
    };

    /**
     * The point of this frame's drag: the tip, plus the width the stick has added for Inset and Bevel, which take
     * the width from the distance dragged. A cut picked from afar stays on the middle of its edge.
     *
     * @returns {number[]} [x, y, z] (reused).
     */
    const dragPoint = () => {
        const point = tipPoint();
        if (model.action === 'loopcut' && candidatebyray) {
            mark.anchor.toArray(point);
            return point;
        }
        if (stickwidth === 0) {
            return point;
        }
        const dx = point[0] - dragorigin[0];
        const dy = point[1] - dragorigin[1];
        const dz = point[2] - dragorigin[2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const total = Math.max(0, distance + stickwidth);
        const unit = distance > 1e-6 ? total / distance : 0;
        // With the hand still the direction does not matter: only the distance is read.
        point[0] = dragorigin[0] + (distance > 1e-6 ? dx * unit : total);
        point[1] = dragorigin[1] + dy * unit;
        point[2] = dragorigin[2] + dz * unit;
        return point;
    };

    /**
     * The trigger went down with an action: start its drag.
     *
     * @param {Object|null} entry The right input entry.
     */
    const beginDrag = (entry) => {
        if (model.action === 'loopcut' && !candidate) {
            return;
        }
        stickwidth = 0;
        stickstep = 0;
        const start = tipPoint();
        dragorigin[0] = start[0];
        dragorigin[1] = start[1];
        dragorigin[2] = start[2];
        dragoptions.hit = null;
        const result = model.begin(dragPoint(), dragOptions());
        if (result !== false) {
            right.modelling = 'drag';
            pulse(entry);
        }
    };

    /**
     * The trigger went down with Select: pick a loop when one was asked for, otherwise start painting.
     *
     * @param {Object|null} entry The right input entry.
     */
    const beginPaint = (entry) => {
        if (looparmed) {
            if (candidate && candidate.kind === 'e') {
                looparmed = false;
                model.selectLoop(candidate);
                pulse(entry);
            }
            return;
        }
        right.modelling = 'paint';
        painted = null;
        if (candidate) {
            const otherhand = entryOf('left');
            const pad = otherhand && otherhand.source ? otherhand.source.gamepad : null;
            const add = buttonValue(pad, BUTTON_TRIGGER) > 0.5 || inSelection(candidate, model.selection());
            model.selectHit(candidate, {add: add});
            painted = candidate;
            pulse(entry);
        }
    };

    /**
     * The trigger went down while modelling.
     *
     * @param {Object|null} entry The right input entry.
     */
    const modelPress = (entry) => {
        try {
            if (actionPicks()) {
                pickclock = PICK_INTERVAL;
                pickNow(entry);
            }
            if (model.action === 'select') {
                beginPaint(entry);
            } else {
                beginDrag(entry);
            }
        } catch (error) {
            Log.debug(error);
            right.modelling = '';
        }
    };

    /**
     * The trigger stays down while modelling: paint on, or carry on the drag.
     */
    const modelHold = () => {
        try {
            if (right.modelling === 'paint') {
                if (candidate && !sameHit(candidate, painted)) {
                    painted = candidate;
                    model.selectHit(candidate, addoptions);
                }
            } else if (!model.active) {
                // Refused or ended by modeltools.
                right.modelling = '';
            } else {
                model.move(dragPoint(), dragOptions());
            }
        } catch (error) {
            Log.debug(error);
            stopModel();
        }
    };

    /**
     * Change the segments, as far as the action takes them.
     *
     * @param {number} step Change.
     */
    const changeSegments = (step) => {
        // Bevel, Loop cut and the shapes each have their own range.
        const range = model.segmentRange();
        const value = clamp((Number(model.segments) || range.min) + step, range.min, range.max);
        if (value !== model.segments) {
            model.setSegments(value);
        }
    };

    /**
     * The stick's change of the segments: repeated while it is held over.
     *
     * @param {number} amount Deflection, -1..1.
     * @param {number} dt Seconds since the last frame.
     */
    const stickSegments = (amount, dt) => {
        if (amount === 0) {
            stickstep = 0;
            return;
        }
        stickstep += amount * SEGMENT_RATE * dt;
        if (Math.abs(stickstep) >= 1) {
            changeSegments(stickstep > 0 ? 1 : -1);
            stickstep = 0;
        }
    };

    /**
     * The stick while modelling: width or segments, as the action suits.
     *
     * @param {number} x Left and right deflection.
     * @param {number} y Up and down deflection (negative is pushed forward).
     * @param {number} dt Seconds since the last frame.
     */
    const modelStick = (x, y, dt) => {
        const action = model.action;
        if (right.modelling === 'drag' && (action === 'inset' || action === 'bevel')) {
            // Pushing the stick forward widens.
            stickwidth = clamp(stickwidth - y * WIDTH_RATE * dt, -WIDTH_LIMIT, WIDTH_LIMIT);
            stickSegments(action === 'bevel' ? x : 0, dt);
        } else if (action === 'bevel' || action === 'loopcut') {
            stickSegments(-y, dt);
        }
    };

    /**
     * Change the action by a step in palette order.
     *
     * @param {number} step 1 or -1.
     */
    const stepAction = (step) => {
        const index = ACTIONS.indexOf(model.action);
        stopModel();
        model.setAction(ACTIONS[((index < 0 ? 0 : index) + step + ACTIONS.length) % ACTIONS.length]);
    };

    /**
     * Show the editing marks of the mesh (edges, vertices, selections) while modelling in VR.
     */
    const showEditing = () => {
        const view = engine ? engine.poly : null;
        if (active && model && view && typeof view.setShowEditing === 'function') {
            view.setShowEditing(method === 'model');
        }
    };

    /**
     * Change the method.
     *
     * @param {string} name 'sculpt' or 'model'.
     * @param {boolean} told Whether to tell the studio (the person chose it here).
     */
    const applyMethod = (name, told) => {
        const next = name === 'model' ? 'model' : 'sculpt';
        if (next === method || (next === 'model' && !model) || (next === 'sculpt' && methods === 'model')) {
            return;
        }
        stopStroke();
        stopModel();
        looparmed = false;
        bakeclock = 0;
        method = next;
        methodclock = METHOD_TIME;
        palette.setMethod(method);
        setCandidate(null, null, false, null);
        showEditing();
        if (told && typeof options.onMethod === 'function') {
            options.onMethod(method);
        }
    };

    /**
     * Add a shape from the palette at the hand, inside what a mesh may reach.
     *
     * @param {string} name Shape name.
     */
    const addShapeAtHand = (name) => {
        const limit = COORD_MAX - SHAPE_SIZE;
        const point = tipPoint();
        model.addShape(name, [clamp(point[0], -limit, limit), clamp(point[1], -limit, limit), clamp(point[2], -limit, limit)],
            SHAPE_SIZE);
    };

    /**
     * Use a one-shot tool. Turn into clay asks to be pressed again: there is no dialog in VR.
     *
     * @param {string} name Tool name.
     */
    const useOneShot = (name) => {
        if (name === 'bake' && bakeclock <= 0) {
            bakeclock = BAKE_WINDOW;
            showMessage(strings.bakeconfirm);
            messageclock = BAKE_WINDOW;
            return;
        }
        bakeclock = 0;
        showMessage('');
        stopModel();
        model.runOneShot(name);
    };

    /**
     * Use a control of the method switch or the Model page.
     *
     * @param {Object} hit Palette hit.
     * @returns {boolean} Whether the control was one of these.
     */
    const useModelControl = (hit) => {
        const name = hit.tool;
        if (bakeclock > 0 && (hit.region !== 'oneshot' || name !== 'bake')) {
            // Anything else takes back the first press of Turn into clay.
            bakeclock = 0;
            showMessage('');
        }
        switch (hit.region) {
            case 'method':
                applyMethod(name, true);
                return true;
            case 'selmode':
                looparmed = false;
                model.setSelectMode(name);
                return true;
            case 'selcmd':
                if (name === 'loop') {
                    // The next pick on an edge selects its loop.
                    looparmed = !looparmed;
                    if (looparmed && model.action !== 'select') {
                        stopModel();
                        model.setAction('select');
                    }
                } else if (name === 'all') {
                    model.selectAll();
                } else if (name === 'none') {
                    model.selectNone();
                } else {
                    model.selectLinked();
                }
                return true;
            case 'action':
                looparmed = false;
                stopModel();
                model.setAction(name);
                return true;
            case 'axis':
                model.setAxis(name === 'free' ? null : name);
                return true;
            case 'segdown':
                changeSegments(-1);
                return true;
            case 'segup':
                changeSegments(1);
                return true;
            case 'shape':
                addShapeAtHand(name);
                return true;
            case 'oneshot':
                useOneShot(name);
                return true;
            default:
                return false;
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
        if (isModelling()) {
            stepAction(step);
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
        if (right.modelling === 'drag') {
            // The button cancels the gesture in progress: nothing older is undone with it.
            right.modelling = '';
            model.cancel();
            return;
        }
        if (redo ? tools.canRedo() : tools.canUndo()) {
            if (redo) {
                tools.redo();
            } else {
                tools.undo();
            }
        }
    };

    /**
     * Use a control of the method switch or the Model page, whatever it throws.
     *
     * @param {Object} hit Palette hit.
     * @returns {boolean} Whether the control was one of these.
     */
    const useModelPalette = (hit) => {
        try {
            return useModelControl(hit);
        } catch (error) {
            Log.debug(error);
            return true;
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
        } else if (model && useModelPalette(hit)) {
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
        if (isModelling()) {
            modelStick(x, y, dt);
            return;
        }
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
    const rightinput = {tracked: false, value: 0, pointing: null, hover: null, rayok: false};

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
            rightinput.rayok = true;
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
            } else if (isModelling()) {
                modelPress(entry);
            } else if (tools) {
                beginStroke(value);
            }
        } else if (pressed && right.capture) {
            if (pointing && pointing.region === right.capture) {
                usePalette(pointing, true);
            }
        } else if (pressed && right.modelling) {
            modelHold();
        } else if (pressed && right.stroking) {
            moveStroke(value);
        } else if (!pressed && right.pressed) {
            right.capture = null;
            stopStroke();
            stopModel();
        }
        right.pressed = pressed;
    };

    /**
     * Place and colour the modelling cursor at the tip: a sphere the size of the reach and a dot at its centre, in the
     * action's colour. Its size is in the room, because the reach is.
     */
    const updateModelCursor = () => {
        const action = String(model.action);
        cursor.position.copy(tipworld);
        cursor.scale.setScalar(REACH);
        if (action !== cursortool) {
            cursortool = action;
            cursormaterial.color.setHex(ACTION_COLOURS[action] === undefined ? 0xffffff : ACTION_COLOURS[action]);
            dotmaterial.color.setHex(ACTION_COLOURS[action] === undefined ? 0xffffff : ACTION_COLOURS[action]);
        }
        cursormaterial.opacity = right.modelling || candidate ? 0.32 : 0.18;
        const shown = !rightinput.pointing && !right.touching;
        cursor.visible = shown;
        dot.position.copy(tipworld);
        dot.visible = shown;
    };

    /**
     * Place and colour the tool cursor at the tip.
     */
    const updateCursor = () => {
        if (!tools) {
            cursor.visible = false;
            return;
        }
        if (isModelling()) {
            updateModelCursor();
            return;
        }
        if (dot) {
            dot.visible = false;
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
     * The words on the label: the method, and when modelling the action and what it picks. Words are only put
     * together when something they name has changed.
     */
    const refreshLabel = () => {
        const action = String(model.action);
        const mode = String(model.selectMode);
        if (method === shownmethod && action === shownaction && mode === shownmode && looparmed === shownloop &&
                message === shownmessage) {
            return;
        }
        shownmethod = method;
        shownaction = action;
        shownmode = mode;
        shownloop = looparmed;
        shownmessage = message;
        const words = [strings['method_' + method] || ''];
        if (method === 'model') {
            words.push(looparmed ? strings.selectloop || '' : strings['action_' + action] || '');
            if (action === 'select' && !looparmed) {
                words.push(strings[MODE_KEYS[mode]] || '');
            }
        }
        label.setLines(words.filter((word) => word !== '').join(' \u00b7 '), message);
    };

    /**
     * Keep the label over the tip: always while modelling; while sculpting only after a switch or for a message.
     *
     * @param {number} dt Seconds since the last frame.
     */
    const updateLabel = (dt) => {
        if (!label) {
            return;
        }
        methodclock = Math.max(0, methodclock - dt);
        if (messageclock > 0) {
            messageclock -= dt;
            if (messageclock <= 0) {
                message = '';
            }
        }
        const quiet = method !== 'model' && methodclock <= 0 && message === '';
        if (quiet || (rightinput.pointing && message === '')) {
            label.sprite.visible = false;
            return;
        }
        refreshLabel();
        label.sprite.position.copy(tipworld);
        label.sprite.position.y += LABEL_RISE;
        label.sprite.visible = true;
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
        rightinput.rayok = false;
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
            stopModel();
            right.pressed = false;
            right.capture = null;
            cursor.visible = false;
            setCandidate(null, null, false, null);
            if (dot) {
                dot.visible = false;
            }
            if (label) {
                label.sprite.visible = false;
            }
            palette.setHover(null);
            return;
        }
        if (isModelling()) {
            updateCandidate(entry, dt);
        }
        applyRightPress(entry);
        palette.setHover(rightinput.hover);
        updateCursor();
        if (isModelling()) {
            updateAimLine(entry);
        }
        updateLabel(dt);
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
        stopModel();
        setCandidate(null, null, false, null);
        looparmed = false;
        bakeclock = 0;
        showMessage('');
        if (dot) {
            dot.visible = false;
        }
        if (label) {
            label.sprite.visible = false;
        }
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
        methodclock = METHOD_TIME;
        reset();
        if (typeof options.onStart === 'function') {
            options.onStart();
        }
        showEditing();
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

    if (model && engine && typeof engine.on === 'function') {
        const stoplistening = engine.on('meshrefused', (detail) => {
            const text = detail ? strings['meshrefused_' + detail.reason] : '';
            if (active && text) {
                showMessage(text);
            }
        });
        if (typeof stoplistening === 'function') {
            removers.push(stoplistening);
        }
    }

    const api = {
        /** @returns {string} The method used in VR now, 'sculpt' or 'model'. */
        get method() {
            return method;
        },

        /**
         * Follow the method chosen outside VR (ignored when the activity does not allow it).
         *
         * @param {string} name 'sculpt' or 'model'.
         */
        setMethod(name) {
            if (!disposed) {
                applyMethod(name, false);
            }
        },

        /**
         * Show a passing message in VR, where the toolbar cannot be seen; one replaces another.
         *
         * @param {string} text Plain text.
         */
        showMessage(text) {
            if (!disposed && active && label) {
                showMessage(text);
            }
        },

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
            if (model) {
                bakeclock = Math.max(0, bakeclock - step);
                modelstate.selectmode = model.selectMode;
                modelstate.action = model.action;
                modelstate.axis = model.axis || 'free';
                modelstate.segments = model.segments;
                modelstate.looparmed = looparmed;
                modelstate.bakearmed = bakeclock > 0;
                palette.setModelState(modelstate);
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
            if (dot) {
                scene.remove(dot);
                dotmaterial.dispose();
            }
            if (mark) {
                mark.dispose();
            }
            if (label) {
                label.dispose();
            }
            cursorgeometry.dispose();
            cursormaterial.dispose();
            linegeometry.dispose();
            gripgeometry.dispose();
            palette.dispose();
        },
    };
    return api;
};
