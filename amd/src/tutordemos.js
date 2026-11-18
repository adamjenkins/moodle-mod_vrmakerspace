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
 * The tutor's demonstrations: "Show me" does the real action on the practice piece, slowly enough to watch.
 *
 * Each demo works through the same calls the mouse and VR input make: tools.begin, move and end with
 * sculpture-local points for the clay tools (as mod_vrmakerspace/desktopinput does), and the mesh tools'
 * selectHit, addShape, setAction, begin, move and end (as mod_vrmakerspace/modelinput does). So what a
 * demo does is an ordinary stroke of the student's own: everyone in the room sees it, and Undo takes it
 * back. A brush stroke follows a path over the clay, found by casting rays at the piece from the
 * viewer's side before the stroke starts (so Add does not climb its own clay); the mesh demos work on
 * the face of the polygon mesh that faces the viewer most, adding a cube first when there is no mesh.
 *
 * The demo is driven by the tutor's frames (ctx.frame()), so it runs on a desktop and in VR alike.
 * Before its first action each demo reports its working spot on the piece (sculpture-local) through
 * ctx.onSpot(point) and waits for the promise it gives: the tutor flies beside that spot first.
 * Afterwards the tool, mirror, method, select mode, drag action and axis lock are put back as they
 * were. A demo that cannot run says why on the toolbar and resolves false; it never throws.
 *
 * No Moodle or three.js imports (three.js comes in as ctx.THREE), so the helpers and the demos run
 * in Node: tests/js/tutordemos.test.mjs.
 *
 * @module     mod_vrmakerspace/tutordemos
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** The demos there are, by the names of the tour's steps. */
export const DEMO_NAMES = Object.freeze(['add', 'carve', 'smooth', 'inflate', 'pinch', 'flatten', 'grab', 'twist', 'mirror',
    'shape', 'cutshape', 'addshape', 'select', 'move', 'rotate', 'scale', 'extrude', 'inset', 'bevel', 'loopcut']);

/** How a demo ended. */
const DONE = 'done';
const FAILED = 'failed';
const NOMESH = 'nomesh';
const REFUSED = 'refused';
const CANCELLED = 'cancelled';

/** Where the viewer is (sculpture-local) when nobody has said: the studio camera's start. */
const DEFAULT_VIEWER = [0, 0.12, 0.62];

/** Seconds: the hand going to where a demo starts, a brush stroke, a mesh drag, placing something, holding still. */
const APPROACH_TIME = 0.6;
const STROKE_TIME = 2.2;
const DRAG_TIME = 2.0;
const PLACE_TIME = 1.0;
const HOLD_TIME = 0.6;

/** Longest and shortest frame a demo steps by (s): a stalled frame does not make it jump. */
const MAX_STEP = 0.1;
const MIN_STEP = 1 / 60;

/** Longest wait for the drawing data of a new mesh (s). */
const MESH_WAIT = 2.5;

/** Points along a brush path. */
const PATH_SAMPLES = 16;

/** Rays at the piece start this far from its centre (m), and miss it to this radius (m): the lump's size. */
const CAST_REACH = 0.6;
const FALLBACK_RADIUS = 0.1;

/** How far above the surface the hand holds the tool (m), on top of the brush radius. */
const HAND_LIFT = 0.012;

/** Brush paths: [yaw from, yaw to, pitch from, pitch to] (rad) about the view's centre, seen from the viewer. */
const BRUSH_PATHS = Object.freeze({
    add: [-0.5, 0.5, 0.35, 0.35],
    carve: [0.45, -0.45, 0.02, 0.06],
    smooth: [-0.55, 0.55, 0.3, 0.4],
    inflate: [-0.35, 0.15, -0.3, -0.15],
    pinch: [-0.45, 0.45, 0.15, 0.15],
    flatten: [-0.45, 0.45, 0.85, 0.85],
});

/** Grab: how far the clay is pulled out along the normal and up (m). */
const GRAB_PULL = 0.035;
const GRAB_LIFT = 0.012;

/** Twist: how far it turns (rad), and the radius of the hand's circle (m). */
const TWIST_ANGLE = 1.0;
const TWIST_HAND = 0.02;

/** Where the shape tools place their shape: [yaw, pitch] (rad). */
const SHAPE_SPOTS = Object.freeze({shape: [0.2, 0.9], cutshape: [-0.25, 0.1]});

/** A new mesh shape: its size, how far it may be from the centre, and the gap above what is there (m), as studio.js. */
const NEW_SHAPE_SIZE = 0.06;
const NEW_SHAPE_REACH = 0.3;
const SHAPE_GAP = 0.015;

/** Mesh drags (m and rad). */
const MOVE_SIDE = 0.05;
const MOVE_UP = 0.02;
const ROTATE_ARM = 0.05;
const ROTATE_ANGLE = 0.8;
const SCALE_ARM = 0.04;
const SCALE_GROWTH = 0.5;
const EXTRUDE_LENGTH = 0.04;
const INSET_WIDTH = 0.015;
const BEVEL_WIDTH = 0.01;
const LOOP_SLIDE = 0.12;

/** Message time on the toolbar (ms), as studio.js. */
const MESSAGE_TIME = 5000;

/**
 * A number brought between 0 and 1.
 *
 * @param {number} v Value.
 * @returns {number}
 */
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Ease in and out: slow at the start and the end, as a hand would move.
 *
 * @param {number} s Progress, 0 to 1.
 * @returns {number} Eased progress, 0 to 1.
 */
