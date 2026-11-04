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
 * Tests of the polygon modelling operators (js/engine/polyops.js) on cubes, cylinders and hand-made meshes: element
 * counts, closed input staying watertight, refusals changing nothing, and determinism.
 *
 * Run from the repository root: node --test tests/js/polyops.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MESH_EDIT_KINDS, MESH_KINDS, applyMeshOp, cleanMeshOp} from '../../js/engine/polyops.js';
import {Capture, MAX_FACE_SIZE, MAX_VERTS, PolyDoc, elementId, exportMesh, newell, parseDoc, serializeDoc}
    from '../../js/engine/polymesh.js';
import {check} from '../../js/engine/validate.js';
import {R5, cos, sin} from '../../js/engine/mathx.js';

/** A cube's half extent in these tests. */
const H = 0.08;

/**
 * Whether a document's text form is the same.
 *
 * @param {PolyDoc} doc The document.
 * @returns {string} Its serialized form.
 */
function textOf(doc) {
    return Buffer.from(serializeDoc(doc)).toString('utf8');
}

/**
 * Asserts the document rules: faces of at least 3 distinct existing vertices, coordinates rounded and in range.
 *
 * @param {PolyDoc} doc The document.
 * @param {boolean} orphansAllowed True when vertices no face uses are expected.
 * @returns {void}
 */
function assertSound(doc, orphansAllowed) {
    const used = new Set();
    doc.faces.forEach((list, f) => {
        assert.ok(list.length >= 3, `face ${f} has ${list.length} vertices`);
        assert.equal(new Set(list).size, list.length, `face ${f} repeats a vertex`);
        assert.ok(list.length <= MAX_FACE_SIZE, `face ${f} is too long`);
        list.forEach((v) => {
            assert.ok(doc.verts.has(v), `face ${f} names missing vertex ${v}`);
            used.add(v);
        });
    });
    doc.verts.forEach((p, v) => {
        p.forEach((c) => {
            assert.ok(Number.isFinite(c), `vertex ${v} is not finite`);
            assert.equal(R5(c), c, `vertex ${v} is not rounded`);
            assert.ok(Math.abs(c) <= 0.4, `vertex ${v} is out of range`);
        });
        assert.ok(orphansAllowed || used.has(v), `vertex ${v} is an orphan`);
    });
}

/** Applies ops to a document for a test, keeping what was applied. */
class Bench {
    /**
     * Creates a bench.
     *
     * @param {PolyDoc} [doc] The document; a new one when not given.
     */
    constructor(doc) {
        this.doc = doc || new PolyDoc();
        this.index = 1000;
        this.ops = [];
        this.orphansAllowed = false;
    }

    /**
     * Makes a clean op from its fields, the author alice unless they say otherwise.
     *
     * @param {object} fields The op's fields.
     * @returns {object} The clean op.
     */
    clean(fields) {
        const c = cleanMeshOp(Object.assign({a: 'alice', s: 7, i: this.index++}, fields));
        assert.ok(c, 'not a valid op: ' + JSON.stringify(fields));
        return c;
    }

    /**
     * Applies an op that must succeed.
     *
     * @param {object} fields The op's fields.
     * @returns {void}
     */
    ok(fields) {
        const c = this.clean(fields);
        const r = applyMeshOp(this.doc, c);
        assert.deepEqual(r, {ok: true}, JSON.stringify(c));
        this.ops.push(c);
        assertSound(this.doc, this.orphansAllowed);
    }

    /**
     * Applies an op that must be refused, and checks that it changed nothing, a stroke's capture included.
     *
     * @param {object} fields The op's fields.
     * @param {string} reason The reason it must give.
     * @returns {void}
     */
    no(fields, reason) {
        const c = this.clean(fields);
        const before = textOf(this.doc);
        const rec = new Capture(c.a, 1);
        this.doc.rec = rec;
        const r = applyMeshOp(this.doc, c);
        this.doc.rec = null;
        assert.deepEqual(r, {ok: false, reason}, JSON.stringify(c));
        assert.equal(textOf(this.doc), before);
        assert.equal(rec.verts.size + rec.faces.size, 0);
    }

    /**
     * Sets a selection.
     *
     * @param {string} md The mode.
     * @param {number[]} ids The items.
     * @param {string} [author] The author.
     * @returns {void}
     */
    select(md, ids, author) {
        this.ok({k: 'msel', sm: 'set', md, ids, a: author || 'alice'});
    }
}

/**
 * The faces all of whose vertices pass a test.
 *
 * @param {PolyDoc} doc The document.
 * @param {function(number[]): boolean} test Tests a position.
 * @returns {number[]} The faces.
 */
function facesWhere(doc, test) {
    const out = [];
    doc.faces.forEach((list, f) => {
        if (list.every((v) => test(doc.verts.get(v)))) {
            out.push(f);
        }
    });
    return out;
}

/**
 * The vertices that pass a test.
 *
 * @param {PolyDoc} doc The document.
 * @param {function(number[]): boolean} test Tests a position.
 * @returns {number[]} The vertices.
 */
function vertsWhere(doc, test) {
    const out = [];
    doc.verts.forEach((p, v) => {
        if (test(p)) {
            out.push(v);
        }
    });
    return out;
}

/**
 * The first edge whose two ends pass a test.
 *
 * @param {PolyDoc} doc The document.
 * @param {function(number[], number[]): boolean} test Tests the two positions, both ways round.
 * @returns {number[]} [lo, hi].
 */
function edgeWhere(doc, test) {
    for (const key of doc.edgeFaces().keys()) {
        const [lo, hi] = key.split('_').map(Number);
        const a = doc.verts.get(lo);
        const b = doc.verts.get(hi);
        if (test(a, b) || test(b, a)) {
            return [lo, hi];
        }
    }
    assert.fail('no such edge');
    return [];
}

/**
 * Whether a position is one of a mesh's vertices.
 *
 * @param {PolyDoc} doc The document.
 * @param {number[]} q The position.
 * @returns {boolean} True when one lies within rounding of it.
 */
function hasVertAt(doc, q) {
    return vertsWhere(doc, (p) => Math.abs(p[0] - q[0]) < 2e-5 && Math.abs(p[1] - q[1]) < 2e-5 &&
        Math.abs(p[2] - q[2]) < 2e-5).length > 0;
}

/**
 * A document's sizes.
 *
 * @param {PolyDoc} doc The document.
 * @returns {number[]} [vertices, faces].
 */
function sizes(doc) {
    return [doc.verts.size, doc.faces.size];
}

/**
 * The print check of a document.
 *
 * @param {PolyDoc} doc The document.
 * @returns {object} The report.
 */
function report(doc) {
    return check(exportMesh(doc));
}

/**
 * Asserts that a document is closed, consistently wound and wound outward.
 *
 * @param {PolyDoc} doc The document.
 * @returns {object} The report.
 */
function assertWatertight(doc) {
    const r = report(doc);
    assert.equal(r.watertight, true, JSON.stringify(r));
    assert.ok(r.volumemm3 > 0, 'inside out: ' + JSON.stringify(r));
    return r;
}

/**
 * A bench holding a cube about the origin, all its faces selected.
 *
 * @returns {Bench} The bench.
 */
function cubeBench() {
    const b = new Bench();
    b.ok({k: 'mprim', sh: 'cube', p: [0, 0, 0], r: H});
    return b;
}

/**
 * A bench holding a cylinder about the origin.
 *
 * @param {number} [n] Its segments.
 * @returns {Bench} The bench.
 */
function cylinderBench(n) {
    const b = new Bench();
    b.ok({k: 'mprim', sh: 'cylinder', p: [0, 0, 0], r: 0.1, n: n || 16});
    return b;
}

/**
 * The top face of a cube.
 *
 * @param {PolyDoc} doc The document.
 * @returns {number} The face.
 */
function topFace(doc) {
    return facesWhere(doc, (p) => p[1] > H - 1e-6)[0];
}

/**
 * The cube's edge along x at the top front.
 *
 * @param {PolyDoc} doc The document.
 * @returns {number[]} [lo, hi].
 */
function topFrontEdge(doc) {
    return edgeWhere(doc, (a, b) => a[1] > H - 1e-6 && b[1] > H - 1e-6 && a[2] > H - 1e-6 && b[2] > H - 1e-6);
}

/**
 * A bench holding a hand-made mesh.
 *
 * @param {number[][]} points The vertices' positions.
 * @param {number[][]} faces The faces, as indices of points.
 * @returns {{b: Bench, ids: number[]}} The bench and the vertex ids.
 */
