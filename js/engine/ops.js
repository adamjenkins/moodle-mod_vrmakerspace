// This file is part of Moodle - https://moodle.org/
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
// along with Moodle.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Sculpting operations: the op wire format, its validation, footprints and the field updates.
 *
 * Wire format: a plain object with the keys k, a, s, i, p, r, st, d, x, g, t, m, sh, tx (in that
 * order, only those the kind uses), JSON at most 600 bytes. cleanOp() rebuilds an op from known keys only,
 * applies the R3/R4/R5 rounding (idempotent) and checks every range; ops come from other people's
 * browsers, so nothing else is ever trusted.
 *
 * Field updates (all deterministic, see mathx.js), with falloff w(t) = (1 − t²)², t = |q − p| / r:
 * - add:    d ← d + st · (smin(d, |q − p| − r, k) − d), k = 0.25 r (polynomial smooth union);
 * - carve:  d ← d + st · (smax(d, r − |q − p|, k) − d) (smooth subtraction);
 * - smooth: d ← d + st · w · (mean of the 6 neighbours − d), Jacobi (reads a copy);
 * - grab:   d(q) ← d₀(q − w · d) (semi-Lagrangian, trilinear reads from a copy); st is not used;
 * - twist:  d(q) ← d₀(p + Rot(axis, −g · w)(q − p)) (trilinear reads from a copy); st is not used;
 * - inflate: d ← d − 0.1 · r · st · w (the surface moves outwards along its normal);
 * - pinch:  d(q) ← d₀(p + (1 + 0.25 · st · w)(q − p)) (pulls the clay towards p, sharpening creases);
 * - flatten: d ← d + st · w · (x̂ · q − g − d), towards the plane x̂ · q = g (x the plane normal,
 *   g its offset, the same for the whole stroke);
 * - shape / cutshape: d ← smin(d, s(q), k) / smax(d, −s(q), k), s the shape sh (shapes.js, text tx)
 *   of size r centred on p and turned by g about x, k = (0.02 + 0.3 st) r; one op per stroke.
 * With m = 1 a stroke op also applies its mirror image across the plane x = 0 (Blender's X symmetry).
 * Every written value is quantised to one of the grid's 255 levels and so clamped to the band.
 * An op writes only inside footprint(op) and reads only inside footprint(op) ± 2 voxels.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/ops
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {PI, R3, R4, R5, sin, cos, falloff} from './mathx.js';
import {BORDER, QMAX, trilinear} from './grid.js';
import {isShape, boundingRadius, prepare} from './shapes.js';
import {isText} from './font.js';

/** Kinds that change the field as part of a stroke. */
export const STROKE_KINDS = Object.freeze(['add', 'carve', 'smooth', 'grab', 'twist', 'inflate', 'pinch', 'flatten',
    'shape', 'cutshape']);

/** Every op kind. */
export const KINDS = Object.freeze(STROKE_KINDS.concat(['end', 'undo', 'redo', 'lock', 'unlock', 'save']));

/** Kinds whose ops carry an axis x and an angle g that turn about it (mirrored as an axial vector). */
const TURNING_KINDS = Object.freeze(['twist', 'shape', 'cutshape']);

/** Inflate: how far one dab moves the surface, as a share of the radius at full strength. */
export const INFLATE_RATE = 0.1;

/** Pinch: how far one dab pulls, as a share of the distance to the centre at full strength. */
export const PINCH_RATE = 0.25;

/** Largest absolute flatten plane offset in metres. */
export const MAX_PLANE = 1;

/** Largest reach of a shape op (its bounding radius) in metres. */
export const MAX_SHAPE_REACH = 0.3;

/** Largest stroke id, op index and undo target. */
export const MAX_ID = 2147483647;

/** Largest absolute position coordinate in metres. */
export const MAX_COORD = 0.4;

/** Brush radius range in metres. */
export const MIN_RADIUS = 0.004;
export const MAX_RADIUS = 0.08;

/** Largest lock radius in metres. */
export const MAX_LOCK_RADIUS = 0.2;

/** Largest absolute twist angle per op in radians. */
export const MAX_TWIST = 0.5;

/** Largest absolute twist axis component (the axis is normalised by the engine). */
const MAX_AXIS = 1000;

/** Largest encoded op in bytes. */
export const MAX_BYTES = 600;

/** Smooth-union blend width as a fraction of the brush radius. */
export const BLEND = 0.25;

/** Extra voxels an op may read around its footprint. */
export const READ_MARGIN = 2;

/** Author id pattern. */
const AUTHOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Default grid shape for footprint() when no grid is given (§2 of the build contract). */
const DEFAULT_GRID = Object.freeze({nx: 128, ny: 128, nz: 128, voxel: 0.004, band: 0.012,
    cx: 63.5, cy: 63.5, cz: 63.5});

/**
 * Whether a kind is one of the field-changing stroke kinds.
 *
 * @param {string} k Kind.
 * @returns {boolean} True for the kinds of STROKE_KINDS.
 */
export function isStrokeKind(k) {
    return STROKE_KINDS.indexOf(k) !== -1;
}

/**
 * The blend width of a shape op.
 *
 * @param {object} op A clean shape or cutshape op.
 * @returns {number} Metres.
 */
function shapeBlend(op) {
    return (0.02 + 0.3 * op.st) * op.r;
}

/**
 * Whether a value is a valid author id.
 *
 * @param {*} a Value.
 * @returns {boolean} True for a 1–40 character [A-Za-z0-9_-] string.
 */
export function isAuthor(a) {
    return typeof a === 'string' && AUTHOR_RE.test(a);
}

/**
 * Whether a value is a valid id (stroke id, op index, undo target).
 *
 * @param {*} v Value.
 * @returns {boolean} True for an integer in 1..2147483647.
 */
function isId(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_ID;
}

/**
 * Whether a value is a finite number.
 *
 * @param {*} v Value.
 * @returns {boolean} True for a finite number.
 */
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Rounds a 3-vector, checking each component's bound.
 *
 * @param {*} v Candidate [x, y, z].
 * @param {function(number): number} round Rounding function.
 * @param {number} bound Largest absolute component after rounding.
 * @returns {number[]|null} The rounded vector or null.
 */
function vec3(v, round, bound) {
    if (!Array.isArray(v) || v.length !== 3) {
        return null;
    }
    const out = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
        if (!isNum(v[n])) {
            return null;
        }
        out[n] = round(v[n]);
        if (Math.abs(out[n]) > bound) {
            return null;
        }
    }
    return out;
}

