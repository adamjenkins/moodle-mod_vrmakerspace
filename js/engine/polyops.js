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
 * Polygon modelling operations: the mesh kinds of the op wire format, their validation and their effect
 * on a PolyDoc.
 *
 * Every kind acts on its author's selection in the document it is applied to, so all clients, applying
 * the same ops in the same order, reach the same bytes. An operator first reads the mesh into a Topo
 * (edges, directed sides, vertex fans) and records its changes in a Plan, which touches the document only
 * in commit(), through the document's mutators, so a stroke's Capture sees every change and a refused op
 * changes nothing. New ids come from elementId(author, op index, n), so an optimistic copy and the
 * confirmed copy agree without any id message. Only + - * /, sqrt, min, max, abs, floor and round and the
 * polynomial sin/cos of mathx.js are used.
 *
 * Behaviour is modelled on Blender's BMesh operators, reworked for this small n-gon kernel:
 * - region extrude on bmo_extrude.cc (duplicate what the region shares with the rest, side quads on the
 *   region's boundary, faces move onto the copies);
 * - region inset on bmo_inset.cc (boundary offset in the face planes, the fan of a corner keeps one copy);
 * - bevel on tools/bmesh_bevel.cc (one boundary vertex per sector between beveled edges, sliding along an
 *   unbeveled edge where one lies in the sector; a single beveled edge ending at a vertex slides on both
 *   neighbours and on the rest of the run, build_boundary_terminal_edge; overlap clamp as bevel_limit_offset);
 *   the arc is an ellipse tangent to both faces rather than Blender's profile, and a vertex with three or
 *   more beveled edges gets one closing n-gon rather than a vertex mesh;
 * - loop cut on bmo_subdivide_edgering.cc (ring through quads, joined at non-quads);
 * - merge on bmo_removedoubles.cc (faces rebuilt without repeats, cluster around the first vertex by distance);
 * - fill on bmo_edgenet.cc and bmo_create.cc (winding voted from the neighbouring faces);
 * - mirror on bmo_mirror.cc and bmo_symmetrize.cc (weld at the plane).
 *
 * Dependency-free apart from its engine siblings: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/polyops
 * @copyright  Blender Authors
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {HALF_PI, PI, R3, R4, R5, cos, sin} from './mathx.js';
import {MAX_COORD_MESH, MAX_FACES, MAX_FACE_SIZE, MAX_OP_ELEMENTS, MAX_VERTS, edgeKey, elementId} from './polymesh.js';
import {PRIM_SHAPES, addPrimitive, primitiveRefusal} from './polyprims.js';

/** Every mesh kind. */
export const MESH_KINDS = Object.freeze(['msel', 'mprim', 'mxf', 'mext', 'minset', 'mbevel', 'mloop', 'mmerge', 'mdel',
    'mfill', 'mflip', 'mmirror', 'mbake']);

/** The kinds that change the mesh and so belong to a stroke: all but msel. */
export const MESH_EDIT_KINDS = Object.freeze(MESH_KINDS.slice(1));

/** Why an op can be refused. */
export const MESH_REASONS = Object.freeze(['empty', 'needfaces', 'neededges', 'nonmanifold', 'badselection', 'limit',
    'conflict']);

/** Largest encoded mesh op in bytes. */
export const MAX_MESH_BYTES = 1000;

/** The wire order of an op's keys. */
const KEY_ORDER = Object.freeze(['a', 's', 'i', 'p', 'r', 'st', 'd', 'x', 'g', 't', 'm', 'sh', 'tx', 'md', 'sm', 'ids', 'e',
    'n', 'sc']);

/** Largest stroke id and op index. */
const MAX_ID = 2147483647;

/** Largest absolute axis component (an axis is normalised when used). */
const MAX_AXIS = 1000;

/** Largest absolute turn of a shape: π as rounded on the wire, so a half turn is not refused for its rounding. */
const MAX_TURN = R4(PI);

/** Author id pattern, as ops.js. */
const AUTHOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Selection modes. */
const MODES = Object.freeze(['v', 'e', 'f']);

/** Selection verbs of msel. */
const SELECT_VERBS = Object.freeze(['set', 'add', 'rem', 'all', 'none', 'linked', 'loop']);

/** Merge verbs of mmerge. */
const MERGE_VERBS = Object.freeze(['centre', 'first', 'last', 'dist']);

/** How far (m) from the plane x = 0 a vertex is welded by mirror. */
const MIRROR_WELD = 0.001;

/** Largest distance of a corner from its old place per unit of width, however sharp the corner. */
const CORNER_LIMIT = 4;

/** Share of the width at which a short edge would collapse that inset and bevel go to at most. */
const OVERLAP_MARGIN = 0.95;

/** Narrowest useful inset (m): below the coordinate rounding the rim would have no width. */
const MIN_WIDTH = 0.00001;

/** Keeps a loop cut's new vertices off the ends of the edges they cut (share of the edge). */
const CUT_MARGIN = 0.02;

/** Below this doubled area (m²) a filled outline counts as having no area. */
const MIN_FILL_AREA = 1e-10;

/** A refusal on its way out of an operator; applyMeshOp turns it into {ok: false, reason}. */
class Refusal {
    /**
     * Creates a refusal.
     *
     * @param {string} reason One of MESH_REASONS.
     */
    constructor(reason) {
        this.reason = reason;
    }
}

/**
 * Whether a value is an integer in a range.
 *
 * @param {*} v Value.
 * @param {number} lo Lowest allowed.
 * @param {number} hi Highest allowed.
 * @returns {boolean} True when it is.
 */
function intIn(v, lo, hi) {
    return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * Rounds a number and checks its range.
 *
 * @param {*} v Candidate.
 * @param {function(number): number} round Rounding function.
 * @param {number} lo Lowest allowed after rounding.
 * @param {number} hi Highest allowed after rounding.
 * @returns {number|null} The rounded value, or null.
 */
function numIn(v, round, lo, hi) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        return null;
    }
    const out = round(v);
    return out >= lo && out <= hi ? out : null;
}

/**
 * Rounds a 3-vector and checks each component's range.
 *
 * @param {*} v Candidate [x, y, z].
 * @param {function(number): number} round Rounding function.
 * @param {number} lo Lowest allowed component.
 * @param {number} hi Highest allowed component.
 * @returns {number[]|null} The rounded vector, or null.
 */
function vecIn(v, round, lo, hi) {
    if (!Array.isArray(v) || v.length !== 3) {
        return null;
    }
    const out = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
        const c = numIn(v[n], round, lo, hi);
        if (c === null) {
            return null;
        }
        out[n] = c;
    }
    return out;
}

/**
 * A non-zero turn axis, rounded.
 *
 * @param {*} v Candidate [x, y, z].
 * @returns {number[]|null} The axis, or null.
 */
function axisOf(v) {
    const x = vecIn(v, R4, -MAX_AXIS, MAX_AXIS);
    return x && (x[0] !== 0 || x[1] !== 0 || x[2] !== 0) ? x : null;
}

/**
 * Copies an array of safe non-negative integers.
 *
 * @param {*} v Candidate.
 * @param {number} most Longest allowed.
 * @returns {number[]|null} The copy, or null.
 */
function idsOf(v, most) {
    if (!Array.isArray(v) || v.length > most) {
        return null;
    }
    const out = [];
    for (let n = 0; n < v.length; n++) {
        if (!Number.isSafeInteger(v[n]) || v[n] < 0) {
            return null;
        }
        out.push(v[n]);
    }
    return out;
}

/**
 * Cleans the keys of a selection op into `v`.
 *
 * @param {object} obj Candidate op.
 * @param {object} v Receives the values.
 * @returns {boolean} False when a key is invalid.
 */
function cleanSelect(obj, v) {
    if (SELECT_VERBS.indexOf(obj.sm) === -1) {
        return false;
    }
    v.sm = obj.sm;
    if (obj.md !== undefined) {
        if (MODES.indexOf(obj.md) === -1) {
            return false;
        }
        v.md = obj.md;
    }
    if (obj.ids !== undefined && obj.sm !== 'all' && obj.sm !== 'none' && obj.sm !== 'loop') {
        v.ids = idsOf(obj.ids, MAX_MESH_BYTES);
        if (!v.ids) {
            return false;
        }
    }
    if (obj.sm === 'loop') {
        v.e = idsOf(obj.e, 2);
        if (!v.e || v.e.length !== 2 || v.e[0] === v.e[1]) {
            return false;
        }
    }
    return true;
}

/**
 * Cleans the keys of a shape op into `v`.
 *
 * @param {object} obj Candidate op.
 * @param {object} v Receives the values.
 * @returns {boolean} False when a key is invalid.
 */
function cleanPrim(obj, v) {
    if (PRIM_SHAPES.indexOf(obj.sh) === -1) {
        return false;
    }
    v.sh = obj.sh;
    v.p = vecIn(obj.p, R5, -MAX_COORD_MESH, MAX_COORD_MESH);
    v.r = numIn(obj.r, R5, 0.01, 0.2);
    if (!v.p || v.r === null) {
        return false;
    }
    if (obj.x !== undefined || obj.g !== undefined) {
        v.x = axisOf(obj.x);
        v.g = numIn(obj.g, R4, -MAX_TURN, MAX_TURN);
        if (!v.x || v.g === null) {
            return false;
        }
    }
    if (obj.n !== undefined) {
        if (!intIn(obj.n, 3, 48)) {
            return false;
        }
        v.n = obj.n;
    }
    return true;
}

/**
 * Cleans the keys of a transform op into `v`: exactly one of a move, a turn and a scale.
 *
 * @param {object} obj Candidate op.
 * @param {object} v Receives the values.
 * @returns {boolean} False when a key is invalid.
 */
function cleanTransform(obj, v) {
    const move = obj.d !== undefined;
    const turn = obj.x !== undefined || obj.g !== undefined;
    const scale = obj.sc !== undefined;
    if ((move ? 1 : 0) + (turn ? 1 : 0) + (scale ? 1 : 0) !== 1) {
        return false;
    }
    if (move) {
        v.d = vecIn(obj.d, R5, -0.8, 0.8);
        return v.d !== null;
    }
    v.p = vecIn(obj.p, R5, -MAX_COORD_MESH, MAX_COORD_MESH);
    if (!v.p) {
        return false;
    }
    if (scale) {
        v.sc = vecIn(obj.sc, R4, 0.05, 20);
        return v.sc !== null;
    }
    v.x = axisOf(obj.x);
    v.g = numIn(obj.g, R4, -0.5, 0.5);
    return v.x !== null && v.g !== null;
}

/**
 * Cleans the keys of a kind into `v`.
 *
 * @param {object} obj Candidate op.
 * @param {object} v Receives the values.
 * @returns {boolean} False when a key is invalid.
 */
