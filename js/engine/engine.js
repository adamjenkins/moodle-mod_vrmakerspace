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
 * The sculpting engine: confirmed state, display state and the rebase rule.
 *
 * The engine keeps the confirmed grid C (every op the sequencer has ordered, applied in sequence
 * order) and the display grid D = C ⊕ pending, where pending is the ordered list of this client's
 * own ops that the sequencer has not confirmed yet. A local op is applied to D only. A confirmed op
 * is applied to C; then every chunk touched by it, or by any pending op whose footprint (± its read
 * margin) reaches those chunks, is reset from C and the involved pending ops are applied again in
 * order, so D = C ⊕ pending holds exactly, bit for bit. When the confirmed op is the oldest pending
 * op itself, D already holds it and nothing is recomputed.
 *
 * Undo records (history.js) and per-author contributions are kept on C only, so every client agrees
 * on them. Duplicates are dropped by (author, op index).
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/engine
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {Grid, CHUNK} from './grid.js';
import {fillModel, isModel} from './models.js';
import {fillUpload, FORMATS} from './meshimport.js';
import {READ_MARGIN, applyOp, cleanOp, copyBox, createWork, footprint, isStrokeKind} from './ops.js';
import {History} from './history.js';
import {isEpoch, readSnapshot, writeSnapshot, MIN_DIM, MAX_DIM, MIN_VOXEL, MAX_VOXEL} from './snapshot.js';

/** Voxels a mesh chunk depends on below its first cell and above its last (surface nets + normals). */
const MESH_MARGIN = 3;

/** Default grid edge in voxels, voxel size in metres and band in voxels (§2 of the build contract). */
export const DEFAULT_DIMS = 128;
export const DEFAULT_VOXEL = 0.004;
export const BAND_VOXELS = 3;

/**
 * A fresh random epoch: 16 lower-case hex characters.
 *
 * @returns {string} The epoch.
 */
export function randomEpoch() {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    let out = '';
    for (let n = 0; n < 8; n++) {
        out += (bytes[n] < 16 ? '0' : '') + bytes[n].toString(16);
    }
    return out;
}

/**
 * Rounds to 2 decimals.
 *
 * @param {number} v Value.
 * @returns {number} Rounded value.
 */
function round2(v) {
    return Math.round(v * 100) / 100;
}

/**
 * The first mesh chunk along an axis whose mesh depends on a voxel.
 *
 * @param {number} v Voxel index.
 * @returns {number} Chunk index.
 */
function firstMeshChunk(v) {
    return Math.max(0, Math.floor((v - MESH_MARGIN) / CHUNK));
}

/**
 * The last mesh chunk along an axis whose mesh depends on a voxel.
 *
 * @param {number} v Voxel index.
 * @param {number} count Mesh chunks along the axis.
 * @returns {number} Chunk index.
 */
function lastMeshChunk(v, count) {
    return Math.min(count - 1, Math.floor((v + MESH_MARGIN) / CHUNK));
}

/**
 * Bytes of an ArrayBuffer or typed array, or null when there are none.
 *
 * @param {*} snapshot Candidate.
 * @returns {ArrayBuffer|ArrayBufferView|null} The bytes or null.
 */
function snapshotBytes(snapshot) {
    if (!snapshot) {
        return null;
    }
    if (snapshot instanceof ArrayBuffer || ArrayBuffer.isView(snapshot)) {
        return snapshot.byteLength > 0 ? snapshot : null;
    }
    throw new Error('the snapshot must be an ArrayBuffer');
}

/**
 * The sculpting engine.
 */
export class Engine {
    /**
     * Creates an engine over a confirmed grid. Use Engine.create().
     *
     * @param {Grid} grid Confirmed grid (taken).
     * @param {number} seq Confirmed sequence number.
     * @param {string} epoch Epoch (16 hex characters).
     */
    constructor(grid, seq, epoch) {
        /** Contributions per author, counted on C: {ops, added, removed} (mm³). @type {Map<string, object>} */
        this.contributions = new Map();
        this.reset(grid, seq, epoch);
    }