/**
 * Validates and canonicalises an op.
 *
 * Builds a new object with only the keys the kind uses, in wire order, rounded (R5 for p, r and d,
 * R3 for st, R4 for x and g). `a` is optional here (the sequencer stamps it): when present it must
 * be valid, when absent the result has none. Returns null for anything out of range.
 *
 * @param {*} obj Candidate op.
 * @returns {object|null} The clean op, or null when it is not a valid op.
 */
export function cleanOp(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return null;
    }
    const k = obj.k;
    if (typeof k !== 'string' || KINDS.indexOf(k) === -1) {
        return null;
    }
    const out = {k};
    if (obj.a !== undefined) {
        if (!isAuthor(obj.a)) {
            return null;
        }
        out.a = obj.a;
    }
    const stroke = isStrokeKind(k);
    if (stroke || k === 'end') {
        if (!isId(obj.s)) {
            return null;
        }
        out.s = obj.s;
    }
    if (!isId(obj.i)) {
        return null;
    }
    out.i = obj.i;
    if (stroke || k === 'lock') {
        const p = vec3(obj.p, R5, MAX_COORD);
        if (!p || !isNum(obj.r)) {
            return null;
        }
        const r = R5(obj.r);
        if (r < MIN_RADIUS || r > (k === 'lock' ? MAX_LOCK_RADIUS : MAX_RADIUS)) {
            return null;
        }
        out.p = p;
        out.r = r;
    }
    if (stroke) {
        if (!isNum(obj.st)) {
            return null;
        }
        const st = R3(obj.st);
        if (st < 0 || st > 1) {
            return null;
        }
        out.st = st;
    }
    if (k === 'grab') {
        const d = vec3(obj.d, R5, out.r);
        if (!d || Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) > out.r) {
            return null;
        }
        out.d = d;
    }
    if (k === 'twist' || k === 'flatten' || k === 'shape' || k === 'cutshape') {
        const x = vec3(obj.x, R4, MAX_AXIS);
        if (!x || (x[0] === 0 && x[1] === 0 && x[2] === 0) || !isNum(obj.g)) {
            return null;
        }
        // twist: angle per op; flatten: plane offset (m); shapes: the turn (rad).
        const g = k === 'flatten' ? R5(obj.g) : R4(obj.g);
        const limit = k === 'twist' ? MAX_TWIST : (k === 'flatten' ? MAX_PLANE : PI);
        if (g < -limit || g > limit) {
            return null;
        }
        out.x = x;
        out.g = g;
    }
    if (k === 'undo' || k === 'redo') {
        if (!isId(obj.t)) {
            return null;
        }
        out.t = obj.t;
    }
    if (stroke && obj.m !== undefined) {
        if (obj.m !== 1) {
            return null;
        }
        out.m = 1;
    }
    if (k === 'shape' || k === 'cutshape') {
        if (!isShape(obj.sh)) {
            return null;
        }
        out.sh = obj.sh;
        if (obj.sh === 'text') {
            if (!isText(obj.tx)) {
                return null;
            }
            out.tx = obj.tx;
        }
        if (boundingRadius(out.sh, out.r, out.tx) > MAX_SHAPE_REACH) {
            return null;
        }
    }
    if (JSON.stringify(out).length > MAX_BYTES) {
        return null;
    }
    return out;
}

