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
 * The polygon mesh document: vertices, n-gon faces and every author's selection.
 *
 * A PolyDoc is the mesh layer of a piece. Every client applies the same ops in the same order, so
 * everything here is deterministic: only + − × ÷ and Math.sqrt/min/max/abs/floor/round, and the
 * order of a Map is its insertion order, which copies and the serialized form preserve.
 *
 * The coordinate arrays and face lists held in a PolyDoc are frozen: a change always replaces the
 * whole array through addVert, setVert, delVert, addFace, setFace or delFace. That is what lets a
 * copy and an undo record share them, and an attempt to change one in place throws at once instead of
 * silently making clients disagree.
 *
 * A selection is stored as it was made: its items may name things since deleted, and they simply
 * do not count (selectionOf) unless an undo brings them back. They stay in the serialized form as well,
 * so a client that joins later holds the very same selection as those who were there.
 *
 * Undo is tolerant of what others have done since: MeshHistory keeps, for each ended stroke, the
 * before-image and the after-image of every vertex and face the stroke changed, and applies the
 * difference to whatever is there now.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/polymesh
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {R5} from './mathx.js';

/** Most vertices a document can hold. */
export const MAX_VERTS = 20000;

/** Most faces a document can hold. */
export const MAX_FACES = 20000;

/** Most vertices of one face. */
export const MAX_FACE_SIZE = 64;

/** Largest absolute vertex coordinate, in metres. */
export const MAX_COORD_MESH = 0.4;

/** Most elements (vertices and faces together) one op can make: n of elementId is below this. */
export const MAX_OP_ELEMENTS = 4096;

/** Largest serialized document parseDoc accepts, in bytes (also the bound for decompressing one). */
export const MAX_DOC_BYTES = 64 * 1024 * 1024;

/** Most authors a serialized document can hold selections for. */
export const MAX_DOC_AUTHORS = 4096;

/** Ended mesh strokes kept per author. */
export const MAX_MESH_RECORDS = 50;

/** Vertex and face images kept by a MeshHistory in all, across authors (oldest strokes evicted first). */
export const MAX_HISTORY_ELEMENTS = 500000;

/** Most times one mbake voxelises: a bound on the work when many parts overlap (bakeGroups). */
export const MAX_BAKE_GROUPS = 16;

/** 2^43: the factor of the author hash in an element id. */
const AUTHOR_FACTOR = 8796093022208;

/** The factor of the op index in an element id. */
const OP_FACTOR = 4096;

/** Largest op index. */
const MAX_OP_INDEX = 2147483647;

/** A Newell vector (twice the area) no longer than this is noise: the face has no direction. */
const DEGENERATE_NEWELL = 1e-13;

/** Ear clipping treats areas below this share of the squared polygon extent as zero. */
const AREA_TOLERANCE = 1e-12;

/** What an author may be called in a serialized selection. */
const AUTHOR_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * FNV-1a of an author string, reduced to 10 bits by folding.
 *
 * @param {string} author The author id.
 * @returns {number} An integer in 0..1023.
 */
function hash10(author) {
    let h = 2166136261;
    for (let n = 0; n < author.length; n++) {
        h = Math.imul(h ^ author.charCodeAt(n), 16777619) >>> 0;
    }
    return (h ^ (h >>> 10) ^ (h >>> 20)) & 1023;
}

/**
 * The id of an element made by an op, the same on every client with no message about it.
 *
 * @param {string} author The op's author.
 * @param {number} opIndex The op's index i, 0..2147483647.
 * @param {number} n Counts the elements the op makes, 0..4095.
 * @returns {number} A safe integer id.
 * @throws {RangeError} When opIndex or n is out of range: an op that needs more elements must be
 *     refused 'limit' before it asks for an id.
 */
export function elementId(author, opIndex, n) {
    if (!(n >= 0 && n < MAX_OP_ELEMENTS) || !(opIndex >= 0 && opIndex <= MAX_OP_INDEX)) {
        throw new RangeError('elementId out of range');
    }
    return hash10(author) * AUTHOR_FACTOR + opIndex * OP_FACTOR + n;
}

/**
 * The key of the undirected edge between two vertices.
 *
 * @param {number} a A vertex id.
 * @param {number} b The other vertex id.
 * @returns {string} `${lo}_${hi}` with lo < hi.
 */