function handMade(points, faces) {
    const b = new Bench();
    const ids = points.map((p, n) => {
        const id = elementId('hand', 1, n);
        b.doc.addVert(id, p);
        return id;
    });
    faces.forEach((list, n) => {
        b.doc.addFace(elementId('hand', 1, points.length + n), list.map((index) => ids[index]));
    });
    return {b, ids};
}

/**
 * A closed prism on an outline, with n-gon top and bottom.
 *
 * @param {number[][]} outline [x, s] corners, counter-clockwise on the (x, s) plane: seen from +Y, with s = −z.
 * @param {number} height Half its height.
 * @returns {{b: Bench, ids: number[]}} The bench and the vertex ids: the bottom corners, then the top corners.
 */
function prism(outline, height) {
    const n = outline.length;
    const points = [];
    outline.forEach(([x, s]) => points.push([x, -height, -s]));
    outline.forEach(([x, s]) => points.push([x, height, -s]));
    const faces = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push([i, j, n + j, n + i]);
    }
    const top = [];
    const bottom = [];
    for (let i = 0; i < n; i++) {
        top.push(n + i);
        bottom.push(n - 1 - i);
    }
    faces.push(top, bottom);
    return handMade(points, faces);
}

/** An L-shaped outline: concave at (0.04, 0.04). */
const L_OUTLINE = [[0, 0], [0.08, 0], [0.08, 0.04], [0.04, 0.04], [0.04, 0.08], [0, 0.08]];

test('kinds: all but msel are edits', () => {
    assert.equal(MESH_KINDS.length, 13);
    assert.ok(MESH_EDIT_KINDS.indexOf('msel') === -1);
    assert.ok(MESH_EDIT_KINDS.indexOf('mbake') !== -1);
    assert.equal(MESH_EDIT_KINDS.length, 12);
});

test('cleanMeshOp: wire order, rounding, unknown keys dropped, idempotent', () => {
    const c = cleanMeshOp({sc: [2.00004, 1, 1], p: [0.123456, 0, 0], i: 3, s: 2, a: 'u1', k: 'mxf', extra: 1});
    assert.equal(JSON.stringify(c), '{"k":"mxf","a":"u1","s":2,"i":3,"p":[0.12346,0,0],"sc":[2,1,1]}');
    assert.deepEqual(cleanMeshOp(c), c);
    const sel = cleanMeshOp({k: 'msel', i: 4, s: 9, sm: 'add', md: 'e', ids: [5, 4, 6, 7]});
    assert.equal(JSON.stringify(sel), '{"k":"msel","i":4,"md":"e","sm":"add","ids":[5,4,6,7]}');
    const loop = cleanMeshOp({k: 'mloop', i: 4, s: 9, e: [9, 3], st: 0.12345, n: 2});
    assert.equal(JSON.stringify(loop), '{"k":"mloop","s":9,"i":4,"st":0.123,"e":[9,3],"n":2}');
    const prim = cleanMeshOp({k: 'mprim', i: 4, s: 9, sh: 'torus', p: [0, 0, 0], r: 0.1, x: [0, 1, 0], g: 1, n: 8});
    assert.equal(JSON.stringify(prim), '{"k":"mprim","s":9,"i":4,"p":[0,0,0],"r":0.1,"x":[0,1,0],"g":1,"sh":"torus","n":8}');
    const merge = cleanMeshOp({k: 'mmerge', i: 4, s: 9, sm: 'first', r: 0.01});
    assert.equal(JSON.stringify(merge), '{"k":"mmerge","s":9,"i":4,"sm":"first"}');
    // A half turn survives its rounding, both ways and when cleaned again.
    const half = cleanMeshOp({k: 'mprim', i: 4, s: 9, sh: 'cube', p: [0, 0, 0], r: 0.1, x: [0, 1, 0], g: -Math.PI});
    assert.equal(half.g, -3.1416);
    assert.deepEqual(cleanMeshOp(half), half);
});

test('cleanMeshOp: refuses what is out of range', () => {
    const base = {s: 1, i: 1};
    const bad = [
        {k: 'nope'},
        {k: 'end'},
        {k: 'mext', s: undefined},
        {k: 'mext', s: 1, i: 0},
        {k: 'mext', s: 2147483648, i: 1},
        {k: 'msel', i: 1},
        {k: 'msel', sm: 'grow'},
        {k: 'msel', sm: 'set', md: 'x'},
        {k: 'msel', sm: 'set', ids: [-1]},
        {k: 'msel', sm: 'set', ids: [1.5]},
        {k: 'msel', sm: 'set', ids: new Array(600).fill(1000000000)},
        {k: 'msel', sm: 'loop'},
        {k: 'msel', sm: 'loop', e: [1]},
        {k: 'msel', sm: 'loop', e: [1, 1]},
        {k: 'mprim', sh: 'blob', p: [0, 0, 0], r: 0.1},
        {k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.001},
        {k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.3},
        {k: 'mprim', sh: 'cube', p: [0.5, 0, 0], r: 0.1},
        {k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.1, n: 2},
        {k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.1, n: 49},
        {k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.1, x: [0, 0, 0], g: 1},
        {k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.1, x: [0, 1, 0]},
        {k: 'mxf'},
        {k: 'mxf', d: [0.9, 0, 0]},
        {k: 'mxf', d: [0, 0, 0], sc: [1, 1, 1], p: [0, 0, 0]},
        {k: 'mxf', p: [0, 0, 0], x: [0, 1, 0], g: 0.6},
        {k: 'mxf', x: [0, 1, 0], g: 0.1},
        {k: 'mxf', p: [0, 0, 0], sc: [0.01, 1, 1]},
        {k: 'mxf', p: [0, 0, 0], sc: [21, 1, 1]},
        {k: 'minset'},
        {k: 'minset', r: 0.0001},
        {k: 'minset', r: 0.3},
        {k: 'minset', r: 0.01, m: 2},
        {k: 'mbevel', r: 0.2},
        {k: 'mbevel', r: 0.01, n: 5},
        {k: 'mbevel', r: 0.01, n: 0},
        {k: 'mloop'},
        {k: 'mloop', e: [1, 2], n: 9},
        {k: 'mloop', e: [1, 2], st: 1.5},
        {k: 'mmerge', sm: 'nope'},
        {k: 'mmerge', sm: 'dist'},
        {k: 'mmerge', sm: 'dist', r: 0.06},
    ];
    bad.forEach((fields) => {
        assert.equal(cleanMeshOp(Object.assign({}, base, fields)), null, JSON.stringify(fields));
    });
    assert.equal(cleanMeshOp(null), null);
    assert.equal(cleanMeshOp([]), null);
    assert.equal(cleanMeshOp({k: 'mext', s: 1, i: 1, a: 'bad author'}), null);
});

test('msel: set, add, remove, all, none', () => {
    const b = cubeBench();
    const doc = b.doc;
    assert.equal(doc.selectionOf('alice').md, 'f');
    assert.equal(doc.selectionOf('alice').items.length, 6);
    b.ok({k: 'msel', sm: 'all', md: 'v'});
    assert.equal(doc.selectionOf('alice').items.length, 8);
    b.ok({k: 'msel', sm: 'all', md: 'e'});
    assert.equal(doc.selectionOf('alice').md, 'e');
    assert.equal(doc.selectionOf('alice').items.length, 24);
    b.ok({k: 'msel', sm: 'none'});
    assert.deepEqual(doc.selectionOf('alice'), {md: 'e', items: []});
    const verts = Array.from(doc.verts.keys());
    b.select('v', [verts[0], verts[1], verts[0], 12345]);
    assert.deepEqual(doc.selectionOf('alice').items, [verts[0], verts[1]]);
    b.ok({k: 'msel', sm: 'add', ids: [verts[1], verts[2]]});
    assert.deepEqual(doc.selectionOf('alice').items, [verts[0], verts[1], verts[2]]);
    b.ok({k: 'msel', sm: 'rem', ids: [verts[1]]});
    assert.deepEqual(doc.selectionOf('alice').items, [verts[0], verts[2]]);
    // A remove in another mode changes nothing; an add in another mode starts over in that mode.
    b.ok({k: 'msel', sm: 'rem', md: 'f', ids: [verts[0]]});
    assert.deepEqual(doc.selectionOf('alice').items, [verts[0], verts[2]]);
    const top = topFace(doc);
    b.ok({k: 'msel', sm: 'add', md: 'f', ids: [top]});
    assert.deepEqual(doc.selectionOf('alice'), {md: 'f', items: [top]});
});

