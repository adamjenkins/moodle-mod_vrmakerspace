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
 * Surface-nets mesher for the sculpting engine's signed distance grid.
 *
 * The grid holds one signed distance per voxel (negative inside). A cell spans the 2 × 2 × 2 voxels
 * (i..i+1, j..j+1, k..k+1); every cell whose corners change sign gets one vertex, placed at the mean
 * of the points where the field crosses zero on the cell's edges. Every voxel edge whose ends change
 * sign is shared by four cells, and their four vertices make one quad (two triangles).
 *
 * Ownership keeps chunk seams exact: the three edges that leave voxel (i, j, k) in +x, +y and +z
 * belong to cell (i, j, k), and a chunk emits the quads of the edges its cells own. A quad also uses
 * vertices of the cells one step lower on the other two axes, so a chunk computes the vertices of a
 * one-cell halo on its low sides; vertex positions depend only on the grid values, so the same cell
 * gives bit-identical vertices in every chunk that uses it.
 *
 * Positions are in sculpture-local metres (Y up, origin at the grid centre): voxel (i, j, k) sits at
 * ((i - (nx - 1) / 2) × voxel, ...). Triangles wind counter-clockwise seen from outside (three.js
 * front faces), and normals are the normalised central-difference gradient of the field, which points
 * outward because the field grows outward.
 *
 * The module is dependency-free and runs in a module Web Worker and in Node. It only uses
 * + - * /, Math.sqrt, Math.min, Math.max and Math.floor, so results are the same in every browser.
 * Scratch buffers are module-level and reused between calls; the returned arrays are fresh copies
 * that the caller may transfer.
 *
 * @module     mod_vrsculpt/engine/mesher
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Cells per chunk edge. */
export const CHUNK = 16;

/** For each of the 12 cell edges: the first corner (corner bit 0 = +x, bit 1 = +y, bit 2 = +z). */
const EDGE_A = new Uint8Array([0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3]);

/** For each of the 12 cell edges: the second corner. */
const EDGE_B = new Uint8Array([1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7]);

/**
 * Reused working memory. Grown on demand, never shrunk.
 *
 * @type {{positions: Float32Array, normals: Float32Array, indices: Uint32Array, map: Int32Array,
 *     corner: Float64Array, grad: Float64Array, vcount: number, icount: number}}
 */
const scratch = {
    positions: new Float32Array(3 * 4096),
    normals: new Float32Array(3 * 4096),
    indices: new Uint32Array(6 * 4096),
    map: new Int32Array(0),
    corner: new Float64Array(8),
    grad: new Float64Array(3),
    vcount: 0,
    icount: 0,
};

/**
 * The region being meshed: the cell box whose vertices may be created and its vertex-index map.
 *
 * @type {{bx: number, by: number, bz: number, sx: number, sy: number}}
 */
const region = {bx: 0, by: 0, bz: 0, sx: 0, sy: 0};

/**
 * Number of chunks along each axis of a grid.
 *
 * @param {{nx: number, ny: number, nz: number}} grid The grid.
 * @returns {number[]} [chunks along x, along y, along z].
 */
export function chunkCounts(grid) {
    return [
        Math.max(0, Math.floor((grid.nx - 2 + CHUNK) / CHUNK)),
        Math.max(0, Math.floor((grid.ny - 2 + CHUNK) / CHUNK)),
        Math.max(0, Math.floor((grid.nz - 2 + CHUNK) / CHUNK)),
    ];
}

/**
 * Makes sure the vertex scratch arrays hold at least the given number of vertices.
 *
 * @param {number} count Vertices needed.
 * @returns {void}
 */
function ensureVertices(count) {
    if (count * 3 <= scratch.positions.length) {
        return;
    }
    let size = scratch.positions.length;
    while (size < count * 3) {
        size *= 2;
    }
    const positions = new Float32Array(size);
    positions.set(scratch.positions.subarray(0, scratch.vcount * 3));
    const normals = new Float32Array(size);
    normals.set(scratch.normals.subarray(0, scratch.vcount * 3));
    scratch.positions = positions;
    scratch.normals = normals;
}

