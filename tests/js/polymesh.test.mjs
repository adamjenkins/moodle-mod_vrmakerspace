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
 * Tests of the polygon mesh document and the basic shapes.
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_BAKE_GROUPS, MAX_COORD_MESH, MAX_DOC_BYTES, MAX_FACES, MAX_FACE_SIZE, MAX_MESH_RECORDS, MAX_VERTS, MeshHistory, PolyDoc,
    bakeGroups, bakeTriangles, edgeKey, elementId, exportMesh, mergeMeshes, newell, parseDoc, renderData, roundR5, serializeDoc, triangulateFace,
} from '../../js/engine/polymesh.js';
import {PRIM_SHAPES, addPrimitive, primitiveCounts, primitiveRefusal} from '../../js/engine/polyprims.js';
import {check} from '../../js/engine/validate.js';

/**
 * A document holding one shape.
 *
 * @param {string} shape The shape.
 * @param {number} [segments] Its segments.
 * @param {number} [size] Its size.
 * @returns {PolyDoc} The document.
 */
const docWith = (shape, segments, size = 0.1) => {
    const doc = new PolyDoc();
    addPrimitive(doc, shape, 'u1', 1, [0, 0, 0], size, null, 0, segments);
    return doc;
};

/**
 * The content of a document in a form that ignores Map order.
 *
 * @param {PolyDoc} doc The document.
 * @returns {string} Sorted vertices and faces.
 */
const content = (doc) => JSON.stringify({
    v: Array.from(doc.verts).sort((a, b) => a[0] - b[0]),
    f: Array.from(doc.faces).sort((a, b) => a[0] - b[0]),
});

/**
 * Whether every vertex a face names exists and no face repeats one.
 *
 * @param {PolyDoc} doc The document.
 * @returns {boolean} True when the topology rule holds.
 */
const consistent = (doc) => {
    for (const list of doc.faces.values()) {
        if (list.length < 3 || new Set(list).size !== list.length || !list.every((id) => doc.verts.has(id))) {
            return false;
        }
    }
    return true;
};

/**
 * Runs a stroke against a document, with a capture.
 *
 * @param {MeshHistory} history The history.
 * @param {PolyDoc} doc The document.
 * @param {string} author The author.
 * @param {number} id The stroke id.
 * @param {Function} edit Makes the changes.
 * @returns {void}
 */
const stroke = (history, doc, author, id, edit) => {
    doc.rec = history.stroke(author, id, doc);
    edit();
    doc.rec = null;
    history.end(author, id, doc);
};

/**
 * Twice the signed area of a triangle in the z = 0 plane.
 *
 * @param {number[][]} pts The polygon.
 * @param {number[]} t An index triple.
 * @returns {number} The area × 2.
 */
const area2 = (pts, t) => {
    const [a, b, c] = [pts[t[0]], pts[t[1]], pts[t[2]]];
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
};

/**
 * Twice the signed area of a polygon in the z = 0 plane.
 *
 * @param {number[][]} pts The polygon.
 * @returns {number} The area × 2.
 */
const polygonArea2 = (pts) => {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
        const q = pts[(i + 1) % pts.length];
        sum += pts[i][0] * q[1] - q[0] * pts[i][1];
    }
    return sum;
};

/**
 * Asserts that triangles use each boundary edge once, in direction, and each inner edge twice, opposed.
 *
 * @param {number[][]} tris The triples.
 * @param {number} n Polygon corners.
 * @returns {void}
 */
const assertTopology = (tris, n) => {
    assert.equal(tris.length, n - 2);
    const directed = new Set();
    for (const t of tris) {
        assert.equal(new Set(t).size, 3);
        for (let k = 0; k < 3; k++) {
            const key = `${t[k]}>${t[(k + 1) % 3]}`;
            assert.ok(!directed.has(key), 'edge ' + key + ' used twice in one direction');
            directed.add(key);
        }
    }
    for (let i = 0; i < n; i++) {
        assert.ok(directed.has(`${i}>${(i + 1) % n}`), 'boundary edge lost at ' + i);
    }
    for (const key of directed) {
        const [a, b] = key.split('>').map(Number);
        const boundary = (a + 1) % n === b;
        if (!boundary) {
            assert.ok(directed.has(`${b}>${a}`), 'inner edge unmatched ' + key);
        }
    }
};

/**
 * Asserts a good triangulation of a flat polygon: complete, all the same way round, covering its area.
 *
 * @param {number[][]} pts The polygon, counter-clockwise, in the z = 0 plane.
 * @returns {void}
 */
const assertFlatTriangulation = (pts) => {
    const tris = triangulateFace(pts);
    assertTopology(tris, pts.length);
    let total = 0;
    for (const t of tris) {
        const a = area2(pts, t);
        assert.ok(a > 0, 'triangle without positive area: ' + t.join(','));
        total += a;
    }
    assert.ok(Math.abs(total - polygonArea2(pts)) < 1e-9, 'triangles cover the polygon');
};

test('element ids are safe, stable and share nothing across ops', () => {
    assert.equal(elementId('a', 2, 3) - elementId('a', 2, 0), 3);
    assert.equal(elementId('a', 3, 0) - elementId('a', 2, 0), 4096);
    assert.ok(Number.isSafeInteger(elementId('zzzz', 2147483647, 4095)));
    assert.equal(elementId('start', 1, 0), elementId('start', 1, 0));
    assert.equal((elementId('b', 1, 0) - 4096) % 8796093022208, 0);
    assert.throws(() => elementId('a', 1, 4096), RangeError);
    assert.throws(() => elementId('a', -1, 0), RangeError);
});

test('edgeKey orders its ends and copes with large ids', () => {
    const big = elementId('a', 2147483647, 4095);
    assert.equal(edgeKey(9, 2), '2_9');
    assert.equal(edgeKey(2, 9), '2_9');
    assert.equal(edgeKey(big, 1), `1_${big}`);
    assert.ok(!edgeKey(big, 1).includes('e'));
});

test('coordinates are rounded and clamped, never −0', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0.123456789, -0.000001, 5]);
    assert.deepEqual(Array.from(doc.verts.get(1)), [0.12346, 0, MAX_COORD_MESH]);
    assert.ok(Object.is(doc.verts.get(1)[1], 0));
    doc.setVert(1, [-5, NaN, Infinity]);
    assert.deepEqual(Array.from(doc.verts.get(1)), [-MAX_COORD_MESH, 0, 0]);
    assert.ok(Object.is(roundR5(-0.000001), 0));
});

