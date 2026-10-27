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
 * Uploaded starting models: reads a triangle mesh (STL, OBJ or glTF binary) and turns it into a
 * signed-distance grid.
 *
 * Every partner of a sculpture builds the starting grid on their own, so the result must be the
 * same bit for bit everywhere: only +, −, ×, ÷ and Math.sqrt (all exactly rounded in IEEE 754) are
 * used, in a fixed order.
 *
 * - The mesh is centred on its bounding box and scaled so its longest side is FIT metres, whatever
 *   its units. STL is Z up (as the STL export writes it); OBJ and glTF are Y up, as the sculpture.
 * - Distance: per triangle, the exact point-to-triangle distance of every voxel within the band.
 * - Inside or outside: ray parity along each axis, voted 2 of 3, so a small hole in an open mesh
 *   spoils one vote and not the voxel. A ray through an edge or vertex counts the crossing exactly
 *   once (simulation of simplicity: the ray is treated as moved by (ε, ε²), and every edge function
 *   is computed from the edge's endpoints in one canonical order, so both triangles of an edge see
 *   the same value).
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/meshimport
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {BORDER} from './grid.js';

/** File formats an uploaded starting model may have. */
export const FORMATS = Object.freeze(['stl', 'obj', 'glb']);

/** Longest side of an uploaded model in the sculpture, metres (the clay lump is 0.22 m wide). */
export const FIT = 0.22;

/** Most triangles an uploaded model may have. */
export const MAX_TRIANGLES = 500000;

/**
 * Bytes as a Uint8Array view.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes The file.
 * @returns {Uint8Array} A view of the same memory.
 */
function u8(bytes) {
    if (bytes instanceof Uint8Array) {
        return bytes;
    }
    if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return new Uint8Array(bytes);
}

/**
 * Collects triangles as a growing list of 9 numbers each.
 */
class TriangleList {
    /**
     * An empty list.
     */
    constructor() {
        /** @type {number[]} */
        this.values = [];
    }

    /**
     * Adds a triangle.
     *
     * @param {number[]} a First vertex [x, y, z].
     * @param {number[]} b Second vertex.
     * @param {number[]} c Third vertex.
     * @returns {void}
     * @throws {Error} Past MAX_TRIANGLES.
     */
    add(a, b, c) {
        if (this.values.length >= MAX_TRIANGLES * 9) {
            throw new Error('the model has more than ' + MAX_TRIANGLES + ' triangles');
        }
        this.values.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }

    /**
     * The triangles.
     *
     * @returns {Float64Array} 9 numbers per triangle.
     * @throws {Error} When there are none or a coordinate is not finite.
     */
    done() {
        if (!this.values.length) {
            throw new Error('the model has no triangles');
        }
        const out = Float64Array.from(this.values);
        for (let n = 0; n < out.length; n++) {
            if (!Number.isFinite(out[n])) {
                throw new Error('the model has a coordinate that is not a number');
            }
        }
        return out;
    }
}

/**
 * Reads an STL file (binary or ASCII), turning Z up into Y up: (x, y, z) → (x, z, −y).
 *
 * @param {Uint8Array} b The file.
 * @returns {Float64Array} Triangles.
 */
export function parseSTL(b) {
    const list = new TriangleList();
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const count = b.byteLength >= 84 ? view.getUint32(80, true) : -1;
    if (count >= 0 && b.byteLength === 84 + count * 50) {
        if (count > MAX_TRIANGLES) {
            throw new Error('the model has more than ' + MAX_TRIANGLES + ' triangles');
        }
        for (let t = 0; t < count; t++) {
            const v = [];
            for (let n = 0; n < 3; n++) {
                const o = 84 + t * 50 + 12 + n * 12;
                v.push([view.getFloat32(o, true), view.getFloat32(o + 8, true), -view.getFloat32(o + 4, true)]);
            }
            list.add(v[0], v[1], v[2]);
        }
        return list.done();
    }
    const text = new TextDecoder('utf-8').decode(b);
    if (!/^\s*solid/.test(text)) {
        throw new Error('not an STL file');
    }
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const v = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        v.push([parseFloat(m[1]), parseFloat(m[3]), -parseFloat(m[2])]);
        if (v.length === 3) {
            list.add(v[0], v[1], v[2]);
            v.length = 0;
        }
    }
    return list.done();
}