test('msel: edge items are stored low id first and only real edges count', () => {
    const b = cubeBench();
    const [lo, hi] = topFrontEdge(b.doc);
    b.select('e', [hi, lo, lo, hi, lo]);
    assert.deepEqual(b.doc.selectionOf('alice').items, [lo, hi]);
    const verts = Array.from(b.doc.verts.keys());
    const across = verts.find((v) => {
        const p = b.doc.verts.get(v);
        return p[1] < 0 && p[2] < 0;
    });
    b.ok({k: 'msel', sm: 'set', md: 'e', ids: [lo, across]});
    assert.deepEqual(b.doc.selectionOf('alice').items, []);
});

test('msel: linked grows to the connected island only', () => {
    const b = cubeBench();
    const first = topFace(b.doc);
    b.ok({k: 'mprim', sh: 'cube', p: [0.3, 0, 0], r: 0.05});
    b.select('f', [first]);
    b.ok({k: 'msel', sm: 'linked'});
    assert.equal(b.doc.selectionOf('alice').items.length, 6);
    b.select('e', topFrontEdge(b.doc));
    b.ok({k: 'msel', sm: 'linked'});
    assert.equal(b.doc.selectionOf('alice').items.length, 24);
    const far = vertsWhere(b.doc, (p) => p[0] > 0.2);
    b.select('v', [far[0]]);
    b.ok({k: 'msel', sm: 'linked'});
    assert.equal(b.doc.selectionOf('alice').items.length, 8);
    b.ok({k: 'msel', sm: 'none'});
    b.ok({k: 'msel', sm: 'linked', ids: [far[1]]});
    assert.equal(b.doc.selectionOf('alice').items.length, 8);
    // The selection grows from where it stands even when the op names another mode.
    b.select('f', [first]);
    b.ok({k: 'msel', sm: 'linked', md: 'v'});
    assert.equal(b.doc.selectionOf('alice').md, 'v');
    assert.equal(b.doc.selectionOf('alice').items.length, 8);
    assert.ok(b.doc.selectionOf('alice').items.every((v) => b.doc.verts.get(v)[0] < 0.2));
    // A pair of vertices with no edge between them connects nothing.
    const low = vertsWhere(b.doc, (p) => p[0] < 0 && p[1] < 0 && p[2] < 0)[0];
    b.ok({k: 'msel', sm: 'none'});
    b.ok({k: 'msel', sm: 'linked', md: 'e', ids: [low, far[0]]});
    assert.deepEqual(b.doc.selectionOf('alice').items, []);
});

test('msel: edge loops', () => {
    // A cube's edge has three-edged corners at both ends: the loop is just that edge.
    const b = cubeBench();
    const e = topFrontEdge(b.doc);
    b.ok({k: 'msel', sm: 'loop', e});
    assert.deepEqual(b.doc.selectionOf('alice'), {md: 'e', items: e});
    // A loop cut's new edges cross four-quad vertices: the loop goes round.
    const upright = edgeWhere(b.doc, (p, q) => p[1] < 0 && q[1] > 0 && p[0] > 0 && q[0] > 0 && p[2] > 0 && q[2] > 0);
    b.ok({k: 'mloop', e: upright});
    const cut = b.doc.selectionOf('alice').items.slice(0, 2);
    b.ok({k: 'msel', sm: 'none'});
    b.ok({k: 'msel', sm: 'loop', e: cut});
    assert.equal(b.doc.selectionOf('alice').items.length, 8);
    // Round a cap of a cylinder: the n-gon is the hub.
    const c = cylinderBench(16);
    const rim = edgeWhere(c.doc, (p, q) => p[1] > 0 && q[1] > 0);
    c.ok({k: 'msel', sm: 'loop', e: rim});
    assert.equal(c.doc.selectionOf('alice').items.length, 32);
    // Round a hole's rim.
    const p = new Bench();
    p.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1});
    const side = edgeWhere(p.doc, () => true);
    p.ok({k: 'msel', sm: 'loop', e: side});
    assert.equal(p.doc.selectionOf('alice').items.length, 8);
    // Along a torus, either way round it.
    const t = new Bench();
    t.ok({k: 'mprim', sh: 'torus', p: [0, 0, 0], r: 0.1, n: 12});
    t.ok({k: 'msel', sm: 'loop', e: edgeWhere(t.doc, () => true)});
    const count = t.doc.selectionOf('alice').items.length / 2;
    assert.ok(count === 12 || count === 6, String(count));
    // An edge that does not exist leaves the selection alone.
    const before = textOf(t.doc);
    t.ok({k: 'msel', sm: 'loop', e: [1, 2]});
    assert.equal(textOf(t.doc), before);
});

test('mprim: closed shapes, selected', () => {
    const shapes = [
        ['cube', 8, 6],
        ['cylinder', 32, 18],
        ['cone', 17, 17],
        ['sphere', 16 * 7 + 2, 16 * 8],
        ['torus', 16 * 8, 16 * 8],
    ];
    shapes.forEach(([sh, v, f]) => {
        const b = new Bench();
        b.ok({k: 'mprim', sh, p: [0, 0, 0], r: 0.1});
        assert.deepEqual(sizes(b.doc), [v, f], sh);
        assertWatertight(b.doc);
        assert.deepEqual(b.doc.selectionOf('alice'), {md: 'f', items: Array.from(b.doc.faces.keys())});
    });
    const plane = new Bench();
    plane.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1});
    assert.deepEqual(sizes(plane.doc), [4, 1]);
    assert.equal(report(plane.doc).boundaryedges, 4);
    // Near the limit of the space a shape is clamped, not refused.
    const edge = new Bench();
    edge.ok({k: 'mprim', sh: 'cube', p: [0.39, 0, 0], r: 0.2});
    assert.equal(Math.max(...Array.from(edge.doc.verts.values()).map((p) => p[0])), 0.4);
    // The same index twice is refused: the ids are taken.
    const twice = cubeBench();
    twice.index--;
    twice.no({k: 'mprim', sh: 'cube', p: [0.2, 0, 0], r: 0.05}, 'conflict');
});

test('mxf: moves, turns and scales the selected vertices', () => {
    const b = cubeBench();
    b.select('f', [topFace(b.doc)]);
    b.ok({k: 'mxf', d: [0, 0.02, 0]});
    assert.ok(hasVertAt(b.doc, [H, H + 0.02, H]));
    assert.ok(hasVertAt(b.doc, [H, -H, H]));
    assertWatertight(b.doc);
    b.ok({k: 'mxf', p: [0, 0, 0], sc: [2, 1, 1]});
    assert.ok(hasVertAt(b.doc, [2 * H, H + 0.02, H]));
    b.ok({k: 'mxf', p: [0, 0, 0], sc: [0.5, 1, 1]});
    b.ok({k: 'mxf', p: [0, 0, 0], x: [0, 2, 0], g: 0.5});
    const c = cos(0.5);
    const s = sin(0.5);
    assert.ok(hasVertAt(b.doc, [R5(H * c + H * s), H + 0.02, R5(H * c - H * s)]));
    assertWatertight(b.doc);
    // The selection is kept.
    assert.equal(b.doc.selectionOf('alice').items.length, 1);
    // One vertex, clamped to the space.
    const v = vertsWhere(b.doc, (p) => p[1] < 0 && p[0] > 0 && p[2] > 0)[0];
    b.select('v', [v]);
    b.ok({k: 'mxf', d: [0.8, 0, 0]});
    assert.equal(b.doc.verts.get(v)[0], 0.4);
    b.ok({k: 'msel', sm: 'none'});
    b.no({k: 'mxf', d: [0.01, 0, 0]}, 'empty');
});

test('mext: a face keeps the mesh closed and pulls outward', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    b.select('f', [top]);
    b.ok({k: 'mext'});
    assert.deepEqual(sizes(b.doc), [12, 10]);
    assert.deepEqual(b.doc.selectionOf('alice'), {md: 'f', items: [top]});
    const flat = assertWatertight(b.doc);
    assert.ok(Math.abs(flat.volumemm3 - 4096000) < 100);
    b.ok({k: 'mxf', d: [0, 0.05, 0]});
    assert.ok(hasVertAt(b.doc, [H, H + 0.05, H]));
    assert.ok(hasVertAt(b.doc, [H, H, H]));
    const pulled = assertWatertight(b.doc);
    assert.ok(Math.abs(pulled.volumemm3 - (4096000 + 160 * 160 * 50)) < 200);
    assert.ok(newell(b.doc.faces.get(top).map((v) => b.doc.verts.get(v)))[1] > 0.99);
});