function cleanKeys(obj, v) {
    switch (obj.k) {
        case 'msel':
            return cleanSelect(obj, v);
        case 'mprim':
            return cleanPrim(obj, v);
        case 'mxf':
            return cleanTransform(obj, v);
        case 'minset':
            v.r = numIn(obj.r, R5, 0.0005, 0.2);
            if (obj.m !== undefined) {
                if (obj.m !== 1) {
                    return false;
                }
                v.m = 1;
            }
            return v.r !== null;
        case 'mbevel':
            v.r = numIn(obj.r, R5, 0.0005, 0.1);
            if (obj.n !== undefined) {
                if (!intIn(obj.n, 1, 4)) {
                    return false;
                }
                v.n = obj.n;
            }
            return v.r !== null;
        case 'mloop':
            v.e = idsOf(obj.e, 2);
            if (!v.e || v.e.length !== 2 || v.e[0] === v.e[1]) {
                return false;
            }
            if (obj.st !== undefined) {
                v.st = numIn(obj.st, R3, 0, 1);
                if (v.st === null) {
                    return false;
                }
            }
            if (obj.n !== undefined) {
                if (!intIn(obj.n, 1, 8)) {
                    return false;
                }
                v.n = obj.n;
            }
            return true;
        case 'mmerge':
            if (obj.sm !== undefined) {
                if (MERGE_VERBS.indexOf(obj.sm) === -1) {
                    return false;
                }
                v.sm = obj.sm;
            }
            if (obj.sm === 'dist') {
                v.r = numIn(obj.r, R5, 0.00001, 0.05);
                return v.r !== null;
            }
            return true;
        default:
            return true;
    }
}

/**
 * Validates and canonicalises a mesh op.
 *
 * Builds a new object with only the keys the kind uses, in wire order, rounded. `a` is optional here (the
 * sequencer stamps it): when present it must be valid. Returns null for anything out of range.
 *
 * @param {*} obj Candidate op.
 * @returns {object|null} The clean op, or null when it is not a valid mesh op.
 */
export function cleanMeshOp(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return null;
    }
    const k = obj.k;
    if (typeof k !== 'string' || MESH_KINDS.indexOf(k) === -1) {
        return null;
    }
    const v = {};
    if (obj.a !== undefined) {
        if (typeof obj.a !== 'string' || !AUTHOR_RE.test(obj.a)) {
            return null;
        }
        v.a = obj.a;
    }
    if (k !== 'msel') {
        if (!intIn(obj.s, 1, MAX_ID)) {
            return null;
        }
        v.s = obj.s;
    }
    if (!intIn(obj.i, 1, MAX_ID) || !cleanKeys(obj, v)) {
        return null;
    }
    v.i = obj.i;
    const out = {k};
    KEY_ORDER.forEach((key) => {
        if (v[key] !== undefined) {
            out[key] = v[key];
        }
    });
    return JSON.stringify(out).length > MAX_MESH_BYTES ? null : out;
}

/**
 * a − b.
 *
 * @param {number[]} a [x, y, z].
 * @param {number[]} b [x, y, z].
 * @returns {number[]} The difference.
 */
function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * a + b.
 *
 * @param {number[]} a [x, y, z].
 * @param {number[]} b [x, y, z].
 * @returns {number[]} The sum.
 */
function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * a × s.
 *
 * @param {number[]} a [x, y, z].
 * @param {number} s Factor.
 * @returns {number[]} The scaled vector.
 */
function scaled(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
}

/**
 * a · b.
 *
 * @param {number[]} a [x, y, z].
 * @param {number[]} b [x, y, z].
 * @returns {number} The dot product.
 */
function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * a × b.
 *
 * @param {number[]} a [x, y, z].
 * @param {number[]} b [x, y, z].
 * @returns {number[]} The cross product.
 */
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * |a|.
 *
 * @param {number[]} a [x, y, z].
 * @returns {number} The length.
 */
function length(a) {
    return Math.sqrt(dot(a, a));
}

/**
 * The unit vector of a, or zero when a is too short to have a direction.
 *
 * @param {number[]} a [x, y, z].
 * @returns {number[]} The unit vector, or [0, 0, 0].
 */
function unit(a) {
    const l = length(a);
    return l < 1e-12 ? [0, 0, 0] : scaled(a, 1 / l);
}

/**
 * The Newell vector of a polygon: along its normal (counter-clockwise seen from its tip), twice its area long.
 *
 * @param {number[][]} points The corners in order.
 * @returns {number[]} The vector.
 */
function newellVector(points) {
    const out = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const q = points[(i + 1) % points.length];
        out[0] += (p[1] - q[1]) * (p[2] + q[2]);
        out[1] += (p[2] - q[2]) * (p[0] + q[0]);
        out[2] += (p[0] - q[0]) * (p[1] + q[1]);
    }
    return out;
}

/**
 * Where a corner goes per unit of width when the lines beside it move inward: on both moved lines at once
 * (a · m = b · m = 1 for unit a, b), limited for sharp corners.
 *
 * @param {number[]} a Unit inward normal of one line (or zero).
 * @param {number[]} b Unit inward normal of the other line (or zero).
 * @param {number[]} back Direction to take when the two normals are opposite (a spike).
 * @returns {number[]} The displacement.
 */
function miter(a, b, back) {
    const den = 1 + dot(a, b);
    if (den < 1e-6) {
        return scaled(unit(back), CORNER_LIMIT);
    }
    const m = scaled(add(a, b), 1 / den);
    const l = length(m);
    return l > CORNER_LIMIT ? scaled(m, CORNER_LIMIT / l) : m;
}

/**
 * How far along an unbeveled edge a corner slides per unit of width for it to lie one width off a beveled edge.
 *
 * @param {number[]} beveled Unit direction of the beveled edge.
 * @param {number[]} along Unit direction of the edge slid on.
 * @returns {number} The slide per unit of width, limited.
 */
function slideRate(beveled, along) {
    const s = length(cross(beveled, along));
    return s * CORNER_LIMIT < 1 ? CORNER_LIMIT : 1 / s;
}

/**
 * Pushes onto the array stored under a key.
 *
 * @param {Map} map The map.
 * @param {*} key The key.
 * @param {*} value The value.
 * @returns {void}
 */