/**
 * Reads a Wavefront OBJ file: v and f lines (faces fanned into triangles, negative indices allowed).
 *
 * @param {Uint8Array} b The file.
 * @returns {Float64Array} Triangles.
 */
export function parseOBJ(b) {
    const list = new TriangleList();
    const text = new TextDecoder('utf-8').decode(b);
    const vertices = [];
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('v ') || line.startsWith('v\t')) {
            const p = line.split(/\s+/);
            vertices.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
        } else if (line.startsWith('f ') || line.startsWith('f\t')) {
            const refs = line.split(/\s+/).slice(1).map((r) => {
                const n = parseInt(r.split('/')[0], 10);
                const i = n < 0 ? vertices.length + n : n - 1;
                if (!Number.isInteger(i) || i < 0 || i >= vertices.length) {
                    throw new Error('the OBJ file has a face with a bad vertex');
                }
                return vertices[i];
            });
            for (let n = 1; n + 1 < refs.length; n++) {
                list.add(refs[0], refs[n], refs[n + 1]);
            }
        }
    }
    return list.done();
}

/**
 * Product of two column-major 4 × 4 matrices.
 *
 * @param {number[]} a Left.
 * @param {number[]} b Right.
 * @returns {number[]} a × b.
 */
function mul4(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return out;
}

/**
 * The local matrix of a glTF node (its matrix, or translation × rotation × scale).
 *
 * @param {object} node The node.
 * @returns {number[]} Column-major 4 × 4 matrix.
 */
function nodeMatrix(node) {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) {
        return node.matrix.map(Number);
    }
    const [tx, ty, tz] = Array.isArray(node.translation) ? node.translation.map(Number) : [0, 0, 0];
    const [x, y, z, w] = Array.isArray(node.rotation) ? node.rotation.map(Number) : [0, 0, 0, 1];
    const [sx, sy, sz] = Array.isArray(node.scale) ? node.scale.map(Number) : [1, 1, 1];
    return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

/**
 * Reads a glTF 2.0 binary file: the triangles of every mesh of the default scene, with node transforms.
 *
 * @param {Uint8Array} b The file.
 * @returns {Float64Array} Triangles.
 */
