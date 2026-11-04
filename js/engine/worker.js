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
 * Module Web Worker that runs the sculpting engine off the main thread.
 *
 * Start it with new Worker(url, {type: 'module'}); url may carry a cache-busting query (?v=…),
 * which is passed on to the sibling modules it imports.
 *
 * main → worker:
 *   {type: 'init', dims, voxel, model, upload: {bytes: ArrayBuffer, format}|null, snapshot: ArrayBuffer|null}
 *       → {type: 'ready', seq, epoch, dims, voxel}, then {type: 'chunks'} with every non-empty chunk
 *   {type: 'local', op}             apply to the display state as a pending op
 *   {type: 'confirmed', op, seq}    apply to the confirmed state in seq order
 *   {type: 'promote'}               every pending op becomes confirmed
 *   {type: 'load', id, snapshot}    → {type: 'loaded', id, seq, epoch} (replaces both states)
 *   {type: 'serialize', id, epoch}  → {type: 'serialized', id, bytes: ArrayBuffer, seq}
 *   {type: 'export', id, format}    → {type: 'exported', id, bytes: ArrayBuffer, report} (stl|glb|3mf)
 *   {type: 'stats', id}             → {type: 'stats', id, seq, pending, contributions}
 * worker → main, unsolicited:
 *   {type: 'chunks', chunks: [{key: 'cx,cy,cz', positions, normals, indices}]} (buffers transferred,
 *       empty arrays remove the chunk), at most every 33 ms;
 *   {type: 'rejected', op, reason};  {type: 'error', id?, message}.
 *
 * Messages are handled strictly in arrival order. serialize and export capture the state at the
 * moment they are handled; their compression and packing then run while later messages proceed.
 *
 * @module     mod_vrmakerspace/engine/worker
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Smallest interval between two chunk messages in ms. */
const REMESH_MS = 33;

/** Cache-busting query of this worker's URL, passed on to its imports. */
const QUERY = self.location.search || '';

/** Lazily imported modules. @type {{engine: object, mesher: object, exporter: object, validate: object}|null} */
let modules = null;

/** The engine, once initialised. @type {object|null} */
let engine = null;

/** Keys of the chunks the main thread currently holds a non-empty mesh for. @type {Set<string>} */
const shown = new Set();

/** Pending remesh timer. @type {number|null} */
let timer = null;

/** Time of the last chunks message (performance.now()). */
let lastSent = -Infinity;

/** Tail of the message queue. @type {Promise<void>} */
let queue = Promise.resolve();

/**
 * Imports the engine, the two meshers, export and validation modules (once).
 *
 * @returns {Promise<object>} The modules.
 */
async function loadModules() {
    if (!modules) {
        const [engineModule, mesher, tetmesh, exporter, validate] = await Promise.all([
            import('./engine.js' + QUERY),
            import('./mesher.js' + QUERY),
            import('./tetmesh.js' + QUERY),
            import('./export.js' + QUERY),
            import('./validate.js' + QUERY),
        ]);
        modules = {engine: engineModule, mesher, tetmesh, exporter, validate};
    }
    return modules;
}

/**
 * Posts an error to the main thread.
 *
 * @param {*} e The error.
 * @param {number|string} [id] Request id it answers.
 * @returns {void}
 */
function postError(e, id) {
    const message = e && e.message ? e.message : String(e);
    const out = {type: 'error', message};
    if (id !== undefined) {
        out.id = id;
    }
    self.postMessage(out);
}

/**
 * The ArrayBuffer of a byte array, ready to transfer (copied when the array is a view into a larger
 * buffer).
 *
 * @param {Uint8Array|ArrayBuffer} bytes Bytes.
 * @returns {ArrayBuffer} An ArrayBuffer holding exactly those bytes.
 */
function ownBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) {
        return bytes;
    }
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        return bytes.buffer;
    }
    return bytes.slice().buffer;
}

/**
 * A typed array whose buffer can be transferred: itself when it owns its whole buffer, else a copy.
 *
 * @param {Float32Array|Uint32Array} arr Array.
 * @returns {Float32Array|Uint32Array} A transferable array with the same values.
 */
function ownArray(arr) {
    if (arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength) {
        return arr;
    }
    return arr.slice();
}

/**
 * Meshes the dirty chunks and posts them (with every chunk that became empty).
 *
 * @returns {void}
 */
function flushChunks() {
    timer = null;
    if (!engine) {
        return;
    }
    const dirty = engine.takeDirtyChunks();
    if (!dirty.length) {
        return;
    }
    const grid = engine.display;
    const out = [];
    const transfer = [];
    for (let n = 0; n < dirty.length; n++) {
        const [cx, cy, cz] = dirty[n];
        const key = cx + ',' + cy + ',' + cz;
        const mesh = modules.mesher.meshChunk(grid, cx, cy, cz);
        if (!mesh.indices.length) {
            if (shown.has(key)) {
                shown.delete(key);
                out.push({key, positions: new Float32Array(0), normals: new Float32Array(0),
                    indices: new Uint32Array(0)});
            }
            continue;
        }
        const positions = ownArray(mesh.positions);
        const normals = ownArray(mesh.normals);
        const indices = ownArray(mesh.indices);
        shown.add(key);
        out.push({key, positions, normals, indices});
        transfer.push(positions.buffer, normals.buffer, indices.buffer);
    }
    lastSent = performance.now();
    if (out.length) {
        self.postMessage({type: 'chunks', chunks: out}, transfer);
    }
}