/**
 * Reach of an op around its centre in metres: the radius beyond which it changes nothing.
 *
 * add/carve: r + band + blend; smooth/twist: r + band; grab: r + band + |d|.
 *
 * @param {object} op A clean stroke op.
 * @param {number} band Grid band in metres.
 * @returns {number} Reach in metres.
 */
function reach(op, band) {
    switch (op.k) {
        case 'add':
        case 'carve':
            return op.r + band + BLEND * op.r;
        case 'grab': {
            const d = op.d;
            return op.r + band + Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        }
        case 'pinch':
            // Reads reach (1 + PINCH_RATE) r from p.
            return (1 + PINCH_RATE) * op.r + band;
        case 'shape':
        case 'cutshape':
            return boundingRadius(op.sh, op.r, op.tx) + band + shapeBlend(op);
        default:
            return op.r + band;
    }
}

/**
 * The mirror image of a stroke op across the plane x = 0.
 *
 * Positions and displacements are mirrored as points; a flatten normal as a vector; the turning axis
 * of twist and the shapes as an axial vector (a mirrored turn is a turn about (x, −y, −z)).
 *
 * @param {object} op A clean stroke op.
 * @returns {object} The mirrored op, without m.
 */
export function mirrorOp(op) {
    const out = Object.assign({}, op);
    delete out.m;
    out.p = [op.p[0] === 0 ? 0 : -op.p[0], op.p[1], op.p[2]];
    if (op.d) {
        out.d = [op.d[0] === 0 ? 0 : -op.d[0], op.d[1], op.d[2]];
    }
    if (op.x) {
        const axial = TURNING_KINDS.indexOf(op.k) !== -1;
        out.x = axial ? [op.x[0], op.x[1] === 0 ? 0 : -op.x[1], op.x[2] === 0 ? 0 : -op.x[2]]
            : [op.x[0] === 0 ? 0 : -op.x[0], op.x[1], op.x[2]];
    }
    return out;
}

/**
 * The smallest voxel box holding two (either may be null).
 *
 * @param {{min: number[], max: number[]}|null} a Box.
 * @param {{min: number[], max: number[]}|null} b Box.
 * @returns {{min: number[], max: number[]}|null} Their union.
 */
