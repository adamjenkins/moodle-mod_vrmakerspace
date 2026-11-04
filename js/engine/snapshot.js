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
 * Snapshot file format "VRSC" (little-endian). Version 2 is written; versions 1 and 2 are read.
 *
 *  0  4 bytes  ASCII "VRSC"
 *  4  u16      format version: 2 (1 = the older clay-only form)
 *  6  u16      flags: bit 0 = the sections are deflate-raw compressed; other bits 0
 *  8  u16 ×3   nx, ny, nz (each 8..256)
 * 14  u16      reserved 0
 * 16  f32      voxel size in metres (0.0005..0.05)
 * 20  f32      band in metres (> 0)
 * 24  u32      seq: the confirmed op sequence number the data reflects
 * 28  16 bytes epoch: ASCII [0-9a-f]{16}, or 16 zero bytes
 * 44  u32      payload length = file length − 48
 * 48  payload
 *
 * Payload of version 2: u32 gridLength, the grid section (gridLength bytes), the mesh section (the
 * rest). Payload of version 1: the grid section alone; such a file has an empty mesh.
 *
 * The grid section holds Int8 per voxel, x fastest then y then z; d = q / 127 × band. The mesh section
 * is polymesh.serializeDoc() output: UTF-8 JSON {"v":[[id,x,y,z],…],"f":[[id,[v…]],…],"s":[[author,md,
 * [items]],…]} in Map order. With flag bit 0 each section is compressed on its own.
 *
 * The engine's grid only ever holds those 255 levels (grid.js), so writing and reading back is
 * lossless. Compression uses CompressionStream('deflate-raw'); where it is missing the sections are
 * written uncompressed (flags 0). Decompression stops as soon as a section outgrows what it can
 * legitimately hold, so a small hostile file cannot fill the memory.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/snapshot
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {Grid, QMAX} from './grid.js';
import {canon} from './mathx.js';
import {MAX_DOC_BYTES, PolyDoc, parseDoc, serializeDoc} from './polymesh.js';

/** File magic. */
export const MAGIC = 'VRSC';

/** The format version written. */
export const VERSION = 2;

/** The older clay-only format version, still read. */
export const VERSION_CLAY = 1;

/** Header size in bytes. */
export const HEADER_BYTES = 48;

/** Size of the gridLength field that starts a version 2 payload. */
export const GRID_LENGTH_BYTES = 4;

/** Flag: the sections are deflate-raw compressed. */
export const FLAG_DEFLATE = 1;

/** Dimension range per axis. */
export const MIN_DIM = 8;
export const MAX_DIM = 256;

/** Voxel size range in metres. */
export const MIN_VOXEL = 0.0005;
export const MAX_VOXEL = 0.05;

/** Largest decompressed mesh section in bytes: what polymesh.parseDoc() accepts. */
export const MAX_MESH_BYTES = MAX_DOC_BYTES;

/** Epoch pattern. */
const EPOCH_RE = /^[0-9a-f]{16}$/;

/**
 * Whether a value is a valid epoch string.
 *
 * @param {*} epoch Value.
 * @returns {boolean} True for 16 lower-case hex characters.
 */
export function isEpoch(epoch) {
    return typeof epoch === 'string' && EPOCH_RE.test(epoch);
}

/**
 * Bytes of an ArrayBuffer or typed array as a Uint8Array view (no copy).
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes Input.
 * @returns {Uint8Array} The view.
 */