test('stored arrays cannot be changed in place, and a copy is independent', () => {
    const doc = new PolyDoc();
    addPrimitive(doc, 'cube', 'u1', 1, [0, 0, 0], 0.1);
    const [fid, list] = doc.faces.entries().next().value;
    const [vid, xyz] = doc.verts.entries().next().value;
    assert.throws(() => list.reverse(), TypeError);
    assert.throws(() => xyz.fill(0), TypeError);

    doc.sel.set('u1', {md: 'f', items: [fid]});
    doc.rec = new MeshHistory().stroke('u1', 1, doc);
    const copy = doc.copy();
    doc.rec = null;
    assert.equal(copy.rec, null);
    assert.deepEqual(serializeDoc(copy), serializeDoc(doc));

    copy.setVert(vid, [0.3, 0.3, 0.3]);
    copy.delFace(fid);
    copy.sel.get('u1').items.push(99);
    assert.deepEqual(Array.from(doc.verts.get(vid)), Array.from(xyz));
    assert.ok(doc.faces.has(fid));
    assert.deepEqual(doc.sel.get('u1').items, [fid]);

    const source = [1, 2, 3];
    doc.addFace(77, source);
    source[0] = 9;
    assert.deepEqual(Array.from(doc.faces.get(77)), [1, 2, 3]);
});

test('isEmpty looks at geometry only', () => {
    const doc = new PolyDoc();
    assert.ok(doc.isEmpty());
    doc.sel.set('u1', {md: 'v', items: [1]});
    assert.ok(doc.isEmpty());
    doc.addVert(1, [0, 0, 0]);
    assert.ok(!doc.isEmpty());
    doc.delVert(1);
    assert.ok(doc.isEmpty());
});

test('selectionOf drops what no longer exists; it is never null', () => {
    const doc = new PolyDoc();
    assert.deepEqual(doc.selectionOf('nobody'), {md: 'v', items: []});
    [1, 2, 3, 4].forEach((id) => doc.addVert(id, [id / 100, 0, 0]));
    doc.addFace(10, [1, 2, 3]);

    doc.sel.set('v', {md: 'v', items: [1, 99, 2, 1]});
    assert.deepEqual(doc.selectionOf('v'), {md: 'v', items: [1, 2]});

    doc.sel.set('f', {md: 'f', items: [10, 11]});
    assert.deepEqual(doc.selectionOf('f'), {md: 'f', items: [10]});

    doc.sel.set('e', {md: 'e', items: [1, 2, 3, 4, 2, 3, 3, 2, 7]});
    assert.deepEqual(doc.selectionOf('e'), {md: 'e', items: [1, 2, 2, 3]});
    assert.deepEqual(doc.sel.get('e').items, [1, 2, 3, 4, 2, 3, 3, 2, 7], 'what is stored stays');

    doc.delFace(10);
    assert.deepEqual(doc.selectionOf('f').items, []);
    assert.deepEqual(doc.selectionOf('e').items, []);
});

test('selectedVerts expands edges and faces, without repeats, in first-seen order', () => {
    const doc = new PolyDoc();
    [1, 2, 3, 4].forEach((id) => doc.addVert(id, [id / 100, id % 2 / 100, 0]));
    doc.addFace(10, [3, 2, 1]);
    doc.addFace(11, [3, 4, 2]);
    doc.sel.set('f', {md: 'f', items: [10, 11]});
    assert.deepEqual(doc.selectedVerts('f'), [3, 2, 1, 4]);
    doc.sel.set('e', {md: 'e', items: [2, 3, 1, 2]});
    assert.deepEqual(doc.selectedVerts('e'), [2, 3, 1]);
    doc.sel.set('v', {md: 'v', items: [4, 99]});
    assert.deepEqual(doc.selectedVerts('v'), [4]);
    assert.deepEqual(doc.selectedVerts('none'), []);
});

test('edgeFaces lists the faces of each edge', () => {
    const doc = docWith('cube');
    const edges = doc.edgeFaces();
    assert.equal(edges.size, 12);
    for (const users of edges.values()) {
        assert.equal(users.length, 2);
    }
    const plane = docWith('plane').edgeFaces();
    assert.equal(plane.size, 4);
    for (const users of plane.values()) {
        assert.equal(users.length, 1);
    }
});

test('every closed shape is watertight and wound outward at every segment count', () => {
    for (const shape of PRIM_SHAPES.filter((name) => name !== 'plane')) {
        for (const segments of [3, 4, 5, 7, 16, 47, 48]) {
            const report = check(exportMesh(docWith(shape, segments)));
            assert.ok(report.watertight, `${shape} ${segments} ${JSON.stringify(report)}`);
            assert.ok(report.volumemm3 > 0, `${shape} ${segments} wound inward`);
        }
    }
});

test('shape volumes are the expected ones', () => {
    /**
     * Asserts the volume of a shape.
     *
     * @param {string} shape The shape.
     * @param {number} expected The volume in mm³ of the smooth solid.
     * @param {number} share Allowed difference as a share.
     * @returns {void}
     */
    const near = (shape, expected, share) => {
        const volume = check(exportMesh(docWith(shape, 48))).volumemm3;
        assert.ok(Math.abs(volume - expected) < expected * share, `${shape}: ${volume} and ${expected}`);
    };
    const r = 100;
    near('cube', 8 * r * r * r, 1e-4);
    near('cylinder', 2 * Math.PI * r * r * r, 0.01);
    near('cone', 2 * Math.PI * r * r * r / 3, 0.01);
    near('sphere', 4 * Math.PI * r * r * r / 3, 0.03);
    near('torus', 2 * Math.PI * Math.PI * 70 * 30 * 30, 0.03);
});

test('each face of a convex shape looks away from its centre', () => {
    for (const shape of ['cube', 'cylinder', 'sphere', 'cone']) {
        const doc = docWith(shape, 12);
        for (const list of doc.faces.values()) {
            const points = list.map((id) => doc.verts.get(id));
            const n = newell(points);
            const mid = [0, 1, 2].map((a) => points.reduce((sum, p) => sum + p[a], 0) / points.length);
            assert.ok(n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] > 0, shape);
        }
    }
});