export function parseGLB(b) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.byteLength < 20 || view.getUint32(0, true) !== 0x46546C67 || view.getUint32(4, true) !== 2) {
        throw new Error('not a glTF 2.0 binary file');
    }
    let json = null;
    let bin = null;
    for (let o = 12; o + 8 <= b.byteLength;) {
        const length = view.getUint32(o, true);
        const type = view.getUint32(o + 4, true);
        if (o + 8 + length > b.byteLength) {
            throw new Error('the glTF file is cut short');
        }
        const chunk = b.subarray(o + 8, o + 8 + length);
        if (type === 0x4E4F534A) {
            json = JSON.parse(new TextDecoder('utf-8').decode(chunk));
        } else if (type === 0x004E4942 && !bin) {
            bin = chunk;
        }
        o += 8 + length;
    }
    if (!json) {
        throw new Error('the glTF file has no JSON chunk');
    }
    if (Array.isArray(json.extensionsRequired) && json.extensionsRequired.length) {
        throw new Error('the glTF file needs ' + json.extensionsRequired.join(', ') + ', which is not supported');
    }
    const binView = bin ? new DataView(bin.buffer, bin.byteOffset, bin.byteLength) : null;
    const accessors = json.accessors || [];
    const views = json.bufferViews || [];

    const read = (index, positions) => {
        const acc = accessors[index];
        if (!acc || acc.bufferView === undefined || acc.sparse || !binView) {
            throw new Error('the glTF file has an accessor that cannot be read');
        }
        const bv = views[acc.bufferView];
        if (!bv || (bv.buffer || 0) !== 0) {
            throw new Error('the glTF file has data outside its binary chunk');
        }
        const components = positions ? 3 : 1;
        const sizes = {5121: 1, 5123: 2, 5125: 4, 5126: 4};
        const size = sizes[acc.componentType];
        if (!size || (positions && (acc.componentType !== 5126 || acc.type !== 'VEC3')) ||
                (!positions && (acc.componentType === 5126 || acc.type !== 'SCALAR'))) {
            throw new Error('the glTF file has an accessor of an unsupported type');
        }
        const stride = bv.byteStride || size * components;
        const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const out = [];
        for (let n = 0; n < acc.count; n++) {
            for (let c = 0; c < components; c++) {
                const o = base + n * stride + c * size;
                if (o + size > (bv.byteOffset || 0) + bv.byteLength) {
                    throw new Error('the glTF file has an accessor past its data');
                }
                out.push(size === 1 ? binView.getUint8(o) : size === 2 ? binView.getUint16(o, true) :
                    acc.componentType === 5126 ? binView.getFloat32(o, true) : binView.getUint32(o, true));
            }
        }
        return out;
    };

    const list = new TriangleList();
    const addMesh = (mesh, m) => {
        for (const prim of mesh.primitives || []) {
            if ((prim.mode === undefined ? 4 : prim.mode) !== 4 || !prim.attributes ||
                    prim.attributes.POSITION === undefined) {
                continue;
            }
            const p = read(prim.attributes.POSITION, true);
            const count = p.length / 3;
            const at = (i) => {
                if (!(i >= 0 && i < count)) {
                    throw new Error('the glTF file has an index past its vertices');
                }
                const x = p[i * 3];
                const y = p[i * 3 + 1];
                const z = p[i * 3 + 2];
                return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
                    m[2] * x + m[6] * y + m[10] * z + m[14]];
            };
            const idx = prim.indices === undefined ? null : read(prim.indices, false);
            const n = idx ? idx.length : count;
            for (let t = 0; t + 2 < n; t += 3) {
                list.add(at(idx ? idx[t] : t), at(idx ? idx[t + 1] : t + 1), at(idx ? idx[t + 2] : t + 2));
            }
        }
    };

    const nodes = json.nodes || [];
    const scenes = json.scenes || [];
    const scene = scenes[json.scene || 0];
    let roots = scene && Array.isArray(scene.nodes) ? scene.nodes : null;
    if (!roots) {
        const children = new Set();
        nodes.forEach((node) => (node.children || []).forEach((c) => children.add(c)));
        roots = nodes.map((node, i) => i).filter((i) => !children.has(i));
    }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const stack = roots.map((i) => [i, identity, 0]);
    while (stack.length) {
        const [i, parent, depth] = stack.pop();
        const node = nodes[i];
        if (!node || depth > 64) {
            continue;
        }
        const m = mul4(parent, nodeMatrix(node));
        if (node.mesh !== undefined && json.meshes && json.meshes[node.mesh]) {
            addMesh(json.meshes[node.mesh], m);
        }
        for (let c = (node.children || []).length - 1; c >= 0; c--) {
            stack.push([node.children[c], m, depth + 1]);
        }
    }
    return list.done();
}

/**
 * Reads an uploaded model.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes The file.
 * @param {string} format 'stl', 'obj' or 'glb'.
 * @returns {Float64Array} Triangles, 9 numbers each, in the file's own units.
 * @throws {Error} For an unknown format or a file that cannot be read.
 */
export function parseModel(bytes, format) {
    const b = u8(bytes);
    if (format === 'stl') {
        return parseSTL(b);
    }
    if (format === 'obj') {
        return parseOBJ(b);
    }
    if (format === 'glb') {
        return parseGLB(b);
    }
    throw new Error('unknown model format: ' + String(format));
}