export function edgeKey(a, b) {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Rounds a coordinate to 5 decimals. Never returns −0.
 *
 * @param {number} v The value.
 * @returns {number} The rounded value.
 */
export function roundR5(v) {
    return R5(v);
}

/**
 * Makes a value fit to store as a vertex coordinate: rounded and within range.
 *
 * @param {number} v The value.
 * @returns {number} The coordinate; 0 for something not finite.
 */
function cleanCoord(v) {
    if (!Number.isFinite(v)) {
        return 0;
    }
    return R5(v < -MAX_COORD_MESH ? -MAX_COORD_MESH : (v > MAX_COORD_MESH ? MAX_COORD_MESH : v));
}

/**
 * The stored form of a position.
 *
 * @param {number[]} xyz [x, y, z].
 * @returns {number[]} A new frozen array of clean coordinates.
 */
function cleanPosition(xyz) {
    return Object.freeze([cleanCoord(xyz[0]), cleanCoord(xyz[1]), cleanCoord(xyz[2])]);
}

/**
 * The first-touch before-image of every vertex and face a stroke changes. Set it as a PolyDoc's rec
 * while the stroke's ops are applied.
 */
export class Capture {
    /**
     * Creates an empty capture.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     */
    constructor(author, stroke) {
        /** @type {string} */
        this.author = author;
        /** @type {number} */
        this.stroke = stroke;
        /** Vertex id → position before the stroke, null when it did not exist. @type {Map<number, ?number[]>} */
        this.verts = new Map();
        /** Face id → vertex list before the stroke, null when it did not exist. @type {Map<number, ?number[]>} */
        this.faces = new Map();
        /** The document last written through this capture. @type {?PolyDoc} */
        this.doc = null;
    }

    /**
     * Notes a vertex about to change, unless it was already noted.
     *
     * @param {PolyDoc} doc The document.
     * @param {number} id The vertex id.
     * @returns {void}
     */
    touchVert(doc, id) {
        this.doc = doc;
        if (!this.verts.has(id)) {
            this.verts.set(id, doc.verts.get(id) || null);
        }
    }

    /**
     * Notes a face about to change, unless it was already noted.
     *
     * @param {PolyDoc} doc The document.
     * @param {number} id The face id.
     * @returns {void}
     */
    touchFace(doc, id) {
        this.doc = doc;
        if (!this.faces.has(id)) {
            this.faces.set(id, doc.faces.get(id) || null);
        }
    }
}

/**
 * Every edge used by any face.
 *
 * @param {PolyDoc} doc The document.
 * @returns {Set<string>} The edge keys.
 */
function edgeSet(doc) {
    const edges = new Set();
    for (const list of doc.faces.values()) {
        for (let c = 0; c < list.length; c++) {
            edges.add(edgeKey(list[c], list[(c + 1) % list.length]));
        }
    }
    return edges;
}

/**
 * The live items of a stored selection, without repeats.
 *
 * @param {PolyDoc} doc The document.
 * @param {{md: string, items: number[]}} stored The stored selection.
 * @param {?Set<string>} edges Every edge of the document, when already known.
 * @returns {number[]} Vertex or face ids; for edges, flat pairs lo, hi.
 */
function liveItems(doc, stored, edges) {
    const out = [];
    const items = stored.items;
    if (stored.md === 'e') {
        const known = edges || (items.length ? edgeSet(doc) : new Set());
        const seen = new Set();
        for (let n = 0; n + 1 < items.length; n += 2) {
            const key = edgeKey(items[n], items[n + 1]);
            if (known.has(key) && !seen.has(key)) {
                seen.add(key);
                out.push(Math.min(items[n], items[n + 1]), Math.max(items[n], items[n + 1]));
            }
        }
        return out;
    }
    const store = stored.md === 'f' ? doc.faces : doc.verts;
    const seen = new Set();
    for (let n = 0; n < items.length; n++) {
        if (store.has(items[n]) && !seen.has(items[n])) {
            seen.add(items[n]);
            out.push(items[n]);
        }
    }
    return out;
}

/**
 * A polygon mesh with per-author selections. All changes to vertices and faces go through its six
 * mutators, so a Capture in `rec` sees every one.
 */
export class PolyDoc {
    /**
     * Creates an empty document.
     */
    constructor() {
        /** Id → frozen [x, y, z]: sculpture-local metres, rounded, within range. @type {Map<number, number[]>} */
        this.verts = new Map();
        /** Id → frozen vertex ids, ≥ 3 distinct, counter-clockwise seen from outside. @type {Map<number, number[]>} */
        this.faces = new Map();
        /** Author → selection as stored; edges as flat lo, hi pairs. @type {Map<string, {md: string, items: number[]}>} */
        this.sel = new Map();
        /** The Capture of the stroke being applied, or null. @type {?Capture} */
        this.rec = null;
    }

    /**
     * A separate document with the same content, in the same order, and no Capture.
     *
     * @returns {PolyDoc} The copy.
     */
    copy() {
        const doc = new PolyDoc();
        doc.verts = new Map(this.verts);
        doc.faces = new Map(this.faces);
        for (const [author, stored] of this.sel) {
            doc.sel.set(author, {md: stored.md, items: stored.items.slice()});
        }
        return doc;
    }

    /**
     * Whether the document has no geometry. Selections do not count.
     *
     * @returns {boolean} True with no vertices and no faces.
     */
    isEmpty() {
        return this.verts.size === 0 && this.faces.size === 0;
    }

    /**
     * Adds a vertex.
     *
     * @param {number} id The new id.
     * @param {number[]} xyz The position; rounded and clamped.
     * @returns {void}
     */
    addVert(id, xyz) {
        this.setVert(id, xyz);
    }

    /**
     * Sets a vertex's position.
     *
     * @param {number} id The id.
     * @param {number[]} xyz The position; rounded and clamped.
     * @returns {void}
     */
    setVert(id, xyz) {
        if (this.rec) {
            this.rec.touchVert(this, id);
        }
        this.verts.set(id, cleanPosition(xyz));
    }

    /**
     * Deletes a vertex. It is the caller's business that no face still uses it.
     *
     * @param {number} id The id; nothing happens when there is none.
     * @returns {void}
     */
    delVert(id) {
        if (!this.verts.has(id)) {
            return;
        }
        if (this.rec) {
            this.rec.touchVert(this, id);
        }
        this.verts.delete(id);
    }

    /**
     * Adds a face.
     *
     * @param {number} id The new id.
     * @param {number[]} list Its vertex ids, ≥ 3 distinct, counter-clockwise seen from outside (copied).
     * @returns {void}
     */
    addFace(id, list) {
        this.setFace(id, list);
    }

    /**
     * Sets a face's vertex list.
     *
     * @param {number} id The id.
     * @param {number[]} list Its vertex ids, ≥ 3 distinct, counter-clockwise seen from outside (copied).
     * @returns {void}
     */
    setFace(id, list) {
        if (this.rec) {
            this.rec.touchFace(this, id);
        }
        this.faces.set(id, Object.freeze(Array.from(list)));
    }

    /**
     * Deletes a face.
     *
     * @param {number} id The id; nothing happens when there is none.
     * @returns {void}
     */
    delFace(id) {
        if (!this.faces.has(id)) {
            return;
        }
        if (this.rec) {
            this.rec.touchFace(this, id);
        }
        this.faces.delete(id);
    }

    /**
     * An author's selection as it stands: items that no longer exist are dropped, as are repeats.
     *
     * @param {string} author The author.
     * @returns {{md: string, items: number[]}} A new object, also when the author never selected anything (mode v).
     */
    selectionOf(author) {
        const stored = this.sel.get(author);
        if (!stored) {
            return {md: 'v', items: []};
        }
        return {md: stored.md, items: liveItems(this, stored, null)};
    }

    /**
     * The vertices an author's selection comes to: faces and edges expanded.
     *
     * @param {string} author The author.
     * @returns {number[]} Vertex ids, without repeats, in first-seen order.
     */
    selectedVerts(author) {
        const {md, items} = this.selectionOf(author);
        if (md === 'v') {
            return items;
        }
        const seen = new Set();
        if (md === 'e') {
            items.forEach((id) => seen.add(id));
        } else {
            for (const face of items) {
                this.faces.get(face).forEach((id) => seen.add(id));
            }
        }
        return Array.from(seen);
    }

    /**
     * Which faces use each edge.
     *
     * @returns {Map<string, number[]>} Edge key → face ids, both in first-seen order of the faces.
     */
    edgeFaces() {
        const edges = new Map();
        for (const [id, list] of this.faces) {
            for (let c = 0; c < list.length; c++) {
                const key = edgeKey(list[c], list[(c + 1) % list.length]);
                const users = edges.get(key);
                if (users) {
                    users.push(id);
                } else {
                    edges.set(key, [id]);
                }
            }
        }
        return edges;
    }
}

/**
 * The Newell vector of a polygon: its normal, as long as twice its area.
 *
 * @param {number[][]} points The corners.
 * @returns {number[]} [x, y, z].
 */
function newellVector(points) {
    let x = 0;
    let y = 0;
    let z = 0;
    const n = points.length;
    for (let c = 0; c < n; c++) {
        const p = points[c];
        const q = points[c + 1 === n ? 0 : c + 1];
        x += (p[1] - q[1]) * (p[2] + q[2]);
        y += (p[2] - q[2]) * (p[0] + q[0]);
        z += (p[0] - q[0]) * (p[1] + q[1]);
    }
    return [x, y, z];
}

/**
 * The unit normal of a polygon by Newell's method, right-handed about the corner order.
 *
 * @param {number[][]} points The corners ([x, y, z] each).
 * @returns {number[]} The unit normal, or [0, 0, 0] for a polygon without area.
 */
export function newell(points) {
    const v = newellVector(points);
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (l <= DEGENERATE_NEWELL) {
        return [0, 0, 0];
    }
    return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * The triangles of a fan over a run of polygon corners.
 *
 * @param {number[]} ring Corner indices, in order.
 * @param {number[][]} out Receives the triples.
 * @returns {number[][]} out.
 */
function fanInto(ring, out) {
    for (let c = 1; c + 1 < ring.length; c++) {
        out.push([ring[0], ring[c], ring[c + 1]]);
    }
    return out;
}

/**
 * Twice the signed area of the triangle (a, b, c) of projected corners.
 *
 * @param {Float64Array} xs Projected x.
 * @param {Float64Array} ys Projected y.
 * @param {number} a Corner index.
 * @param {number} b Corner index.
 * @param {number} c Corner index.
 * @returns {number} Positive when counter-clockwise.
 */
function area2(xs, ys, a, b, c) {
    return (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
}

/**
 * Whether the corner at a place in the ring can be cut off: it turns the right way, with area, and no
 * other corner is inside its triangle or on its border.
 *
 * @param {number[]} ring The remaining corners.
 * @param {number} at The place in the ring.
 * @param {Float64Array} xs Projected x.
 * @param {Float64Array} ys Projected y.
 * @param {number} tol Twice-area tolerance.
 * @returns {boolean} True for an ear.
 */
function isEar(ring, at, xs, ys, tol) {
    const m = ring.length;
    const a = ring[at === 0 ? m - 1 : at - 1];
    const b = ring[at];
    const c = ring[at + 1 === m ? 0 : at + 1];
    if (area2(xs, ys, a, b, c) <= tol) {
        return false;
    }
    for (let k = 0; k < m; k++) {
        const p = ring[k];
        if (p === a || p === b || p === c) {
            continue;
        }
        if (area2(xs, ys, a, b, p) >= -tol && area2(xs, ys, b, c, p) >= -tol && area2(xs, ys, c, a, p) >= -tol) {
            return false;
        }
    }
    return true;
}

/**
 * Triangulates a polygon by ear clipping in its Newell plane. Every result uses each boundary edge of
 * the polygon exactly once in its own direction, whatever the polygon's shape, so a closed mesh stays
 * closed. Concave polygons and corners in a straight line are handled properly; what cannot be
 * handled (no area, self-crossing) becomes a fan, or a fan of what is left.
 *
 * @param {number[][]} points The corners ([x, y, z] each).
 * @returns {number[][]} Index triples [a, b, c] into points, in the polygon's direction; points.length − 2 of them.
 */
export function triangulateFace(points) {
    const n = points.length;
    if (n < 3) {
        return [];
    }
    if (n === 3) {
        return [[0, 1, 2]];
    }
    const ring = [];
    for (let c = 0; c < n; c++) {
        ring.push(c);
    }
    const normal = newell(points);
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
        return fanInto(ring, []);
    }

    // A right-handed basis (u, v, normal) of the plane: counter-clockwise about the normal stays so.
    const ax = Math.abs(normal[0]);
    const ay = Math.abs(normal[1]);
    const az = Math.abs(normal[2]);
    const seed = ax <= ay && ax <= az ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
    let ux = normal[1] * seed[2] - normal[2] * seed[1];
    let uy = normal[2] * seed[0] - normal[0] * seed[2];
    let uz = normal[0] * seed[1] - normal[1] * seed[0];
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = normal[1] * uz - normal[2] * uy;
    const vy = normal[2] * ux - normal[0] * uz;
    const vz = normal[0] * uy - normal[1] * ux;

    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    for (let c = 0; c < n; c++) {
        const p = points[c];
        xs[c] = p[0] * ux + p[1] * uy + p[2] * uz;
        ys[c] = p[0] * vx + p[1] * vy + p[2] * vz;
        minx = Math.min(minx, xs[c]);
        maxx = Math.max(maxx, xs[c]);
        miny = Math.min(miny, ys[c]);
        maxy = Math.max(maxy, ys[c]);
    }
    const extent = Math.max(maxx - minx, maxy - miny);
    const tol = extent * extent * AREA_TOLERANCE;

    // By far the most faces are convex quads: split along 0-2 when both triangles have area.
    if (n === 4 && area2(xs, ys, 0, 1, 2) > tol && area2(xs, ys, 0, 2, 3) > tol
            && area2(xs, ys, 1, 2, 3) >= -tol && area2(xs, ys, 3, 0, 1) >= -tol) {
        return [[0, 1, 2], [0, 2, 3]];
    }

    const out = [];
    let cursor = 0;
    while (ring.length > 3) {
        const m = ring.length;
        let ear = -1;
        for (let k = 0; k < m && ear < 0; k++) {
            const at = (cursor + k) % m;
            if (isEar(ring, at, xs, ys, tol)) {
                ear = at;
            }
        }
        if (ear < 0) {
            break;
        }
        out.push([ring[(ear + m - 1) % m], ring[ear], ring[(ear + 1) % m]]);
        ring.splice(ear, 1);
        // Moving on past the next corner cuts all round the polygon, rather than a fan of slivers.
        cursor = (ear + 1) % ring.length;
    }
    return fanInto(ring, out);
}

/**
 * The corners of a face.
 *
 * @param {PolyDoc} doc The document.
 * @param {number[]} list The face's vertex ids.
 * @returns {number[][]} Their positions.
 */
function facePoints(doc, list) {
    const points = new Array(list.length);
    for (let c = 0; c < list.length; c++) {
        points[c] = doc.verts.get(list[c]);
    }
    return points;
}

/**
 * The drawing data of a document, as typed arrays that can be posted to the main thread.
 *
 * @param {PolyDoc} doc The document.
 * @returns {{vertIds: Float64Array, vertPos: Float32Array, faceIds: Float64Array, faceStart: Uint32Array,
 *     faceVerts: Uint32Array, triPos: Float32Array, triNormal: Float32Array, triFace: Uint32Array, edges: Uint32Array,
 *     openEdges: Uint32Array, sels: {a: string, md: string, items: number[]}[]}} Vertices and faces in document
 *     order; faceVerts are indices into vertIds; triangles are flat with 3 corners each and the flat normal of their
 *     face; edges are unique pairs of vertex indices and openEdges those used by one face or more than two.
 */
export function renderData(doc) {
    const nv = doc.verts.size;
    const nf = doc.faces.size;
    const vertIds = new Float64Array(nv);
    const vertPos = new Float32Array(nv * 3);
    const indexOf = new Map();
    let at = 0;
    for (const [id, xyz] of doc.verts) {
        vertIds[at] = id;
        vertPos[at * 3] = xyz[0];
        vertPos[at * 3 + 1] = xyz[1];
        vertPos[at * 3 + 2] = xyz[2];
        indexOf.set(id, at);
        at++;
    }

    let corners = 0;
    let triangles = 0;
    for (const list of doc.faces.values()) {
        corners += list.length;
        triangles += list.length - 2;
    }
    const faceIds = new Float64Array(nf);
    const faceStart = new Uint32Array(nf + 1);
    const faceVerts = new Uint32Array(corners);
    const triPos = new Float32Array(triangles * 9);
    const triNormal = new Float32Array(triangles * 9);
    const triFace = new Uint32Array(triangles);
    const uses = new Map();
    let f = 0;
    let corner = 0;
    let t = 0;
    for (const [id, list] of doc.faces) {
        faceIds[f] = id;
        faceStart[f] = corner;
        for (let c = 0; c < list.length; c++) {
            const a = indexOf.get(list[c]);
            const b = indexOf.get(list[c + 1 === list.length ? 0 : c + 1]);
            faceVerts[corner++] = a;
            const key = a < b ? a * nv + b : b * nv + a;
            uses.set(key, (uses.get(key) || 0) + 1);
        }
        const points = facePoints(doc, list);
        const normal = newell(points);
        const flat = normal[0] === 0 && normal[1] === 0 && normal[2] === 0 ? [0, 1, 0] : normal;
        for (const tri of triangulateFace(points)) {
            for (let k = 0; k < 3; k++) {
                const p = points[tri[k]];
                const o = t * 9 + k * 3;
                triPos[o] = p[0];
                triPos[o + 1] = p[1];
                triPos[o + 2] = p[2];
                triNormal[o] = flat[0];
                triNormal[o + 1] = flat[1];
                triNormal[o + 2] = flat[2];
            }
            triFace[t++] = f;
        }
        f++;
    }
    faceStart[nf] = corner;

    let open = 0;
    for (const count of uses.values()) {
        if (count !== 2) {
            open++;
        }
    }
    const edges = new Uint32Array(uses.size * 2);
    const openEdges = new Uint32Array(open * 2);
    let e = 0;
    let oe = 0;
    for (const [key, count] of uses) {
        const hi = key % nv;
        const lo = (key - hi) / nv;
        edges[e++] = lo;
        edges[e++] = hi;
        if (count !== 2) {
            openEdges[oe++] = lo;
            openEdges[oe++] = hi;
        }
    }

    const sels = [];
    if (doc.sel.size) {
        const known = edgeSet(doc);
        for (const [a, stored] of doc.sel) {
            sels.push({a, md: stored.md, items: liveItems(doc, stored, known)});
        }
    }
    return {vertIds, vertPos, faceIds, faceStart, faceVerts, triPos, triNormal, triFace, edges, openEdges, sels};
}

/**
 * The document as one welded triangle mesh, one vertex per vertex id; vertices no face uses are left
 * out. Normals are area-weighted over the faces round each vertex.
 *
 * @param {PolyDoc} doc The document.
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} The mesh.
 */
export function exportMesh(doc) {
    const indexOf = new Map();
    let triangles = 0;
    for (const list of doc.faces.values()) {
        triangles += list.length - 2;
        for (let c = 0; c < list.length; c++) {
            if (!indexOf.has(list[c])) {
                indexOf.set(list[c], indexOf.size);
            }
        }
    }
    const count = indexOf.size;
    const positions = new Float32Array(count * 3);
    const sums = new Float64Array(count * 3);
    const indices = new Uint32Array(triangles * 3);
    for (const [id, index] of indexOf) {
        const xyz = doc.verts.get(id);
        positions[index * 3] = xyz[0];
        positions[index * 3 + 1] = xyz[1];
        positions[index * 3 + 2] = xyz[2];
    }
    let t = 0;
    for (const list of doc.faces.values()) {
        const points = facePoints(doc, list);
        const area = newellVector(points);
        for (let c = 0; c < list.length; c++) {
            const index = indexOf.get(list[c]);
            sums[index * 3] += area[0];
            sums[index * 3 + 1] += area[1];
            sums[index * 3 + 2] += area[2];
        }
        for (const tri of triangulateFace(points)) {
            indices[t++] = indexOf.get(list[tri[0]]);
            indices[t++] = indexOf.get(list[tri[1]]);
            indices[t++] = indexOf.get(list[tri[2]]);
        }
    }
    const normals = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
        const x = sums[v * 3];
        const y = sums[v * 3 + 1];
        const z = sums[v * 3 + 2];
        const l = Math.sqrt(x * x + y * y + z * z);
        if (l > DEGENERATE_NEWELL) {
            normals[v * 3] = x / l;
            normals[v * 3 + 1] = y / l;
            normals[v * 3 + 2] = z / l;
        } else {
            normals[v * 3 + 1] = 1;
        }
    }
    return {positions, normals, indices};
}

/**
 * The document's triangles for meshimport.fillMesh.
 *
 * @param {PolyDoc} doc The document.
 * @returns {Float64Array} 9 numbers per triangle: its corners in sculpture-local metres.
 */
export function bakeTriangles(doc) {
    let triangles = 0;
    for (const list of doc.faces.values()) {
        triangles += list.length - 2;
    }
    const out = new Float64Array(triangles * 9);
    let o = 0;
    for (const list of doc.faces.values()) {
        const points = facePoints(doc, list);
        for (const tri of triangulateFace(points)) {
            for (let k = 0; k < 3; k++) {
                const p = points[tri[k]];
                out[o++] = p[0];
                out[o++] = p[1];
                out[o++] = p[2];
            }
        }
    }
    return out;
}

/**
 * The root of a vertex in a table of connected vertices (a root has no entry).
 *
 * @param {Map<number, number>} parent Vertex → a vertex it is connected to.
 * @param {number} id The vertex.
 * @returns {number} The root.
 */
function rootOf(parent, id) {
    let at = id;
    let up = parent.get(at);
    while (up !== undefined) {
        const top = parent.get(up);
        if (top !== undefined) {
            parent.set(at, top);
        }
        at = up;
        up = parent.get(at);
    }
    return at;
}

/**
 * Whether the bounding boxes of two islands touch or overlap.
 *
 * @param {{lo: number[], hi: number[]}} a An island.
 * @param {{lo: number[], hi: number[]}} b Another island.
 * @returns {boolean} True when they do.
 */
function boxesTouch(a, b) {
    return a.lo[0] <= b.hi[0] && b.lo[0] <= a.hi[0] && a.lo[1] <= b.hi[1] && b.lo[1] <= a.hi[1] &&
        a.lo[2] <= b.hi[2] && b.lo[2] <= a.hi[2];
}

/**
 * The document's triangles for meshimport.fillMesh, in groups to voxelise one at a time. fillMesh counts surface
 * crossings along rays, so inside the overlap of two closed islands it counts an even number and leaves a hollow.
 * Islands (faces connected through shared vertices) whose bounding boxes touch therefore go in different groups, and
 * the caller keeps the lowest distance over the groups: their union. Each island takes the first group it fits, so
 * many separate parts are still voxelised at once; past MAX_BAKE_GROUPS the last group takes what is left.
 *
 * @param {PolyDoc} doc The document.
 * @returns {Float64Array[]} Per group, 9 numbers per triangle: its corners in sculpture-local metres. Empty with no faces.
 */
export function bakeGroups(doc) {
    const parent = new Map();
    for (const list of doc.faces.values()) {
        const first = rootOf(parent, list[0]);
        for (let c = 1; c < list.length; c++) {
            const other = rootOf(parent, list[c]);
            if (other !== first) {
                parent.set(other, first);
            }
        }
    }
    const islands = new Map();
    for (const list of doc.faces.values()) {
        const root = rootOf(parent, list[0]);
        let island = islands.get(root);
        if (!island) {
            island = {faces: [], triangles: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity]};
            islands.set(root, island);
        }
        island.faces.push(list);
        island.triangles += list.length - 2;
        for (let c = 0; c < list.length; c++) {
            const p = doc.verts.get(list[c]);
            for (let a = 0; a < 3; a++) {
                island.lo[a] = p[a] < island.lo[a] ? p[a] : island.lo[a];
                island.hi[a] = p[a] > island.hi[a] ? p[a] : island.hi[a];
            }
        }
    }
    const groups = [];
    islands.forEach((island) => {
        let group = groups.find((g) => g.islands.every((other) => !boxesTouch(other, island)));
        if (!group && groups.length >= MAX_BAKE_GROUPS) {
            group = groups[groups.length - 1];
        }
        if (!group) {
            group = {islands: [], triangles: 0};
            groups.push(group);
        }
        group.islands.push(island);
        group.triangles += island.triangles;
    });
    return groups.map((group) => {
        const out = new Float64Array(group.triangles * 9);
        let o = 0;
        group.islands.forEach((island) => island.faces.forEach((list) => {
            const points = facePoints(doc, list);
            for (const tri of triangulateFace(points)) {
                for (let k = 0; k < 3; k++) {
                    const p = points[tri[k]];
                    out[o++] = p[0];
                    out[o++] = p[1];
                    out[o++] = p[2];
                }
            }
        }));
        return out;
    });
}