export const ease = (s) => {
    const t = clamp01(Number(s) || 0);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
};

/**
 * The sum of two vectors.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]}
 */
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * The difference of two vectors.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]} a - b.
 */
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * A vector times a number.
 *
 * @param {number[]} v Vector.
 * @param {number} s Factor.
 * @returns {number[]}
 */
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];

/**
 * The dot product.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number}
 */
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The cross product.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]}
 */
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * A vector's length.
 *
 * @param {number[]} v Vector.
 * @returns {number}
 */
const length3 = (v) => Math.sqrt(dot3(v, v));

/**
 * A vector of length one.
 *
 * @param {number[]} v Vector.
 * @param {?number[]} fallback What a vector of no length gives.
 * @returns {?number[]}
 */
const unit3 = (v, fallback = null) => {
    const length = length3(v);
    return length > 1e-9 && Number.isFinite(length) ? scale3(v, 1 / length) : fallback;
};

/**
 * Between two points.
 *
 * @param {number[]} a From.
 * @param {number[]} b To.
 * @param {number} t How far, 0 to 1.
 * @returns {number[]}
 */
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A point or direction as [x, y, z], from an array or an object with x, y and z (a THREE.Vector3).
 *
 * @param {*} v The value.
 * @returns {?number[]} Null when it is not three finite numbers.
 */
export const vec3 = (v) => {
    if (!v) {
        return null;
    }
    const out = Array.isArray(v) ? [Number(v[0]), Number(v[1]), Number(v[2])] : [Number(v.x), Number(v.y), Number(v.z)];
    return out.every(Number.isFinite) ? out : null;
};

/**
 * The directions of the view from the piece's centre: d at the viewer, right and up as the viewer sees them.
 *
 * @param {?number[]} viewer Where the viewer is, sculpture-local.
 * @returns {{d: number[], right: number[], up: number[]}} Unit vectors at right angles.
 */
export const viewBasis = (viewer) => {
    const d = unit3(vec3(viewer) || DEFAULT_VIEWER, [0, 0, 1]);
    // Looking straight down or up, the sculpture's x is to the right.
    const right = unit3(cross3([0, 1, 0], d), [1, 0, 0]);
    return {d: d, right: right, up: unit3(cross3(d, right), [0, 1, 0])};
};

/**
 * A direction turned from the view's: yaw to the right, pitch up.
 *
 * @param {Object} basis From viewBasis().
 * @param {number} yaw Turn to the right (rad).
 * @param {number} pitch Turn up (rad).
 * @returns {number[]} Unit vector.
 */
export const direction = (basis, yaw, pitch) => unit3(add3(add3(
    scale3(basis.d, Math.cos(pitch) * Math.cos(yaw)),
    scale3(basis.right, Math.cos(pitch) * Math.sin(yaw))),
    scale3(basis.up, Math.sin(pitch))), basis.d);

/**
 * Directions swept from one turn of the view's direction to another.
 *
 * @param {Object} basis From viewBasis().
 * @param {number[]} path [yaw from, yaw to, pitch from, pitch to] (rad).
 * @param {number} [count] How many.
 * @returns {number[][]} Unit vectors, at least two.
 */
export const sweepDirections = (basis, path, count = PATH_SAMPLES) => {
    const n = Math.max(2, Math.round(count));
    const out = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        out.push(direction(basis, path[0] + (path[1] - path[0]) * t, path[2] + (path[3] - path[2]) * t));
    }
    return out;
};

/**
 * Directions between two directions.
 *
 * @param {number[]} a From.
 * @param {number[]} b To.
 * @param {number} [count] How many.
 * @returns {number[][]} Unit vectors, at least two.
 */
export const lineDirections = (a, b, count = PATH_SAMPLES) => {
    const n = Math.max(2, Math.round(count));
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(unit3(lerp3(a, b, i / (n - 1)), unit3(a, [0, 0, 1])));
    }
    return out;
};

/**
 * A vector turned about an axis (Rodrigues' formula).
 *
 * @param {number[]} v The vector.
 * @param {number[]} axis Unit axis.
 * @param {number} angle Angle (rad), anticlockwise looking down the axis.
 * @returns {number[]}
 */
export const rotateAbout = (v, axis, angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return add3(add3(scale3(v, cos), scale3(cross3(axis, v), sin)), scale3(axis, dot3(axis, v) * (1 - cos)));
};

/**
 * How far along a path each of its points lies.
 *
 * @param {number[][]} points The path.
 * @returns {number[]} Distances from the first point, one per point.
 */
export const pathLengths = (points) => {
    const out = [0];
    for (let i = 1; i < points.length; i++) {
        out.push(out[i - 1] + length3(sub3(points[i], points[i - 1])));
    }
    return out;
};

/**
 * The point a share of the way along a path; with points of no length between them, by count instead.
 *
 * @param {number[][]} values Points (or anything per point to blend, such as normals).
 * @param {number[]} lengths From pathLengths() of the path the values go with.
 * @param {number} s Share of the way, 0 to 1.
 * @returns {number[]}
 */
export const pointAlong = (values, lengths, s) => {
    const last = values.length - 1;
    if (last <= 0) {
        return values[0].slice();
    }
    const t = clamp01(s);
    const total = lengths[last];
    if (!(total > 1e-9)) {
        const at = t * last;
        const i = Math.min(last - 1, Math.floor(at));
        return lerp3(values[i], values[i + 1], at - i);
    }
    const wanted = t * total;
    let i = 0;
    while (i < last - 1 && lengths[i + 1] < wanted) {
        i++;
    }
    const span = lengths[i + 1] - lengths[i];
    return lerp3(values[i], values[i + 1], span > 1e-12 ? (wanted - lengths[i]) / span : 0);
};