test('mext: a region shares its vertices, a whole island stays, a plane closes', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    const right = facesWhere(b.doc, (p) => p[0] > H - 1e-6)[0];
    b.select('f', [top, right]);
    b.ok({k: 'mext'});
    assert.deepEqual(sizes(b.doc), [14, 12]);
    assertWatertight(b.doc);
    b.ok({k: 'mxf', p: [0, 0, 0], sc: [1.2, 1.2, 1.2]});
    assertWatertight(b.doc);
    const whole = cubeBench();
    const text = textOf(whole.doc);
    whole.ok({k: 'mext'});
    assert.equal(textOf(whole.doc), text);
    const plane = new Bench();
    plane.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1});
    plane.ok({k: 'mext'});
    assert.deepEqual(sizes(plane.doc), [8, 6]);
    assert.equal(report(plane.doc).boundaryedges, 0);
    assert.equal(report(plane.doc).flippededges, 0);
    plane.ok({k: 'mxf', d: [0, 0.05, 0]});
    assertWatertight(plane.doc);
    const cylinder = cylinderBench(16);
    const cap = facesWhere(cylinder.doc, (p) => p[1] > 0.09)[0];
    cylinder.select('f', [cap]);
    cylinder.ok({k: 'mext'});
    assert.deepEqual(sizes(cylinder.doc), [48, 34]);
    assertWatertight(cylinder.doc);
});

test('mext: edges get quads on shared copies, wound with their neighbours', () => {
    const p = new Bench();
    p.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1});
    p.ok({k: 'msel', sm: 'all', md: 'e'});
    p.ok({k: 'mext'});
    assert.deepEqual(sizes(p.doc), [8, 5]);
    assert.equal(p.doc.selectionOf('alice').md, 'e');
    assert.equal(p.doc.selectionOf('alice').items.length, 8);
    let r = report(p.doc);
    assert.equal(r.boundaryedges, 4);
    assert.equal(r.flippededges, 0);
    p.ok({k: 'mxf', d: [0, 0.03, 0]});
    assert.ok(hasVertAt(p.doc, [0.1, 0.03, 0.1]));

    const one = new Bench();
    one.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1});
    one.select('e', edgeWhere(one.doc, () => true));
    one.ok({k: 'mext'});
    assert.deepEqual(sizes(one.doc), [6, 2]);
    r = report(one.doc);
    assert.equal(r.flippededges, 0);
    assert.equal(r.nonmanifoldedges, 0);

    // Edges of a closed surface in a chain, with no open edge to go by, still agree with each other.
    const chain = cubeBench();
    chain.ok({k: 'msel', sm: 'set', md: 'e', ids: edgesOfFace(chain.doc, topFace(chain.doc))});
    chain.ok({k: 'mext'});
    assert.deepEqual(sizes(chain.doc), [12, 10]);
    assert.equal(report(chain.doc).flippededges, 0);

    const v = cubeBench();
    v.ok({k: 'msel', sm: 'all', md: 'v'});
    v.no({k: 'mext'}, 'needfaces');
    v.ok({k: 'msel', sm: 'none'});
    v.no({k: 'mext'}, 'empty');
});

/**
 * A face's edges as selection items.
 *
 * @param {PolyDoc} doc The document.
 * @param {number} f The face.
 * @returns {number[]} Flat pairs.
 */
function edgesOfFace(doc, f) {
    const list = doc.faces.get(f);
    const out = [];
    list.forEach((u, i) => out.push(u, list[(i + 1) % list.length]));
    return out;
}

test('minset: a face gets a rim, in its plane', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    b.select('f', [top]);
    b.ok({k: 'minset', r: 0.01});
    assert.deepEqual(sizes(b.doc), [12, 10]);
    assert.deepEqual(b.doc.selectionOf('alice'), {md: 'f', items: [top]});
    assert.ok(hasVertAt(b.doc, [H - 0.01, H, H - 0.01]));
    assert.ok(hasVertAt(b.doc, [H, H, H]));
    const r = assertWatertight(b.doc);
    assert.ok(Math.abs(r.volumemm3 - 4096000) < 100);
});

test('minset: regions, and each face separately', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    const right = facesWhere(b.doc, (p) => p[0] > H - 1e-6)[0];
    b.select('f', [top, right]);
    b.ok({k: 'minset', r: 0.01});
    assert.deepEqual(sizes(b.doc), [14, 12]);
    assertWatertight(b.doc);
    // At the crease the corner slides along it.
    assert.ok(hasVertAt(b.doc, [H, H, H - 0.01]));

    const two = cubeBench();
    const a = topFace(two.doc);
    const c = facesWhere(two.doc, (p) => p[0] > H - 1e-6)[0];
    two.select('f', [a, c]);
    two.ok({k: 'minset', r: 0.01, m: 1});
    assert.deepEqual(sizes(two.doc), [16, 14]);
    assertWatertight(two.doc);

    const whole = cubeBench();
    const text = textOf(whole.doc);
    whole.ok({k: 'minset', r: 0.01});
    assert.equal(textOf(whole.doc), text);
    whole.ok({k: 'minset', r: 0.01, m: 1});
    assert.deepEqual(sizes(whole.doc), [32, 30]);
    assertWatertight(whole.doc);
});

test('minset: a width past the middle stops short and the face keeps facing out', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    b.select('f', [top]);
    b.ok({k: 'minset', r: 0.2});
    const points = b.doc.faces.get(top).map((v) => b.doc.verts.get(v));
    points.forEach((p) => {
        assert.ok(Math.abs(p[0]) > 0 && Math.abs(p[0]) < H);
        assert.ok(Math.abs(p[2]) > 0 && Math.abs(p[2]) < H);
    });
    assert.ok(newell(points)[1] > 0.99);
    assertWatertight(b.doc);
});

test('minset: concave and sharp outlines', () => {
    const {b} = prism(L_OUTLINE, 0.03);
    const top = facesWhere(b.doc, (p) => p[1] > 0.02)[0];
    b.select('f', [top]);
    b.ok({k: 'minset', r: 0.005});
    assert.deepEqual(sizes(b.doc), [18, 14]);
    assertWatertight(b.doc);
    assert.ok(hasVertAt(b.doc, [0.035, 0.03, -0.035]), 'the concave corner moves away from the notch');
    assert.ok(newell(b.doc.faces.get(top).map((v) => b.doc.verts.get(v)))[1] > 0.99);

    const r = 0.002;
    const sharp = prism([[0, 0], [0.2, 0], [0, 0.01]], 0.03);
    const tip = sharp.b.doc.verts.get(sharp.ids[4]);
    const face = facesWhere(sharp.b.doc, (p) => p[1] > 0.02)[0];
    sharp.b.select('f', [face]);
    sharp.b.ok({k: 'minset', r});
    const next = sharp.b.doc.faces.get(face);
    const moved = next.map((v) => sharp.b.doc.verts.get(v)).find((p) => p[0] > 0.1);
    const dx = moved[0] - tip[0];
    const dz = moved[2] - tip[2];
    assert.ok(Math.sqrt(dx * dx + dz * dz) <= 4 * r + 1e-4, 'the sharp corner is limited');
    assertWatertight(sharp.b.doc);
});

test('minset: refusals', () => {
    const b = cubeBench();
    b.ok({k: 'msel', sm: 'all', md: 'v'});
    b.no({k: 'minset', r: 0.01}, 'needfaces');
    b.ok({k: 'msel', sm: 'all', md: 'e'});
    b.no({k: 'minset', r: 0.01}, 'needfaces');
    b.ok({k: 'msel', sm: 'none'});
    b.no({k: 'minset', r: 0.01}, 'empty');
});

test('mbevel: one edge, one and three segments', () => {
    const b = cubeBench();
    b.select('e', topFrontEdge(b.doc));
    b.ok({k: 'mbevel', r: 0.01});
    assert.deepEqual(sizes(b.doc), [10, 7]);
    assert.equal(b.doc.selectionOf('alice').md, 'f');
    assert.equal(b.doc.selectionOf('alice').items.length, 1);
    assert.ok(hasVertAt(b.doc, [H, H, H - 0.01]));
    assert.ok(hasVertAt(b.doc, [H, H - 0.01, H]));
    assert.ok(!hasVertAt(b.doc, [H, H, H]));
    assertWatertight(b.doc);

    const round = cubeBench();
    round.select('e', topFrontEdge(round.doc));
    round.ok({k: 'mbevel', r: 0.01, n: 3});
    assert.deepEqual(sizes(round.doc), [14, 9]);
    assert.equal(round.doc.selectionOf('alice').items.length, 3);
    assertWatertight(round.doc);
    // The arc lies on the circle of the rounded edge, and the end faces take it.
    const arc = vertsWhere(round.doc, (p) => p[1] > H - 0.0099 && p[1] < H - 0.0001 && p[2] > H - 0.0099 && p[2] < H - 0.0001);
    assert.equal(arc.length, 4);
    arc.forEach((v) => {
        const p = round.doc.verts.get(v);
        const dy = p[1] - (H - 0.01);
        const dz = p[2] - (H - 0.01);
        assert.ok(Math.abs(Math.sqrt(dy * dy + dz * dz) - 0.01) < 5e-5);
    });
    assert.ok(Array.from(round.doc.faces.values()).some((list) => list.length === 7), 'three corners and an arc of four');
});