function unionBox(a, b) {
    if (!a || !b) {
        return a || b;
    }
    return {min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
        max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])]};
}

/**
 * The voxel box an op may write: its reach around p, clipped to the interior (the outer 2 voxels
 * of every face are never written); with m, the box holding the op and its mirror image.
 *
 * @param {object} op A clean op.
 * @param {{nx: number, ny: number, nz: number, voxel: number, band: number, cx: number, cy: number,
 *     cz: number}} [grid] The grid (default: the 128³, 4 mm grid of the build contract).
 * @returns {{min: number[], max: number[]}|null} Inclusive voxel box, or null when the op writes
 *     nothing (not a stroke op, or entirely outside the interior).
 */
export function footprint(op, grid) {
    if (!op || !isStrokeKind(op.k)) {
        return null;
    }
    const g = grid || DEFAULT_GRID;
    if (op.m === 1) {
        return unionBox(footprintOne(op, g), footprintOne(mirrorOp(op), g));
    }
    return footprintOne(op, g);
}

/**
 * The voxel box one op (not its mirror image) may write.
 *
 * @param {object} op A clean stroke op.
 * @param {object} g The grid.
 * @returns {{min: number[], max: number[]}|null} Inclusive voxel box or null.
 */
function footprintOne(op, g) {
    const rv = reach(op, g.band) / g.voxel;
    const c = [op.p[0] / g.voxel + g.cx, op.p[1] / g.voxel + g.cy, op.p[2] / g.voxel + g.cz];
    const n = [g.nx, g.ny, g.nz];
    const min = [0, 0, 0];
    const max = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
        min[a] = Math.max(BORDER, Math.floor(c[a] - rv));
        max[a] = Math.min(n[a] - 1 - BORDER, Math.ceil(c[a] + rv));
        if (min[a] > max[a]) {
            return null;
        }
    }
    return {min, max};
}

/**
 * Whether two voxel boxes intersect.
 *
 * @param {{min: number[], max: number[]}} a Box.
 * @param {{min: number[], max: number[]}} b Box.
 * @returns {boolean} True when they share a voxel.
 */
export function boxesIntersect(a, b) {
    return a.min[0] <= b.max[0] && b.min[0] <= a.max[0] &&
        a.min[1] <= b.max[1] && b.min[1] <= a.max[1] &&
        a.min[2] <= b.max[2] && b.min[2] <= a.max[2];
}

/**
 * Creates the reusable working memory of op application (one per grid that ops are applied to
 * concurrently; buffers grow and are never shrunk).
 *
 * @returns {{before: Float32Array, region: Float32Array, ox: number, oy: number, oz: number,
 *     sx: number, sy: number, sz: number, axis: Float64Array}} Working memory.
 */
export function createWork() {
    return {
        before: new Float32Array(4096),
        region: new Float32Array(4096),
        ox: 0,
        oy: 0,
        oz: 0,
        sx: 0,
        sy: 0,
        sz: 0,
        axis: new Float64Array(3),
    };
}

/**
 * Grows a buffer of the working memory to at least the given length.
 *
 * @param {Float32Array} buf Current buffer.
 * @param {number} length Needed length.
 * @returns {Float32Array} A buffer at least that long (buf itself when it already is).
 */
function grow(buf, length) {
    if (buf.length >= length) {
        return buf;
    }
    let size = buf.length || 4096;
    while (size < length) {
        size *= 2;
    }
    return new Float32Array(size);
}

/**
 * Copies the values of a voxel box into work.before (x fastest, box-local).
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {{min: number[], max: number[]}} box Inclusive voxel box.
 * @param {object} work Working memory from createWork().
 * @returns {Float32Array} work.before.
 */
