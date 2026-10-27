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
 * Snapshot file format "VRSC" version 1 (little-endian).
 *
 *  0  4 bytes  ASCII "VRSC"
 *  4  u16      format version = 1
 *  6  u16      flags: bit 0 = payload is deflate-raw compressed; other bits 0
 *  8  u16 ×3   nx, ny, nz (each 8..256)
 * 14  u16      reserved 0
 * 16  f32      voxel size in metres (0.0005..0.05)
 * 20  f32      band in metres (> 0)
 * 24  u32      seq: the confirmed op sequence number the data reflects
 * 28  16 bytes epoch: ASCII [0-9a-f]{16}, or 16 zero bytes
 * 44  u32      payload length = file length − 48
 * 48  payload  Int8 per voxel, x fastest then y then z; d = q / 127 × band (after decompression)
 *
 * The engine's grid only ever holds those 255 levels (grid.js), so writing and reading back is
 * lossless. Compression uses CompressionStream('deflate-raw'); where it is missing the payload is
 * written uncompressed (flags 0).
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/snapshot
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {Grid, QMAX} from './grid.js';
import {canon} from './mathx.js';

/** File magic. */
export const MAGIC = 'VRSC';

/** Format version. */
export const VERSION = 1;

/** Header size in bytes. */
export const HEADER_BYTES = 48;

/** Flag: the payload is deflate-raw compressed. */
export const FLAG_DEFLATE = 1;

/** Dimension range per axis. */
export const MIN_DIM = 8;
export const MAX_DIM = 256;

/** Voxel size range in metres. */
export const MIN_VOXEL = 0.0005;
export const MAX_VOXEL = 0.05;

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
 *     voxel: number, band: number, seq: number, epoch: string, payloadLength: number}} Header fields;
 *     voxel and band canonicalised to 7 decimals, epoch '' for 16 zero bytes.
 * @throws {Error} 'snapshotinvalid: …' when the header is not a valid VRSC v1 header.
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
    if (version !== VERSION) {
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
    if (!compressed && payloadLength !== nx * ny * nz) {
        throw new Error('snapshotinvalid: payload does not match the dimensions');
    }
    return {version, flags, compressed, nx, ny, nz, voxel: canon(voxel), band: canon(band), seq, epoch,
        payloadLength};
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
 * Inflates deflate-raw bytes.
 *
 * @param {Uint8Array} u8 Compressed bytes.
 * @returns {Promise<Uint8Array>} Decompressed bytes.
 * @throws {Error} When the platform cannot decompress or the data is corrupt.
 */
async function inflate(u8) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('snapshotinvalid: this browser cannot decompress snapshots');
    }
    try {
        return await pipe(u8, new DecompressionStream('deflate-raw'));
    } catch (e) {
        throw new Error('snapshotinvalid: corrupt payload');
    }
}

/**
 * Writes a grid as a VRSC v1 snapshot.
 *
 * The voxel payload is built synchronously when this is called (before the first await), so the
 * snapshot reflects the grid at the moment of the call even if the grid changes while it compresses.
 *
 * @param {Grid} grid The grid.
 * @param {number} seq Confirmed op sequence number the data reflects (0..2^32 − 1).
 * @param {string} epoch 16 hex characters, or '' for none.
 * @param {{compress: (boolean|undefined)}} [options] compress: false writes the payload uncompressed.
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
    const plain = new Uint8Array(raw.buffer);
    let payload = plain;
    let flags = 0;
    if (options.compress !== false) {
        const packed = await deflate(plain);
        if (packed) {
            payload = packed;
            flags = FLAG_DEFLATE;
        }
    }
    dv.setUint16(6, flags, true);
    dv.setUint32(44, payload.length, true);
    const out = new Uint8Array(HEADER_BYTES + payload.length);
    out.set(head, 0);
    out.set(payload, HEADER_BYTES);
    return out;
}

/**
 * Reads a VRSC v1 snapshot into a new grid.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes The file.
 * @returns {Promise<{grid: Grid, seq: number, epoch: string, header: object}>} The grid, its seq,
 *     its epoch ('' when none) and the parsed header.
 * @throws {Error} 'snapshotinvalid: …' for anything but a valid snapshot.
 */
export async function readSnapshot(bytes) {
    const u8 = asBytes(bytes);
    const h = header(u8);
    const count = h.nx * h.ny * h.nz;
    let payload = u8.subarray(HEADER_BYTES);
    if (h.compressed) {
        payload = await inflate(payload);
    }
    if (payload.length !== count) {
        throw new Error('snapshotinvalid: payload does not match the dimensions');
    }
    const grid = new Grid(h.nx, h.ny, h.nz, h.voxel, h.band);
    const q = new Int8Array(payload.buffer, payload.byteOffset, count);
    const {data, levels} = grid;
    for (let n = 0; n < count; n++) {
        let v = q[n];
        v = v < -QMAX ? -QMAX : v;
        data[n] = levels[v + QMAX];
    }
    return {grid, seq: h.seq, epoch: h.epoch, header: h};
}