/**
 * A polygon's normal by Newell's method (its winding gives its side).
 *
 * @param {number[][]} corners Corner positions in order.
 * @returns {?number[]} Unit normal.
 */
const newellNormal = (corners) => {
    const n = [0, 0, 0];
    corners.forEach((a, i) => {
        const b = corners[(i + 1) % corners.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    });
    return unit3(n);
};

/**
 * The own normal of each face, from its first triangle in the drawing data.
 *
 * @param {Object} data Drawing data (polymesh.renderData).
 * @returns {Map<number, number[]>} Face index to unit normal.
 */
const faceNormals = (data) => {
    const out = new Map();
    if (!data.triFace || !data.triNormal) {
        return out;
    }
    for (let tri = 0; tri < data.triFace.length; tri++) {
        const face = data.triFace[tri];
        if (!out.has(face)) {
            const at = tri * 9;
            const n = unit3([data.triNormal[at], data.triNormal[at + 1], data.triNormal[at + 2]]);
            if (n) {
                out.set(face, n);
            }
        }
    }
    return out;
};

/**
 * The corners of a face.
 *
 * @param {Object} data Drawing data.
 * @param {number} face Face index.
 * @returns {Array<{id: number, pos: number[]}>} Vertex ids and positions, in order.
 */
const faceCorners = (data, face) => {
    const out = [];
    for (let i = data.faceStart[face]; i < data.faceStart[face + 1]; i++) {
        const index = data.faceVerts[i];
        const at = index * 3;
        out.push({id: data.vertIds[index], pos: [data.vertPos[at], data.vertPos[at + 1], data.vertPos[at + 2]]});
    }
    return out;
};

/**
 * Whether drawing data has the arrays of faces a demo reads.
 *
 * @param {*} data Drawing data, or anything.
 * @returns {boolean}
 */
const hasFaces = (data) => !!data && !!data.faceIds && data.faceIds.length > 0 && !!data.faceStart && !!data.faceVerts
    && !!data.vertIds && !!data.vertPos;

/**
 * The face of the mesh that faces the viewer most (nearer ones win a close call).
 *
 * @param {?Object} data Drawing data (polymesh.renderData).
 * @param {number[]} view Unit vector from the piece at the viewer.
 * @returns {?{index: number, id: number, centroid: number[], normal: number[], corners: Array}} Null without faces.
 */
export const frontFace = (data, view) => {
    if (!hasFaces(data)) {
        return null;
    }
    const normals = faceNormals(data);
    let best = null;
    for (let face = 0; face < data.faceIds.length; face++) {
        const corners = faceCorners(data, face);
        if (corners.length < 3) {
            continue;
        }
        const normal = normals.get(face) || newellNormal(corners.map((c) => c.pos));
        if (!normal) {
            continue;
        }
        const centroid = scale3(corners.reduce((sum, c) => add3(sum, c.pos), [0, 0, 0]), 1 / corners.length);
        const score = dot3(normal, view) + dot3(centroid, view);
        if (best === null || score > best.score) {
            best = {index: face, id: data.faceIds[face], centroid, normal, corners, score};
        }
    }
    return best;
};

/**
 * The edges of a face.
 *
 * @param {Object} face From frontFace().
 * @returns {Array<{a: number, b: number, pa: number[], pb: number[], mid: number[]}>} Vertex ids and positions.
 */
const faceEdges = (face) => face.corners.map((c, i) => {
    const next = face.corners[(i + 1) % face.corners.length];
    return {a: c.id, b: next.id, pa: c.pos, pb: next.pos, mid: lerp3(c.pos, next.pos, 0.5)};
});

/**
 * The highest edge of a face.
 *
 * @param {Object} face From frontFace().
 * @param {number[]} up Which way is up.
 * @returns {Object} The edge {a, b, pa, pb, mid}.
 */
export const topEdge = (face, up) => faceEdges(face).reduce((best, e) => (dot3(e.mid, up) > dot3(best.mid, up) ? e : best));

/**
 * The edge of a face that stands most upright: a loop cut through it goes round the mesh.
 *
 * @param {Object} face From frontFace().
 * @param {number[]} up Which way is up.
 * @returns {Object} The edge {a, b, pa, pb, mid}.
 */
export const sideEdge = (face, up) => {
    /**
     * How upright an edge stands.
     *
     * @param {Object} e The edge.
     * @returns {number} 0 (flat) to 1 (straight up).
     */
    const upright = (e) => Math.abs(dot3(unit3(sub3(e.pb, e.pa), [0, 0, 0]), up));
    return faceEdges(face).reduce((best, e) => (upright(e) > upright(best) ? e : best));
};

/**
 * The height of the highest vertex of the mesh.
 *
 * @param {?Object} data Drawing data.
 * @returns {?number} Null without vertices.
 */
export const meshTop = (data) => {
    if (!data || !data.vertPos || data.vertPos.length < 3) {
        return null;
    }
    let top = -Infinity;
    for (let i = 1; i < data.vertPos.length; i += 3) {
        top = Math.max(top, data.vertPos[i]);
    }
    return Number.isFinite(top) ? top : null;
};

/**
 * Where a new shape goes: above what is there already, or in the middle when there is nothing.
 *
 * @param {?number} top The height of the top of the piece, or null.
 * @returns {number[]} Sculpture-local point.
 */
export const shapeSpot = (top) => (top === null || !Number.isFinite(top) ? [0, 0, 0]
    : [0, Math.min(NEW_SHAPE_REACH, Math.max(-NEW_SHAPE_REACH, top + NEW_SHAPE_SIZE + SHAPE_GAP)), 0]);

/**
 * Log an error where the studio logs.
 *
 * @param {Object} ctx Demo context.
 * @param {*} error The error.
 */
const logError = (ctx, error) => {
    if (ctx && typeof ctx.log === 'function') {
        ctx.log(error);
    }
};

/**
 * Show a passing message by its string key: through ctx.message (toolbar and VR) or the toolbar.
 *
 * @param {Object} ctx Demo context.
 * @param {string} key String key.
 */
const say = (ctx, key) => {
    const text = ctx && ctx.strings ? ctx.strings[key] : '';
    if (!text) {
        return;
    }
    try {
        if (typeof ctx.message === 'function') {
            ctx.message(text);
        } else if (ctx.toolbar && typeof ctx.toolbar.message === 'function') {
            ctx.toolbar.message(text, MESSAGE_TIME);
        }
    } catch (e) {
        logError(ctx, e);
    }
};

/**
 * The method the studio is in.
 *
 * @param {Object} ctx Demo context.
 * @returns {string}
 */
const methodOf = (ctx) => String((typeof ctx.method === 'function' ? ctx.method() : ctx.method) || '');

/**
 * Switch to a method for a demo.
 *
 * @param {Object} ctx Demo context.
 * @param {string} name 'sculpt' or 'model'.
 * @returns {boolean} Whether the studio is in it now (as far as can be told).
 */
const useMethod = (ctx, name) => {
    if (methodOf(ctx) !== name && typeof ctx.setMethod === 'function') {
        ctx.setMethod(name);
    }
    return typeof ctx.method !== 'function' || methodOf(ctx) === name;
};

/**
 * What a demo may change, as it is before.
 *
 * @param {Object} ctx Demo context.
 * @returns {Object}
 */
const saveState = (ctx) => ({
    method: methodOf(ctx),
    tool: ctx.tools ? ctx.tools.tool : null,
    mirror: ctx.tools ? !!ctx.tools.mirror : false,
    action: ctx.modeltools ? ctx.modeltools.action : null,
    axis: ctx.modeltools ? ctx.modeltools.axis : null,
    selectMode: ctx.modeltools ? ctx.modeltools.selectMode : null,
});

/**
 * Finish what a demo left going and put the clay tools back.
 *
 * @param {Object} tools The clay tools.
 * @param {Object} saved From saveState().
 */
const restoreTools = (tools, saved) => {
    tools.end();
    if (saved.tool && tools.tool !== saved.tool) {
        tools.setTool(saved.tool);
    }
    if (!!tools.mirror !== saved.mirror) {
        tools.setMirror(saved.mirror);
    }
};

/**
 * Finish what a demo left going and put the mesh tools back.
 *
 * @param {Object} model The mesh tools.
 * @param {Object} saved From saveState().
 */
const restoreModel = (model, saved) => {
    if (model.active) {
        model.end();
    }
    if (saved.action && model.action !== saved.action) {
        model.setAction(saved.action);
    }
    if (model.axis !== saved.axis) {
        model.setAxis(saved.axis);
    }
    if (saved.selectMode && model.selectMode !== saved.selectMode) {
        model.setSelectMode(saved.selectMode);
    }
};

/**
 * Put back what a demo changed; the method last, so the tools are put back where they belong.
 *
 * @param {Object} ctx Demo context.
 * @param {Object} saved From saveState().
 */
const restoreState = (ctx, saved) => {
    const steps = [
        () => ctx.tools && restoreTools(ctx.tools, saved),
        () => ctx.modeltools && restoreModel(ctx.modeltools, saved),
        () => saved.method && typeof ctx.setMethod === 'function' && ctx.setMethod(saved.method),
        () => ctx.hand(null, null),
    ];
    steps.forEach((step) => {
        try {
            step();
        } catch (e) {
            logError(ctx, e);
        }
    });
};

/**
 * Run a step every frame for a time.
 *
 * @param {Object} ctx Demo context.
 * @param {number} seconds How long.
 * @param {function(number)} step Called each frame with the share of the time gone, ending with 1.
 * @returns {Promise<boolean>} False when the demo was called off.
 */
const animate = async(ctx, seconds, step) => {
    let t = 0;
    while (t < seconds) {
        const dt = Number(await ctx.frame());
        if (ctx.cancelled()) {
            return false;
        }
        t = Math.min(seconds, t + (Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_STEP) : MIN_STEP));
        step(t / seconds);
    }
    return true;
};