test('the plane is one upward quad with an open boundary', () => {
    const doc = docWith('plane');
    assert.equal(doc.faces.size, 1);
    assert.equal(doc.verts.size, 4);
    const list = Array.from(doc.faces.values())[0];
    assert.deepEqual(newell(list.map((id) => doc.verts.get(id))), [0, 1, 0]);
    const report = check(exportMesh(doc));
    assert.equal(report.boundaryedges, 4);
    assert.ok(!report.watertight);
});

test('shapes are quads where natural, with the counts promised', () => {
    assert.ok(Array.from(docWith('cube').faces.values()).every((list) => list.length === 4));
    assert.ok(Array.from(docWith('torus', 12).faces.values()).every((list) => list.length === 4));
    const cylinder = Array.from(docWith('cylinder', 12).faces.values());
    assert.equal(cylinder.filter((list) => list.length === 4).length, 12);
    assert.equal(cylinder.filter((list) => list.length === 12).length, 2);
    assert.deepEqual(primitiveCounts('sphere', 16), {verts: 2 + 16 * 7, faces: 16 * 8});
    assert.deepEqual(primitiveCounts('torus', 16), {verts: 16 * 8, faces: 16 * 8});
    assert.deepEqual(primitiveCounts('cone', 16), {verts: 17, faces: 17});
    assert.deepEqual(primitiveCounts('cube'), {verts: 8, faces: 6});
    assert.equal(primitiveCounts('teapot'), null);
    for (const shape of PRIM_SHAPES) {
        const counts = primitiveCounts(shape, 48);
        assert.ok(counts.verts + counts.faces <= 4096, shape + ' fits one op');
    }
    assert.equal(docWith('cylinder').faces.size, 18, 'default 16 segments');
    assert.equal(docWith('cylinder', 1000).faces.size, 50, 'at most 48');
    assert.equal(docWith('cylinder', 1).faces.size, 5, 'at least 3');
});

test('a shape goes where it is told, turned about its centre, and stays closed', () => {
    const doc = new PolyDoc();
    const ids = addPrimitive(doc, 'cone', 'u1', 5, [0.1, 0.05, -0.1], 0.05, [0, 0, 2], Math.PI / 2, 8);
    assert.equal(ids.length, 9);
    assert.deepEqual(Array.from(doc.verts.get(elementId('u1', 5, 8))), [0.05, 0.05, -0.1], 'the tip turned to −x');
    assert.deepEqual(ids[0], elementId('u1', 5, 9));
    assert.ok(check(exportMesh(doc)).watertight);
    assert.ok(check(exportMesh(doc)).volumemm3 > 0);

    const still = new PolyDoc();
    addPrimitive(still, 'cube', 'u1', 5, [0, 0, 0], 0.05, [0, 0, 0], 1);
    assert.deepEqual(Array.from(still.verts.get(elementId('u1', 5, 7))), [0.05, 0.05, 0.05], 'a zero axis does not turn');
});

test('two documents built the same way are byte-identical', () => {
    for (const shape of PRIM_SHAPES) {
        const a = new PolyDoc();
        const b = new PolyDoc();
        addPrimitive(a, shape, 'u1', 3, [0.01, 0.02, 0.03], 0.1, [1, 2, 3], 0.7, 11);
        addPrimitive(b, shape, 'u1', 3, [0.01, 0.02, 0.03], 0.1, [1, 2, 3], 0.7, 11);
        assert.deepEqual(serializeDoc(a), serializeDoc(b));
    }
});

test('a shape that cannot be added changes nothing and says why', () => {
    const doc = new PolyDoc();
    addPrimitive(doc, 'cube', 'u1', 1, [0, 0, 0], 0.1);
    const before = serializeDoc(doc);
    assert.equal(primitiveRefusal(doc, 'cube', 'u1', 1), 'conflict');
    assert.deepEqual(addPrimitive(doc, 'cube', 'u1', 1, [0, 0, 0], 0.1), []);
    assert.equal(primitiveRefusal(doc, 'teapot', 'u1', 2), 'empty');
    assert.deepEqual(addPrimitive(doc, 'teapot', 'u1', 2, [0, 0, 0], 0.1), []);
    assert.deepEqual(serializeDoc(doc), before);

    const full = new PolyDoc();
    for (let id = 0; id < MAX_VERTS - 7; id++) {
        full.addVert(id, [0, 0, 0]);
    }
    assert.equal(primitiveRefusal(full, 'cube', 'u1', 1), 'limit');
    assert.deepEqual(addPrimitive(full, 'cube', 'u1', 1, [0, 0, 0], 0.1), []);
    assert.equal(full.verts.size, MAX_VERTS - 7);
    full.delVert(0);
    assert.equal(primitiveRefusal(full, 'cube', 'u1', 1), null);
});