/**
 * Puts two meshes into one. Neither is changed, and either may be null or empty.
 *
 * @param {?{positions: Float32Array, normals: ?Float32Array, indices: Uint32Array}} a A mesh.
 * @param {?{positions: Float32Array, normals: ?Float32Array, indices: Uint32Array}} b Another mesh.
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} A new mesh with a's vertices first.
 */
export function mergeMeshes(a, b) {
    const pa = a && a.positions ? a.positions : new Float32Array(0);
    const pb = b && b.positions ? b.positions : new Float32Array(0);
    const ia = a && a.indices ? a.indices : new Uint32Array(0);
    const ib = b && b.indices ? b.indices : new Uint32Array(0);
    const positions = new Float32Array(pa.length + pb.length);
    positions.set(pa, 0);
    positions.set(pb, pa.length);
    const normals = new Float32Array(pa.length + pb.length);
    if (a && a.normals) {
        normals.set(a.normals, 0);
    }
    if (b && b.normals) {
        normals.set(b.normals, pa.length);
    }
    const indices = new Uint32Array(ia.length + ib.length);
    indices.set(ia, 0);
    const offset = pa.length / 3;
    for (let n = 0; n < ib.length; n++) {
        indices[ia.length + n] = ib[n] + offset;
    }
    return {positions, normals, indices};
}