function pushTo(map, key, value) {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/**
 * Key of a directed side.
 *
 * @param {number} u From.
 * @param {number} v To.
 * @returns {string} The key.
 */
function dirKey(u, v) {
    return u + '>' + v;
}

/**
 * Whether two lists hold the same values in the same order.
 *
 * @param {number[]} a One list.
 * @param {number[]} b The other.
 * @returns {boolean} True when equal.
 */
function sameList(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

/**
 * A coordinate as a document holds it: clamped and rounded. Not a number becomes 0, so nothing can poison a document.
 *
 * @param {number} v The value.
 * @returns {number} The coordinate.
 */
function coordOf(v) {
    if (Number.isNaN(v)) {
        return 0;
    }
    return R5(Math.max(-MAX_COORD_MESH, Math.min(MAX_COORD_MESH, v)));
}

/**
 * A position as a document holds it.
 *
 * @param {number[]} p [x, y, z].
 * @returns {number[]} The clamped and rounded position.
 */
function posOf(p) {
    return [coordOf(p[0]), coordOf(p[1]), coordOf(p[2])];
}

/**
 * A face's vertex list without repeats. Throws a refusal when it is longer than a face may be.
 *
 * @param {number[]} list The list.
 * @returns {number[]} The clean list.
 */
function cleanList(list) {
    const seen = new Set();
    const out = [];
    list.forEach((v) => {
        if (!seen.has(v)) {
            seen.add(v);
            out.push(v);
        }
    });
    if (out.length > MAX_FACE_SIZE) {
        throw new Refusal('limit');
    }
    return out;
}

/** The changes of one op, kept apart from the document until they are known to be possible. */
class Plan {
    /**
     * Creates an empty plan.
     *
     * @param {PolyDoc} doc The document.
     * @param {{a: string, i: number}} op The op, for its new ids.
     */
    constructor(doc, op) {
        this.doc = doc;
        this.author = op.a;
        this.index = op.i;
        this.count = 0;
        this.addVerts = new Map();
        this.setVerts = new Map();
        this.delVerts = new Set();
        this.addFaces = new Map();
        this.setFaces = new Map();
        this.delFaces = new Set();
    }

    /**
     * The next new element id. Throws a refusal when the op has made too many, or when the id is taken.
     *
     * @returns {number} The id.
     */
    newId() {
        if (this.count >= MAX_OP_ELEMENTS) {
            throw new Refusal('limit');
        }
        const id = elementId(this.author, this.index, this.count);
        this.count++;
        if (this.doc.verts.has(id) || this.doc.faces.has(id)) {
            throw new Refusal('conflict');
        }
        return id;
    }

    /**
     * Plans a new vertex.
     *
     * @param {number[]} p Its position.
     * @returns {number} Its id.
     */
    newVert(p) {
        const id = this.newId();
        this.addVerts.set(id, posOf(p));
        return id;
    }

    /**
     * Plans a new face, unless its list has fewer than 3 different vertices.
     *
     * @param {number[]} list Its vertices.
     * @returns {number|null} Its id, or null when there is no such face.
     */
    newFace(list) {
        const clean = cleanList(list);
        if (clean.length < 3) {
            return null;
        }
        const id = this.newId();
        this.addFaces.set(id, clean);
        return id;
    }

    /**
     * Plans a vertex's new position.
     *
     * @param {number} id The vertex.
     * @param {number[]} p Its position.
     * @returns {void}
     */
    setVert(id, p) {
        this.setVerts.set(id, posOf(p));
    }

    /**
     * Plans a vertex's removal.
     *
     * @param {number} id The vertex.
     * @returns {void}
     */
    delVert(id) {
        if (this.addVerts.has(id)) {
            this.addVerts.delete(id);
        } else {
            this.setVerts.delete(id);
            this.delVerts.add(id);
        }
    }

    /**
     * Plans a face's new list; a list of fewer than 3 different vertices removes the face.
     *
     * @param {number} id The face.
     * @param {number[]} list Its vertices.
     * @returns {void}
     */
    setFace(id, list) {
        const clean = cleanList(list);
        if (clean.length < 3) {
            this.delFace(id);
        } else if (this.addFaces.has(id)) {
            this.addFaces.set(id, clean);
        } else {
            this.setFaces.set(id, clean);
        }
    }

    /**
     * Plans a face's removal.
     *
     * @param {number} id The face.
     * @returns {void}
     */
    delFace(id) {
        if (this.addFaces.has(id)) {
            this.addFaces.delete(id);
        } else {
            this.setFaces.delete(id);
            this.delFaces.add(id);
        }
    }

    /**
     * Plans the removal of those of some vertices that no face will use after this plan.
     *
     * @param {Iterable<number>} candidates The vertices that may have lost their last face.
     * @returns {void}
     */
    dropUnused(candidates) {
        const used = new Set();
        this.doc.faces.forEach((list, id) => {
            if (!this.delFaces.has(id)) {
                (this.setFaces.get(id) || list).forEach((v) => used.add(v));
            }
        });
        this.addFaces.forEach((list) => list.forEach((v) => used.add(v)));
        for (const v of candidates) {
            if (!used.has(v)) {
                this.delVert(v);
            }
        }
    }

    /**
     * Carries the plan out through the document's mutators. Throws a refusal, before any change, when the
     * document would grow past its limits.
     *
     * @returns {void}
     */
    commit() {
        const doc = this.doc;
        if (doc.verts.size + this.addVerts.size - this.delVerts.size > MAX_VERTS ||
                doc.faces.size + this.addFaces.size - this.delFaces.size > MAX_FACES) {
            throw new Refusal('limit');
        }
        this.addVerts.forEach((p, id) => doc.addVert(id, p));
        this.setVerts.forEach((p, id) => doc.setVert(id, p));
        this.setFaces.forEach((list, id) => {
            if (!sameList(doc.faces.get(id), list)) {
                doc.setFace(id, list);
            }
        });
        this.addFaces.forEach((list, id) => doc.addFace(id, list));
        this.delFaces.forEach((id) => doc.delFace(id));
        this.delVerts.forEach((id) => doc.delVert(id));
    }
}

/** The connections of a document as it stands: edges, directed sides, faces of a vertex, ordered fans. */
class Topo {
    /**
     * Reads a document.
     *
     * @param {PolyDoc} doc The document.
     */
    constructor(doc) {
        this.doc = doc;
        this.edges = new Map();
        this.directed = new Map();
        this.vertFaces = new Map();
        this.fans = new Map();
        doc.faces.forEach((list, f) => {
            const n = list.length;
            for (let i = 0; i < n; i++) {
                const u = list[i];
                const v = list[(i + 1) % n];
                pushTo(this.vertFaces, u, f);
                pushTo(this.directed, dirKey(u, v), f);
                const key = edgeKey(u, v);
                const e = this.edges.get(key);
                if (e) {
                    e.faces.push(f);
                } else {
                    this.edges.set(key, {a: u < v ? u : v, b: u < v ? v : u, faces: [f]});
                }
            }
        });
    }

    /**
     * An edge.
     *
     * @param {number} u One end.
     * @param {number} v The other end.
     * @returns {{a: number, b: number, faces: number[]}|undefined} The edge (a < b), when it exists.
     */
    edge(u, v) {
        return this.edges.get(edgeKey(u, v));
    }

    /**
     * The faces running along a directed side.
     *
     * @param {number} u From.
     * @param {number} v To.
     * @returns {number[]} The faces.
     */
    along(u, v) {
        return this.directed.get(dirKey(u, v)) || [];
    }

    /**
     * The fan of faces round a vertex in counter-clockwise order seen from outside: face wedges[i] lies between
     * spokes[i] (its side leaving the vertex) and spokes[i + 1] (its side arriving at the vertex). A closed
     * fan has as many spokes as wedges, its spokes wrap round; an open one (on a hole) has one spoke more.
     *
     * @param {number} v The vertex.
     * @returns {{spokes: number[], wedges: number[], closed: boolean}|null} The fan, or null when the faces
     *     round the vertex do not form one fan (a non-manifold vertex or inconsistent winding).
     */
    fan(v) {
        if (this.fans.has(v)) {
            return this.fans.get(v);
        }
        const fan = this.buildFan(v);
        this.fans.set(v, fan);
        return fan;
    }

    /**
     * The neighbours of a vertex in a face.
     *
     * @param {number} f The face.
     * @param {number} v The vertex.
     * @returns {number[]} [the vertex after it, the vertex before it].
     */
    corner(f, v) {
        const list = this.doc.faces.get(f);
        const n = list.length;
        const i = list.indexOf(v);
        return [list[(i + 1) % n], list[(i + n - 1) % n]];
    }

    /**
     * Walks a vertex's faces into a fan.
     *
     * @param {number} v The vertex.
     * @returns {{spokes: number[], wedges: number[], closed: boolean}|null} The fan, or null.
     */
    buildFan(v) {
        const faces = this.vertFaces.get(v);
        if (!faces) {
            return null;
        }
        for (let i = 0; i < faces.length; i++) {
            const [next, prev] = this.corner(faces[i], v);
            if (this.along(v, next).length !== 1 || this.along(prev, v).length !== 1) {
                return null;
            }
        }
        const start = faces[0];
        const seen = new Set([start]);
        const [first, second] = this.corner(start, v);
        const wedges = [start];
        const spokes = [first, second];
        let closed = false;
        // Counter-clockwise from the first face, until the fan closes or a hole ends it.
        for (;;) {
            const after = this.along(v, spokes[spokes.length - 1]);
            if (after.length === 0) {
                break;
            }
            const g = after[0];
            if (g === start) {
                spokes.pop();
                closed = true;
                break;
            }
            if (seen.has(g)) {
                return null;
            }
            seen.add(g);
            wedges.push(g);
            spokes.push(this.corner(g, v)[1]);
        }
        // Clockwise from the first face, when a hole ended the walk.
        while (!closed) {
            const before = this.along(spokes[0], v);
            if (before.length === 0) {
                break;
            }
            const g = before[0];
            if (seen.has(g)) {
                return null;
            }
            seen.add(g);
            wedges.unshift(g);
            spokes.unshift(this.corner(g, v)[0]);
        }
        return seen.size === faces.length ? {spokes, wedges, closed} : null;
    }

    /**
     * The other face across a side when the side is interior to a chosen set of faces.
     *
     * @param {number} f The face.
     * @param {number} u From.
     * @param {number} v To.
     * @param {Set<number>} chosen The chosen faces.
     * @param {boolean} strict Also require the other face to run the opposite way.
     * @returns {number|null} The other face, or null when the side is on the set's boundary.
     */
    twin(f, u, v, chosen, strict) {
        const faces = this.edge(u, v).faces;
        if (faces.length !== 2) {
            return null;
        }
        const g = faces[0] === f ? faces[1] : faces[0];
        if (!chosen.has(g) || (strict && (this.along(v, u).length !== 1 || this.along(v, u)[0] !== g))) {
            return null;
        }
        return g;
    }

    /**
     * Splits chosen faces into regions connected across their shared sides.
     *
     * @param {number[]} faces The chosen faces.
     * @param {boolean} strict Connect only across sides the two faces run in opposite ways.
     * @returns {{faces: number[], set: Set<number>}[]} The regions, in first-seen order.
     */
    regions(faces, strict) {
        const chosen = new Set(faces);
        const seen = new Set();
        const out = [];
        faces.forEach((start) => {
            if (seen.has(start)) {
                return;
            }
            seen.add(start);
            const region = [start];
            for (let at = 0; at < region.length; at++) {
                const f = region[at];
                const list = this.doc.faces.get(f);
                list.forEach((u, i) => {
                    const g = this.twin(f, u, list[(i + 1) % list.length], chosen, strict);
                    if (g !== null && !seen.has(g)) {
                        seen.add(g);
                        region.push(g);
                    }
                });
            }
            out.push({faces: region, set: new Set(region)});
        });
        return out;
    }

    /**
     * The unit normal of a face.
     *
     * @param {number} f The face.
     * @returns {number[]} The normal, or zero for a face with no area.
     */
    normal(f) {
        return unit(newellVector(this.doc.faces.get(f).map((v) => this.doc.verts.get(v))));
    }
}

/**
 * Replaces an author's selection.
 *
 * @param {PolyDoc} doc The document.
 * @param {string} author The author.
 * @param {string} md The mode.
 * @param {number[]} items The items.
 * @returns {void}
 */
function setSelection(doc, author, md, items) {
    doc.sel.set(author, {md, items});
}

/**
 * Items naming elements that exist, in a mode's form; an edge pair is written low id first, a lone last id is dropped.
 *
 * @param {PolyDoc} doc The document.
 * @param {string} md The mode.
 * @param {number[]} ids The ids.
 * @returns {number[]} The items.
 */
function existingItems(doc, md, ids) {
    const out = [];
    if (md === 'e') {
        for (let i = 0; i + 1 < ids.length; i += 2) {
            const u = ids[i];
            const v = ids[i + 1];
            if (u !== v && doc.verts.has(u) && doc.verts.has(v)) {
                out.push(u < v ? u : v, u < v ? v : u);
            }
        }
        return out;
    }
    const table = md === 'f' ? doc.faces : doc.verts;
    ids.forEach((id) => {
        if (table.has(id)) {
            out.push(id);
        }
    });
    return out;
}

/**
 * Joins item lists without repeats, first-seen order.
 *
 * @param {string} md The mode.
 * @param {number[]} a Items.
 * @param {number[]} b More items.
 * @returns {number[]} The joined items.
 */
function joinItems(md, a, b) {
    const seen = new Set();
    const out = [];
    const all = a.concat(b);
    const step = md === 'e' ? 2 : 1;
    for (let i = 0; i < all.length; i += step) {
        const key = md === 'e' ? edgeKey(all[i], all[i + 1]) : all[i];
        if (!seen.has(key)) {
            seen.add(key);
            out.push(all[i]);
            if (md === 'e') {
                out.push(all[i + 1]);
            }
        }
    }
    return out;
}

/**
 * Items without those of another list.
 *
 * @param {string} md The mode.
 * @param {number[]} items The items.
 * @param {number[]} gone The items to take away.
 * @returns {number[]} What remains.
 */
function withoutItems(md, items, gone) {
    const out = [];
    if (md === 'e') {
        const drop = new Set();
        for (let i = 0; i + 1 < gone.length; i += 2) {
            drop.add(edgeKey(gone[i], gone[i + 1]));
        }
        for (let i = 0; i + 1 < items.length; i += 2) {
            if (!drop.has(edgeKey(items[i], items[i + 1]))) {
                out.push(items[i], items[i + 1]);
            }
        }
        return out;
    }
    const drop = new Set(gone);
    items.forEach((id) => {
        if (!drop.has(id)) {
            out.push(id);
        }
    });
    return out;
}

/**
 * The vertices items name.
 *
 * @param {PolyDoc} doc The document.
 * @param {string} md The mode.
 * @param {number[]} items The items.
 * @returns {number[]} The vertices, repeats possible.
 */
function itemVerts(doc, md, items) {
    if (md !== 'f') {
        return items;
    }
    const out = [];
    items.forEach((f) => {
        doc.faces.get(f).forEach((v) => out.push(v));
    });
    return out;
}

/**
 * The connected island or islands of some vertices.
 *
 * @param {Topo} topo The connections.
 * @param {number[]} seeds Vertices.
 * @returns {{verts: Set<number>, faces: Set<number>}} All their vertices and faces.
 */
function islandOf(topo, seeds) {
    const verts = new Set(seeds);
    const faces = new Set();
    const stack = Array.from(verts);
    while (stack.length > 0) {
        const v = stack.pop();
        (topo.vertFaces.get(v) || []).forEach((f) => {
            if (!faces.has(f)) {
                faces.add(f);
                topo.doc.faces.get(f).forEach((w) => {
                    if (!verts.has(w)) {
                        verts.add(w);
                        stack.push(w);
                    }
                });
            }
        });
    }
    return {verts, faces};
}

/**
 * Every element of a mode in connected islands, in document order.
 *
 * @param {Topo} topo The connections.
 * @param {string} md The mode.
 * @param {{verts: Set<number>, faces: Set<number>}} island The islands.
 * @returns {number[]} The items.
 */
function islandItems(topo, md, island) {
    const doc = topo.doc;
    const out = [];
    if (md === 'v') {
        doc.verts.forEach((p, v) => {
            if (island.verts.has(v)) {
                out.push(v);
            }
        });
    } else if (md === 'f') {
        doc.faces.forEach((list, f) => {
            if (island.faces.has(f)) {
                out.push(f);
            }
        });
    } else {
        topo.edges.forEach((e) => {
            if (island.verts.has(e.a)) {
                out.push(e.a, e.b);
            }
        });
    }
    return out;
}

/**
 * The vertex an edge loop goes on to after an edge, as Blender's edge loop walker: along a hole's rim, round an
 * n-gon whose rim vertices have nothing else but one edge each, or straight across a vertex with four quads.
 *
 * @param {Topo} topo The connections.
 * @param {number} from The edge's far end.
 * @param {number} at The edge's near end, where the walk stands.
 * @returns {number|null} The next vertex, or null where the loop ends.
 */
function nextInLoop(topo, from, at) {
    const edge = topo.edge(from, at);
    const fan = topo.fan(at);
    if (!fan) {
        return null;
    }
    const k = fan.spokes.length;
    if (edge.faces.length === 1) {
        if (fan.closed) {
            return null;
        }
        if (fan.spokes[0] === from) {
            return fan.spokes[k - 1];
        }
        return fan.spokes[k - 1] === from ? fan.spokes[0] : null;
    }
    if (edge.faces.length !== 2 || !fan.closed) {
        return null;
    }
    const hub = edge.faces.find((f) => topo.doc.faces.get(f).length > 4);
    if (hub !== undefined) {
        if (k !== 3) {
            return null;
        }
        const [next, prev] = topo.corner(hub, at);
        return next === from ? prev : next;
    }
    if (k !== 4 || fan.wedges.some((f) => topo.doc.faces.get(f).length !== 4)) {
        return null;
    }
    return fan.spokes[(fan.spokes.indexOf(from) + 2) % 4];
}

/**
 * Selects the edge loop through an edge.
 *
 * @param {Topo} topo The connections.
 * @param {number} u One end of the edge.
 * @param {number} v The other end.
 * @returns {number[]|null} The loop's edges as items, or null when there is no such edge.
 */
function edgeLoop(topo, u, v) {
    if (!topo.edge(u, v)) {
        return null;
    }
    const seen = new Set([edgeKey(u, v)]);
    const out = [Math.min(u, v), Math.max(u, v)];
    const ends = [[u, v], [v, u]];
    for (let w = 0; w < 2; w++) {
        let [from, at] = ends[w];
        for (;;) {
            const next = nextInLoop(topo, from, at);
            if (next === null || next === undefined || seen.has(edgeKey(at, next))) {
                break;
            }
            seen.add(edgeKey(at, next));
            out.push(Math.min(at, next), Math.max(at, next));
            from = at;
            at = next;
        }
    }
    return out;
}

/**
 * msel: changes the author's selection. Never refused.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opSelect(doc, op) {
    const cur = doc.selectionOf(op.a);
    const md = op.md || cur.md;
    const base = md === cur.md ? cur.items : [];
    const ids = existingItems(doc, md, op.ids || []);
    switch (op.sm) {
        case 'set':
            setSelection(doc, op.a, md, joinItems(md, ids, []));
            break;
        case 'add':
            setSelection(doc, op.a, md, joinItems(md, base, ids));
            break;
        case 'rem':
            if (md === cur.md) {
                setSelection(doc, op.a, md, withoutItems(md, cur.items, ids));
            }
            break;
        case 'all': {
            const topo = new Topo(doc);
            const everything = {verts: new Set(doc.verts.keys()), faces: new Set(doc.faces.keys())};
            setSelection(doc, op.a, md, islandItems(topo, md, everything));
            break;
        }
        case 'none':
            setSelection(doc, op.a, md, []);
            break;
        case 'linked': {
            // The current selection counts in whatever mode it was made; a pair naming no edge connects nothing.
            const topo = new Topo(doc);
            const asked = md === 'e' ? existingEdges(topo, ids).flatMap((e) => [e.a, e.b]) : ids;
            const seeds = itemVerts(doc, cur.md, cur.items).concat(itemVerts(doc, md, asked));
            const island = islandOf(topo, seeds);
            setSelection(doc, op.a, md, joinItems(md, joinItems(md, base, asked), islandItems(topo, md, island)));
            break;
        }
        case 'loop': {
            const loop = edgeLoop(new Topo(doc), op.e[0], op.e[1]);
            if (loop) {
                setSelection(doc, op.a, 'e', loop);
            }
            break;
        }
        default:
    }
}

/**
 * mprim: adds a shape, unless the document has no room for it or its ids are taken.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opPrimitive(doc, op) {
    const reason = primitiveRefusal(doc, op.sh, op.a, op.i, op.n);
    if (reason !== null) {
        throw new Refusal(reason);
    }
    setSelection(doc, op.a, 'f', addPrimitive(doc, op.sh, op.a, op.i, op.p, op.r, op.x || null, op.g || 0, op.n));
}

/**
 * The function an mxf op moves points by.
 *
 * @param {object} op The op.
 * @returns {function(number[]): number[]} Maps a position to its new one.
 */
function transformOf(op) {
    if (op.d) {
        return (q) => add(q, op.d);
    }
    if (op.sc) {
        return (q) => [
            op.p[0] + (q[0] - op.p[0]) * op.sc[0],
            op.p[1] + (q[1] - op.p[1]) * op.sc[1],
            op.p[2] + (q[2] - op.p[2]) * op.sc[2],
        ];
    }
    const axis = unit(op.x);
    const c = cos(op.g);
    const s = sin(op.g);
    return (q) => {
        // Rodrigues' rotation about the line through p.
        const r = sub(q, op.p);
        return add(op.p, add(add(scaled(r, c), scaled(cross(axis, r), s)), scaled(axis, dot(axis, r) * (1 - c))));
    };
}

/**
 * mxf: moves the selected vertices. Selection unchanged.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opTransform(doc, op) {
    const verts = doc.selectedVerts(op.a);
    if (verts.length === 0) {
        throw new Refusal('empty');
    }
    const move = transformOf(op);
    verts.forEach((v) => {
        const before = doc.verts.get(v);
        const after = posOf(move(before));
        if (after[0] !== before[0] || after[1] !== before[1] || after[2] !== before[2]) {
            doc.setVert(v, after);
        }
    });
}

/**
 * The selected edges that exist, without repeats.
 *
 * @param {Topo} topo The connections.
 * @param {number[]} items Flat pairs.
 * @returns {{a: number, b: number, faces: number[]}[]} The edges.
 */
function existingEdges(topo, items) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i + 1 < items.length; i += 2) {
        const e = topo.edge(items[i], items[i + 1]);
        if (e && !seen.has(e)) {
            seen.add(e);
            out.push(e);
        }
    }
    return out;
}

