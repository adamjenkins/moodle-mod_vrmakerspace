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
 * Picking on the mesh layer: which vertex, edge or face a ray or a hand points at, worked out from the drawing data
 * the engine posts (polymesh.renderData). Everything is in the sculpture-local frame.
 *
 * A ray finds the nearest triangle, seen from either side, because a face may be flipped and a plane has two sides.
 * In face mode that is the answer. In vertex and edge mode the answer is the closest element within tol × distance of
 * the ray that is not behind that triangle (with a small allowance; the elements of the face it hit are always in
 * front of it, however steeply the face is seen). A ray that misses every triangle can still take an element on the
 * mesh's outline, so edges seen edge-on stay pickable.
 *
 * No Moodle or three.js imports, so it runs in Node (tests/js/polypick.test.mjs).
 *
 * @module     mod_vrmakerspace/polypick
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Tolerance of a ray when none is given: reach as a share of the distance along it. */
const DEFAULT_TOLERANCE = 0.02;

/** How far (m) behind the triangle hit an element may lie and still count as visible. */
const BEHIND_ALLOWANCE = 0.003;

/** Added to the distance from the ray per metre along it, so that of two elements in line the nearer one wins. */
const DEPTH_BIAS = 0.01;

/** How far outside a triangle (in its barycentric coordinates) a ray still counts, so it cannot slip through a seam. */
const SEAM = 1e-6;

/** A ray parameter closer than this (m) to the origin is not a hit. */
const MIN_DISTANCE = 1e-6;

/** Below this the ray lies in the triangle's plane. */
const MIN_DETERMINANT = 1e-16;

/**
 * A point or direction as [x, y, z], from an array or an object with x, y and z.
 *
 * @param {number[]|Object} v The value.
 * @returns {number[]|null} The three numbers, or null when it is not that.
 */
const toVector = (v) => {
    if (!v) {
        return null;
    }
    const out = Array.isArray(v) ? [Number(v[0]), Number(v[1]), Number(v[2])] : [Number(v.x), Number(v.y), Number(v.z)];
    return out.every(Number.isFinite) ? out : null;
};

/**
 * Whether drawing data can be picked on.
 *
 * @param {Object} data Drawing data, or null.
 * @returns {boolean} Whether it has the arrays picking reads.
 */
const usable = (data) => !!data && !!data.vertIds && !!data.triPos;

/**
 * The nearest triangle along a ray, seen from either side (Möller and Trumbore's test).
 *
 * @param {number[]} o Ray origin.
 * @param {number[]} d Unit ray direction.
 * @param {Float32Array} pos Flat triangle corners.
 * @returns {{t: number, tri: number}|null} Distance along the ray and the triangle's index.
 */
const nearestTriangle = (o, d, pos) => {
    let best = null;
    const count = pos.length / 9;
    for (let tri = 0; tri < count; tri++) {
        const at = tri * 9;
        const ax = pos[at];
        const ay = pos[at + 1];
        const az = pos[at + 2];
        const e1x = pos[at + 3] - ax;
        const e1y = pos[at + 4] - ay;
        const e1z = pos[at + 5] - az;
        const e2x = pos[at + 6] - ax;
        const e2y = pos[at + 7] - ay;
        const e2z = pos[at + 8] - az;
        const px = d[1] * e2z - d[2] * e2y;
        const py = d[2] * e2x - d[0] * e2z;
        const pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < MIN_DETERMINANT) {
            continue;
        }
        const inv = 1 / det;
        const sx = o[0] - ax;
        const sy = o[1] - ay;
        const sz = o[2] - az;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < -SEAM || u > 1 + SEAM) {
            continue;
        }
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < -SEAM || u + v > 1 + SEAM) {
            continue;
        }
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > MIN_DISTANCE && (best === null || t < best.t)) {
            best = {t: t, tri: tri};
        }
    }
    return best;
};

/**
 * What picking a triangle gives: its face, the point and the face's own normal (never turned towards the viewer).
 *
 * @param {Object} data Drawing data.
 * @param {number} tri Triangle index.
 * @param {number[]} point The point on it.
 * @returns {{kind: string, id: number, point: number[], normal: number[]}} The hit.
 */
