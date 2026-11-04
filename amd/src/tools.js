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
 * The sculpting tools: turn a stroke of brush positions (from the mouse or a VR controller, in the
 * sculpture-local frame) into the ops of the wire format and hand them to the session.
 *
 * Add, carve, smooth, inflate, pinch and flatten place a dab every 0.3 × the brush radius along the
 * path (flatten keeps the plane of the stroke's first point, at right angles to the surface normal
 * there). Shape and cut shape place one shape (or a word of letters) where the stroke begins, its up
 * along the surface normal (letters face along it). With mirror on, every op also works on the
 * mirror image across the sculpture's x = 0 plane (the engine applies it). Grab sends the
 * displacement since its previous op (never more than the radius per op), twist the angle since its
 * previous op (at most 0.5 rad per op). Every value is rounded (positions and radii to 1e-5,
 * strength to 1e-3, axis and angle to 1e-4) before it is sent and applied, so every client applies
 * exactly the same numbers. Ops are capped at 30 a second; the dabs a fast stroke owes are sent as
 * the cap allows. Grab and twist strokes are wrapped in lock and unlock ops, and no stroke starts
 * or continues inside a region another person has locked.
 *
 * Stroke ids and op indices only ever increase for an author, also across page loads: they start
 * from a time-based value (8 per second since 2026) or past the last value this browser reserved,
 * whichever is higher.
 *
 * The undo and redo stacks are shared with the mesh tools (modeltools.js), which take their stroke ids
 * from allocStroke() and put them on the stack with recordStroke(), so Undo and Redo go through both
 * ways of making in the order things were done.
 *
 * @module     mod_vrmakerspace/tools
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';

/** Tool names, in the order of the keyboard shortcuts 1 to 9 and 0. */
export const TOOLS = ['grab', 'twist', 'add', 'carve', 'smooth', 'inflate', 'pinch', 'flatten', 'shape', 'cutshape'];

/** Tools that lock the region they work in. */
const LOCKING = ['grab', 'twist'];

/** Tools that place one shape per stroke. */
export const SHAPE_TOOLS = ['shape', 'cutshape'];

/** Shapes of the shape tools (js/engine/shapes.js). */
export const SHAPES = ['sphere', 'cube', 'cylinder', 'cone', 'torus', 'text'];

/** Characters the letters can be made of (js/engine/font.js), and the most of them. */
const TEXT_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-!?\'';
const MAX_TEXT = 16;

/** Largest reach of a shape op (m), as js/engine/ops.js MAX_SHAPE_REACH. */
const MAX_SHAPE_REACH = 0.3;

/** Brush radius range (m) and the default. */
export const MIN_SIZE = 0.004;
export const MAX_SIZE = 0.08;
const DEFAULT_SIZE = 0.02;

/** Strength range and the default. */
export const MIN_STRENGTH = 0;
export const MAX_STRENGTH = 1;
const DEFAULT_STRENGTH = 0.5;

/** Largest lock radius (m) and the lock radius as a factor of the brush radius. */
const MAX_LOCK = 0.2;
const LOCK_FACTOR = 1.5;

/** Largest coordinate of an op position (m). */
const MAX_COORD = 0.4;

/** Dab spacing as a factor of the brush radius. */
const SPACING = 0.3;

/** How far behind the pointer a stroke may lag, as a factor of the radius, before dabs are skipped. */
const MAX_LAG = 2;

/** Op rate cap: ops a second and the burst allowed. */
const RATE = 30;
const BURST = 3;

/** Largest twist angle per op (rad), and the smallest worth sending. */
const MAX_TWIST = 0.5;
const MIN_TWIST = 0.002;

/** Smallest grab displacement worth sending (m). */
const MIN_GRAB = 0.00002;

/** A grab op moves at most this share of the radius (keeps |d| ≤ r after rounding). */
const GRAB_STEP = 0.95;

/** Undo history kept per user (the engine keeps the same number). */
const MAX_UNDO = 50;

