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
 * Tests of the surface-nets mesher (node --test).
 *
 * The grid is built here (a minimal object with the Grid fields the mesher reads), so these tests do
 * not depend on the engine's grid module.
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {meshChunk, meshAll, chunkCounts, CHUNK} from '../../js/engine/mesher.js';
import {check} from '../../js/engine/validate.js';

/**
 * Builds a minimal grid holding a clamped signed distance field.
 *
 * @param {number} n Voxels per axis.
 * @param {number} voxel Voxel size in metres.
 * @param {function(number, number, number): number} sdf Signed distance at a point (metres).
 * @returns {object} A grid {nx, ny, nz, voxel, band, data, get(i, j, k)}.
 */
function makeGrid(n, voxel, sdf) {
    const band = 3 * voxel;
    const data = new Float32Array(n * n * n);
    const half = (n - 1) / 2;
    for (let k = 0; k < n; k++) {
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const border = i < 2 || j < 2 || k < 2 || i >= n - 2 || j >= n - 2 || k >= n - 2;
                const d = border ? band : sdf((i - half) * voxel, (j - half) * voxel, (k - half) * voxel);
                data[i + n * (j + n * k)] = Math.max(-band, Math.min(band, d));
            }
        }
    }
    return {
        nx: n,
        ny: n,
        nz: n,
        voxel,
        band,
        data,
        get(i, j, k) {
            return data[i + n * (j + n * k)];
        },
    };
}

/**
 * Signed distance of a sphere at the origin.
 *
 * @param {number} r Radius in metres.
 * @returns {function(number, number, number): number} The field.
 */
function sphere(r) {
    return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r;
}

/**
 * Text key of a vertex position.
 *
 * @param {Float32Array} p Positions.
 * @param {number} v Vertex index.
 * @returns {string} Key.
 */
function vkey(p, v) {
    return p[v * 3] + ',' + p[v * 3 + 1] + ',' + p[v * 3 + 2];
}

/**
 * Canonical text key of a triangle by its vertex positions, keeping its winding (cyclic rotation
 * so the smallest key comes first).
 *
 * @param {Float32Array} p Positions.
 * @param {Uint32Array} idx Indices.
 * @param {number} t Triangle index.
 * @returns {string} Key.
 */
function tkey(p, idx, t) {
    const k = [vkey(p, idx[t * 3]), vkey(p, idx[t * 3 + 1]), vkey(p, idx[t * 3 + 2])];
    let first = 0;
    for (let n = 1; n < 3; n++) {
        if (k[n] < k[first]) {
            first = n;
        }
    }
    return k[first] + '|' + k[(first + 1) % 3] + '|' + k[(first + 2) % 3];
}

/**
 * Meshes every chunk and welds the results by exact position into one mesh.
 *
 * @param {object} grid The grid.
 * @returns {{positions: Float32Array, indices: Uint32Array, chunks: number}} The welded mesh.
 */
function weldChunks(grid) {
    const [cxn, cyn, czn] = chunkCounts(grid);
    const map = new Map();
    const positions = [];
    const indices = [];
    let chunks = 0;
    for (let cz = 0; cz < czn; cz++) {
        for (let cy = 0; cy < cyn; cy++) {
            for (let cx = 0; cx < cxn; cx++) {
                const m = meshChunk(grid, cx, cy, cz);
                assert.equal(m.positions.length, m.normals.length);
                if (m.indices.length === 0) {
                    continue;
                }
                chunks++;
                const remap = new Uint32Array(m.positions.length / 3);
                for (let v = 0; v < remap.length; v++) {
                    const key = vkey(m.positions, v);
                    let id = map.get(key);
                    if (id === undefined) {
                        id = positions.length / 3;
                        map.set(key, id);
                        positions.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
                    }
                    remap[v] = id;
                }
                for (const i of m.indices) {
                    indices.push(remap[i]);
                }
            }
        }
    }
    return {positions: Float32Array.from(positions), indices: Uint32Array.from(indices), chunks};
}

const grid = makeGrid(64, 0.004, sphere(0.1));

test('chunk counts cover every cell', () => {
    assert.deepEqual(chunkCounts(grid), [4, 4, 4]);
    assert.deepEqual(chunkCounts({nx: 128, ny: 128, nz: 128}), [8, 8, 8]);
    assert.equal(CHUNK, 16);
});

