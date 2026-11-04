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
 * Tests of the VRSC snapshot format, version 2 and the older version 1 (js/engine/snapshot.js).
 *
 * Run from the repository root: node --test tests/js/snapshot.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {header, readSnapshot, writeSnapshot, HEADER_BYTES, MAX_MESH_BYTES} from '../../js/engine/snapshot.js';
import {Grid} from '../../js/engine/grid.js';
import {fillModel} from '../../js/engine/models.js';
import {PolyDoc, serializeDoc} from '../../js/engine/polymesh.js';
import {addPrimitive} from '../../js/engine/polyprims.js';

/**
 * A lump on a small grid (32 × 24 × 40 voxels of 6 mm, band 18 mm).
 *
 * @returns {Grid} The grid.
 */
const makeGrid = () => fillModel(new Grid(32, 24, 40, 0.006, 0.018), 'lump');

/**
 * A copy of a file with some bytes changed.
 *
 * @param {Uint8Array} bytes File.
 * @param {function(DataView, Uint8Array): void} change Changes the copy.
 * @returns {Uint8Array} The changed copy.
 */
function tamper(bytes, change) {
    const copy = bytes.slice();
    change(new DataView(copy.buffer), copy);
    return copy;
}

/**
 * Runs bytes through a compression stream.
 *
 * @param {Uint8Array} u8 Input.
 * @returns {Promise<Uint8Array>} Deflate-raw bytes.
 */
async function deflate(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A version 1 file (no gridLength, no mesh section) of a grid, as older versions of the plugin wrote it.
 *
 * @param {Grid} grid The grid.
 * @param {number} seq Sequence number.
 * @param {string} epoch Epoch or ''.
 * @param {boolean} compress Whether to deflate the voxels.
 * @returns {Promise<Uint8Array>} The file.
 */
async function versionOne(grid, seq, epoch, compress) {
    const v2 = await writeSnapshot(grid, seq, epoch, {compress: false});
    const count = grid.nx * grid.ny * grid.nz;
    const voxels = v2.subarray(52, 52 + count);
    const payload = compress ? await deflate(voxels) : voxels;
    const out = new Uint8Array(48 + payload.length);
    out.set(v2.subarray(0, 48), 0);
    out.set(payload, 48);
    const dv = new DataView(out.buffer);
    dv.setUint16(4, 1, true);
    dv.setUint16(6, compress ? 1 : 0, true);
    dv.setUint32(44, payload.length, true);
    return out;
}

/**
 * A copy of an uncompressed version 2 file with another mesh section.
 *
 * @param {Uint8Array} plain An uncompressed version 2 file.
 * @param {string} text The new mesh section.
 * @returns {Uint8Array} The file.
 */
function withMesh(plain, text) {
    const h = header(plain);
    const section = new TextEncoder().encode(text);
    const out = new Uint8Array(h.meshOffset + section.length);
    out.set(plain.subarray(0, h.meshOffset), 0);
    out.set(section, h.meshOffset);
    new DataView(out.buffer).setUint32(44, out.length - 48, true);
    return out;
}

/**
 * A small mesh document with a cube and one person's selection.
 *
 * @returns {PolyDoc} The document.
 */
function makeDoc() {
    const doc = new PolyDoc();
    const faces = addPrimitive(doc, 'cube', 'u1', 1, [0.01, 0.02, 0.03], 0.05, null, 0, 16);
    doc.sel.set('u1', {md: 'f', items: faces.slice(0, 2)});
    return doc;
}

test('a compressed snapshot round-trips losslessly with its header fields', async() => {
    const grid = makeGrid();
    const bytes = await writeSnapshot(grid, 4321, '00ff00ff00ff00ff');
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'VRSC');
    const h = header(bytes);
    assert.equal(h.version, 2);
    assert.equal(h.flags, 1, 'deflate-raw is available in Node');
    assert.equal(h.compressed, true);
    assert.deepEqual([h.nx, h.ny, h.nz], [32, 24, 40]);
    assert.equal(h.voxel, 0.006);
    assert.equal(h.band, 0.018);
    assert.equal(h.seq, 4321);
    assert.equal(h.epoch, '00ff00ff00ff00ff');
    assert.equal(h.payloadLength, bytes.length - HEADER_BYTES);
    assert.ok(h.payloadLength < 32 * 24 * 40, 'the payload is compressed');
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    assert.equal(dv.getUint16(14, true), 0, 'reserved');
    assert.equal(dv.getUint32(44, true), bytes.length - 48);
    assert.equal(dv.getUint32(48, true), h.gridLength, 'the payload starts with the grid section length');
    assert.equal(h.gridOffset, 52);
    assert.equal(h.meshOffset, 52 + h.gridLength);
    assert.equal(h.meshLength, bytes.length - h.meshOffset);

    const r = await readSnapshot(bytes);
    assert.equal(r.seq, 4321);
    assert.equal(r.epoch, '00ff00ff00ff00ff');
    assert.ok(r.grid.sameShape(grid));
    assert.deepEqual(r.grid.data, grid.data, 'lossless');
    assert.equal(r.mesh.verts.size, 0, 'no mesh given: an empty one');
    assert.equal(r.mesh.faces.size, 0);
    // An ArrayBuffer works as well as a Uint8Array.
    const again = await readSnapshot(bytes.slice().buffer);
    assert.deepEqual(again.grid.data, grid.data);
});

