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
 * Tests of the STL, glTF binary and 3MF writers, the zip writer and the mesh check (node --test).
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import {toSTL, toGLB, to3MF} from '../../js/engine/export.js';
import {check} from '../../js/engine/validate.js';
import {crc32, createZip} from '../../js/engine/zip.js';

/**
 * A closed box of 0.1 × 0.2 × 0.3 m (x, y, z) centred at the origin, wound outward.
 *
 * Vertex v has x bit 0, y bit 1, z bit 2.
 *
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} The mesh.
 */
function box() {
    const positions = new Float32Array(24);
    const normals = new Float32Array(24);
    for (let v = 0; v < 8; v++) {
        const x = (v & 1) - 0.5;
        const y = ((v >> 1) & 1) - 0.5;
        const z = ((v >> 2) & 1) - 0.5;
        positions.set([x * 0.1, y * 0.2, z * 0.3], v * 3);
        const len = Math.sqrt(x * x + y * y + z * z);
        normals.set([x / len, y / len, z / len], v * 3);
    }
    const indices = Uint32Array.from([
        0, 4, 6, 0, 6, 2, // Face -x.
        1, 3, 7, 1, 7, 5, // Face +x.
        0, 1, 5, 0, 5, 4, // Face -y.
        2, 6, 7, 2, 7, 3, // Face +y.
        0, 2, 3, 0, 3, 1, // Face -z.
        4, 5, 7, 4, 7, 6, // Face +z.
    ]);
    return {positions, normals, indices};
}

/**
 * Checks that an XML document is well-formed (enough for the 3MF parts) and lists its elements.
 *
 * @param {string} xml The document.
 * @returns {Array<{name: string, attrs: object}>} Every start or empty element in document order.
 */
function parseXml(xml) {
    const rest = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
    assert.ok(rest.length < xml.length, 'XML declaration present');
    const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>|([^<]+)/y;
    const stack = [];
    const elements = [];
    let roots = 0;
    let at = 0;
    while (at < rest.length) {
        token.lastIndex = at;
        const m = token.exec(rest);
        assert.ok(m, 'malformed XML near: ' + rest.slice(at, at + 40));
        at = token.lastIndex;
        if (m[5] !== undefined) {
            assert.ok(stack.length > 0 || m[5].trim() === '', 'text outside the root');
            assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(m[5]), 'bad entity');
            continue;
        }
        if (m[1] === '/') {
            assert.equal(stack.pop(), m[2], 'mismatched end tag ' + m[2]);
            continue;
        }
        if (stack.length === 0) {
            roots++;
        }
        const attrs = {};
        for (const a of m[3].matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) {
            assert.ok(!(a[1] in attrs), 'duplicate attribute');
            attrs[a[1]] = a[2];
        }
        elements.push({name: m[2], attrs});
        if (m[4] !== '/') {
            stack.push(m[2]);
        }
    }
    assert.equal(stack.length, 0, 'unclosed elements');
    assert.equal(roots, 1, 'one root element');
    return elements;
}

/**
 * Reads a zip archive by its central directory and checks every header against it.
 *
 * @param {Uint8Array} bytes The archive.
 * @returns {Map<string, Uint8Array>} Entry name to data.
 */
function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22;
    assert.equal(dv.getUint32(eocd, true), 0x06054B50, 'end of central directory signature');
    const count = dv.getUint16(eocd + 10, true);
    assert.equal(dv.getUint16(eocd + 8, true), count);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdStart = dv.getUint32(eocd + 16, true);
    assert.equal(cdStart + cdSize, eocd, 'central directory ends at the end record');
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const out = new Map();
    let o = cdStart;
    for (let n = 0; n < count; n++) {
        assert.equal(dv.getUint32(o, true), 0x02014B50, 'central header signature');
        const flags = dv.getUint16(o + 8, true);
        assert.equal(flags & 0x0800, 0x0800, 'UTF-8 names flag');
        assert.equal(dv.getUint16(o + 10, true), 0, 'stored');
        const crc = dv.getUint32(o + 16, true);
        const csize = dv.getUint32(o + 20, true);
        const usize = dv.getUint32(o + 24, true);
        assert.equal(csize, usize);
        const nameLen = dv.getUint16(o + 28, true);
        const extraLen = dv.getUint16(o + 30, true);
        const commentLen = dv.getUint16(o + 32, true);
        const local = dv.getUint32(o + 42, true);
        const name = decoder.decode(bytes.subarray(o + 46, o + 46 + nameLen));
        o += 46 + nameLen + extraLen + commentLen;

        assert.equal(dv.getUint32(local, true), 0x04034B50, 'local header signature');
        assert.equal(dv.getUint16(local + 6, true), flags);
        assert.equal(dv.getUint16(local + 8, true), 0);
        assert.equal(dv.getUint32(local + 14, true), crc);
        assert.equal(dv.getUint32(local + 18, true), csize);
        assert.equal(dv.getUint32(local + 22, true), usize);
        const lnameLen = dv.getUint16(local + 26, true);
        const lextraLen = dv.getUint16(local + 28, true);
        assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + lnameLen)), name);
        const start = local + 30 + lnameLen + lextraLen;
        const data = bytes.subarray(start, start + usize);
        assert.equal(crc32(data), crc, 'CRC of ' + name);
        if (typeof zlib.crc32 === 'function') {
            assert.equal(zlib.crc32(data) >>> 0, crc, 'CRC of ' + name + ' matches zlib');
        }
        out.set(name, data);
    }
    assert.equal(o, eocd);
    return out;
}