test('newell gives a unit normal, or zero for no area', () => {
    const square = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    assert.deepEqual(newell(square), [0, 0, 1]);
    assert.deepEqual(newell(square.slice().reverse()), [0, 0, -1]);
    assert.deepEqual(newell([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), [0, 0, 0]);
    assert.deepEqual(newell([[1, 1, 1], [1, 1, 1], [1, 1, 1]]), [0, 0, 0]);
});

test('triangulateFace handles simple and convex polygons', () => {
    assert.deepEqual(triangulateFace([[0, 0, 0], [1, 0, 0]]), []);
    assert.deepEqual(triangulateFace([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), [[0, 1, 2]]);
    assert.deepEqual(triangulateFace([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), [[0, 1, 2], [0, 2, 3]]);
    const circle = [];
    for (let i = 0; i < 48; i++) {
        circle.push([Math.cos(i * Math.PI / 24), Math.sin(i * Math.PI / 24), 0]);
    }
    assertFlatTriangulation(circle);
});

test('triangulateFace handles concave polygons', () => {
    // A concave quad with its reflex corner at each place in the list in turn.
    const dart = [[0, 0, 0], [2, 1, 0], [0, 2, 0], [0.5, 1, 0]];
    for (let turn = 0; turn < 4; turn++) {
        assertFlatTriangulation(dart.slice(turn).concat(dart.slice(0, turn)));
    }
    // An L, a U and a comb.
    assertFlatTriangulation([[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]]);
    assertFlatTriangulation([[0, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0], [2, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]]);
    const comb = [[0, 0, 0], [8, 0, 0]];
    for (let x = 8; x > 0; x--) {
        comb.push([x, 3, 0], [x - 0.5, 1, 0]);
    }
    comb.push([0, 3, 0]);
    assertFlatTriangulation(comb);
    // A five-pointed star.
    const star = [];
    for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.4 : 1;
        star.push([r * Math.cos(i * Math.PI / 5), r * Math.sin(i * Math.PI / 5), 0]);
    }
    assertFlatTriangulation(star);
});

test('triangulateFace keeps corners that lie along an edge, without zero-area triangles', () => {
    assertFlatTriangulation([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
    assertFlatTriangulation([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0], [0, 2, 0], [0, 1, 0]]);
    assertFlatTriangulation([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1.5, 0, 0], [2, 0, 0], [1, 1, 0]]);
});

test('triangulateFace works in the plane of the face, whichever way it faces', () => {
    /**
     * Turns the L-shape into a tilted plane.
     *
     * @param {number[]} p A point in z = 0.
     * @returns {number[]} The point in the plane through the origin with normal (1, 1, 1) direction.
     */
    const tilt = (p) => [p[0], p[1], -p[0] - p[1]];
    const shape = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
    const up = triangulateFace(shape.map(tilt));
    assertTopology(up, 6);
    const flat = up.reduce((sum, t) => sum + area2(shape, t), 0);
    assert.ok(Math.abs(flat - polygonArea2(shape)) < 1e-9);
    assert.ok(up.every((t) => area2(shape, t) > 0));

    // Facing the other way: the same corners reversed, seen from the back, still all one way round.
    const down = shape.slice().reverse();
    const tris = triangulateFace(down.map(tilt));
    assertTopology(tris, 6);
    assert.ok(tris.every((t) => area2(down, t) < 0));
});

test('triangulateFace falls back without losing an edge on degenerate polygons', () => {
    // No area at all.
    assertTopology(triangulateFace([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]), 4);
    assertTopology(triangulateFace([[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]]), 5);
    // A bow tie, a corner repeated by position and a spike.
    assertTopology(triangulateFace([[0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0]]), 4);
    assertTopology(triangulateFace([[0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), 5);
    assertTopology(triangulateFace([[0, 0, 0], [2, 0, 0], [2, 2, 0], [2, 4, 0], [2, 2, 0], [0, 2, 0]]), 6);
    // A self-crossing star: all five points on a circle taken two apart.
    const pentagram = [];
    for (let i = 0; i < 5; i++) {
        pentagram.push([Math.cos(i * 4 * Math.PI / 5), Math.sin(i * 4 * Math.PI / 5), 0]);
    }
    assertTopology(triangulateFace(pentagram), 5);
});

test('triangulateFace is deterministic', () => {
    const shape = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
    assert.deepEqual(triangulateFace(shape), triangulateFace(shape.map((p) => p.slice())));
});

test('a concave n-gon in a closed solid stays watertight in the export', () => {
    const doc = new PolyDoc();
    const outline = [[0, 0], [0.2, 0], [0.2, 0.1], [0.1, 0.1], [0.1, 0.2], [0, 0.2]];
    outline.forEach((p, i) => {
        doc.addVert(100 + i, [p[0], p[1], 0]);
        doc.addVert(200 + i, [p[0], p[1], 0.1]);
    });
    doc.addFace(1, outline.map((p, i) => 100 + 5 - i));
    doc.addFace(2, outline.map((p, i) => 200 + i));
    outline.forEach((p, i) => {
        const j = (i + 1) % outline.length;
        doc.addFace(10 + i, [100 + i, 100 + j, 200 + j, 200 + i]);
    });
    const report = check(exportMesh(doc));
    assert.ok(report.watertight, JSON.stringify(report));
    assert.ok(Math.abs(report.volumemm3 - 3000000) < 10, String(report.volumemm3));
});

test('renderData describes the document', () => {
    const doc = docWith('cube');
    const faceId = Array.from(doc.faces.keys())[0];
    doc.sel.set('u1', {md: 'f', items: [faceId, 12345]});
    const data = renderData(doc);
    assert.deepEqual(Array.from(data.vertIds), Array.from(doc.verts.keys()));
    assert.equal(data.vertPos.length, 24);
    assert.ok(data.vertPos instanceof Float32Array);
    assert.deepEqual(Array.from(data.faceIds), Array.from(doc.faces.keys()));
    assert.deepEqual(Array.from(data.faceStart), [0, 4, 8, 12, 16, 20, 24]);
    assert.equal(data.faceVerts.length, 24);
    assert.equal(data.triPos.length, 12 * 9);
    assert.equal(data.triNormal.length, 12 * 9);
    assert.equal(data.triFace.length, 12);
    assert.equal(data.edges.length, 24);
    assert.equal(data.openEdges.length, 0);
    assert.deepEqual(data.sels, [{a: 'u1', md: 'f', items: [faceId]}]);

    const list = Array.from(doc.faces.values())[0];
    assert.equal(data.vertIds[data.faceVerts[0]], list[0]);
    assert.deepEqual(Array.from(data.triFace.slice(0, 2)), [0, 0]);
    assert.deepEqual(Array.from(data.triNormal.slice(0, 3)), [1, 0, 0], 'the first cube face looks along +x');
    assert.deepEqual(Array.from(data.triNormal.slice(9, 12)), [1, 0, 0], 'all its corners flat');

    for (let e = 0; e < data.edges.length; e += 2) {
        assert.ok(data.edges[e] < data.edges[e + 1]);
    }
});

test('renderData reports open edges and copes with empty documents', () => {
    const plane = renderData(docWith('plane'));
    assert.equal(plane.openEdges.length, 8);
    assert.equal(plane.edges.length, 8);

    const fin = docWith('plane');
    const list = Array.from(fin.faces.values())[0];
    fin.addVert(5, [0, 0.1, 0]);
    fin.addVert(6, [0, -0.1, 0]);
    fin.addFace(50, [list[1], list[0], 5]);
    fin.addFace(51, [list[0], list[1], 6]);
    const shared = renderData(fin);
    assert.equal(shared.edges.length, 2 * (4 + 4));
    assert.equal(shared.openEdges.length, 2 * (4 + 4), 'an edge of three faces is open, as are the ends');

    const empty = renderData(new PolyDoc());
    assert.equal(empty.vertIds.length, 0);
    assert.deepEqual(Array.from(empty.faceStart), [0]);
    assert.equal(empty.triPos.length, 0);
    assert.deepEqual(empty.sels, []);
});

test('renderData gives a face without area a usable normal', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0, 0, 0]);
    doc.addVert(2, [0.1, 0, 0]);
    doc.addVert(3, [0.2, 0, 0]);
    doc.addFace(9, [1, 2, 3]);
    assert.deepEqual(Array.from(renderData(doc).triNormal.slice(0, 3)), [0, 1, 0]);
});

test('exportMesh welds per vertex, leaves out unused vertices and points normals out', () => {
    const doc = docWith('cube');
    doc.addVert(4242, [0.3, 0.3, 0.3]);
    const mesh = exportMesh(doc);
    assert.equal(mesh.positions.length, 24);
    assert.equal(mesh.normals.length, 24);
    assert.equal(mesh.indices.length, 36);
    assert.ok(mesh.indices instanceof Uint32Array);
    assert.ok(check(mesh).watertight);
    for (let v = 0; v < 8; v++) {
        const out = mesh.positions[v * 3] * mesh.normals[v * 3] + mesh.positions[v * 3 + 1] * mesh.normals[v * 3 + 1]
            + mesh.positions[v * 3 + 2] * mesh.normals[v * 3 + 2];
        assert.ok(out > 0);
    }
    const empty = exportMesh(new PolyDoc());
    assert.equal(empty.positions.length, 0);
    assert.equal(empty.indices.length, 0);
});

test('bakeTriangles lists the corners of every triangle', () => {
    const tris = bakeTriangles(docWith('cube'));
    assert.ok(tris instanceof Float64Array);
    assert.equal(tris.length, 12 * 9);
    assert.ok(tris.every((v) => Math.abs(v) === 0.1));
    assert.equal(bakeTriangles(new PolyDoc()).length, 0);
});

test('bakeGroups keeps overlapping islands apart and separate ones together', () => {
    assert.deepEqual(bakeGroups(new PolyDoc()), []);
    assert.deepEqual(bakeGroups(docWith('cube')).map((tris) => tris.length), [12 * 9]);

    const doc = new PolyDoc();
    addPrimitive(doc, 'cube', 'u1', 1, [-0.02, 0, 0], 0.05);
    addPrimitive(doc, 'cube', 'u1', 2, [0.02, 0, 0], 0.05);
    addPrimitive(doc, 'cube', 'u1', 3, [0.3, 0, 0], 0.02);
    const groups = bakeGroups(doc);
    assert.deepEqual(groups.map((tris) => tris.length), [24 * 9, 12 * 9], 'the far cube joins the first group');
    assert.ok(groups.every((tris) => tris instanceof Float64Array));
    const sorted = (list) => Array.from(list).sort((a, b) => a - b);
    assert.deepEqual(sorted([...groups[0], ...groups[1]]), sorted(bakeTriangles(doc)), 'every corner is there');

    const pile = new PolyDoc();
    for (let n = 1; n <= MAX_BAKE_GROUPS + 4; n++) {
        addPrimitive(pile, 'cube', 'u1', n, [0, 0, 0], 0.05);
    }
    const capped = bakeGroups(pile);
    assert.equal(capped.length, MAX_BAKE_GROUPS);
    assert.equal(capped.reduce((sum, tris) => sum + tris.length, 0), bakeTriangles(pile).length);
});

test('mergeMeshes joins meshes and tolerates a missing one', () => {
    const a = exportMesh(docWith('cube'));
    const b = exportMesh(docWith('cone', 8));
    const merged = mergeMeshes(a, b);
    assert.equal(merged.positions.length, a.positions.length + b.positions.length);
    assert.equal(merged.normals.length, merged.positions.length);
    assert.equal(merged.indices.length, a.indices.length + b.indices.length);
    assert.equal(merged.indices[a.indices.length], b.indices[0] + 8);
    assert.deepEqual(Array.from(merged.normals.slice(24, 27)), Array.from(b.normals.slice(0, 3)));
    const report = check(merged);
    assert.ok(report.watertight);
    assert.equal(report.triangles, check(a).triangles + check(b).triangles);

    assert.deepEqual(Array.from(mergeMeshes(null, b).indices), Array.from(b.indices));
    assert.deepEqual(Array.from(mergeMeshes(a, null).positions), Array.from(a.positions));
    assert.equal(mergeMeshes(null, null).positions.length, 0);
    const emptyClay = {positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0)};
    assert.deepEqual(Array.from(mergeMeshes(emptyClay, b).indices), Array.from(b.indices));
    assert.equal(merged.positions.buffer === a.positions.buffer, false);
});

