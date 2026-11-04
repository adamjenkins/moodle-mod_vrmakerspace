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
 * The mesh tools: turn what a person does with the mouse or a VR controller (in the sculpture-local frame) into the
 * mesh ops of the wire format and hand them to the session. The desktop and the VR input both work through this module
 * and nothing else.
 *
 * What it knows of the mesh is the drawing data the engine posts (polymesh.renderData). The document itself lives in
 * the worker, and everything here is advisory: each op acts on the author's selection in the document it is applied
 * to, so a refusal or a race is settled the same way on every client, and is told through onMessage when it happens.
 *
 * - The drawing data arrives a moment after an op. Until it has had time to come, selection() answers with what the
 *   op is expected to give, and an empty selection is not refused here but left to the document to decide.
 * - Locks are advisory, as clay's are: selecting or editing something that shares a vertex with the selection of
 *   another person present is refused, naming them. Someone who has left stops counting at once.
 * - A drag takes its target from the whole way the pointer has gone, and each op sends what is still owed towards it,
 *   rounded, so rounding never adds up, and an op the rate cap held back is made up for by the next. Moves stop
 *   where the selection would reach the edge of the working space, so it keeps its shape.
 * - Extrude sends nothing until the pointer has moved, so a click does not leave faces of no size behind.
 *
 * No Moodle or three.js imports, so it runs in Node (tests/js/polypick.test.mjs); logging comes in as options.log.
 * ringVerts walks a ring of quads as js/engine/polyops.js does, which is modelled on Blender's bmo_subdivide_edgering.cc.
 *
 * @module     mod_vrmakerspace/modeltools
 * @copyright  Blender Authors
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** The actions a drag can have. */
export const MODEL_ACTIONS = Object.freeze(['select', 'move', 'rotate', 'scale', 'extrude', 'inset', 'bevel', 'loopcut']);

/** The tools that act at once on the selection or the whole mesh. */
export const MODEL_ONE_SHOTS = Object.freeze(['merge', 'delete', 'fill', 'flip', 'mirror', 'bake']);

/** The basic shapes. */
export const MODEL_SHAPES = Object.freeze(['cube', 'plane', 'cylinder', 'sphere', 'cone', 'torus']);

/** The op kind of each one-shot tool. */
const ONE_SHOT_KINDS = new Map([['merge', 'mmerge'], ['delete', 'mdel'], ['fill', 'mfill'], ['flip', 'mflip'],
    ['mirror', 'mmirror'], ['bake', 'mbake']]);

/** Why the document can refuse an op: each has a string meshrefused_<reason>. */
const REASONS = Object.freeze(['empty', 'needfaces', 'neededges', 'nonmanifold', 'badselection', 'limit', 'conflict',
    'nosolid']);

/** Selection modes. */
const MODES = Object.freeze(['v', 'e', 'f']);

/** The unit vector of each axis lock. */
const AXES = new Map([['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]);

/** Shapes that take a number of segments. */
const ROUND_SHAPES = Object.freeze(['cylinder', 'sphere', 'cone', 'torus']);

/** What the segments mean under each action: shapes (every action but these), bevel and loop cut, with their ranges. */
const SEGMENT_RANGES = new Map([['shape', [3, 48]], ['bevel', [1, 4]], ['loopcut', [1, 8]]]);

/** Starting segments of each. */
const DEFAULT_SEGMENTS = new Map([['shape', 16], ['bevel', 1], ['loopcut', 1]]);

/** Width range (m) of inset and bevel. */
const WIDTH_RANGES = new Map([['inset', [0.0005, 0.2]], ['bevel', [0.0005, 0.1]]]);

/** Size range (m) of a shape, and its size when none is given. */
const MIN_SHAPE_SIZE = 0.01;
const MAX_SHAPE_SIZE = 0.2;
const DEFAULT_SHAPE_SIZE = 0.08;

/** Largest coordinate of the mesh (m). */
const MAX_COORD = 0.4;

/** How long after an own op (ms) the drawing data may still be from before it: the worker's 33 ms and the way back. */
const SETTLE_MS = 120;

/** Op rate cap of a drag: ops a second and the burst allowed. */
const RATE = 30;
const BURST = 3;

/** Smallest interval between two previews (ms). */
const PREVIEW_MS = 33;

/** Largest turn per op (rad), and the smallest worth sending. */
const MAX_TURN = 0.5;
const MIN_TURN = 0.002;

/** Smallest move worth sending (m). */
const MIN_MOVE = 0.00002;

/** Range of a scale, per op and in total, and the smallest change worth sending. */
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const MIN_SCALE_CHANGE = 0.0002;

/** A pointer closer than this (m) to the pivot gives no direction to turn by. */
const MIN_ARM = 0.001;

/** Extrude starts once the pointer has gone this far (m). */
const MIN_DRAG = 0.001;

/** The distance from the pivot (m) a scale measures against, at the least. */
const MIN_SCALE_BASE = 0.01;

/** A loop cut this close (share of the edge) to the middle goes to the middle. */
const SLIDE_SNAP = 0.05;

/** Largest encoded selection op (bytes). */
const MAX_SELECTION_BYTES = 900;

/** The same message or refusal is not repeated within this time (ms). */
const MESSAGE_GAP = 1000;

/** How many one-shot strokes are remembered in case they come back refused. */
const MAX_REMEMBERED = 64;

/** The op index of a preview (Engine.setPreview): what it adds has ids of this index, and only it does. */
const PREVIEW_INDEX = 2147483647;

/** How many op indexes there are, and how many elements one op can make (polymesh.elementId). */
const INDEX_RANGE = 2147483648;
const ELEMENTS_PER_OP = 4096;

/** Most ops one flush at the end of a drag sends: it always gets there long before this. */
const MAX_FLUSH = 256;

/**
 * Round to 5 decimals (never -0).
 *
 * @param {number} v Value.
 * @returns {number}
 */
const r5 = (v) => Math.round(v * 1e5) / 1e5 + 0;

/**
 * Round to 4 decimals (never -0).
 *
 * @param {number} v Value.
 * @returns {number}
 */
const r4 = (v) => Math.round(v * 1e4) / 1e4 + 0;

/**
 * Round to 3 decimals (never -0).
 *
 * @param {number} v Value.
 * @returns {number}
 */
const r3 = (v) => Math.round(v * 1e3) / 1e3 + 0;

/**
 * Whether an element exists only in the preview on show, so no op sent can name it.
 *
 * @param {number} id Element id.
 * @returns {boolean}
 */
const isPreviewId = (id) => Math.floor(id / ELEMENTS_PER_OP) % INDEX_RANGE === PREVIEW_INDEX;

/**
 * Clamp a number.
 *
 * @param {number} v Value.
 * @param {number} lo Lowest.
 * @param {number} hi Highest.
 * @returns {number}
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A point or direction as [x, y, z], from an array or an object with x, y and z.
 *
 * @param {number[]|Object} v The value.
 * @returns {number[]|null} The three numbers, or null when it is not that.
 */
const pointOf = (v) => {
    if (!v) {
        return null;
    }
    const out = Array.isArray(v) ? [Number(v[0]), Number(v[1]), Number(v[2])] : [Number(v.x), Number(v.y), Number(v.z)];
    return out.every(Number.isFinite) ? out : null;
};

/**
 * The difference a − b.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]}
 */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * The dot product a · b.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number}
 */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The cross product a × b.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number[]}
 */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * |a|.
 *
 * @param {number[]} a Vector.
 * @returns {number}
 */
const lengthOf = (a) => Math.sqrt(dot(a, a));

/**
 * The part of a vector at right angles to a unit axis.
 *
 * @param {number[]} a Vector.
 * @param {number[]} axis Unit axis.
 * @returns {number[]}
 */
const flatten = (a, axis) => {
    const along = dot(a, axis);
    return [a[0] - axis[0] * along, a[1] - axis[1] * along, a[2] - axis[2] * along];
};

/**
 * The unit vector of a vector, or null when it has no length to speak of.
 *
 * @param {number[]|Object|null} v Vector.
 * @returns {number[]|null}
 */
const unitOf = (v) => {
    const p = pointOf(v);
    if (!p) {
        return null;
    }
    const l = lengthOf(p);
    return l < 1e-9 ? null : [p[0] / l, p[1] / l, p[2] / l];
};

/**
 * A rotation as a unit quaternion [x, y, z, w], from an array or an object with x, y, z and w.
 *
 * @param {number[]|Object} q The value.
 * @returns {number[]|null} The unit quaternion, or null when it is not one.
 */
const quatOf = (q) => {
    if (!q) {
        return null;
    }
    const v = Array.isArray(q) ? q.map(Number) : [Number(q.x), Number(q.y), Number(q.z), Number(q.w)];
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + v[3] * v[3]);
    return Number.isFinite(l) && l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l, v[3] / l] : null;
};

