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
 * Writers for the open model formats a sculpture exports to.
 *
 * All take an indexed mesh `{positions: Float32Array, normals: Float32Array, indices: Uint32Array}` in
 * sculpture-local metres, Y up, triangles wound counter-clockwise seen from outside (the mesher's
 * meshAll() output), and return the file bytes.
 *
 * - STL (binary): millimetres, Z up. Print (x, y, z) = (x, −z, y) × 1000, a proper rotation, so the
 *   winding stays outward. Facet normals are recomputed from each printed triangle.
 * - glTF 2.0 binary (.glb): metres, Y up, one mesh with POSITION (with min/max), NORMAL and
 *   UNSIGNED_INT indices and a clay-coloured PBR material; asset.generator "mod_vrmakerspace".
 * - 3MF: an OPC zip ([Content_Types].xml, _rels/.rels, 3D/3dmodel.model), core 2015/02 model,
 *   unit millimeter, Z up, same orientation as the STL.
 *
 * Dependency-free apart from the sibling zip writer; runs in a Web Worker and in Node.
 *
 * @module     mod_vrmakerspace/engine/export
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {createZip} from './zip.js';

/** glTF component type FLOAT. */
const GL_FLOAT = 5126;

/** glTF component type UNSIGNED_INT. */
const GL_UNSIGNED_INT = 5125;

/** glTF buffer view target ARRAY_BUFFER. */
const GL_ARRAY_BUFFER = 34962;

/** glTF buffer view target ELEMENT_ARRAY_BUFFER. */
const GL_ELEMENT_ARRAY_BUFFER = 34963;

/** The 3MF core specification namespace. */
const NS_3MF = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/**
 * Normalises the input mesh to typed arrays.
 *
 * @param {object} mesh The mesh ({positions, normals, indices}).
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array, vertices: number,
 *     triangles: number}} The mesh as typed arrays with counts.
 */
function prepare(mesh) {
    const src = mesh || {};
    const positions = src.positions instanceof Float32Array ? src.positions : Float32Array.from(src.positions || []);
    const indices = src.indices instanceof Uint32Array ? src.indices : Uint32Array.from(src.indices || []);
    let normals = src.normals instanceof Float32Array ? src.normals : Float32Array.from(src.normals || []);
    const vertices = Math.floor(positions.length / 3);
    if (normals.length !== vertices * 3) {
        normals = vertexNormals(positions, indices, vertices);
    }
    return {positions, normals, indices, vertices, triangles: Math.floor(indices.length / 3)};
}

/**
 * Computes area-weighted vertex normals, for a mesh given without usable normals.
 *
 * @param {Float32Array} positions Vertex positions.
 * @param {Uint32Array} indices Triangle indices.
 * @param {number} vertices Vertex count.
 * @returns {Float32Array} Unit normals.
 */
function vertexNormals(positions, indices, vertices) {
    const acc = new Float64Array(vertices * 3);
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = indices[t] * 3;
        const b = indices[t + 1] * 3;
        const c = indices[t + 2] * 3;
        const ux = positions[b] - positions[a];
        const uy = positions[b + 1] - positions[a + 1];
        const uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a];
        const vy = positions[c + 1] - positions[a + 1];
        const vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) {
            acc[v] += nx;
            acc[v + 1] += ny;
            acc[v + 2] += nz;
        }
    }
    const out = new Float32Array(vertices * 3);
    for (let v = 0; v < vertices * 3; v += 3) {
        const len = Math.sqrt(acc[v] * acc[v] + acc[v + 1] * acc[v + 1] + acc[v + 2] * acc[v + 2]);
        if (len > 0) {
            out[v] = acc[v] / len;
            out[v + 1] = acc[v + 1] / len;
            out[v + 2] = acc[v + 2] / len;
        } else {
            out[v + 1] = 1;
        }
    }
    return out;
}

/**
 * Writes a binary STL file (millimetres, Z up).
 *
 * @param {object} mesh The mesh ({positions, normals, indices}, metres, Y up).
 * @returns {Uint8Array} The STL bytes: 80-byte header, triangle count, 50 bytes per triangle.
 */
