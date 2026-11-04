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
 * The engine of a piece, its clay and mesh layers: confirmed state, display state and the rebase rule.
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
 * The mesh layer follows the same idea, more simply: MC is the confirmed PolyDoc and MD = MC ⊕ the pending
 * mesh ops, in pending order. A mesh op applies to MD when local; when the sequencer confirms it, it applies
 * to MC with a capture for MeshHistory. If it was the oldest pending op with identical JSON, MD already holds
 * it; otherwise, with mesh ops still pending, MD is rebuilt from MC. Own ops that the document refuses are
 * kept in pending all the same (they are sent, and the confirmed state decides), have no effect while they
 * are refused, and are told to the main thread once. mbake (the whole mesh into the clay) is never applied
 * optimistically: it runs when confirmed, and changes both layers under one stroke. A preview is a local-only
 * op shown on a throw-away copy of MD; it is never sent and never reaches MC.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/engine
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {BORDER, Grid, CHUNK} from './grid.js';
import {fillMeshModel, fillModel, isModel} from './models.js';
import {fillMesh, fillUpload, FORMATS} from './meshimport.js';
import {MAX_ID, READ_MARGIN, applyOp, cleanOp, copyBox, createWork, footprint, isStrokeKind} from './ops.js';
import {History} from './history.js';
import {MeshHistory, PolyDoc, bakeGroups} from './polymesh.js';
import {MESH_EDIT_KINDS, MESH_KINDS, applyMeshOp} from './polyops.js';
import {isEpoch, readSnapshot, writeSnapshot, MIN_DIM, MAX_DIM, MIN_VOXEL, MAX_VOXEL} from './snapshot.js';

/** Voxels a mesh chunk depends on below its first cell and above its last (surface nets + normals). */
const MESH_MARGIN = 3;

/** Default grid edge in voxels, voxel size in metres and band in voxels (§2 of the build contract). */
export const DEFAULT_DIMS = 128;
export const DEFAULT_VOXEL = 0.004;
export const BAND_VOXELS = 3;

/** Voxels added around the band when baking the mesh into the clay. */
const BAKE_MARGIN = 2;

/** Refused own ops kept for the main thread until it collects them. */
const MAX_REFUSALS = 64;

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
 * Whether a kind acts on the mesh layer.
 *
 * @param {string} k Kind.
 * @returns {boolean} True for the m* kinds.
 */
function isMeshKind(k) {
    return MESH_KINDS.indexOf(k) !== -1;
}

/**
 * The engine of a piece.
 */
export class Engine {
    /**
     * Creates an engine over a confirmed grid. Use Engine.create().
     *
     * @param {Grid} grid Confirmed grid (taken).
     * @param {number} seq Confirmed sequence number.
     * @param {string} epoch Epoch (16 hex characters).
     * @param {PolyDoc} [mesh] Confirmed mesh document (taken); default: an empty one.
     */
    constructor(grid, seq, epoch, mesh) {
        /** Contributions per author, counted on C: {ops, added, removed} (mm³). @type {Map<string, object>} */
        this.contributions = new Map();
        this.reset(grid, seq, epoch, mesh);
    }

