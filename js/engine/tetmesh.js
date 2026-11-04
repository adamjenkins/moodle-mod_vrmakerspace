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
 * The export mesh: marching tetrahedra over the whole grid.
 *
 * Surface nets (mesher.js) draw the sculpture quickly, but where two surfaces pass through one cell
 * they share a vertex and the mesh is not manifold there. A 3D printer needs a closed, manifold
 * surface, so exports use marching tetrahedra instead: every cell is cut into the six tetrahedra of
 * the Kuhn subdivision (all along the cell's main diagonal), which match across neighbouring cells, and
 * each grid edge crossing the surface gets exactly one vertex shared by every triangle that uses it.
 * The result is closed and 2-manifold by construction. Inside is d < 0; a value of exactly 0 counts as
 * outside, and its vertex is pulled just off the grid point so no two vertices coincide.
 *
 * Dependency-free ES module (runs in the engine's Web Worker and in Node).
 *
 * @module     mod_vrmakerspace/engine/tetmesh
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** The six Kuhn tetrahedra of a cell, as cell-corner numbers (bit 0 = +x, bit 1 = +y, bit 2 = +z). */
const TETS = [
    [0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7],
    [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7],
];

/** Value used instead of exactly 0 on the outside end of an edge, in metres. */
const NUDGE = 1e-6;

/**
 * Mesh the zero level of the grid with marching tetrahedra.
 *
 * @param {Object} grid Grid {nx, ny, nz, voxel, data (x fastest)}.
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} Sculpture-local metres.
 */
export function meshManifold(grid) {
    const {nx, ny, nz, voxel, data} = grid;
    const sx = 1;
    const sy = nx;
    const sz = nx * ny;
    const cx = (nx - 1) / 2;
    const cy = (ny - 1) / 2;
    const cz = (nz - 1) / 2;
    const total = nx * ny * nz;

    const positions = [];
    const normals = [];
    const indices = [];
    const edges = new Map();

    /**
     * The field's central-difference gradient at a grid point (one-sided at the border).
     *
     * @param {number} g Grid point index.
     * @param {number} i x index.
     * @param {number} j y index.
     * @param {number} k z index.
     * @param {number[]} out Receives [gx, gy, gz].
     */
    const gradient = (g, i, j, k, out) => {
        out[0] = data[i < nx - 1 ? g + sx : g] - data[i > 0 ? g - sx : g];
        out[1] = data[j < ny - 1 ? g + sy : g] - data[j > 0 ? g - sy : g];
        out[2] = data[k < nz - 1 ? g + sz : g] - data[k > 0 ? g - sz : g];
    };

    const ga = [0, 0, 0];
    const gb = [0, 0, 0];

    /**
     * The vertex where the surface crosses the edge from inside point a to outside point b.
     *
     * @param {number} a Inside grid point index.
     * @param {number} b Outside grid point index.
     * @returns {number} Vertex index.
     */
    const vertex = (a, b) => {
        const key = a < b ? a * total + b : b * total + a;
        const known = edges.get(key);
        if (known !== undefined) {
            return known;
        }
        const va = data[a];
        const vb = data[b] === 0 ? NUDGE : data[b];
        const t = va / (va - vb);
        const ai = a % nx;
        const aj = Math.floor(a / nx) % ny;
        const ak = Math.floor(a / sz);
        const bi = b % nx;
        const bj = Math.floor(b / nx) % ny;
        const bk = Math.floor(b / sz);
        positions.push(
            (ai + (bi - ai) * t - cx) * voxel,
            (aj + (bj - aj) * t - cy) * voxel,
            (ak + (bk - ak) * t - cz) * voxel
        );
        gradient(a, ai, aj, ak, ga);
        gradient(b, bi, bj, bk, gb);
        let nxv = ga[0] + (gb[0] - ga[0]) * t;
        let nyv = ga[1] + (gb[1] - ga[1]) * t;
        let nzv = ga[2] + (gb[2] - ga[2]) * t;
        const length = Math.sqrt(nxv * nxv + nyv * nyv + nzv * nzv) || 1;
        nxv /= length;
        nyv /= length;
        nzv /= length;
        normals.push(nxv, nyv, nzv);
        const index = positions.length / 3 - 1;
        edges.set(key, index);
        return index;
    };

    /**
     * Add a triangle, wound so that its face normal points away from an inside grid point (or toward an
     * outside one). This is decided by the tetrahedron's own geometry, so it is right even where the
     * field's gradient is flat.
     *
     * @param {number} p First vertex.
     * @param {number} q Second vertex.
     * @param {number} r Third vertex.
     * @param {number} g The reference grid point.
     * @param {number} away 1 when the reference point is inside, -1 when it is outside.
     */
    const triangle = (p, q, r, g, away) => {
        const ux = positions[q * 3] - positions[p * 3];
        const uy = positions[q * 3 + 1] - positions[p * 3 + 1];
        const uz = positions[q * 3 + 2] - positions[p * 3 + 2];
        const vx = positions[r * 3] - positions[p * 3];
        const vy = positions[r * 3 + 1] - positions[p * 3 + 1];
        const vz = positions[r * 3 + 2] - positions[p * 3 + 2];
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        const gx = ((g % nx) - cx) * voxel;
        const gy = ((Math.floor(g / nx) % ny) - cy) * voxel;
        const gz = (Math.floor(g / sz) - cz) * voxel;
        const dx = (positions[p * 3] + positions[q * 3] + positions[r * 3]) / 3 - gx;
        const dy = (positions[p * 3 + 1] + positions[q * 3 + 1] + positions[r * 3 + 1]) / 3 - gy;
        const dz = (positions[p * 3 + 2] + positions[q * 3 + 2] + positions[r * 3 + 2]) / 3 - gz;
        if ((fx * dx + fy * dy + fz * dz) * away < 0) {
            indices.push(p, r, q);
        } else {
            indices.push(p, q, r);
        }
    };

    const corner = new Int32Array(8);
    const inside = new Uint8Array(8);
    const ins = [0, 0, 0, 0];
    const outs = [0, 0, 0, 0];
    for (let k = 0; k < nz - 1; k++) {
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const base = i * sx + j * sy + k * sz;
                let count = 0;
                for (let c = 0; c < 8; c++) {
                    const g = base + ((c & 1) ? sx : 0) + ((c & 2) ? sy : 0) + ((c & 4) ? sz : 0);
                    corner[c] = g;
                    inside[c] = data[g] < 0 ? 1 : 0;
                    count += inside[c];
                }
                if (count === 0 || count === 8) {
                    continue;
                }
                for (let t = 0; t < TETS.length; t++) {
                    const tet = TETS[t];
                    let ni = 0;
                    let no = 0;
                    for (let v = 0; v < 4; v++) {
                        const g = corner[tet[v]];
                        if (inside[tet[v]]) {
                            ins[ni++] = g;
                        } else {
                            outs[no++] = g;
                        }
                    }
                    if (ni === 1) {
                        triangle(vertex(ins[0], outs[0]), vertex(ins[0], outs[1]), vertex(ins[0], outs[2]), ins[0], 1);
                    } else if (ni === 3) {
                        triangle(vertex(ins[0], outs[0]), vertex(ins[1], outs[0]), vertex(ins[2], outs[0]), outs[0], -1);
                    } else if (ni === 2) {
                        // The four crossing edges form the cycle a-c, a-d, b-d, b-c.
                        const ac = vertex(ins[0], outs[0]);
                        const ad = vertex(ins[0], outs[1]);
                        const bd = vertex(ins[1], outs[1]);
                        const bc = vertex(ins[1], outs[0]);
                        triangle(ac, ad, bd, ins[0], 1);
                        triangle(ac, bd, bc, ins[1], 1);
                    }
                }
            }
        }
    }
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
    };
}