export function toSTL(mesh) {
    const m = prepare(mesh);
    const out = new Uint8Array(84 + 50 * m.triangles);
    const dv = new DataView(out.buffer);
    // The header must not start with "solid", or some readers take the file for ASCII STL.
    const header = 'mod_vrmakerspace binary STL; units: millimetres; Z up';
    for (let n = 0; n < header.length && n < 80; n++) {
        out[n] = header.charCodeAt(n) & 0x7F;
    }
    dv.setUint32(80, m.triangles, true);
    const p = m.positions;
    const pt = new Float64Array(9);
    let o = 84;
    for (let t = 0; t < m.triangles; t++) {
        for (let corner = 0; corner < 3; corner++) {
            const v = m.indices[t * 3 + corner] * 3;
            pt[corner * 3] = p[v] * 1000;
            pt[corner * 3 + 1] = -p[v + 2] * 1000;
            pt[corner * 3 + 2] = p[v + 1] * 1000;
        }
        const ux = pt[3] - pt[0];
        const uy = pt[4] - pt[1];
        const uz = pt[5] - pt[2];
        const vx = pt[6] - pt[0];
        const vy = pt[7] - pt[1];
        const vz = pt[8] - pt[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
            nx /= len;
            ny /= len;
            nz /= len;
        }
        dv.setFloat32(o, nx, true);
        dv.setFloat32(o + 4, ny, true);
        dv.setFloat32(o + 8, nz, true);
        for (let n = 0; n < 9; n++) {
            dv.setFloat32(o + 12 + n * 4, pt[n], true);
        }
        dv.setUint16(o + 48, 0, true);
        o += 50;
    }
    return out;
}

/**
 * Pads a length up to a multiple of 4.
 *
 * @param {number} n The length.
 * @returns {number} The padded length.
 */
function pad4(n) {
    return (n + 3) & ~3;
}

/**
 * Writes a glTF 2.0 binary file (metres, Y up).
 *
 * @param {object} mesh The mesh ({positions, normals, indices}, metres, Y up).
 * @param {{name: (string|undefined)}} [options] `name`: node and mesh name (default "sculpture").
 * @returns {Uint8Array} The GLB bytes.
 */
export function toGLB(mesh, options = {}) {
    const m = prepare(mesh);
    const name = typeof options.name === 'string' && options.name !== '' ? options.name : 'sculpture';
    const gltf = {
        asset: {version: '2.0', generator: 'mod_vrmakerspace'},
        scene: 0,
        scenes: [{name, nodes: []}],
        nodes: [],
    };
    let bin = new Uint8Array(0);
    if (m.vertices > 0 && m.triangles > 0) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < m.vertices * 3; v += 3) {
            for (let a = 0; a < 3; a++) {
                const value = m.positions[v + a];
                min[a] = Math.min(min[a], value);
                max[a] = Math.max(max[a], value);
            }
        }
        const posBytes = m.vertices * 12;
        const normBytes = m.vertices * 12;
        const idxBytes = m.triangles * 12;
        bin = new Uint8Array(posBytes + normBytes + idxBytes);
        bin.set(new Uint8Array(m.positions.buffer, m.positions.byteOffset, posBytes), 0);
        bin.set(new Uint8Array(m.normals.buffer, m.normals.byteOffset, normBytes), posBytes);
        bin.set(new Uint8Array(m.indices.buffer, m.indices.byteOffset, idxBytes), posBytes + normBytes);
        if (!littleEndian()) {
            swapWords(bin);
        }
        gltf.scenes[0].nodes = [0];
        gltf.nodes = [{name, mesh: 0}];
        gltf.meshes = [{name, primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2, material: 0, mode: 4}]}];
        gltf.materials = [{
            name: 'clay',
            pbrMetallicRoughness: {baseColorFactor: [0.78, 0.62, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.85},
            doubleSided: false,
        }];
        gltf.buffers = [{byteLength: bin.length}];
        gltf.bufferViews = [
            {buffer: 0, byteOffset: 0, byteLength: posBytes, byteStride: 12, target: GL_ARRAY_BUFFER},
            {buffer: 0, byteOffset: posBytes, byteLength: normBytes, byteStride: 12, target: GL_ARRAY_BUFFER},
            {buffer: 0, byteOffset: posBytes + normBytes, byteLength: idxBytes, target: GL_ELEMENT_ARRAY_BUFFER},
        ];
        gltf.accessors = [
            {bufferView: 0, componentType: GL_FLOAT, count: m.vertices, type: 'VEC3', min, max},
            {bufferView: 1, componentType: GL_FLOAT, count: m.vertices, type: 'VEC3'},
            {bufferView: 2, componentType: GL_UNSIGNED_INT, count: m.triangles * 3, type: 'SCALAR'},
        ];
    }

    const json = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonLen = pad4(json.length);
    const binLen = pad4(bin.length);
    const total = 12 + 8 + jsonLen + (bin.length > 0 ? 8 + binLen : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true);
    dv.setUint32(16, 0x4E4F534A, true);
    out.set(json, 20);
    out.fill(0x20, 20 + json.length, 20 + jsonLen);
    if (bin.length > 0) {
        const at = 20 + jsonLen;
        dv.setUint32(at, binLen, true);
        dv.setUint32(at + 4, 0x004E4942, true);
        out.set(bin, at + 8);
    }
    return out;
}