/**
 * The rotation that does b first and then a: the product a × b.
 *
 * @param {number[]} a Quaternion.
 * @param {number[]} b Quaternion.
 * @returns {number[]}
 */
const quatMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * The opposite of a unit quaternion's rotation.
 *
 * @param {number[]} q Quaternion.
 * @returns {number[]}
 */
const quatInverse = (q) => [-q[0], -q[1], -q[2], q[3]];

/**
 * A rotation about a unit axis.
 *
 * @param {number[]} axis Unit axis.
 * @param {number} angle Radians, right-handed about the axis.
 * @returns {number[]} The quaternion.
 */
const quatAbout = (axis, angle) => {
    const s = Math.sin(angle / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

/**
 * The shortest way to make a rotation.
 *
 * @param {number[]} q Quaternion.
 * @returns {{axis: number[], angle: number}|null} Unit axis and angle in [0, π], or null for no rotation.
 */
const quatTurn = (q) => {
    const sign = q[3] < 0 ? -1 : 1;
    const s = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    if (s < 1e-9) {
        return null;
    }
    return {
        axis: [sign * q[0] / s, sign * q[1] / s, sign * q[2] / s],
        angle: 2 * Math.atan2(s, sign * q[3]),
    };
};

/**
 * How much of a rotation goes about one axis.
 *
 * @param {number[]} q Quaternion.
 * @param {number[]} axis Unit axis.
 * @returns {number} Radians in [-π, π].
 */
const quatTwist = (q, axis) => {
    const angle = 2 * Math.atan2(q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2], q[3]);
    if (angle > Math.PI) {
        return angle - 2 * Math.PI;
    }
    return angle < -Math.PI ? angle + 2 * Math.PI : angle;
};

/** The lookup tables of each drawing data, made when first asked for. */
const TABLES = new WeakMap();

/**
 * The lookup tables of drawing data.
 *
 * @param {Object} data Drawing data.
 * @returns {{verts: Map<number, number>, faces: Map<number, number>, edgeFaces: Map|null, vertFaces: Map|null}} Vertex
 *     id → index and face id → index; edgeFacesOf and vertFacesOf fill in the other two when they are needed.
 */
const tablesOf = (data) => {
    let tables = TABLES.get(data);
    if (!tables) {
        const verts = new Map();
        const faces = new Map();
        data.vertIds.forEach((id, n) => verts.set(id, n));
        data.faceIds.forEach((id, n) => faces.set(id, n));
        tables = {verts, faces, edgeFaces: null, vertFaces: null};
        TABLES.set(data, tables);
    }
    return tables;
};

/**
 * The vertex ids of a face in order.
 *
 * @param {Object} data Drawing data.
 * @param {number} face Face index.
 * @returns {number[]}
 */
const faceList = (data, face) => {
    const out = [];
    for (let c = data.faceStart[face]; c < data.faceStart[face + 1]; c++) {
        out.push(data.vertIds[data.faceVerts[c]]);
    }
    return out;
};

/**
 * The key of an edge.
 *
 * @param {number} a A vertex id.
 * @param {number} b The other.
 * @returns {string}
 */
const edgeKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

/**
 * Which faces use each edge.
 *
 * @param {Object} data Drawing data.
 * @returns {Map<string, number[]>} Edge key → face indices.
 */
const edgeFacesOf = (data) => {
    const tables = tablesOf(data);
    if (!tables.edgeFaces) {
        tables.edgeFaces = new Map();
        for (let face = 0; face < data.faceIds.length; face++) {
            const list = faceList(data, face);
            list.forEach((v, n) => {
                const key = edgeKey(v, list[n + 1 === list.length ? 0 : n + 1]);
                if (tables.edgeFaces.has(key)) {
                    tables.edgeFaces.get(key).push(face);
                } else {
                    tables.edgeFaces.set(key, [face]);
                }
            });
        }
    }
    return tables.edgeFaces;
};

/**
 * Which faces use each vertex.
 *
 * @param {Object} data Drawing data.
 * @returns {Map<number, number[]>} Vertex id → face indices.
 */
const vertFacesOf = (data) => {
    const tables = tablesOf(data);
    if (!tables.vertFaces) {
        tables.vertFaces = new Map();
        for (let face = 0; face < data.faceIds.length; face++) {
            faceList(data, face).forEach((v) => {
                if (tables.vertFaces.has(v)) {
                    tables.vertFaces.get(v).push(face);
                } else {
                    tables.vertFaces.set(v, [face]);
                }
            });
        }
    }
    return tables.vertFaces;
};

/**
 * The vertices a selection comes to, without repeats, leaving out what the data does not know.
 *
 * @param {Object} data Drawing data.
 * @param {{md: string, items: number[]}} sel The selection.
 * @returns {number[]} Vertex ids.
 */
const verticesOf = (data, sel) => {
    const tables = tablesOf(data);
    const seen = new Set();
    if (sel.md === 'f') {
        sel.items.forEach((id) => {
            const face = tables.faces.get(id);
            if (face !== undefined) {
                faceList(data, face).forEach((v) => seen.add(v));
            }
        });
    } else {
        sel.items.forEach((id) => {
            if (tables.verts.has(id)) {
                seen.add(id);
            }
        });
    }
    return Array.from(seen);
};

/**
 * Where a vertex is.
 *
 * @param {Object} data Drawing data.
 * @param {number} id Vertex id.
 * @returns {number[]|null} Its position, or null when the data does not know it.
 */
const positionOf = (data, id) => {
    const n = tablesOf(data).verts.get(id);
    return n === undefined ? null : [data.vertPos[n * 3], data.vertPos[n * 3 + 1], data.vertPos[n * 3 + 2]];
};

/**
 * The centroid and bounds of some vertices.
 *
 * @param {Object} data Drawing data.
 * @param {number[]} verts Vertex ids.
 * @returns {{pivot: number[], min: number[], max: number[]}}
 */
const measure = (data, verts) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const sum = [0, 0, 0];
    verts.forEach((id) => {
        const p = positionOf(data, id);
        for (let n = 0; n < 3; n++) {
            sum[n] += p[n];
            min[n] = Math.min(min[n], p[n]);
            max[n] = Math.max(max[n], p[n]);
        }
    });
    return {pivot: sum.map((v) => r5(clamp(v / verts.length, -MAX_COORD, MAX_COORD))), min, max};
};

/**
 * The area-weighted mean normal of some faces.
 *
 * @param {Object} data Drawing data.
 * @param {number[]} faces Face ids.
 * @returns {number[]|null} Unit normal, or null when they point every way (a closed shape).
 */
const meanNormal = (data, faces) => {
    const total = [0, 0, 0];
    faces.forEach((id) => {
        const face = tablesOf(data).faces.get(id);
        if (face === undefined) {
            return;
        }
        const list = faceList(data, face).map((v) => positionOf(data, v));
        list.forEach((p, n) => {
            const q = list[n + 1 === list.length ? 0 : n + 1];
            total[0] += (p[1] - q[1]) * (p[2] + q[2]);
            total[1] += (p[2] - q[2]) * (p[0] + q[0]);
            total[2] += (p[0] - q[0]) * (p[1] + q[1]);
        });
    });
    return lengthOf(total) < 1e-9 ? null : unitOf(total);
};

/**
 * The vertices of the connected islands of some vertices.
 *
 * @param {Object} data Drawing data.
 * @param {number[]} seeds Vertex ids.
 * @returns {number[]} Vertex ids.
 */