test('CRC-32 matches the standard check value', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
    const all = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    assert.equal(crc32(all.subarray(10), crc32(all.subarray(0, 10))), crc32(all));
    assert.equal(crc32(all), 0x414FA339);
});

test('the zip writer stores UTF-8 names and refuses bad ones', () => {
    const zip = createZip([{name: 'a/ü.txt', data: 'grüß'}, {name: 'b.bin', data: new Uint8Array([1, 2, 3])}],
        {date: new Date(2026, 9, 27, 12, 30, 10)});
    const files = readZip(zip);
    assert.deepEqual([...files.keys()], ['a/ü.txt', 'b.bin']);
    assert.equal(new TextDecoder().decode(files.get('a/ü.txt')), 'grüß');
    const dv = new DataView(zip.buffer);
    assert.equal(dv.getUint16(10, true), (12 << 11) | (30 << 5) | 5);
    assert.equal(dv.getUint16(12, true), ((2026 - 1980) << 9) | (10 << 5) | 27);
    assert.throws(() => createZip([{name: 'x', data: ''}, {name: 'x', data: ''}]));
    assert.throws(() => createZip([{name: '/abs', data: ''}]));
});

test('the box checks watertight with the right print size and volume', () => {
    const report = check(box());
    assert.equal(report.triangles, 12);
    assert.equal(report.vertices, 8);
    assert.equal(report.boundaryedges, 0);
    assert.equal(report.nonmanifoldedges, 0);
    assert.equal(report.watertight, true);
    // Print orientation is Z up: sculpture y (0.2 m) becomes print z, sculpture z (0.3 m) print y.
    assert.deepEqual(report.sizemm, [100, 300, 200]);
    assert.ok(Math.abs(report.volumemm3 - 6e6) < 1, 'volume ' + report.volumemm3);
});

test('an open mesh reports its boundary edges and is not watertight', () => {
    const mesh = box();
    mesh.indices = mesh.indices.slice(0, 33);
    const report = check(mesh);
    assert.equal(report.triangles, 11);
    assert.equal(report.boundaryedges, 3);
    assert.equal(report.nonmanifoldedges, 0);
    assert.equal(report.watertight, false);

    const doubled = box();
    doubled.indices = Uint32Array.from([...doubled.indices, 1, 3, 7]);
    const second = check(doubled);
    assert.ok(second.nonmanifoldedges >= 1);
    assert.equal(second.watertight, false);

    const flipped = box();
    flipped.indices[1] = 6;
    flipped.indices[2] = 4;
    const third = check(flipped);
    assert.ok(third.flippededges > 0);
    assert.equal(third.watertight, false);

    assert.equal(check({positions: new Float32Array(0), indices: new Uint32Array(0)}).watertight, false);
});

test('STL: header, triangle count, millimetres and Z up', () => {
    const stl = toSTL(box());
    assert.equal(stl.length, 84 + 50 * 12);
    const head = new TextDecoder().decode(stl.subarray(0, 5));
    assert.notEqual(head.toLowerCase(), 'solid');
    const dv = new DataView(stl.buffer);
    assert.equal(dv.getUint32(80, true), 12);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < 12; t++) {
        const o = 84 + t * 50;
        for (let v = 0; v < 3; v++) {
            for (let a = 0; a < 3; a++) {
                const value = dv.getFloat32(o + 12 + v * 12 + a * 4, true);
                min[a] = Math.min(min[a], value);
                max[a] = Math.max(max[a], value);
            }
        }
        assert.equal(dv.getUint16(o + 48, true), 0);
    }
    assert.deepEqual(max.map((v, a) => Math.round(v - min[a])), [100, 300, 200]);
    // Triangle 2 lies on face +x: its print normal is +x. Triangle 6 lies on +y (up): print +z.
    const normal = (t) => [0, 1, 2].map((a) => Math.round(dv.getFloat32(84 + t * 50 + a * 4, true) * 1000) / 1000 + 0);
    assert.deepEqual(normal(2), [1, 0, 0]);
    assert.deepEqual(normal(6), [0, 0, 1]);
    assert.deepEqual(normal(8), [0, 1, 0]);
});