function asBytes(bytes) {
    if (bytes instanceof Uint8Array) {
        return bytes;
    }
    if (bytes instanceof ArrayBuffer) {
        return new Uint8Array(bytes);
    }
    if (bytes && ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    throw new Error('snapshotinvalid: not binary data');
}

/**
 * Reads and validates the header of a snapshot.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes The whole file.
 * @returns {{version: number, flags: number, compressed: boolean, nx: number, ny: number, nz: number,
 *     voxel: number, band: number, seq: number, epoch: string, payloadLength: number, gridOffset: number,
 *     gridLength: number, meshOffset: number, meshLength: number}} Header fields; voxel and band
 *     canonicalised to 7 decimals, epoch '' for 16 zero bytes; the offsets are from the start of the
 *     file, the lengths are as stored (compressed when the file is), meshLength 0 in version 1.
 * @throws {Error} 'snapshotinvalid: …' when the header is not a valid VRSC header.
 */
export function header(bytes) {
    const u8 = asBytes(bytes);
    if (u8.length < HEADER_BYTES) {
        throw new Error('snapshotinvalid: too short');
    }
    if (u8[0] !== 0x56 || u8[1] !== 0x52 || u8[2] !== 0x53 || u8[3] !== 0x43) {
        throw new Error('snapshotinvalid: bad magic');
    }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = dv.getUint16(4, true);
    if (version !== VERSION && version !== VERSION_CLAY) {
        throw new Error('snapshotinvalid: unsupported version ' + version);
    }
    const flags = dv.getUint16(6, true);
    if ((flags & ~FLAG_DEFLATE) !== 0) {
        throw new Error('snapshotinvalid: unknown flags');
    }
    const nx = dv.getUint16(8, true);
    const ny = dv.getUint16(10, true);
    const nz = dv.getUint16(12, true);
    [nx, ny, nz].forEach((n) => {
        if (n < MIN_DIM || n > MAX_DIM) {
            throw new Error('snapshotinvalid: bad dimensions');
        }
    });
    const voxel = dv.getFloat32(16, true);
    if (!(voxel >= MIN_VOXEL * 0.999999 && voxel <= MAX_VOXEL * 1.000001)) {
        throw new Error('snapshotinvalid: bad voxel size');
    }
    const band = dv.getFloat32(20, true);
    if (!(band > 0) || !Number.isFinite(band)) {
        throw new Error('snapshotinvalid: bad band');
    }
    const seq = dv.getUint32(24, true);
    let epoch = '';
    let zero = true;
    for (let n = 28; n < 44; n++) {
        if (u8[n] !== 0) {
            zero = false;
        }
    }
    if (!zero) {
        epoch = String.fromCharCode.apply(null, Array.from(u8.subarray(28, 44)));
        if (!isEpoch(epoch)) {
            throw new Error('snapshotinvalid: bad epoch');
        }
    }
    const payloadLength = dv.getUint32(44, true);
    if (payloadLength !== u8.length - HEADER_BYTES) {
        throw new Error('snapshotinvalid: bad payload length');
    }
    const compressed = (flags & FLAG_DEFLATE) !== 0;
    let gridOffset = HEADER_BYTES;
    let gridLength = payloadLength;
    if (version === VERSION) {
        if (payloadLength < GRID_LENGTH_BYTES) {
            throw new Error('snapshotinvalid: bad payload length');
        }
        gridOffset = HEADER_BYTES + GRID_LENGTH_BYTES;
        gridLength = dv.getUint32(HEADER_BYTES, true);
        if (gridLength > payloadLength - GRID_LENGTH_BYTES) {
            throw new Error('snapshotinvalid: bad grid length');
        }
    }
    if (!compressed && gridLength !== nx * ny * nz) {
        throw new Error('snapshotinvalid: payload does not match the dimensions');
    }
    const meshOffset = gridOffset + gridLength;
    return {version, flags, compressed, nx, ny, nz, voxel: canon(voxel), band: canon(band), seq, epoch,
        payloadLength, gridOffset, gridLength, meshOffset, meshLength: u8.length - meshOffset};
}

/**
 * Runs bytes through a compression or decompression stream.
 *
 * @param {Uint8Array} u8 Input.
 * @param {TransformStream} transform A CompressionStream or DecompressionStream.
 * @returns {Promise<Uint8Array>} Output.
 */
async function pipe(u8, transform) {
    const stream = new Blob([u8]).stream().pipeThrough(transform);
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

/**
 * Deflate-raw compresses bytes, or returns null when the platform cannot.
 *
 * @param {Uint8Array} u8 Input.
 * @returns {Promise<Uint8Array|null>} Compressed bytes or null.
 */
async function deflate(u8) {
    if (typeof CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') {
        return null;
    }
    try {
        return await pipe(u8, new CompressionStream('deflate-raw'));
    } catch (e) {
        return null;
    }
}

/**
 * Inflates deflate-raw bytes, giving up as soon as the output outgrows a limit.
 *
 * @param {Uint8Array} u8 Compressed bytes.
 * @param {number} limit Most bytes the section can hold.
 * @returns {Promise<Uint8Array>} Decompressed bytes.
 * @throws {Error} When the platform cannot decompress, the data is corrupt or it is too large.
 */
async function inflate(u8, limit) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('snapshotinvalid: this browser cannot decompress snapshots');
    }
    const parts = [];
    let total = 0;
    let reader = null;
    try {
        reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        let chunk = await reader.read();
        while (!chunk.done) {
            total += chunk.value.length;
            if (total > limit) {
                break;
            }
            parts.push(chunk.value);
            chunk = await reader.read();
        }
    } catch (e) {
        throw new Error('snapshotinvalid: corrupt payload');
    }
    if (total > limit) {
        // The stream is abandoned half way; its end no longer matters.
        reader.cancel().catch(() => null);
        throw new Error('snapshotinvalid: a section is larger than it can be');
    }
    const out = new Uint8Array(total);
    let at = 0;
    parts.forEach((part) => {
        out.set(part, at);
        at += part.length;
    });
    return out;
}