/**
 * Centres triangles on their bounding box and scales them so the longest side is `size` (in place).
 *
 * @param {Float64Array} tris Triangles.
 * @param {number} size Longest side after scaling, metres.
 * @returns {Float64Array} The same array.
 * @throws {Error} When the model has no extent.
 */
export function fitTriangles(tris, size) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let n = 0; n < tris.length; n++) {
        const a = n % 3;
        lo[a] = tris[n] < lo[a] ? tris[n] : lo[a];
        hi[a] = tris[n] > hi[a] ? tris[n] : hi[a];
    }
    const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!(extent > 0) || !Number.isFinite(extent)) {
        throw new Error('the model is flat or empty');
    }
    const scale = size / extent;
    const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    for (let n = 0; n < tris.length; n++) {
        tris[n] = (tris[n] - mid[n % 3]) * scale;
    }
    return tris;
}

/**
 * Squared distance from a point to a triangle (Ericson, Real-Time Collision Detection, 5.1.5).
 *
 * @param {number} px Point x.
 * @param {number} py Point y.
 * @param {number} pz Point z.
 * @param {Float64Array} t Triangles.
 * @param {number} o Offset of the triangle's first number.
 * @returns {number} The squared distance.
 */
function distance2(px, py, pz, t, o) {
    const ax = t[o];
    const ay = t[o + 1];
    const az = t[o + 2];
    const abx = t[o + 3] - ax;
    const aby = t[o + 4] - ay;
    const abz = t[o + 5] - az;
    const acx = t[o + 6] - ax;
    const acy = t[o + 7] - ay;
    const acz = t[o + 8] - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let u;
    let v;
    if (d1 <= 0 && d2 <= 0) {
        u = 0;
        v = 0;
    } else {
        const bpx = px - t[o + 3];
        const bpy = py - t[o + 4];
        const bpz = pz - t[o + 5];
        const d3 = abx * bpx + aby * bpy + abz * bpz;
        const d4 = acx * bpx + acy * bpy + acz * bpz;
        const cpx = px - t[o + 6];
        const cpy = py - t[o + 7];
        const cpz = pz - t[o + 8];
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        const vc = d1 * d4 - d3 * d2;
        const vb = d5 * d2 - d1 * d6;
        const va = d3 * d6 - d5 * d4;
        if (d3 >= 0 && d4 <= d3) {
            u = 1;
            v = 0;
        } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
            u = d1 / (d1 - d3);
            v = 0;
        } else if (d6 >= 0 && d5 <= d6) {
            u = 0;
            v = 1;
        } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            u = 0;
            v = d2 / (d2 - d6);
        } else if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
            const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
            u = 1 - w;
            v = w;
        } else {
            const denom = 1 / (va + vb + vc);
            u = vb * denom;
            v = vc * denom;
        }
    }
    const dx = apx - abx * u - acx * v;
    const dy = apy - aby * u - acy * v;
    const dz = apz - abz * u - acz * v;
    return dx * dx + dy * dy + dz * dz;
}

/**
 * Edge function of the ray point (pu, pv) against the edge from (au, av) to (bu, bv), as seen by
 * the ray moved by (ε, ε²): never zero unless the edge has no length.
 *
 * Computed with the endpoints in one canonical order and negated when they come the other way, so
 * the two triangles of an edge get exactly opposite values.
 *
 * @param {number} au Edge start u.
 * @param {number} av Edge start v.
 * @param {number} bu Edge end u.
 * @param {number} bv Edge end v.
 * @param {number} pu Point u.
 * @param {number} pv Point v.
 * @returns {number[]} [value, sign], sign −1, 0 or 1 of the moved ray.
 */