    /**
     * Creates an engine from a snapshot, or from a starting model when there is none.
     *
     * @param {{dims: (number|undefined), voxel: (number|undefined), model: (string|undefined),
     *     upload: ({bytes: (ArrayBuffer|ArrayBufferView), format: string}|null|undefined),
     *     snapshot: (ArrayBuffer|ArrayBufferView|null|undefined)}} [options] dims (8..256, default 128)
     *     and voxel (metres, default 0.004) for a new grid; model 'lump' (default), 'sphere', 'cube',
     *     'empty', 'meshcube' (no clay, a polygon cube) or 'upload' (the uploaded model in upload: an STL, OBJ
     *     or glTF binary file, see meshimport.js); snapshot a VRSC file, whose dimensions, voxel, mesh, seq and
     *     epoch then win.
     * @returns {Promise<Engine>} The engine. Its epoch is the snapshot's, else a new random one.
     * @throws {Error} For a bad snapshot, model or grid shape.
     */
    static async create(options = {}) {
        const bytes = snapshotBytes(options.snapshot);
        if (bytes) {
            const r = await readSnapshot(bytes);
            return new Engine(r.grid, r.seq, r.epoch || randomEpoch(), r.mesh);
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
        return new Engine(grid, 0, randomEpoch(), fillMeshModel(new PolyDoc(), model));
    }

    /**
     * Replaces both states with a confirmed grid and mesh (pending ops, undo records, a preview and dedupe
     * state are dropped; contributions are kept) and marks every mesh chunk and the mesh layer dirty.
     *
     * @param {Grid} grid Confirmed grid (taken).
     * @param {number} seq Confirmed sequence number.
     * @param {string} epoch Epoch.
     * @param {PolyDoc} [mesh] Confirmed mesh document (taken); default: an empty one.
     * @returns {void}
     */
    reset(grid, seq, epoch, mesh) {
        /** Confirmed mesh document. @type {PolyDoc} */
        this.MC = mesh || new PolyDoc();
        /** Display mesh document, MC ⊕ the pending mesh ops. @type {PolyDoc} */
        this.MD = this.MC.copy();
        /** Undo records of the mesh layer, kept on MC only. @type {MeshHistory} */
        this.meshHistory = new MeshHistory();
        /** Whether the shown mesh changed since takePolyDirty(). @type {boolean} */
        this.meshDirty = true;
        /** The clean local-only op being previewed. @type {object|null} */
        this.previewOp = null;
        /** MD with the preview applied, made when first asked for. @type {PolyDoc|null} */
        this.previewDoc = null;
        /** Own mesh ops refused and not yet collected: {op, reason}. @type {object[]} */
        this.refusals = [];
        /** Why the confirmed mesh op being applied was refused. @type {string|null} */
        this.refusal = null;
        /** Whether applying a confirmed op changed MC so that MD must be rebuilt. @type {boolean} */
        this.polyStale = false;
        /** @type {Grid} */
        this.C = grid;
        /** @type {Grid} */
        this.D = grid.copy();
        /** Pending own ops: {op, json, box, mesh, told}. @type {object[]} */
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
     * The confirmed mesh document.
     *
     * @returns {PolyDoc} The document (do not modify).
     */
    get polyConfirmed() {
        return this.MC;
    }

    /**
     * The mesh to show: MD, or a throw-away copy of MD with the preview applied. A preview the document
     * refuses shows MD as it is.
     *
     * @returns {PolyDoc} The document (do not modify).
     */
    get polyDisplay() {
        if (!this.previewOp) {
            return this.MD;
        }
        if (!this.previewDoc) {
            const doc = this.MD.copy();
            this.previewDoc = applyMeshOp(doc, this.previewOp).ok ? doc : this.MD;
        }
        return this.previewDoc;
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
     * A mesh op the document refuses stays pending: it is on its way to the sequencer, and the confirmed
     * state decides. The result then carries the document's reason as `refused`, and takeRefusals() has it.
     *
     * @param {object} op The op (must carry its author `a`).
     * @returns {{ok: boolean, op: (object|undefined), reason: (string|undefined), refused: (string|undefined)}}
     *     ok with the clean op, or a reason: 'invalid', 'noauthor' or 'duplicate'.
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
        let refused = null;
        const mesh = isMeshKind(c.k);
        if (isStrokeKind(c.k)) {
            box = applyOp(this.D, c, this.workD);
            if (box) {
                this.markDirtyBox(box);
            }
        } else if (mesh && c.k !== 'mbake') {
            const r = applyMeshOp(this.MD, c);
            if (r.ok) {
                this.polyChanged();
            } else {
                refused = r.reason;
                this.refuse(c, refused);
            }
        }
        this.pending.push({op: c, json: JSON.stringify(c), box, mesh, told: refused !== null});
        return refused === null ? {ok: true, op: c} : {ok: true, op: c, refused};
    }

    /**
     * Applies a sequenced op to the confirmed state, then rebases the display state.
     *
     * The sequence number advances even for an invalid op (every client rejects it the same way).
     * Pending ops of the same author with an index up to the op's are dropped (confirmed, or lost).
     * A mesh op the document refuses is still ok here (it took its seq and changed nothing, on every
     * client alike); the result carries the reason as `refused`, and when it is this client's own op that
     * it has not been told about yet, takeRefusals() has it.
     *
     * @param {object} op The op, author stamped by the sequencer.
     * @param {number} seq Its sequence number (must be greater than the current one).
     * @returns {{ok: boolean, op: (object|undefined), reason: (string|undefined), refused: (string|undefined)}}
     *     ok with the clean op, or a reason: 'stale' (old seq, ignored), 'invalid', 'noauthor' or 'duplicate'.
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
            first.json === JSON.stringify(c) && c.k !== 'undo' && c.k !== 'redo' && c.k !== 'mbake';
        const changed = [];
        let w = 0;
        let droppedMesh = false;
        let own = false;
        let told = false;
        for (let n = 0; n < pending.length; n++) {
            const p = pending[n];
            if (p.op.a === c.a && p.op.i <= c.i) {
                if (!(fast && n === 0)) {
                    if (p.box) {
                        changed.push(p.box);
                    }
                    // A dropped mbake never showed; any other mesh op left its mark on MD.
                    droppedMesh = droppedMesh || (p.mesh && p.op.k !== 'mbake');
                }
                if (p.op.i === c.i) {
                    own = true;
                    told = p.told;
                }
                continue;
            }
            pending[w++] = p;
        }
        pending.length = w;

        this.refusal = null;
        this.polyStale = false;
        const box = this.applyConfirmed(c);
        if (!fast && box) {
            changed.push(box);
        }
        if (changed.length) {
            this.rebase(changed);
        }
        const refused = this.refusal;
        this.rebasePoly(c, fast, droppedMesh, refused);
        if (refused === null) {
            return {ok: true, op: c};
        }
        if (own && !told) {
            this.refuse(c, refused);
        }
        return {ok: true, op: c, refused};
    }

    /**
     * Brings MD back to MC ⊕ the pending mesh ops after a confirmed op.
     *
     * @param {object} c The clean confirmed op, already applied to MC and removed from pending.
     * @param {boolean} fast Whether it was the oldest pending op with identical JSON, so MD holds it.
     * @param {boolean} droppedMesh Whether a pending mesh op that MD holds was dropped without being that op.
     * @param {string|null} refused Why MC refused it, if it did: MC then did not change.
     * @returns {void}
     */
    rebasePoly(c, fast, droppedMesh, refused) {
        if (droppedMesh || this.polyStale) {
            this.rebuildPoly();
            return;
        }
        if (fast || refused !== null || !isMeshKind(c.k)) {
            return;
        }
        if (this.pending.some((p) => p.mesh && p.op.k !== 'mbake')) {
            this.rebuildPoly();
            return;
        }
        applyMeshOp(this.MD, c);
        this.polyChanged();
    }

    /**
     * Rebuilds MD: a copy of MC with every pending mesh op applied again in order (a pending mbake never shows).
     *
     * @returns {void}
     */
    rebuildPoly() {
        const doc = this.MC.copy();
        this.pending.forEach((p) => {
            if (p.mesh && p.op.k !== 'mbake') {
                applyMeshOp(doc, p.op);
            }
        });
        this.MD = doc;
        this.polyChanged();
    }

    /**
     * Notes that the mesh on display changed: a preview is worked out again, and the worker posts it.
     *
     * @returns {void}
     */
    polyChanged() {
        this.previewDoc = null;
        this.meshDirty = true;
    }

    /**
     * Keeps an own mesh op's refusal until the main thread collects it.
     *
     * @param {object} op The clean op.
     * @param {string} reason The document's reason.
     * @returns {void}
     */
    refuse(op, reason) {
        if (this.refusals.length < MAX_REFUSALS) {
            this.refusals.push({op, reason});
        }
    }

    /**
     * The own mesh ops refused since the last call, oldest first, and clears the list. Each op appears
     * at most once: when local refused it, its confirmation adds nothing.
     *
     * @returns {Array<{op: object, reason: string}>} The refusals.
     */
    takeRefusals() {
        const out = this.refusals;
        this.refusals = [];
        return out;
    }

    /**
     * Whether the mesh to show changed since the last call, and clears the flag.
     *
     * @returns {boolean} True when polyDisplay has something new.
     */
    takePolyDirty() {
        const dirty = this.meshDirty;
        this.meshDirty = false;
        return dirty;
    }

    /**
     * Shows the result of an adjustable mesh tool while it is dragged. The op is local only: it is never sent,
     * never pending, and only ever applied to a copy of MD. It is applied again after every change of MD.
     *
     * @param {object|null} op The op (with its author; `i` is replaced by the largest op index, and `s` is
     *     optional), or null to clear. Not `msel` or `mbake`.
     * @returns {{ok: boolean, reason: (string|undefined)}} ok, or 'invalid' or 'noauthor' (the preview is
     *     then cleared).
     */
    setPreview(op) {
        const had = this.previewOp !== null;
        this.previewOp = null;
        this.previewDoc = null;
        let result = {ok: true};
        if (op) {
            const c = cleanOp(Object.assign({}, op, {i: MAX_ID, s: op.s === undefined ? MAX_ID : op.s}));
            if (!c || MESH_EDIT_KINDS.indexOf(c.k) === -1 || c.k === 'mbake') {
                result = {ok: false, reason: 'invalid'};
            } else if (!c.a) {
                result = {ok: false, reason: 'noauthor'};
            } else {
                this.previewOp = c;
            }
        }
        if (had || this.previewOp) {
            this.meshDirty = true;
        }
        return result;
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
     * Applies a clean op to the confirmed state with undo capture and contribution counting.
     *
     * Sets this.refusal when the mesh document refused the op and this.polyStale when MD must be rebuilt.
     *
     * @param {object} c Clean op with an author.
     * @returns {{min: number[], max: number[]}|null} The voxel box written in C, or null.
     */
    applyConfirmed(c) {
        const C = this.C;
        if (c.k === 'mbake') {
            return this.applyBake(c);
        }
        if (isMeshKind(c.k)) {
            this.applyMeshConfirmed(c);
            return null;
        }
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
        if (c.k === 'hz') {
            // Someone started from a state without undo records. Every client forgets its records at this
            // same point of the stream, so an undo can never mean different things on different clients.
            this.history.clear();
            this.meshHistory.clear();
            return null;
        }
        if (c.k === 'end') {
            this.history.end(c.a, c.s, C);
            this.meshHistory.end(c.a, c.s, this.MC);
            return null;
        }
        if (c.k === 'undo' || c.k === 'redo') {
            const redo = c.k === 'redo';
            if (this.meshHistory.has(c.a, c.t)) {
                if (redo) {
                    this.meshHistory.redo(c.a, c.t, this.MC);
                } else {
                    this.meshHistory.undo(c.a, c.t, this.MC);
                }
                this.polyStale = true;
            }
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
     * Applies a clean mesh op other than mbake to MC. An edit goes through the stroke's capture, and counts
     * for its author unless the document refused it (a refused op did nothing).
     *
     * @param {object} c Clean mesh op with an author.
     * @returns {void}
     */
    applyMeshConfirmed(c) {
        const edit = MESH_EDIT_KINDS.indexOf(c.k) !== -1;
        const MC = this.MC;
        MC.rec = edit ? this.meshHistory.stroke(c.a, c.s, MC) : null;
        let r;
        try {
            r = applyMeshOp(MC, c);
        } finally {
            MC.rec = null;
        }
        if (!r.ok) {
            this.refusal = r.reason;
        } else if (edit) {
            this.contributionOf(c.a).ops++;
        }
    }

    /**
     * The confirmed mesh as a field. Overlapping parts are voxelised apart: counted together, their overlap
     * would come out hollow.
     *
     * @returns {Grid|null} A new grid, or null when the mesh encloses no voxel.
     */
    bakeSolid() {
        const C = this.C;
        const solid = new Grid(C.nx, C.ny, C.nz, C.voxel, C.band);
        const temp = new Grid(C.nx, C.ny, C.nz, C.voxel, C.band);
        const out = solid.data;
        const from = temp.data;
        out.fill(temp.levels[temp.levels.length - 1]);
        bakeGroups(this.MC).forEach((tris) => {
            fillMesh(temp, tris);
            for (let idx = 0; idx < out.length; idx++) {
                if (from[idx] < out[idx]) {
                    out[idx] = from[idx];
                }
            }
        });
        for (let idx = 0; idx < out.length; idx++) {
            if (out[idx] < 0) {
                return solid;
            }
        }
        return null;
    }

    /**
     * The voxel box of the mesh's faces grown by the band and a margin, clipped to the interior.
     *
     * @returns {{min: number[], max: number[]}|null} Inclusive voxel box, or null when the mesh lies entirely
     *     outside the interior.
     */
    bakeBox() {
        const C = this.C;
        const verts = this.MC.verts;
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        this.MC.faces.forEach((list) => {
            list.forEach((id) => {
                const p = verts.get(id);
                for (let a = 0; a < 3; a++) {
                    lo[a] = p[a] < lo[a] ? p[a] : lo[a];
                    hi[a] = p[a] > hi[a] ? p[a] : hi[a];
                }
            });
        });
        const reach = C.band / C.voxel + BAKE_MARGIN;
        const centre = [C.cx, C.cy, C.cz];
        const size = [C.nx, C.ny, C.nz];
        const min = [0, 0, 0];
        const max = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
            min[a] = Math.max(BORDER, Math.floor(lo[a] / C.voxel + centre[a] - reach));
            max[a] = Math.min(size[a] - 1 - BORDER, Math.ceil(hi[a] / C.voxel + centre[a] + reach));
            if (min[a] > max[a]) {
                return null;
            }
        }
        return {min, max};
    }

    /**
     * mbake: the whole mesh into the clay layer, as one stroke of both layers. Voxelises the mesh on a temporary
     * grid, keeps the lower distance of clay and mesh in the mesh's box, and deletes every face and vertex.
     * Refused 'empty' when there are no faces.
     *
     * @param {object} c Clean mbake op with an author.
     * @returns {{min: number[], max: number[]}|null} The voxel box written in C, or null.
     */
    applyBake(c) {
        const C = this.C;
        const MC = this.MC;
        if (MC.faces.size === 0) {
            this.refusal = 'empty';
            return null;
        }
        const box = this.bakeBox();
        const solid = box ? this.bakeSolid() : null;
        if (!solid) {
            // An open sheet encloses nothing: turning it into clay would only make it disappear.
            this.refusal = 'nosolid';
            return null;
        }
        this.contributionOf(c.a).ops++;
        const capture = this.history.stroke(c.a, c.s, C);
        copyBox(C, box, this.workC);
        const {nx, ny, data} = C;
        const from = solid.data;
        for (let k = box.min[2]; k <= box.max[2]; k++) {
            for (let j = box.min[1]; j <= box.max[1]; j++) {
                let idx = box.min[0] + nx * (j + ny * k);
                for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
                    if (from[idx] < data[idx]) {
                        data[idx] = from[idx];
                    }
                }
            }
        }
        this.account(box, c.a, capture);
        MC.rec = this.meshHistory.stroke(c.a, c.s, MC);
        try {
            Array.from(MC.faces.keys()).forEach((id) => MC.delFace(id));
            Array.from(MC.verts.keys()).forEach((id) => MC.delVert(id));
        } finally {
            MC.rec = null;
        }
        this.polyStale = true;
        return box;
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
        return writeSnapshot(this.C, this.seqValue, this.epochValue, {mesh: this.MC});
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
        this.reset(r.grid, r.seq, r.epoch || randomEpoch(), r.mesh);
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