/**
 * The mesh section of a snapshot: UTF-8 JSON {"v":[[id,x,y,z],…],"f":[[id,[v…]],…],"s":[[author,md,[items]],…]},
 * everything in Map order. Selections are written as stored, stale items included (see the file comment).
 *
 * @param {PolyDoc} doc The document.
 * @returns {Uint8Array} The bytes.
 */
export function serializeDoc(doc) {
    const v = [];
    for (const [id, xyz] of doc.verts) {
        v.push(JSON.stringify([id, xyz[0], xyz[1], xyz[2]]));
    }
    const f = [];
    for (const [id, list] of doc.faces) {
        f.push(JSON.stringify([id, list]));
    }
    const s = [];
    for (const [author, stored] of doc.sel) {
        const items = stored.md === 'e' && stored.items.length % 2 ? stored.items.slice(0, -1) : stored.items;
        s.push(JSON.stringify([author, stored.md, items]));
    }
    return new TextEncoder().encode(`{"v":[${v.join(',')}],"f":[${f.join(',')}],"s":[${s.join(',')}]}`);
}

/**
 * Refuses a serialized document.
 *
 * @param {string} why What is wrong.
 * @returns {Error} The error to throw.
 */
function invalid(why) {
    return new Error('snapshotinvalid: mesh: ' + why);
}