/**
 * Whether this platform stores typed arrays little-endian (every browser and Node on x86 and ARM).
 *
 * @returns {boolean} True on a little-endian platform.
 */
function littleEndian() {
    return new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
}

/**
 * Reverses the byte order of every 4-byte word in place (big-endian platforms only).
 *
 * @param {Uint8Array} bytes Bytes whose length is a multiple of 4.
 * @returns {void}
 */
function swapWords(bytes) {
    for (let n = 0; n + 3 < bytes.length; n += 4) {
        const a = bytes[n];
        const b = bytes[n + 1];
        bytes[n] = bytes[n + 3];
        bytes[n + 1] = bytes[n + 2];
        bytes[n + 2] = b;
        bytes[n + 3] = a;
    }
}

/**
 * Formats a millimetre coordinate for the 3MF model: at most 4 decimals, no exponent.
 *
 * @param {number} v The value in millimetres.
 * @returns {string} The number as text.
 */
function num(v) {
    const r = Math.round(v * 10000) / 10000;
    return r === 0 ? '0' : String(r);
}

/**
 * Escapes text for an XML attribute value.
 *
 * @param {string} s The text.
 * @returns {string} The escaped text.
 */
function xmlAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Writes a 3MF package (millimetres, Z up).
 *
 * @param {object} mesh The mesh ({positions, normals, indices}, metres, Y up).
 * @param {{name: (string|undefined), date: (Date|undefined)}} [options] `name`: object name (default
 *     "sculpture"); `date`: zip entry time (default now).
 * @returns {Uint8Array} The 3MF (zip) bytes.
 */
export function to3MF(mesh, options = {}) {
    const m = prepare(mesh);
    const name = typeof options.name === 'string' && options.name !== '' ? options.name : 'sculpture';
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    parts.push('<model unit="millimeter" xml:lang="en-US" xmlns="' + NS_3MF + '">\n');
    parts.push(' <metadata name="Application">mod_vrmakerspace</metadata>\n');
    parts.push(' <metadata name="Title">' + xmlAttr(name) + '</metadata>\n');
    parts.push(' <resources>\n');
    const hasMesh = m.vertices > 0 && m.triangles > 0;
    if (hasMesh) {
        parts.push('  <object id="1" type="model" name="' + xmlAttr(name) + '">\n   <mesh>\n    <vertices>\n');
        const p = m.positions;
        for (let v = 0; v < m.vertices * 3; v += 3) {
            parts.push('     <vertex x="' + num(p[v] * 1000) + '" y="' + num(-p[v + 2] * 1000) + '" z="'
                + num(p[v + 1] * 1000) + '"/>\n');
        }
        parts.push('    </vertices>\n    <triangles>\n');
        const idx = m.indices;
        for (let t = 0; t < m.triangles * 3; t += 3) {
            parts.push('     <triangle v1="' + idx[t] + '" v2="' + idx[t + 1] + '" v3="' + idx[t + 2] + '"/>\n');
        }
        parts.push('    </triangles>\n   </mesh>\n  </object>\n');
    }
    parts.push(' </resources>\n');
    parts.push(hasMesh ? ' <build>\n  <item objectid="1"/>\n </build>\n' : ' <build/>\n');
    parts.push('</model>\n');

    const contentTypes = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        + '</Types>\n';
    const rels = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
        + 'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        + '</Relationships>\n';

    return createZip([
        {name: '[Content_Types].xml', data: contentTypes},
        {name: '_rels/.rels', data: rels},
        {name: '3D/3dmodel.model', data: parts.join('')},
    ], {date: options.date});
}