function edgeFunction(au, av, bu, bv, pu, pv) {
    const swap = bu < au || (bu === au && bv < av);
    const su = swap ? bu : au;
    const sv = swap ? bv : av;
    const eu = swap ? au : bu;
    const ev = swap ? av : bv;
    let value = (eu - su) * (pv - sv) - (ev - sv) * (pu - su);
    let sign = value > 0 ? 1 : (value < 0 ? -1 : 0);
    if (sign === 0) {
        // Moved by (ε, ε²): value' = value − (ev − sv) ε + (eu − su) ε².
        const dv = ev - sv;
        sign = dv !== 0 ? (dv > 0 ? -1 : 1) : (eu !== su ? 1 : 0);
    }
    if (swap) {
        value = -value;
        sign = -sign;
    }
    return [value, sign];
}

/**
 * Adds a vote for every voxel the rays along one axis find inside the mesh.
 *
 * @param {import('./grid.js').Grid} grid The grid.
 * @param {Float64Array} tris Triangles.
 * @param {number} axis The ray axis: 0 x, 1 y, 2 z.
 * @param {Uint8Array} votes Votes per voxel.
 * @returns {void}
 */
function voteAxis(grid, tris, axis, votes) {
    const dims = [grid.nx, grid.ny, grid.nz];
    const centre = [grid.cx, grid.cy, grid.cz];
    const voxel = grid.voxel;
    const ua = (axis + 1) % 3;
    const va = (axis + 2) % 3;
    const nu = dims[ua];
    const nv = dims[va];
    const nw = dims[axis];
    const rows = new Array(nu * nv);
    for (let o = 0; o < tris.length; o += 9) {
        const u0 = tris[o + ua];
        const v0 = tris[o + va];
        const u1 = tris[o + 3 + ua];
        const v1 = tris[o + 3 + va];
        const u2 = tris[o + 6 + ua];
        const v2 = tris[o + 6 + va];
        const lo = Math.max(0, Math.ceil(Math.min(u0, u1, u2) / voxel + centre[ua]) - 1);
        const hi = Math.min(nu - 1, Math.floor(Math.max(u0, u1, u2) / voxel + centre[ua]) + 1);
        const lov = Math.max(0, Math.ceil(Math.min(v0, v1, v2) / voxel + centre[va]) - 1);
        const hiv = Math.min(nv - 1, Math.floor(Math.max(v0, v1, v2) / voxel + centre[va]) + 1);
        for (let jv = lov; jv <= hiv; jv++) {
            const pv = (jv - centre[va]) * voxel;
            for (let ju = lo; ju <= hi; ju++) {
                const pu = (ju - centre[ua]) * voxel;
                const [e0, s0] = edgeFunction(u1, v1, u2, v2, pu, pv);
                if (s0 === 0) {
                    continue;
                }
                const [e1, s1] = edgeFunction(u2, v2, u0, v0, pu, pv);
                if (s1 !== s0) {
                    continue;
                }
                const [e2, s2] = edgeFunction(u0, v0, u1, v1, pu, pv);
                const sum = e0 + e1 + e2;
                if (s2 !== s0 || sum === 0) {
                    continue;
                }
                const w = (e0 * tris[o + axis] + e1 * tris[o + 3 + axis] + e2 * tris[o + 6 + axis]) / sum;
                const r = ju + nu * jv;
                if (!rows[r]) {
                    rows[r] = [];
                }
                rows[r].push(w);
            }
        }
    }
    const stride = [1, grid.nx, grid.nx * grid.ny];
    for (let jv = 0; jv < nv; jv++) {
        for (let ju = 0; ju < nu; ju++) {
            const hits = rows[ju + nu * jv];
            if (!hits || hits.length < 2) {
                continue;
            }
            hits.sort((a, b) => a - b);
            let h = 0;
            const base = ju * stride[ua] + jv * stride[va];
            for (let k = 0; k < nw; k++) {
                const pw = (k - centre[axis]) * voxel;
                while (h < hits.length && hits[h] < pw) {
                    h++;
                }
                // Odd crossings behind and at least one ahead: inside.
                if ((h & 1) === 1 && h < hits.length) {
                    votes[base + k * stride[axis]]++;
                }
            }
        }
    }
}