    /**
     * Creates an engine from a snapshot, or from a starting model when there is none.
     *
     * @param {{dims: (number|undefined), voxel: (number|undefined), model: (string|undefined),
     *     upload: ({bytes: (ArrayBuffer|ArrayBufferView), format: string}|null|undefined),
     *     snapshot: (ArrayBuffer|ArrayBufferView|null|undefined)}} [options] dims (8..256, default 128)
     *     and voxel (metres, default 0.004) for a new grid; model 'lump' (default), 'sphere', 'cube',
     *     'empty' or 'upload' (the uploaded model in upload: an STL, OBJ or glTF binary file, see meshimport.js);
     *     snapshot a VRSC file, whose dimensions, voxel, seq and epoch then win.
     * @returns {Promise<Engine>} The engine. Its epoch is the snapshot's, else a new random one.
     * @throws {Error} For a bad snapshot, model or grid shape.
     */
    static async create(options = {}) {
        const bytes = snapshotBytes(options.snapshot);
        if (bytes) {
            const r = await readSnapshot(bytes);
            return new Engine(r.grid, r.seq, r.epoch || randomEpoch());
        }
        const dims = options.dims === undefined || options.dims === null ? DEFAULT_DIMS : options.dims;
        const voxel = options.voxel === undefined || options.voxel === null ? DEFAULT_VOXEL : options.voxel;
        const model = options.model === undefined || options.model === null || options.model === '' ?
            'lump' : options.model;
        if (!Number.isInteger(dims) || dims < MIN_DIM || dims > MAX_DIM) {
            throw new Error('bad grid dimensions');
        }
        if (typeof voxel !== 'number' || !(voxel >= MIN_VOXEL && voxel <= MAX_VOXEL)) {
            throw new Error('bad voxel size');
        }
        const upload = model === 'upload' ? options.upload : null;
        if (model === 'upload' && (!upload || !upload.bytes || FORMATS.indexOf(upload.format) === -1)) {
            throw new Error('the uploaded model is missing');
        }
        if (!upload && !isModel(model)) {
            throw new Error('unknown model: ' + String(model));
        }
        const grid = new Grid(dims, dims, dims, voxel, BAND_VOXELS * voxel);
        if (upload) {
            fillUpload(grid, upload.bytes, upload.format);
        } else {
            fillModel(grid, model);
        }
        return new Engine(grid, 0, randomEpoch());
    }

    /**
     * Replaces both states with a confirmed grid (pending ops, undo records and dedupe state are
     * dropped; contributions are kept) and marks every mesh chunk dirty.
     *
     * @param {Grid} grid Confirmed grid (taken).
     * @param {number} seq Confirmed sequence number.
     * @param {string} epoch Epoch.
     * @returns {void}
     */
    reset(grid, seq, epoch) {
        /** @type {Grid} */
        this.C = grid;
        /** @type {Grid} */
        this.D = grid.copy();
        /** Pending own ops: {op, json, box}. @type {object[]} */
        this.pending = [];
        /** Highest confirmed op index per author. @type {Map<string, number>} */
        this.lastIndex = new Map();
        /** @type {History} */
        this.history = new History();
        this.seqValue = seq;
        this.epochValue = epoch;
        this.workC = createWork();
        this.workD = createWork();
        const [vx, vy, vz] = grid.chunks;
        /** Chunks involved in the current rebase (voxel chunks). @type {Uint8Array} */
        this.involved = new Uint8Array(vx * vy * vz);
        /** Mesh chunk counts (cells [16c, 16c + 16), cells 0..n − 2), as the mesher counts them. */
        this.meshChunks = [Math.floor((grid.nx + 14) / CHUNK), Math.floor((grid.ny + 14) / CHUNK),
            Math.floor((grid.nz + 14) / CHUNK)];
        /** Dirty mesh chunks. @type {Uint8Array} */
        this.dirty = new Uint8Array(this.meshChunks[0] * this.meshChunks[1] * this.meshChunks[2]);
        this.dirty.fill(1);
        /** Scratch copy of D's chunks during a rebase. @type {Float32Array} */
        this.saved = new Float32Array(0);
    }

    /**
     * The display grid D = C ⊕ pending.
     *
     * @returns {Grid} The grid (do not modify).
     */
    get display() {
        return this.D;
    }