/**
 * Report the working spot before the first action and wait for the tutor to fly there.
 *
 * @param {Object} ctx Demo context.
 * @param {number[]} point The spot, sculpture-local.
 * @returns {Promise<boolean>} False when the demo was called off meanwhile.
 */
const goTo = async(ctx, point) => {
    if (typeof ctx.onSpot === 'function' && point) {
        try {
            await ctx.onSpot(point.slice());
        } catch (e) {
            logError(ctx, e);
        }
    }
    return !ctx.cancelled();
};

/**
 * Move the tutor's hand to where a demo starts.
 *
 * @param {Object} ctx Demo context.
 * @param {number[]} to Where the hand goes.
 * @param {?number[]} target What it points at.
 * @param {number} seconds How long it takes.
 * @returns {Promise<boolean>} False when the demo was called off.
 */
const approach = (ctx, to, target, seconds) => {
    const from = vec3(ctx.handPosition()) || to;
    return animate(ctx, seconds, (s) => ctx.hand(lerp3(from, to, ease(s)), target));
};

/**
 * Hold the hand still for a moment, drawn back a little from where it worked.
 *
 * @param {Object} ctx Demo context.
 * @param {number[]} away Which way it draws back (unit).
 * @returns {Promise<string>} DONE, or CANCELLED.
 */