export function copyBox(grid, box, work) {
    const bw = box.max[0] - box.min[0] + 1;
    const bh = box.max[1] - box.min[1] + 1;
    const bd = box.max[2] - box.min[2] + 1;
    work.before = grow(work.before, bw * bh * bd);
    const out = work.before;
    const {nx, ny, data} = grid;
    let o = 0;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const row = box.min[0] + nx * (j + ny * k);
            out.set(data.subarray(row, row + bw), o);
            o += bw;
        }
    }
    return out;
}

/**
 * Copies the box grown by `pad` voxels (clipped to the grid) into work.region and records its
 * origin and size.
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {{min: number[], max: number[]}} box Inclusive voxel box.
 * @param {number} pad Voxels added on every side.
 * @param {object} work Working memory from createWork().
 * @returns {void}
 */
function copyRegion(grid, box, pad, work) {
    const {nx, ny, nz, data} = grid;
    const x0 = Math.max(0, box.min[0] - pad);
    const y0 = Math.max(0, box.min[1] - pad);
    const z0 = Math.max(0, box.min[2] - pad);
    const x1 = Math.min(nx - 1, box.max[0] + pad);
    const y1 = Math.min(ny - 1, box.max[1] + pad);
    const z1 = Math.min(nz - 1, box.max[2] + pad);
    const sx = x1 - x0 + 1;
    const sy = y1 - y0 + 1;
    const sz = z1 - z0 + 1;
    work.region = grow(work.region, sx * sy * sz);
    const out = work.region;
    let o = 0;
    for (let k = z0; k <= z1; k++) {
        for (let j = y0; j <= y1; j++) {
            const row = x0 + nx * (j + ny * k);
            out.set(data.subarray(row, row + sx), o);
            o += sx;
        }
    }
    work.ox = x0;
    work.oy = y0;
    work.oz = z0;
    work.sx = sx;
    work.sy = sy;
    work.sz = sz;
}

/**
 * add and carve: polynomial smooth union with (or subtraction of) the brush sphere.
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean add or carve op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @param {boolean} carve True to subtract.
 * @returns {void}
 */