test('mbevel: vertices with several selected edges', () => {
    // Two edges at a corner share a boundary vertex on each side and no closing face.
    const b = cubeBench();
    const corner = vertsWhere(b.doc, (p) => p[0] > 0 && p[1] > 0 && p[2] > 0)[0];
    const others = vertsWhere(b.doc, (p) => p[1] > 0 && (p[0] > 0) !== (p[2] > 0));
    b.select('e', [corner, others[0], corner, others[1]]);
    b.ok({k: 'mbevel', r: 0.01});
    assert.deepEqual(sizes(b.doc), [11, 8]);
    assertWatertight(b.doc);
    const round = cubeBench();
    round.select('e', [corner, others[0], corner, others[1]]);
    round.ok({k: 'mbevel', r: 0.01, n: 3});
    // The two strips share the arc at the corner: 5 old vertices, 2 + 2 + 2 on the boundary, 2 + 2 + 2 on the arcs.
    assert.deepEqual(sizes(round.doc), [17, 12]);
    assertWatertight(round.doc);

    // Three at a corner close it with an n-gon.
    const all = cubeBench();
    all.ok({k: 'msel', sm: 'all', md: 'e'});
    all.ok({k: 'mbevel', r: 0.01});
    assert.deepEqual(sizes(all.doc), [24, 26]);
    assert.equal(all.doc.selectionOf('alice').items.length, 20);
    assertWatertight(all.doc);
    const roundAll = cubeBench();
    roundAll.ok({k: 'msel', sm: 'all', md: 'e'});
    roundAll.ok({k: 'mbevel', r: 0.01, n: 3});
    assert.deepEqual(sizes(roundAll.doc), [72, 50]);
    assertWatertight(roundAll.doc);
});

test('mbevel: a cylinder rim', () => {
    [[1, 48, 34], [3, 80, 66]].forEach(([n, v, f]) => {
        const c = cylinderBench(16);
        const rim = edgeWhere(c.doc, (p, q) => p[1] > 0 && q[1] > 0);
        c.ok({k: 'msel', sm: 'loop', e: rim});
        c.ok({k: 'mbevel', r: 0.01, n});
        assert.deepEqual(sizes(c.doc), [v, f]);
        assertWatertight(c.doc);
    });
});

test('mbevel: a selected edge ending where unselected edges run on', () => {
    // After a loop cut the middle of an upright edge has four edges: the bevel of the upper part ends there.
    [[1, 15, 12], [3, 19, 14]].forEach(([n, v, f]) => {
        const b = cubeBench();
        const upright = edgeWhere(b.doc, (p, q) => p[1] < 0 && q[1] > 0 && p[0] > 0 && q[0] > 0 && p[2] > 0 && q[2] > 0);
        b.ok({k: 'mloop', e: upright});
        const part = edgeWhere(b.doc, (p, q) => p[1] > H - 1e-6 && Math.abs(q[1]) < 1e-6 && p[0] > 0 && q[0] > 0 &&
            p[2] > 0 && q[2] > 0);
        b.select('e', part);
        b.ok({k: 'mbevel', r: 0.01, n});
        assert.deepEqual(sizes(b.doc), [v, f]);
        assertWatertight(b.doc);
    });

    // A vertex with only two edges: the bevel ends in a tip on the other one.
    const m = cubeBench();
    const [a, c] = topFrontEdge(m.doc);
    const mid = elementId('hand', 1, 0);
    m.doc.addVert(mid, [0, H, H]);
    m.doc.edgeFaces().get(`${a}_${c}`).forEach((f) => {
        const list = m.doc.faces.get(f);
        const i = list.indexOf(a);
        const j = list[(i + 1) % list.length] === c ? i + 1 : i;
        const next = Array.from(list);
        next.splice(j, 0, mid);
        m.doc.setFace(f, next);
    });
    assertWatertight(m.doc);
    m.select('e', [a, mid]);
    m.ok({k: 'mbevel', r: 0.01});
    assert.deepEqual(sizes(m.doc), [10, 7]);
    assertWatertight(m.doc);
    m.select('f', m.doc.selectionOf('alice').items);
    assert.equal(m.doc.selectionOf('alice').items.length, 1);
});

test('mbevel: a concave edge, and a width too wide for the mesh', () => {
    const {b, ids} = prism(L_OUTLINE, 0.03);
    b.select('e', [ids[3], ids[9]]);
    b.ok({k: 'mbevel', r: 0.005, n: 2});
    assert.deepEqual(sizes(b.doc), [12 - 2 + 6, 8 + 2]);
    assertWatertight(b.doc);

    const wide = cubeBench();
    wide.ok({k: 'msel', sm: 'all', md: 'e'});
    wide.ok({k: 'mbevel', r: 0.1});
    assertWatertight(wide.doc);
    const top = facesWhere(wide.doc, (p) => p[1] > H - 1e-6)[0];
    assert.ok(newell(wide.doc.faces.get(top).map((v) => wide.doc.verts.get(v)))[1] > 0.99, 'still facing up');
});

test('mbevel: refusals', () => {
    const b = cubeBench();
    b.no({k: 'mbevel', r: 0.01}, 'neededges');
    b.ok({k: 'msel', sm: 'all', md: 'v'});
    b.no({k: 'mbevel', r: 0.01}, 'neededges');
    b.ok({k: 'msel', sm: 'none'});
    b.no({k: 'mbevel', r: 0.01}, 'empty');
    const plane = new Bench();
    plane.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1});
    plane.ok({k: 'msel', sm: 'all', md: 'e'});
    plane.no({k: 'mbevel', r: 0.01}, 'nonmanifold');
    // An edge with three faces.
    const fin = cubeBench();
    const e = topFrontEdge(fin.doc);
    fin.select('e', e);
    fin.ok({k: 'mext'});
    fin.select('e', e);
    fin.no({k: 'mbevel', r: 0.01}, 'nonmanifold');
    // Of an open edge and a closed one, only the closed one is beveled.
    const part = cubeBench();
    const closed = topFrontEdge(part.doc);
    part.select('f', [facesWhere(part.doc, (p) => p[1] < -H + 1e-6)[0]]);
    part.ok({k: 'mdel'});
    const hole = edgeWhere(part.doc, (p, q) => p[1] < 0 && q[1] < 0);
    part.select('e', closed.concat(hole));
    part.ok({k: 'mbevel', r: 0.01});
    assert.equal(part.doc.selectionOf('alice').items.length, 1);
    assert.equal(report(part.doc).nonmanifoldedges, 0);
    assert.equal(report(part.doc).flippededges, 0);
});

test('mloop: a cube, one and three cuts, placed by st', () => {
    const b = cubeBench();
    const upright = edgeWhere(b.doc, (p, q) => p[1] < 0 && q[1] > 0);
    const [lo, hi] = upright;
    const low = b.doc.verts.get(lo)[1] < 0 ? lo : hi;
    const high = low === lo ? hi : lo;
    b.ok({k: 'mloop', e: [low, high], st: 0.25});
    assert.deepEqual(sizes(b.doc), [12, 10]);
    assert.equal(b.doc.selectionOf('alice').md, 'e');
    assert.equal(b.doc.selectionOf('alice').items.length, 8);
    assert.equal(vertsWhere(b.doc, (p) => Math.abs(p[1] + 0.04) < 2e-5).length, 4);
    assertWatertight(b.doc);

    const three = cubeBench();
    three.ok({k: 'mloop', e: upright, n: 3});
    assert.deepEqual(sizes(three.doc), [20, 18]);
    assert.equal(three.doc.selectionOf('alice').items.length, 24);
    [-0.04, 0, 0.04].forEach((y) => {
        assert.equal(vertsWhere(three.doc, (p) => Math.abs(p[1] - y) < 2e-5).length, 4);
    });
    assertWatertight(three.doc);

    // The other way along the edge reads st from the other end.
    const back = cubeBench();
    back.ok({k: 'mloop', e: [high, low], st: 0.25});
    assert.equal(vertsWhere(back.doc, (p) => Math.abs(p[1] - 0.04) < 2e-5).length, 4);

    // At the very ends the cuts stay off the corners.
    const end = cubeBench();
    end.ok({k: 'mloop', e: [low, high], st: 0});
    assert.equal(vertsWhere(end.doc, (p) => Math.abs(p[1] + H) < 1e-6).length, 4);
    assertWatertight(end.doc);
});