/**
 * mext with faces selected: each region's boundary gets side quads and the region moves onto copies of the
 * vertices it shares with the rest; nothing moves yet. A region with no boundary (a whole closed island) stays as it is.
 * A region that is a whole open island (a lone plane, say) keeps its original faces too, flipped, so it extrudes to a
 * closed solid: the rule of bmo_extrude_face_region_exec, whose delorig is false when no input face borders another face.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @param {Topo} topo The connections.
 * @param {number[]} faces The selected faces.
 * @returns {void}
 */
function extrudeFaces(doc, op, topo, faces) {
    const plan = new Plan(doc, op);
    const chosen = new Set(faces);
    const touched = new Set();
    topo.regions(faces, false).forEach((region) => {
        const sides = [];
        const need = new Set();
        region.faces.forEach((f) => {
            const list = doc.faces.get(f);
            list.forEach((u, i) => {
                const v = list[(i + 1) % list.length];
                if (topo.twin(f, u, v, chosen, false) === null) {
                    sides.push([u, v]);
                    need.add(u);
                    need.add(v);
                }
                if (topo.vertFaces.get(u).some((g) => !region.set.has(g))) {
                    need.add(u);
                }
            });
        });
        const lone = sides.length > 0 && !region.faces.some((f) => doc.faces.get(f).some(
            (v) => topo.vertFaces.get(v).some((g) => !region.set.has(g))));
        const copies = new Map();
        region.faces.forEach((f) => {
            const list = doc.faces.get(f);
            if (lone) {
                list.forEach((v) => need.add(v));
                plan.newFace(Array.from(list).reverse());
            }
            plan.setFace(f, list.map((v) => {
                if (!need.has(v)) {
                    return v;
                }
                if (!copies.has(v)) {
                    copies.set(v, plan.newVert(doc.verts.get(v)));
                    touched.add(v);
                }
                return copies.get(v);
            }));
        });
        sides.forEach(([u, v]) => plan.newFace([u, v, copies.get(v), copies.get(u)]));
    });
    plan.dropUnused(touched);
    plan.commit();
    setSelection(doc, op.a, 'f', faces);
}

/**
 * Which way each extruded edge's new quad runs along the old edge, so that quads sharing a vertex agree and a
 * quad agrees with the face of an open edge: the open edges' way first, then spreading along the chains.
 *
 * @param {Topo} topo The connections.
 * @param {{a: number, b: number, faces: number[]}[]} edges The edges.
 * @returns {number[][]} [from, to] per edge.
 */
function orientEdges(topo, edges) {
    const atVertex = new Map();
    edges.forEach((e, i) => {
        pushTo(atVertex, e.a, i);
        pushTo(atVertex, e.b, i);
    });
    const ways = new Array(edges.length).fill(null);
    const queue = [];
    edges.forEach((e, i) => {
        if (e.faces.length === 1) {
            ways[i] = wayAgainstFace(topo, e);
            queue.push(i);
        }
    });
    spreadWays(edges, atVertex, ways, queue);
    edges.forEach((e, i) => {
        if (ways[i] === null) {
            ways[i] = wayAgainstFace(topo, e);
            queue.push(i);
            spreadWays(edges, atVertex, ways, queue);
        }
    });
    return ways;
}

/**
 * The way a new quad on an edge runs so as to agree with the edge's first face.
 *
 * @param {Topo} topo The connections.
 * @param {{a: number, b: number}} e The edge.
 * @returns {number[]} [from, to].
 */
function wayAgainstFace(topo, e) {
    return topo.along(e.a, e.b).length > 0 ? [e.b, e.a] : [e.a, e.b];
}

/**
 * Spreads quad directions along chains of edges: the edge after one starts where that one ends.
 *
 * @param {{a: number, b: number}[]} edges The edges.
 * @param {Map<number, number[]>} atVertex The edges at each vertex.
 * @param {Array<?number[]>} ways The directions so far; filled in.
 * @param {number[]} queue The edges whose direction has yet to spread; emptied.
 * @returns {void}
 */
function spreadWays(edges, atVertex, ways, queue) {
    while (queue.length > 0) {
        const [p, q] = ways[queue.shift()];
        atVertex.get(q).forEach((j) => {
            if (ways[j] === null) {
                const o = edges[j];
                ways[j] = o.a === q ? [o.a, o.b] : [o.b, o.a];
                queue.push(j);
            }
        });
        atVertex.get(p).forEach((j) => {
            if (ways[j] === null) {
                const o = edges[j];
                ways[j] = o.b === p ? [o.a, o.b] : [o.b, o.a];
                queue.push(j);
            }
        });
    }
}