/** Largest counter value (contract: 1..2147483647). */
const MAX_COUNTER = 2147483647;

/** Counter values reserved in browser storage at a time. */
const RESERVE = 1000;

/** Start of the time base of the counters (ms). */
const COUNTER_EPOCH = Date.UTC(2026, 0, 1);

/**
 * Round to 5 decimals.
 *
 * @param {number} v Value.
 * @returns {number}
 */
export const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Round to 4 decimals.
 *
 * @param {number} v Value.
 * @returns {number}
 */
export const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Round to 3 decimals.
 *
 * @param {number} v Value.
 * @returns {number}
 */
export const r3 = (v) => Math.round(v * 1e3) / 1e3;

/**
 * Clamp a number.
 *
 * @param {number} v Value.
 * @param {number} lo Lowest.
 * @param {number} hi Highest.
 * @returns {number}
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Read a point from an array or an object with x, y, z, clamped to the op range.
 *
 * @param {number[]|Object} p Point.
 * @returns {number[]|null} [x, y, z] or null when not a point.
 */
const toPoint = (p) => {
    if (!p) {
        return null;
    }
    const v = Array.isArray(p) ? p : [p.x, p.y, p.z];
    const out = [Number(v[0]), Number(v[1]), Number(v[2])];
    if (!out.every(Number.isFinite)) {
        return null;
    }
    return out.map((c) => clamp(c, -MAX_COORD, MAX_COORD));
};

/**
 * Distance between two points.
 *
 * @param {number[]} a Point.
 * @param {number[]} b Point.
 * @returns {number}
 */
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/**
 * A rounded point.
 *
 * @param {number[]} p Point.
 * @returns {number[]}
 */
const roundPoint = (p) => [r5(clamp(p[0], -MAX_COORD, MAX_COORD)), r5(clamp(p[1], -MAX_COORD, MAX_COORD)),
    r5(clamp(p[2], -MAX_COORD, MAX_COORD))];

/**
 * Read browser storage, never throwing.
 *
 * @param {string} key Key.
 * @returns {number} The stored number, or 0.
 */
const readStored = (key) => {
    try {
        const value = Number(window.localStorage.getItem(key));
        return Number.isFinite(value) ? value : 0;
    } catch (e) {
        return 0;
    }
};

/**
 * Write browser storage, never throwing.
 *
 * @param {string} key Key.
 * @param {number} value Value.
 */
const writeStored = (key, value) => {
    try {
        window.localStorage.setItem(key, String(value));
    } catch (e) {
        // Private windows and blocked storage: the time base alone keeps the counters increasing.
    }
};

/**
 * An increasing counter of one author (stroke ids or op indices).
 *
 * @param {string} name Counter name.
 * @returns {Function} (author) → next value.
 */
const makeCounter = (name) => {
    let author = null;
    let value = 0;
    let reserved = 0;
    return (who) => {
        const key = 'mod_vrmakerspace_' + name + '_' + who;
        if (author !== who) {
            author = who;
            const timebase = Math.floor((Date.now() - COUNTER_EPOCH) / 1000) * 8;
            value = Math.max(1, Math.min(MAX_COUNTER - RESERVE * 10, Math.max(timebase, readStored(key) + 1))) - 1;
            reserved = 0;
        }
        value = Math.min(MAX_COUNTER, value + 1);
        if (value > reserved) {
            reserved = Math.min(MAX_COUNTER, value + RESERVE);
            writeStored(key, reserved);
        }
        return value;
    };
};

/**
 * Create the tools.
 *
 * @param {Object} options {session, lockOwner(p, r) → name|null, onChange(), onRefused(name)}
 * @returns {Object} Tools {tool, size, strength, mirror, shape, text, active, setTool, setSize, setStrength,
 *     setMirror, setShape, setText, begin, move, end, undo, redo, canUndo, canRedo, cursorRadius, author,
 *     allocStroke, recordStroke, forgetStroke}
 */