test('a document survives serializing byte for byte, in order, stale selections included', () => {
    const doc = docWith('torus', 9);
    addPrimitive(doc, 'sphere', 'u2', 7, [0.1, -0.1, 0.05], 0.05, [1, 1, 0], 0.5, 8);
    const ids = Array.from(doc.faces.keys());
    const verts = Array.from(doc.verts.keys());
    doc.delFace(ids[3]);
    doc.setVert(verts[2], [0.11111, -0.22222, 0.33333]);
    doc.sel.set('u1', {md: 'f', items: [ids[0], ids[3], 999]});
    doc.sel.set('u2', {md: 'e', items: [verts[0], verts[1], 5, 6]});
    doc.sel.set('z-_9', {md: 'v', items: []});
    doc.delVert(verts[verts.length - 1]);
    doc.addVert(verts[verts.length - 1], [0, 0, 0.4]);

    const bytes = serializeDoc(doc);
    const back = parseDoc(bytes);
    assert.deepEqual(serializeDoc(back), bytes);
    assert.deepEqual(Array.from(back.verts.keys()), Array.from(doc.verts.keys()));
    assert.deepEqual(Array.from(back.faces.keys()), Array.from(doc.faces.keys()));
    assert.deepEqual(back.selectionOf('u1'), doc.selectionOf('u1'));
    assert.deepEqual(back.sel.get('u1').items, [ids[0], ids[3], 999]);
    assert.equal(back.rec, null);

    assert.deepEqual(serializeDoc(parseDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))), bytes);
    assert.equal(new TextDecoder().decode(serializeDoc(new PolyDoc())), '{"v":[],"f":[],"s":[]}');
    assert.ok(parseDoc(serializeDoc(new PolyDoc())).isEmpty());
});

