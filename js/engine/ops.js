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
 * Wire format: a plain object with the keys k, a, s, i, p, r, st, d, x, g, t (in that order, only
 * those the kind uses), JSON at most 600 bytes. cleanOp() rebuilds an op from known keys only,
 * applies the R3/R4/R5 rounding (idempotent) and checks every range; ops come from other people's
 * browsers, so nothing else is ever trusted.
 *
 * Field updates (all deterministic, see mathx.js), with falloff w(t) = (1 − t²)², t = |q − p| / r:
 * - add:    d ← d + st · (smin(d, |q − p| − r, k) − d), k = 0.25 r (polynomial smooth union);
 * - carve:  d ← d + st · (smax(d, r − |q − p|, k) − d) (smooth subtraction);
 * - smooth: d ← d + st · w · (mean of the 6 neighbours − d), Jacobi (reads a copy);
 * - grab:   d(q) ← d₀(q − w · d) (semi-Lagrangian, trilinear reads from a copy); st is not used;
 * - twist:  d(q) ← d₀(p + Rot(axis, −g · w)(q − p)) (trilinear reads from a copy); st is not used.
 * Every written value is quantised to one of the grid's 255 levels and so clamped to the band.
 * An op writes only inside footprint(op) and reads only inside footprint(op) ± 2 voxels.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/ops
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {R3, R4, R5, sin, cos, falloff} from './mathx.js';
import {BORDER, QMAX, trilinear} from './grid.js';

/** Every op kind. */
export const KINDS = Object.freeze(['add', 'carve', 'smooth', 'grab', 'twist', 'end', 'undo', 'redo', 'lock',
    'unlock', 'save']);

/** Kinds that change the field as part of a stroke. */
export const STROKE_KINDS = Object.freeze(['add', 'carve', 'smooth', 'grab', 'twist']);

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
 * @returns {boolean} True for add, carve, smooth, grab and twist.
 */
export function isStrokeKind(k) {
    return k === 'add' || k === 'carve' || k === 'smooth' || k === 'grab' || k === 'twist';
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
    if (k === 'twist') {
        const x = vec3(obj.x, R4, MAX_AXIS);
        if (!x || (x[0] === 0 && x[1] === 0 && x[2] === 0) || !isNum(obj.g)) {
            return null;
        }
        const g = R4(obj.g);
        if (g < -MAX_TWIST || g > MAX_TWIST) {
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
        default:
            return op.r + band;
    }
}

/**
 * The voxel box an op may write: its reach around p, clipped to the interior (the outer 2 voxels
 * of every face are never written).
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
        default:
            return null;
    }
    return fp;
}