export const createTools = (options) => {
    const session = options.session;
    const lockOwner = typeof options.lockOwner === 'function' ? options.lockOwner
        : (p, r) => (typeof session.lockOwner === 'function' ? session.lockOwner(p, r) : null);
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => undefined;
    const onRefused = typeof options.onRefused === 'function' ? options.onRefused : () => undefined;
    const nextStroke = makeCounter('stroke');
    const nextIndex = makeCounter('op');
    const undostack = [];
    const redostack = [];
    let tool = 'add';
    let mirror = false;
    let shape = 'sphere';
    let text = 'ABC';
    let size = DEFAULT_SIZE;
    let strength = DEFAULT_STRENGTH;
    let tokens = BURST;
    let lastrefill = 0;
    /** @type {Object|null} the stroke in progress */
    let stroke = null;

    /**
     * Tell the owner that something the toolbar shows has changed.
     */
    const changed = () => {
        try {
            onChange();
        } catch (e) {
            Log.debug(e);
        }
    };

    /**
     * The author id of this user.
     *
     * @returns {string}
     */
    const author = () => String(session.author());

    /**
     * Put a finished stroke on the undo stack: it is the last thing done, so nothing is left to redo.
     *
     * @param {number} s The stroke id.
     */
    const pushUndo = (s) => {
        undostack.push(s);
        if (undostack.length > MAX_UNDO) {
            undostack.shift();
        }
        redostack.length = 0;
    };

    /**
     * Take one op from the rate budget.
     *
     * @returns {boolean} Whether an op may be sent now.
     */
    const takeToken = () => {
        const now = performance.now();
        if (lastrefill === 0) {
            lastrefill = now;
        }
        tokens = Math.min(BURST, tokens + (now - lastrefill) * RATE / 1000);
        lastrefill = now;
        if (tokens >= 1) {
            tokens -= 1;
            return true;
        }
        return false;
    };

    /**
     * Send an op to the session.
     *
     * @param {Object} op The op, keys in wire order.
     */
    const send = (op) => {
        try {
            session.submit(op);
        } catch (e) {
            Log.debug(e);
        }
    };

    /**
     * The strength of a stroke step: the chosen strength scaled by the pressure (a VR trigger), if any.
     *
     * @param {number} base The strength chosen when the stroke began.
     * @param {Object} opts Stroke options, maybe with pressure 0..1.
     * @returns {number} Rounded strength.
     */
    const pressed = (base, opts) => {
        const pressure = opts && opts.pressure !== undefined ? Number(opts.pressure) : NaN;
        return r3(Number.isFinite(pressure) ? clamp(base * pressure, MIN_STRENGTH, MAX_STRENGTH) : base);
    };

    /**
     * The radius a locking stroke locks.
     *
     * @param {number} radius Brush radius.
     * @returns {number}
     */
    const lockRadius = (radius) => r5(Math.min(MAX_LOCK, radius * LOCK_FACTOR));

    /**
     * Who else works inside a sphere, or null.
     *
     * @param {number[]} p Centre.
     * @param {number} radius Radius.
     * @returns {string|null}
     */
    const otherOwner = (p, radius) => {
        try {
            const owner = lockOwner(p, radius);
            // A lock whose owner's name is not known yet ('') still counts.
            return owner === null || owner === undefined || owner === false ? null : String(owner);
        } catch (e) {
            Log.debug(e);
            return null;
        }
    };

    /**
     * Send a lock op for the stroke in progress.
     *
     * @param {number[]} p Centre.
     */
    const sendLock = (p) => {
        const centre = roundPoint(p);
        send({k: 'lock', a: author(), i: nextIndex(author()), p: centre, r: stroke.lockr});
        stroke.lockcentre = centre;
    };

    /**
     * Finish the stroke in progress: owed dab, end op, undo record, unlock.
     */
    const finish = () => {
        if (!stroke) {
            return;
        }
        const current = stroke;
        if (current.owed && !current.locked) {
            current.owed = false;
            sendDab(current, current.last, true);
        }
        stroke = null;
        if (current.ops > 0) {
            send({k: 'end', a: author(), s: current.s, i: nextIndex(author())});
            pushUndo(current.s);
        }
        if (current.locked) {
            send({k: 'unlock', a: author(), i: nextIndex(author())});
        }
        changed();
    };

    /**
     * Refuse to go on: someone else is working here.
     *
     * @param {string} owner Their name.
     */
    const refuse = (owner) => {
        finish();
        try {
            onRefused(owner);
        } catch (e) {
            Log.debug(e);
        }
    };

    /**
     * The op with the mirror flag of its stroke.
     *
     * @param {Object} op The op, keys in wire order.
     * @param {Object} current The stroke.
     * @returns {Object} The op.
     */
    const withMirror = (op, current) => {
        if (current.mirror) {
            op.m = 1;
        }
        return op;
    };

    /**
     * Send one dab of a stroke (add, carve, smooth, inflate, pinch, flatten).
     *
     * @param {Object} current The stroke.
     * @param {number[]} p Dab centre.
     * @param {boolean} last The last dab of a stroke that is ending: sent even when the rate budget is
     *     spent, and quietly dropped (no refusal) inside another person's lock.
     * @returns {boolean} Whether it was sent (false: no budget, or refused).
     */
    function sendDab(current, p, last) {
        const owner = otherOwner(p, current.r);
        if (owner !== null) {
            if (!last) {
                refuse(owner);
            }
            return false;
        }
        if (!takeToken() && !last) {
            return false;
        }
        const op = {k: current.kind, a: author(), s: current.s, i: nextIndex(author()), p: roundPoint(p), r: current.r,
            st: current.st};
        if (current.kind === 'flatten') {
            op.x = current.normal;
            op.g = current.plane;
        }
        send(withMirror(op, current));
        current.ops++;
        return true;
    }

    /**
     * Move a dab stroke towards a point, placing dabs along the way.
     *
     * @param {number[]} target Where the pointer is now.
     */
    const moveDabs = (target) => {
        const current = stroke;
        const spacing = Math.max(MIN_SIZE * SPACING, current.r * SPACING);
        if (current.owed) {
            if (!sendDab(current, current.last, false)) {
                return;
            }
            current.owed = false;
        }
        let remaining = distance(current.last, target);
        while (remaining >= spacing) {
            if (stroke !== current) {
                break;
            }
            const t = spacing / remaining;
            const next = [
                current.last[0] + (target[0] - current.last[0]) * t,
                current.last[1] + (target[1] - current.last[1]) * t,
                current.last[2] + (target[2] - current.last[2]) * t,
            ];
            if (!sendDab(current, next, false)) {
                break;
            }
            current.last = next;
            remaining -= spacing;
        }
        if (stroke !== current) {
            return;
        }
        // Out of budget far behind the pointer: skip ahead rather than lag further.
        const lag = distance(current.last, target);
        const maxlag = current.r * MAX_LAG;
        if (lag > maxlag) {
            const t = (lag - maxlag) / lag;
            current.last = [
                current.last[0] + (target[0] - current.last[0]) * t,
                current.last[1] + (target[1] - current.last[1]) * t,
                current.last[2] + (target[2] - current.last[2]) * t,
            ];
        }
    };

    /**
     * Move a grab stroke: send the displacement of the material since its previous op.
     *
     * @param {number[]} target Where the grabbed material should be now.
     */
    const moveGrab = (target) => {
        const current = stroke;
        const acc = [target[0] - current.point[0], target[1] - current.point[1], target[2] - current.point[2]];
        const length = Math.hypot(acc[0], acc[1], acc[2]);
        if (length < MIN_GRAB) {
            return;
        }
        const owner = otherOwner(current.point, current.r);
        if (owner !== null) {
            refuse(owner);
            return;
        }
        if (!takeToken()) {
            return;
        }
        const limit = current.r * GRAB_STEP;
        const scale = length > limit ? limit / length : 1;
        const d = [r5(acc[0] * scale), r5(acc[1] * scale), r5(acc[2] * scale)];
        if (Math.hypot(d[0], d[1], d[2]) === 0) {
            return;
        }
        const p = roundPoint(current.point);
        send(withMirror({k: 'grab', a: author(), s: current.s, i: nextIndex(author()), p: p, r: current.r,
            st: current.st, d: d}, current));
        current.ops++;
        current.point = roundPoint([p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
        // Keep the region locked where the material now is.
        if (distance(current.lockcentre, current.point) > current.r * 0.5) {
            sendLock(current.point);
        }
    };

    /**
     * Normalise a twist axis, or null when it has no length.
     *
     * @param {number[]|Object|undefined} axis The axis.
     * @returns {number[]|null}
     */
    const toAxis = (axis) => {
        if (!axis) {
            return null;
        }
        const v = Array.isArray(axis) ? axis.map(Number) : [Number(axis.x), Number(axis.y), Number(axis.z)];
        const length = Math.hypot(v[0], v[1], v[2]);
        if (!Number.isFinite(length) || length < 1e-6) {
            return null;
        }
        const out = [r4(v[0] / length), r4(v[1] / length), r4(v[2] / length)];
        return out[0] === 0 && out[1] === 0 && out[2] === 0 ? null : out;
    };

    /**
     * Move a twist stroke: send the angle turned since its previous op.
     *
     * @param {number[]} p Where the tool is now.
     * @param {Object} opts {axis, angle}: angle is the whole angle of the stroke so far (rad); without
     *     it the angle the tool turned about the axis through the stroke centre is used.
     */
    const moveTwist = (p, opts) => {
        const current = stroke;
        const axis = toAxis(opts.axis) || current.axis;
        current.axis = axis;
        if (Number.isFinite(Number(opts.angle))) {
            current.target = Number(opts.angle);
        } else if (current.previous) {
            const c = current.centre;
            const a = [current.previous[0] - c[0], current.previous[1] - c[1], current.previous[2] - c[2]];
            const b = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
            // Project both onto the plane at right angles to the axis.
            const da = a[0] * axis[0] + a[1] * axis[1] + a[2] * axis[2];
            const db = b[0] * axis[0] + b[1] * axis[1] + b[2] * axis[2];
            const pa = [a[0] - da * axis[0], a[1] - da * axis[1], a[2] - da * axis[2]];
            const pb = [b[0] - db * axis[0], b[1] - db * axis[1], b[2] - db * axis[2]];
            const min = current.r * 0.1;
            if (Math.hypot(pa[0], pa[1], pa[2]) > min && Math.hypot(pb[0], pb[1], pb[2]) > min) {
                const cross = [pa[1] * pb[2] - pa[2] * pb[1], pa[2] * pb[0] - pa[0] * pb[2], pa[0] * pb[1] - pa[1] * pb[0]];
                const sin = cross[0] * axis[0] + cross[1] * axis[1] + cross[2] * axis[2];
                const cos = pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2];
                current.target += Math.atan2(sin, cos);
            }
        }
        current.previous = p;
        const diff = current.target - current.emitted;
        if (Math.abs(diff) < MIN_TWIST) {
            return;
        }
        const owner = otherOwner(current.centre, current.r);
        if (owner !== null) {
            refuse(owner);
            return;
        }
        if (!takeToken()) {
            return;
        }
        const g = r4(clamp(diff, -MAX_TWIST, MAX_TWIST));
        if (g === 0) {
            return;
        }
        send(withMirror({k: 'twist', a: author(), s: current.s, i: nextIndex(author()), p: current.centre,
            r: current.r, st: current.st, x: axis, g: g}, current));
        current.ops++;
        current.emitted += g;
    };

    /**
     * The size of a shape: the brush radius, smaller for a word too long to fit (letters are 2r high
     * and 2r / 3 wide per unit of the font; see js/engine/shapes.js boundingRadius()).
     *
     * @param {string} name Shape name.
     * @param {string} word The letters of a text shape.
     * @returns {number} Radius (m).
     */
    const shapeSize = (name, word) => {
        if (name !== 'text') {
            return size;
        }
        const width = (word.length - 1) * 6 + 4;
        const fit = MAX_SHAPE_REACH / (Math.sqrt((width / 6) * (width / 6) + 1) + 0.2) * 0.98;
        return r5(Math.max(MIN_SIZE, Math.min(size, fit)));
    };

    /**
     * The turn (axis, angle) taking the shape's own frame to the frame at a surface: up (local Y) along
     * the normal, and for letters, facing (local Z) along the normal and upright (local X level).
     *
     * @param {number[]} n Unit normal.
     * @param {boolean} letters Whether the shape is text.
     * @returns {{x: number[], g: number}} Axis and angle, rounded as the wire format wants.
     */
    const turnTo = (n, letters) => {
        // Columns of the rotation matrix: the local X, Y and Z axes in the sculpture frame.
        let ex;
        let ey;
        let ez;
        if (letters) {
            ez = n;
            // Level: local X = up × normal (or, looking straight down or up, the sculpture's x).
            ex = [n[2], 0, -n[0]];
            const length = Math.hypot(ex[0], ex[2]);
            ex = length < 1e-6 ? [1, 0, 0] : [ex[0] / length, 0, ex[2] / length];
            ey = [ez[1] * ex[2] - ez[2] * ex[1], ez[2] * ex[0] - ez[0] * ex[2], ez[0] * ex[1] - ez[1] * ex[0]];
        } else {
            ey = n;
            ex = [n[1], -n[0], 0];
            let length = Math.hypot(ex[0], ex[1]);
            if (length < 1e-6) {
                ex = [1, 0, 0];
                length = 1;
            }
            ex = [ex[0] / length, ex[1] / length, 0];
            ez = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
        }
        // Axis and angle of the matrix [ex ey ez].
        const trace = ex[0] + ey[1] + ez[2];
        const angle = Math.acos(clamp((trace - 1) / 2, -1, 1));
        let axis = [ey[2] - ez[1], ez[0] - ex[2], ex[1] - ey[0]];
        if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) {
            if (angle < 1e-3) {
                return {x: [0, 1, 0], g: 0};
            }
            // A half turn: the axis is the column of (M + I) with the largest length.
            const columns = [[ex[0] + 1, ex[1], ex[2]], [ey[0], ey[1] + 1, ey[2]], [ez[0], ez[1], ez[2] + 1]];
            axis = columns.reduce((best, c) => (Math.hypot(...c) > Math.hypot(...best) ? c : best));
        }
        return {x: toAxis(axis) || [0, 1, 0], g: r4(clamp(angle, -Math.PI + 1e-4, Math.PI - 1e-4))};
    };

    /**
     * Place one shape (or word) at a point: a whole stroke of one op.
     *
     * @param {number[]} point Where (sculpture-local).
     * @param {number[]} normal Unit surface normal there.
     * @returns {boolean} Whether it was placed.
     */
    const placeShape = (point, normal) => {
        const word = text;
        const letters = shape === 'text';
        const radius = shapeSize(shape, word);
        const owner = otherOwner(point, radius);
        if (owner !== null) {
            try {
                onRefused(owner);
            } catch (e) {
                Log.debug(e);
            }
            return false;
        }
        const turn = turnTo(normal, letters);
        const s = nextStroke(author());
        const op = {k: tool, a: author(), s: s, i: nextIndex(author()), p: roundPoint(point), r: radius,
            st: strength, x: turn.x, g: turn.g};
        if (mirror) {
            op.m = 1;
        }
        op.sh = shape;
        if (letters) {
            op.tx = word;
        }
        send(op);
        send({k: 'end', a: author(), s: s, i: nextIndex(author())});
        pushUndo(s);
        changed();
        return true;
    };

    /**
     * A unit normal from stroke options: the surface normal (desktop), else back along the controller's
     * forward axis, towards the person (VR), else the direction from the sculpture's centre.
     *
     * @param {Object} opts Stroke options, maybe with normal or axis.
     * @param {number[]} point The stroke's point.
     * @returns {number[]} Unit vector, rounded to 1e-4.
     */
    const normalOf = (opts, point) => {
        const back = opts.axis ? toAxis(opts.axis) : null;
        return toAxis(opts.normal) || (back ? back.map((v) => (v === 0 ? 0 : -v)) : null) || toAxis(point) || [0, 1, 0];
    };

    return {
        /** @returns {string} The current tool. */
        get tool() {
            return tool;
        },

        /** @returns {number} The brush radius (m). */
        get size() {
            return size;
        },

        /** @returns {boolean} Whether strokes also work on their mirror image (x = 0). */
        get mirror() {
            return mirror;
        },

        /** @returns {string} The shape of the shape tools. */
        get shape() {
            return shape;
        },

        /** @returns {string} The letters the text shape writes. */
        get text() {
            return text;
        },

        /**
         * Turn mirroring on or off.
         *
         * @param {boolean} on Whether it is on.
         */
        setMirror: (on) => {
            mirror = !!on;
            changed();
        },

        /**
         * Choose the shape of the shape tools.
         *
         * @param {string} name One of SHAPES.
         */
        setShape: (name) => {
            if (SHAPES.includes(name)) {
                shape = name;
                changed();
            }
        },

        /**
         * Set the letters of the text shape: capitals, digits, space and . - ! ? ' (others are dropped).
         *
         * @param {string} value Letters.
         * @returns {string} What will be written ('' when nothing is left).
         */
        setText: (value) => {
            const clean = Array.from(String(value || '').toUpperCase())
                .filter((c) => TEXT_CHARACTERS.includes(c)).join('').slice(0, MAX_TEXT);
            if (clean.trim() !== '') {
                text = clean;
                changed();
            }
            return clean;
        },

        /** @returns {number} The strength, 0 to 1. */
        get strength() {
            return strength;
        },

        /** @returns {boolean} Whether a stroke is in progress. */
        get active() {
            return stroke !== null;
        },

        /**
         * Choose a tool (ends a stroke in progress).
         *
         * @param {string} name One of TOOLS.
         */
        setTool: (name) => {
            if (!TOOLS.includes(name) || name === tool) {
                return;
            }
            finish();
            tool = name;
            changed();
        },

        /**
         * Set the brush radius.
         *
         * @param {number} m Radius in metres.
         */
        setSize: (m) => {
            const value = Number(m);
            if (!Number.isFinite(value)) {
                return;
            }
            size = r5(clamp(value, MIN_SIZE, MAX_SIZE));
            changed();
        },

        /**
         * Set the strength.
         *
         * @param {number} v Strength, 0 to 1.
         */
        setStrength: (v) => {
            const value = Number(v);
            if (!Number.isFinite(value)) {
                return;
            }
            strength = r3(clamp(value, MIN_STRENGTH, MAX_STRENGTH));
            changed();
        },

        /**
         * Start a stroke.
         *
         * @param {number[]|Object} p Tool position, sculpture-local.
         * @param {Object} [opts] {axis} for twist; {normal} the surface normal for flatten and the shapes;
         *     {pressure} 0..1 scales the strength.
         * @returns {boolean} Whether the stroke started, or for a shape tool whether the shape was placed
         *     (false: refused or not a point).
         */
        begin: (p, opts = {}) => {
            finish();
            const point = toPoint(p);
            if (!point) {
                return false;
            }
            if (SHAPE_TOOLS.includes(tool)) {
                return placeShape(point, normalOf(opts, point));
            }
            const radius = size;
            const locking = LOCKING.includes(tool);
            const lockr = lockRadius(radius);
            const owner = otherOwner(point, locking ? lockr : radius);
            if (owner !== null) {
                try {
                    onRefused(owner);
                } catch (e) {
                    Log.debug(e);
                }
                return false;
            }
            stroke = {
                kind: tool,
                s: nextStroke(author()),
                r: radius,
                base: strength,
                st: pressed(strength, opts),
                ops: 0,
                locked: locking,
                lockr: lockr,
                lockcentre: null,
                last: point,
                owed: !locking,
                point: roundPoint(point),
                centre: roundPoint(point),
                axis: toAxis(opts.axis) || [0, 0, 1],
                previous: null,
                target: 0,
                emitted: 0,
                mirror: mirror,
                normal: null,
                plane: 0,
            };
            if (tool === 'flatten') {
                stroke.normal = normalOf(opts, point);
                const n = stroke.normal;
                stroke.plane = r5(clamp(n[0] * point[0] + n[1] * point[1] + n[2] * point[2], -1, 1));
            }
            if (locking) {
                sendLock(point);
            } else {
                moveDabs(point);
            }
            changed();
            return stroke !== null;
        },

        /**
         * Continue the stroke.
         *
         * @param {number[]|Object} p Tool position, sculpture-local.
         * @param {Object} [opts] {axis, angle} for twist; {delta} for grab: the whole displacement since
         *     the stroke began, used instead of p; {pressure} 0..1 scales the strength.
         */
        move: (p, opts = {}) => {
            if (!stroke) {
                return;
            }
            const point = toPoint(p);
            stroke.st = pressed(stroke.base, opts);
            if (stroke.kind === 'grab') {
                const delta = opts.delta ? toPoint(opts.delta) : null;
                if (delta) {
                    moveGrab([stroke.centre[0] + delta[0], stroke.centre[1] + delta[1], stroke.centre[2] + delta[2]]);
                } else if (point) {
                    moveGrab(point);
                }
            } else if (stroke.kind === 'twist') {
                moveTwist(point || stroke.centre, opts);
            } else if (point) {
                moveDabs(point);
            }
        },

        /** End the stroke in progress. */
        end: () => {
            finish();
        },

        /** Undo this user's last stroke. */
        undo: () => {
            if (stroke || undostack.length === 0) {
                return;
            }
            const target = undostack.pop();
            send({k: 'undo', a: author(), i: nextIndex(author()), t: target});
            redostack.push(target);
            changed();
        },

        /** Redo this user's last undone stroke. */
        redo: () => {
            if (stroke || redostack.length === 0) {
                return;
            }
            const target = redostack.pop();
            send({k: 'redo', a: author(), i: nextIndex(author()), t: target});
            undostack.push(target);
            changed();
        },

        /** @returns {boolean} Whether there is a stroke to undo. */
        canUndo: () => undostack.length > 0,

        /** @returns {boolean} Whether there is a stroke to redo. */
        canRedo: () => redostack.length > 0,

        /** @returns {number} The radius of the tool cursor (m, sculpture-local). */
        cursorRadius: () => (stroke ? stroke.r : size),

        /** @returns {string} The author id of this user. */
        author: () => author(),

        /** @returns {number} The next stroke id of this user, for a stroke made outside these tools. */
        allocStroke: () => nextStroke(author()),

        /**
         * Put a stroke made outside these tools on the shared undo stack.
         *
         * @param {number} s Its stroke id, from allocStroke().
         */
        recordStroke: (s) => {
            pushUndo(s);
            changed();
        },

        /**
         * Forget what can be undone and redone: the room's undo records started again.
         *
         * @returns {boolean} Whether there was anything to forget.
         */
        clearHistory: () => {
            const had = undostack.length > 0 || redostack.length > 0;
            undostack.length = 0;
            redostack.length = 0;
            if (had) {
                changed();
            }
            return had;
        },

        /**
         * Take a stroke off the undo stack again, because it turned out to have done nothing.
         *
         * @param {number} s Its stroke id.
         */
        forgetStroke: (s) => {
            const at = undostack.lastIndexOf(s);
            if (at !== -1) {
                undostack.splice(at, 1);
                changed();
            }
        },
    };
};