/**
 * mext with edges selected: each edge gets a new quad on copies of its ends, edges sharing a vertex share its copy.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @param {Topo} topo The connections.
 * @param {{a: number, b: number, faces: number[]}[]} edges The selected edges.
 * @returns {void}
 */
function extrudeEdges(doc, op, topo, edges) {
    const plan = new Plan(doc, op);
    const copies = new Map();
    const items = [];
    orientEdges(topo, edges).forEach(([p, q]) => {
        [p, q].forEach((v) => {
            if (!copies.has(v)) {
                copies.set(v, plan.newVert(doc.verts.get(v)));
            }
        });
        const cp = copies.get(p);
        const cq = copies.get(q);
        plan.newFace([p, q, cq, cp]);
        items.push(cp < cq ? cp : cq, cp < cq ? cq : cp);
    });
    plan.commit();
    setSelection(doc, op.a, 'e', items);
}

/**
 * mext: extrudes the selected faces or edges.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opExtrude(doc, op) {
    const sel = doc.selectionOf(op.a);
    if (sel.items.length === 0) {
        throw new Refusal('empty');
    }
    if (sel.md === 'v') {
        throw new Refusal('needfaces');
    }
    const topo = new Topo(doc);
    if (sel.md === 'f') {
        extrudeFaces(doc, op, topo, sel.items);
    } else {
        extrudeEdges(doc, op, topo, existingEdges(topo, sel.items));
    }
}

/**
 * Finds a key's root in a union-find table, with path halving.
 *
 * @param {Map<string, string>} parent The table.
 * @param {string} key The key.
 * @returns {string} Its root.
 */