const hold = async(ctx, away) => {
    const from = vec3(ctx.handPosition());
    if (!from) {
        return DONE;
    }
    const ok = await animate(ctx, HOLD_TIME, (s) => ctx.hand(add3(from, scale3(away, 0.02 * ease(s))), null));
    return ok ? DONE : CANCELLED;
};

/**
 * The view directions of a demo, from where the tutor last saw the viewer.
 *
 * @param {Object} ctx Demo context.
 * @returns {Object} From viewBasis().
 */
const basisOf = (ctx) => viewBasis(typeof ctx.view === 'function' ? ctx.view() : null);

/**
 * Every mesh of the piece that rays can hit: the clay's and the polygon mesh's (as desktopinput picks).
 *
 * @param {Object} engine The engine client.
 * @returns {Object[]} THREE.Mesh objects.
 */
const castMeshes = (engine) => {
    const list = [];
    if (typeof engine.meshes === 'function') {
        list.push(...engine.meshes());
    }
    if (engine.poly && typeof engine.poly.meshes === 'function') {
        list.push(...engine.poly.meshes());
    }
    return list;
};

/**
 * Where a ray from outside the piece, coming in along a direction towards its centre, meets it.
 *
 * @param {Object} ctx Demo context (THREE, sculptureRoot and engine).
 * @param {number[]} dir Unit direction from the centre out to where the ray starts, sculpture-local.
 * @returns {{point: number[], normal: number[], hit: boolean}} Sculpture-local; without a hit, a point at the
 *     lump's radius along the direction.
 */
const surfaceAt = (ctx, dir) => {
    const fallback = {point: scale3(dir, FALLBACK_RADIUS), normal: dir.slice(), hit: false};
    const {THREE, sculptureRoot, engine} = ctx;
    if (!THREE || !sculptureRoot || !engine) {
        return fallback;
    }
    const meshes = castMeshes(engine);
    if (meshes.length === 0) {
        return fallback;
    }
    sculptureRoot.updateWorldMatrix(true, true);
    const origin = sculptureRoot.localToWorld(new THREE.Vector3(dir[0] * CAST_REACH, dir[1] * CAST_REACH, dir[2] * CAST_REACH));
    const rootquat = new THREE.Quaternion();
    sculptureRoot.getWorldQuaternion(rootquat);
    const way = new THREE.Vector3(-dir[0], -dir[1], -dir[2]).applyQuaternion(rootquat).normalize();
    const hits = new THREE.Raycaster(origin, way).intersectObjects(meshes, false);
    if (hits.length === 0) {
        return fallback;
    }
    const local = sculptureRoot.worldToLocal(hits[0].point.clone());
    let normal = dir.slice();
    if (hits[0].face) {
        // The face normal, from the mesh's frame to the world's, then to the sculpture's (as desktopinput).
        const normalmatrix = new THREE.Matrix3().getNormalMatrix(hits[0].object.matrixWorld);
        const n = hits[0].face.normal.clone().applyMatrix3(normalmatrix).applyQuaternion(rootquat.invert()).normalize();
        normal = unit3([n.x, n.y, n.z], dir);
        if (dot3(normal, dir) < 0) {
            normal = scale3(normal, -1);
        }
    }
    return {point: [local.x, local.y, local.z], normal: normal, hit: true};
};

/**
 * A brush stroke along a path over the clay.
 *
 * @param {Object} ctx Demo context.
 * @param {string} tool The brush.
 * @param {number[][]} dirs Directions from the centre whose surface points the stroke goes through.
 * @returns {Promise<string>} How it ended.
 */
const brushStroke = async(ctx, tool, dirs) => {
    const tools = ctx.tools;
    if (!tools || !useMethod(ctx, 'sculpt')) {
        return FAILED;
    }
    tools.setTool(tool);
    const hits = dirs.map((dir) => surfaceAt(ctx, dir));
    const points = hits.map((h) => h.point);
    const normals = hits.map((h) => h.normal);
    const lengths = pathLengths(points);
    const lift = tools.size + HAND_LIFT;
    if (!await goTo(ctx, pointAlong(points, lengths, 0.5))) {
        return CANCELLED;
    }
    if (!await approach(ctx, add3(points[0], scale3(normals[0], lift)), points[0], APPROACH_TIME)) {
        return CANCELLED;
    }
    if (!tools.begin(points[0], {normal: normals[0]})) {
        // Someone else works there: the tools have said so.
        return REFUSED;
    }
    const ok = await animate(ctx, STROKE_TIME, (s) => {
        const e = ease(s);
        const at = pointAlong(points, lengths, e);
        const n = unit3(pointAlong(normals, lengths, e), normals[0]);
        if (tools.active) {
            tools.move(at);
        }
        ctx.hand(add3(at, scale3(n, lift)), at);
    });
    tools.end();
    return ok ? DONE : CANCELLED;
};