test('mloop: a cylinder round its side, and across it into the caps', () => {
    const c = cylinderBench(16);
    const upright = edgeWhere(c.doc, (p, q) => p[1] < 0 && q[1] > 0);
    c.ok({k: 'mloop', e: upright});
    assert.deepEqual(sizes(c.doc), [48, 34]);
    assertWatertight(c.doc);

    [[1, 34, 19], [3, 38, 21]].forEach(([n, v, f]) => {
        const d = cylinderBench(16);
        const rim = edgeWhere(d.doc, (p, q) => p[1] > 0 && q[1] > 0);
        d.ok({k: 'mloop', e: rim, n});
        assert.deepEqual(sizes(d.doc), [v, f]);
        assert.deepEqual(Array.from(d.doc.faces.values()).map((list) => list.length).sort((x, y) => y - x).slice(0, 2),
            [16 + n, 16 + n]);
        assertWatertight(d.doc);
    });
});

test('mloop: refusals', () => {
    const b = cubeBench();
    b.no({k: 'mloop', e: [1, 2]}, 'conflict');
    const cone = new Bench();
    cone.ok({k: 'mprim', sh: 'cone', p: [0, 0, 0], r: 0.1});
    cone.no({k: 'mloop', e: edgeWhere(cone.doc, () => true)}, 'nonmanifold');
    // The caps of a 48-sided cylinder take two cuts of 8 and then no more.
    const c = cylinderBench(48);
    const cut = {k: 'mloop', e: edgeWhere(c.doc, (p, q) => p[1] > 0 && q[1] > 0), n: 8};
    c.ok(cut);
    c.ok({k: 'mloop', e: edgeWhere(c.doc, (p, q) => p[1] > 0 && q[1] > 0), n: 8});
    c.no({k: 'mloop', e: edgeWhere(c.doc, (p, q) => p[1] > 0 && q[1] > 0), n: 8}, 'limit');
    assertWatertight(c.doc);
});

test('mmerge: collapses to the centre, first or last', () => {
    const b = cubeBench();
    b.select('f', [topFace(b.doc)]);
    b.ok({k: 'mmerge'});
    assert.deepEqual(sizes(b.doc), [5, 5]);
    assert.equal(b.doc.selectionOf('alice').md, 'v');
    assert.equal(b.doc.selectionOf('alice').items.length, 1);
    assert.deepEqual(b.doc.verts.get(b.doc.selectionOf('alice').items[0]), [0, H, 0]);
    assertWatertight(b.doc);

    const e = cubeBench();
    const [lo, hi] = topFrontEdge(e.doc);
    e.select('v', [lo, hi]);
    e.ok({k: 'mmerge', sm: 'first'});
    assert.deepEqual(sizes(e.doc), [7, 6]);
    assert.ok(e.doc.verts.has(lo));
    assert.ok(!e.doc.verts.has(hi));
    assertWatertight(e.doc);

    const last = cubeBench();
    const place = last.doc.verts.get(hi);
    last.select('v', [lo, hi]);
    last.ok({k: 'mmerge', sm: 'last'});
    assert.deepEqual(last.doc.selectionOf('alice').items, [hi]);
    assert.deepEqual(last.doc.verts.get(hi), place);
    assertWatertight(last.doc);

    // Opposite corners of a face: the face goes.
    const diagonal = cubeBench();
    const list = diagonal.doc.faces.get(topFace(diagonal.doc));
    diagonal.select('v', [list[0], list[2]]);
    diagonal.ok({k: 'mmerge'});
    assert.deepEqual(sizes(diagonal.doc), [7, 5]);
    assertWatertight(diagonal.doc);

    // One vertex: nothing to do.
    const one = cubeBench();
    const before = Array.from(one.doc.verts.keys());
    one.select('v', [before[0]]);
    one.ok({k: 'mmerge'});
    assert.deepEqual(sizes(one.doc), [8, 6]);
    assert.deepEqual(one.doc.selectionOf('alice').items, [before[0]]);

    const none = cubeBench();
    none.ok({k: 'msel', sm: 'none'});
    none.no({k: 'mmerge'}, 'empty');
});

test('mmerge: a face pinched at a repeat becomes two', () => {
    const hexagon = [[0.04, 0], [0.02, 0.03], [-0.02, 0.03], [-0.04, 0], [-0.02, -0.03], [0.02, -0.03]];
    const {b, ids} = prism(hexagon, 0.03);
    b.select('v', [ids[6], ids[9]]);
    b.ok({k: 'mmerge'});
    assert.deepEqual(sizes(b.doc), [11, 9]);
    assert.equal(facesWhere(b.doc, (p) => p[1] > 0.02).length, 2);
    assertWatertight(b.doc);
});

test('mmerge: faces come to name the same vertices', () => {
    // A tetrahedron with one edge collapsed is two faces back to back with nothing inside: both go.
    const s = 0.05;
    const {b, ids} = handMade([[s, s, s], [s, -s, -s], [-s, s, -s], [-s, -s, s]],
        [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]]);
    assertWatertight(b.doc);
    b.select('v', [ids[0], ids[1]]);
    b.ok({k: 'mmerge'});
    assert.deepEqual(sizes(b.doc), [0, 0]);
    assert.deepEqual(b.doc.selectionOf('alice').items, []);
});

test('mmerge: by distance', () => {
    const b = new Bench();
    b.ok({k: 'mprim', sh: 'plane', p: [-0.1, 0, 0], r: 0.1});
    b.ok({k: 'mprim', sh: 'plane', p: [0.1, 0, 0], r: 0.1});
    b.ok({k: 'msel', sm: 'all', md: 'v'});
    b.ok({k: 'mmerge', sm: 'dist', r: 0.001});
    assert.deepEqual(sizes(b.doc), [6, 2]);
    assert.equal(b.doc.selectionOf('alice').items.length, 6);
    const r = report(b.doc);
    assert.equal(r.boundaryedges, 6);
    assert.equal(r.flippededges, 0);
    // Only among the selected, and not across a gap wider than the distance.
    const c = new Bench();
    c.ok({k: 'mprim', sh: 'plane', p: [-0.1, 0, 0], r: 0.1});
    c.ok({k: 'mprim', sh: 'plane', p: [0.1, 0, 0], r: 0.1});
    const left = vertsWhere(c.doc, (p) => p[0] < -0.001);
    c.select('v', left);
    c.ok({k: 'mmerge', sm: 'dist', r: 0.001});
    assert.deepEqual(sizes(c.doc), [8, 2]);
});

test('mdel and mfill: delete opens, fill closes', () => {
    const b = cubeBench();
    b.select('f', [topFace(b.doc)]);
    b.ok({k: 'mdel'});
    assert.deepEqual(sizes(b.doc), [8, 5]);
    assert.equal(report(b.doc).boundaryedges, 4);
    assert.deepEqual(b.doc.selectionOf('alice'), {md: 'f', items: []});
    b.no({k: 'mdel'}, 'empty');
    const rim = vertsWhere(b.doc, (p) => p[1] > 0);
    // Whatever order the rim's vertices are selected in.
    b.select('v', [rim[0], rim[3], rim[1], rim[2]]);
    b.ok({k: 'mfill'});
    assert.deepEqual(sizes(b.doc), [8, 6]);
    assert.equal(b.doc.selectionOf('alice').md, 'f');
    assert.equal(b.doc.selectionOf('alice').items.length, 1);
    const r = assertWatertight(b.doc);
    assert.ok(Math.abs(r.volumemm3 - 4096000) < 100);

    const e = cubeBench();
    const top = topFace(e.doc);
    const items = edgesOfFace(e.doc, top);
    e.select('f', [top]);
    e.ok({k: 'mdel'});
    e.select('e', [items[0], items[1], items[4], items[5], items[2], items[3], items[6], items[7]]);
    e.ok({k: 'mfill'});
    assert.deepEqual(sizes(e.doc), [8, 6]);
    assertWatertight(e.doc);
    // A cylinder's cap, by its edge loop.
    const c = cylinderBench(16);
    const cap = facesWhere(c.doc, (p) => p[1] > 0.09)[0];
    const rimEdge = edgeWhere(c.doc, (p, q) => p[1] > 0 && q[1] > 0);
    c.select('f', [cap]);
    c.ok({k: 'mdel'});
    c.ok({k: 'msel', sm: 'loop', e: rimEdge});
    assert.equal(c.doc.selectionOf('alice').items.length, 32);
    c.ok({k: 'mfill'});
    assert.deepEqual(sizes(c.doc), [32, 18]);
    assertWatertight(c.doc);
});