/**
 * Makes sure the index scratch array holds at least the given number of indices.
 *
 * @param {number} count Indices needed.
 * @returns {void}
 */
function ensureIndices(count) {
    if (count <= scratch.indices.length) {
        return;
    }
    let size = scratch.indices.length;
    while (size < count) {
        size *= 2;
    }
    const indices = new Uint32Array(size);
    indices.set(scratch.indices.subarray(0, scratch.icount));
    scratch.indices = indices;
}

/**
 * Writes the field gradient at a voxel into scratch.grad (central differences, one-sided at the grid
 * faces).
 *
 * @param {Float32Array} data The grid values, x fastest.
 * @param {number} nx Voxels along x.
 * @param {number} ny Voxels along y.
 * @param {number} nz Voxels along z.
 * @param {number} x Voxel x index.
 * @param {number} y Voxel y index.
 * @param {number} z Voxel z index.
 * @returns {void}
 */
function gradientAt(data, nx, ny, nz, x, y, z) {
    const nxy = nx * ny;
    const at = x + nx * y + nxy * z;
    const g = scratch.grad;
    const x0 = x > 0 ? at - 1 : at;
    const x1 = x < nx - 1 ? at + 1 : at;
    const dx = (x > 0 ? 1 : 0) + (x < nx - 1 ? 1 : 0);
    g[0] = dx > 0 ? (data[x1] - data[x0]) / dx : 0;
    const y0 = y > 0 ? at - nx : at;
    const y1 = y < ny - 1 ? at + nx : at;
    const dy = (y > 0 ? 1 : 0) + (y < ny - 1 ? 1 : 0);
    g[1] = dy > 0 ? (data[y1] - data[y0]) / dy : 0;
    const z0 = z > 0 ? at - nxy : at;
    const z1 = z < nz - 1 ? at + nxy : at;
    const dz = (z > 0 ? 1 : 0) + (z < nz - 1 ? 1 : 0);
    g[2] = dz > 0 ? (data[z1] - data[z0]) / dz : 0;
}

/**
 * Computes the vertex of cell (i, j, k) and appends it to the scratch vertex arrays.
 *
 * @param {object} grid The grid ({nx, ny, nz, voxel, data}).
 * @param {number} i Cell x index (0..nx-2).
 * @param {number} j Cell y index (0..ny-2).
 * @param {number} k Cell z index (0..nz-2).
 * @returns {number} The new vertex index.
 */
function addVertex(grid, i, j, k) {
    const nx = grid.nx;
    const ny = grid.ny;
    const nz = grid.nz;
    const data = grid.data;
    const nxy = nx * ny;
    const base = i + nx * j + nxy * k;
    const c = scratch.corner;
    c[0] = data[base];
    c[1] = data[base + 1];
    c[2] = data[base + nx];
    c[3] = data[base + nx + 1];
    c[4] = data[base + nxy];
    c[5] = data[base + nxy + 1];
    c[6] = data[base + nxy + nx];
    c[7] = data[base + nxy + nx + 1];

    let sx = 0;
    let sy = 0;
    let sz = 0;
    let crossings = 0;
    for (let e = 0; e < 12; e++) {
        const a = EDGE_A[e];
        const b = EDGE_B[e];
        const va = c[a];
        const vb = c[b];
        if ((va < 0) === (vb < 0)) {
            continue;
        }
        const t = va / (va - vb);
        const ax = a & 1;
        const ay = (a >> 1) & 1;
        const az = (a >> 2) & 1;
        sx += ax + ((b & 1) - ax) * t;
        sy += ay + (((b >> 1) & 1) - ay) * t;
        sz += az + (((b >> 2) & 1) - az) * t;
        crossings++;
    }
    let fx = 0.5;
    let fy = 0.5;
    let fz = 0.5;
    if (crossings > 0) {
        fx = sx / crossings;
        fy = sy / crossings;
        fz = sz / crossings;
    }

    // Trilinear blend of the corner gradients at the vertex.
    let gx = 0;
    let gy = 0;
    let gz = 0;
    const g = scratch.grad;
    for (let corner = 0; corner < 8; corner++) {
        const cx = corner & 1;
        const cy = (corner >> 1) & 1;
        const cz = (corner >> 2) & 1;
        const w = (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy) * (cz ? fz : 1 - fz);
        if (w === 0) {
            continue;
        }
        gradientAt(data, nx, ny, nz, i + cx, j + cy, k + cz);
        gx += g[0] * w;
        gy += g[1] * w;
        gz += g[2] * w;
    }
    let len = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (!(len > 1e-20)) {
        // Flat central differences (a thin sheet): use the cell's own corner differences.
        gx = (c[1] - c[0]) + (c[3] - c[2]) + (c[5] - c[4]) + (c[7] - c[6]);
        gy = (c[2] - c[0]) + (c[3] - c[1]) + (c[6] - c[4]) + (c[7] - c[5]);
        gz = (c[4] - c[0]) + (c[5] - c[1]) + (c[6] - c[2]) + (c[7] - c[3]);
        len = Math.sqrt(gx * gx + gy * gy + gz * gz);
    }
    if (!(len > 1e-20)) {
        gx = 0;
        gy = 1;
        gz = 0;
        len = 1;
    }

    const index = scratch.vcount;
    ensureVertices(index + 1);
    const voxel = grid.voxel;
    const o = index * 3;
    scratch.positions[o] = (i + fx - (nx - 1) / 2) * voxel;
    scratch.positions[o + 1] = (j + fy - (ny - 1) / 2) * voxel;
    scratch.positions[o + 2] = (k + fz - (nz - 1) / 2) * voxel;
    scratch.normals[o] = gx / len;
    scratch.normals[o + 1] = gy / len;
    scratch.normals[o + 2] = gz / len;
    scratch.vcount = index + 1;
    return index;
}