/**
 * The demo of a brush with a path of its own.
 *
 * @param {string} tool The brush.
 * @returns {function(Object): Promise<string>}
 */
const brushDemo = (tool) => (ctx) => brushStroke(ctx, tool, sweepDirections(basisOf(ctx), BRUSH_PATHS[tool]));

/**
 * Mirror: a stroke of Add on the viewer's right with mirror on, so its copy grows on the other side of x = 0.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>}
 */
const mirrorDemo = (ctx) => {
    if (!ctx.tools) {
        return Promise.resolve(FAILED);
    }
    const basis = basisOf(ctx);
    const sx = basis.right[0] >= 0 ? 1 : -1;
    const sz = basis.d[2] >= 0 ? 1 : -1;
    ctx.tools.setMirror(true);
    return brushStroke(ctx, 'add', lineDirections([sx * 0.9, 0.45, sz * 0.35], [sx * 0.9, -0.15, sz * 0.5]));
};

/**
 * Grab: take hold of the clay facing the viewer and pull it out a little.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>}
 */
const grabDemo = async(ctx) => {
    const tools = ctx.tools;
    if (!tools || !useMethod(ctx, 'sculpt')) {
        return FAILED;
    }
    tools.setTool('grab');
    const basis = basisOf(ctx);
    const start = surfaceAt(ctx, direction(basis, 0.35, 0.15));
    const target = add3(start.point, add3(scale3(start.normal, GRAB_PULL), scale3(basis.up, GRAB_LIFT)));
    if (!await goTo(ctx, start.point)) {
        return CANCELLED;
    }
    if (!await approach(ctx, add3(start.point, scale3(start.normal, HAND_LIFT)), start.point, APPROACH_TIME)) {
        return CANCELLED;
    }
    if (!tools.begin(start.point, {normal: start.normal})) {
        return REFUSED;
    }
    const ok = await animate(ctx, DRAG_TIME, (s) => {
        const p = lerp3(start.point, target, ease(s));
        if (tools.active) {
            tools.move(p);
        }
        ctx.hand(add3(p, scale3(start.normal, HAND_LIFT)), p);
    });
    tools.end();
    return ok ? DONE : CANCELLED;
};

/**
 * Twist: turn the clay facing the viewer about the view's axis, the hand going round.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>}
 */
const twistDemo = async(ctx) => {
    const tools = ctx.tools;
    if (!tools || !useMethod(ctx, 'sculpt')) {
        return FAILED;
    }
    tools.setTool('twist');
    const basis = basisOf(ctx);
    const axis = basis.d;
    const start = surfaceAt(ctx, direction(basis, -0.1, 0.15));
    const centre = add3(start.point, scale3(start.normal, tools.size + HAND_LIFT));
    const arm = scale3(basis.right, TWIST_HAND);
    if (!await goTo(ctx, start.point)) {
        return CANCELLED;
    }
    if (!await approach(ctx, add3(centre, arm), start.point, APPROACH_TIME)) {
        return CANCELLED;
    }
    if (!tools.begin(start.point, {axis: axis, normal: start.normal})) {
        return REFUSED;
    }
    const ok = await animate(ctx, DRAG_TIME, (s) => {
        const angle = TWIST_ANGLE * ease(s);
        if (tools.active) {
            tools.move(start.point, {axis: axis, angle: angle});
        }
        ctx.hand(add3(centre, rotateAbout(arm, axis, angle)), start.point);
    });
    tools.end();
    return ok ? DONE : CANCELLED;
};

/**
 * Shape and cut shape: place the current shape on the clay with one click.
 *
 * @param {string} tool 'shape' or 'cutshape'.
 * @returns {function(Object): Promise<string>}
 */
const shapeDemo = (tool) => async(ctx) => {
    const tools = ctx.tools;
    if (!tools || !useMethod(ctx, 'sculpt')) {
        return FAILED;
    }
    tools.setTool(tool);
    const spot = surfaceAt(ctx, direction(basisOf(ctx), SHAPE_SPOTS[tool][0], SHAPE_SPOTS[tool][1]));
    const lift = tools.size * 2 + HAND_LIFT;
    if (!await goTo(ctx, spot.point)) {
        return CANCELLED;
    }
    if (!await approach(ctx, add3(spot.point, scale3(spot.normal, lift)), spot.point, PLACE_TIME)) {
        return CANCELLED;
    }
    const placed = tools.begin(spot.point, {normal: spot.normal});
    tools.end();
    return placed ? hold(ctx, spot.normal) : REFUSED;
};

/**
 * The polygon mesh's drawing data.
 *
 * @param {Object} ctx Demo context.
 * @returns {?Object}
 */
const polyData = (ctx) => (ctx.engine && typeof ctx.engine.polydata === 'function' ? ctx.engine.polydata() : null);

/**
 * How many faces the mesh has.
 *
 * @param {?Object} data Drawing data.
 * @returns {number}
 */
const faceCount = (data) => (hasFaces(data) ? data.faceIds.length : 0);

/**
 * Whether a mesh demo can start: the mesh tools are there, and the studio is in Model.
 *
 * @param {Object} ctx Demo context.
 * @returns {boolean}
 */
const modelReady = (ctx) => !!ctx.modeltools && !!ctx.engine && typeof ctx.engine.polydata === 'function'
    && useMethod(ctx, 'model');

/**
 * Wait until the mesh has more faces than it had (its drawing data comes a moment after the op).
 *
 * @param {Object} ctx Demo context.
 * @param {number} before Faces it had.
 * @returns {Promise<string>} DONE, NOMESH when the data did not come in time, or CANCELLED.
 */
