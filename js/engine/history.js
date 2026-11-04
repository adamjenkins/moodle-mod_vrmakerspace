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
 * Per-author undo records of the confirmed sculpture.
 *
 * While a stroke's ops are applied to the confirmed grid, the engine hands every voxel the stroke
 * changes to the stroke's capture, which keeps the voxel's first-touch level. When the stroke ends,
 * the per-voxel delta (level after − level before, integers) and its voxel box become the stroke's
 * record. undo subtracts the delta, redo adds it back, both clamped to the band, so the arithmetic
 * is exact and identical on every client. The last 50 ended strokes per author are kept, at most
 * 64 MB in all (oldest evicted first).
 *
 * Captures and deltas are stored per chunk of 16³ voxels, chunk-local index lx + 16 (ly + 16 lz).
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/history
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {CHUNK, QMAX} from './grid.js';

/** Voxels per chunk. */
export const CHUNK_VOXELS = CHUNK * CHUNK * CHUNK;

/** Ended strokes kept per author. */
export const MAX_RECORDS_PER_AUTHOR = 50;

/** Bytes of deltas kept in all. */
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

/**
 * The first-touch levels of an open stroke.
 */
export class StrokeCapture {
    /**
     * Creates an empty capture.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     */
    constructor(author, stroke) {
        /** @type {string} */
        this.author = author;
        /** @type {number} */
        this.stroke = stroke;
        /** Chunk index → {before: Int8Array, mask: Uint8Array}. @type {Map<number, object>} */
        this.chunks = new Map();
    }

    /**
     * The capture buffers of a chunk, created on first use.
     *
     * @param {number} ci Chunk index.
     * @returns {{before: Int8Array, mask: Uint8Array}} Levels before the first touch and touched flags.
     */
    chunk(ci) {
        let c = this.chunks.get(ci);
        if (!c) {
            c = {before: new Int8Array(CHUNK_VOXELS), mask: new Uint8Array(CHUNK_VOXELS)};
            this.chunks.set(ci, c);
        }
        return c;
    }
}

/**
 * Undo records of every author.
 */
export class History {
    /**
     * Creates an empty history.
     */
    constructor() {
        /** Open stroke per author. @type {Map<string, StrokeCapture>} */
        this.open = new Map();
        /** Ended records per author, oldest first. @type {Map<string, object[]>} */
        this.records = new Map();
        /** Every kept record, oldest first (removed ones are skipped lazily). @type {object[]} */
        this.order = [];
        /** Bytes of deltas kept. @type {number} */
        this.bytes = 0;
    }

    /**
     * Forgets everything.
     *
     * @returns {void}
     */
    clear() {
        this.open.clear();
        this.records.clear();
        this.order = [];
        this.bytes = 0;
    }

    /**
     * The capture of an author's stroke, opening it when needed. Opening a newer stroke ends the
     * author's previous open stroke first (its end op may have been lost). Ops of an older stroke
     * than the open one, or of a stroke already ended, are not captured.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     * @param {import('./grid.js').Grid} grid The confirmed grid.
     * @returns {StrokeCapture|null} The capture, or null when this op is not undoable.
     */
    stroke(author, stroke, grid) {
        const cur = this.open.get(author);
        if (cur) {
            if (cur.stroke === stroke) {
                return cur;
            }
            if (stroke < cur.stroke) {
                return null;
            }
            this.end(author, cur.stroke, grid);
        }
        const list = this.records.get(author);
        if (list && list.length && list[list.length - 1].stroke >= stroke) {
            return null;
        }
        const capture = new StrokeCapture(author, stroke);
        this.open.set(author, capture);
        return capture;
    }

    /**
     * Ends an author's open stroke and stores its record.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id (ignored unless it is the open one).
     * @param {import('./grid.js').Grid} grid The confirmed grid, after the stroke.
     * @returns {object|null} The new record, or null (no such open stroke, or it changed nothing).
     */
    end(author, stroke, grid) {
        const cur = this.open.get(author);
        if (!cur || cur.stroke !== stroke) {
            return null;
        }
        this.open.delete(author);
        const {nx, ny, data} = grid;
        const [ncx, ncy] = grid.chunks;
        const rec = {author, stroke, chunks: new Map(), box: null, bytes: 0, undone: false, removed: false};
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        cur.chunks.forEach((cap, ci) => {
            const cx = ci % ncx;
            const cy = Math.floor(ci / ncx) % ncy;
            const cz = Math.floor(ci / (ncx * ncy));
            const bx = cx * CHUNK;
            const by = cy * CHUNK;
            const bz = cz * CHUNK;
            let delta = null;
            for (let li = 0; li < CHUNK_VOXELS; li++) {
                if (!cap.mask[li]) {
                    continue;
                }
                const i = bx + (li & 15);
                const j = by + ((li >> 4) & 15);
                const k = bz + (li >> 8);
                const dl = grid.level(data[i + nx * (j + ny * k)]) - cap.before[li];
                if (dl === 0) {
                    continue;
                }
                if (!delta) {
                    delta = new Int16Array(CHUNK_VOXELS);
                }
                delta[li] = dl;
                if (i < min[0]) {
                    min[0] = i;
                }
                if (j < min[1]) {
                    min[1] = j;
                }
                if (k < min[2]) {
                    min[2] = k;
                }
                if (i > max[0]) {
                    max[0] = i;
                }
                if (j > max[1]) {
                    max[1] = j;
                }
                if (k > max[2]) {
                    max[2] = k;
                }
            }
            if (delta) {
                rec.chunks.set(ci, delta);
                rec.bytes += delta.byteLength;
            }
        });
        if (!rec.chunks.size) {
            return null;
        }
        rec.box = {min, max};
        let list = this.records.get(author);
        if (!list) {
            list = [];
            this.records.set(author, list);
        }
        list.push(rec);
        this.order.push(rec);
        this.bytes += rec.bytes;
        while (list.length > MAX_RECORDS_PER_AUTHOR) {
            this.remove(list[0]);
        }
        while (this.bytes > MAX_HISTORY_BYTES && this.order.length) {
            const oldest = this.order.shift();
            if (!oldest.removed) {
                this.remove(oldest);
            }
        }
        return rec;
    }