test('a sphere meshes watertight and manifold with the right size and volume', () => {
    const mesh = meshAll(grid);
    assert.ok(mesh.positions instanceof Float32Array);
    assert.ok(mesh.normals instanceof Float32Array);
    assert.ok(mesh.indices instanceof Uint32Array);
    assert.ok(mesh.indices.length > 3000);
    const report = check(mesh);
    assert.equal(report.boundaryedges, 0);
    assert.equal(report.nonmanifoldedges, 0);
    assert.equal(report.flippededges, 0);
    assert.equal(report.watertight, true);
    // Every vertex is used: the welded mesh has no stray vertices.
    const used = new Set(mesh.indices);
    assert.equal(used.size, mesh.positions.length / 3);
    for (const s of report.sizemm) {
        assert.ok(Math.abs(s - 200) < 4, 'size ' + s);
    }
    const expected = 4 / 3 * Math.PI * 100 * 100 * 100;
    assert.ok(Math.abs(report.volumemm3 - expected) / expected < 0.02, 'volume ' + report.volumemm3);
});

test('vertex normals and triangle windings point outward', () => {
    const {positions: p, normals: n, indices: idx} = meshAll(grid);
    for (let v = 0; v < p.length; v += 3) {
        const r = Math.sqrt(p[v] * p[v] + p[v + 1] * p[v + 1] + p[v + 2] * p[v + 2]);
        const dot = (p[v] * n[v] + p[v + 1] * n[v + 1] + p[v + 2] * n[v + 2]) / r;
        assert.ok(dot > 0.9, 'normal not outward at vertex ' + v / 3);
        const len = Math.sqrt(n[v] * n[v] + n[v + 1] * n[v + 1] + n[v + 2] * n[v + 2]);
        assert.ok(Math.abs(len - 1) < 1e-5);
    }
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3;
        const b = idx[t + 1] * 3;
        const c = idx[t + 2] * 3;
        const ux = p[b] - p[a];
        const uy = p[b + 1] - p[a + 1];
        const uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a];
        const vy = p[c + 1] - p[a + 1];
        const vz = p[c + 2] - p[a + 2];
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        const cx = p[a] + p[b] + p[c];
        const cy = p[a + 1] + p[b + 1] + p[c + 1];
        const cz = p[a + 2] + p[b + 2] + p[c + 2];
        assert.ok(fx * cx + fy * cy + fz * cz > 0, 'triangle ' + t / 3 + ' faces inward');
    }
});

test('chunk meshes together cover exactly the triangles of meshAll, with matching seams', () => {
    const all = meshAll(grid);
    const welded = weldChunks(grid);
    assert.ok(welded.chunks > 1, 'the sphere spans several chunks');
    assert.equal(welded.indices.length, all.indices.length);
    assert.equal(welded.positions.length, all.positions.length);
    const allKeys = new Set();
    for (let t = 0; t < all.indices.length / 3; t++) {
        allKeys.add(tkey(all.positions, all.indices, t));
    }
    assert.equal(allKeys.size, all.indices.length / 3);
    for (let t = 0; t < welded.indices.length / 3; t++) {
        assert.ok(allKeys.has(tkey(welded.positions, welded.indices, t)), 'chunk triangle ' + t + ' not in meshAll');
    }
    // Welding the chunk meshes by exact position closes every seam.
    const report = check(welded);
    assert.equal(report.watertight, true);
});

test('repeated meshing gives identical results (scratch buffers are reused safely)', () => {
    const first = meshChunk(grid, 1, 1, 1);
    meshAll(grid);
    const second = meshChunk(grid, 1, 1, 1);
    assert.deepEqual(Array.from(second.positions), Array.from(first.positions));
    assert.deepEqual(Array.from(second.indices), Array.from(first.indices));
});

test('a chunk without surface is empty', () => {
    const m = meshChunk(grid, 0, 0, 0);
    assert.equal(m.positions.length, 0);
    assert.equal(m.normals.length, 0);
    assert.equal(m.indices.length, 0);
    const outside = meshChunk(grid, 9, 9, 9);
    assert.equal(outside.indices.length, 0);
});

test('a surface with a hole through it (a torus) is closed too', () => {
    const torus = makeGrid(64, 0.004, (x, y, z) => {
        const ring = Math.sqrt(x * x + z * z) - 0.07;
        return Math.sqrt(ring * ring + y * y) - 0.03;
    });
    const report = check(meshAll(torus));
    assert.equal(report.boundaryedges, 0);
    assert.equal(report.nonmanifoldedges, 0);
    assert.equal(report.watertight, true);
});