const faceHit = (data, tri, point) => {
    const at = tri * 9;
    return {
        kind: 'f',
        id: data.faceIds[data.triFace[tri]],
        point: point,
        normal: [data.triNormal[at], data.triNormal[at + 1], data.triNormal[at + 2]],
    };
};

/**
 * The vertex indices of a face.
 *
 * @param {Object} data Drawing data.
 * @param {number} face Face index.
 * @returns {Set<number>} Its vertex indices.
 */
const faceCorners = (data, face) => {
    const out = new Set();
    for (let c = data.faceStart[face]; c < data.faceStart[face + 1]; c++) {
        out.add(data.faceVerts[c]);
    }
    return out;
};

/**
 * The closest vertex to a ray.
 *
 * @param {number[]} o Ray origin.
 * @param {number[]} d Unit ray direction.
 * @param {Object} data Drawing data.
 * @param {number} tol Reach as a share of the distance along the ray.
 * @param {number} limit Furthest visible distance along the ray.
 * @param {Set<number>} front Vertex indices that count as visible anyway.
 * @returns {{kind: string, id: number}|null} The hit.
 */
const rayVertex = (o, d, data, tol, limit, front) => {
    const pos = data.vertPos;
    let best = -1;
    let bestscore = Infinity;
    for (let i = 0; i < data.vertIds.length; i++) {
        const wx = pos[i * 3] - o[0];
        const wy = pos[i * 3 + 1] - o[1];
        const wz = pos[i * 3 + 2] - o[2];
        const s = wx * d[0] + wy * d[1] + wz * d[2];
        if (s <= 0 || (s > limit && !front.has(i))) {
            continue;
        }
        const off = Math.sqrt(Math.max(0, wx * wx + wy * wy + wz * wz - s * s));
        if (off > tol * s) {
            continue;
        }
        const score = off + DEPTH_BIAS * s;
        if (score < bestscore) {
            bestscore = score;
            best = i;
        }
    }
    return best === -1 ? null : {kind: 'v', id: data.vertIds[best]};
};

/**
 * The closest edge to a ray.
 *
 * @param {number[]} o Ray origin.
 * @param {number[]} d Unit ray direction.
 * @param {Object} data Drawing data.
 * @param {number} tol Reach as a share of the distance along the ray.
 * @param {number} limit Furthest visible distance along the ray.
 * @param {Set<number>} front Vertex indices of the face hit: its edges count as visible anyway.
 * @returns {{kind: string, a: number, b: number}|null} The hit, a < b.
 */
const rayEdge = (o, d, data, tol, limit, front) => {
    const pos = data.vertPos;
    const edges = data.edges;
    let best = -1;
    let bestscore = Infinity;
    for (let n = 0; n < edges.length; n += 2) {
        const a = edges[n] * 3;
        const b = edges[n + 1] * 3;
        const vx = pos[b] - pos[a];
        const vy = pos[b + 1] - pos[a + 1];
        const vz = pos[b + 2] - pos[a + 2];
        const wx = o[0] - pos[a];
        const wy = o[1] - pos[a + 1];
        const wz = o[2] - pos[a + 2];
        const uv = d[0] * vx + d[1] * vy + d[2] * vz;
        const vv = vx * vx + vy * vy + vz * vz;
        const uw = d[0] * wx + d[1] * wy + d[2] * wz;
        const vw = vx * wx + vy * wy + vz * wz;
        const den = vv - uv * uv;
        // The closest point on the segment; a segment along the ray or without length has it at its start.
        const t = den > 1e-14 ? Math.min(1, Math.max(0, (vw - uw * uv) / den)) : 0;
        const s = t * uv - uw;
        if (s <= 0 || (s > limit && !(front.has(edges[n]) && front.has(edges[n + 1])))) {
            continue;
        }
        const gx = wx + s * d[0] - t * vx;
        const gy = wy + s * d[1] - t * vy;
        const gz = wz + s * d[2] - t * vz;
        const off = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (off > tol * s) {
            continue;
        }
        const score = off + DEPTH_BIAS * s;
        if (score < bestscore) {
            bestscore = score;
            best = n;
        }
    }
    if (best === -1) {
        return null;
    }
    const first = data.vertIds[edges[best]];
    const second = data.vertIds[edges[best + 1]];
    return {kind: 'e', a: Math.min(first, second), b: Math.max(first, second)};
};

