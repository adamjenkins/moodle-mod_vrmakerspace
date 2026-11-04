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
 * Tests of the two studio modules that need no browser: picking (mod_vrmakerspace/polypick) and the mesh tools
 * (mod_vrmakerspace/modeltools), the latter against the real mesh document and operators.
 *
 * Run from the repository root: node --test tests/js/polypick.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pickNear, pickRay} from '../../amd/src/polypick.js';
import {createModelTools} from '../../amd/src/modeltools.js';
import {PolyDoc, renderData} from '../../js/engine/polymesh.js';
import {addPrimitive} from '../../js/engine/polyprims.js';
import {applyMeshOp, cleanMeshOp} from '../../js/engine/polyops.js';

/**
 * A document holding one cube of half-extent 0.08 at the origin.
 *
 * @returns {PolyDoc}
 */
const cubeDoc = () => {
    const doc = new PolyDoc();
    addPrimitive(doc, 'cube', 'start', 1, [0, 0, 0], 0.08);
    return doc;
};

/**
 * The id of the vertex closest to a point.
 *
 * @param {PolyDoc} doc The document.
 * @param {number[]} p The point.
 * @returns {number}
 */
const vertexAt = (doc, p) => {
    let best = null;
    let bestdist = Infinity;
    for (const [id, q] of doc.verts) {
        const dist = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        if (dist < bestdist) {
            bestdist = dist;
            best = id;
        }
    }
    return best;
};

/**
 * Asserts that two numbers are close.
 *
 * @param {number} actual The value.
 * @param {number} expected What it should be.
 * @param {number} [eps] How close.
 */