test('mdel: edges and vertices take their faces', () => {
    const b = cubeBench();
    b.select('e', topFrontEdge(b.doc));
    b.ok({k: 'mdel'});
    assert.deepEqual(sizes(b.doc), [8, 4]);
    const v = cubeBench();
    v.select('v', [Array.from(v.doc.verts.keys())[0]]);
    v.ok({k: 'mdel'});
    assert.deepEqual(sizes(v.doc), [7, 3]);
    const all = cubeBench();
    all.ok({k: 'mdel'});
    assert.deepEqual(sizes(all.doc), [0, 0]);
    assert.ok(all.doc.isEmpty());
});

test('mfill: what it refuses, and three free vertices', () => {
    const b = cubeBench();
    const verts = Array.from(b.doc.verts.keys());
    b.select('v', [verts[0], verts[1]]);
    b.no({k: 'mfill'}, 'badselection');
    b.ok({k: 'msel', sm: 'none'});
    b.no({k: 'mfill'}, 'empty');
    // The corners of a face that exists.
    b.select('v', Array.from(b.doc.faces.get(topFace(b.doc))));
    b.no({k: 'mfill'}, 'badselection');
    b.select('f', [topFace(b.doc)]);
    b.no({k: 'mfill'}, 'badselection');
    // Edges that do not close.
    const items = edgesOfFace(b.doc, topFace(b.doc));
    b.select('e', items.slice(0, 6));
    b.no({k: 'mfill'}, 'badselection');
    // Three vertices in a line.
    const cut = cubeBench();
    const upright = edgeWhere(cut.doc, (p, q) => p[1] < 0 && q[1] > 0);
    cut.ok({k: 'mloop', e: upright});
    const middle = vertsWhere(cut.doc, (p) => {
        const end = cut.doc.verts.get(upright[0]);
        return p[0] === end[0] && p[2] === end[2] && p[1] === 0;
    });
    cut.select('v', [upright[0], middle[0], upright[1]]);
    cut.no({k: 'mfill'}, 'badselection');
    // Any three vertices in selection order.
    const free = cubeBench();
    const fv = Array.from(free.doc.verts.keys());
    free.select('v', [fv[0], fv[3], fv[6]]);
    free.ok({k: 'mfill'});
    assert.deepEqual(sizes(free.doc), [8, 7]);
});

test('mflip: reverses, twice is nothing', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    const list = Array.from(b.doc.faces.get(top));
    b.select('f', [top]);
    const before = textOf(b.doc);
    b.ok({k: 'mflip'});
    assert.deepEqual(Array.from(b.doc.faces.get(top)), list.slice().reverse());
    assert.equal(b.doc.selectionOf('alice').items.length, 1);
    assert.equal(report(b.doc).flippededges, 4);
    b.ok({k: 'mflip'});
    assert.equal(textOf(b.doc), before);
    // A vertex's faces.
    const v = cubeBench();
    v.select('v', [Array.from(v.doc.verts.keys())[0]]);
    v.ok({k: 'mflip'});
    // The three edges among those faces still agree; the six on their rim do not.
    assert.equal(report(v.doc).flippededges, 6);
    // Everything: inside out.
    const all = cubeBench();
    all.ok({k: 'mflip'});
    assert.ok(report(all.doc).volumemm3 < 0);
    assert.equal(report(all.doc).flippededges, 0);
    const none = cubeBench();
    none.ok({k: 'msel', sm: 'none'});
    none.no({k: 'mflip'}, 'empty');
});

test('mmirror: separate copy, welded halves, the wall between them', () => {
    const away = new Bench();
    away.ok({k: 'mprim', sh: 'cube', p: [0.2, 0, 0], r: H});
    away.ok({k: 'mmirror'});
    assert.deepEqual(sizes(away.doc), [16, 12]);
    assert.equal(away.doc.selectionOf('alice').items.length, 6);
    assert.ok(hasVertAt(away.doc, [-0.2 - H, H, H]));
    const r = assertWatertight(away.doc);
    assert.ok(Math.abs(r.volumemm3 - 2 * 4096000) < 200);

    // A cylinder clear of the plane.
    const c = new Bench();
    c.ok({k: 'mprim', sh: 'cylinder', p: [0.2, 0, 0], r: 0.1});
    c.ok({k: 'mmirror'});
    assert.deepEqual(sizes(c.doc), [64, 36]);
    assertWatertight(c.doc);

    // A box open on the plane, nothing selected: the whole mesh, welded.
    const half = new Bench();
    half.ok({k: 'mprim', sh: 'cube', p: [H, 0, 0], r: H});
    half.select('f', facesWhere(half.doc, (p) => p[0] < 1e-6));
    half.ok({k: 'mdel'});
    half.ok({k: 'mmirror'});
    assert.deepEqual(sizes(half.doc), [12, 10]);
    const closed = assertWatertight(half.doc);
    assert.ok(Math.abs(closed.volumemm3 - 2 * 4096000) < 200);

    // A box with a face on the plane: that face would be a wall inside, and goes.
    const wall = new Bench();
    wall.ok({k: 'mprim', sh: 'cube', p: [H, 0, 0], r: H});
    wall.ok({k: 'mmirror'});
    assert.deepEqual(sizes(wall.doc), [12, 10]);
    assertWatertight(wall.doc);

    // Vertices within a millimetre of the plane are welded onto it.
    const near = new Bench();
    near.ok({k: 'mprim', sh: 'cube', p: [H + 0.0005, 0, 0], r: H});
    near.ok({k: 'mmirror'});
    assert.deepEqual(sizes(near.doc), [12, 10]);
    assert.equal(vertsWhere(near.doc, (p) => p[0] === 0).length, 4);
    assertWatertight(near.doc);

    // Only the selection's island.
    const two = new Bench();
    two.ok({k: 'mprim', sh: 'cube', p: [0.2, 0, 0], r: 0.05});
    const first = topFaceOf(two.doc);
    two.ok({k: 'mprim', sh: 'cube', p: [0, 0.2, 0.2], r: 0.05});
    two.select('f', [first]);
    two.ok({k: 'mmirror'});
    assert.deepEqual(sizes(two.doc), [24, 18]);
    assertWatertight(two.doc);

    // A sheet lying in the plane has no other side to make.
    const sheet = new Bench();
    sheet.ok({k: 'mprim', sh: 'plane', p: [0, 0, 0], r: 0.1, x: [0, 0, 1], g: 1.5708});
    sheet.ok({k: 'mmirror'});
    assert.deepEqual(sizes(sheet.doc), [4, 1]);

    const empty = new Bench();
    empty.no({k: 'mmirror'}, 'empty');
});

/**
 * Any face of a document.
 *
 * @param {PolyDoc} doc The document.
 * @returns {number} The first face.
 */
function topFaceOf(doc) {
    return Array.from(doc.faces.keys())[0];
}

test('mbake: empties the mesh, refused when there is nothing', () => {
    const b = cubeBench();
    b.ok({k: 'mbake'});
    assert.ok(b.doc.isEmpty());
    b.no({k: 'mbake'}, 'empty');
});

test('limits: a refused op leaves everything as it was', () => {
    const b = cubeBench();
    b.orphansAllowed = true;
    const top = topFace(b.doc);
    b.select('f', [top]);
    const room = MAX_VERTS - b.doc.verts.size - 3;
    for (let n = 0; n < room; n++) {
        b.doc.addVert(elementId('hand', 2, n % 4096) + 4096 * 1000 * Math.floor(n / 4096), [0, 0, 0]);
    }
    assert.equal(b.doc.verts.size, MAX_VERTS - 3);
    b.no({k: 'mext'}, 'limit');
    b.no({k: 'minset', r: 0.01}, 'limit');
    b.no({k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.1}, 'limit');
});

test('conflict: an op whose new ids exist is refused', () => {
    const b = cubeBench();
    b.select('f', [topFace(b.doc)]);
    b.ok({k: 'mext'});
    b.index--;
    b.no({k: 'mext'}, 'conflict');
});

