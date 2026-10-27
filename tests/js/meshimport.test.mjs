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
 * Tests of uploaded starting models: STL, OBJ and glTF binary read, fitted and voxelised the same way
 * on every client.
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../js/engine/engine.js';
import {Grid} from '../../js/engine/grid.js';
import {FIT, fillUpload, parseModel} from '../../js/engine/meshimport.js';
import {meshManifold} from '../../js/engine/tetmesh.js';
import {check} from '../../js/engine/validate.js';

/**
 * The triangles of a box with half-sizes (hx, hy, hz), wound counter-clockwise seen from outside.
 *
 * @param {number} hx Half-size along x.
 * @param {number} hy Half-size along y.
 * @param {number} hz Half-size along z.
 * @returns {number[][][]} Triangles of three [x, y, z] vertices.
 */
const box = (hx, hy, hz) => {
    const v = (i) => [i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz];
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const out = [];
    faces.forEach(([a, b, c, d]) => {
        out.push([v(a), v(b), v(c)], [v(a), v(c), v(d)]);
    });
    return out;
};

/**
 * The triangles of a UV sphere.
 *
 * @param {number} r Radius.
 * @param {number} rings Rings from pole to pole.
 * @param {number} segments Segments around.
 * @returns {number[][][]} Triangles.
 */
const uvSphere = (r, rings, segments) => {
    const p = (i, j) => {
        const t = Math.PI * i / rings;
        const f = 2 * Math.PI * j / segments;
        return [r * Math.sin(t) * Math.cos(f), r * Math.cos(t), r * Math.sin(t) * Math.sin(f)];
    };
    const out = [];
    for (let i = 0; i < rings; i++) {
        for (let j = 0; j < segments; j++) {
            const a = p(i, j);
            const b = p(i + 1, j);
            const c = p(i + 1, j + 1);
            const d = p(i, j + 1);
            if (i > 0) {
                out.push([a, d, c]);
            }
            if (i < rings - 1) {
                out.push([a, c, b]);
            }
        }
    }
    return out;
};

/**
 * An ASCII STL file of triangles given Y up (written Z up, as the export does: (x, y, z) → (x, −z, y)).
 *
 * @param {number[][][]} tris Triangles.
 * @returns {Uint8Array} The file.
 */
const asciiSTL = (tris) => {
    const lines = ['solid test'];
    tris.forEach((t) => {
        lines.push(' facet normal 0 0 0', '  outer loop');
        t.forEach(([x, y, z]) => lines.push(`   vertex ${x} ${-z} ${y}`));
        lines.push('  endloop', ' endfacet');
    });
    lines.push('endsolid test');
    return new TextEncoder().encode(lines.join('\n'));
};

/**
 * A binary STL file of triangles given Y up.
 *
 * @param {number[][][]} tris Triangles.
 * @returns {Uint8Array} The file.
 */
const binarySTL = (tris) => {
    const out = new Uint8Array(84 + tris.length * 50);
    const view = new DataView(out.buffer);
    view.setUint32(80, tris.length, true);
    tris.forEach((t, n) => {
        t.forEach(([x, y, z], v) => {
            const o = 84 + n * 50 + 12 + v * 12;
            view.setFloat32(o, x, true);
            view.setFloat32(o + 4, -z, true);
            view.setFloat32(o + 8, y, true);
        });
    });
    return out;
};

/**
 * An OBJ file of triangles, as indexed quads where two triangles make one (negative indices).
 *
 * @param {number[][][]} tris Triangles.
 * @returns {Uint8Array} The file.
 */
const objFile = (tris) => {
    const lines = ['# test', 'o test'];
    tris.forEach((t) => {
        t.forEach(([x, y, z]) => lines.push(`v ${x} ${y} ${z}`));
        lines.push('f -3/1/1 -2/1/1 -1/1/1');
    });
    return new TextEncoder().encode(lines.join('\r\n'));
};