test('GLB: header, JSON chunk, binary chunk, lengths and alignment', () => {
    const mesh = box();
    const glb = toGLB(mesh);
    const dv = new DataView(glb.buffer);
    assert.equal(dv.getUint32(0, true), 0x46546C67);
    assert.equal(new TextDecoder().decode(glb.subarray(0, 4)), 'glTF');
    assert.equal(dv.getUint32(4, true), 2);
    assert.equal(dv.getUint32(8, true), glb.length);
    assert.equal(glb.length % 4, 0);
    const jsonLen = dv.getUint32(12, true);
    assert.equal(jsonLen % 4, 0);
    assert.equal(dv.getUint32(16, true), 0x4E4F534A);
    const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
    assert.equal(gltf.asset.version, '2.0');
    assert.equal(gltf.asset.generator, 'mod_vrsculpt');
    const binAt = 20 + jsonLen;
    const binLen = dv.getUint32(binAt, true);
    assert.equal(binLen % 4, 0);
    assert.equal(dv.getUint32(binAt + 4, true), 0x004E4942);
    assert.equal(binAt + 8 + binLen, glb.length);
    assert.ok(gltf.buffers[0].byteLength <= binLen);
    assert.equal(gltf.buffers[0].byteLength, 8 * 12 * 2 + 36 * 4);

    const prim = gltf.meshes[0].primitives[0];
    const pos = gltf.accessors[prim.attributes.POSITION];
    const nor = gltf.accessors[prim.attributes.NORMAL];
    const idx = gltf.accessors[prim.indices];
    assert.equal(pos.componentType, 5126);
    assert.equal(pos.type, 'VEC3');
    assert.equal(pos.count, 8);
    assert.deepEqual(pos.min, [Math.fround(-0.05), Math.fround(-0.1), Math.fround(-0.15)]);
    assert.deepEqual(pos.max, [Math.fround(0.05), Math.fround(0.1), Math.fround(0.15)]);
    assert.equal(nor.count, 8);
    assert.equal(idx.componentType, 5125);
    assert.equal(idx.type, 'SCALAR');
    assert.equal(idx.count, 36);
    for (const view of gltf.bufferViews) {
        assert.equal(view.byteOffset % 4, 0);
        assert.ok(view.byteOffset + view.byteLength <= gltf.buffers[0].byteLength);
    }
    const posView = gltf.bufferViews[pos.bufferView];
    const readPos = new Float32Array(glb.buffer.slice(binAt + 8 + posView.byteOffset,
        binAt + 8 + posView.byteOffset + posView.byteLength));
    assert.deepEqual(Array.from(readPos), Array.from(mesh.positions));
    const idxView = gltf.bufferViews[idx.bufferView];
    const readIdx = new Uint32Array(glb.buffer.slice(binAt + 8 + idxView.byteOffset,
        binAt + 8 + idxView.byteOffset + idxView.byteLength));
    assert.deepEqual(Array.from(readIdx), Array.from(mesh.indices));

    const empty = toGLB({positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0)});
    const edv = new DataView(empty.buffer);
    assert.equal(edv.getUint32(8, true), empty.length);
    assert.equal(empty.length, 20 + edv.getUint32(12, true));
    assert.equal(JSON.parse(new TextDecoder().decode(empty.subarray(20)).trim()).asset.generator, 'mod_vrsculpt');
});

test('3MF: zip structure, CRCs and a parsable millimetre model', () => {
    const bytes = to3MF(box(), {name: 'Clay & co', date: new Date(2026, 0, 2, 3, 4, 6)});
    const files = readZip(bytes);
    assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const text = (name) => new TextDecoder('utf-8', {fatal: true}).decode(files.get(name));

    const types = parseXml(text('[Content_Types].xml'));
    assert.equal(types[0].name, 'Types');
    const extensions = types.filter((e) => e.name === 'Default').map((e) => e.attrs.Extension);
    assert.deepEqual(extensions.sort(), ['model', 'rels']);

    const rels = parseXml(text('_rels/.rels'));
    const rel = rels.find((e) => e.name === 'Relationship');
    assert.equal(rel.attrs.Target, '/3D/3dmodel.model');
    assert.equal(rel.attrs.Type, 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel');

    const model = parseXml(text('3D/3dmodel.model'));
    assert.equal(model[0].name, 'model');
    assert.equal(model[0].attrs.unit, 'millimeter');
    assert.equal(model[0].attrs.xmlns, 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02');
    const vertices = model.filter((e) => e.name === 'vertex');
    const triangles = model.filter((e) => e.name === 'triangle');
    assert.equal(vertices.length, 8);
    assert.equal(triangles.length, 12);
    // Vertex 0 is (-0.05, -0.1, -0.15) m: print (x, -z, y) mm.
    assert.deepEqual([vertices[0].attrs.x, vertices[0].attrs.y, vertices[0].attrs.z].map(Number), [-50, 150, -100]);
    assert.deepEqual([triangles[0].attrs.v1, triangles[0].attrs.v2, triangles[0].attrs.v3].map(Number), [0, 4, 6]);
    const object = model.find((e) => e.name === 'object');
    assert.equal(object.attrs.name, 'Clay &amp; co');
    assert.equal(model.find((e) => e.name === 'item').attrs.objectid, object.attrs.id);
});