const islandVerts = (data, seeds) => {
    const uses = vertFacesOf(data);
    const seen = new Set(seeds);
    const faces = new Set();
    const stack = Array.from(seen);
    while (stack.length > 0) {
        (uses.get(stack.pop()) || []).forEach((face) => {
            if (faces.has(face)) {
                return;
            }
            faces.add(face);
            faceList(data, face).forEach((v) => {
                if (!seen.has(v)) {
                    seen.add(v);
                    stack.push(v);
                }
            });
        });
    }
    return Array.from(seen);
};

/**
 * The vertices of the ring of quads a loop cut goes through from an edge, walking as the document does.
 *
 * @param {Object} data Drawing data.
 * @param {number} a One end of the edge.
 * @param {number} b The other.
 * @returns {number[]} Vertex ids.
 */
const ringVerts = (data, a, b) => {
    const users = edgeFacesOf(data);
    const seen = new Set([a, b]);
    const crossed = new Set();
    (users.get(edgeKey(a, b)) || []).forEach((first) => {
        let face = first;
        let from = a;
        let to = b;
        while (!crossed.has(face)) {
            const list = faceList(data, face);
            if (list.length !== 4) {
                return;
            }
            crossed.add(face);
            const at = list.indexOf(from);
            const nextFrom = list[(at + (list[(at + 1) % 4] === to ? 3 : 1)) % 4];
            const nextTo = list[(at + 2) % 4];
            seen.add(nextFrom);
            seen.add(nextTo);
            const faces = users.get(edgeKey(nextFrom, nextTo)) || [];
            if (faces.length !== 2) {
                return;
            }
            face = faces[0] === face ? faces[1] : faces[0];
            from = nextFrom;
            to = nextTo;
        }
    });
    return Array.from(seen);
};

/**
 * The side of a face closest to a point.
 *
 * @param {Object} data Drawing data.
 * @param {number} id Face id.
 * @param {number[]|null} point The point; without one, the face's first side.
 * @returns {number[]|null} [a, b] with a < b, or null when the data does not know the face.
 */
const nearestSide = (data, id, point) => {
    const face = tablesOf(data).faces.get(id);
    if (face === undefined) {
        return null;
    }
    const list = faceList(data, face);
    let best = null;
    let bestdist = Infinity;
    list.forEach((u, n) => {
        const v = list[n + 1 === list.length ? 0 : n + 1];
        let dist = 0;
        if (point) {
            const a = positionOf(data, u);
            const side = sub(positionOf(data, v), a);
            const away = sub(point, a);
            const t = clamp(dot(away, side) / Math.max(dot(side, side), 1e-12), 0, 1);
            dist = lengthOf([away[0] - side[0] * t, away[1] - side[1] * t, away[2] - side[2] * t]);
        }
        if (dist < bestdist) {
            bestdist = dist;
            best = [Math.min(u, v), Math.max(u, v)];
        }
    });
    return best;
};

/**
 * Every element of a mode.
 *
 * @param {Object} data Drawing data.
 * @param {string} md Mode.
 * @returns {number[]} The items; edges as flat pairs, low id first.
 */
const allItems = (data, md) => {
    if (md === 'v') {
        return Array.from(data.vertIds);
    }
    if (md === 'f') {
        return Array.from(data.faceIds);
    }
    const out = [];
    for (let n = 0; n < data.edges.length; n += 2) {
        const a = data.vertIds[data.edges[n]];
        const b = data.vertIds[data.edges[n + 1]];
        out.push(Math.min(a, b), Math.max(a, b));
    }
    return out;
};

/**
 * What a selection comes to in another mode: the vertices of what is selected, the edges of selected faces or between
 * selected vertices, and the faces all of whose vertices are selected.
 *
 * @param {Object} data Drawing data.
 * @param {{md: string, items: number[]}} sel The selection.
 * @param {string} md The mode wanted.
 * @returns {number[]} The items.
 */
const convertSelection = (data, sel, md) => {
    const verts = new Set(verticesOf(data, sel));
    if (md === 'v') {
        return Array.from(verts);
    }
    const out = [];
    if (md === 'f') {
        for (let face = 0; face < data.faceIds.length; face++) {
            if (faceList(data, face).every((v) => verts.has(v))) {
                out.push(data.faceIds[face]);
            }
        }
        return out;
    }
    if (sel.md === 'f') {
        const seen = new Set();
        sel.items.forEach((id) => {
            const face = tablesOf(data).faces.get(id);
            if (face === undefined) {
                return;
            }
            const list = faceList(data, face);
            list.forEach((u, n) => {
                const v = list[n + 1 === list.length ? 0 : n + 1];
                const key = edgeKey(u, v);
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push(Math.min(u, v), Math.max(u, v));
                }
            });
        });
        return out;
    }
    for (let n = 0; n < data.edges.length; n += 2) {
        const a = data.vertIds[data.edges[n]];
        const b = data.vertIds[data.edges[n + 1]];
        if (verts.has(a) && verts.has(b)) {
            out.push(Math.min(a, b), Math.max(a, b));
        }
    }
    return out;
};

/**
 * The items a pick names.
 *
 * @param {Object} hit {kind: 'v', id}, {kind: 'e', a, b} or {kind: 'f', id}.
 * @returns {number[]|null} The items, or null for what is not a pick.
 */
const itemsOfHit = (hit) => {
    if (hit.kind === 'v' || hit.kind === 'f') {
        return Number.isSafeInteger(hit.id) && hit.id >= 0 ? [hit.id] : null;
    }
    if (hit.kind === 'e' && Number.isSafeInteger(hit.a) && Number.isSafeInteger(hit.b) && hit.a !== hit.b) {
        return [Math.min(hit.a, hit.b), Math.max(hit.a, hit.b)];
    }
    return null;
};

/**
 * Whether a list of items holds all of some others.
 *
 * @param {string} md Mode.
 * @param {number[]} items The list.
 * @param {number[]} wanted The others.
 * @returns {boolean}
 */
const holdsAll = (md, items, wanted) => {
    if (md !== 'e') {
        return wanted.every((id) => items.includes(id));
    }
    for (let w = 0; w + 1 < wanted.length; w += 2) {
        let found = false;
        for (let n = 0; n + 1 < items.length && !found; n += 2) {
            found = items[n] === wanted[w] && items[n + 1] === wanted[w + 1];
        }
        if (!found) {
            return false;
        }
    }
    return true;
};

/**
 * A list of items without some others.
 *
 * @param {string} md Mode.
 * @param {number[]} items The list.
 * @param {number[]} gone The others.
 * @returns {number[]}
 */
const withoutItems = (md, items, gone) => {
    if (md !== 'e') {
        return items.filter((id) => !gone.includes(id));
    }
    const out = [];
    for (let n = 0; n + 1 < items.length; n += 2) {
        if (!holdsAll('e', gone, [items[n], items[n + 1]])) {
            out.push(items[n], items[n + 1]);
        }
    }
    return out;
};

/**
 * Whether two selections are the same.
 *
 * @param {{md: string, items: number[]}} a A selection.
 * @param {{md: string, items: number[]}} b The other.
 * @returns {boolean}
 */
const sameSelection = (a, b) => a.md === b.md && a.items.length === b.items.length && a.items.every((id, n) => id === b.items[n]);

/**
 * The time now in ms, on a clock that only goes forward.
 *
 * @returns {number}
 */
const systemClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Create the mesh tools.
 *
 * @param {Object} options {session, tools, engine, onChange(), onRefused(name), onMessage(stringkey, a), log(e), now()}.
 *     log and now are optional: where errors go (a Moodle page passes core/log's debug), and the clock in ms.
 * @returns {Object} The tools: {selectMode, setSelectMode, selection, selectHit, selectAll, selectNone, selectLinked,
 *     selectLoop, action, setAction, segments, segmentRange, setSegments, axis, setAxis, width, setWidth, pivot, addShape,
 *     runOneShot, begin, move, end, cancel, active, dispose}
 */
export const createModelTools = (options) => {
    const session = options.session;
    const tools = options.tools;
    const engine = options.engine;
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => undefined;
    const onRefused = typeof options.onRefused === 'function' ? options.onRefused : () => undefined;
    const onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => undefined;
    const log = typeof options.log === 'function' ? options.log : () => undefined;
    const clock = typeof options.now === 'function' ? options.now : systemClock;

    /** @type {Object|null} the latest drawing data */
    let data = typeof engine.polydata === 'function' ? engine.polydata() : null;
    /** The mode while the document holds no selection of this author. A face is what most first clicks are after. */
    let mode = 'f';
    let action = 'select';
    let axis = null;
    const segments = new Map(DEFAULT_SEGMENTS);
    let predicted = null;
    let predictedKnown = false;
    let settleAt = 0;
    let settleTimer = null;
    /** @type {{md: string, items: number[]}|null} the selection held still while a preview's shows on the data */
    let frozen = null;
    /** @type {{md: string, items: number[]}} what onChange last told */
    let told = {md: mode, items: []};
    /** @type {Object|null} the drag in progress */
    let gesture = null;
    let tokens = BURST;
    let lastRefill = 0;
    let lockCache = null;
    let lastTold = '';
    let lastToldAt = -Infinity;
    const oneShots = new Set();
    const unsubscribers = [];

    /** Tell the owner that something the toolbar shows has changed. */
    const changed = () => {
        try {
            onChange();
        } catch (e) {
            log(e);
        }
    };

    /**
     * The author id of this user.
     *
     * @returns {string}
     */
    const author = () => String(session.author());

    /**
     * Send an op to the session.
     *
     * @param {Object} op The op; the session stamps the author and the index.
     * @returns {boolean} Whether it was taken.
     */
    const submit = (op) => {
        try {
            return session.submit(op) !== false;
        } catch (e) {
            log(e);
            return false;
        }
    };

    /**
     * Whether this was said a moment ago, and if not, note that it is being said now.
     *
     * @param {string} text What is being said.
     * @returns {boolean}
     */
    const repeated = (text) => {
        const now = clock();
        if (text === lastTold && now - lastToldAt < MESSAGE_GAP) {
            return true;
        }
        lastTold = text;
        lastToldAt = now;
        return false;
    };

    /**
     * Show a message, unless it is showing already.
     *
     * @param {string} key String key.
     * @param {*} [a] String argument.
     */
    const tell = (key, a) => {
        if (repeated('m' + key)) {
            return;
        }
        try {
            onMessage(key, a);
        } catch (e) {
            log(e);
        }
    };

    /**
     * Say that someone else is working there, unless that is showing already.
     *
     * @param {string} name Their name.
     */
    const refuse = (name) => {
        if (repeated('r' + name)) {
            return;
        }
        try {
            onRefused(name);
        } catch (e) {
            log(e);
        }
    };

    /**
     * The own selection as the drawing data has it.
     *
     * @returns {{md: string, items: number[]}}
     */
    const selectionInData = () => {
        const me = author();
        const entry = data && Array.isArray(data.sels) ? data.sels.find((sel) => sel.a === me) : null;
        return entry ? {md: entry.md, items: entry.items} : {md: mode, items: []};
    };

    /**
     * The own selection as it stands or is about to.
     *
     * @returns {{md: string, items: number[]}}
     */
    const current = () => {
        if (frozen) {
            return frozen;
        }
        return predicted && clock() < settleAt ? predicted : selectionInData();
    };

    /**
     * Whether current() can be relied on: otherwise an empty answer may only mean the data has not come yet.
     *
     * @returns {boolean}
     */
    const known = () => clock() >= settleAt || predictedKnown;

    /** Let the owner know when the selection in the data differs from what it was last told. */
    const refresh = () => {
        if (frozen || clock() < settleAt) {
            return;
        }
        predicted = null;
        const sel = selectionInData();
        mode = sel.md;
        if (!sameSelection(sel, told)) {
            told = sel;
            changed();
        }
    };

    /**
     * Note that an op has gone out that changes the selection, with what it is expected to give.
     *
     * @param {{md: string, items: number[]}|null} prediction The selection expected, or null when it cannot be told.
     * @param {boolean} sure Whether the prediction is complete.
     */
    const settle = (prediction, sure) => {
        predicted = prediction;
        predictedKnown = sure;
        settleAt = clock() + SETTLE_MS;
        if (prediction) {
            mode = prediction.md;
            told = prediction;
        }
        if (settleTimer !== null) {
            clearTimeout(settleTimer);
        }
        settleTimer = setTimeout(() => {
            settleTimer = null;
            refresh();
        }, SETTLE_MS + 1);
    };

    /**
     * The vertices other people present have selected.
     *
     * @returns {Map<number, string>} Vertex id → a name.
     */
    const lockedVerts = () => {
        let peers = [];
        try {
            peers = typeof session.peers === 'function' ? session.peers() : [];
        } catch (e) {
            log(e);
        }
        const me = author();
        const key = peers.map((peer) => peer.peerid).join(',');
        if (lockCache && lockCache.data === data && lockCache.key === key) {
            return lockCache.verts;
        }
        const verts = new Map();
        if (data && peers.length > 0 && Array.isArray(data.sels)) {
            const names = new Map(peers.map((peer) => [String(peer.peerid), peer.name]));
            data.sels.forEach((sel) => {
                if (sel.a !== me && names.has(sel.a) && sel.items.length > 0) {
                    verticesOf(data, sel).forEach((v) => {
                        if (!verts.has(v)) {
                            verts.set(v, names.get(sel.a) || '');
                        }
                    });
                }
            });
        }
        lockCache = {data, key, verts};
        return verts;
    };

    /**
     * Who else has one of some vertices selected.
     *
     * @param {number[]} verts Vertex ids.
     * @returns {string|null} Their name ('' when not known yet), or null when the vertices are free.
     */
    const lockedBy = (verts) => {
        const locked = lockedVerts();
        if (locked.size === 0) {
            return null;
        }
        const taken = verts.find((v) => locked.has(v));
        return taken === undefined ? null : locked.get(taken);
    };

    /**
     * Whether some vertices are free, telling the person when they are not.
     *
     * @param {number[]} verts Vertex ids.
     * @returns {boolean}
     */
    const free = (verts) => {
        const name = lockedBy(verts);
        if (name === null) {
            return true;
        }
        refuse(name);
        return false;
    };

    /**
     * Take one op from a drag's rate budget.
     *
     * @returns {boolean} Whether an op may be sent now.
     */
    const takeToken = () => {
        const now = clock();
        tokens = Math.min(BURST, tokens + (now - lastRefill) * RATE / 1000);
        lastRefill = now;
        if (tokens >= 1) {
            tokens -= 1;
            return true;
        }
        return false;
    };

    /**
     * Make a selection, in as many ops as it takes.
     *
     * @param {string} md The mode.
     * @param {number[]} items The items.
     */
    const sendSelection = (md, items) => {
        if (items.length === 0) {
            submit({k: 'msel', md: md, sm: 'none'});
            return;
        }
        if (data && items.length === allItems(data, md).length) {
            submit({k: 'msel', md: md, sm: 'all'});
            return;
        }
        // What the op comes to with an index as long as they get, without its ids.
        const shell = JSON.stringify({k: 'msel', a: author(), i: 2147483647, md: md, sm: 'set', ids: []}).length;
        const step = md === 'e' ? 2 : 1;
        let verb = 'set';
        let chunk = [];
        let bytes = shell;
        for (let n = 0; n < items.length; n += step) {
            const part = items.slice(n, n + step);
            const cost = part.reduce((sum, id) => sum + String(id).length + 1, 0);
            if (chunk.length > 0 && bytes + cost > MAX_SELECTION_BYTES) {
                submit({k: 'msel', md: md, sm: verb, ids: chunk});
                verb = 'add';
                chunk = [];
                bytes = shell;
            }
            chunk.push(...part);
            bytes += cost;
        }
        submit({k: 'msel', md: md, sm: verb, ids: chunk});
    };

    /**
     * Send one op that is a whole stroke.
     *
     * @param {Object} op The op, without its stroke id.
     * @returns {boolean} Whether it was taken.
     */
    const sendStroke = (op) => {
        const s = tools.allocStroke();
        if (!submit(Object.assign({}, op, {s: s}))) {
            return false;
        }
        submit({k: 'end', s: s});
        tools.recordStroke(s);
        oneShots.add(s);
        if (oneShots.size > MAX_REMEMBERED) {
            oneShots.delete(oneShots.values().next().value);
        }
        return true;
    };

    /**
     * Close a drag's stroke, when it has sent anything.
     *
     * @param {Object} g The drag.
     * @param {boolean} worked Whether it changed anything, so that it belongs on the undo stack.
     */
    const closeStroke = (g, worked) => {
        if (g.ops > 0) {
            submit({k: 'end', s: g.s});
            if (worked) {
                tools.recordStroke(g.s);
            }
        }
    };

    /**
     * Send one op of a drag; a drag whose op was not taken stops, keeping what it has done.
     *
     * @param {Object} g The drag.
     * @param {Object} op The op, without its stroke id.
     * @returns {boolean} Whether it was taken.
     */
    const sendDragOp = (g, op) => {
        if (submit(Object.assign({}, op, {s: g.s}))) {
            g.ops++;
            return true;
        }
        gesture = null;
        closeStroke(g, g.ops > 0);
        changed();
        return false;
    };

    /**
     * The whole move a drag wants so far, within the working space.
     *
     * @param {Object} g The drag.
     * @returns {number[]} The move.
     */
    const moveTarget = (g) => {
        const way = sub(g.last, g.p0);
        const direction = AXES.get(axis) || g.normal;
        if (!direction) {
            return way.map((v, n) => clamp(v, -MAX_COORD - g.min[n], MAX_COORD - g.max[n]));
        }
        const along = dot(way, direction);
        const wanted = direction.map((v) => v * along);
        // Along a line it stops where the first vertex gets to the edge, so it stays on the line.
        let share = 1;
        wanted.forEach((v, n) => {
            if (v > 0) {
                share = Math.min(share, (MAX_COORD - g.max[n]) / v);
            } else if (v < 0) {
                share = Math.min(share, (-MAX_COORD - g.min[n]) / v);
            }
        });
        return wanted.map((v) => v * Math.max(0, share));
    };

    /**
     * Send what a move or extrude drag still owes.
     *
     * @param {Object} g The drag.
     * @param {boolean} force Whether to send it whatever the rate budget says.
     */
    const stepMove = (g, force) => {
        const target = moveTarget(g);
        if (g.kind === 'extrude' && !g.started) {
            if (lengthOf(target) < MIN_DRAG) {
                return;
            }
            takeToken();
            if (!sendDragOp(g, {k: 'mext'})) {
                return;
            }
            g.started = true;
        }
        const d = target.map((v, n) => r5(v - g.done[n]));
        if (d.every((v) => Math.abs(v) < MIN_MOVE) || (!force && !takeToken())) {
            return;
        }
        if (sendDragOp(g, {k: 'mxf', d: d})) {
            g.done = g.done.map((v, n) => v + d[n]);
        }
    };

    /**
     * Send one op towards a rotate drag's target.
     *
     * @param {Object} g The drag.
     * @param {boolean} force Whether to send it whatever the rate budget says.
     * @returns {boolean} Whether an op was sent.
     */
    const stepRotate = (g, force) => {
        const owed = quatTurn(quatMul(g.turnTarget, quatInverse(g.turnDone)));
        if (!owed || owed.angle < MIN_TURN || (!force && !takeToken())) {
            return false;
        }
        const x = owed.axis.map(r4);
        const turn = r4(Math.min(owed.angle, MAX_TURN));
        const sent = unitOf(x);
        if (!sent || turn === 0 || !sendDragOp(g, {k: 'mxf', p: g.pivot, x: x, g: turn})) {
            return false;
        }
        g.turnDone = quatMul(quatAbout(sent, turn), g.turnDone);
        return true;
    };

    /**
     * Follow the hand or pointer of a rotate drag.
     *
     * @param {Object} g The drag.
     * @param {number[]|null} quat The hand's rotation now, if it has one.
     */
    const followRotate = (g, quat) => {
        const locked = AXES.get(axis) || null;
        if (quat) {
            if (!g.quatBase) {
                g.quatBase = quat;
            } else if (locked) {
                g.sweep += quatTwist(quatMul(quat, quatInverse(g.quatPrevious)), locked);
                g.turnTarget = quatAbout(locked, g.sweep);
            } else {
                g.turnTarget = quatMul(quat, quatInverse(g.quatBase));
            }
            g.quatPrevious = quat;
            return;
        }
        const fixed = locked || g.viewAxis;
        const was = sub(g.previous, g.pivot);
        const now = sub(g.last, g.pivot);
        const a = fixed ? flatten(was, fixed) : was;
        const b = fixed ? flatten(now, fixed) : now;
        if (lengthOf(a) < MIN_ARM || lengthOf(b) < MIN_ARM) {
            return;
        }
        const turnAxis = cross(a, b);
        if (fixed) {
            g.sweep += Math.atan2(dot(fixed, turnAxis), dot(a, b));
            g.turnTarget = quatAbout(fixed, g.sweep);
        } else {
            const direction = unitOf(turnAxis);
            if (direction) {
                g.turnTarget = quatMul(quatAbout(direction, Math.atan2(lengthOf(turnAxis), dot(a, b))), g.turnTarget);
            }
        }
        g.previous = g.last;
    };

    /**
     * The whole scale a drag wants so far, per axis, within the working space.
     *
     * @param {Object} g The drag.
     * @returns {number[]} [sx, sy, sz].
     */
    const scaleTarget = (g) => {
        const ratio = lengthOf(sub(g.last, g.pivot)) / g.scaleBase;
        // How far each axis can go before a vertex reaches the edge.
        const most = [0, 1, 2].map((n) => {
            const up = g.max[n] - g.pivot[n] > 1e-9 ? (MAX_COORD - g.pivot[n]) / (g.max[n] - g.pivot[n]) : MAX_SCALE;
            const down = g.pivot[n] - g.min[n] > 1e-9 ? (MAX_COORD + g.pivot[n]) / (g.pivot[n] - g.min[n]) : MAX_SCALE;
            return Math.min(up, down, MAX_SCALE);
        });
        const locked = axis === null ? -1 : ['x', 'y', 'z'].indexOf(axis);
        if (locked !== -1) {
            return [0, 1, 2].map((n) => (n === locked ? clamp(ratio, MIN_SCALE, most[n]) : 1));
        }
        const uniform = clamp(ratio, MIN_SCALE, Math.min(most[0], most[1], most[2]));
        return [uniform, uniform, uniform];
    };

    /**
     * Send one op towards a scale drag's target.
     *
     * @param {Object} g The drag.
     * @param {boolean} force Whether to send it whatever the rate budget says.
     * @returns {boolean} Whether an op was sent.
     */
    const stepScale = (g, force) => {
        const target = scaleTarget(g);
        const sc = target.map((v, n) => r4(clamp(v / g.scaleDone[n], MIN_SCALE, MAX_SCALE)));
        if (sc.every((v) => Math.abs(v - 1) < MIN_SCALE_CHANGE) || (!force && !takeToken())) {
            return false;
        }
        if (!sendDragOp(g, {k: 'mxf', p: g.pivot, sc: sc})) {
            return false;
        }
        g.scaleDone = g.scaleDone.map((v, n) => v * sc[n]);
        return true;
    };

    /**
     * The op an inset or bevel drag comes to now.
     *
     * @param {Object} g The drag.
     * @returns {Object|null} The op, or null while the width is too small to mean anything.
     */
    const widthOp = (g) => {
        const range = WIDTH_RANGES.get(g.kind);
        const wanted = g.fixedWidth === null ? lengthOf(sub(g.last, g.p0)) : g.fixedWidth;
        if (r5(wanted) < range[0]) {
            return null;
        }
        const r = r5(Math.min(wanted, range[1]));
        return g.kind === 'inset' ? {k: 'minset', r: r} : {k: 'mbevel', r: r, n: segments.get('bevel')};
    };

    /**
     * The op a loop cut drag comes to now: from the middle of the edge, by how far the pointer has gone along it.
     *
     * @param {Object} g The drag.
     * @returns {Object} The op.
     */
    const loopOp = (g) => {
        const a = positionOf(data, g.edge[0]);
        const b = positionOf(data, g.edge[1]);
        let st = 0.5;
        if (a && b) {
            const side = sub(b, a);
            const squared = dot(side, side);
            if (squared > 1e-12) {
                const slid = clamp(0.5 + dot(sub(g.last, g.p0), side) / squared, 0, 1);
                st = Math.abs(slid - 0.5) < SLIDE_SNAP ? 0.5 : slid;
            }
        }
        return {k: 'mloop', e: g.edge.slice(), st: r3(st), n: segments.get('loopcut')};
    };

    /**
     * Show what an inset, bevel or loop cut drag would do now.
     *
     * @param {Object} g The drag.
     * @param {boolean} force Whether to show it however soon after the last.
     */
    const showPreview = (g, force) => {
        const op = g.kind === 'loopcut' ? loopOp(g) : widthOp(g);
        if (!op) {
            if (g.shown) {
                g.shown = false;
                g.lastJson = '';
                engine.preview(null);
            }
            return;
        }
        const json = JSON.stringify(op);
        const now = clock();
        if (json === g.lastJson || (!force && now - g.lastPreview < PREVIEW_MS)) {
            return;
        }
        g.lastJson = json;
        g.lastPreview = now;
        g.shown = true;
        engine.preview(Object.assign({a: author()}, op));
    };

    /**
     * Take back what an adjustable drag shows, and let the selection follow the data again.
     *
     * @param {Object} g The drag.
     */
    const endPreview = (g) => {
        if (g.shown) {
            g.shown = false;
            engine.preview(null);
        }
        frozen = null;
        settle(g.before, false);
    };

    /**
     * Do what a drag owes for where the pointer is now.
     *
     * @param {Object} g The drag.
     * @param {boolean} force Whether to do it whatever the rate budget says.
     */
    const advance = (g, force) => {
        if (g.kind === 'move' || g.kind === 'extrude') {
            stepMove(g, force);
        } else if (g.kind === 'rotate') {
            stepRotate(g, force);
        } else if (g.kind === 'scale') {
            stepScale(g, force);
        } else if (g.kind !== 'paint') {
            showPreview(g, force);
        }
    };

    /**
     * Send a drag's last steps, for as long as it lasts and its step still sends something.
     *
     * @param {Object} g The drag.
     * @param {function(Object, boolean): boolean} step stepRotate or stepScale.
     */
    const flushSteps = (g, step) => {
        for (let n = 0; n < MAX_FLUSH; n++) {
            if (gesture !== g || !step(g, true)) {
                return;
            }
        }
    };

    /**
     * Finish the drag in progress: everything it owes goes out, and it goes on the undo stack.
     */
    const finish = () => {
        const g = gesture;
        if (!g) {
            return;
        }
        if (g.kind === 'inset' || g.kind === 'bevel' || g.kind === 'loopcut') {
            gesture = null;
            endPreview(g);
            const op = g.kind === 'loopcut' ? loopOp(g) : widthOp(g);
            if (op) {
                sendStroke(op);
            }
        } else if (g.kind === 'paint') {
            gesture = null;
        } else {
            if (g.kind === 'rotate') {
                // Each pass sends one turn of at most MAX_TURN.
                flushSteps(g, stepRotate);
            } else if (g.kind === 'scale') {
                // Each pass sends one scale of at most MAX_SCALE.
                flushSteps(g, stepScale);
            } else {
                stepMove(g, true);
            }
            if (gesture !== g) {
                return;
            }
            gesture = null;
            closeStroke(g, true);
            settle(null, false);
        }
        changed();
    };

    /**
     * Undo a drag as if it had never been: a preview is taken back, a stroke already started is undone.
     */
    const cancel = () => {
        const g = gesture;
        if (!g) {
            return;
        }
        gesture = null;
        if (g.kind === 'inset' || g.kind === 'bevel' || g.kind === 'loopcut') {
            endPreview(g);
        } else if (g.ops > 0) {
            submit({k: 'end', s: g.s});
            submit({k: 'undo', t: g.s});
            // Extruded edges were selected and are going again, so the ones the extrude began from come back.
            if (g.kind === 'extrude') {
                sendSelection(g.before.md, g.before.items);
                settle(g.before, true);
            } else {
                settle(null, false);
            }
        }
        changed();
    };

    /**
     * Stop a drag because another person now holds what it is working on, keeping what it has done.
     *
     * @param {Object} g The drag.
     * @param {string} name Their name.
     */
    const refuseDrag = (g, name) => {
        if (g.kind === 'inset' || g.kind === 'bevel' || g.kind === 'loopcut') {
            cancel();
        } else {
            finish();
        }
        refuse(name);
    };

    /**
     * What the person is working on, checked: the selection when it is there and free, telling them when it is not.
     *
     * @returns {{sel: Object, verts: number[]}|null} The selection and its vertices.
     */
    const workingOn = () => {
        const sel = current();
        if (sel.items.length === 0) {
            if (known()) {
                tell('meshrefused_empty');
            }
            return null;
        }
        const verts = verticesOf(data, sel);
        return verts.length > 0 && free(verts) ? {sel, verts} : null;
    };

    /**
     * Start a move, rotate, scale or extrude drag.
     *
     * @param {string} kind The action.
     * @param {number[]} point Where the pointer is.
     * @param {Object} opts Drag options.
     * @returns {boolean} Whether it started.
     */
    const beginTransform = (kind, point, opts) => {
        const work = workingOn();
        if (!work) {
            return false;
        }
        if (kind === 'extrude' && work.sel.md === 'v') {
            tell('meshrefused_needfaces');
            return false;
        }
        const box = measure(data, work.verts);
        const flat = box.min.every((v, n) => box.max[n] - v < 1e-9);
        if ((kind === 'rotate' || kind === 'scale') && flat) {
            // One vertex, or several in one place, turns and scales into itself.
            return false;
        }
        const base = {kind, s: tools.allocStroke(), ops: 0, p0: point, last: point, verts: work.verts, before: work.sel};
        gesture = Object.assign(base, box);
        if (kind === 'move' || kind === 'extrude') {
            gesture.done = [0, 0, 0];
            gesture.started = false;
            gesture.normal = kind === 'extrude' && work.sel.md === 'f' ? meanNormal(data, work.sel.items) : null;
        } else if (kind === 'rotate') {
            gesture.turnTarget = [0, 0, 0, 1];
            gesture.turnDone = [0, 0, 0, 1];
            gesture.sweep = 0;
            gesture.previous = point;
            // The view's own axis when given: a ray's direction changes across the screen.
            gesture.viewAxis = unitOf(opts.view) || (opts.ray ? unitOf(opts.ray.dir || opts.ray.direction) : null);
            gesture.quatBase = quatOf(opts.quat);
            gesture.quatPrevious = gesture.quatBase;
        } else {
            gesture.scaleDone = [1, 1, 1];
            gesture.scaleBase = Math.max(lengthOf(sub(point, box.pivot)), MIN_SCALE_BASE);
        }
        return true;
    };

    /**
     * Start an inset or bevel drag.
     *
     * @param {string} kind The action.
     * @param {number[]} point Where the pointer is.
     * @param {Object} opts Drag options.
     * @returns {boolean} Whether it started.
     */
    const beginWidth = (kind, point, opts) => {
        const work = workingOn();
        if (!work) {
            return false;
        }
        if (kind === 'inset' && work.sel.md !== 'f') {
            tell('meshrefused_needfaces');
            return false;
        }
        if (kind === 'bevel' && work.sel.md !== 'e') {
            tell('meshrefused_neededges');
            return false;
        }
        const range = WIDTH_RANGES.get(kind);
        gesture = {kind, s: 0, ops: 0, p0: point, last: point, verts: work.verts, before: work.sel, shown: false, lastJson: '',
            lastPreview: -Infinity, fixedWidth: Number.isFinite(opts.width) ? clamp(opts.width, range[0], range[1]) : null};
        frozen = work.sel;
        showPreview(gesture, true);
        return true;
    };

    /**
     * The edge a pick chooses for a loop cut.
     *
     * @param {Object|null} hit The pick.
     * @returns {number[]|null} [a, b] with a < b.
     */
    const edgeOfHit = (hit) => {
        if (hit && hit.kind === 'e') {
            return itemsOfHit(hit);
        }
        return hit && hit.kind === 'f' ? nearestSide(data, hit.id, pointOf(hit.point)) : null;
    };

    /**
     * Start a loop cut drag on the edge picked, or else on the edge last selected.
     *
     * @param {number[]} point Where the pointer is.
     * @param {Object} opts Drag options.
     * @returns {boolean} Whether it started.
     */
    const beginLoopCut = (point, opts) => {
        const sel = current();
        let edge = edgeOfHit(opts.hit);
        if (!edge && sel.md === 'e' && sel.items.length >= 2) {
            edge = sel.items.slice(-2);
        }
        if (!edge) {
            tell('meshrefused_neededges');
            return false;
        }
        const verts = ringVerts(data, edge[0], edge[1]);
        if (!free(verts)) {
            return false;
        }
        gesture = {kind: 'loopcut', s: 0, ops: 0, p0: point, last: point, verts, before: sel, shown: false, lastJson: '',
            lastPreview: -Infinity, edge};
        frozen = sel;
        showPreview(gesture, true);
        return true;
    };

    /**
     * Make a pick the selection, or add it or take it away.
     *
     * @param {Object|null} hit The pick; no pick clears the selection, unless adding or removing.
     * @param {Object} opts {add, remove}
     * @returns {boolean} Whether the pick is now selected.
     */
    const select = (hit, opts) => {
        const sel = current();
        if (!hit) {
            if (!opts.add && !opts.remove && sel.items.length > 0) {
                submit({k: 'msel', md: sel.md, sm: 'none'});
                settle({md: sel.md, items: []}, true);
                changed();
            }
            return false;
        }
        const items = itemsOfHit(hit);
        if (!items || !data) {
            return false;
        }
        const md = hit.kind;
        const same = sel.md === md;
        if (opts.remove) {
            if (same && holdsAll(md, sel.items, items)) {
                submit({k: 'msel', md: md, sm: 'rem', ids: items});
                settle({md: md, items: withoutItems(md, sel.items, items)}, true);
                changed();
            }
            return false;
        }
        // Painting over what is selected already, or clicking it again, changes nothing.
        if (same && holdsAll(md, sel.items, items) && (opts.add || sel.items.length === items.length)) {
            return true;
        }
        if (!free(verticesOf(data, {md, items}))) {
            return false;
        }
        submit({k: 'msel', md: md, sm: opts.add ? 'add' : 'set', ids: items});
        settle({md: md, items: opts.add && same ? sel.items.concat(items) : items}, true);
        changed();
        return true;
    };

    if (typeof engine.on === 'function') {
        unsubscribers.push(engine.on('polymesh', (next) => {
            if (next) {
                data = next;
                refresh();
            }
        }));
        unsubscribers.push(engine.on('meshrefused', (detail) => {
            const op = detail && detail.op ? detail.op : {};
            const reason = detail ? detail.reason : '';
            if (gesture && op.s !== undefined && gesture.s === op.s) {
                // The drag is working on nothing now (someone else has deleted it, say): one message, and it stops.
                const g = gesture;
                gesture = null;
                closeStroke(g, g.ops > 1);
                settle(null, false);
                changed();
            } else if (oneShots.has(op.s)) {
                oneShots.delete(op.s);
                if (typeof tools.forgetStroke === 'function') {
                    tools.forgetStroke(op.s);
                }
            }
            if (REASONS.includes(reason)) {
                tell('meshrefused_' + reason);
            } else {
                log(detail);
            }
        }));
    }

    return {
        /** @returns {string} The selection mode: 'v', 'e' or 'f'. */
        get selectMode() {
            return current().md;
        },

        /**
         * Choose the selection mode. What is selected carries over into the new mode as far as it can.
         *
         * @param {string} md 'v', 'e' or 'f'.
         */
        setSelectMode: (md) => {
            if (!MODES.includes(md)) {
                return;
            }
            finish();
            const sel = current();
            if (sel.md === md) {
                return;
            }
            if (!data) {
                mode = md;
                changed();
                return;
            }
            const items = convertSelection(data, sel, md);
            sendSelection(md, items);
            settle({md, items}, true);
            changed();
        },

        /**
         * The own selection.
         *
         * @returns {{md: string, items: number[]}} A copy; edges as flat pairs, low id first.
         */
        selection: () => {
            const sel = current();
            return {md: sel.md, items: sel.items.slice()};
        },

        /**
         * Select what was picked.
         *
         * @param {Object|null} hit From polypick; no pick clears the selection, unless adding or removing.
         * @param {Object} [opts] {add: add to the selection, never taking anything away, so it can paint;
         *     remove: take the pick out of the selection}.
         * @returns {boolean} Whether the pick is now selected (false: nothing picked, or someone else has it).
         */
        selectHit: (hit, opts = {}) => {
            if (gesture && gesture.kind !== 'paint') {
                finish();
            }
            return select(hit, opts);
        },

        /** Select everything in the current mode, unless someone else is working on some of it. */
        selectAll: () => {
            finish();
            if (!data || !free(Array.from(data.vertIds))) {
                return;
            }
            const md = current().md;
            submit({k: 'msel', md: md, sm: 'all'});
            settle({md, items: allItems(data, md)}, true);
            changed();
        },

        /** Select nothing. */
        selectNone: () => {
            finish();
            select(null, {});
        },

        /**
         * Grow the selection to everything connected to it, unless someone else is working on some of that.
         *
         * @param {Object} [hit] A pick to grow from as well.
         */
        selectLinked: (hit) => {
            finish();
            if (!data) {
                return;
            }
            const sel = current();
            const items = hit ? itemsOfHit(hit) : null;
            const md = items ? hit.kind : sel.md;
            const seeds = verticesOf(data, sel).concat(items ? verticesOf(data, {md, items}) : []);
            if (seeds.length === 0) {
                if (known()) {
                    tell('meshrefused_empty');
                }
                return;
            }
            if (!free(islandVerts(data, seeds))) {
                return;
            }
            const op = {k: 'msel', md: md, sm: 'linked'};
            if (items) {
                op.ids = items;
            }
            submit(op);
            settle({md, items: sel.md === md ? sel.items : []}, false);
            changed();
        },

        /**
         * Select the edge loop through an edge: the one picked, or else the one last selected.
         *
         * @param {Object} [hit] The pick. A face's pick means its side closest to the point.
         */
        selectLoop: (hit) => {
            finish();
            if (!data) {
                return;
            }
            const sel = current();
            let edge = edgeOfHit(hit || null);
            if (!edge && sel.md === 'e' && sel.items.length >= 2) {
                edge = sel.items.slice(-2);
            }
            if (!edge) {
                tell('meshrefused_neededges');
                return;
            }
            if (!free(edge)) {
                return;
            }
            submit({k: 'msel', md: 'e', sm: 'loop', e: edge});
            settle({md: 'e', items: edge}, false);
            changed();
        },

        /** @returns {string} What a drag does. */
        get action() {
            return action;
        },

        /**
         * Choose what a drag does (finishes a drag in progress).
         *
         * @param {string} name One of MODEL_ACTIONS.
         */
        setAction: (name) => {
            if (!MODEL_ACTIONS.includes(name) || name === action) {
                return;
            }
            finish();
            action = name;
            changed();
        },

        /** @returns {number} The segments of the current action: bevel and loop cut have their own, shapes the rest. */
        get segments() {
            return segments.get(SEGMENT_RANGES.has(action) ? action : 'shape');
        },

        /**
         * The range of the segments of the current action.
         *
         * @returns {{min: number, max: number}}
         */
        segmentRange: () => {
            const range = SEGMENT_RANGES.get(SEGMENT_RANGES.has(action) ? action : 'shape');
            return {min: range[0], max: range[1]};
        },

        /**
         * Set the segments of the current action. A drag in progress shows the change.
         *
         * @param {number} n Segments; brought into the action's range.
         */
        setSegments: (n) => {
            const value = Math.round(Number(n));
            if (!Number.isFinite(value)) {
                return;
            }
            const key = SEGMENT_RANGES.has(action) ? action : 'shape';
            const range = SEGMENT_RANGES.get(key);
            segments.set(key, clamp(value, range[0], range[1]));
            if (gesture && gesture.kind === key) {
                showPreview(gesture, true);
            }
            changed();
        },

        /** @returns {string|null} The axis lock: null, 'x', 'y' or 'z'. */
        get axis() {
            return axis;
        },

        /**
         * Set the axis lock. A drag in progress follows it at once; a turn starts again from where the drag began.
         *
         * @param {string|null} name null, 'x', 'y' or 'z'.
         */
        setAxis: (name) => {
            const next = AXES.has(name) ? name : null;
            if (next === axis) {
                return;
            }
            axis = next;
            if (gesture && gesture.kind === 'rotate') {
                gesture.turnTarget = [0, 0, 0, 1];
                gesture.sweep = 0;
                gesture.previous = gesture.last;
                gesture.quatBase = gesture.quatPrevious;
            }
            if (gesture) {
                advance(gesture, false);
            }
            changed();
        },

        /** @returns {number} The width an inset or bevel drag would make now (m), 0 when there is none. */
        get width() {
            if (!gesture || !WIDTH_RANGES.has(gesture.kind)) {
                return 0;
            }
            const op = widthOp(gesture);
            return op ? op.r : 0;
        },

        /**
         * Set the width of the inset or bevel drag in progress: from now on the pointer no longer decides it.
         *
         * @param {number} m Width (m); brought into the action's range.
         */
        setWidth: (m) => {
            const value = Number(m);
            if (!gesture || !WIDTH_RANGES.has(gesture.kind) || !Number.isFinite(value)) {
                return;
            }
            const range = WIDTH_RANGES.get(gesture.kind);
            gesture.fixedWidth = clamp(value, range[0], range[1]);
            showPreview(gesture, true);
            changed();
        },

        /**
         * The point a turn or scale works about.
         *
         * @returns {number[]|null} The centroid of the selected vertices, or null with nothing selected.
         */
        pivot: () => {
            if (gesture && gesture.pivot) {
                return gesture.pivot.slice();
            }
            const verts = data ? verticesOf(data, current()) : [];
            return verts.length > 0 ? measure(data, verts).pivot : null;
        },

        /**
         * Add a basic shape. It becomes the selection.
         *
         * @param {string} shape One of MODEL_SHAPES.
         * @param {number[]|Object} p Where its centre goes, sculpture-local.
         * @param {number} [size] Half-extent or radius (m), 0.01 to 0.2.
         * @param {number[]|Object} [turnAxis] Axis of a turn.
         * @param {number} [angle] Size of the turn (rad).
         * @returns {boolean} Whether it was sent.
         */
        addShape: (shape, p, size, turnAxis, angle) => {
            const point = pointOf(p);
            if (!MODEL_SHAPES.includes(shape) || !point) {
                return false;
            }
            finish();
            const op = {
                k: 'mprim',
                sh: shape,
                p: point.map((v) => r5(clamp(v, -MAX_COORD, MAX_COORD))),
                r: r5(clamp(Number(size) || DEFAULT_SHAPE_SIZE, MIN_SHAPE_SIZE, MAX_SHAPE_SIZE)),
            };
            const unit = unitOf(turnAxis);
            const turn = r4(clamp(Number(angle) || 0, -Math.PI, Math.PI));
            if (unit && turn !== 0) {
                op.x = unit.map(r4);
                op.g = turn;
            }
            if (ROUND_SHAPES.includes(shape)) {
                op.n = segments.get('shape');
            }
            if (!sendStroke(op)) {
                return false;
            }
            settle({md: 'f', items: []}, false);
            changed();
            return true;
        },

        /**
         * Use a tool that acts at once.
         *
         * @param {string} name One of MODEL_ONE_SHOTS. 'bake' does not ask: asking is for whoever calls this.
         * @returns {boolean} Whether it was sent (false: refused here, and the person told).
         */
        runOneShot: (name) => {
            const kind = ONE_SHOT_KINDS.get(name);
            if (!kind) {
                return false;
            }
            finish();
            if (!data) {
                return false;
            }
            const sel = current();
            const whole = name === 'bake' || (name === 'mirror' && sel.items.length === 0);
            if (whole && data.faceIds.length === 0) {
                tell('meshrefused_empty');
                return false;
            }
            if (!whole && sel.items.length === 0 && known()) {
                tell('meshrefused_empty');
                return false;
            }
            const verts = whole ? Array.from(data.vertIds) : verticesOf(data, sel);
            if (name === 'merge' && verts.length === 1 && known()) {
                // Nothing to merge it with: the document would accept this and change nothing.
                tell('meshrefused_empty');
                return false;
            }
            if (!free(verts) || !sendStroke({k: kind})) {
                return false;
            }
            settle(sel, false);
            changed();
            return true;
        },

        /**
         * Start a drag under the current action.
         *
         * @param {number[]|Object} p The pointer or hand, sculpture-local.
         * @param {Object} [opts] {quat: the hand's rotation [x, y, z, w] (rotate); hit: from polypick (loop cut, select);
         *     view: a unit vector at the viewer, the axis a rotate turns about unless locked; ray: {origin, dir} of the
         *     pointer, that axis when there is no view; width: a fixed width (inset, bevel); add: under select, add the
         *     first pick rather than replace}.
         * @returns {boolean} Whether a drag has started (false: refused, and the person told, or nothing to do).
         */
        begin: (p, opts = {}) => {
            finish();
            const point = pointOf(p);
            if (!point || !data) {
                return false;
            }
            let started = false;
            if (action === 'select') {
                if (opts.hit !== undefined) {
                    select(opts.hit, {add: !!opts.add});
                    gesture = {kind: 'paint', s: 0, ops: 0, p0: point, last: point, verts: []};
                    started = true;
                }
            } else if (action === 'inset' || action === 'bevel') {
                started = beginWidth(action, point, opts);
            } else if (action === 'loopcut') {
                started = beginLoopCut(point, opts);
            } else {
                started = beginTransform(action, point, opts);
            }
            changed();
            return started;
        },

        /**
         * Continue the drag.
         *
         * @param {number[]|Object} p The pointer or hand, sculpture-local.
         * @param {Object} [opts] As begin. Under loop cut a hit on another edge moves the cut there; under select each
         *     hit is added to the selection.
         */
        move: (p, opts = {}) => {
            const g = gesture;
            if (!g) {
                return;
            }
            const point = pointOf(p);
            const quat = quatOf(opts.quat);
            if (point) {
                g.last = point;
            }
            if (g.kind === 'paint') {
                if (opts.hit) {
                    select(opts.hit, {add: true});
                }
                return;
            }
            const name = lockedBy(g.verts);
            if (name !== null) {
                refuseDrag(g, name);
                return;
            }
            if (g.kind === 'rotate') {
                followRotate(g, quat);
            } else if (WIDTH_RANGES.has(g.kind) && Number.isFinite(opts.width)) {
                const range = WIDTH_RANGES.get(g.kind);
                g.fixedWidth = clamp(opts.width, range[0], range[1]);
            } else if (g.kind === 'loopcut' && opts.hit) {
                const edge = edgeOfHit(opts.hit);
                // The pick was made on what the preview shows: a piece of the cut itself is not an edge of the mesh.
                if (edge && !edge.some(isPreviewId) && edgeKey(edge[0], edge[1]) !== edgeKey(g.edge[0], g.edge[1])) {
                    const verts = ringVerts(data, edge[0], edge[1]);
                    if (lockedBy(verts) === null) {
                        g.edge = edge;
                        g.verts = verts;
                        g.p0 = g.last;
                    }
                }
            }
            advance(g, false);
        },

        /** Finish the drag: what it owes goes out, and a preview becomes the real thing. */
        end: () => {
            finish();
        },

        /** Call the drag off: a preview is taken back, and a stroke already started is undone. */
        cancel: () => {
            cancel();
        },

        /** @returns {boolean} Whether a drag is in progress. */
        get active() {
            return gesture !== null;
        },

        /** Call off a drag in progress and stop listening to the engine. */
        dispose: () => {
            cancel();
            unsubscribers.forEach((unsubscribe) => {
                if (typeof unsubscribe === 'function') {
                    unsubscribe();
                }
            });
            unsubscribers.length = 0;
            if (settleTimer !== null) {
                clearTimeout(settleTimer);
                settleTimer = null;
            }
        },
    };
};