function applyBlob(grid, op, box, carve) {
    const {nx, ny, voxel, data, levels, inv} = grid;
    const r = op.r;
    const st = op.st;
    const k = BLEND * r;
    const quarterK = 0.25 * k;
    const reachR = op.r + grid.band + k;
    const reach2 = reachR * reachR;
    const [px, py, pz] = op.p;
    for (let kk = box.min[2]; kk <= box.max[2]; kk++) {
        const dz = (kk - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            const dyz = dy * dy + dz * dz;
            let idx = box.min[0] + nx * (j + ny * kk);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const dx = (i - grid.cx) * voxel - px;
                const d2 = dx * dx + dyz;
                if (d2 >= reach2) {
                    continue;
                }
                const a = data[idx];
                const s = Math.sqrt(d2) - r;
                let m;
                if (carve) {
                    const b = -s;
                    const h = Math.max(k - Math.abs(a - b), 0) / k;
                    m = Math.max(a, b) + h * h * quarterK;
                } else {
                    const h = Math.max(k - Math.abs(a - s), 0) / k;
                    m = Math.min(a, s) - h * h * quarterK;
                }
                const v = a + st * (m - a);
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * smooth: relaxes each voxel toward the mean of its 6 neighbours (read from a copy).
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean smooth op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @param {object} work Working memory.
 * @returns {void}
 */
function applySmooth(grid, op, box, work) {
    copyRegion(grid, box, 1, work);
    const {nx, ny, voxel, data, levels, inv} = grid;
    const reg = work.region;
    const {ox, oy, oz, sx, sy} = work;
    const sxy = sx * sy;
    const r = op.r;
    const r2 = r * r;
    const st = op.st;
    const [px, py, pz] = op.p;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        const dz = (k - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            const dyz = dy * dy + dz * dz;
            let idx = box.min[0] + nx * (j + ny * k);
            let ri = (box.min[0] - ox) + sx * ((j - oy) + sy * (k - oz));
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++, ri++) {
                const dx = (i - grid.cx) * voxel - px;
                const d2 = dx * dx + dyz;
                if (d2 >= r2) {
                    continue;
                }
                const w = falloff(Math.sqrt(d2) / r) * st;
                if (w === 0) {
                    continue;
                }
                const a = reg[ri];
                const mean = (reg[ri - 1] + reg[ri + 1] + reg[ri - sx] + reg[ri + sx] + reg[ri - sxy] +
                    reg[ri + sxy]) / 6;
                const v = a + w * (mean - a);
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * grab: semi-Lagrangian advection by d × falloff (trilinear reads from a copy).
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean grab op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @param {object} work Working memory.
 * @returns {void}
 */
function applyGrab(grid, op, box, work) {
    const [ddx, ddy, ddz] = op.d;
    if (ddx === 0 && ddy === 0 && ddz === 0) {
        return;
    }
    copyRegion(grid, box, READ_MARGIN, work);
    const {nx, ny, voxel, data, levels, inv} = grid;
    const reg = work.region;
    const {ox, oy, oz, sx, sy, sz} = work;
    const r = op.r;
    const r2 = r * r;
    const [px, py, pz] = op.p;
    const vx = ddx / voxel;
    const vy = ddy / voxel;
    const vz = ddz / voxel;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        const dz = (k - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            const dyz = dy * dy + dz * dz;
            let idx = box.min[0] + nx * (j + ny * k);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const dx = (i - grid.cx) * voxel - px;
                const d2 = dx * dx + dyz;
                if (d2 >= r2) {
                    continue;
                }
                const w = falloff(Math.sqrt(d2) / r);
                if (w === 0) {
                    continue;
                }
                const v = trilinear(reg, ox, oy, oz, sx, sy, sz, i - vx * w, j - vy * w, k - vz * w);
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * twist: rotates the field about the axis through p by g × falloff (trilinear reads from a copy).
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean twist op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @param {object} work Working memory.
 * @returns {void}
 */
function applyTwist(grid, op, box, work) {
    if (op.g === 0) {
        return;
    }
    copyRegion(grid, box, READ_MARGIN, work);
    const {nx, ny, voxel, data, levels, inv} = grid;
    const reg = work.region;
    const {ox, oy, oz, sx, sy, sz} = work;
    const al = Math.sqrt(op.x[0] * op.x[0] + op.x[1] * op.x[1] + op.x[2] * op.x[2]);
    const kx = op.x[0] / al;
    const ky = op.x[1] / al;
    const kz = op.x[2] / al;
    const r = op.r;
    const r2 = r * r;
    const g = op.g;
    const [px, py, pz] = op.p;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        const dz = (k - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            const dyz = dy * dy + dz * dz;
            let idx = box.min[0] + nx * (j + ny * k);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const dx = (i - grid.cx) * voxel - px;
                const d2 = dx * dx + dyz;
                if (d2 >= r2) {
                    continue;
                }
                const w = falloff(Math.sqrt(d2) / r);
                if (w === 0) {
                    continue;
                }
                // Inverse map: the value arriving at q comes from q rotated by −g·w (Rodrigues).
                const angle = -g * w;
                const c = cos(angle);
                const s = sin(angle);
                const kv = kx * dx + ky * dy + kz * dz;
                const ck = (1 - c) * kv;
                const rx = dx * c + (ky * dz - kz * dy) * s + kx * ck;
                const ry = dy * c + (kz * dx - kx * dz) * s + ky * ck;
                const rz = dz * c + (kx * dy - ky * dx) * s + kz * ck;
                const fx = (px + rx) / voxel + grid.cx;
                const fy = (py + ry) / voxel + grid.cy;
                const fz = (pz + rz) / voxel + grid.cz;
                const v = trilinear(reg, ox, oy, oz, sx, sy, sz, fx, fy, fz);
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * inflate: moves the surface outwards along its normal (subtracts from the distance).
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean inflate op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @returns {void}
 */
function applyInflate(grid, op, box) {
    const {nx, ny, voxel, data, levels, inv} = grid;
    const r = op.r;
    const r2 = r * r;
    const amount = INFLATE_RATE * r * op.st;
    const [px, py, pz] = op.p;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        const dz = (k - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            const dyz = dy * dy + dz * dz;
            let idx = box.min[0] + nx * (j + ny * k);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const dx = (i - grid.cx) * voxel - px;
                const d2 = dx * dx + dyz;
                if (d2 >= r2) {
                    continue;
                }
                const w = falloff(Math.sqrt(d2) / r);
                if (w === 0) {
                    continue;
                }
                const v = data[idx] - amount * w;
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * pinch: pulls the clay towards p (trilinear reads from a copy, from farther out).
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean pinch op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @param {object} work Working memory.
 * @returns {void}
 */
function applyPinch(grid, op, box, work) {
    if (op.st === 0) {
        return;
    }
    copyRegion(grid, box, READ_MARGIN, work);
    const {nx, ny, voxel, data, levels, inv} = grid;
    const reg = work.region;
    const {ox, oy, oz, sx, sy, sz} = work;
    const r = op.r;
    const r2 = r * r;
    const rate = PINCH_RATE * op.st;
    const [px, py, pz] = op.p;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        const dz = (k - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            const dyz = dy * dy + dz * dz;
            let idx = box.min[0] + nx * (j + ny * k);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const dx = (i - grid.cx) * voxel - px;
                const d2 = dx * dx + dyz;
                if (d2 >= r2) {
                    continue;
                }
                const w = falloff(Math.sqrt(d2) / r);
                if (w === 0) {
                    continue;
                }
                const f = 1 + rate * w;
                const v = trilinear(reg, ox, oy, oz, sx, sy, sz, (px + dx * f) / voxel + grid.cx,
                    (py + dy * f) / voxel + grid.cy, (pz + dz * f) / voxel + grid.cz);
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * flatten: blends the field towards the distance to the plane x̂ · q = g.
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean flatten op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @returns {void}
 */
function applyFlatten(grid, op, box) {
    const {nx, ny, voxel, data, levels, inv} = grid;
    const al = Math.sqrt(op.x[0] * op.x[0] + op.x[1] * op.x[1] + op.x[2] * op.x[2]);
    const nxv = op.x[0] / al;
    const nyv = op.x[1] / al;
    const nzv = op.x[2] / al;
    const r = op.r;
    const r2 = r * r;
    const st = op.st;
    const [px, py, pz] = op.p;
    for (let k = box.min[2]; k <= box.max[2]; k++) {
        const z = (k - grid.cz) * voxel;
        const dz = z - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const y = (j - grid.cy) * voxel;
            const dy = y - py;
            const dyz = dy * dy + dz * dz;
            const plane = nyv * y + nzv * z - op.g;
            let idx = box.min[0] + nx * (j + ny * k);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const x = (i - grid.cx) * voxel;
                const dx = x - px;
                const d2 = dx * dx + dyz;
                if (d2 >= r2) {
                    continue;
                }
                const w = falloff(Math.sqrt(d2) / r) * st;
                if (w === 0) {
                    continue;
                }
                const a = data[idx];
                const v = a + w * (nxv * x + plane - a);
                let q = Math.round(v * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * shape and cutshape: smooth union with (or subtraction of) a turned shape.
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {object} op Clean shape or cutshape op.
 * @param {{min: number[], max: number[]}} box Its footprint.
 * @param {boolean} cut True to subtract.
 * @returns {void}
 */
function applyShape(grid, op, box, cut) {
    const {nx, ny, voxel, data, levels, inv} = grid;
    const k = shapeBlend(op);
    const quarterK = 0.25 * k;
    const sdf = prepare(op.sh, op.r, op.tx, grid.band + k);
    // Local = Rᵀ (q − p), R the turn by g about x̂ (Rodrigues).
    const al = Math.sqrt(op.x[0] * op.x[0] + op.x[1] * op.x[1] + op.x[2] * op.x[2]);
    const ax = op.x[0] / al;
    const ay = op.x[1] / al;
    const az = op.x[2] / al;
    const c = cos(op.g);
    const s = sin(op.g);
    const t = 1 - c;
    const m00 = c + ax * ax * t;
    const m01 = ax * ay * t - az * s;
    const m02 = ax * az * t + ay * s;
    const m10 = ay * ax * t + az * s;
    const m11 = c + ay * ay * t;
    const m12 = ay * az * t - ax * s;
    const m20 = az * ax * t - ay * s;
    const m21 = az * ay * t + ax * s;
    const m22 = c + az * az * t;
    const [px, py, pz] = op.p;
    for (let kk = box.min[2]; kk <= box.max[2]; kk++) {
        const dz = (kk - grid.cz) * voxel - pz;
        for (let j = box.min[1]; j <= box.max[1]; j++) {
            const dy = (j - grid.cy) * voxel - py;
            let idx = box.min[0] + nx * (j + ny * kk);
            for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                const dx = (i - grid.cx) * voxel - px;
                const lx = m00 * dx + m10 * dy + m20 * dz;
                const ly = m01 * dx + m11 * dy + m21 * dz;
                const lz = m02 * dx + m12 * dy + m22 * dz;
                const b = sdf(lx, ly, lz);
                const a = data[idx];
                let m;
                if (cut) {
                    const h = Math.max(k - Math.abs(a + b), 0) / k;
                    m = Math.max(a, -b) + h * h * quarterK;
                } else {
                    const h = Math.max(k - Math.abs(a - b), 0) / k;
                    m = Math.min(a, b) - h * h * quarterK;
                }
                let q = Math.round(m * inv);
                q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
                data[idx] = levels[q + QMAX];
            }
        }
    }
}

/**
 * Applies a clean stroke op to a grid, writing only inside its footprint.
 *
 * @param {import('./grid.js').Grid} grid The grid (changed in place).
 * @param {object} op A clean op (from cleanOp()).
 * @param {object} work Working memory from createWork().
 * @param {{min: number[], max: number[]}|null} [box] Its footprint when already computed.
 * @returns {{min: number[], max: number[]}|null} The footprint written, or null when the op does not
 *     change the field.
 */
export function applyOp(grid, op, work, box) {
    const fp = box === undefined ? footprint(op, grid) : box;
    if (!fp) {
        return null;
    }
    if (op.m === 1) {
        // The op, then its mirror image, each in its own box.
        const own = Object.assign({}, op);
        delete own.m;
        const ownbox = footprintOne(own, grid);
        if (ownbox) {
            applyOne(grid, own, work, ownbox);
        }
        const mirror = mirrorOp(op);
        const mirrorbox = footprintOne(mirror, grid);
        if (mirrorbox) {
            applyOne(grid, mirror, work, mirrorbox);
        }
        return fp;
    }
    return applyOne(grid, op, work, fp) ? fp : null;
}

/**
 * Applies one op (no mirror image) inside a box.
 *
 * @param {import('./grid.js').Grid} grid The grid (changed in place).
 * @param {object} op A clean op without m.
 * @param {object} work Working memory.
 * @param {{min: number[], max: number[]}} fp Its footprint.
 * @returns {boolean} Whether the kind changes the field.
 */
function applyOne(grid, op, work, fp) {
    switch (op.k) {
        case 'add':
            applyBlob(grid, op, fp, false);
            break;
        case 'carve':
            applyBlob(grid, op, fp, true);
            break;
        case 'smooth':
            applySmooth(grid, op, fp, work);
            break;
        case 'grab':
            applyGrab(grid, op, fp, work);
            break;
        case 'twist':
            applyTwist(grid, op, fp, work);
            break;
        case 'inflate':
            applyInflate(grid, op, fp);
            break;
        case 'pinch':
            applyPinch(grid, op, fp, work);
            break;
        case 'flatten':
            applyFlatten(grid, op, fp);
            break;
        case 'shape':
            applyShape(grid, op, fp, false);
            break;
        case 'cutshape':
            applyShape(grid, op, fp, true);
            break;
        default:
            return false;
    }
    return true;
}