/**
 * A glTF binary file: one indexed mesh under a parent node with the given transform.
 *
 * @param {number[][][]} tris Triangles.
 * @param {object} parent Node properties (translation, rotation, scale or matrix) of the parent node.
 * @param {string[]} [required] extensionsRequired.
 * @returns {Uint8Array} The file.
 */
const glbFile = (tris, parent, required) => {
    const positions = new Float32Array(tris.length * 9);
    const indices = new Uint16Array(tris.length * 3);
    tris.forEach((t, n) => t.forEach((p, v) => {
        positions.set(p, n * 9 + v * 3);
        indices[n * 3 + v] = n * 3 + v;
    }));
    const ibytes = indices.byteLength + (4 - indices.byteLength % 4) % 4;
    const bin = new Uint8Array(positions.byteLength + ibytes);
    bin.set(new Uint8Array(positions.buffer), 0);
    bin.set(new Uint8Array(indices.buffer), positions.byteLength);
    const json = {
        asset: {version: '2.0'},
        scene: 0,
        scenes: [{nodes: [0]}],
        nodes: [Object.assign({children: [1]}, parent), {mesh: 0, scale: [2, 2, 2]}],
        meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1}]}],
        buffers: [{byteLength: bin.byteLength}],
        bufferViews: [{buffer: 0, byteOffset: 0, byteLength: positions.byteLength},
            {buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength}],
        accessors: [{bufferView: 0, componentType: 5126, count: tris.length * 3, type: 'VEC3'},
            {bufferView: 1, componentType: 5123, count: tris.length * 3, type: 'SCALAR'}],
    };
    if (required) {
        json.extensionsRequired = required;
    }
    let text = new TextEncoder().encode(JSON.stringify(json));
    const pad = (4 - text.length % 4) % 4;
    text = new TextEncoder().encode(JSON.stringify(json) + ' '.repeat(pad));
    const out = new Uint8Array(12 + 8 + text.length + 8 + bin.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546C67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, out.length, true);
    view.setUint32(12, text.length, true);
    view.setUint32(16, 0x4E4F534A, true);
    out.set(text, 20);
    view.setUint32(20 + text.length, bin.length, true);
    view.setUint32(24 + text.length, 0x004E4942, true);
    out.set(bin, 28 + text.length);
    return out;
};

/**
 * A fresh test grid: 64 voxels of 8 mm (band 24 mm), as the export tests use.
 *
 * @returns {Grid} The grid.
 */
const grid = () => new Grid(64, 64, 64, 0.008, 0.024);

/**
 * Asserts that a grid holds a centred box of the given half-sizes: every voxel more than one voxel
 * inside is inside, every voxel more than one voxel outside is outside.
 *
 * @param {Grid} g The grid.
 * @param {number[]} half Half-sizes in metres.
 * @returns {void}
 */
const assertBox = (g, half) => {
    let wrong = 0;
    for (let k = 0; k < g.nz; k++) {
        for (let j = 0; j < g.ny; j++) {
            for (let i = 0; i < g.nx; i++) {
                const p = [(i - g.cx) * g.voxel, (j - g.cy) * g.voxel, (k - g.cz) * g.voxel];
                const inside = p.every((c, a) => Math.abs(c) < half[a] - g.voxel);
                const outside = p.some((c, a) => Math.abs(c) > half[a] + g.voxel);
                const v = g.get(i, j, k);
                if ((inside && !(v < 0)) || (outside && !(v > 0))) {
                    wrong++;
                }
            }
        }
    }
    assert.equal(wrong, 0, 'voxels on the wrong side');
};

test('a cube in every format becomes the same grid, fitted to the longest side', () => {
    const tris = box(1, 1, 1);
    const files = {
        stl: [asciiSTL(tris), binarySTL(tris)],
        obj: [objFile(tris)],
        glb: [glbFile(tris, {translation: [5, -3, 2]})],
    };
    let first = null;
    for (const [format, list] of Object.entries(files)) {
        for (const bytes of list) {
            const g = fillUpload(grid(), bytes, format);
            assertBox(g, [FIT / 2, FIT / 2, FIT / 2]);
            if (first) {
                assert.deepEqual(g.data, first.data, format + ' differs');
            } else {
                first = g;
            }
        }
    }
});