test('an uncompressed snapshot stores gridLength, one Int8 level per voxel, x fastest, then the mesh', async() => {
    const grid = makeGrid();
    const bytes = await writeSnapshot(grid, 0, '', {compress: false});
    const h = header(bytes);
    assert.equal(h.flags, 0);
    assert.equal(h.epoch, '');
    assert.deepEqual(Array.from(bytes.subarray(28, 44)), new Array(16).fill(0));
    assert.equal(h.gridLength, 32 * 24 * 40);
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(48, true), 32 * 24 * 40);
    const empty = serializeDoc(new PolyDoc());
    assert.equal(bytes.length, 52 + 32 * 24 * 40 + empty.length);
    assert.deepEqual(bytes.subarray(52 + 32 * 24 * 40), empty, 'the mesh section is serializeDoc output');
    const q = new Int8Array(bytes.buffer, bytes.byteOffset + 52, 32 * 24 * 40);
    const idx = grid.index(5, 7, 9);
    assert.equal(grid.levels[q[idx] + 127], grid.data[idx]);
    assert.equal(q[0], 127, 'the corner is +band');
    const r = await readSnapshot(bytes);
    assert.deepEqual(r.grid.data, grid.data);
});

test('bad files are refused', async() => {
    const good = await writeSnapshot(makeGrid(), 1, 'abcdefabcdef0123');
    const goodPlain = await writeSnapshot(makeGrid(), 1, '', {compress: false});
    const bad = {
        'bad magic': tamper(good, (dv, u8) => {
            u8[0] = 0x58;
        }),
        'version 0': tamper(good, (dv) => dv.setUint16(4, 0, true)),
        'a future version': tamper(good, (dv) => dv.setUint16(4, 3, true)),
        'version 2 read as version 1': tamper(goodPlain, (dv) => dv.setUint16(4, 1, true)),
        'unknown flags': tamper(good, (dv) => dv.setUint16(6, 3, true)),
        'dimension too small': tamper(good, (dv) => dv.setUint16(8, 7, true)),
        'dimension too large': tamper(good, (dv) => dv.setUint16(12, 257, true)),
        'voxel too small': tamper(good, (dv) => dv.setFloat32(16, 0.0001, true)),
        'voxel too large': tamper(good, (dv) => dv.setFloat32(16, 0.1, true)),
        'band not positive': tamper(good, (dv) => dv.setFloat32(20, 0, true)),
        'bad epoch': tamper(good, (dv, u8) => {
            u8[30] = 0x47;
        }),
        'payload length': tamper(good, (dv) => dv.setUint32(44, 5, true)),
        'truncated': good.slice(0, good.length - 1),
        'too short': good.slice(0, 20),
        'plain payload does not match the dimensions': tamper(goodPlain, (dv) => dv.setUint16(8, 33, true)),
        'grid length beyond the payload': tamper(good, (dv, u8) => dv.setUint32(48, u8.length - 51, true)),
        'plain grid length does not match the dimensions': tamper(goodPlain, (dv) => dv.setUint32(48, 100, true)),
        'corrupt grid stream': tamper(good, (dv, u8) => u8.fill(0xff, 52, 52 + header(good).gridLength)),
        'corrupt mesh stream': tamper(good, (dv, u8) => u8.fill(0xff, header(good).meshOffset)),
        'no room for a grid length': tamper(good.slice(0, 50), (dv) => dv.setUint32(44, 2, true)),
    };
    for (const [name, bytes] of Object.entries(bad)) {
        await assert.rejects(readSnapshot(bytes), /snapshotinvalid/, name);
    }
    assert.throws(() => header(bad['bad magic']), /snapshotinvalid: bad magic/);
    assert.throws(() => header(bad['dimension too small']), /snapshotinvalid: bad dimensions/);
    await assert.rejects(readSnapshot('VRSC'), /snapshotinvalid/);
});

test('the header can be read without decompressing', async() => {
    const bytes = await writeSnapshot(makeGrid(), 77, '0000000000000001');
    const h = header(bytes.subarray(0));
    assert.equal(h.seq, 77);
    assert.equal(h.epoch, '0000000000000001');
});

test('the mesh section round-trips byte for byte, selections and Map order included', async() => {
    const doc = makeDoc();
    const text = serializeDoc(doc);
    for (const compress of [true, false]) {
        const bytes = await writeSnapshot(makeGrid(), 5, '', {compress, mesh: doc});
        const r = await readSnapshot(bytes);
        assert.deepEqual(serializeDoc(r.mesh), text);
        assert.deepEqual(Array.from(r.mesh.verts.keys()), Array.from(doc.verts.keys()));
        assert.deepEqual(Array.from(r.mesh.faces.keys()), Array.from(doc.faces.keys()));
        assert.deepEqual(r.mesh.selectionOf('u1'), doc.selectionOf('u1'));
        assert.equal(r.mesh.rec, null);
    }
});