    /**
     * The confirmed grid C.
     *
     * @returns {Grid} The grid (do not modify).
     */
    get confirmedGrid() {
        return this.C;
    }

    /**
     * The confirmed sequence number.
     *
     * @returns {number} seq.
     */
    get seq() {
        return this.seqValue;
    }

    /**
     * The epoch the confirmed state belongs to.
     *
     * @returns {string} 16 hex characters.
     */
    get epoch() {
        return this.epochValue;
    }

    /**
     * The pending ops, oldest first.
     *
     * @returns {object[]} Copies of the clean ops.
     */
    get pendingOps() {
        return this.pending.map((p) => Object.assign({}, p.op));
    }

    /**
     * Applies an own op to the display state as a pending op.
     *
     * @param {object} op The op (must carry its author `a`).
     * @returns {{ok: boolean, op: (object|undefined), reason: (string|undefined)}} ok with the clean op,
     *     or a reason: 'invalid', 'noauthor' or 'duplicate'.
     */
    local(op) {
        const c = cleanOp(op);
        if (!c) {
            return {ok: false, reason: 'invalid'};
        }
        if (!c.a) {
            return {ok: false, reason: 'noauthor'};
        }
        if ((this.lastIndex.get(c.a) || 0) >= c.i) {
            return {ok: false, reason: 'duplicate'};
        }
        for (let n = 0; n < this.pending.length; n++) {
            const p = this.pending[n].op;
            if (p.a === c.a && p.i >= c.i) {
                return {ok: false, reason: 'duplicate'};
            }
        }
        let box = null;
        if (isStrokeKind(c.k)) {
            box = applyOp(this.D, c, this.workD);
            if (box) {
                this.markDirtyBox(box);
            }
        }
        this.pending.push({op: c, json: JSON.stringify(c), box});
        return {ok: true, op: c};
    }

    /**
     * Applies a sequenced op to the confirmed state, then rebases the display state.
     *
     * The sequence number advances even for an invalid op (every client rejects it the same way).
     * Pending ops of the same author with an index up to the op's are dropped (confirmed, or lost).
     *
     * @param {object} op The op, author stamped by the sequencer.
     * @param {number} seq Its sequence number (must be greater than the current one).
     * @returns {{ok: boolean, op: (object|undefined), reason: (string|undefined)}} ok with the clean op,
     *     or a reason: 'stale' (old seq, ignored), 'invalid', 'noauthor' or 'duplicate'.
     */
    confirmed(op, seq) {
        if (!Number.isInteger(seq) || seq < 1 || seq <= this.seqValue) {
            return {ok: false, reason: 'stale'};
        }
        this.seqValue = seq;
        const c = cleanOp(op);
        if (!c) {
            return {ok: false, reason: 'invalid'};
        }
        if (!c.a) {
            return {ok: false, reason: 'noauthor'};
        }
        if ((this.lastIndex.get(c.a) || 0) >= c.i) {
            return {ok: false, reason: 'duplicate'};
        }
        this.lastIndex.set(c.a, c.i);

        const pending = this.pending;
        const first = pending.length ? pending[0] : null;
        const fast = first !== null && first.op.a === c.a && first.op.i === c.i &&
            first.json === JSON.stringify(c) && c.k !== 'undo' && c.k !== 'redo';
        const changed = [];
        let w = 0;
        for (let n = 0; n < pending.length; n++) {
            const p = pending[n];
            if (p.op.a === c.a && p.op.i <= c.i) {
                if (!(fast && n === 0) && p.box) {
                    changed.push(p.box);
                }
                continue;
            }
            pending[w++] = p;
        }
        pending.length = w;

        const box = this.applyConfirmed(c);
        if (!fast && box) {
            changed.push(box);
        }
        if (changed.length) {
            this.rebase(changed);
        }
        return {ok: true, op: c};
    }

    /**
     * Confirms every pending op, in order, with the next sequence numbers (the sequencer went away
     * and this client takes over).
     *
     * @returns {number} How many ops were promoted.
     */
    promote() {
        const list = this.pending.map((p) => p.op);
        list.forEach((op) => {
            this.confirmed(op, this.seqValue + 1);
        });
        return list.length;
    }