/**
 * Writes a piece as a VRSC v2 snapshot.
 *
 * The grid and mesh sections are built synchronously when this is called (before the first await), so
 * the snapshot reflects the state at the moment of the call even if it changes while it compresses.
 *
 * @param {Grid} grid The grid.
 * @param {number} seq Confirmed op sequence number the data reflects (0..2^32 − 1).
 * @param {string} epoch 16 hex characters, or '' for none.
 * @param {{compress: (boolean|undefined), mesh: (PolyDoc|undefined)}} [options] compress: false writes the
 *     sections uncompressed; mesh: the mesh document (default: an empty one).
 * @returns {Promise<Uint8Array>} The file.
 */
export async function writeSnapshot(grid, seq, epoch, options = {}) {
    const {nx, ny, nz, data, inv} = grid;
    const count = nx * ny * nz;
    const raw = new Int8Array(count);
    for (let n = 0; n < count; n++) {
        let q = Math.round(data[n] * inv);
        q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
        raw[n] = q;
    }
    const meshPlain = serializeDoc(options.mesh || new PolyDoc());
    const head = new Uint8Array(HEADER_BYTES);
    const dv = new DataView(head.buffer);
    head[0] = 0x56;
    head[1] = 0x52;
    head[2] = 0x53;
    head[3] = 0x43;
    dv.setUint16(4, VERSION, true);
    dv.setUint16(8, nx, true);
    dv.setUint16(10, ny, true);
    dv.setUint16(12, nz, true);
    dv.setUint16(14, 0, true);
    dv.setFloat32(16, grid.voxel, true);
    dv.setFloat32(20, grid.band, true);
    dv.setUint32(24, Math.max(0, Math.min(0xffffffff, Math.floor(seq) || 0)), true);
    if (isEpoch(epoch)) {
        for (let n = 0; n < 16; n++) {
            head[28 + n] = epoch.charCodeAt(n);
        }
    }
    let gridSection = new Uint8Array(raw.buffer);
    let meshSection = meshPlain;
    let flags = 0;
    if (options.compress !== false) {
        const packedGrid = await deflate(gridSection);
        const packedMesh = packedGrid ? await deflate(meshPlain) : null;
        if (packedGrid && packedMesh) {
            gridSection = packedGrid;
            meshSection = packedMesh;
            flags = FLAG_DEFLATE;
        }
    }
    const payloadLength = GRID_LENGTH_BYTES + gridSection.length + meshSection.length;
    dv.setUint16(6, flags, true);
    dv.setUint32(44, payloadLength, true);
    const out = new Uint8Array(HEADER_BYTES + payloadLength);
    out.set(head, 0);
    new DataView(out.buffer).setUint32(HEADER_BYTES, gridSection.length, true);
    out.set(gridSection, HEADER_BYTES + GRID_LENGTH_BYTES);
    out.set(meshSection, HEADER_BYTES + GRID_LENGTH_BYTES + gridSection.length);
    return out;
}

/**
 * Reads the mesh section of a version 2 file (already decompressed).
 *
 * @param {Uint8Array} bytes The section.
 * @returns {PolyDoc} The document.
 * @throws {Error} 'snapshotinvalid: …' for anything but a valid document.
 */
function readMesh(bytes) {
    try {
        return parseDoc(bytes);
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        throw new Error(message.indexOf('snapshotinvalid') === 0 ? message : 'snapshotinvalid: bad mesh: ' + message);
    }
}

/**
 * Reads a VRSC snapshot (version 1 or 2) into a new grid and mesh document.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes The file.
 * @returns {Promise<{grid: Grid, mesh: PolyDoc, seq: number, epoch: string, header: object}>} The grid, the
 *     mesh (empty for a version 1 file), the seq, the epoch ('' when none) and the parsed header.
 * @throws {Error} 'snapshotinvalid: …' for anything but a valid snapshot.
 */
export async function readSnapshot(bytes) {
    const u8 = asBytes(bytes);
    const h = header(u8);
    const count = h.nx * h.ny * h.nz;
    let gridSection = u8.subarray(h.gridOffset, h.gridOffset + h.gridLength);
    if (h.compressed) {
        gridSection = await inflate(gridSection, count);
    }
    if (gridSection.length !== count) {
        throw new Error('snapshotinvalid: payload does not match the dimensions');
    }
    let mesh;
    if (h.version === VERSION_CLAY) {
        mesh = new PolyDoc();
    } else {
        let meshSection = u8.subarray(h.meshOffset);
        if (meshSection.length > MAX_MESH_BYTES) {
            throw new Error('snapshotinvalid: a section is larger than it can be');
        }
        if (h.compressed) {
            meshSection = await inflate(meshSection, MAX_MESH_BYTES);
        }
        mesh = readMesh(meshSection);
    }
    const grid = new Grid(h.nx, h.ny, h.nz, h.voxel, h.band);
    const q = new Int8Array(gridSection.buffer, gridSection.byteOffset, count);
    const {data, levels} = grid;
    for (let n = 0; n < count; n++) {
        let v = q[n];
        v = v < -QMAX ? -QMAX : v;
        data[n] = levels[v + QMAX];
    }
    return {grid, mesh, seq: h.seq, epoch: h.epoch, header: h};
}
