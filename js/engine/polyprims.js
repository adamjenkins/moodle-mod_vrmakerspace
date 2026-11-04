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
 * The basic shapes of the Model method, as polygon meshes.
 *
 * All are centred on the point given, with local Y up, and closed and wound outward, except the plane,
 * a single quad facing +Y. Sizes, for size r: cube edge 2r; plane side 2r; cylinder radius r, height 2r;
 * sphere radius r; cone base radius r, height 2r; torus outer radius r (ring 0.7 r, tube 0.3 r). With n
 * segments the sphere has max(2, ⌊n / 2⌋) rings and the torus tube max(3, ⌊n / 2⌋) segments.
 *
 * Ring corners run counter-clockwise seen from +Y: (r cos θ, y, −r sin θ). Vertices take the first
 * element numbers of the op, faces the ones after.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/polyprims
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {PI, TWO_PI, cos, sin} from './mathx.js';
import {MAX_FACES, MAX_VERTS, elementId} from './polymesh.js';

/** The shape names. */
export const PRIM_SHAPES = Object.freeze(['cube', 'plane', 'cylinder', 'sphere', 'cone', 'torus']);

/** Segments when none are given. */
export const DEFAULT_SEGMENTS = 16;

/** Fewest segments of a round shape. */
export const MIN_SEGMENTS = 3;

/** Most segments of a round shape. */
export const MAX_SEGMENTS = 48;

/** Torus ring radius as a share of the size. */
const TORUS_RING = 0.7;

/** Torus tube radius as a share of the size. */
const TORUS_TUBE = 0.3;

/**
 * A usable number of segments.
 *
 * @param {number} [segments] As asked for.
 * @returns {number} An integer in MIN_SEGMENTS..MAX_SEGMENTS, DEFAULT_SEGMENTS when not given.
 */
function cleanSegments(segments) {
    if (!Number.isFinite(segments)) {
        return DEFAULT_SEGMENTS;
    }
    return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.floor(segments)));
}

/**
 * Appends a ring of points round the Y axis.
 *
 * @param {number[][]} points Receives the points.
 * @param {number} n Points in the ring.
 * @param {number} radius The ring's radius.
 * @param {number} y The ring's height.
 * @returns {number} The index of the ring's first point.
 */
function pushRing(points, n, radius, y) {
    const first = points.length;
    for (let i = 0; i < n; i++) {
        const angle = TWO_PI * i / n;
        points.push([radius * cos(angle), y, -radius * sin(angle)]);
    }
    return first;
}

/**
 * The quads between two rings, wound outward when `lower` is below `upper`.
 *
 * @param {number[][]} faces Receives the faces.
 * @param {number} n Points per ring.
 * @param {number} lower Index of the lower ring's first point.
 * @param {number} upper Index of the upper ring's first point.
 * @returns {void}
 */
function pushBand(faces, n, lower, upper) {
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push([lower + i, lower + j, upper + j, upper + i]);
    }
}

/**
 * The face closing a ring.
 *
 * @param {number} n Points in the ring.
 * @param {number} first Index of its first point.
 * @param {boolean} up True for a face looking up, false for one looking down.
 * @returns {number[]} The face.
 */
function ringFace(n, first, up) {
    const list = [];
    for (let i = 0; i < n; i++) {
        list.push(up ? first + i : first + n - 1 - i);
    }
    return list;
}

/**
 * The shape about the origin.
 *
 * @param {string} shape The shape's name.
 * @param {number} r Its size.
 * @param {number} n Its segments.
 * @returns {?{points: number[][], faces: number[][]}} Points and faces of point indices; null for an unknown shape.
 */
function buildShape(shape, r, n) {
    const points = [];
    const faces = [];
    switch (shape) {
        case 'cube':
            for (let c = 0; c < 8; c++) {
                points.push([c & 1 ? r : -r, c & 2 ? r : -r, c & 4 ? r : -r]);
            }
            faces.push([1, 3, 7, 5], [0, 4, 6, 2], [2, 6, 7, 3], [0, 1, 5, 4], [4, 5, 7, 6], [0, 2, 3, 1]);
            break;
        case 'plane':
            points.push([-r, 0, -r], [-r, 0, r], [r, 0, r], [r, 0, -r]);
            faces.push([0, 1, 2, 3]);
            break;
        case 'cylinder': {
            const lower = pushRing(points, n, r, -r);
            const upper = pushRing(points, n, r, r);
            pushBand(faces, n, lower, upper);
            faces.push(ringFace(n, upper, true), ringFace(n, lower, false));
            break;
        }
        case 'cone': {
            const base = pushRing(points, n, r, -r);
            const tip = points.length;
            points.push([0, r, 0]);
            for (let i = 0; i < n; i++) {
                faces.push([base + i, base + (i + 1) % n, tip]);
            }
            faces.push(ringFace(n, base, false));
            break;
        }
        case 'sphere': {
            const rings = Math.max(2, Math.floor(n / 2));
            const top = points.length;
            points.push([0, r, 0]);
            const firstRing = points.length;
            for (let j = 1; j < rings; j++) {
                const angle = PI * j / rings;
                pushRing(points, n, r * sin(angle), r * cos(angle));
            }
            const bottom = points.length;
            points.push([0, -r, 0]);
            for (let i = 0; i < n; i++) {
                faces.push([top, firstRing + i, firstRing + (i + 1) % n]);
            }
            for (let j = 0; j + 2 < rings; j++) {
                pushBand(faces, n, firstRing + (j + 1) * n, firstRing + j * n);
            }
            const lastRing = firstRing + (rings - 2) * n;
            for (let i = 0; i < n; i++) {
                faces.push([bottom, lastRing + (i + 1) % n, lastRing + i]);
            }
            break;
        }
        case 'torus': {
            const m = Math.max(3, Math.floor(n / 2));
            for (let i = 0; i < n; i++) {
                const around = TWO_PI * i / n;
                const cx = cos(around);
                const cz = -sin(around);
                for (let j = 0; j < m; j++) {
                    const tube = TWO_PI * j / m;
                    const reach = TORUS_RING * r + TORUS_TUBE * r * cos(tube);
                    points.push([reach * cx, TORUS_TUBE * r * sin(tube), reach * cz]);
                }
            }
            for (let i = 0; i < n; i++) {
                const i1 = (i + 1) % n;
                for (let j = 0; j < m; j++) {
                    const j1 = (j + 1) % m;
                    faces.push([i * m + j, i1 * m + j, i1 * m + j1, i * m + j1]);
                }
            }
            break;
        }
        default:
            return null;
    }
    return {points, faces};
}