test('the sections reflect the state when writing was called, not when compressing ended', async() => {
    const doc = makeDoc();
    const text = serializeDoc(doc);
    const grid = makeGrid();
    const values = grid.data.slice();
    const writing = writeSnapshot(grid, 5, '', {mesh: doc});
    Array.from(doc.faces.keys()).forEach((id) => doc.delFace(id));
    grid.data.fill(grid.levels[0]);
    const r = await readSnapshot(await writing);
    assert.deepEqual(serializeDoc(r.mesh), text);
    assert.deepEqual(r.grid.data, values);
});

test('version 1 files are still read, with an empty mesh', async() => {
    const grid = makeGrid();
    for (const compress of [false, true]) {
        const bytes = await versionOne(grid, 9, '00ff00ff00ff00ff', compress);
        const h = header(bytes);
        assert.equal(h.version, 1);
        assert.equal(h.gridOffset, 48);
        assert.equal(h.gridLength, bytes.length - 48);
        assert.equal(h.meshLength, 0);
        const r = await readSnapshot(bytes);
        assert.equal(r.seq, 9);
        assert.equal(r.epoch, '00ff00ff00ff00ff');
        assert.deepEqual(r.grid.data, grid.data);
        assert.equal(r.mesh.verts.size, 0);
        assert.equal(r.mesh.faces.size, 0);
        assert.deepEqual(r.mesh.selectionOf('u1').items, []);
    }
    const plain = await versionOne(grid, 9, '', false);
    await assert.rejects(readSnapshot(tamper(plain, (dv) => dv.setUint16(8, 33, true))), /snapshotinvalid/);
});

test('a bad mesh section is refused as an invalid snapshot', async() => {
    const plain = await writeSnapshot(makeGrid(), 1, '', {compress: false});
    const bad = {
        'empty section': '',
        'not JSON': 'this is not a mesh',
        'not an object': '[]',
        'missing parts': '{"v":[]}',
        'coordinate out of range': '{"v":[[1,0.5,0,0]],"f":[],"s":[]}',
        'coordinate not a number': '{"v":[[1,"0",0,0]],"f":[],"s":[]}',
        'id not a safe integer': '{"v":[[9007199254740992,0,0,0]],"f":[],"s":[]}',
        'negative id': '{"v":[[-1,0,0,0]],"f":[],"s":[]}',
        'repeated vertex id': '{"v":[[1,0,0,0],[1,0.1,0,0]],"f":[],"s":[]}',
        'face with a missing vertex': '{"v":[[1,0,0,0],[2,0.1,0,0]],"f":[[5,[1,2,3]]],"s":[]}',
        'face with too few vertices': '{"v":[[1,0,0,0],[2,0.1,0,0]],"f":[[5,[1,2]]],"s":[]}',
        'face with a repeated vertex': '{"v":[[1,0,0,0],[2,0.1,0,0],[3,0,0.1,0]],"f":[[5,[1,2,1]]],"s":[]}',
        'bad selection mode': '{"v":[],"f":[],"s":[["u1","q",[]]]}',
        'bad selection author': '{"v":[],"f":[],"s":[["not an author!","v",[]]]}',
    };
    for (const [name, text] of Object.entries(bad)) {
        await assert.rejects(readSnapshot(withMesh(plain, text)), /snapshotinvalid/, name);
    }
    // Sanity: the same route accepts a good section.
    const good = await readSnapshot(withMesh(plain, '{"v":[[1,0,0,0],[2,0.1,0,0],[3,0,0.1,0]],"f":[[5,[1,2,3]]],"s":[]}'));
    assert.equal(good.mesh.faces.size, 1);
});

test('a section that decompresses to more than it can hold is refused', async() => {
    const good = await writeSnapshot(makeGrid(), 1, '');
    const h = header(good);
    const bomb = await deflate(new Uint8Array(MAX_MESH_BYTES + 1));
    const big = new Uint8Array(h.meshOffset + bomb.length);
    big.set(good.subarray(0, h.meshOffset), 0);
    big.set(bomb, h.meshOffset);
    new DataView(big.buffer).setUint32(44, big.length - 48, true);
    await assert.rejects(readSnapshot(big), /snapshotinvalid/, 'mesh section');
    // A grid section one voxel too long.
    const longer = await deflate(new Uint8Array(32 * 24 * 40 + 1));
    const mesh = good.subarray(h.meshOffset);
    const file = new Uint8Array(52 + longer.length + mesh.length);
    file.set(good.subarray(0, 48), 0);
    file.set(longer, 52);
    file.set(mesh, 52 + longer.length);
    const dv = new DataView(file.buffer);
    dv.setUint32(44, file.length - 48, true);
    dv.setUint32(48, longer.length, true);
    await assert.rejects(readSnapshot(file), /snapshotinvalid/, 'grid section');
});