/**
 * What a ray from a point picks on the mesh.
 *
 * @param {number[]|Object} origin Ray origin, sculpture-local.
 * @param {number[]|Object} dir Ray direction, sculpture-local; its length does not matter.
 * @param {Object} data Drawing data (polymesh.renderData).
 * @param {string} mode 'v', 'e' or 'f'.
 * @param {number} [tol] In modes v and e, how far from the ray an element may be, as a share of the distance along it.
 * @returns {Object|null} {kind: 'v', id}, {kind: 'e', a, b} with a < b, {kind: 'f', id, point, normal}, or null.
 */
export const pickRay = (origin, dir, data, mode, tol) => {
    const o = toVector(origin);
    const raw = toVector(dir);
    if (!o || !raw || !usable(data)) {
        return null;
    }
    const length = Math.sqrt(raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2]);
    if (length < 1e-12) {
        return null;
    }
    const d = [raw[0] / length, raw[1] / length, raw[2] / length];
    const hit = nearestTriangle(o, d, data.triPos);
    if (mode === 'f') {
        return hit ? faceHit(data, hit.tri, [o[0] + d[0] * hit.t, o[1] + d[1] * hit.t, o[2] + d[2] * hit.t]) : null;
    }
    const reach = Number.isFinite(tol) && tol >= 0 ? tol : DEFAULT_TOLERANCE;
    const limit = hit ? hit.t + BEHIND_ALLOWANCE : Infinity;
    const front = hit ? faceCorners(data, data.triFace[hit.tri]) : new Set();
    if (mode === 'v') {
        return rayVertex(o, d, data, reach, limit, front);
    }
    return mode === 'e' ? rayEdge(o, d, data, reach, limit, front) : null;
};

/**
 * The squared distance between two points in flat arrays' terms.
 *
 * @param {number[]} p A point.
 * @param {number} x The other point's x.
 * @param {number} y Its y.
 * @param {number} z Its z.
 * @returns {number} The squared distance.
 */
const squaredTo = (p, x, y, z) => (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y) + (p[2] - z) * (p[2] - z);

/**
 * The closest vertex to a point.
 *
 * @param {number[]} p The point.
 * @param {Object} data Drawing data.
 * @param {number} most Largest squared distance.
 * @returns {{kind: string, id: number}|null} The hit.
 */
const nearVertex = (p, data, most) => {
    const pos = data.vertPos;
    let best = -1;
    let bestdist = most;
    for (let i = 0; i < data.vertIds.length; i++) {
        const dist = squaredTo(p, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        if (dist <= bestdist) {
            bestdist = dist;
            best = i;
        }
    }
    return best === -1 ? null : {kind: 'v', id: data.vertIds[best]};
};

/**
 * The closest edge to a point.
 *
 * @param {number[]} p The point.
 * @param {Object} data Drawing data.
 * @param {number} most Largest squared distance.
 * @returns {{kind: string, a: number, b: number}|null} The hit, a < b.
 */
const nearEdge = (p, data, most) => {
    const pos = data.vertPos;
    const edges = data.edges;
    let best = -1;
    let bestdist = most;
    for (let n = 0; n < edges.length; n += 2) {
        const a = edges[n] * 3;
        const b = edges[n + 1] * 3;
        const vx = pos[b] - pos[a];
        const vy = pos[b + 1] - pos[a + 1];
        const vz = pos[b + 2] - pos[a + 2];
        const vv = vx * vx + vy * vy + vz * vz;
        const along = vx * (p[0] - pos[a]) + vy * (p[1] - pos[a + 1]) + vz * (p[2] - pos[a + 2]);
        const t = vv > 1e-14 ? Math.min(1, Math.max(0, along / vv)) : 0;
        const dist = squaredTo(p, pos[a] + vx * t, pos[a + 1] + vy * t, pos[a + 2] + vz * t);
        if (dist <= bestdist) {
            bestdist = dist;
            best = n;
        }
    }
    if (best === -1) {
        return null;
    }
    const first = data.vertIds[edges[best]];
    const second = data.vertIds[edges[best + 1]];
    return {kind: 'e', a: Math.min(first, second), b: Math.max(first, second)};
};

/**
 * The dot product u · v.
 *
 * @param {number[]} u A vector.
 * @param {number[]} v A vector.
 * @returns {number} The dot product.
 */
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/**
 * The closest point of a triangle to a point, by which of its regions the point's projection falls in.
 *
 * @param {number[]} p The point.
 * @param {Float32Array} pos Flat triangle corners.
 * @param {number} at Offset of the triangle's first corner.
 * @returns {number[]} The closest point.
 */
const closestOnTriangle = (p, pos, at) => {
    const a = [pos[at], pos[at + 1], pos[at + 2]];
    const ab = [pos[at + 3] - a[0], pos[at + 4] - a[1], pos[at + 5] - a[2]];
    const ac = [pos[at + 6] - a[0], pos[at + 7] - a[1], pos[at + 8] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    /**
     * The point at given shares along the triangle's two sides from its first corner.
     *
     * @param {number} s Share of the side to the second corner.
     * @param {number} t Share of the side to the third corner.
     * @returns {number[]} The point.
     */
    const at2 = (s, t) => [a[0] + ab[0] * s + ac[0] * t, a[1] + ab[1] * s + ac[1] * t, a[2] + ab[2] * s + ac[2] * t];
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) {
        return a;
    }
    const bp = [ap[0] - ab[0], ap[1] - ab[1], ap[2] - ab[2]];
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) {
        return at2(1, 0);
    }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        return at2(d1 - d3 === 0 ? 0 : d1 / (d1 - d3), 0);
    }
    const cp = [ap[0] - ac[0], ap[1] - ac[1], ap[2] - ac[2]];
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) {
        return at2(0, 1);
    }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        return at2(0, d2 - d6 === 0 ? 0 : d2 / (d2 - d6));
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = d4 - d3 + d5 - d6 === 0 ? 0 : (d4 - d3) / (d4 - d3 + d5 - d6);
        return at2(1 - w, w);
    }
    const total = va + vb + vc;
    return total === 0 ? a : at2(vb / total, vc / total);
};