function findRoot(parent, key) {
    let at = key;
    let up = parent.get(at);
    while (up !== undefined && up !== at) {
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
 * Joins two keys in a union-find table.
 *
 * @param {Map<string, string>} parent The table.
 * @param {string} a One key.
 * @param {string} b The other.
 * @returns {void}
 */
function joinRoots(parent, a, b) {
    const ra = findRoot(parent, a);
    const rb = findRoot(parent, b);
    if (ra !== rb) {
        parent.set(rb, ra);
    }
}

/**
 * The widest offset, up to a wanted width, at which no side between two moving corners turns back on itself.
 *
 * @param {number} wanted The wanted width.
 * @param {number[]} pu The start of a side.
 * @param {number[]} pv The end of the side.
 * @param {number[]} mu The start's displacement per unit of width.
 * @param {number[]} mv The end's displacement per unit of width.
 * @returns {number} The width allowed.
 */
function clampSide(wanted, pu, pv, mu, mv) {
    const side = sub(pv, pu);
    const l = length(side);
    const closing = l < 1e-12 ? 0 : dot(sub(mu, mv), scaled(side, 1 / l));
    if (closing <= 1e-9) {
        return wanted;
    }
    return Math.min(wanted, OVERLAP_MARGIN * l / closing);
}

/**
 * Insets one region: its boundary moves inward in the face planes; a corner fan keeps one new vertex; the rim gets quads.
 *
 * @param {PolyDoc} doc The document.
 * @param {Plan} plan The plan.
 * @param {Topo} topo The connections.
 * @param {{faces: number[], set: Set<number>}} region The region.
 * @param {number} wanted The width.
 * @param {boolean} separate Each face on its own: no side is interior.
 * @returns {void}
 */
function insetRegion(doc, plan, topo, region, wanted, separate) {
    const parent = new Map();
    const boundary = [];
    region.faces.forEach((f) => {
        const list = doc.faces.get(f);
        list.forEach((u, i) => {
            const v = list[(i + 1) % list.length];
            const g = separate ? null : topo.twin(f, u, v, region.set, true);
            if (g === null) {
                boundary.push({f, u, v});
            } else {
                joinRoots(parent, cornerKey(f, u), cornerKey(g, u));
                joinRoots(parent, cornerKey(f, v), cornerKey(g, v));
            }
        });
    });
    if (boundary.length === 0) {
        return;
    }
    const fans = insetFans(doc, topo, boundary, parent);
    let width = wanted;
    const none = {move: [0, 0, 0]};
    region.faces.forEach((f) => {
        const list = doc.faces.get(f);
        list.forEach((u, i) => {
            const v = list[(i + 1) % list.length];
            const fu = fans.get(findRoot(parent, cornerKey(f, u))) || none;
            const fv = fans.get(findRoot(parent, cornerKey(f, v))) || none;
            width = clampSide(width, doc.verts.get(u), doc.verts.get(v), fu.move, fv.move);
        });
    });
    if (width < MIN_WIDTH) {
        return;
    }
    // The corner fans take their new vertices in the order the boundary reaches them.
    boundary.forEach(({f, u, v}) => {
        [u, v].forEach((w) => {
            const fan = fans.get(findRoot(parent, cornerKey(f, w)));
            if (fan.id === null) {
                fan.id = plan.newVert(add(doc.verts.get(w), scaled(fan.move, width)));
            }
        });
    });
    region.faces.forEach((f) => {
        plan.setFace(f, doc.faces.get(f).map((v) => {
            const fan = fans.get(findRoot(parent, cornerKey(f, v)));
            return fan ? fan.id : v;
        }));
    });
    boundary.forEach(({f, u, v}) => {
        const fu = fans.get(findRoot(parent, cornerKey(f, u)));
        const fv = fans.get(findRoot(parent, cornerKey(f, v)));
        plan.newFace([u, v, fv.id, fu.id]);
    });
}

/**
 * Key of a face's corner at a vertex.
 *
 * @param {number} f The face.
 * @param {number} v The vertex.
 * @returns {string} The key.
 */
function cornerKey(f, v) {
    return f + ':' + v;
}

/**
 * The corner fans of an inset's boundary, each with the way its vertex moves: to where the offsets of the side
 * arriving at the vertex and the side leaving it meet.
 *
 * @param {PolyDoc} doc The document.
 * @param {Topo} topo The connections.
 * @param {{f: number, u: number, v: number}[]} boundary The region's boundary sides.
 * @param {Map<string, string>} parent Corners joined across the region's interior sides.
 * @returns {Map<string, {arriving: ?number[], leaving: ?number[], back: number[], move: ?number[], id: ?number}>}
 *     The fans by root corner.
 */
function insetFans(doc, topo, boundary, parent) {
    const fans = new Map();
    /**
     * The fan of a corner, made when first asked for.
     *
     * @param {number} f The face.
     * @param {number} v The vertex.
     * @returns {object} The fan.
     */
    const fanOf = (f, v) => {
        const root = findRoot(parent, cornerKey(f, v));
        if (!fans.has(root)) {
            fans.set(root, {arriving: null, leaving: null, back: [0, 0, 0], move: null, id: null});
        }
        return fans.get(root);
    };
    boundary.forEach(({f, u, v}) => {
        const dir = unit(sub(doc.verts.get(v), doc.verts.get(u)));
        const inward = unit(cross(topo.normal(f), dir));
        const end = fanOf(f, v);
        end.arriving = inward;
        end.back = sub(end.back, dir);
        const start = fanOf(f, u);
        start.leaving = inward;
        start.back = add(start.back, dir);
    });
    fans.forEach((fan) => {
        const a = fan.arriving || fan.leaving;
        const b = fan.leaving || fan.arriving;
        fan.move = miter(a, b, fan.back);
    });
    return fans;
}

/**
 * minset: insets the selected faces, as regions or (m = 1) each face separately. Inner faces stay selected.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opInset(doc, op) {
    const sel = doc.selectionOf(op.a);
    if (sel.items.length === 0) {
        throw new Refusal('empty');
    }
    if (sel.md !== 'f') {
        throw new Refusal('needfaces');
    }
    const faces = sel.items;
    const topo = new Topo(doc);
    const plan = new Plan(doc, op);
    const separate = op.m === 1;
    const regions = separate ? faces.map((f) => ({faces: [f], set: new Set([f])})) : topo.regions(faces, true);
    regions.forEach((region) => insetRegion(doc, plan, topo, region, op.r, separate));
    plan.commit();
    setSelection(doc, op.a, 'f', faces);
}

/**
 * The selected edges a bevel can work on: exactly two faces running opposite ways, an orderable fan at both ends.
 *
 * @param {Topo} topo The connections.
 * @param {number[]} items Flat pairs.
 * @returns {{a: number, b: number, faces: number[]}[]} The edges.
 */
function bevelEdges(topo, items) {
    return existingEdges(topo, items).filter((e) => {
        return e.faces.length === 2 && topo.along(e.a, e.b).length === 1 && topo.along(e.b, e.a).length === 1 &&
            topo.fan(e.a) !== null && topo.fan(e.b) !== null;
    });
}

/**
 * Makes a corner's boundary vertex.
 *
 * @param {object} corner The corner.
 * @param {number[]} move Its displacement per unit of width.
 * @returns {{move: number[], pos: number[]|null, id: number|null}} The boundary vertex.
 */
function newBound(corner, move) {
    const bound = {move, pos: null, id: null};
    corner.bounds.push(bound);
    return bound;
}

/**
 * The unit direction of a spoke of a corner.
 *
 * @param {Topo} topo The connections.
 * @param {object} corner The corner.
 * @param {number} i The spoke, wrapping round.
 * @returns {number[]} The direction.
 */
function spokeDir(topo, corner, i) {
    const spokes = corner.fan.spokes;
    const far = spokes[((i % spokes.length) + spokes.length) % spokes.length];
    return unit(sub(topo.doc.verts.get(far), topo.doc.verts.get(corner.v)));
}

/**
 * The face of a wedge of a corner, wrapping round.
 *
 * @param {object} corner The corner.
 * @param {number} i The wedge.
 * @returns {number} The face.
 */
function wedgeFace(corner, i) {
    return corner.fan.wedges[i % corner.fan.spokes.length];
}

/**
 * A closed fan's single beveled edge ends here. Its two sides slide on the neighbouring edges and any edges
 * beyond them slide too (Blender's terminal edge), so the original vertex goes and the run's faces keep their shape:
 * with one edge in the run the bevel ends in a tip on it; with two the face between takes the arc; with
 * more a closing n-gon runs through the slid points and the arc.
 *
 * @param {Topo} topo The connections.
 * @param {object} corner The corner.
 * @returns {void}
 */
function terminalCorner(topo, corner) {
    const s = corner.sel[0];
    const run = corner.fan.spokes.length - 1;
    const a = spokeDir(topo, corner, s);
    if (run === 1) {
        const tip = newBound(corner, spokeDir(topo, corner, s + 1));
        corner.after.set(s, tip);
        corner.before.set(s, tip);
        corner.rep.set(wedgeFace(corner, s), [tip]);
        corner.rep.set(wedgeFace(corner, s + 1), [tip]);
        return;
    }
    const slid = [];
    for (let j = 1; j <= run; j++) {
        const d = spokeDir(topo, corner, s + j);
        slid.push(newBound(corner, scaled(d, j === 1 || j === run ? slideRate(a, d) : 1)));
    }
    const left = slid[0];
    const right = slid[run - 1];
    corner.after.set(s, left);
    corner.before.set(s, right);
    corner.rep.set(wedgeFace(corner, s), [left]);
    for (let j = 1; j < run; j++) {
        corner.rep.set(wedgeFace(corner, s + j), [slid[j], slid[j - 1]]);
    }
    corner.rep.set(wedgeFace(corner, s + run), [right]);
    if (run === 2) {
        corner.arcFace = wedgeFace(corner, s + 1);
    } else {
        corner.closing = slid;
    }
}

/**
 * The sector between two neighbouring beveled edges keeps one boundary vertex: where their offset lines meet in
 * the face, or on the one unbeveled edge between them, or where the offsets meet across a longer unbeveled run.
 *
 * @param {Topo} topo The connections.
 * @param {object} corner The corner.
 * @param {number} s The spoke the sector starts from.
 * @param {number} t The spoke it ends at.
 * @returns {void}
 */
function sectorBetween(topo, corner, s, t) {
    const k = corner.fan.spokes.length;
    const count = (t - s + k) % k;
    const a = spokeDir(topo, corner, s);
    const b = spokeDir(topo, corner, t);
    let move;
    if (count === 2) {
        const d = spokeDir(topo, corner, s + 1);
        move = scaled(d, (slideRate(a, d) + slideRate(b, d)) / 2);
    } else {
        const na = topo.normal(wedgeFace(corner, s));
        const nb = topo.normal(wedgeFace(corner, s + count - 1));
        move = miter(unit(cross(na, a)), unit(cross(b, nb)), add(a, b));
    }
    const bound = newBound(corner, move);
    corner.after.set(s, bound);
    corner.before.set(t, bound);
    for (let i = 0; i < count; i++) {
        corner.rep.set(wedgeFace(corner, s + i), [bound]);
    }
}

/**
 * The run from an open fan's outermost beveled edge to the hole: one boundary vertex sliding on the neighbouring edge.
 *
 * @param {Topo} topo The connections.
 * @param {object} corner The corner.
 * @param {number} s The beveled spoke.
 * @param {boolean} after True for the run after the spoke, false for the run before it.
 * @returns {void}
 */
function outerRun(topo, corner, s, after) {
    const d = spokeDir(topo, corner, after ? s + 1 : s - 1);
    const bound = newBound(corner, scaled(d, slideRate(spokeDir(topo, corner, s), d)));
    (after ? corner.after : corner.before).set(s, bound);
    const from = after ? s : 0;
    const to = after ? corner.fan.wedges.length : s;
    for (let i = from; i < to; i++) {
        corner.rep.set(corner.fan.wedges[i], [bound]);
    }
}

/**
 * Works out what replaces a beveled vertex in each face round it.
 *
 * @param {Topo} topo The connections.
 * @param {object} corner The corner.
 * @returns {void}
 */
function buildCorner(topo, corner) {
    corner.sel.sort((x, y) => x - y);
    const closed = corner.fan.closed;
    const count = corner.sel.length;
    if (closed && count === 1) {
        terminalCorner(topo, corner);
        return;
    }
    const sectors = closed ? count : count - 1;
    for (let i = 0; i < sectors; i++) {
        sectorBetween(topo, corner, corner.sel[i], corner.sel[(i + 1) % count]);
    }
    if (!closed) {
        outerRun(topo, corner, corner.sel[0], false);
        outerRun(topo, corner, corner.sel[count - 1], true);
    }
}

/**
 * The widest bevel, up to a wanted width, at which no side of an old face turns back on itself.
 *
 * @param {PolyDoc} doc The document.
 * @param {Map<number, object>} corners The corners by vertex.
 * @param {Set<number>} touched The faces round them.
 * @param {number} wanted The wanted width.
 * @returns {number} The width.
 */
function bevelWidth(doc, corners, touched, wanted) {
    const none = {move: [0, 0, 0]};
    let width = wanted;
    touched.forEach((f) => {
        const list = doc.faces.get(f);
        list.forEach((u, i) => {
            const v = list[(i + 1) % list.length];
            const cu = corners.get(u);
            const cv = corners.get(v);
            const ru = cu ? cu.rep.get(f) : null;
            const rv = cv ? cv.rep.get(f) : null;
            const mu = ru ? ru[ru.length - 1] : none;
            const mv = rv ? rv[0] : none;
            width = clampSide(width, doc.verts.get(u), doc.verts.get(v), mu.move, mv.move);
        });
    });
    return width;
}

/**
 * The points of an arc from one boundary vertex to another at a vertex: an ellipse tangent to the faces at both
 * ends (at a right-angled edge, a circle). Asked for the other way round, gives the same vertices reversed.
 *
 * @param {Plan} plan The plan.
 * @param {Map<string, number[]>} cache Arcs made so far.
 * @param {number} segments The segments of the arc.
 * @param {number} v The vertex.
 * @param {number[]} at Its position.
 * @param {object} from The start.
 * @param {object} to The end.
 * @returns {number[]} segments + 1 vertex ids from start to end.
 */
function arcIds(plan, cache, segments, v, at, from, to) {
    const key = v + ':' + from.id + ':' + to.id;
    if (cache.has(key)) {
        return cache.get(key);
    }
    const ids = [from.id];
    if (from === to) {
        for (let j = 1; j <= segments; j++) {
            ids.push(from.id);
        }
        return ids;
    }
    const centre = sub(add(from.pos, to.pos), at);
    const a = sub(from.pos, centre);
    const b = sub(to.pos, centre);
    for (let j = 1; j < segments; j++) {
        const angle = HALF_PI * j / segments;
        ids.push(plan.newVert(add(centre, add(scaled(a, cos(angle)), scaled(b, sin(angle))))));
    }
    ids.push(to.id);
    cache.set(key, ids);
    cache.set(v + ':' + to.id + ':' + from.id, ids.slice().reverse());
    return ids;
}

/**
 * mbevel: replaces the selected edges with strips of quads, their ends closed where needed.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opBevel(doc, op) {
    const sel = doc.selectionOf(op.a);
    if (sel.items.length === 0) {
        throw new Refusal('empty');
    }
    if (sel.md !== 'e') {
        throw new Refusal('neededges');
    }
    const topo = new Topo(doc);
    const edges = bevelEdges(topo, sel.items);
    if (edges.length === 0) {
        throw new Refusal('nonmanifold');
    }
    const segments = op.n || 1;
    const corners = new Map();
    edges.forEach((e) => {
        [[e.a, e.b], [e.b, e.a]].forEach(([v, far]) => {
            if (!corners.has(v)) {
                corners.set(v, {v, fan: topo.fan(v), sel: [], bounds: [], after: new Map(), before: new Map(),
                    rep: new Map(), arcFace: null, closing: null});
            }
            const corner = corners.get(v);
            corner.sel.push(corner.fan.spokes.indexOf(far));
        });
    });
    const touched = new Set();
    corners.forEach((corner) => {
        buildCorner(topo, corner);
        corner.rep.forEach((list, f) => touched.add(f));
    });
    const width = bevelWidth(doc, corners, touched, op.r);

    const plan = new Plan(doc, op);
    corners.forEach((corner, v) => {
        const at = doc.verts.get(v);
        corner.bounds.forEach((bound) => {
            bound.pos = add(at, scaled(bound.move, width));
            bound.id = plan.newVert(bound.pos);
        });
    });
    const cache = new Map();
    /**
     * An arc at a corner.
     *
     * @param {object} corner The corner.
     * @param {object} from The boundary vertex it starts at.
     * @param {object} to The boundary vertex it ends at.
     * @returns {number[]} The arc's vertices.
     */
    const arc = (corner, from, to) => arcIds(plan, cache, segments, corner.v, doc.verts.get(corner.v), from, to);
    const made = [];
    // The strips: running against the face along a → b on one side and the face along b → a on the other.
    edges.forEach((e) => {
        const ca = corners.get(e.a);
        const cb = corners.get(e.b);
        const sa = ca.fan.spokes.indexOf(e.b);
        const sb = cb.fan.spokes.indexOf(e.a);
        const arcA = arc(ca, ca.after.get(sa), ca.before.get(sa));
        const arcB = arc(cb, cb.before.get(sb), cb.after.get(sb));
        for (let j = 0; j < segments; j++) {
            const id = plan.newFace([arcB[j], arcA[j], arcA[j + 1], arcB[j + 1]]);
            if (id !== null) {
                made.push(id);
            }
        }
    });
    // The closing n-gons.
    corners.forEach((corner) => {
        const list = [];
        if (corner.closing) {
            corner.closing.forEach((bound) => list.push(bound.id));
            const left = corner.closing[0];
            const right = corner.closing[corner.closing.length - 1];
            const round = arc(corner, right, left);
            for (let j = 1; j < segments; j++) {
                list.push(round[j]);
            }
        } else if (corner.fan.closed && corner.sel.length >= 3) {
            corner.sel.forEach((s) => {
                const round = arc(corner, corner.before.get(s), corner.after.get(s));
                for (let j = 0; j < segments; j++) {
                    list.push(round[j]);
                }
            });
        }
        if (list.length > 0) {
            const id = plan.newFace(list);
            if (id !== null) {
                made.push(id);
            }
        }
    });
    // The old faces take the boundary vertices in place of the old ones.
    touched.forEach((f) => {
        const list = [];
        doc.faces.get(f).forEach((v) => {
            const corner = corners.get(v);
            if (!corner) {
                list.push(v);
            } else if (corner.arcFace === f) {
                const [right, left] = corner.rep.get(f);
                arc(corner, right, left).forEach((id) => list.push(id));
            } else {
                corner.rep.get(f).forEach((bound) => list.push(bound.id));
            }
        });
        plan.setFace(f, list);
    });
    corners.forEach((corner, v) => plan.delVert(v));
    plan.commit();
    setSelection(doc, op.a, 'f', made);
}

/**
 * Walks the ring of quads from an edge, both ways, stopping at any non-quad, a hole, or a quad already crossed.
 *
 * @param {Topo} topo The connections.
 * @param {number} a The edge's first end.
 * @param {number} b The edge's second end.
 * @returns {{rungs: object[], quads: object[]}} The cut edges {a, b, cuts} (a → b the way of the cut's position)
 *     and the quads crossed {f, from, to, fromA, toA, forward}.
 */
function walkRing(topo, a, b) {
    const doc = topo.doc;
    const rungs = new Map();
    const quads = [];
    const crossed = new Set();
    const start = {a, b, cuts: null};
    rungs.set(edgeKey(a, b), start);
    topo.edge(a, b).faces.forEach((first) => {
        let f = first;
        let rung = start;
        let from = a;
        let to = b;
        while (doc.faces.get(f).length === 4 && !crossed.has(f)) {
            crossed.add(f);
            // Opposite side: from, to, X, Y round the quad, or from, Y, X, to; X lies beside `to`, Y beside `from`.
            const list = doc.faces.get(f);
            const i = list.indexOf(from);
            const forward = list[(i + 1) % 4] === to;
            const nextFrom = list[(i + (forward ? 3 : 1)) % 4];
            const nextTo = list[(i + 2) % 4];
            const key = edgeKey(nextFrom, nextTo);
            let next = rungs.get(key);
            const known = next !== undefined;
            if (!known) {
                next = {a: nextFrom, b: nextTo, cuts: null};
                rungs.set(key, next);
            }
            quads.push({f, from: rung, to: next, fromA: from, toA: nextFrom, forward});
            const faces = topo.edge(nextFrom, nextTo).faces;
            if (known || faces.length !== 2) {
                break;
            }
            f = faces[0] === f ? faces[1] : faces[0];
            rung = next;
            from = nextFrom;
            to = nextTo;
        }
    });
    return {rungs: Array.from(rungs.values()), quads};
}

/**
 * A rung's whole line of vertices from a given end: that end, the cuts, the other end.
 *
 * @param {{a: number, b: number, cuts: number[]}} rung The rung.
 * @param {number} from The end to start from.
 * @returns {number[]} The vertices.
 */
function railOf(rung, from) {
    const line = [rung.a].concat(rung.cuts, [rung.b]);
    return rung.a === from ? line : line.reverse();
}

/**
 * Puts a cut edge's new vertices into a face list, the right way round, when the list has the edge as a side.
 *
 * @param {number[]} list The list.
 * @param {{a: number, b: number, cuts: number[]}} rung The cut edge.
 * @returns {number[]} The new list (the same one when the edge is not a side of it).
 */
function insertCuts(list, rung) {
    const n = list.length;
    for (let i = 0; i < n; i++) {
        const u = list[i];
        const v = list[(i + 1) % n];
        if ((u === rung.a && v === rung.b) || (u === rung.b && v === rung.a)) {
            const between = u === rung.a ? rung.cuts : rung.cuts.slice().reverse();
            return list.slice(0, i + 1).concat(between, list.slice(i + 1));
        }
    }
    return list;
}

/**
 * mloop: cuts the ring of quads through an edge with evenly spaced loops; faces beside the ring's ends take the
 * new vertices into their lists, so the mesh stays closed. New edges selected.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opLoopCut(doc, op) {
    const topo = new Topo(doc);
    const [a, b] = op.e;
    const edge = topo.edge(a, b);
    if (!edge) {
        throw new Refusal('conflict');
    }
    if (edge.faces.length > 2 || !edge.faces.some((f) => doc.faces.get(f).length === 4)) {
        throw new Refusal('nonmanifold');
    }
    const count = op.n || 1;
    const st = op.st === undefined ? 0.5 : op.st;
    const {rungs, quads} = walkRing(topo, a, b);
    const plan = new Plan(doc, op);
    const step = 1 / (count + 1);
    const shift = (st - 0.5) * 2 * step;
    rungs.forEach((rung) => {
        const pa = doc.verts.get(rung.a);
        const pb = doc.verts.get(rung.b);
        rung.cuts = [];
        for (let k = 1; k <= count; k++) {
            const t = Math.max(CUT_MARGIN, Math.min(1 - CUT_MARGIN, k * step + shift));
            rung.cuts.push(plan.newVert(add(pa, scaled(sub(pb, pa), t))));
        }
    });
    // The quads of the ring, each cut into count + 1 quads of the same winding.
    const items = [];
    const parts = new Map();
    const own = new Map();
    quads.forEach((q) => {
        const one = railOf(q.from, q.fromA);
        const two = railOf(q.to, q.toA);
        const lists = [];
        for (let k = 0; k <= count; k++) {
            lists.push(q.forward ? [one[k], one[k + 1], two[k + 1], two[k]] : [one[k + 1], one[k], two[k], two[k + 1]]);
            if (k > 0) {
                items.push(Math.min(one[k], two[k]), Math.max(one[k], two[k]));
            }
        }
        parts.set(q.f, lists);
        own.set(q.f, [q.from, q.to]);
    });
    // Everything else along a cut edge takes the new vertices in: non-quads and quads the ring ended on.
    const others = new Map();
    rungs.forEach((rung) => {
        topo.edge(rung.a, rung.b).faces.forEach((f) => {
            if (!parts.has(f)) {
                others.set(f, insertCuts(others.get(f) || doc.faces.get(f), rung));
            } else if (own.get(f).indexOf(rung) === -1) {
                parts.set(f, parts.get(f).map((list) => insertCuts(list, rung)));
            }
        });
    });
    parts.forEach((lists, f) => {
        plan.setFace(f, lists[0]);
        for (let k = 1; k < lists.length; k++) {
            plan.newFace(lists[k]);
        }
    });
    others.forEach((list, f) => plan.setFace(f, list));
    plan.commit();
    setSelection(doc, op.a, 'e', items);
}

/**
 * Cuts a vertex list at its repeats into polygons without repeats, keeping the winding. Parts under 3 vertices go.
 *
 * @param {number[]} list The list.
 * @returns {number[][]} The polygons; the outermost first.
 */
function splitRepeats(list) {
    const stack = [];
    const place = new Map();
    const parts = [];
    list.forEach((v) => {
        if (place.has(v)) {
            const at = place.get(v);
            const part = stack.splice(at + 1);
            part.forEach((w) => place.delete(w));
            if (part.length >= 2) {
                parts.push([v].concat(part));
            }
        } else {
            place.set(v, stack.length);
            stack.push(v);
        }
    });
    return stack.length >= 3 ? [stack].concat(parts) : parts;
}

/**
 * Whether two vertex lists are the same cycle, reading the second forwards or (for `reverse`) backwards.
 *
 * @param {number[]} a One list.
 * @param {number[]} b The other, as long.
 * @param {boolean} reverse Read the second backwards.
 * @returns {boolean} True when they match.
 */
function sameCycle(a, b, reverse) {
    const n = a.length;
    const at = b.indexOf(a[0]);
    if (at === -1 || b.length !== n) {
        return false;
    }
    for (let i = 0; i < n; i++) {
        const j = reverse ? (at - i + n) % n : (at + i) % n;
        if (a[i] !== b[j]) {
            return false;
        }
    }
    return true;
}

/**
 * Key of a cell of a merge-by-distance grid. Coordinates are at most 0.4 m and cells at least 0.00001 m wide, so
 * cell numbers stay well inside ±50000 and the key inside a safe integer.
 *
 * @param {number} x Cell number along x.
 * @param {number} y Cell number along y.
 * @param {number} z Cell number along z.
 * @returns {number} The key.
 */
function cellKey(x, y, z) {
    return (x + 50000) + 1e5 * (y + 50000) + 1e10 * (z + 50000);
}

/**
 * The clusters of a merge by distance, in the selection's order: each first unclaimed vertex takes every other
 * unclaimed vertex within the distance (no chaining), as Blender's find doubles.
 *
 * @param {PolyDoc} doc The document.
 * @param {number[]} verts The vertices.
 * @param {number} r The distance.
 * @returns {number[][]} Clusters of two or more, each in selection order.
 */
function clustersByDistance(doc, verts, r) {
    const cells = new Map();
    verts.forEach((v, i) => {
        const p = doc.verts.get(v);
        pushTo(cells, cellKey(Math.floor(p[0] / r), Math.floor(p[1] / r), Math.floor(p[2] / r)), i);
    });
    const taken = new Uint8Array(verts.length);
    const out = [];
    const r2 = r * r;
    verts.forEach((v, i) => {
        if (taken[i]) {
            return;
        }
        taken[i] = 1;
        const p = doc.verts.get(v);
        const cx = Math.floor(p[0] / r);
        const cy = Math.floor(p[1] / r);
        const cz = Math.floor(p[2] / r);
        const near = [];
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    (cells.get(cellKey(cx + dx, cy + dy, cz + dz)) || []).forEach((j) => {
                        if (!taken[j]) {
                            const d = sub(doc.verts.get(verts[j]), p);
                            if (dot(d, d) <= r2) {
                                taken[j] = 1;
                                near.push(j);
                            }
                        }
                    });
                }
            }
        }
        if (near.length > 0) {
            near.sort((x, y) => x - y);
            out.push([v].concat(near.map((j) => verts[j])));
        }
    });
    return out;
}