/**
 * Whether a value can be an element id.
 *
 * @param {*} v The value.
 * @returns {boolean} True for a safe non-negative integer.
 */
function isId(v) {
    return Number.isSafeInteger(v) && v >= 0;
}

/**
 * Reads a mesh section, strictly: limits, safe integers, finite coordinates in range and rounded, face
 * lists of distinct existing vertices, no repeated ids. Selection items are only checked for form, for
 * they may name things since deleted.
 *
 * @param {Uint8Array|ArrayBuffer} bytes The output of serializeDoc.
 * @returns {PolyDoc} The document; serializing it gives the same bytes.
 * @throws {Error} 'snapshotinvalid: …' when anything is wrong.
 */
export function parseDoc(bytes) {
    let data = bytes;
    if (data instanceof ArrayBuffer) {
        data = new Uint8Array(data);
    }
    if (!(data instanceof Uint8Array)) {
        throw invalid('not binary data');
    }
    if (data.length > MAX_DOC_BYTES) {
        throw invalid('too large');
    }
    let root;
    try {
        root = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(data));
    } catch {
        throw invalid('not JSON');
    }
    if (root === null || typeof root !== 'object' || Array.isArray(root) || Object.keys(root).length !== 3
            || !Array.isArray(root.v) || !Array.isArray(root.f) || !Array.isArray(root.s)) {
        throw invalid('bad structure');
    }
    if (root.v.length > MAX_VERTS || root.f.length > MAX_FACES || root.s.length > MAX_DOC_AUTHORS) {
        throw invalid('over the limits');
    }

    const doc = new PolyDoc();
    for (const row of root.v) {
        if (!Array.isArray(row) || row.length !== 4 || !isId(row[0]) || doc.verts.has(row[0])) {
            throw invalid('bad vertex');
        }
        for (let a = 1; a < 4; a++) {
            const c = row[a];
            if (!Number.isFinite(c) || Math.abs(c) > MAX_COORD_MESH || R5(c) !== c) {
                throw invalid('bad coordinate');
            }
        }
        doc.addVert(row[0], [row[1], row[2], row[3]]);
    }
    for (const row of root.f) {
        if (!Array.isArray(row) || row.length !== 2 || !isId(row[0]) || doc.faces.has(row[0]) || !Array.isArray(row[1])) {
            throw invalid('bad face');
        }
        const list = row[1];
        if (list.length < 3 || list.length > MAX_FACE_SIZE || new Set(list).size !== list.length) {
            throw invalid('bad face size');
        }
        for (const id of list) {
            if (!isId(id) || !doc.verts.has(id)) {
                throw invalid('bad face vertex');
            }
        }
        doc.addFace(row[0], list);
    }
    for (const row of root.s) {
        if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' || !AUTHOR_PATTERN.test(row[0])
                || doc.sel.has(row[0]) || !Array.isArray(row[2])) {
            throw invalid('bad selection');
        }
        if ((row[1] !== 'v' && row[1] !== 'e' && row[1] !== 'f') || (row[1] === 'e' && row[2].length % 2)) {
            throw invalid('bad selection mode');
        }
        for (const id of row[2]) {
            if (!isId(id)) {
                throw invalid('bad selection item');
            }
        }
        doc.sel.set(row[0], {md: row[1], items: row[2]});
    }
    return doc;
}