test('the serialized form is the one in the contract', () => {
    const doc = new PolyDoc();
    doc.addVert(4, [0.1, -0.2, 0]);
    doc.addVert(5, [0, 0, 0]);
    doc.addVert(6, [0, 0, 0.3]);
    doc.addFace(9, [4, 5, 6]);
    doc.sel.set('u1', {md: 'f', items: [9]});
    assert.equal(new TextDecoder().decode(serializeDoc(doc)),
        '{"v":[[4,0.1,-0.2,0],[5,0,0,0],[6,0,0,0.3]],"f":[[9,[4,5,6]]],"s":[["u1","f",[9]]]}');
});

test('parseDoc refuses anything malformed', () => {
    /**
     * Asserts that some text is refused.
     *
     * @param {string} text The JSON.
     * @param {string} name What is wrong with it.
     * @returns {void}
     */
    const refused = (text, name) => {
        assert.throws(() => parseDoc(new TextEncoder().encode(text)), /^Error: snapshotinvalid/, name);
    };
    const verts = '[1,0,0,0],[2,0.1,0,0],[3,0,0.1,0]';
    refused('', 'empty');
    refused('nonsense', 'not JSON');
    refused('[]', 'an array');
    refused('null', 'null');
    refused('{"v":[],"f":[]}', 'a key missing');
    refused('{"v":[],"f":[],"s":[],"x":1}', 'an extra key');
    refused('{"v":{},"f":[],"s":[]}', 'an object for an array');
    refused('{"v":[[1,0,0]],"f":[],"s":[]}', 'a short vertex');
    refused('{"v":[[1,0,0,0],[1,0,0,0]],"f":[],"s":[]}', 'a repeated vertex id');
    refused('{"v":[[-1,0,0,0]],"f":[],"s":[]}', 'a negative id');
    refused('{"v":[[1.5,0,0,0]],"f":[],"s":[]}', 'a fractional id');
    refused('{"v":[[9007199254740992,0,0,0]],"f":[],"s":[]}', 'an unsafe id');
    refused('{"v":[["1",0,0,0]],"f":[],"s":[]}', 'a string id');
    refused('{"v":[[1,0.5,0,0]],"f":[],"s":[]}', 'a coordinate out of range');
    refused('{"v":[[1,1e999,0,0]],"f":[],"s":[]}', 'an infinite coordinate');
    refused('{"v":[[1,null,0,0]],"f":[],"s":[]}', 'a null coordinate');
    refused('{"v":[[1,0.123456,0,0]],"f":[],"s":[]}', 'an unrounded coordinate');
    refused(`{"v":[${verts}],"f":[[9,[1,2]]],"s":[]}`, 'a face too small');
    refused(`{"v":[${verts}],"f":[[9,[1,2,2]]],"s":[]}`, 'a repeated vertex in a face');
    refused(`{"v":[${verts}],"f":[[9,[1,2,4]]],"s":[]}`, 'a face naming no vertex');
    refused(`{"v":[${verts}],"f":[[9,[1,2,"3"]]],"s":[]}`, 'a string in a face');
    refused(`{"v":[${verts}],"f":[[9,[1,2,3]],[9,[1,2,3]]],"s":[]}`, 'a repeated face id');
    refused(`{"v":[${verts}],"f":[[9,[1,2,3],0]],"s":[]}`, 'a long face row');
    refused('{"v":[],"f":[],"s":[["u1","x",[]]]}', 'an unknown mode');
    refused('{"v":[],"f":[],"s":[["u 1","v",[]]]}', 'a bad author');
    refused('{"v":[],"f":[],"s":[["u1","v",[]],["u1","v",[]]]}', 'a repeated author');
    refused('{"v":[],"f":[],"s":[["u1","e",[1,2,3]]]}', 'half an edge');
    refused('{"v":[],"f":[],"s":[["u1","v",[1.5]]]}', 'a fractional item');
    refused('{"v":[],"f":[],"s":[["u1","v"]]}', 'a short selection');

    const large = [];
    for (let i = 0; i < MAX_FACE_SIZE + 1; i++) {
        large.push(`[${i},0,0,0]`);
    }
    const ids = Array.from({length: MAX_FACE_SIZE + 1}, (unused, i) => i);
    refused(`{"v":[${large.join(',')}],"f":[[99,[${ids.join(',')}]]],"s":[]}`, 'a face too large');
    const manyVerts = Array.from({length: MAX_VERTS + 1}, (unused, i) => `[${i},0,0,0]`).join(',');
    refused(`{"v":[${manyVerts}],"f":[],"s":[]}`, 'too many vertices');
    const manyFaces = Array.from({length: MAX_FACES + 1}, (unused, i) => `[${i},[1,2,3]]`).join(',');
    refused(`{"v":[${verts}],"f":[${manyFaces}],"s":[]}`, 'too many faces');

    assert.throws(() => parseDoc('text'), /^Error: snapshotinvalid/, 'not binary');
    assert.throws(() => parseDoc(null), /^Error: snapshotinvalid/, 'nothing');
    assert.throws(() => parseDoc(new Uint8Array([0x7b, 0xff, 0x7d])), /^Error: snapshotinvalid/, 'bad UTF-8');
    assert.throws(() => parseDoc(new Uint8Array(MAX_DOC_BYTES + 1)), /^Error: snapshotinvalid/, 'too many bytes');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"v":[],"f":[],"s":[]}')]);
    assert.throws(() => parseDoc(bom), /^Error: snapshotinvalid/, 'a byte order mark');
});

test('parseDoc gives frozen arrays like any other document', () => {
    const back = parseDoc(new TextEncoder().encode('{"v":[[1,0,0,0],[2,0.1,0,0],[3,0,0.1,0]],"f":[[9,[1,2,3]]],"s":[]}'));
    assert.throws(() => back.faces.get(9).reverse(), TypeError);
    assert.throws(() => back.verts.get(1).fill(1), TypeError);
});