test('capture: every change goes through the document\'s mutators', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    b.select('f', [top]);
    const rec = new Capture('alice', 7);
    b.doc.rec = rec;
    b.ok({k: 'minset', r: 0.01});
    b.doc.rec = null;
    assert.equal(rec.verts.size, 4);
    assert.equal(rec.faces.size, 5);
    assert.ok(rec.faces.get(top) !== null);
    let fresh = 0;
    rec.faces.forEach((list) => {
        fresh += list === null ? 1 : 0;
    });
    assert.equal(fresh, 4);
});

test('another author: deletes during a gesture', () => {
    const b = cubeBench();
    const top = topFace(b.doc);
    b.select('f', [top], 'alice');
    b.select('f', [top], 'bob');
    b.ok({k: 'mdel', a: 'bob'});
    b.no({k: 'mxf', d: [0, 0.01, 0]}, 'empty');
    b.no({k: 'mext'}, 'empty');
    b.no({k: 'minset', r: 0.01}, 'empty');
    b.no({k: 'mflip'}, 'empty');
    b.no({k: 'mdel'}, 'empty');

    // Alice holds an edge; Bob merges one of its ends away.
    const c = cubeBench();
    const [lo, hi] = topFrontEdge(c.doc);
    c.select('e', [lo, hi], 'alice');
    const far = vertsWhere(c.doc, (p) => p[1] < 0 && p[2] > 0).find((v) => c.doc.verts.get(v)[0] === c.doc.verts.get(lo)[0]);
    c.select('v', [far, lo], 'bob');
    c.ok({k: 'mmerge', sm: 'first', a: 'bob'});
    c.no({k: 'mbevel', r: 0.01}, 'empty');
    c.no({k: 'mloop', e: [lo, hi]}, 'conflict');

    // Alice holds vertices; Bob removes every face of the mesh.
    const d = cubeBench();
    d.ok({k: 'msel', sm: 'all', md: 'v'});
    d.ok({k: 'msel', sm: 'all', md: 'f', a: 'bob'});
    d.ok({k: 'mdel', a: 'bob'});
    d.no({k: 'mxf', d: [0, 0.01, 0]}, 'empty');
    d.no({k: 'mmerge'}, 'empty');
});

test('cylinders: inset, bevel, loop cut and merge keep them closed', () => {
    const cap = cylinderBench(16);
    const top = facesWhere(cap.doc, (p) => p[1] > 0.09)[0];
    cap.select('f', [top]);
    cap.ok({k: 'minset', r: 0.01});
    assert.deepEqual(sizes(cap.doc), [48, 34]);
    assert.deepEqual(cap.doc.selectionOf('alice'), {md: 'f', items: [top]});
    assertWatertight(cap.doc);

    // Two neighbouring side quads are one region: the upright between them keeps its two new vertices.
    const side = cylinderBench(16);
    const quads = Array.from(side.doc.faces.keys()).filter((f) => side.doc.faces.get(f).length === 4);
    side.select('f', quads.slice(0, 2));
    side.ok({k: 'minset', r: 0.005});
    assert.deepEqual(sizes(side.doc), [38, 24]);
    assertWatertight(side.doc);

    // One upright: at each end it slides on the two rim edges and the cap takes the arc.
    [[1, 34, 19], [3, 38, 21]].forEach(([n, v, f]) => {
        const c = cylinderBench(16);
        c.select('e', edgeWhere(c.doc, (p, q) => p[1] < 0 && q[1] > 0));
        c.ok({k: 'mbevel', r: 0.005, n});
        assert.deepEqual(sizes(c.doc), [v, f]);
        assertWatertight(c.doc);
    });

    const ring = cylinderBench(16);
    ring.ok({k: 'mloop', e: edgeWhere(ring.doc, (p, q) => p[1] < 0 && q[1] > 0), n: 3});
    assert.deepEqual(sizes(ring.doc), [80, 66]);
    assert.equal(ring.doc.selectionOf('alice').items.length, 96);
    assertWatertight(ring.doc);

    // Two rim vertices: the side quad between them becomes a triangle and the cap loses a corner.
    const merged = cylinderBench(16);
    merged.select('v', edgeWhere(merged.doc, (p, q) => p[1] > 0 && q[1] > 0));
    merged.ok({k: 'mmerge'});
    assert.deepEqual(sizes(merged.doc), [31, 18]);
    assert.equal(merged.doc.selectionOf('alice').items.length, 1);
    assertWatertight(merged.doc);
});

test('non-manifold input: the operators keep the document sound, and merging by distance mends it', () => {
    const b = cubeBench();
    const e = topFrontEdge(b.doc);
    b.select('e', e);
    b.ok({k: 'mext'});
    assert.deepEqual(sizes(b.doc), [10, 7]);
    assert.equal(report(b.doc).nonmanifoldedges, 1);
    b.no({k: 'mloop', e}, 'nonmanifold');
    b.select('f', [topFace(b.doc)]);
    b.ok({k: 'minset', r: 0.01});
    assert.deepEqual(sizes(b.doc), [14, 11]);
    b.ok({k: 'mext'});
    assert.deepEqual(sizes(b.doc), [18, 15]);
    // The fin and the unmoved extrusion have no width: they collapse, and what is left is a cube with an inset top.
    b.ok({k: 'msel', sm: 'all', md: 'v'});
    b.ok({k: 'mmerge', sm: 'dist', r: 0.00001});
    assert.deepEqual(sizes(b.doc), [12, 10]);
    assertWatertight(b.doc);
});

test('preview: the largest op index still makes ids', () => {
    const b = cubeBench();
    b.select('e', topFrontEdge(b.doc));
    const before = textOf(b.doc);
    const copy = b.doc.copy();
    const r = applyMeshOp(copy, cleanMeshOp({k: 'mbevel', a: 'alice', s: 2147483647, i: 2147483647, r: 0.01, n: 4}));
    assert.deepEqual(r, {ok: true});
    assertSound(copy, false);
    assertWatertight(copy);
    assert.equal(textOf(b.doc), before);
});

/**
 * Runs a long modelling session on a bench.
 *
 * @param {Bench} b The bench.
 * @returns {void}
 */
function session(b) {
    b.ok({k: 'mprim', sh: 'cube', p: [0.1, 0, 0], r: 0.05});
    const top = facesWhere(b.doc, (p) => p[1] > 0.049)[0];
    b.select('f', [top]);
    b.ok({k: 'mext'});
    b.ok({k: 'mxf', d: [0, 0.02, 0]});
    b.ok({k: 'minset', r: 0.01});
    b.ok({k: 'mext'});
    b.ok({k: 'mxf', p: [0.1, 0.07, 0], sc: [0.5, 1, 0.5]});
    b.ok({k: 'mxf', p: [0.1, 0.07, 0], x: [0, 1, 0], g: 0.3});
    b.select('e', edgesOfFace(b.doc, top).slice(0, 4));
    b.ok({k: 'mbevel', r: 0.002, n: 2});
    const upright = edgeWhere(b.doc, (p, q) => p[1] < -0.04 && q[1] > 0.04);
    b.ok({k: 'mloop', e: upright, n: 2, st: 0.4});
    b.ok({k: 'mprim', sh: 'cylinder', p: [0.1, 0, 0.2], r: 0.04, n: 12, x: [1, 0, 0], g: 0.7});
    b.ok({k: 'mflip'});
    b.ok({k: 'mflip'});
    b.ok({k: 'msel', sm: 'none'});
    b.ok({k: 'mmirror'});
    b.ok({k: 'msel', sm: 'all', md: 'v'});
    b.ok({k: 'mmerge', sm: 'dist', r: 0.0005});
    b.select('f', [Array.from(b.doc.faces.keys())[3]]);
    b.ok({k: 'mdel'});
    b.ok({k: 'msel', sm: 'all', md: 'f', a: 'bob'});
    b.ok({k: 'msel', sm: 'linked', md: 'v', ids: [Array.from(b.doc.verts.keys())[0]]});
}

test('determinism: the same ops give the same bytes, also through a copy and a snapshot', () => {
    const first = new Bench();
    session(first);
    const bytes = Buffer.from(serializeDoc(first.doc));

    const again = new PolyDoc();
    first.ops.forEach((op) => assert.deepEqual(applyMeshOp(again, op), {ok: true}));
    assert.ok(bytes.equals(Buffer.from(serializeDoc(again))), 'a second document differs');

    let moved = new PolyDoc();
    first.ops.forEach((op, n) => {
        if (n % 5 === 2) {
            moved = moved.copy();
        }
        if (n % 5 === 4) {
            moved = parseDoc(serializeDoc(moved));
        }
        assert.deepEqual(applyMeshOp(moved, op), {ok: true});
    });
    assert.ok(bytes.equals(Buffer.from(serializeDoc(moved))), 'a copied and reloaded document differs');
});