test('rays through the cube\'s edges and diagonals count each crossing once', () => {
    // A 1 x 1 x 1 cube fitted to 0.22 m puts voxel centres (odd multiples of 4 mm) on the face
    // diagonals y = ±z, so rows along x meet the shared edges of the face triangles exactly.
    const g = fillUpload(grid(), objFile(box(1, 1, 1)), 'obj');
    const i = 32;
    for (let j = 0; j < g.ny; j++) {
        const k = j;
        const y = (j - g.cy) * g.voxel;
        if (Math.abs(y) < FIT / 2 - g.voxel) {
            assert.ok(g.get(i, j, k) < 0, 'inside on the diagonal at ' + j);
        }
    }
});

test('STL is read Z up and turned Y up; glTF node transforms apply', () => {
    // 1 (x) by 3 (y, up) by 2 (z): longest side y.
    const tris = box(0.5, 1.5, 1);
    const half = [FIT / 6, FIT / 2, FIT / 3];
    assertBox(fillUpload(grid(), binarySTL(tris), 'stl'), half);
    assertBox(fillUpload(grid(), objFile(tris), 'obj'), half);
    // Rotated 90° about z: x and y swap.
    const s = Math.SQRT1_2;
    assertBox(fillUpload(grid(), glbFile(tris, {rotation: [0, 0, s, s]}), 'glb'), [FIT / 2, FIT / 6, FIT / 3]);
});

test('an uploaded sphere has the volume of a sphere and exports watertight', async() => {
    const bytes = binarySTL(uvSphere(1, 48, 96));
    const engine = await Engine.create({dims: 64, voxel: 0.008, model: 'upload', upload: {bytes, format: 'stl'}});
    assert.equal(engine.seq, 0);
    const report = check(meshManifold(engine.display));
    const r = FIT / 2 * 1000;
    const expected = 4 / 3 * Math.PI * r * r * r;
    assert.ok(Math.abs(report.volumemm3 - expected) / expected < 0.06, 'volume ' + report.volumemm3);
    assert.equal(report.watertight, true);
});

test('two clients build the same starting grid bit for bit', async() => {
    const bytes = glbFile(uvSphere(1, 20, 40), {rotation: [0.1, 0.2, 0.3, 0.927362]});
    const a = await Engine.create({dims: 64, voxel: 0.008, model: 'upload', upload: {bytes, format: 'glb'}});
    const b = await Engine.create({dims: 64, voxel: 0.008, model: 'upload', upload: {bytes: bytes.slice(), format: 'glb'}});
    assert.deepEqual(a.display.data, b.display.data);
    assert.ok(a.display.data.some((v) => v < 0));
});

test('a mesh with a missing face still gives a solid inside', () => {
    const tris = box(1, 1, 1);
    tris.splice(3, 1);
    const g = fillUpload(grid(), objFile(tris), 'obj');
    assert.ok(g.get(32, 32, 32) < 0);
    assert.ok(g.get(4, 4, 4) > 0);
});

test('bad files and missing uploads are refused', async() => {
    assert.throws(() => parseModel(new Uint8Array(10), 'stl'), /not an STL file/);
    assert.throws(() => parseModel(new TextEncoder().encode('# empty'), 'obj'), /no triangles/);
    assert.throws(() => parseModel(new TextEncoder().encode('v 0 0 0\nf 1 2 3'), 'obj'), /bad vertex/);
    assert.throws(() => parseModel(glbFile(box(1, 1, 1), {}, ['KHR_draco_mesh_compression']), 'glb'), /not supported/);
    assert.throws(() => parseModel(new Uint8Array(40), 'glb'), /not a glTF/);
    assert.throws(() => parseModel(new Uint8Array(10), '3ds'), /unknown model format/);
    assert.throws(() => fillUpload(grid(), objFile([[[0, 0, 0], [0, 0, 0], [0, 0, 0]]]), 'obj'), /flat or empty/);
    await assert.rejects(Engine.create({model: 'upload'}), /uploaded model is missing/);
});