const near = (actual, expected, eps = 1e-4) => {
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} should be within ${eps} of ${expected}`);
};

test('pickRay in face mode gives the nearest face, the point and its normal', () => {
    const doc = cubeDoc();
    const hit = pickRay([0.01, 0.02, 1], [0, 0, -1], renderData(doc), 'f', 0.01);
    assert.equal(hit.kind, 'f');
    assert.ok(doc.faces.has(hit.id));
    near(hit.point[0], 0.01);
    near(hit.point[1], 0.02);
    near(hit.point[2], 0.08);
    near(hit.normal[0], 0);
    near(hit.normal[1], 0);
    near(hit.normal[2], 1);
    assert.ok(doc.faces.get(hit.id).every((v) => Math.abs(doc.verts.get(v)[2] - 0.08) < 1e-6));
    assert.equal(pickRay([0.2, 0, 1], [0, 0, -1], renderData(doc), 'f', 0.01), null);
});

test('pickRay takes vectors as objects, any length of direction, and refuses what is not a ray', () => {
    const data = renderData(cubeDoc());
    const hit = pickRay({x: 0, y: 0, z: 1}, {x: 0, y: 0, z: -5}, data, 'f', 0.01);
    assert.equal(hit.kind, 'f');
    near(hit.point[2], 0.08);
    assert.equal(pickRay([0, 0, 1], [0, 0, 0], data, 'f', 0.01), null);
    assert.equal(pickRay([0, 0, NaN], [0, 0, -1], data, 'f', 0.01), null);
    assert.equal(pickRay([0, 0, 1], [0, 0, -1], data, 'x', 0.01), null);
    assert.equal(pickRay([0, 0, 1], [0, 0, -1], null, 'f', 0.01), null);
});

test('nothing is picked on an empty mesh', () => {
    const data = renderData(new PolyDoc());
    ['v', 'e', 'f'].forEach((mode) => {
        assert.equal(pickRay([0, 0, 1], [0, 0, -1], data, mode, 0.1), null);
        assert.equal(pickNear([0, 0, 0], 1, data, mode), null);
    });
});

test('pickRay in vertex mode takes the visible corner, also on the outline, not the one behind it', () => {
    const doc = cubeDoc();
    const data = renderData(doc);
    const front = vertexAt(doc, [0.08, 0.08, 0.08]);
    assert.deepEqual(pickRay([0.079, 0.079, 1], [0, 0, -1], data, 'v', 0.01), {kind: 'v', id: front});
    // Just past the corner the ray misses the cube, and of the two corners in line the nearer one wins.
    assert.deepEqual(pickRay([0.081, 0.081, 1], [0, 0, -1], data, 'v', 0.01), {kind: 'v', id: front});
    // The middle of a face is out of reach of every corner.
    assert.equal(pickRay([0, 0, 1], [0, 0, -1], data, 'v', 0.01), null);
});

test('pickRay does not reach through a face to what lies behind it', () => {
    const behind = new PolyDoc();
    addPrimitive(behind, 'cube', 'start', 1, [0.02, 0.02, 0], 0.05);
    const corner = vertexAt(behind, [-0.03, -0.03, 0.05]);
    assert.deepEqual(pickRay([-0.03, -0.03, 1], [0, 0, -1], renderData(behind), 'v', 0.002), {kind: 'v', id: corner});
    addPrimitive(behind, 'cube', 'start', 2, [0, 0, 0.2], 0.05);
    assert.equal(pickRay([-0.03, -0.03, 1], [0, 0, -1], renderData(behind), 'v', 0.002), null);
});

test('pickRay allows the corners of the face it hit, however steeply that face is seen', () => {
    const doc = new PolyDoc();
    doc.addVert(1, [0, -0.002, 0]);
    doc.addVert(2, [0.02, -0.002, -0.08]);
    doc.addVert(3, [0.02, 0.002, -0.08]);
    doc.addVert(4, [0, 0.002, 0]);
    doc.addFace(10, [1, 2, 3, 4]);
    assert.deepEqual(pickRay([0.019, 0.001, 1], [0, 0, -1], renderData(doc), 'v', 0.01), {kind: 'v', id: 3});
});

test('pickRay in edge mode takes real edges, low id first, not the diagonals of the triangles', () => {
    const doc = cubeDoc();
    const data = renderData(doc);
    const u = vertexAt(doc, [-0.08, 0.08, 0.08]);
    const v = vertexAt(doc, [0.08, 0.08, 0.08]);
    const hit = pickRay([0, 0.0805, 1], [0, 0, -1], data, 'e', 0.005);
    assert.deepEqual(hit, {kind: 'e', a: Math.min(u, v), b: Math.max(u, v)});
    assert.equal(pickRay([0.001, 0.001, 1], [0, 0, -1], data, 'e', 0.005), null);
    assert.equal(pickRay([0.001, -0.001, 1], [0, 0, -1], data, 'e', 0.005), null);
});

test('a concave face is hit where it is and not in its notch, from both sides, with its own normal', () => {
    const doc = new PolyDoc();
    [[0, 0], [0.1, 0], [0.1, 0.05], [0.05, 0.05], [0.05, 0.1], [0, 0.1]].forEach((p, n) => doc.addVert(n + 1, [p[0], p[1], 0]));
    doc.addFace(100, [1, 2, 3, 4, 5, 6]);
    const data = renderData(doc);
    assert.equal(pickRay([0.075, 0.075, 1], [0, 0, -1], data, 'f', 0.01), null);
    assert.equal(pickRay([0.025, 0.075, 1], [0, 0, -1], data, 'f', 0.01).id, 100);
    assert.equal(pickRay([0.075, 0.025, 1], [0, 0, -1], data, 'f', 0.01).id, 100);
    const below = pickRay([0.025, 0.025, -1], [0, 0, 1], data, 'f', 0.01);
    assert.equal(below.id, 100);
    near(below.normal[2], 1);
});

test('pickNear gives the closest vertex, edge or face within the radius', () => {
    const doc = cubeDoc();
    const data = renderData(doc);
    assert.deepEqual(pickNear([0.085, 0.085, 0.085], 0.02, data, 'v'), {kind: 'v', id: vertexAt(doc, [0.08, 0.08, 0.08])});
    assert.equal(pickNear([0.085, 0.085, 0.085], 0.005, data, 'v'), null);
    const u = vertexAt(doc, [-0.08, 0.08, 0.08]);
    const v = vertexAt(doc, [0.08, 0.08, 0.08]);
    assert.deepEqual(pickNear([0, 0.085, 0.085], 0.02, data, 'e'), {kind: 'e', a: Math.min(u, v), b: Math.max(u, v)});
    assert.equal(pickNear([0, 0.085, 0.085], 0.005, data, 'e'), null);
    const face = pickNear([0.01, 0, 0.09], 0.02, data, 'f');
    assert.equal(face.kind, 'f');
    near(face.point[0], 0.01);
    near(face.point[2], 0.08);
    near(face.normal[2], 1);
    assert.equal(pickNear([0, 0, 0.11], 0.02, data, 'f'), null);
    assert.equal(pickNear([0, 0, 0.09], 0.02, data, 'x'), null);
    assert.equal(pickNear([0, 0, 0.09], -1, data, 'f'), null);
});

/**
 * The mesh tools against a real document, with the worker's delay: drawing data and refusals arrive at pump().
 *
 * @param {Function} [build] Fills the document; a cube when not given.
 * @returns {Object} The rig.
 */
const makeRig = (build) => {
    const doc = build ? build() : cubeDoc();
    const listeners = new Map();
    const queue = [];
    const rig = {doc, time: 1000, sent: [], previews: [], messages: [], refused: [], peers: [], stack: [], forgotten: []};
    let index = 0;
    let stroke = 100;
    let data = renderData(doc);
    const session = {
        author: () => 'u1',
        peers: () => rig.peers,
        submit: (op) => {
            rig.sent.push(op);
            index++;
            if (op.k === 'end' || op.k === 'undo') {
                return true;
            }
            const clean = cleanMeshOp(Object.assign({}, op, {a: 'u1', i: index}));
            assert.ok(clean, 'a valid op: ' + JSON.stringify(op));
            const result = applyMeshOp(doc, clean);
            queue.push(result.ok ? ['polymesh', renderData(doc)] : ['meshrefused', {op: clean, reason: result.reason}]);
            return true;
        },
    };
    const engine = {
        polydata: () => data,
        preview: (op) => rig.previews.push(op),
        on: (type, fn) => {
            listeners.set(type, (listeners.get(type) || []).concat([fn]));
            return () => undefined;
        },
    };
    const tools = {
        allocStroke: () => ++stroke,
        recordStroke: (s) => rig.stack.push(s),
        forgetStroke: (s) => rig.forgotten.push(s),
    };
    rig.model = createModelTools({
        session,
        tools,
        engine,
        onMessage: (key) => rig.messages.push(key),
        onRefused: (name) => rig.refused.push(name),
        now: () => rig.time,
    });
    rig.data = () => data;
    rig.pump = () => {
        queue.splice(0).forEach(([type, detail]) => {
            if (type === 'polymesh') {
                data = detail;
            }
            (listeners.get(type) || []).forEach((fn) => fn(detail));
        });
    };
    rig.settle = () => {
        rig.time += 200;
        rig.pump();
    };
    rig.other = (op) => {
        index++;
        assert.ok(applyMeshOp(doc, cleanMeshOp(Object.assign({}, op, {a: 'u2', i: index}))).ok);
        queue.push(['polymesh', renderData(doc)]);
        rig.settle();
    };
    rig.kinds = () => rig.sent.map((op) => op.k);
    rig.mxf = () => rig.sent.filter((op) => op.k === 'mxf');
    return rig;
};

/**
 * Pick along -z in a rig.
 *
 * @param {Object} rig The rig.
 * @param {string} mode The mode.
 * @param {number} [x] Ray x.
 * @param {number} [y] Ray y.
 * @returns {Object|null} The pick.
 */
const pickFront = (rig, mode, x = 0, y = 0) => pickRay([x, y, 1], [0, 0, -1], rig.data(), mode, 0.005);

/**
 * Select the cube's +z face in a rig, and let the data come back.
 *
 * @param {Object} rig The rig.
 * @returns {number} The face id.
 */
const selectFront = (rig) => {
    const hit = pickFront(rig, 'f');
    rig.model.selectHit(hit);
    rig.settle();
    rig.sent.length = 0;
    return hit.id;
};

/**
 * Select the whole cube in a rig.
 *
 * @param {Object} rig The rig.
 */
const selectEverything = (rig) => {
    rig.model.selectAll();
    rig.settle();
    rig.sent.length = 0;
};

/**
 * Select the cube's top front edge in a rig.
 *
 * @param {Object} rig The rig.
 * @returns {Object} The pick.
 */
const selectFrontEdge = (rig) => {
    const hit = pickFront(rig, 'e', 0, 0.0805);
    assert.equal(hit.kind, 'e');
    rig.model.selectHit(hit);
    rig.settle();
    rig.sent.length = 0;
    return hit;
};

test('a click selects with one op and shows at once; clicking it again sends nothing', () => {
    const rig = makeRig();
    const hit = pickFront(rig, 'f');
    assert.equal(rig.model.selectHit(hit), true);
    assert.deepEqual(rig.sent, [{k: 'msel', md: 'f', sm: 'set', ids: [hit.id]}]);
    assert.deepEqual(rig.model.selection(), {md: 'f', items: [hit.id]});
    rig.settle();
    assert.deepEqual(rig.model.selection(), {md: 'f', items: [hit.id]});
    rig.model.selectHit(hit);
    assert.equal(rig.sent.length, 1);
});

test('Shift adds and paints without toggling; no pick clears unless adding', () => {
    const rig = makeRig();
    const front = pickFront(rig, 'f');
    rig.model.selectHit(front);
    rig.settle();
    const side = pickRay([1, 0, 0], [-1, 0, 0], rig.data(), 'f');
    rig.model.selectHit(side, {add: true});
    rig.model.selectHit(side, {add: true});
    assert.deepEqual(rig.sent[1], {k: 'msel', md: 'f', sm: 'add', ids: [side.id]});
    assert.equal(rig.sent.length, 2);
    rig.settle();
    assert.deepEqual(rig.model.selection().items, [front.id, side.id]);
    rig.model.selectHit(null, {add: true});
    assert.equal(rig.sent.length, 2);
    rig.model.selectHit(side, {remove: true});
    assert.deepEqual(rig.sent[2], {k: 'msel', md: 'f', sm: 'rem', ids: [side.id]});
    assert.deepEqual(rig.model.selection().items, [front.id]);
    rig.settle();
    rig.model.selectHit(null);
    assert.deepEqual(rig.sent[3], {k: 'msel', md: 'f', sm: 'none'});
    rig.settle();
    assert.deepEqual(rig.doc.selectionOf('u1').items, []);
});

test('the selection carries over between modes', () => {
    const rig = makeRig();
    const face = selectFront(rig);
    const model = rig.model;
    assert.equal(model.selectMode, 'f');
    model.setSelectMode('e');
    assert.equal(model.selectMode, 'e');
    rig.settle();
    assert.equal(rig.doc.selectionOf('u1').md, 'e');
    assert.equal(rig.doc.selectionOf('u1').items.length, 8);
    model.setSelectMode('v');
    rig.settle();
    assert.equal(rig.doc.selectionOf('u1').items.length, 4);
    model.setSelectMode('f');
    rig.settle();
    assert.deepEqual(rig.doc.selectionOf('u1'), {md: 'f', items: [face]});
});

test('selecting everything is one op, also when a mode change comes to everything', () => {
    const rig = makeRig();
    selectEverything(rig);
    assert.equal(rig.model.selection().items.length, 6);
    rig.model.setSelectMode('v');
    assert.deepEqual(rig.sent, [{k: 'msel', md: 'v', sm: 'all'}]);
    rig.settle();
    assert.equal(rig.doc.selectionOf('u1').items.length, 8);
});

test('a large selection goes as a set and adds, each under the limit', () => {
    let sphereFaces = 0;
    const rig = makeRig(() => {
        const doc = new PolyDoc();
        addPrimitive(doc, 'sphere', 'start', 1, [0, 0, 0], 0.05, null, 0, 48);
        sphereFaces = doc.faces.size;
        doc.sel.set('u1', {md: 'v', items: Array.from(doc.verts.keys())});
        addPrimitive(doc, 'cube', 'start', 2, [0.2, 0, 0], 0.05);
        return doc;
    });
    rig.model.setSelectMode('f');
    assert.ok(rig.sent.length > 1);
    rig.sent.forEach((op, n) => {
        assert.equal(op.k, 'msel');
        assert.equal(op.sm, n === 0 ? 'set' : 'add');
        const size = JSON.stringify({k: op.k, a: 'u1', i: 2147483647, md: op.md, sm: op.sm, ids: op.ids}).length;
        assert.ok(size <= 900, `${size} bytes`);
    });
    rig.settle();
    assert.equal(rig.doc.selectionOf('u1').md, 'f');
    assert.equal(rig.doc.selectionOf('u1').items.length, sphereFaces);
});

test('select all, linked and loop', () => {
    const rig = makeRig();
    const model = rig.model;
    model.selectLinked();
    assert.deepEqual(rig.messages, ['meshrefused_empty']);
    assert.equal(rig.sent.length, 0);
    selectFront(rig);
    model.selectLinked();
    rig.settle();
    assert.equal(rig.doc.selectionOf('u1').items.length, 6);
    const edge = pickFront(rig, 'e', 0, 0.0805);
    model.selectLoop(edge);
    assert.deepEqual(rig.sent[rig.sent.length - 1], {k: 'msel', md: 'e', sm: 'loop', e: [edge.a, edge.b]});
    assert.equal(model.selectMode, 'e');
    rig.settle();
    assert.equal(rig.doc.selectionOf('u1').md, 'e');
    model.selectNone();
    rig.settle();
    assert.deepEqual(rig.doc.selectionOf('u1').items, []);
});

test('with nothing selected a drag or one-shot is refused here, with one message and no op', () => {
    const rig = makeRig();
    const model = rig.model;
    model.setAction('move');
    assert.equal(model.begin([0, 0, 0]), false);
    assert.equal(model.active, false);
    rig.time += 2000;
    assert.equal(model.runOneShot('delete'), false);
    assert.deepEqual(rig.messages, ['meshrefused_empty', 'meshrefused_empty']);
    assert.equal(rig.sent.length, 0);
    assert.equal(rig.stack.length, 0);
});

test('a move sends what it owes in increments, and goes on the undo stack with its end', () => {
    const rig = makeRig();
    selectFront(rig);
    const model = rig.model;
    model.setAction('move');
    assert.equal(model.begin([0, 0, 0.1]), true);
    assert.equal(model.active, true);
    rig.time += 100;
    model.move([0.01, 0, 0.1]);
    rig.time += 100;
    model.move([0.03, 0.01, 0.1]);
    rig.time += 100;
    model.end();
    assert.equal(model.active, false);
    assert.deepEqual(rig.kinds(), ['mxf', 'mxf', 'end']);
    assert.deepEqual(rig.sent[0].d, [0.01, 0, 0]);
    assert.deepEqual(rig.sent[1].d, [0.02, 0.01, 0]);
    assert.equal(rig.sent[2].s, rig.sent[0].s);
    assert.deepEqual(rig.stack, [rig.sent[0].s]);
    const p = rig.doc.verts.get(vertexAt(rig.doc, [0.11, 0.09, 0.08]));
    near(p[0], 0.11);
    near(p[1], 0.09);
    near(p[2], 0.08);
    near(rig.doc.verts.get(vertexAt(rig.doc, [0.08, 0.08, -0.08]))[0], 0.08);
});

test('a drag that does not move sends nothing and leaves nothing to undo', () => {
    const rig = makeRig();
    selectFront(rig);
    rig.model.setAction('move');
    rig.model.begin([0, 0, 0]);
    rig.model.end();
    assert.equal(rig.sent.length, 0);
    assert.equal(rig.stack.length, 0);
});

test('the rate cap holds ops back, the next op makes up for them, and the end sends the rest', () => {
    const rig = makeRig();
    selectFront(rig);
    const model = rig.model;
    model.setAction('move');
    model.begin([0, 0, 0]);
    for (let n = 1; n <= 10; n++) {
        model.move([n * 0.01, 0, 0]);
    }
    assert.equal(rig.mxf().length, 3);
    model.end();
    assert.equal(rig.mxf().length, 4);
    near(rig.mxf().reduce((sum, op) => sum + op.d[0], 0), 0.1, 1e-6);
});

test('a move stops at the edge of the working space, keeping the shape', () => {
    const rig = makeRig();
    selectFront(rig);
    rig.model.setAction('move');
    rig.model.begin([0, 0, 0]);
    rig.model.move([1, 0, 0]);
    rig.model.end();
    near(rig.doc.verts.get(vertexAt(rig.doc, [0.4, 0.08, 0.08]))[0], 0.4);
    near(rig.doc.verts.get(vertexAt(rig.doc, [0.24, 0.08, 0.08]))[0], 0.24);
});

test('an axis lock holds a move to the axis, also when it comes during the drag', () => {
    const rig = makeRig();
    selectFront(rig);
    const model = rig.model;
    model.setAction('move');
    model.setAxis('y');
    assert.equal(model.axis, 'y');
    model.begin([0, 0, 0]);
    rig.time += 100;
    model.move([0.05, 0.02, 0.03]);
    model.end();
    assert.deepEqual(rig.sent[0].d, [0, 0.02, 0]);
    rig.sent.length = 0;
    model.setAxis(null);
    model.begin([0, 0, 0]);
    rig.time += 100;
    model.move([0.05, 0.02, 0]);
    rig.time += 100;
    model.setAxis('x');
    model.end();
    assert.deepEqual(rig.sent[0].d, [0.05, 0.02, 0]);
    assert.deepEqual(rig.sent[1].d, [0, -0.02, 0]);
});

test('a hand turn goes about the hand\'s own axis, split at 0.5 rad', () => {
    const rig = makeRig();
    selectEverything(rig);
    const before = new Map(rig.doc.verts);
    const model = rig.model;
    model.setAction('rotate');
    assert.equal(model.begin([0, 0, 0], {quat: [0, 0, 0, 1]}), true);
    rig.time += 100;
    model.move([0, 0, 0], {quat: [0, Math.sin(0.6), 0, Math.cos(0.6)]});
    model.end();
    const turns = rig.mxf();
    assert.equal(turns.length, 3);
    turns.forEach((op) => {
        assert.ok(Math.abs(op.g) <= 0.5);
        assert.deepEqual(op.x, [0, 1, 0]);
        assert.deepEqual(op.p, [0, 0, 0]);
    });
    near(turns.reduce((sum, op) => sum + op.g, 0), 1.2, 0.001);
    before.forEach((p, id) => {
        const q = rig.doc.verts.get(id);
        near(q[0], p[0] * Math.cos(1.2) + p[2] * Math.sin(1.2), 0.0005);
        near(q[1], p[1], 0.0005);
        near(q[2], -p[0] * Math.sin(1.2) + p[2] * Math.cos(1.2), 0.0005);
    });
});

test('a pointer turn goes the way the pointer goes round the pivot, about the view', () => {
    const rig = makeRig();
    selectEverything(rig);
    const before = new Map(rig.doc.verts);
    const model = rig.model;
    model.setAction('rotate');
    model.begin([0.1, 0, 0], {ray: {origin: [0, 0, 1], dir: [0, 0, -1]}});
    rig.time += 100;
    model.move([0, 0.1, 0]);
    model.end();
    rig.mxf().forEach((op) => assert.ok(Math.abs(op.g) <= 0.5));
    before.forEach((p, id) => {
        const q = rig.doc.verts.get(id);
        near(q[0], -p[1], 0.0005);
        near(q[1], p[0], 0.0005);
        near(q[2], p[2], 0.0005);
    });
});

test('a scale follows the distance from the pivot, on one axis when locked, and stops at the working space', () => {
    const rig = makeRig();
    selectEverything(rig);
    const model = rig.model;
    model.setAction('scale');
    model.begin([0.1, 0, 0]);
    rig.time += 100;
    model.move([0.2, 0, 0]);
    model.end();
    assert.deepEqual(rig.mxf()[0].sc, [2, 2, 2]);
    assert.deepEqual(rig.mxf()[0].p, [0, 0, 0]);
    near(rig.doc.verts.get(vertexAt(rig.doc, [0.16, 0.16, 0.16]))[0], 0.16);
    rig.settle();
    rig.sent.length = 0;
    model.setAxis('y');
    model.begin([0.1, 0, 0]);
    rig.time += 100;
    model.move([0.15, 0, 0]);
    model.end();
    assert.deepEqual(rig.mxf()[0].sc, [1, 1.5, 1]);
    rig.settle();
    rig.sent.length = 0;
    model.setAxis(null);
    model.begin([0.01, 0, 0]);
    rig.time += 100;
    model.move([1, 0, 0]);
    model.end();
    for (const p of rig.doc.verts.values()) {
        assert.ok(Math.abs(p[0]) <= 0.4 && Math.abs(p[1]) <= 0.4 && Math.abs(p[2]) <= 0.4);
    }
    near(Math.max(...Array.from(rig.doc.verts.values(), (p) => Math.abs(p[1]))), 0.4, 0.001);
});

test('one vertex does not turn or scale, but it does move', () => {
    const rig = makeRig();
    const model = rig.model;
    const id = vertexAt(rig.doc, [0.08, 0.08, 0.08]);
    model.selectHit({kind: 'v', id});
    rig.settle();
    rig.sent.length = 0;
    model.setAction('rotate');
    assert.equal(model.begin([0, 0, 0]), false);
    model.setAction('scale');
    assert.equal(model.begin([0, 0, 0]), false);
    assert.equal(rig.sent.length, 0);
    model.setAction('move');
    assert.equal(model.begin([0, 0, 0]), true);
    rig.time += 100;
    model.move([0.01, 0, 0]);
    model.end();
    near(rig.doc.verts.get(id)[0], 0.09);
});

test('extrude waits for the pointer, then pulls along the normal', () => {
    const rig = makeRig();
    const face = selectFront(rig);
    const model = rig.model;
    model.setAction('extrude');
    assert.equal(model.begin([0, 0, 0.08]), true);
    model.end();
    assert.equal(rig.sent.length, 0);
    assert.equal(rig.stack.length, 0);
    model.begin([0, 0, 0.08]);
    rig.time += 100;
    model.move([0.05, 0, 0.12]);
    model.end();
    assert.deepEqual(rig.kinds(), ['mext', 'mxf', 'end']);
    assert.equal(rig.sent[0].s, rig.sent[1].s);
    near(rig.sent[1].d[0], 0);
    near(rig.sent[1].d[2], 0.04);
    assert.equal(rig.doc.verts.size, 12);
    assert.equal(rig.doc.faces.size, 10);
    assert.deepEqual(rig.doc.selectionOf('u1'), {md: 'f', items: [face]});
    rig.doc.faces.get(face).forEach((v) => near(rig.doc.verts.get(v)[2], 0.12));
    assert.equal(rig.stack.length, 1);
});

test('extrude needs faces or edges', () => {
    const rig = makeRig();
    rig.model.selectHit({kind: 'v', id: vertexAt(rig.doc, [0.08, 0.08, 0.08])});
    rig.settle();
    rig.sent.length = 0;
    rig.model.setAction('extrude');
    assert.equal(rig.model.begin([0, 0, 0]), false);
    assert.deepEqual(rig.messages, ['meshrefused_needfaces']);
    assert.equal(rig.sent.length, 0);
});

test('inset shows a preview while dragged and sends the real op at the end', () => {
    const rig = makeRig();
    const face = selectFront(rig);
    const model = rig.model;
    model.setAction('inset');
    assert.equal(model.begin([0, 0, 0.08]), true);
    assert.deepEqual(rig.previews, []);
    rig.time += 50;
    model.move([0.01, 0, 0.08]);
    assert.deepEqual(rig.previews, [{a: 'u1', k: 'minset', r: 0.01}]);
    assert.equal(model.width, 0.01);
    assert.equal(rig.sent.length, 0);
    // What the preview selects on the data is not the selection until the real op has been made.
    assert.deepEqual(model.selection(), {md: 'f', items: [face]});
    rig.time += 50;
    model.end();
    assert.deepEqual(rig.previews[1], null);
    assert.deepEqual(rig.kinds(), ['minset', 'end']);
    assert.equal(rig.sent[0].r, 0.01);
    assert.equal(rig.doc.verts.size, 12);
    assert.equal(rig.doc.faces.size, 10);
    assert.deepEqual(rig.stack, [rig.sent[0].s]);
});

test('an inset with no drag does nothing, and a call-off takes the preview back', () => {
    const rig = makeRig();
    selectFront(rig);
    const model = rig.model;
    model.setAction('inset');
    model.begin([0, 0, 0.08]);
    model.end();
    assert.deepEqual(rig.previews, []);
    assert.equal(rig.sent.length, 0);
    rig.settle();
    model.begin([0, 0, 0.08]);
    rig.time += 50;
    model.move([0.01, 0, 0.08]);
    model.cancel();
    assert.equal(model.active, false);
    assert.equal(rig.previews[rig.previews.length - 1], null);
    assert.equal(rig.sent.length, 0);
    assert.equal(rig.stack.length, 0);
});

test('bevel needs edges, and takes its width and segments from the drag', () => {
    const rig = makeRig();
    const model = rig.model;
    selectFront(rig);
    model.setAction('bevel');
    assert.equal(model.begin([0, 0, 0]), false);
    assert.deepEqual(rig.messages, ['meshrefused_neededges']);
    selectFrontEdge(rig);
    model.setSegments(99);
    assert.equal(model.segments, 4);
    model.setSegments(2);
    assert.equal(model.begin([0, 0, 0]), true);
    model.setWidth(0.5);
    assert.equal(model.width, 0.1);
    model.setWidth(0.01);
    assert.deepEqual(rig.previews[rig.previews.length - 1], {a: 'u1', k: 'mbevel', r: 0.01, n: 2});
    model.end();
    assert.deepEqual(rig.kinds(), ['mbevel', 'end']);
    assert.equal(rig.sent[0].n, 2);
    rig.settle();
    assert.equal(rig.messages.length, 1);
});

test('each action keeps its own segments in its own range', () => {
    const model = makeRig().model;
    assert.equal(model.segments, 16);
    assert.deepEqual(model.segmentRange(), {min: 3, max: 48});
    model.setAction('bevel');
    assert.equal(model.segments, 1);
    assert.deepEqual(model.segmentRange(), {min: 1, max: 4});
    model.setAction('loopcut');
    assert.equal(model.segments, 1);
    model.setSegments(99);
    assert.equal(model.segments, 8);
    model.setAction('select');
    assert.equal(model.segments, 16);
    model.setSegments(1);
    assert.equal(model.segments, 3);
});

test('a loop cut takes its edge from the pick, or a face\'s nearest side, slides, and sends at the end', () => {
    const rig = makeRig();
    const model = rig.model;
    const edge = pickFront(rig, 'e', 0, 0.0805);
    const face = pickFront(rig, 'f');
    model.setAction('loopcut');
    assert.equal(model.begin([0, 0, 0]), false);
    assert.deepEqual(rig.messages, ['meshrefused_neededges']);
    assert.equal(model.begin([0, 0.07, 0.08], {hit: {kind: 'f', id: face.id, point: [0, 0.07, 0.08]}}), true);
    assert.deepEqual(rig.previews[0], {a: 'u1', k: 'mloop', e: [edge.a, edge.b], st: 0.5, n: 1});
    rig.time += 50;
    model.move([0.04, 0.07, 0.08]);
    near(Math.abs(rig.previews[1].st - 0.5), 0.25);
    model.cancel();
    rig.settle();
    rig.previews.length = 0;
    model.begin([0, 0, 0], {hit: edge});
    model.end();
    assert.deepEqual(rig.kinds(), ['mloop', 'end']);
    assert.deepEqual(rig.sent[0].e, [edge.a, edge.b]);
    assert.equal(rig.sent[0].st, 0.5);
    assert.equal(rig.doc.verts.size, 12);
    assert.equal(rig.doc.faces.size, 10);
    assert.equal(rig.doc.selectionOf('u1').md, 'e');
});

test('calling off a started stroke undoes it and leaves it off the stack', () => {
    const rig = makeRig();
    selectFront(rig);
    const model = rig.model;
    model.setAction('move');
    model.begin([0, 0, 0]);
    rig.time += 100;
    model.move([0.01, 0, 0]);
    model.cancel();
    const s = rig.sent[0].s;
    assert.deepEqual(rig.sent.slice(1), [{k: 'end', s}, {k: 'undo', t: s}]);
    assert.equal(rig.stack.length, 0);
    assert.equal(model.active, false);
});

test('calling off a drag that has not started sends nothing', () => {
    const rig = makeRig();
    selectFront(rig);
    rig.model.setAction('extrude');
    rig.model.begin([0, 0, 0]);
    rig.model.cancel();
    assert.equal(rig.sent.length, 0);
});

test('another person\'s selection locks what shares a vertex with it, until they leave', () => {
    const rig = makeRig();
    const model = rig.model;
    const front = pickFront(rig, 'f');
    const side = pickRay([1, 0, 0], [-1, 0, 0], rig.data(), 'f');
    const back = pickRay([0, 0, -1], [0, 0, 1], rig.data(), 'f');
    rig.peers = [{peerid: 'u2', name: 'Bea'}];
    rig.other({k: 'msel', md: 'f', sm: 'set', ids: [front.id]});
    assert.equal(model.selectHit(front), false);
    assert.deepEqual(rig.refused, ['Bea']);
    assert.equal(rig.sent.length, 0);
    rig.time += 2000;
    assert.equal(model.selectHit(side), false);
    assert.deepEqual(rig.refused, ['Bea', 'Bea']);
    rig.time += 2000;
    model.selectAll();
    assert.equal(rig.refused.length, 3);
    assert.equal(rig.sent.length, 0);
    assert.equal(model.selectHit(back), true);
    assert.equal(rig.sent.length, 1);
    rig.settle();
    rig.peers = [];
    assert.equal(model.selectHit(side), true);
    rig.settle();
    assert.deepEqual(rig.model.selection().items, [side.id]);
});

test('an edit is refused at the start and stopped on the way when someone else holds what it works on', () => {
    const rig = makeRig();
    const model = rig.model;
    const side = pickRay([1, 0, 0], [-1, 0, 0], rig.data(), 'f');
    selectFront(rig);
    rig.peers = [{peerid: 'u2', name: 'Bea'}];
    model.setAction('move');
    assert.equal(model.begin([0, 0, 0]), true);
    rig.time += 100;
    model.move([0.01, 0, 0]);
    rig.other({k: 'msel', md: 'f', sm: 'set', ids: [side.id]});
    model.move([0.02, 0, 0]);
    assert.equal(model.active, false);
    assert.deepEqual(rig.refused, ['Bea']);
    assert.deepEqual(rig.kinds().slice(-1), ['end']);
    assert.equal(rig.stack.length, 1);
    rig.time += 2000;
    assert.equal(model.begin([0, 0, 0]), false);
    assert.deepEqual(rig.refused, ['Bea', 'Bea']);
    assert.equal(model.runOneShot('delete'), false);
    assert.equal(rig.doc.faces.size, 6);
});

test('what someone else deletes during a drag stops the drag, with one message', () => {
    const rig = makeRig();
    const face = selectFront(rig);
    const model = rig.model;
    model.setAction('move');
    model.begin([0, 0, 0]);
    rig.time += 100;
    model.move([0.01, 0, 0]);
    rig.pump();
    rig.other({k: 'msel', md: 'f', sm: 'set', ids: [face]});
    rig.other({k: 'mdel', s: 500});
    rig.time += 100;
    model.move([0.02, 0, 0]);
    rig.pump();
    assert.equal(model.active, false);
    assert.deepEqual(rig.messages, ['meshrefused_empty']);
    const count = rig.sent.length;
    rig.time += 100;
    model.move([0.03, 0, 0]);
    model.end();
    assert.equal(rig.sent.length, count);
    assert.deepEqual(rig.kinds().slice(-1), ['end']);
});

test('a one-shot the document refuses comes off the undo stack, and says why', () => {
    const rig = makeRig();
    const model = rig.model;
    model.selectHit({kind: 'v', id: vertexAt(rig.doc, [0.08, 0.08, 0.08])});
    rig.settle();
    model.selectHit({kind: 'v', id: vertexAt(rig.doc, [-0.08, -0.08, -0.08])}, {add: true});
    rig.settle();
    rig.sent.length = 0;
    assert.equal(model.runOneShot('fill'), true);
    assert.equal(rig.stack.length, 1);
    rig.pump();
    assert.deepEqual(rig.forgotten, [rig.sent[0].s]);
    assert.deepEqual(rig.messages, ['meshrefused_badselection']);
});

test('one-shots: delete, flip, mirror of everything, bake; merge wants two vertices', () => {
    const rig = makeRig();
    const model = rig.model;
    model.selectHit({kind: 'v', id: vertexAt(rig.doc, [0.08, 0.08, 0.08])});
    rig.settle();
    assert.equal(model.runOneShot('merge'), false);
    assert.deepEqual(rig.messages, ['meshrefused_empty']);
    assert.equal(model.runOneShot('nonsense'), false);
    model.selectNone();
    rig.settle();
    assert.equal(model.runOneShot('mirror'), true);
    rig.settle();
    assert.equal(rig.doc.faces.size, 12);
    assert.equal(model.selectMode, 'f');
    assert.equal(model.selection().items.length, 6);
    assert.equal(model.runOneShot('flip'), true);
    rig.settle();
    assert.equal(model.runOneShot('delete'), true);
    rig.settle();
    assert.equal(rig.doc.faces.size, 6);
    assert.equal(model.selection().items.length, 0);
    assert.equal(model.runOneShot('bake'), true);
    assert.equal(rig.sent[rig.sent.length - 2].k, 'mbake');
    rig.settle();
    assert.equal(rig.doc.faces.size, 0);
    rig.time += 2000;
    assert.equal(model.runOneShot('bake'), false);
    assert.equal(rig.messages[rig.messages.length - 1], 'meshrefused_empty');
});

test('a shape goes on the wire within its ranges and becomes the selection', () => {
    const rig = makeRig();
    const model = rig.model;
    assert.equal(model.addShape('cylinder', [0, 0.2, 0], 0.05), true);
    assert.deepEqual(rig.sent[0], {k: 'mprim', sh: 'cylinder', p: [0, 0.2, 0], r: 0.05, n: 16, s: rig.sent[1].s});
    assert.equal(rig.sent[1].k, 'end');
    assert.equal(rig.stack.length, 1);
    rig.settle();
    assert.equal(model.selectMode, 'f');
    assert.equal(model.selection().items.length, 18);
    rig.sent.length = 0;
    assert.equal(model.addShape('cube', [0, -0.2, 0], 0.001, [0, 2, 0], 0.5), true);
    assert.deepEqual(rig.sent[0], {k: 'mprim', sh: 'cube', p: [0, -0.2, 0], r: 0.01, x: [0, 1, 0], g: 0.5, s: rig.sent[1].s});
    assert.equal(model.addShape('blob', [0, 0, 0], 0.05), false);
    assert.equal(model.addShape('cube', null, 0.05), false);
});