    /**
     * Drops a record.
     *
     * @param {object} rec The record.
     * @returns {void}
     */
    remove(rec) {
        if (rec.removed) {
            return;
        }
        rec.removed = true;
        this.bytes -= rec.bytes;
        const list = this.records.get(rec.author);
        if (list) {
            const at = list.indexOf(rec);
            if (at !== -1) {
                list.splice(at, 1);
            }
            if (!list.length) {
                this.records.delete(rec.author);
            }
        }
        if (this.order.length > 4 * MAX_RECORDS_PER_AUTHOR) {
            this.order = this.order.filter((r) => !r.removed);
        }
    }

    /**
     * The record of an author's ended stroke.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     * @returns {object|null} The record or null (unknown or evicted).
     */
    find(author, stroke) {
        const list = this.records.get(author);
        if (!list) {
            return null;
        }
        for (let n = list.length - 1; n >= 0; n--) {
            if (list[n].stroke === stroke) {
                return list[n];
            }
        }
        return null;
    }

    /**
     * The voxel box an undo or redo of a stroke would write.
     *
     * @param {string} author Author id.
     * @param {number} stroke Target stroke id.
     * @param {boolean} redo True for redo.
     * @returns {{min: number[], max: number[]}|null} The box, or null when it would be a no-op.
     */
    boxFor(author, stroke, redo) {
        const rec = this.find(author, stroke);
        if (!rec || rec.undone !== redo) {
            return null;
        }
        return rec.box;
    }

    /**
     * Undoes (subtracts the delta of) an author's stroke. A no-op for unknown, evicted or already
     * undone strokes.
     *
     * @param {string} author Author id.
     * @param {number} stroke Target stroke id.
     * @param {import('./grid.js').Grid} grid The confirmed grid.
     * @returns {{min: number[], max: number[]}|null} The box written, or null.
     */
    undo(author, stroke, grid) {
        const rec = this.find(author, stroke);
        if (!rec || rec.undone) {
            return null;
        }
        applyDelta(rec, grid, -1);
        rec.undone = true;
        return rec.box;
    }

    /**
     * Redoes (adds the delta of) an author's undone stroke. A no-op unless it is undone.
     *
     * @param {string} author Author id.
     * @param {number} stroke Target stroke id.
     * @param {import('./grid.js').Grid} grid The confirmed grid.
     * @returns {{min: number[], max: number[]}|null} The box written, or null.
     */
    redo(author, stroke, grid) {
        const rec = this.find(author, stroke);
        if (!rec || !rec.undone) {
            return null;
        }
        applyDelta(rec, grid, 1);
        rec.undone = false;
        return rec.box;
    }
}

/**
 * Adds sign × delta of a record to the grid, clamped to the band.
 *
 * @param {object} rec The record.
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {number} sign −1 (undo) or 1 (redo).
 * @returns {void}
 */
function applyDelta(rec, grid, sign) {
    const {nx, ny, data, levels} = grid;
    const [ncx, ncy] = grid.chunks;
    rec.chunks.forEach((delta, ci) => {
        const bx = (ci % ncx) * CHUNK;
        const by = (Math.floor(ci / ncx) % ncy) * CHUNK;
        const bz = Math.floor(ci / (ncx * ncy)) * CHUNK;
        for (let li = 0; li < CHUNK_VOXELS; li++) {
            const dl = delta[li];
            if (dl === 0) {
                continue;
            }
            const idx = (bx + (li & 15)) + nx * ((by + ((li >> 4) & 15)) + ny * (bz + (li >> 8)));
            let q = grid.level(data[idx]) + sign * dl;
            q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
            data[idx] = levels[q + QMAX];
        }
    });
}