const waitForFaces = async(ctx, before) => {
    let waited = 0;
    while (waited < MESH_WAIT && faceCount(polyData(ctx)) <= before) {
        const dt = Number(await ctx.frame());
        if (ctx.cancelled()) {
            return CANCELLED;
        }
        waited += Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_STEP) : MIN_STEP;
    }
    return faceCount(polyData(ctx)) > before ? DONE : NOMESH;
};

/**
 * Add a cube above what is there, the hand bringing it.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>} How it ended.
 */
const placeCube = async(ctx) => {
    const clay = surfaceAt(ctx, [0, 1, 0]);
    const tops = [meshTop(polyData(ctx)), clay.hit ? clay.point[1] : null].filter((v) => v !== null);
    const spot = shapeSpot(tops.length ? Math.max(...tops) : null);
    const basis = basisOf(ctx);
    const before = faceCount(polyData(ctx));
    if (!await goTo(ctx, spot)) {
        return CANCELLED;
    }
    if (!await approach(ctx, add3(spot, scale3(basis.d, NEW_SHAPE_SIZE + HAND_LIFT)), spot, PLACE_TIME)) {
        return CANCELLED;
    }
    if (!ctx.modeltools.addShape('cube', spot, NEW_SHAPE_SIZE)) {
        return REFUSED;
    }
    return waitForFaces(ctx, before);
};

/**
 * Add shape: a cube from the Add shape menu.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>}
 */
const addShapeDemo = async(ctx) => {
    if (!modelReady(ctx)) {
        return FAILED;
    }
    const placed = await placeCube(ctx);
    return placed === DONE ? hold(ctx, basisOf(ctx).d) : placed;
};

/**
 * Make sure there is a mesh to work on: a cube is added when there is none.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>} DONE when there is one.
 */
const ensureMesh = (ctx) => (faceCount(polyData(ctx)) > 0 ? Promise.resolve(DONE) : placeCube(ctx));

/**
 * The pick of the front face, or of its top edge or top corner, in a select mode.
 *
 * @param {Object} face From frontFace().
 * @param {string} md 'v', 'e' or 'f'.
 * @param {number[]} up Which way is up.
 * @returns {Object} {hit (as polypick gives), at: the point it stands for}
 */
const pickFor = (face, md, up) => {
    if (md === 'f') {
        return {hit: {kind: 'f', id: face.id, point: face.centroid.slice(), normal: face.normal.slice()}, at: face.centroid};
    }
    const edge = topEdge(face, up);
    if (md === 'e') {
        return {hit: {kind: 'e', a: Math.min(edge.a, edge.b), b: Math.max(edge.a, edge.b)}, at: edge.mid};
    }
    return {hit: {kind: 'v', id: edge.a}, at: edge.pa};
};

/**
 * The face a mesh demo works on, once there is a mesh.
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<Object>} {result, face, basis}: result DONE with the face, or why not.
 */
const meshFace = async(ctx) => {
    if (!modelReady(ctx)) {
        return {result: FAILED};
    }
    const mesh = await ensureMesh(ctx);
    if (mesh !== DONE) {
        return {result: mesh};
    }
    const basis = basisOf(ctx);
    const face = frontFace(polyData(ctx), basis.d);
    return face ? {result: DONE, face, basis} : {result: NOMESH};
};

/**
 * Select: click the front face (or its top edge or corner, in the student's select mode).
 *
 * @param {Object} ctx Demo context.
 * @returns {Promise<string>}
 */
const selectDemo = async(ctx) => {
    const {result, face, basis} = await meshFace(ctx);
    if (result !== DONE) {
        return result;
    }
    const pick = pickFor(face, ctx.modeltools.selectMode, basis.up);
    if (!await goTo(ctx, pick.at)) {
        return CANCELLED;
    }
    if (!await approach(ctx, add3(pick.at, scale3(basis.d, HAND_LIFT * 2)), pick.at, PLACE_TIME)) {
        return CANCELLED;
    }
    if (!ctx.modeltools.selectHit(pick.hit, {add: false})) {
        return REFUSED;
    }
    return hold(ctx, basis.d);
};

/** The drags of the mesh demos: what to select, where the drag starts and the way it goes. */
const DRAG_PLANS = Object.freeze({
    move: (face, b) => ({
        select: 'f', from: face.centroid,
        at: (e) => add3(face.centroid, add3(scale3(b.right, MOVE_SIDE * e), scale3(b.up, MOVE_UP * e))),
    }),
    /**
     * Rotate: drag round the face's centre about the view axis.
     *
     * @param {Object} face From frontFace().
     * @param {Object} b From viewBasis().
     * @returns {Object} The plan.
     */
    rotate: (face, b) => {
        const arm = scale3(b.right, ROTATE_ARM);
        return {select: 'f', from: add3(face.centroid, arm), opts: {view: b.d},
            at: (e) => add3(face.centroid, rotateAbout(arm, b.d, ROTATE_ANGLE * e))};
    },
    scale: (face, b) => ({
        select: 'f', from: add3(face.centroid, scale3(b.right, SCALE_ARM)),
        at: (e) => add3(face.centroid, scale3(b.right, SCALE_ARM * (1 + SCALE_GROWTH * e))),
    }),
    extrude: (face) => ({
        select: 'f', from: face.centroid, at: (e) => add3(face.centroid, scale3(face.normal, EXTRUDE_LENGTH * e)),
    }),
    inset: (face, b) => ({select: 'f', from: face.centroid, at: (e) => add3(face.centroid, scale3(b.right, INSET_WIDTH * e))}),
    /**
     * Bevel: the face's top edge, dragged up.
     *
     * @param {Object} face From frontFace().
     * @param {Object} b From viewBasis().
     * @returns {Object} The plan.
     */
    bevel: (face, b) => {
        const mid = topEdge(face, b.up).mid;
        return {select: 'e', from: mid, at: (e) => add3(mid, scale3(b.up, BEVEL_WIDTH * e))};
    },
    /**
     * Loop cut: through the face's most upright edge, slid there and back.
     *
     * @param {Object} face From frontFace().
     * @param {Object} b From viewBasis().
     * @returns {Object} The plan.
     */
    loopcut: (face, b) => {
        const edge = sideEdge(face, b.up);
        const along = sub3(edge.pb, edge.pa);
        return {select: null, from: edge.mid, opts: {hit: {kind: 'e', a: Math.min(edge.a, edge.b), b: Math.max(edge.a, edge.b)}},
            at: (e) => add3(edge.mid, scale3(along, LOOP_SLIDE * Math.sin(Math.PI * e)))};
    },
});