/**
 * The mean position of some vertices.
 *
 * @param {PolyDoc} doc The document.
 * @param {number[]} verts The vertices.
 * @returns {number[]} The mean.
 */
function centroid(doc, verts) {
    const sum = [0, 0, 0];
    verts.forEach((v) => {
        const p = doc.verts.get(v);
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
    });
    return scaled(sum, 1 / verts.length);
}

/**
 * After a merge: removes faces that have come to name the same vertices. Two running opposite ways are the two
 * sides of a flattened pocket and both go, which keeps a closed mesh closed; of others the first stays.
 *
 * @param {PolyDoc} doc The document.
 * @param {Plan} plan The plan.
 * @param {Set<number>} targets The vertices merged into.
 * @param {Set<number>} changed The faces the merge changed or made.
 * @returns {void}
 */
function dropMergedDuplicates(doc, plan, targets, changed) {
    const final = [];
    doc.faces.forEach((list, f) => {
        if (!plan.delFaces.has(f)) {
            final.push({f, list: plan.setFaces.get(f) || list});
        }
    });
    plan.addFaces.forEach((list, f) => final.push({f, list}));
    const groups = new Map();
    final.forEach((g) => {
        if (g.list.some((v) => targets.has(v))) {
            pushTo(groups, g.list.slice().sort((x, y) => x - y).join(','), g);
        }
    });
    groups.forEach((group) => {
        if (group.length < 2 || !group.some((g) => changed.has(g.f))) {
            return;
        }
        const kept = [];
        group.forEach((g) => {
            const pair = kept.findIndex((o) => sameCycle(o.list, g.list, true));
            if (pair !== -1) {
                plan.delFace(kept[pair].f);
                kept.splice(pair, 1);
                plan.delFace(g.f);
            } else if (kept.length > 0) {
                plan.delFace(g.f);
            } else {
                kept.push(g);
            }
        });
    });
}