test('undo and redo restore exactly what a stroke changed', () => {
    const doc = docWith('cube');
    const history = new MeshHistory();
    const verts = Array.from(doc.verts.keys());
    const faces = Array.from(doc.faces.keys());
    const start = content(doc);
    stroke(history, doc, 'u1', 1, () => {
        doc.setVert(verts[0], [0.11111, 0.22222, 0.33333]);
        doc.setVert(verts[0], [0.12345, 0.23456, 0.34567]);
        // The second cube face does not use corner 7; the first, third and fifth do.
        doc.setFace(faces[1], Array.from(doc.faces.get(faces[1])).reverse());
        [faces[0], faces[2], faces[4]].forEach((id) => doc.delFace(id));
        doc.delVert(verts[7]);
        doc.addVert(5000, [0.01, 0.02, 0.03]);
        doc.addFace(6000, [verts[1], verts[2], 5000]);
    });
    const after = content(doc);
    assert.notEqual(after, start);
    assert.ok(history.has('u1', 1));
    assert.ok(!history.has('u2', 1));
    assert.ok(!history.has('u1', 2));

    assert.equal(history.undo('u1', 1, doc), true);
    assert.equal(content(doc), start);
    assert.equal(history.undo('u1', 1, doc), false, 'not twice');
    assert.equal(content(doc), start);
    assert.equal(history.redo('u1', 1, doc), true);
    assert.equal(content(doc), after);
    assert.equal(history.redo('u1', 1, doc), false, 'not twice');
    assert.equal(history.undo('u1', 1, doc), true);
    assert.equal(content(doc), start);
    assert.ok(consistent(doc));
    assert.equal(doc.rec, null);
});

test('undo restores a primitive, and a bake that took everything', () => {
    const doc = new PolyDoc();
    const history = new MeshHistory();
    stroke(history, doc, 'u1', 1, () => addPrimitive(doc, 'sphere', 'u1', 1, [0, 0, 0], 0.1));
    const full = content(doc);
    history.undo('u1', 1, doc);
    assert.ok(doc.isEmpty());
    history.redo('u1', 1, doc);
    assert.equal(content(doc), full);

    stroke(history, doc, 'u1', 2, () => {
        Array.from(doc.faces.keys()).forEach((id) => doc.delFace(id));
        Array.from(doc.verts.keys()).forEach((id) => doc.delVert(id));
    });
    assert.ok(doc.isEmpty());
    history.undo('u1', 2, doc);
    assert.equal(content(doc), full);
    assert.ok(check(exportMesh(doc)).watertight);
});

test('undo keeps what others have done to the moved vertices', () => {
    const doc = new PolyDoc();
    const history = new MeshHistory();
    doc.addVert(1, [0.1, 0.1, 0.1]);
    stroke(history, doc, 'a', 1, () => doc.setVert(1, [0.15, 0.1, 0.1]));
    stroke(history, doc, 'b', 1, () => doc.setVert(1, [0.15, 0.2, 0.1]));
    history.undo('a', 1, doc);
    assert.deepEqual(Array.from(doc.verts.get(1)), [0.1, 0.2, 0.1], 'b keeps its move');
    history.redo('a', 1, doc);
    assert.deepEqual(Array.from(doc.verts.get(1)), [0.15, 0.2, 0.1]);
    history.undo('b', 1, doc);
    assert.deepEqual(Array.from(doc.verts.get(1)), [0.15, 0.1, 0.1]);

    doc.setVert(1, [0.39, 0, 0]);
    stroke(history, doc, 'c', 1, () => doc.setVert(1, [0.1, 0, 0]));
    doc.setVert(1, [0.3, 0, 0]);
    history.undo('c', 1, doc);
    assert.deepEqual(Array.from(doc.verts.get(1)), [MAX_COORD_MESH, 0, 0], 'clamped, not out of range');
});

test('undo skips a moved vertex someone has deleted, and a face whose vertices are gone', () => {
    const doc = docWith('plane');
    const history = new MeshHistory();
    const [v0, v1, v2, v3] = Array.from(doc.verts.keys());
    const face = Array.from(doc.faces.keys())[0];

    stroke(history, doc, 'a', 1, () => {
        doc.setVert(v0, [0.2, 0.2, 0.2]);
        doc.setFace(face, [v0, v1, v2]);
    });
    stroke(history, doc, 'b', 1, () => {
        doc.delFace(face);
        doc.delVert(v3);
        doc.delVert(v0);
    });
    assert.equal(history.undo('a', 1, doc), true);
    assert.ok(!doc.verts.has(v0), 'the moved vertex stays gone');
    assert.ok(!doc.faces.has(face), 'its face cannot come back: v3 and v0 are gone');
    assert.ok(consistent(doc));
});

test('undo keeps a vertex the stroke made when someone else uses it', () => {
    const doc = docWith('plane');
    const history = new MeshHistory();
    const verts = Array.from(doc.verts.keys());
    stroke(history, doc, 'a', 1, () => {
        doc.addVert(100, [0, 0.1, 0]);
        doc.addVert(101, [0.1, 0.1, 0]);
        doc.addFace(200, [verts[0], verts[1], 100]);
    });
    stroke(history, doc, 'b', 1, () => doc.addFace(300, [verts[2], verts[3], 100]));

    history.undo('a', 1, doc);
    assert.ok(!doc.faces.has(200));
    assert.ok(doc.verts.has(100), 'b uses it');
    assert.ok(!doc.verts.has(101), 'nothing uses it');
    assert.ok(doc.faces.has(300));
    assert.ok(consistent(doc));

    history.redo('a', 1, doc);
    assert.ok(doc.faces.has(200));
    assert.ok(doc.verts.has(101));
    assert.ok(consistent(doc));
});