    /**
     * The contribution counters of an author, created on first use.
     *
     * @param {string} author Author id.
     * @returns {{ops: number, added: number, removed: number}} The counters.
     */
    contributionOf(author) {
        let c = this.contributions.get(author);
        if (!c) {
            c = {ops: 0, added: 0, removed: 0};
            this.contributions.set(author, c);
        }
        return c;
    }

    /**
     * Applies a clean op to C with undo capture and contribution counting.
     *
     * @param {object} c Clean op with an author.
     * @returns {{min: number[], max: number[]}|null} The voxel box written, or null.
     */
    applyConfirmed(c) {
        const C = this.C;
        if (isStrokeKind(c.k)) {
            this.contributionOf(c.a).ops++;
            const box = footprint(c, C);
            if (!box) {
                return null;
            }
            const capture = this.history.stroke(c.a, c.s, C);
            copyBox(C, box, this.workC);
            applyOp(C, c, this.workC, box);
            this.account(box, c.a, capture);
            return box;
        }
        if (c.k === 'end') {
            this.history.end(c.a, c.s, C);
            return null;
        }
        if (c.k === 'undo' || c.k === 'redo') {
            const redo = c.k === 'redo';
            const box = this.history.boxFor(c.a, c.t, redo);
            if (!box) {
                return null;
            }
            copyBox(C, box, this.workC);
            if (redo) {
                this.history.redo(c.a, c.t, C);
            } else {
                this.history.undo(c.a, c.t, C);
            }
            this.account(box, c.a, null);
            return box;
        }
        return null;
    }