/**
 * Schedules a remesh no sooner than 33 ms after the previous chunks message.
 *
 * @returns {void}
 */
function scheduleRemesh() {
    if (timer !== null) {
        return;
    }
    const wait = Math.max(0, REMESH_MS - (performance.now() - lastSent));
    timer = setTimeout(() => {
        try {
            flushChunks();
        } catch (e) {
            postError(e);
        }
    }, wait);
}

/**
 * Meshes everything now (after init and load), cancelling a scheduled remesh.
 *
 * @returns {void}
 */
function remeshNow() {
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
    flushChunks();
}

/**
 * Posts a rejected op.
 *
 * @param {*} op The op as received.
 * @param {string} reason Why.
 * @returns {void}
 */
function postRejected(op, reason) {
    self.postMessage({type: 'rejected', op, reason});
}

/**
 * Throws unless the engine is initialised.
 *
 * @returns {object} The engine.
 * @throws {Error} When init has not succeeded yet.
 */
function needEngine() {
    if (!engine) {
        throw new Error('the engine is not initialised');
    }
    return engine;
}

/**
 * Builds the export of the display state: one closed, manifold mesh (marching tetrahedra; the display's
 * surface nets can be non-manifold where two surfaces share a cell), the file and its printability report.
 *
 * @param {object} grid The display grid.
 * @param {string} format 'stl', 'glb' or '3mf'.
 * @returns {Promise<{bytes: ArrayBuffer, report: object}>} The file and report.
 */
async function buildExport(grid, format) {
    const mesh = modules.tetmesh.meshManifold(grid);
    let bytes;
    if (format === 'stl') {
        bytes = await modules.exporter.toSTL(mesh);
    } else if (format === 'glb') {
        bytes = await modules.exporter.toGLB(mesh);
    } else if (format === '3mf') {
        bytes = await modules.exporter.to3MF(mesh);
    } else {
        throw new Error('unknown export format: ' + String(format));
    }
    const report = modules.validate.check(mesh);
    return {bytes: ownBuffer(bytes), report};
}

/**
 * Handles one message from the main thread.
 *
 * @param {object} msg The message.
 * @returns {Promise<void>} Resolves when the state change is done (replies of serialize and export
 *     may follow later).
 */
async function handle(msg) {
    if (!msg || typeof msg !== 'object') {
        return;
    }
    switch (msg.type) {
        case 'init': {
            const m = await loadModules();
            engine = await m.engine.Engine.create({dims: msg.dims, voxel: msg.voxel, model: msg.model,
                upload: msg.upload || null, snapshot: msg.snapshot || null});
            shown.clear();
            const grid = engine.display;
            self.postMessage({type: 'ready', seq: engine.seq, epoch: engine.epoch, dims: grid.nx, voxel: grid.voxel});
            engine.markAllDirty();
            remeshNow();
            return;
        }
        case 'local': {
            const r = needEngine().local(msg.op);
            if (!r.ok && r.reason !== 'duplicate') {
                postRejected(msg.op, r.reason);
            }
            scheduleRemesh();
            return;
        }
        case 'confirmed': {
            const r = needEngine().confirmed(msg.op, msg.seq);
            if (!r.ok && (r.reason === 'invalid' || r.reason === 'noauthor')) {
                postRejected(msg.op, r.reason);
            }
            scheduleRemesh();
            return;
        }
        case 'promote':
            needEngine().promote();
            scheduleRemesh();
            return;
        case 'load': {
            try {
                const r = await needEngine().load(msg.snapshot);
                self.postMessage({type: 'loaded', id: msg.id, seq: r.seq, epoch: r.epoch});
                engine.markAllDirty();
                remeshNow();
            } catch (e) {
                postError(e, msg.id);
            }
            return;
        }
        case 'serialize': {
            const e = needEngine();
            const seq = e.seq;
            // The payload is captured synchronously inside serialize(); compression continues while
            // later messages are handled.
            e.serialize(msg.epoch).then((bytes) => {
                const buffer = ownBuffer(bytes);
                self.postMessage({type: 'serialized', id: msg.id, bytes: buffer, seq}, [buffer]);
                return null;
            }).catch((err) => postError(err, msg.id));
            return;
        }
        case 'export': {
            const e = needEngine();
            buildExport(e.display, msg.format).then(({bytes, report}) => {
                self.postMessage({type: 'exported', id: msg.id, bytes, report}, [bytes]);
                return null;
            }).catch((err) => postError(err, msg.id));
            return;
        }
        case 'stats': {
            const s = needEngine().stats();
            self.postMessage({type: 'stats', id: msg.id, seq: s.seq, pending: s.pending,
                contributions: s.contributions});
            return;
        }
        default:
            return;
    }
}

self.addEventListener('message', (event) => {
    const msg = event.data;
    queue = queue.then(() => handle(msg)).catch((e) => {
        postError(e, msg && msg.id !== undefined ? msg.id : undefined);
    });
});
