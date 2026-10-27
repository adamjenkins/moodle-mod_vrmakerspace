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
 * Tests of the VRSC v1 snapshot format (js/engine/snapshot.js).
 *
 * Run from the repository root: node --test tests/js/snapshot.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {header, readSnapshot, writeSnapshot, HEADER_BYTES} from '../../js/engine/snapshot.js';
import {Grid} from '../../js/engine/grid.js';
import {fillModel} from '../../js/engine/models.js';

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

test('a compressed snapshot round-trips losslessly with its header fields', async() => {
    const grid = makeGrid();
    const bytes = await writeSnapshot(grid, 4321, '00ff00ff00ff00ff');
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'VRSC');
    const h = header(bytes);
    assert.equal(h.version, 1);
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

    const r = await readSnapshot(bytes);
    assert.equal(r.seq, 4321);
    assert.equal(r.epoch, '00ff00ff00ff00ff');
    assert.ok(r.grid.sameShape(grid));
    assert.deepEqual(r.grid.data, grid.data, 'lossless');
    // An ArrayBuffer works as well as a Uint8Array.
    const again = await readSnapshot(bytes.slice().buffer);
    assert.deepEqual(again.grid.data, grid.data);
});

test('an uncompressed snapshot stores one Int8 level per voxel, x fastest', async() => {
    const grid = makeGrid();
    const bytes = await writeSnapshot(grid, 0, '', {compress: false});
    const h = header(bytes);
    assert.equal(h.flags, 0);
    assert.equal(h.epoch, '');
    assert.deepEqual(Array.from(bytes.subarray(28, 44)), new Array(16).fill(0));
    assert.equal(bytes.length, 48 + 32 * 24 * 40);
    const q = new Int8Array(bytes.buffer, bytes.byteOffset + 48);
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
        'bad version': tamper(good, (dv) => dv.setUint16(4, 2, true)),
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
        'corrupt deflate stream': tamper(good, (dv, u8) => u8.fill(0xff, 48)),
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