    /**
     * Compares C inside a box with the copy in workC.before: counts the voxels that crossed the
     * surface for the author's contributions, and hands first touches to the stroke capture.
     *
     * @param {{min: number[], max: number[]}} box The box written.
     * @param {string} author Author id.
     * @param {import('./history.js').StrokeCapture|null} capture The open stroke's capture, or null.
     * @returns {void}
     */
    account(box, author, capture) {
        const C = this.C;
        const {nx, ny, data} = C;
        const [ncx, ncy] = C.chunks;
        const before = this.workC.before;
        const [x0, y0, z0] = box.min;
        const [x1, y1, z1] = box.max;
        const bw = x1 - x0 + 1;
        const bh = y1 - y0 + 1;
        let added = 0;
        let removed = 0;
        for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) {
            const k0 = Math.max(z0, cz * CHUNK);
            const k1 = Math.min(z1, cz * CHUNK + CHUNK - 1);
            for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
                const j0 = Math.max(y0, cy * CHUNK);
                const j1 = Math.min(y1, cy * CHUNK + CHUNK - 1);
                for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
                    const i0 = Math.max(x0, cx * CHUNK);
                    const i1 = Math.min(x1, cx * CHUNK + CHUNK - 1);
                    const ci = cx + ncx * (cy + ncy * cz);
                    let cap = null;
                    for (let k = k0; k <= k1; k++) {
                        for (let j = j0; j <= j1; j++) {
                            let idx = i0 + nx * (j + ny * k);
                            let bi = (i0 - x0) + bw * ((j - y0) + bh * (k - z0));
                            for (let i = i0; i <= i1; i++, idx++, bi++) {
                                const old = before[bi];
                                const now = data[idx];
                                if (old === now) {
                                    continue;
                                }
                                if (old >= 0 && now < 0) {
                                    added++;
                                } else if (old < 0 && now >= 0) {
                                    removed++;
                                }
                                if (capture) {
                                    if (!cap) {
                                        cap = capture.chunk(ci);
                                    }
                                    const li = (i & 15) + CHUNK * ((j & 15) + CHUNK * (k & 15));
                                    if (!cap.mask[li]) {
                                        cap.mask[li] = 1;
                                        cap.before[li] = C.level(old);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (added || removed) {
            const mm = C.voxel * 1000;
            const volume = mm * mm * mm;
            const counters = this.contributionOf(author);
            counters.added += added * volume;
            counters.removed += removed * volume;
        }
    }

    /**
     * Grows a voxel box by a margin, clipped to the grid.
     *
     * @param {{min: number[], max: number[]}} box Box.
     * @param {number} margin Voxels.
     * @returns {{min: number[], max: number[]}} The grown box.
     */
    grow(box, margin) {
        const C = this.C;
        return {
            min: [Math.max(0, box.min[0] - margin), Math.max(0, box.min[1] - margin), Math.max(0, box.min[2] - margin)],
            max: [Math.min(C.nx - 1, box.max[0] + margin), Math.min(C.ny - 1, box.max[1] + margin),
                Math.min(C.nz - 1, box.max[2] + margin)],
        };
    }

    /**
     * Marks (or tests) the voxel chunks a box covers in the involved set.
     *
     * @param {{min: number[], max: number[]}} box Box.
     * @param {boolean} test True to only test whether any covered chunk is marked.
     * @returns {boolean} When testing: whether one is marked; when marking: true.
     */
    chunksOf(box, test) {
        const [ncx, ncy] = this.C.chunks;
        const set = this.involved;
        for (let cz = Math.floor(box.min[2] / CHUNK); cz <= Math.floor(box.max[2] / CHUNK); cz++) {
            for (let cy = Math.floor(box.min[1] / CHUNK); cy <= Math.floor(box.max[1] / CHUNK); cy++) {
                for (let cx = Math.floor(box.min[0] / CHUNK); cx <= Math.floor(box.max[0] / CHUNK); cx++) {
                    const ci = cx + ncx * (cy + ncy * cz);
                    if (test) {
                        if (set[ci]) {
                            return true;
                        }
                    } else {
                        set[ci] = 1;
                    }
                }
            }
        }
        return !test;
    }

    /**
     * The rebase rule: resets every chunk the changed boxes touch, plus the chunks of every pending
     * op that reaches them (transitively, footprints grown by the read margin), from C, and applies
     * the involved pending ops again in order. Marks the mesh chunks whose display values changed.
     *
     * @param {Array<{min: number[], max: number[]}>} boxes Voxel boxes changed in C or dropped from D.
     * @returns {void}
     */
    rebase(boxes) {
        const set = this.involved;
        set.fill(0);
        boxes.forEach((b) => this.chunksOf(b, false));
        const pending = this.pending;
        const reapply = new Uint8Array(pending.length);
        const grown = pending.map((p) => (p.box ? this.grow(p.box, READ_MARGIN) : null));
        let changed = true;
        while (changed) {
            changed = false;
            for (let n = 0; n < pending.length; n++) {
                if (!reapply[n] && grown[n] && this.chunksOf(grown[n], true)) {
                    reapply[n] = 1;
                    this.chunksOf(grown[n], false);
                    changed = true;
                }
            }
        }

        const C = this.C;
        const D = this.D;
        const [ncx, ncy] = C.chunks;
        const chunks = [];
        for (let ci = 0; ci < set.length; ci++) {
            if (set[ci]) {
                chunks.push(ci);
            }
        }
        const per = CHUNK * CHUNK * CHUNK;
        if (this.saved.length < chunks.length * per) {
            this.saved = new Float32Array(chunks.length * per);
        }
        const saved = this.saved;
        const {nx, ny} = D;
        const ranges = chunks.map((ci) => {
            const cx = ci % ncx;
            const cy = Math.floor(ci / ncx) % ncy;
            const cz = Math.floor(ci / (ncx * ncy));
            return [cx, cy, cz, cx * CHUNK, Math.min(nx, cx * CHUNK + CHUNK), cy * CHUNK,
                Math.min(ny, cy * CHUNK + CHUNK), cz * CHUNK, Math.min(D.nz, cz * CHUNK + CHUNK)];
        });
        ranges.forEach((r, n) => {
            let o = n * per;
            for (let k = r[7]; k < r[8]; k++) {
                for (let j = r[5]; j < r[6]; j++) {
                    const row = nx * (j + ny * k);
                    saved.set(D.data.subarray(row + r[3], row + r[4]), o);
                    o += r[4] - r[3];
                }
            }
            D.copyChunkFrom(C, r[0], r[1], r[2]);
        });
        for (let n = 0; n < pending.length; n++) {
            if (reapply[n]) {
                applyOp(D, pending[n].op, this.workD, pending[n].box);
            }
        }
        const data = D.data;
        ranges.forEach((r, n) => {
            let o = n * per;
            let lo0 = Infinity;
            let lo1 = Infinity;
            let lo2 = Infinity;
            let hi0 = -1;
            let hi1 = -1;
            let hi2 = -1;
            for (let k = r[7]; k < r[8]; k++) {
                for (let j = r[5]; j < r[6]; j++) {
                    let idx = r[3] + nx * (j + ny * k);
                    for (let i = r[3]; i < r[4]; i++, idx++, o++) {
                        if (data[idx] !== saved[o]) {
                            lo0 = i < lo0 ? i : lo0;
                            lo1 = j < lo1 ? j : lo1;
                            lo2 = k < lo2 ? k : lo2;
                            hi0 = i > hi0 ? i : hi0;
                            hi1 = j > hi1 ? j : hi1;
                            hi2 = k > hi2 ? k : hi2;
                        }
                    }
                }
            }
            if (hi0 >= 0) {
                this.markDirtyBox({min: [lo0, lo1, lo2], max: [hi0, hi1, hi2]});
            }
        });
    }

    /**
     * Marks the mesh chunks whose meshes depend on any voxel of a box.
     *
     * @param {{min: number[], max: number[]}} box Voxel box whose display values changed.
     * @returns {void}
     */
    markDirtyBox(box) {
        const [mx, my, mz] = this.meshChunks;
        const x1 = lastMeshChunk(box.max[0], mx);
        const y1 = lastMeshChunk(box.max[1], my);
        const z1 = lastMeshChunk(box.max[2], mz);
        for (let cz = firstMeshChunk(box.min[2]); cz <= z1; cz++) {
            for (let cy = firstMeshChunk(box.min[1]); cy <= y1; cy++) {
                for (let cx = firstMeshChunk(box.min[0]); cx <= x1; cx++) {
                    this.dirty[cx + mx * (cy + my * cz)] = 1;
                }
            }
        }
    }

    /**
     * Marks every mesh chunk dirty.
     *
     * @returns {void}
     */
    markAllDirty() {
        this.dirty.fill(1);
    }

    /**
     * The mesh chunks whose display values changed since the last call, and clears the set.
     *
     * @returns {number[][]} [[cx, cy, cz], …].
     */
    takeDirtyChunks() {
        const [mx, my] = this.meshChunks;
        const out = [];
        const dirty = this.dirty;
        for (let n = 0; n < dirty.length; n++) {
            if (dirty[n]) {
                dirty[n] = 0;
                out.push([n % mx, Math.floor(n / mx) % my, Math.floor(n / (mx * my))]);
            }
        }
        return out;
    }

    /**
     * Writes the confirmed state as a VRSC snapshot.
     *
     * @param {string} [epoch] Epoch to write (16 hex characters); it becomes the engine's epoch.
     *     Anything else writes the engine's current epoch.
     * @returns {Promise<Uint8Array>} The snapshot file.
     */
    async serialize(epoch) {
        if (isEpoch(epoch)) {
            this.epochValue = epoch;
        }
        return writeSnapshot(this.C, this.seqValue, this.epochValue);
    }

    /**
     * Replaces both states with a snapshot (pending ops, undo records and dedupe state are dropped).
     *
     * @param {ArrayBuffer|ArrayBufferView} bytes The VRSC file.
     * @returns {Promise<{seq: number, epoch: string}>} The loaded seq and epoch (a new random epoch when
     *     the snapshot has none).
     * @throws {Error} 'snapshotinvalid: …' for a bad file (the engine is then unchanged).
     */
    async load(bytes) {
        const r = await readSnapshot(bytes);
        this.reset(r.grid, r.seq, r.epoch || randomEpoch());
        return {seq: this.seqValue, epoch: this.epochValue};
    }

    /**
     * Sequence state and contributions.
     *
     * @returns {{seq: number, pending: number, contributions: Object<string, {ops: number, added: number,
     *     removed: number}>}} Cumulative totals per author since the engine was created (ops = stroke
     *     ops confirmed, added/removed = mm³ of voxels that crossed into/out of the sculpture).
     */
    stats() {
        const contributions = {};
        this.contributions.forEach((v, a) => {
            contributions[a] = {ops: v.ops, added: round2(v.added), removed: round2(v.removed)};
        });
        return {seq: this.seqValue, pending: this.pending.length, contributions};
    }
}
