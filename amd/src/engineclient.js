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
 * The main-thread side of the sculpting engine: owns the module Web Worker that holds the signed
 * distance field, turns its chunk meshes into three.js meshes under the sculpture group, and gives
 * the session and the studio a promise-based API over the worker protocol.
 *
 * Every chunk is one Mesh whose geometry is updated in place: the vertex and index buffers grow
 * (by half again) only when a chunk needs more room than it has, so steady sculpting allocates
 * nothing on the main thread. The bounding sphere of a chunk is fixed by its place in the grid,
 * so it is never recomputed.
 *
 * @module     mod_vrsculpt/engineclient
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';

/** Cells per chunk edge (contract §2). */
const CHUNK = 16;

/** Extra room given to a buffer that has to grow, as a factor of the size needed. */
const GROWTH = 1.5;

/** Smallest vertex capacity of a chunk buffer. */
const MIN_VERTICES = 256;

/**
 * Copy bytes into a fresh ArrayBuffer the worker may keep (never transfers the caller's buffer).
 *
 * @param {ArrayBuffer|ArrayBufferView|null} bytes The bytes, or null.
 * @returns {ArrayBuffer|null}
 */
const toBuffer = (bytes) => {
    if (!bytes) {
        return null;
    }
    if (bytes instanceof ArrayBuffer) {
        return bytes.slice(0);
    }
    if (ArrayBuffer.isView(bytes)) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    throw new Error('Snapshot bytes must be an ArrayBuffer or a typed array');
};

/**
 * Create the engine client.
 *
 * @param {string} workerurl URL of js/engine/worker.js (with its ?v= cache key).
 * @param {Object} THREE The three.js module.
 * @param {Object} parent THREE.Group the chunk meshes are added to (the sculpture-local frame).
 * @param {Object} material Material every chunk mesh uses.
 * @returns {Object} EngineClient {init, local, confirmed, promote, load, serialize, exportModel, stats,
 *     meshes, on, dispose}
 */