/**
 * Returns the vertex index of a cell, creating the vertex on first use.
 *
 * @param {object} grid The grid.
 * @param {number} i Cell x index.
 * @param {number} j Cell y index.
 * @param {number} k Cell z index.
 * @returns {number} Vertex index.
 */
function vertexOf(grid, i, j, k) {
    const m = (i - region.bx) + region.sx * ((j - region.by) + region.sy * (k - region.bz));
    let v = scratch.map[m];
    if (v < 0) {
        v = addVertex(grid, i, j, k);
        scratch.map[m] = v;
    }
    return v;
}

/**
 * Squared distance between two scratch vertices.
 *
 * @param {number} a First vertex index.
 * @param {number} b Second vertex index.
 * @returns {number} Squared distance in m².
 */
function dist2(a, b) {
    const p = scratch.positions;
    const dx = p[a * 3] - p[b * 3];
    const dy = p[a * 3 + 1] - p[b * 3 + 1];
    const dz = p[a * 3 + 2] - p[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
}

/**
 * Appends a quad as two triangles, splitting along its shorter diagonal.
 *
 * The four vertices are given counter-clockwise seen from the side the quad faces when `flip` is
 * false; with `flip` the winding is reversed.
 *
 * @param {number} a Vertex 0.
 * @param {number} b Vertex 1.
 * @param {number} c Vertex 2.
 * @param {number} d Vertex 3.
 * @param {boolean} flip Reverse the winding.
 * @returns {void}
 */
function addQuad(a, b, c, d, flip) {
    if (flip) {
        const t = b;
        b = d;
        d = t;
    }
    ensureIndices(scratch.icount + 6);
    const idx = scratch.indices;
    let o = scratch.icount;
    if (dist2(a, c) <= dist2(b, d)) {
        idx[o++] = a;
        idx[o++] = b;
        idx[o++] = c;
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = d;
    } else {
        idx[o++] = a;
        idx[o++] = b;
        idx[o++] = d;
        idx[o++] = b;
        idx[o++] = c;
        idx[o++] = d;
    }
    scratch.icount = o;
}

/**
 * Meshes the quads owned by the cells in a box and returns fresh arrays.
 *
 * @param {object} grid The grid ({nx, ny, nz, voxel, data}).
 * @param {number} x0 First owned cell x (inclusive).
 * @param {number} y0 First owned cell y.
 * @param {number} z0 First owned cell z.
 * @param {number} x1 Last owned cell x (exclusive).
 * @param {number} y1 Last owned cell y.
 * @param {number} z1 Last owned cell z.
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} The mesh.
 */
function meshBox(grid, x0, y0, z0, x1, y1, z1) {
    const nx = grid.nx;
    const ny = grid.ny;
    const nz = grid.nz;
    const data = grid.data;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    z0 = Math.max(0, z0);
    x1 = Math.min(nx - 1, x1);
    y1 = Math.min(ny - 1, y1);
    z1 = Math.min(nz - 1, z1);
    scratch.vcount = 0;
    scratch.icount = 0;
    if (x0 >= x1 || y0 >= y1 || z0 >= z1 || !data) {
        return {positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0)};
    }

    region.bx = Math.max(0, x0 - 1);
    region.by = Math.max(0, y0 - 1);
    region.bz = Math.max(0, z0 - 1);
    region.sx = x1 - region.bx;
    region.sy = y1 - region.by;
    const cells = region.sx * region.sy * (z1 - region.bz);
    if (scratch.map.length < cells) {
        scratch.map = new Int32Array(cells);
    }
    scratch.map.fill(-1, 0, cells);

    const nxy = nx * ny;
    for (let k = z0; k < z1; k++) {
        for (let j = y0; j < y1; j++) {
            let base = x0 + nx * j + nxy * k;
            for (let i = x0; i < x1; i++, base++) {
                const inside = data[base] < 0;
                // Edge along +x: shared by cells (i, j-1..j, k-1..k).
                if (j >= 1 && k >= 1 && inside !== (data[base + 1] < 0)) {
                    addQuad(vertexOf(grid, i, j - 1, k - 1), vertexOf(grid, i, j, k - 1),
                        vertexOf(grid, i, j, k), vertexOf(grid, i, j - 1, k), !inside);
                }
                // Edge along +y: shared by cells (i-1..i, j, k-1..k).
                if (i >= 1 && k >= 1 && inside !== (data[base + nx] < 0)) {
                    addQuad(vertexOf(grid, i - 1, j, k - 1), vertexOf(grid, i - 1, j, k),
                        vertexOf(grid, i, j, k), vertexOf(grid, i, j, k - 1), !inside);
                }
                // Edge along +z: shared by cells (i-1..i, j-1..j, k).
                if (i >= 1 && j >= 1 && inside !== (data[base + nxy] < 0)) {
                    addQuad(vertexOf(grid, i - 1, j - 1, k), vertexOf(grid, i, j - 1, k),
                        vertexOf(grid, i, j, k), vertexOf(grid, i - 1, j, k), !inside);
                }
            }
        }
    }

    // The loops stop at cell n - 2 on every axis, so base + 1, base + nx and base + nxy stay inside
    // the grid.
    return {
        positions: scratch.positions.slice(0, scratch.vcount * 3),
        normals: scratch.normals.slice(0, scratch.vcount * 3),
        indices: scratch.indices.slice(0, scratch.icount),
    };
}

/**
 * Meshes one chunk: the quads owned by cells [16c, 16c + 16) on each axis.
 *
 * Meshes of neighbouring chunks share their seam vertices bit for bit, and every quad of the surface
 * is emitted by exactly one chunk. An empty chunk returns empty arrays.
 *
 * @param {object} grid The grid ({nx, ny, nz, voxel, data: Float32Array x fastest}).
 * @param {number} cx Chunk x index.
 * @param {number} cy Chunk y index.
 * @param {number} cz Chunk z index.
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} The chunk mesh.
 */
export function meshChunk(grid, cx, cy, cz) {
    return meshBox(grid, cx * CHUNK, cy * CHUNK, cz * CHUNK, cx * CHUNK + CHUNK, cy * CHUNK + CHUNK,
        cz * CHUNK + CHUNK);
}

/**
 * Meshes the whole grid as one welded indexed mesh (every cell vertex appears once), so a closed
 * surface is watertight. Used for export.
 *
 * @param {object} grid The grid ({nx, ny, nz, voxel, data: Float32Array x fastest}).
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} The mesh.
 */
export function meshAll(grid) {
    return meshBox(grid, 0, 0, 0, grid.nx - 1, grid.ny - 1, grid.nz - 1);
}