/**
 * Whether two stored images are the same.
 *
 * @param {?number[]} a An image or null.
 * @param {?number[]} b An image or null.
 * @returns {boolean} True when equal.
 */
function sameImage(a, b) {
    if (a === b) {
        return true;
    }
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    for (let n = 0; n < a.length; n++) {
        if (a[n] !== b[n]) {
            return false;
        }
    }
    return true;
}

/**
 * Applies an ended stroke's change to a document in its present state, in either direction. `from` is the
 * image the stroke's direction starts from and `to` the one it restores.
 *
 * 1. vertices that are to come back are re-added at `to` (unless their id exists, or the mesh is full);
 * 2. vertices it moved get current + (to − from), rounded (when they still exist);
 * 3. faces: `to` null → deleted if present; otherwise set or added when all its vertices exist, else skipped;
 * 4. vertices that are to go are deleted when no face uses them.
 *
 * @param {object} rec The record.
 * @param {PolyDoc} doc The document.
 * @param {string} from Key of the image to go from: 'after' for undo, 'before' for redo.
 * @param {string} to Key of the image to go to: 'before' for undo, 'after' for redo.
 * @returns {void}
 */
function applyRecord(rec, doc, from, to) {
    let goes = false;
    for (const [id, image] of rec.verts) {
        const target = image[to];
        const start = image[from];
        if (target && !start) {
            if (!doc.verts.has(id) && doc.verts.size < MAX_VERTS) {
                doc.addVert(id, target);
            }
        } else if (target && start) {
            const now = doc.verts.get(id);
            if (now) {
                doc.setVert(id, [now[0] + target[0] - start[0], now[1] + target[1] - start[1], now[2] + target[2] - start[2]]);
            }
        } else {
            goes = true;
        }
    }
    for (const [id, image] of rec.faces) {
        const target = image[to];
        if (!target) {
            doc.delFace(id);
        } else if (target.every((v) => doc.verts.has(v)) && (doc.faces.has(id) || doc.faces.size < MAX_FACES)) {
            doc.setFace(id, target);
        }
    }
    if (!goes) {
        return;
    }
    const used = new Set();
    for (const list of doc.faces.values()) {
        for (let c = 0; c < list.length; c++) {
            used.add(list[c]);
        }
    }
    for (const [id, image] of rec.verts) {
        if (!image[to] && !used.has(id)) {
            doc.delVert(id);
        }
    }
}