/**
 * The closest face to a point.
 *
 * @param {number[]} p The point.
 * @param {Object} data Drawing data.
 * @param {number} most Largest squared distance.
 * @returns {{kind: string, id: number, point: number[], normal: number[]}|null} The hit.
 */
const nearFace = (p, data, most) => {
    const pos = data.triPos;
    const count = pos.length / 9;
    let best = -1;
    let bestdist = most;
    let bestpoint = null;
    let reach = Math.sqrt(most);
    for (let tri = 0; tri < count; tri++) {
        const at = tri * 9;
        // A hand reaches only a little way: most triangles are out of the box round it.
        if (Math.min(pos[at], pos[at + 3], pos[at + 6]) > p[0] + reach ||
            Math.max(pos[at], pos[at + 3], pos[at + 6]) < p[0] - reach ||
            Math.min(pos[at + 1], pos[at + 4], pos[at + 7]) > p[1] + reach ||
            Math.max(pos[at + 1], pos[at + 4], pos[at + 7]) < p[1] - reach ||
            Math.min(pos[at + 2], pos[at + 5], pos[at + 8]) > p[2] + reach ||
            Math.max(pos[at + 2], pos[at + 5], pos[at + 8]) < p[2] - reach) {
            continue;
        }
        const q = closestOnTriangle(p, pos, at);
        const dist = squaredTo(p, q[0], q[1], q[2]);
        if (dist <= bestdist) {
            bestdist = dist;
            reach = Math.sqrt(dist);
            best = tri;
            bestpoint = q;
        }
    }
    return best === -1 ? null : faceHit(data, best, bestpoint);
};

/**
 * What lies closest to a point, within a radius (a hand reaching for the mesh).
 *
 * @param {number[]|Object} point The point, sculpture-local.
 * @param {number} radius How far from it to look (m).
 * @param {Object} data Drawing data (polymesh.renderData).
 * @param {string} mode 'v', 'e' or 'f'.
 * @returns {Object|null} {kind: 'v', id}, {kind: 'e', a, b} with a < b, {kind: 'f', id, point, normal}, or null.
 */
export const pickNear = (point, radius, data, mode) => {
    const p = toVector(point);
    if (!p || !usable(data) || !Number.isFinite(radius) || radius < 0) {
        return null;
    }
    const most = radius * radius;
    if (mode === 'v') {
        return nearVertex(p, data, most);
    }
    if (mode === 'e') {
        return nearEdge(p, data, most);
    }
    return mode === 'f' ? nearFace(p, data, most) : null;
};