/**
 * How many vertices and faces a shape has.
 *
 * @param {string} shape The shape's name.
 * @param {number} [segments] Its segments.
 * @returns {?{verts: number, faces: number}} The counts; null for an unknown shape.
 */
export function primitiveCounts(shape, segments) {
    const built = buildShape(shape, 1, cleanSegments(segments));
    return built ? {verts: built.points.length, faces: built.faces.length} : null;
}

/**
 * Why a shape cannot be added.
 *
 * @param {PolyDoc} doc The document.
 * @param {string} shape The shape's name.
 * @param {string} author The op's author.
 * @param {number} opIndex The op's index.
 * @param {number} [segments] Its segments.
 * @returns {?string} 'limit' when the document has no room, 'conflict' when an id is taken, 'empty' for an unknown
 *     shape, or null when it can be added.
 */
export function primitiveRefusal(doc, shape, author, opIndex, segments) {
    const counts = primitiveCounts(shape, segments);
    if (!counts) {
        return 'empty';
    }
    if (doc.verts.size + counts.verts > MAX_VERTS || doc.faces.size + counts.faces > MAX_FACES) {
        return 'limit';
    }
    for (let n = 0; n < counts.verts; n++) {
        if (doc.verts.has(elementId(author, opIndex, n))) {
            return 'conflict';
        }
    }
    for (let n = 0; n < counts.faces; n++) {
        if (doc.faces.has(elementId(author, opIndex, counts.verts + n))) {
            return 'conflict';
        }
    }
    return null;
}

/**
 * Adds a basic shape to a document.
 *
 * @param {PolyDoc} doc The document.
 * @param {string} shape cube, plane, cylinder, sphere, cone or torus.
 * @param {string} author The op's author.
 * @param {number} opIndex The op's index.
 * @param {number[]} p Its centre.
 * @param {number} size Its size (half-extent or radius).
 * @param {?number[]} [axis] The axis of an optional turn; it need not be a unit vector.
 * @param {number} [angle] The turn in radians.
 * @param {number} [segments] Segments of a round shape (default 16, 3..48).
 * @returns {number[]} The ids of the new faces; empty, with nothing changed, when primitiveRefusal gives a reason.
 */
export function addPrimitive(doc, shape, author, opIndex, p, size, axis, angle, segments) {
    if (primitiveRefusal(doc, shape, author, opIndex, segments) !== null) {
        return [];
    }
    const {points, faces} = buildShape(shape, size, cleanSegments(segments));

    let kx = 0;
    let ky = 0;
    let kz = 0;
    const turning = axis && Number.isFinite(angle) && angle !== 0;
    if (turning) {
        const l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
        if (l > 0) {
            kx = axis[0] / l;
            ky = axis[1] / l;
            kz = axis[2] / l;
        }
    }
    const turned = kx !== 0 || ky !== 0 || kz !== 0;
    const s = turned ? sin(angle) : 0;
    const c = turned ? cos(angle) : 1;

    const vertIds = [];
    for (let n = 0; n < points.length; n++) {
        const q = points[n];
        let x = q[0];
        let y = q[1];
        let z = q[2];
        if (turned) {
            // Rodrigues: v cos + (k × v) sin + k (k · v) (1 − cos).
            const along = (kx * x + ky * y + kz * z) * (1 - c);
            const rx = x * c + (ky * z - kz * y) * s + kx * along;
            const ry = y * c + (kz * x - kx * z) * s + ky * along;
            const rz = z * c + (kx * y - ky * x) * s + kz * along;
            x = rx;
            y = ry;
            z = rz;
        }
        const id = elementId(author, opIndex, n);
        doc.addVert(id, [p[0] + x, p[1] + y, p[2] + z]);
        vertIds.push(id);
    }
    const faceIds = [];
    for (let n = 0; n < faces.length; n++) {
        const id = elementId(author, opIndex, points.length + n);
        doc.addFace(id, faces[n].map((index) => vertIds[index]));
        faceIds.push(id);
    }
    return faceIds;
}