export const createEngineClient = (workerurl, THREE, parent, material) => {
    const worker = new Worker(workerurl, {type: 'module'});
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    const requests = new Map();
    /** @type {Map<string, Object>} chunk key → Mesh */
    const chunks = new Map();
    /** @type {Object[]} the chunk meshes, for raycasting */
    let meshlist = [];
    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();
    let nextid = 1;
    let dims = 128;
    let voxel = 0.004;
    let initwait = null;
    let disposed = false;

    /**
     * Call the listeners of an event.
     *
     * @param {string} type Event type.
     * @param {*} detail Event detail.
     */
    const emit = (type, detail) => {
        const set = listeners.get(type);
        if (!set) {
            return;
        }
        set.forEach((fn) => {
            try {
                fn(detail);
            } catch (e) {
                Log.debug(e);
            }
        });
    };

    /**
     * Send a request that the worker answers with the same id.
     *
     * @param {Object} message The message without its id.
     * @param {Transferable[]} [transfer] Buffers to transfer.
     * @returns {Promise<Object>} The worker's answer.
     */
    const request = (message, transfer = []) => {
        if (disposed) {
            return Promise.reject(new Error('The sculpting engine has stopped'));
        }
        const id = nextid++;
        return new Promise((resolve, reject) => {
            requests.set(id, {resolve, reject});
            worker.postMessage(Object.assign({}, message, {id: id}), transfer);
        });
    };

    /**
     * Post a message that has no answer.
     *
     * @param {Object} message The message.
     */
    const post = (message) => {
        if (!disposed) {
            worker.postMessage(message);
        }
    };

    /**
     * The fixed bounding sphere of a chunk in the sculpture-local frame.
     *
     * @param {string} key Chunk key "cx,cy,cz".
     * @returns {Object} THREE.Sphere
     */
    const chunkSphere = (key) => {
        const parts = key.split(',').map(Number);
        const middle = (dims - 1) / 2;
        const centre = new THREE.Vector3(
            (parts[0] * CHUNK + CHUNK / 2 - middle) * voxel,
            (parts[1] * CHUNK + CHUNK / 2 - middle) * voxel,
            (parts[2] * CHUNK + CHUNK / 2 - middle) * voxel
        );
        // Half the chunk diagonal plus a voxel of margin.
        const radius = Math.sqrt(3) * (CHUNK / 2 + 1) * voxel;
        return new THREE.Sphere(centre, radius);
    };

    /**
     * Make an empty geometry with room for a number of vertices and indices.
     *
     * @param {number} vertexcapacity Vertices.
     * @param {number} indexcapacity Indices.
     * @param {Object} sphere Bounding sphere.
     * @returns {Object} THREE.BufferGeometry
     */
    const makeGeometry = (vertexcapacity, indexcapacity, sphere) => {
        const geometry = new THREE.BufferGeometry();
        const position = new THREE.BufferAttribute(new Float32Array(vertexcapacity * 3), 3);
        const normal = new THREE.BufferAttribute(new Float32Array(vertexcapacity * 3), 3);
        const index = new THREE.BufferAttribute(new Uint32Array(indexcapacity), 1);
        position.setUsage(THREE.DynamicDrawUsage);
        normal.setUsage(THREE.DynamicDrawUsage);
        index.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position', position);
        geometry.setAttribute('normal', normal);
        geometry.setIndex(index);
        geometry.boundingSphere = sphere.clone();
        geometry.boundingBox = new THREE.Box3(
            sphere.center.clone().subScalar(sphere.radius),
            sphere.center.clone().addScalar(sphere.radius)
        );
        return geometry;
    };

    /**
     * Remove one chunk mesh and free its GPU buffers.
     *
     * @param {string} key Chunk key.
     */
    const removeChunk = (key) => {
        const mesh = chunks.get(key);
        if (!mesh) {
            return;
        }
        parent.remove(mesh);
        mesh.geometry.dispose();
        chunks.delete(key);
    };

    /**
     * Put one chunk's new mesh data into its Mesh, growing the buffers only when needed.
     *
     * @param {Object} chunk {key, positions, normals, indices} from the worker.
     */
    const applyChunk = (chunk) => {
        const key = String(chunk.key);
        const positions = chunk.positions;
        const normals = chunk.normals;
        const indices = chunk.indices;
        if (!positions || !indices || positions.length === 0 || indices.length === 0) {
            removeChunk(key);
            return;
        }
        const vertices = positions.length / 3;
        let mesh = chunks.get(key);
        if (mesh) {
            const geometry = mesh.geometry;
            const capacity = geometry.getAttribute('position').count;
            const indexcapacity = geometry.index.count;
            if (capacity < vertices || indexcapacity < indices.length) {
                const sphere = geometry.boundingSphere;
                const replacement = makeGeometry(Math.ceil(Math.max(vertices, capacity) * GROWTH),
                    Math.ceil(Math.max(indices.length, indexcapacity) * GROWTH), sphere);
                geometry.dispose();
                mesh.geometry = replacement;
            }
        } else {
            const geometry = makeGeometry(Math.max(MIN_VERTICES, Math.ceil(vertices * GROWTH)),
                Math.max(MIN_VERTICES * 6, Math.ceil(indices.length * GROWTH)), chunkSphere(key));
            mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'vrsculpt-chunk-' + key;
            mesh.userData.vrsculptChunk = key;
            mesh.matrixAutoUpdate = false;
            mesh.updateMatrix();
            chunks.set(key, mesh);
            parent.add(mesh);
        }
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        position.array.set(positions);
        position.clearUpdateRanges();
        position.addUpdateRange(0, positions.length);
        position.needsUpdate = true;
        if (normals && normals.length === positions.length) {
            normal.array.set(normals);
        } else {
            normal.array.fill(0, 0, positions.length);
        }
        normal.clearUpdateRanges();
        normal.addUpdateRange(0, positions.length);
        normal.needsUpdate = true;
        geometry.index.array.set(indices);
        geometry.index.clearUpdateRanges();
        geometry.index.addUpdateRange(0, indices.length);
        geometry.index.needsUpdate = true;
        geometry.setDrawRange(0, indices.length);
    };

    /**
     * Apply a chunks message and refresh the raycast list when chunks came or went.
     *
     * @param {Object[]} list Chunk updates.
     */
    const applyChunks = (list) => {
        const before = chunks.size;
        let changed = false;
        (Array.isArray(list) ? list : []).forEach((chunk) => {
            const had = chunks.has(String(chunk.key));
            applyChunk(chunk);
            if (had !== chunks.has(String(chunk.key))) {
                changed = true;
            }
        });
        if (changed || before !== chunks.size) {
            meshlist = Array.from(chunks.values());
        }
        emit('chunks', {count: Array.isArray(list) ? list.length : 0});
    };

    /** Remove every chunk mesh. */
    const clearChunks = () => {
        Array.from(chunks.keys()).forEach(removeChunk);
        meshlist = [];
    };

    /**
     * Fail every waiting request.
     *
     * @param {Error} error The reason.
     */
    const failAll = (error) => {
        requests.forEach((pending) => pending.reject(error));
        requests.clear();
        if (initwait) {
            initwait.reject(error);
            initwait = null;
        }
    };

    /** Replies that settle a request: message type -> the value the request resolves to. */
    const REPLIES = {
        loaded: (data) => ({seq: Number(data.seq) || 0, epoch: data.epoch || ''}),
        serialized: (data) => ({bytes: new Uint8Array(data.bytes), seq: Number(data.seq) || 0}),
        exported: (data) => ({bytes: new Uint8Array(data.bytes), report: data.report || {}}),
        stats: (data) => ({
            seq: Number(data.seq) || 0,
            pending: Number(data.pending) || 0,
            contributions: data.contributions || {},
        }),
    };

    /**
     * Handle the engine's 'ready' message.
     *
     * @param {Object} data The message.
     */
    const onReady = (data) => {
        dims = Number(data.dims) || dims;
        voxel = Number(data.voxel) || voxel;
        if (initwait) {
            initwait.resolve({seq: Number(data.seq) || 0, epoch: data.epoch || ''});
            initwait = null;
        }
    };

    /**
     * Handle the engine's 'error' message: fail its request, else the start, else report it.
     *
     * @param {Object} data The message.
     * @param {Object|null} pending The request it answers.
     */
    const onError = (data, pending) => {
        const error = new Error(String(data.message || 'error'));
        if (pending) {
            requests.delete(data.id);
            pending.reject(error);
        } else if (initwait) {
            initwait.reject(error);
            initwait = null;
        } else {
            emit('error', {message: error.message});
        }
    };

    worker.addEventListener('message', (event) => {
        const data = event.data || {};
        const pending = data.id !== undefined && data.id !== null ? requests.get(data.id) : null;
        if (REPLIES[data.type]) {
            if (pending) {
                requests.delete(data.id);
                pending.resolve(REPLIES[data.type](data));
            }
        } else if (data.type === 'ready') {
            onReady(data);
        } else if (data.type === 'chunks') {
            applyChunks(data.chunks);
        } else if (data.type === 'rejected') {
            emit('rejected', {op: data.op, reason: data.reason});
        } else if (data.type === 'error') {
            onError(data, pending);
        } else {
            Log.debug('mod_vrsculpt: unknown engine message ' + data.type);
        }
    });
    worker.addEventListener('error', (event) => {
        const error = new Error(event && event.message ? event.message : 'The sculpting engine could not start');
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        failAll(error);
        emit('error', {message: error.message});
    });
    worker.addEventListener('messageerror', () => {
        emit('error', {message: 'The sculpting engine sent a message that could not be read'});
    });

    return {
        /**
         * Start (or restart) the engine from a model or a snapshot.
         *
         * @param {Object} options {dims, voxel, model, upload: {bytes, format}|null, snapshot: ArrayBuffer|Uint8Array|null}
         * @returns {Promise<Object>} {seq, epoch}
         */
        init: (options) => {
            if (disposed) {
                return Promise.reject(new Error('The sculpting engine has stopped'));
            }
            if (initwait) {
                initwait.reject(new Error('The sculpting engine was started again'));
            }
            clearChunks();
            const snapshot = toBuffer(options.snapshot || null);
            // A copy of the uploaded model each time: the caller keeps its bytes for a restart.
            const upload = options.upload ? {bytes: toBuffer(options.upload.bytes), format: options.upload.format} : null;
            const transfer = [snapshot, upload && upload.bytes].filter((b) => b);
            return new Promise((resolve, reject) => {
                initwait = {resolve, reject};
                worker.postMessage({
                    type: 'init',
                    dims: Number(options.dims) || 128,
                    voxel: Number(options.voxel) || 0.004,
                    model: options.model || 'lump',
                    upload: upload,
                    snapshot: snapshot,
                }, transfer);
            });
        },

        /**
         * Apply an own op to the display state as pending.
         *
         * @param {Object} op The op.
         */
        local: (op) => {
            post({type: 'local', op: op});
        },

        /**
         * Apply a sequenced op to the confirmed state.
         *
         * @param {Object} op The op (author stamped).
         * @param {number} seq Its sequence number.
         */
        confirmed: (op, seq) => {
            post({type: 'confirmed', op: op, seq: seq});
        },

        /** Turn every pending op into a confirmed one (this client became the sequencer). */
        promote: () => {
            post({type: 'promote'});
        },

        /**
         * Replace both states with a snapshot.
         *
         * @param {ArrayBuffer|Uint8Array} bytes VRSC bytes.
         * @returns {Promise<Object>} {seq, epoch}
         */
        load: (bytes) => {
            const snapshot = toBuffer(bytes);
            if (!snapshot) {
                return Promise.reject(new Error('No snapshot to load'));
            }
            return request({type: 'load', snapshot: snapshot}, [snapshot]);
        },

        /**
         * Serialise the confirmed state.
         *
         * @param {string} epoch Epoch written into the header.
         * @returns {Promise<Object>} {bytes: Uint8Array, seq}
         */
        serialize: (epoch) => request({type: 'serialize', epoch: epoch || ''}),

        /**
         * Export the display state as a printable or viewable file.
         *
         * @param {string} format 'stl', 'glb' or '3mf'.
         * @returns {Promise<Object>} {bytes: Uint8Array, report}
         */
        exportModel: (format) => request({type: 'export', format: format}),

        /**
         * Sequence state and contributions.
         *
         * @returns {Promise<Object>} {seq, pending, contributions}
         */
        stats: () => request({type: 'stats'}),

        /**
         * The chunk meshes (for raycasting); the array is replaced, never changed in place.
         *
         * @returns {Object[]} THREE.Mesh list.
         */
        meshes: () => meshlist,

        /**
         * Listen to an engine event: chunks, rejected, error.
         *
         * @param {string} type Event type.
         * @param {Function} fn Listener.
         * @returns {Function} Removes the listener.
         */
        on: (type, fn) => {
            if (!listeners.has(type)) {
                listeners.set(type, new Set());
            }
            listeners.get(type).add(fn);
            return () => {
                const set = listeners.get(type);
                if (set) {
                    set.delete(fn);
                }
            };
        },

        /** Stop the worker and free every mesh. */
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            failAll(new Error('The sculpting engine has stopped'));
            worker.terminate();
            clearChunks();
            listeners.clear();
        },
    };
};