/**
 * Fills a grid with a triangle mesh (already fitted to the sculpture): quantised signed distances,
 * clamped to the band, and +band on the outer border voxels of every face.
 *
 * @param {import('./grid.js').Grid} grid The grid to fill (overwritten).
 * @param {Float64Array} tris Triangles, sculpture-local metres.
 * @returns {import('./grid.js').Grid} The grid.
 */
export function fillMesh(grid, tris) {
    const {nx, ny, nz, voxel, band, data} = grid;
    const d2 = new Float64Array(nx * ny * nz);
    d2.fill(band * band);
    for (let o = 0; o < tris.length; o += 9) {
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let n = 0; n < 9; n++) {
            const a = n % 3;
            lo[a] = tris[o + n] < lo[a] ? tris[o + n] : lo[a];
            hi[a] = tris[o + n] > hi[a] ? tris[o + n] : hi[a];
        }
        const i0 = Math.max(0, Math.ceil((lo[0] - band) / voxel + grid.cx));
        const i1 = Math.min(nx - 1, Math.floor((hi[0] + band) / voxel + grid.cx));
        const j0 = Math.max(0, Math.ceil((lo[1] - band) / voxel + grid.cy));
        const j1 = Math.min(ny - 1, Math.floor((hi[1] + band) / voxel + grid.cy));
        const k0 = Math.max(0, Math.ceil((lo[2] - band) / voxel + grid.cz));
        const k1 = Math.min(nz - 1, Math.floor((hi[2] + band) / voxel + grid.cz));
        for (let k = k0; k <= k1; k++) {
            const z = (k - grid.cz) * voxel;
            for (let j = j0; j <= j1; j++) {
                const y = (j - grid.cy) * voxel;
                let idx = i0 + nx * (j + ny * k);
                for (let i = i0; i <= i1; i++, idx++) {
                    const d = distance2((i - grid.cx) * voxel, y, z, tris, o);
                    if (d < d2[idx]) {
                        d2[idx] = d;
                    }
                }
            }
        }
    }
    const votes = new Uint8Array(nx * ny * nz);
    voteAxis(grid, tris, 0, votes);
    voteAxis(grid, tris, 1, votes);
    voteAxis(grid, tris, 2, votes);
    const outside = grid.levels[grid.levels.length - 1];
    let idx = 0;
    for (let k = 0; k < nz; k++) {
        const zb = k < BORDER || k >= nz - BORDER;
        for (let j = 0; j < ny; j++) {
            const yb = zb || j < BORDER || j >= ny - BORDER;
            for (let i = 0; i < nx; i++, idx++) {
                if (yb || i < BORDER || i >= nx - BORDER) {
                    data[idx] = outside;
                } else {
                    const d = Math.sqrt(d2[idx]);
                    data[idx] = grid.quant(votes[idx] >= 2 ? -d : d);
                }
            }
        }
    }
    return grid;
}

/**
 * Fills a grid with an uploaded model: read, fitted (longest side FIT metres, less on a grid too small
 * for that) and voxelised.
 *
 * @param {import('./grid.js').Grid} grid The grid to fill (overwritten).
 * @param {ArrayBuffer|ArrayBufferView} bytes The file.
 * @param {string} format 'stl', 'obj' or 'glb'.
 * @returns {import('./grid.js').Grid} The grid.
 * @throws {Error} When the file cannot be read.
 */
export function fillUpload(grid, bytes, format) {
    // Clear of the border and the band on both sides, with a voxel to spare.
    const room = (Math.min(grid.nx, grid.ny, grid.nz) - 2 * BORDER - 2) * grid.voxel - 2 * grid.band;
    return fillMesh(grid, fitTriangles(parseModel(bytes, format), Math.min(FIT, room)));
}
