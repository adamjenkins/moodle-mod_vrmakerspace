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
 * Print-readiness check of an indexed triangle mesh.
 *
 * Counts every undirected edge: an edge used by one triangle is a boundary (a hole), by more than two
 * is non-manifold, and an edge used by exactly two triangles in the same direction is a flipped
 * (inconsistently wound) pair. A mesh is watertight when it has triangles and none of the three.
 * Size and volume are in millimetres in print orientation (Z up: print (x, y, z) = (x, −z, y) ×
 * 1000 of the sculpture-local metres), the volume by the divergence theorem (sum of signed
 * tetrahedra against the bounding-box centre), which is positive for an outward-wound closed mesh.
 *
 * @module     mod_vrmakerspace/engine/validate
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Increment for an edge used from its lower to its higher vertex index. */
const FORWARD = 1;

/** Increment for an edge used from its higher to its lower vertex index. */
const BACKWARD = 0x10000;

/**
 * Rounds a number to a number of decimals for the report.
 *
 * @param {number} v The value.
 * @param {number} scale 10 to the number of decimals.
 * @returns {number} The rounded value.
 */
function roundTo(v, scale) {
    return Math.round(v * scale) / scale;
}

/**
 * Checks a mesh for 3D printing.
 *
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh The mesh (sculpture-local metres, Y up).
 * @returns {{triangles: number, vertices: number, boundaryedges: number, nonmanifoldedges: number,
 *     flippededges: number, degeneratetriangles: number, watertight: boolean, sizemm: number[],
 *     volumemm3: number}} The report; sizemm is [x, y, z] of the print orientation, rounded to 0.01 mm,
 *     and volumemm3 is rounded to 0.1 mm³.
 */
export function check(mesh) {
    const positions = mesh && mesh.positions ? mesh.positions : new Float32Array(0);
    const indices = mesh && mesh.indices ? mesh.indices : new Uint32Array(0);
    const vertices = Math.floor(positions.length / 3);
    const triangles = Math.floor(indices.length / 3);

    // Bounding box in print orientation (millimetres, Z up).
    let minx = Infinity;
    let miny = Infinity;
    let minz = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    let maxz = -Infinity;
    const used = new Uint8Array(vertices);
    for (let t = 0; t < triangles * 3; t++) {
        const v = indices[t];
        if (v < vertices) {
            used[v] = 1;
        }
    }
    for (let v = 0; v < vertices; v++) {
        if (!used[v]) {
            continue;
        }
        const x = positions[v * 3] * 1000;
        const y = -positions[v * 3 + 2] * 1000;
        const z = positions[v * 3 + 1] * 1000;
        minx = Math.min(minx, x);
        maxx = Math.max(maxx, x);
        miny = Math.min(miny, y);
        maxy = Math.max(maxy, y);
        minz = Math.min(minz, z);
        maxz = Math.max(maxz, z);
    }
    const hasbox = minx <= maxx;
    const ox = hasbox ? (minx + maxx) / 2 : 0;
    const oy = hasbox ? (miny + maxy) / 2 : 0;
    const oz = hasbox ? (minz + maxz) / 2 : 0;

    const edges = new Map();
    let degenerate = 0;
    let volume6 = 0;
    for (let t = 0; t < triangles; t++) {
        const a = indices[t * 3];
        const b = indices[t * 3 + 1];
        const c = indices[t * 3 + 2];
        if (a >= vertices || b >= vertices || c >= vertices || a === b || b === c || a === c) {
            degenerate++;
            continue;
        }
        const tri = [a, b, c];
        for (let e = 0; e < 3; e++) {
            const p = tri[e];
            const q = tri[(e + 1) % 3];
            const key = p < q ? p * vertices + q : q * vertices + p;
            edges.set(key, (edges.get(key) || 0) + (p < q ? FORWARD : BACKWARD));
        }
        const ax = positions[a * 3] * 1000 - ox;
        const ay = -positions[a * 3 + 2] * 1000 - oy;
        const az = positions[a * 3 + 1] * 1000 - oz;
        const bx = positions[b * 3] * 1000 - ox;
        const by = -positions[b * 3 + 2] * 1000 - oy;
        const bz = positions[b * 3 + 1] * 1000 - oz;
        const cx = positions[c * 3] * 1000 - ox;
        const cy = -positions[c * 3 + 2] * 1000 - oy;
        const cz = positions[c * 3 + 1] * 1000 - oz;
        volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }

    let boundary = 0;
    let nonmanifold = 0;
    let flipped = 0;
    for (const value of edges.values()) {
        const forward = value % BACKWARD;
        const backward = (value - forward) / BACKWARD;
        const uses = forward + backward;
        if (uses === 1) {
            boundary++;
        } else if (uses > 2) {
            nonmanifold++;
        } else if (forward !== 1) {
            flipped++;
        }
    }

    const sizemm = hasbox ? [roundTo(maxx - minx, 100), roundTo(maxy - miny, 100), roundTo(maxz - minz, 100)] : [0, 0, 0];
    return {
        triangles,
        vertices,
        boundaryedges: boundary,
        nonmanifoldedges: nonmanifold,
        flippededges: flipped,
        degeneratetriangles: degenerate,
        watertight: triangles > 0 && degenerate < triangles && boundary === 0 && nonmanifold === 0 && flipped === 0,
        sizemm,
        volumemm3: roundTo(volume6 / 6, 10),
    };
}