/**
 * A mesh drag: select what it works on, choose the action, then drag as the mouse would.
 *
 * @param {string} action One of the mesh tools' drag actions.
 * @returns {function(Object): Promise<string>}
 */
const dragDemo = (action) => async(ctx) => {
    const {result, face, basis} = await meshFace(ctx);
    if (result !== DONE) {
        return result;
    }
    const model = ctx.modeltools;
    const plan = DRAG_PLANS[action](face, basis);
    if (!await goTo(ctx, plan.from)) {
        return CANCELLED;
    }
    if (plan.select && !model.selectHit(pickFor(face, plan.select, basis.up).hit, {add: false})) {
        return REFUSED;
    }
    model.setAxis(null);
    model.setAction(action);
    const lift = scale3(basis.d, HAND_LIFT);
    if (!await approach(ctx, add3(plan.from, lift), plan.from, APPROACH_TIME)) {
        return CANCELLED;
    }
    model.begin(plan.from, Object.assign({view: basis.d}, plan.opts || {}));
    if (!model.active) {
        // The mesh tools have said why.
        return REFUSED;
    }
    const ok = await animate(ctx, DRAG_TIME, (s) => {
        const p = plan.at(ease(s));
        if (model.active) {
            model.move(p, {view: basis.d});
        }
        ctx.hand(add3(p, lift), p);
    });
    if (model.active) {
        model.end();
    }
    return ok ? DONE : CANCELLED;
};

/** Each demo by name. */
const RUNS = Object.freeze({
    add: brushDemo('add'),
    carve: brushDemo('carve'),
    smooth: brushDemo('smooth'),
    inflate: brushDemo('inflate'),
    pinch: brushDemo('pinch'),
    flatten: brushDemo('flatten'),
    grab: grabDemo,
    twist: twistDemo,
    mirror: mirrorDemo,
    shape: shapeDemo('shape'),
    cutshape: shapeDemo('cutshape'),
    addshape: addShapeDemo,
    select: selectDemo,
    move: dragDemo('move'),
    rotate: dragDemo('rotate'),
    scale: dragDemo('scale'),
    extrude: dragDemo('extrude'),
    inset: dragDemo('inset'),
    bevel: dragDemo('bevel'),
    loopcut: dragDemo('loopcut'),
});

/**
 * Whether a context has what every demo needs from the tutor.
 *
 * @param {*} ctx Demo context.
 * @returns {boolean}
 */
const usableContext = (ctx) => !!ctx && typeof ctx.frame === 'function' && typeof ctx.hand === 'function'
    && typeof ctx.handPosition === 'function' && typeof ctx.cancelled === 'function';

/**
 * Run a demo.
 *
 * ctx: {tools, modeltools, engine, session, setMethod(name), method (a function giving the method, or the method),
 * toolbar, message(text) (optional: shows a message on the toolbar and in VR), strings (tutor_watch,
 * tutor_demofailed, tutor_demonomesh), THREE, sculptureRoot, view() (the viewer, sculpture-local), hand(position,
 * target) (where the tutor's hand goes and what it points at, sculpture-local; null, null lets go), handPosition(),
 * onSpot(point) (optional: the demo's working spot, sculpture-local, before its first action; a Promise the demo waits for),
 * frame() (a Promise of the seconds until the next frame), cancelled(), log(error)}.
 *
 * @param {string} name One of DEMO_NAMES.
 * @param {Object} ctx Demo context.
 * @returns {Promise<boolean>} Whether it was shown in full; never rejects.
 */
export const demo = async(name, ctx) => {
    const run = Object.prototype.hasOwnProperty.call(RUNS, name) ? RUNS[name] : null;
    if (!run || !usableContext(ctx)) {
        say(ctx, 'tutor_demofailed');
        return false;
    }
    say(ctx, 'tutor_watch');
    let saved = null;
    let result = FAILED;
    try {
        saved = saveState(ctx);
        result = await run(ctx);
    } catch (e) {
        logError(ctx, e);
        result = FAILED;
    } finally {
        if (saved) {
            restoreState(ctx, saved);
        }
    }
    if (result === FAILED) {
        say(ctx, 'tutor_demofailed');
    } else if (result === NOMESH) {
        say(ctx, 'tutor_demonomesh');
    }
    return result === DONE;
};