/**
 * mmerge: collapses the selected vertices, or clusters of them by distance. Merged vertices selected.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opMerge(doc, op) {
    const verts = Array.from(new Set(doc.selectedVerts(op.a)));
    if (verts.length === 0) {
        throw new Refusal('empty');
    }
    const how = op.sm || 'centre';
    const merged = new Map();
    const places = new Map();
    const clusters = how === 'dist' ? clustersByDistance(doc, verts, op.r) : (verts.length > 1 ? [verts] : []);
    clusters.forEach((cluster) => {
        const target = how === 'last' ? cluster[cluster.length - 1] : cluster[0];
        cluster.forEach((v) => {
            if (v !== target) {
                merged.set(v, target);
            }
        });
        places.set(target, how === 'first' || how === 'last' ? doc.verts.get(target) : centroid(doc, cluster));
    });
    const plan = new Plan(doc, op);
    const touched = new Set();
    const changed = new Set();
    const targets = new Set(places.keys());
    doc.faces.forEach((list, f) => {
        if (!list.some((v) => merged.has(v))) {
            return;
        }
        list.forEach((v) => touched.add(v));
        const parts = splitRepeats(list.map((v) => (merged.has(v) ? merged.get(v) : v)));
        if (parts.length === 0) {
            plan.delFace(f);
            return;
        }
        plan.setFace(f, parts[0]);
        changed.add(f);
        for (let i = 1; i < parts.length; i++) {
            const id = plan.newFace(parts[i]);
            if (id !== null) {
                changed.add(id);
            }
        }
    });
    dropMergedDuplicates(doc, plan, targets, changed);
    places.forEach((p, v) => plan.setVert(v, p));
    merged.forEach((target, v) => plan.delVert(v));
    // Faces removed may leave vertices no face uses, the targets among them.
    plan.delFaces.forEach((f) => doc.faces.get(f).forEach((v) => touched.add(v)));
    targets.forEach((v) => touched.add(v));
    plan.dropUnused(Array.from(touched).filter((v) => !merged.has(v)));
    plan.commit();
    const left = verts.filter((v) => doc.verts.has(v));
    setSelection(doc, op.a, 'v', left);
}

/**
 * mdel: removes what the selection names and the vertices left with no face.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opDelete(doc, op) {
    const sel = doc.selectionOf(op.a);
    if (sel.items.length === 0) {
        throw new Refusal('empty');
    }
    const topo = new Topo(doc);
    const plan = new Plan(doc, op);
    const gone = new Set();
    if (sel.md === 'f') {
        sel.items.forEach((f) => gone.add(f));
    } else if (sel.md === 'e') {
        existingEdges(topo, sel.items).forEach((e) => e.faces.forEach((f) => gone.add(f)));
    } else {
        sel.items.forEach((v) => (topo.vertFaces.get(v) || []).forEach((f) => gone.add(f)));
    }
    const touched = new Set(sel.md === 'v' ? sel.items : []);
    gone.forEach((f) => {
        doc.faces.get(f).forEach((v) => touched.add(v));
        plan.delFace(f);
    });
    plan.dropUnused(touched);
    plan.commit();
    setSelection(doc, op.a, sel.md, []);
}

/**
 * Orders edges into one simple closed chain, when they make one.
 *
 * @param {number[][]} pairs The edges as [u, v].
 * @returns {number[]|null} The chain's vertices in order, or null.
 */
function closedChain(pairs) {
    if (pairs.length < 3) {
        return null;
    }
    const links = new Map();
    pairs.forEach(([u, v]) => {
        pushTo(links, u, v);
        pushTo(links, v, u);
    });
    for (const list of links.values()) {
        if (list.length !== 2) {
            return null;
        }
    }
    const start = pairs[0][0];
    const chain = [start];
    let prev = start;
    let at = pairs[0][1];
    while (at !== start) {
        chain.push(at);
        const list = links.get(at);
        const next = list[0] === prev ? list[1] : list[0];
        prev = at;
        at = next;
    }
    return chain.length === pairs.length ? chain : null;
}

/**
 * The outline an mfill selection names: a closed chain of edges or of vertices (open edges preferred, then any
 * edges among them), or else 3–64 vertices in selection order.
 *
 * @param {Topo} topo The connections.
 * @param {{md: string, items: number[]}} sel The selection.
 * @returns {number[]|null} The outline, or null when the selection names none.
 */
function fillOutline(topo, sel) {
    if (sel.md === 'e') {
        return closedChain(existingEdges(topo, sel.items).map((e) => [e.a, e.b]));
    }
    if (sel.md !== 'v') {
        return null;
    }
    const verts = Array.from(new Set(sel.items));
    const chosen = new Set(verts);
    const open = [];
    const any = [];
    topo.edges.forEach((e) => {
        if (chosen.has(e.a) && chosen.has(e.b)) {
            any.push([e.a, e.b]);
            if (e.faces.length === 1) {
                open.push([e.a, e.b]);
            }
        }
    });
    if (open.length === verts.length) {
        const chain = closedChain(open);
        if (chain) {
            return chain;
        }
    }
    if (any.length === verts.length) {
        const chain = closedChain(any);
        if (chain) {
            return chain;
        }
    }
    return verts.length >= 3 && verts.length <= MAX_FACE_SIZE ? verts : null;
}

/**
 * mfill: makes one face on the outline the selection names, wound as most of its neighbours want.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opFill(doc, op) {
    const sel = doc.selectionOf(op.a);
    if (sel.items.length === 0) {
        throw new Refusal('empty');
    }
    const topo = new Topo(doc);
    const outline = fillOutline(topo, sel);
    if (!outline || outline.length < 3 || outline.length > MAX_FACE_SIZE) {
        throw new Refusal('badselection');
    }
    const key = outline.slice().sort((x, y) => x - y).join(',');
    const twin = (topo.vertFaces.get(outline[0]) || []).some((f) => {
        return doc.faces.get(f).slice().sort((x, y) => x - y).join(',') === key;
    });
    if (twin || length(newellVector(outline.map((v) => doc.verts.get(v)))) < MIN_FILL_AREA) {
        throw new Refusal('badselection');
    }
    let vote = 0;
    outline.forEach((u, i) => {
        const v = outline[(i + 1) % outline.length];
        vote += topo.along(v, u).length - topo.along(u, v).length;
    });
    const plan = new Plan(doc, op);
    const id = plan.newFace(vote < 0 ? outline.slice().reverse() : outline);
    plan.commit();
    setSelection(doc, op.a, 'f', [id]);
}

/**
 * mflip: reverses the selected faces, or in vertex and edge mode every face of the selected vertices.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opFlip(doc, op) {
    const sel = doc.selectionOf(op.a);
    if (sel.items.length === 0) {
        throw new Refusal('empty');
    }
    let faces = sel.items;
    if (sel.md !== 'f') {
        const topo = new Topo(doc);
        const found = new Set();
        doc.selectedVerts(op.a).forEach((v) => (topo.vertFaces.get(v) || []).forEach((f) => found.add(f)));
        faces = Array.from(found);
    }
    if (faces.length === 0) {
        throw new Refusal('empty');
    }
    const plan = new Plan(doc, op);
    faces.forEach((f) => plan.setFace(f, doc.faces.get(f).slice().reverse()));
    plan.commit();
}

/**
 * What mirror does with the faces lying wholly on the plane. A connected patch whose every rim edge also has another
 * face is a wall between the two halves: it goes. Any other patch (a sheet in the plane) stays, unmirrored.
 *
 * @param {Topo} topo The connections.
 * @param {number[]} faces The faces being mirrored.
 * @param {Set<number>} welded The vertices on the plane.
 * @returns {{plane: Set<number>, walls: number[]}} Faces on the plane, and those of them to remove.
 */
function mirrorPlaneFaces(topo, faces, welded) {
    const doc = topo.doc;
    const plane = new Set(faces.filter((f) => doc.faces.get(f).every((v) => welded.has(v))));
    const seen = new Set();
    const walls = [];
    plane.forEach((start) => {
        if (seen.has(start)) {
            return;
        }
        seen.add(start);
        const patch = [start];
        for (let at = 0; at < patch.length; at++) {
            const list = doc.faces.get(patch[at]);
            list.forEach((u, i) => {
                topo.edge(u, list[(i + 1) % list.length]).faces.forEach((g) => {
                    if (plane.has(g) && !seen.has(g)) {
                        seen.add(g);
                        patch.push(g);
                    }
                });
            });
        }
        const inside = new Set(patch);
        let rim = 0;
        let backed = true;
        patch.forEach((f) => {
            const list = doc.faces.get(f);
            list.forEach((u, i) => {
                const e = topo.edge(u, list[(i + 1) % list.length]);
                if (e.faces.filter((g) => inside.has(g)).length === 1) {
                    rim++;
                    backed = backed && e.faces.length >= 2;
                }
            });
        });
        if (rim > 0 && backed) {
            patch.forEach((f) => walls.push(f));
        }
    });
    return {plane, walls};
}

/**
 * mmirror: copies the selection's islands (the whole mesh when nothing is selected) across x = 0, welding what lies
 * on the plane, with reversed winding so normals stay outward. New faces selected.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The op.
 * @returns {void}
 */
function opMirror(doc, op) {
    const topo = new Topo(doc);
    const seeds = doc.selectedVerts(op.a);
    let faces;
    if (seeds.length === 0) {
        faces = Array.from(doc.faces.keys());
    } else {
        const island = islandOf(topo, seeds);
        faces = Array.from(doc.faces.keys()).filter((f) => island.faces.has(f));
    }
    if (faces.length === 0) {
        throw new Refusal('empty');
    }
    const welded = new Set();
    faces.forEach((f) => {
        doc.faces.get(f).forEach((v) => {
            if (Math.abs(doc.verts.get(v)[0]) <= MIRROR_WELD) {
                welded.add(v);
            }
        });
    });
    const {plane, walls} = mirrorPlaneFaces(topo, faces, welded);
    const plan = new Plan(doc, op);
    welded.forEach((v) => {
        const p = doc.verts.get(v);
        if (p[0] !== 0) {
            plan.setVert(v, [0, p[1], p[2]]);
        }
    });
    const copies = new Map();
    const made = [];
    faces.forEach((f) => {
        if (!plane.has(f)) {
            const list = doc.faces.get(f).map((v) => {
                if (welded.has(v)) {
                    return v;
                }
                if (!copies.has(v)) {
                    const p = doc.verts.get(v);
                    copies.set(v, plan.newVert([-p[0], p[1], p[2]]));
                }
                return copies.get(v);
            });
            const id = plan.newFace(list.reverse());
            if (id !== null) {
                made.push(id);
            }
        }
    });
    const touched = new Set();
    walls.forEach((f) => {
        doc.faces.get(f).forEach((v) => touched.add(v));
        plan.delFace(f);
    });
    plan.dropUnused(touched);
    plan.commit();
    setSelection(doc, op.a, 'f', made);
}

/**
 * mbake: on the mesh, removes every face and vertex (the engine fills the clay from them first).
 *
 * @param {PolyDoc} doc The document.
 * @returns {void}
 */
function opBake(doc) {
    if (doc.faces.size === 0) {
        throw new Refusal('empty');
    }
    Array.from(doc.faces.keys()).forEach((f) => doc.delFace(f));
    Array.from(doc.verts.keys()).forEach((v) => doc.delVert(v));
}

/**
 * Applies a clean mesh op with an author to a document. A refused op changes nothing, and refusal is
 * deterministic, so every client refuses the same ops.
 *
 * @param {PolyDoc} doc The document.
 * @param {object} op The clean op.
 * @returns {{ok: boolean, reason: (string|undefined)}} {ok: true}, or {ok: false, reason} with a reason of MESH_REASONS.
 */
export function applyMeshOp(doc, op) {
    try {
        switch (op.k) {
            case 'msel':
                opSelect(doc, op);
                break;
            case 'mprim':
                opPrimitive(doc, op);
                break;
            case 'mxf':
                opTransform(doc, op);
                break;
            case 'mext':
                opExtrude(doc, op);
                break;
            case 'minset':
                opInset(doc, op);
                break;
            case 'mbevel':
                opBevel(doc, op);
                break;
            case 'mloop':
                opLoopCut(doc, op);
                break;
            case 'mmerge':
                opMerge(doc, op);
                break;
            case 'mdel':
                opDelete(doc, op);
                break;
            case 'mfill':
                opFill(doc, op);
                break;
            case 'mflip':
                opFlip(doc, op);
                break;
            case 'mmirror':
                opMirror(doc, op);
                break;
            case 'mbake':
                opBake(doc);
                break;
            default:
                throw new Refusal('empty');
        }
    } catch (e) {
        if (e instanceof Refusal) {
            return {ok: false, reason: e.reason};
        }
        throw e;
    }
    return {ok: true};
}