/**
 * The undo records of the confirmed document, per author: the last MAX_MESH_RECORDS ended strokes,
 * and MAX_HISTORY_ELEMENTS images in all (oldest evicted first). Used as history.js is:
 *
 *     doc.rec = meshHistory.stroke(author, strokeId, doc);   // null: the op is not undoable
 *     applyMeshOp(doc, op);
 *     doc.rec = null;
 *     …
 *     meshHistory.end(author, strokeId, doc);                // on the stroke's `end` op
 *     if (meshHistory.has(author, target)) {
 *         meshHistory.undo(author, target, doc);
 *     }
 */
export class MeshHistory {
    /**
     * Creates an empty history.
     */
    constructor() {
        /** Open capture per author. @type {Map<string, Capture>} */
        this.open = new Map();
        /** Ended records per author, oldest first. @type {Map<string, object[]>} */
        this.records = new Map();
        /** Every kept record, oldest first (removed ones are skipped lazily). @type {object[]} */
        this.order = [];
        /** Images kept. @type {number} */
        this.elements = 0;
    }

    /**
     * Forgets everything.
     *
     * @returns {void}
     */
    clear() {
        this.open.clear();
        this.records.clear();
        this.order = [];
        this.elements = 0;
    }

    /**
     * The capture of an author's stroke, opening it when needed. Opening a newer stroke ends the
     * author's previous open stroke first (its end op may have been lost). Ops of an older stroke than
     * the open one, or of one already ended, are not captured.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     * @param {PolyDoc} [doc] The confirmed document, for ending a previous stroke.
     * @returns {?Capture} The capture, or null when this op is not undoable.
     */
    stroke(author, stroke, doc) {
        const cur = this.open.get(author);
        if (cur) {
            if (cur.stroke === stroke) {
                return cur;
            }
            if (stroke < cur.stroke) {
                return null;
            }
            this.end(author, cur.stroke, doc);
        }
        const list = this.records.get(author);
        if (list && list.length && list[list.length - 1].stroke >= stroke) {
            return null;
        }
        const capture = new Capture(author, stroke);
        this.open.set(author, capture);
        return capture;
    }