test('undo does not bring back a deleted vertex over an id that exists, nor past the limits', () => {
    const doc = new PolyDoc();
    const history = new MeshHistory();
    doc.addVert(1, [0.1, 0, 0]);
    stroke(history, doc, 'a', 1, () => doc.delVert(1));
    doc.addVert(1, [0.2, 0, 0]);
    history.undo('a', 1, doc);
    assert.deepEqual(Array.from(doc.verts.get(1)), [0.2, 0, 0]);

    const full = docWith('plane');
    const fullHistory = new MeshHistory();
    const face = Array.from(full.faces.keys())[0];
    const list = Array.from(full.faces.values())[0];
    stroke(fullHistory, full, 'a', 1, () => {
        full.delFace(face);
        list.forEach((id) => full.delVert(id));
    });
    for (let id = 0; id < MAX_VERTS - 2; id++) {
        full.addVert(id, [0, 0, 0]);
    }
    fullHistory.undo('a', 1, full);
    assert.equal(full.verts.size, MAX_VERTS);
    assert.ok(!full.faces.has(face), 'not all its vertices came back');
    assert.ok(consistent(full));
    parseDoc(serializeDoc(full));
});

test('a stroke that changed nothing leaves no record, and later undo is harmless', () => {
    const doc = docWith('plane');
    const history = new MeshHistory();
    const verts = Array.from(doc.verts.keys());
    const xyz = Array.from(doc.verts.get(verts[0]));
    stroke(history, doc, 'a', 1, () => {
        doc.setVert(verts[0], [0, 0, 0]);
        doc.setVert(verts[0], xyz);
        doc.addVert(100, [0, 0, 0]);
        doc.delVert(100);
    });
    assert.ok(!history.has('a', 1));
    assert.equal(history.undo('a', 1, doc), false);
    assert.equal(history.undo('a', 99, doc), false);
    assert.equal(history.redo('a', 99, doc), false);
});

test('strokes open and close as those of history.js do', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0, 0, 0]);
    const history = new MeshHistory();

    const first = history.stroke('a', 5, doc);
    assert.equal(history.stroke('a', 5, doc), first);
    assert.equal(history.stroke('a', 4, doc), null, 'older than the open one');
    doc.rec = first;
    doc.setVert(1, [0.1, 0, 0]);
    doc.rec = null;
    assert.ok(history.has('a', 5), 'an open stroke is known');

    const second = history.stroke('a', 6, doc);
    assert.notEqual(second, first);
    assert.ok(history.find('a', 5), 'opening a newer one ended the older');
    assert.equal(history.stroke('a', 5, doc), null, 'ended');
    assert.equal(history.end('a', 5, doc), null);
    assert.equal(history.end('a', 6, doc), null, 'changed nothing');

    // The first touch counts, and a Capture listens only while it is rec.
    const third = history.stroke('a', 7, doc);
    doc.rec = third;
    doc.setVert(1, [0.2, 0, 0]);
    doc.setVert(1, [0.3, 0, 0]);
    doc.rec = null;
    doc.addVert(2, [0, 0, 0]);
    history.end('a', 7, doc);
    assert.deepEqual(Array.from(history.find('a', 7).verts.get(1).before), [0.1, 0, 0]);
    assert.deepEqual(Array.from(history.find('a', 7).verts.get(1).after), [0.3, 0, 0]);
    assert.ok(!history.find('a', 7).verts.has(2));
    assert.equal(history.find('a', 7).undone, false);

    history.clear();
    assert.ok(!history.has('a', 7));
    assert.notEqual(history.stroke('a', 1, doc), null);
});

test('undoing a stroke still open ends it first', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0, 0, 0]);
    const history = new MeshHistory();
    doc.rec = history.stroke('a', 1, doc);
    doc.setVert(1, [0.1, 0, 0]);
    doc.rec = null;
    assert.equal(history.undo('a', 1, doc), true);
    assert.deepEqual(Array.from(doc.verts.get(1)), [0, 0, 0]);
    assert.equal(history.stroke('a', 1, doc), null);
});

test('an undo while another stroke is being applied is not captured by it', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0, 0, 0]);
    doc.addVert(2, [0, 0, 0]);
    const history = new MeshHistory();
    stroke(history, doc, 'a', 1, () => doc.setVert(1, [0.1, 0, 0]));
    const capture = history.stroke('b', 1, doc);
    doc.rec = capture;
    doc.setVert(2, [0.2, 0, 0]);
    history.undo('a', 1, doc);
    assert.equal(doc.rec, capture);
    doc.rec = null;
    assert.ok(!capture.verts.has(1));
});

test('only the last strokes of an author are kept', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0, 0, 0]);
    const history = new MeshHistory();
    for (let s = 1; s <= MAX_MESH_RECORDS + 5; s++) {
        stroke(history, doc, 'a', s, () => doc.setVert(1, [s / 1000, 0, 0]));
    }
    assert.ok(!history.has('a', 5));
    assert.equal(history.undo('a', 5, doc), false);
    assert.ok(history.has('a', 6));
    assert.equal(history.undo('a', MAX_MESH_RECORDS + 5, doc), true);
    stroke(history, doc, 'b', 1, () => doc.setVert(1, [0, 0, 0]));
    assert.ok(history.has('b', 1), 'each author has their own');
});

test('two clients applying the same sequence agree, foreign edits and undo included', () => {
    /**
     * Runs the same mixed sequence.
     *
     * @returns {Uint8Array} The final serialized document.
     */
    const run = () => {
        const doc = new PolyDoc();
        const history = new MeshHistory();
        stroke(history, doc, 'a', 1, () => addPrimitive(doc, 'cylinder', 'a', 1, [0, 0, 0], 0.1, null, 0, 6));
        const verts = Array.from(doc.verts.keys());
        stroke(history, doc, 'b', 1, () => addPrimitive(doc, 'cone', 'b', 1, [0.2, 0, 0], 0.05, [1, 0, 0], 0.3, 5));
        stroke(history, doc, 'a', 2, () => doc.setVert(verts[0], [0.05, 0.05, 0.05]));
        stroke(history, doc, 'b', 2, () => {
            Array.from(doc.faces).filter((row) => row[1].includes(verts[0])).forEach((row) => doc.delFace(row[0]));
            doc.delVert(verts[0]);
        });
        history.undo('a', 1, doc);
        history.undo('b', 2, doc);
        history.redo('a', 1, doc);
        history.undo('a', 2, doc);
        assert.ok(consistent(doc));
        return serializeDoc(doc);
    };
    assert.deepEqual(run(), run());
});