    /**
     * Ends an author's open stroke: takes the after-images and stores the record.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id (ignored unless it is the open one).
     * @param {PolyDoc} [doc] The confirmed document, after the stroke (default: the one the capture wrote to).
     * @returns {?object} The new record, or null (no such open stroke, or it changed nothing).
     */
    end(author, stroke, doc) {
        const cur = this.open.get(author);
        if (!cur || cur.stroke !== stroke) {
            return null;
        }
        this.open.delete(author);
        const target = doc || cur.doc;
        if (!target) {
            return null;
        }
        const rec = {author, stroke, verts: new Map(), faces: new Map(), undone: false, removed: false, size: 0};
        for (const [id, before] of cur.verts) {
            const after = target.verts.get(id) || null;
            if (!sameImage(before, after)) {
                rec.verts.set(id, {before, after});
            }
        }
        for (const [id, before] of cur.faces) {
            const after = target.faces.get(id) || null;
            if (!sameImage(before, after)) {
                rec.faces.set(id, {before, after});
            }
        }
        rec.size = rec.verts.size + rec.faces.size;
        if (!rec.size) {
            return null;
        }
        let list = this.records.get(author);
        if (!list) {
            list = [];
            this.records.set(author, list);
        }
        list.push(rec);
        this.order.push(rec);
        this.elements += rec.size;
        while (list.length > MAX_MESH_RECORDS) {
            this.remove(list[0]);
        }
        while (this.elements > MAX_HISTORY_ELEMENTS && this.order.length) {
            const oldest = this.order.shift();
            if (!oldest.removed) {
                this.remove(oldest);
            }
        }
        return rec;
    }

    /**
     * Drops a record.
     *
     * @param {object} rec The record.
     * @returns {void}
     */
    remove(rec) {
        if (rec.removed) {
            return;
        }
        rec.removed = true;
        this.elements -= rec.size;
        const list = this.records.get(rec.author);
        if (list) {
            const at = list.indexOf(rec);
            if (at !== -1) {
                list.splice(at, 1);
            }
            if (!list.length) {
                this.records.delete(rec.author);
            }
        }
        if (this.order.length > 4 * MAX_MESH_RECORDS) {
            this.order = this.order.filter((r) => !r.removed);
        }
    }

    /**
     * The record of an author's ended stroke.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     * @returns {?object} The record, or null (unknown or evicted).
     */
    find(author, stroke) {
        const list = this.records.get(author);
        if (!list) {
            return null;
        }
        for (let n = list.length - 1; n >= 0; n--) {
            if (list[n].stroke === stroke) {
                return list[n];
            }
        }
        return null;
    }

    /**
     * Whether an undo or redo of this stroke is a matter for the mesh: it is the author's open mesh
     * stroke or an ended one still kept.
     *
     * @param {string} author Author id.
     * @param {number} stroke Stroke id.
     * @returns {boolean} True when known here.
     */
    has(author, stroke) {
        const cur = this.open.get(author);
        return (cur !== undefined && cur.stroke === stroke) || this.find(author, stroke) !== null;
    }

    /**
     * Runs a record in one direction with no Capture listening, so that an undo in the middle of
     * applying someone else's op is not part of their stroke.
     *
     * @param {object} rec The record.
     * @param {PolyDoc} doc The document.
     * @param {string} from Key of the image to go from.
     * @param {string} to Key of the image to go to.
     * @returns {void}
     */
    run(rec, doc, from, to) {
        const listening = doc.rec;
        doc.rec = null;
        applyRecord(rec, doc, from, to);
        doc.rec = listening;
    }

    /**
     * Undoes an author's stroke, ending it first if it is still open (a cancelled drag). A no-op for
     * unknown, evicted or already undone strokes.
     *
     * @param {string} author Author id.
     * @param {number} stroke Target stroke id.
     * @param {PolyDoc} doc The confirmed document.
     * @returns {boolean} True when it ran.
     */
    undo(author, stroke, doc) {
        this.end(author, stroke, doc);
        const rec = this.find(author, stroke);
        if (!rec || rec.undone) {
            return false;
        }
        this.run(rec, doc, 'after', 'before');
        rec.undone = true;
        return true;
    }

    /**
     * Redoes an author's undone stroke. A no-op unless it is undone.
     *
     * @param {string} author Author id.
     * @param {number} stroke Target stroke id.
     * @param {PolyDoc} doc The confirmed document.
     * @returns {boolean} True when it ran.
     */
    redo(author, stroke, doc) {
        const rec = this.find(author, stroke);
        if (!rec || !rec.undone) {
            return false;
        }
        this.run(rec, doc, 'before', 'after');
        rec.undone = false;
        return true;
    }
}
