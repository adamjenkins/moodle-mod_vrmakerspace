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
 * Tests of the mesh layer inside the engine (js/engine/engine.js): convergence of mixed clay and mesh ops,
 * the mesh rebase rule, undo and redo, turning the mesh into clay, the preview and the snapshot.
 *
 * Run from the repository root: node --test tests/js/polyengine.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../js/engine/engine.js';
import {header, readSnapshot, writeSnapshot} from '../../js/engine/snapshot.js';
import {PolyDoc, serializeDoc} from '../../js/engine/polymesh.js';
import {addPrimitive} from '../../js/engine/polyprims.js';
import {applyMeshOp} from '../../js/engine/polyops.js';
import {cleanOp} from '../../js/engine/ops.js';

/** A small grid keeps the tests fast: 40³ voxels of 6 mm, a 0.10 m sphere of clay. */
const OPTS = {dims: 40, voxel: 0.006, model: 'sphere'};

/** An engine with no clay and an empty mesh. */
const EMPTY = {dims: 40, voxel: 0.006, model: 'empty'};

/** The epoch every serialized file of a comparison carries. */
const EPOCH = '0123456789abcdef';

/**
 * Bytes of a grid's values.
 *
 * @param {object} grid Grid.
 * @returns {Buffer} A copy of its bytes.
 */
const clayOf = (grid) => Buffer.from(grid.data.slice().buffer);

/**
 * The bytes of a mesh document.
 *
 * @param {object} doc PolyDoc.
 * @returns {Buffer} Its serialized form.
 */
const meshOf = (doc) => Buffer.from(serializeDoc(doc));

/**
 * Makes ops of one author with increasing op indexes and stroke ids.
 *
 * @param {string} author Author id.
 * @returns {{op: function(object): object, stroke: function(object[]): object[], s: function(): number}} op()
 *     stamps one op; stroke() stamps edit ops as one new stroke, closed by its end op.
 */
function writer(author) {
    let i = 0;
    let s = 0;
    return {
        op: (o) => Object.assign({a: author, i: ++i}, o),
        stroke(list) {
            s++;
            const out = list.map((o) => Object.assign({a: author, s, i: ++i}, o));
            out.push({k: 'end', a: author, s, i: ++i});
            return out;
        },
        s: () => s,
    };
}

/**
 * The id of the first face of a cube an mprim op makes.
 *
 * @param {object} op The clean mprim op, with author and index.
 * @returns {number} The face id.
 */
function firstFace(op) {
    return addPrimitive(new PolyDoc(), 'cube', op.a, op.i, op.p, op.r, null, 0, 16)[0];
}

/**
 * The ops one author sends: clay strokes and mesh edits of most kinds, with undo and redo of both.
 *
 * @param {string} author Author id.
 * @param {number} side +1 or −1: the side of x = 0 this author mostly works on.
 * @returns {object[]} Ops in the author's order.
 */
function authorOps(author, side) {
    const w = writer(author);
    const x = 0.05 * side;
    const ops = [];
    ops.push(...w.stroke([{k: 'add', p: [x, 0.09, 0], r: 0.02, st: 0.8}]));
    const cube = w.stroke([{k: 'mprim', sh: 'cube', p: [x, 0, 0], r: 0.03}]);
    ops.push(...cube);
    ops.push(w.op({k: 'msel', md: 'f', sm: 'set', ids: [firstFace(cube[0])]}));
    ops.push(...w.stroke([{k: 'mxf', d: [0, 0.01, 0]}, {k: 'mxf', d: [0.002, 0, 0]}]));
    ops.push(...w.stroke([{k: 'mext'}, {k: 'mxf', d: [0, 0.005, 0]}]));
    ops.push(...w.stroke([{k: 'minset', r: 0.002}]));
    ops.push(w.op({k: 'undo', t: w.s()}));
    ops.push(...w.stroke([{k: 'carve', p: [x, -0.09, 0], r: 0.02, st: 0.6}]));
    ops.push(w.op({k: 'redo', t: w.s() - 1}));
    ops.push(w.op({k: 'msel', sm: 'all'}));
    ops.push(...w.stroke([{k: 'mxf', p: [0, 0, 0], sc: [1.1, 1, 1]}]));
    ops.push(w.op({k: 'msel', sm: 'none'}));
    ops.push(...w.stroke([{k: 'mprim', sh: 'cylinder', p: [x, -0.05, 0], r: 0.02, n: 6}]));
    ops.push(...w.stroke([{k: 'mflip'}]));
    ops.push(...w.stroke([{k: 'mmirror'}]));
    ops.push(...w.stroke([{k: 'mdel'}]));
    ops.push(w.op({k: 'save'}));
    return ops;
}

/**
 * Merges two authors' ops in a sequencer order: `pattern` ops of a, then one of b, repeatedly.
 *
 * @param {object[]} a Ops of the first author.
 * @param {object[]} b Ops of the second author.
 * @param {number} pattern Ops of a per op of b.
 * @returns {object[]} The sequenced ops.
 */
function merge(a, b, pattern) {
    const out = [];
    let ia = 0;
    let ib = 0;
    while (ia < a.length || ib < b.length) {
        for (let n = 0; n < pattern && ia < a.length; n++) {
            out.push(a[ia++]);
        }
        if (ib < b.length) {
            out.push(b[ib++]);
        }
    }
    return out;
}

/**
 * The display mesh rebuilt from scratch: a copy of MC with every pending mesh op applied in order.
 *
 * @param {Engine} engine Engine.
 * @returns {Buffer} Its serialized form.
 */
function rebuilt(engine) {
    const doc = engine.polyConfirmed.copy();
    engine.pendingOps.forEach((op) => {
        const c = cleanOp(op);
        if (c.k[0] === 'm' && c.k !== 'mbake') {
            applyMeshOp(doc, c);
        }
    });
    return meshOf(doc);
}

/**
 * Runs one client over a sequence: its own ops are applied locally `lag` positions ahead of their
 * confirmation, and MD = MC ⊕ pending is checked after every confirmation.
 *
 * @param {object} options Engine options.
 * @param {object[]} sequence Sequenced ops.
 * @param {string|null} author This client's author id (null: a client with no own ops).
 * @param {number} lag How far ahead own ops are applied locally.
 * @returns {Promise<Engine>} The engine after the whole sequence.
 */
async function runClient(options, sequence, author, lag) {
    const engine = await Engine.create(options);
    const own = [];
    sequence.forEach((op, n) => {
        if (op.a === author) {
            own.push({op, n});
        }
    });
    let next = 0;
    for (let n = 0; n < sequence.length; n++) {
        while (next < own.length && own[next].n < n + lag) {
            assert.equal(engine.local(own[next].op).ok, true);
            next++;
        }
        assert.equal(engine.confirmed(sequence[n], n + 1).ok, true, 'op ' + n + ' confirmed');
        assert.ok(meshOf(engine.MD).equals(rebuilt(engine)), 'MD = MC ⊕ pending after op ' + n);
    }
    assert.equal(engine.stats().pending, 0);
    return engine;
}

/**
 * Applies an op as a solo client does: locally, then confirmed with the next seq.
 *
 * @param {Engine} e Engine.
 * @param {object} op Op.
 * @returns {object} The result of confirmed().
 */
function submit(e, op) {
    assert.equal(e.local(op).ok, true);
    const r = e.confirmed(op, e.seq + 1);
    assert.equal(r.ok, true);
    return r;
}

/**
 * Applies several ops as a solo client does.
 *
 * @param {Engine} e Engine.
 * @param {object[]} ops Ops.
 * @returns {void}
 */
function submitAll(e, ops) {
    ops.forEach((op) => submit(e, op));
}

/**
 * Counts the voxels inside the clay.
 *
 * @param {object} grid Grid.
 * @returns {number} The count.
 */
const inside = (grid) => grid.data.reduce((n, v) => n + (v < 0 ? 1 : 0), 0);

test('clients with different local/confirmed interleavings of clay and mesh ops converge byte-identically', async() => {
    const a = authorOps('ua', 1);
    const b = authorOps('ub', -1);
    for (const sequence of [merge(a, b, 2), merge(b, a, 3), a.concat(b)]) {
        const ref = await runClient(OPTS, sequence, null, 0);
        const refBytes = Buffer.from(await ref.serialize(EPOCH));
        const clients = [
            await runClient(OPTS, sequence, 'ua', 1),
            await runClient(OPTS, sequence, 'ua', 6),
            await runClient(OPTS, sequence, 'ub', 3),
            await runClient(OPTS, sequence, 'ub', 11),
        ];
        for (const e of clients) {
            assert.ok(Buffer.from(await e.serialize(EPOCH)).equals(refBytes), 'the files are identical');
            assert.ok(clayOf(e.display).equals(clayOf(ref.display)), 'the clay on display is identical');
            assert.ok(meshOf(e.MD).equals(meshOf(ref.MD)), 'the mesh on display is identical');
            assert.deepEqual(e.stats(), ref.stats(), 'same seq and contributions');
        }
    }
});

test('the test script does real work: both layers change and most edits are not refused', async() => {
    const sequence = authorOps('ua', 1);
    const e = await Engine.create(OPTS);
    const clay = clayOf(e.confirmedGrid);
    const refused = [];
    let faces = 0;
    sequence.forEach((op, n) => {
        const r = e.confirmed(op, n + 1);
        if (r.refused) {
            refused.push(op.k + ': ' + r.refused);
        }
        faces = Math.max(faces, e.polyConfirmed.faces.size);
    });
    assert.deepEqual(refused, []);
    assert.ok(faces >= 6);
    assert.ok(!clayOf(e.confirmedGrid).equals(clay));
});

test('a different sequencer order also converges, and differs from the first where edits overlap', async() => {
    const w1 = writer('ua');
    const w2 = writer('ub');
    const first = w1.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.03}]);
    const second = w2.op({k: 'msel', sm: 'all'});
    const third = w2.stroke([{k: 'mxf', d: [0.01, 0, 0]}]);
    const s1 = first.concat([second], third);
    const s2 = [second].concat(third, first);
    const x = await runClient(EMPTY, s1, 'ua', 3);
    const y = await runClient(EMPTY, s1, 'ub', 2);
    assert.ok(meshOf(x.MC).equals(meshOf(y.MC)));
    const z = await runClient(EMPTY, s2, 'ub', 2);
    assert.ok(!meshOf(x.MC).equals(meshOf(z.MC)), 'selected before or after the cube existed');
});

test('a foreign mesh op confirmed under pending ops rebases the display exactly', async() => {
    const e = await Engine.create(EMPTY);
    const me = writer('me');
    const you = writer('you');
    const own = me.stroke([{k: 'mprim', sh: 'cube', p: [0.05, 0, 0], r: 0.02}, {k: 'mxf', d: [0, 0.01, 0]}]);
    const clay = me.stroke([{k: 'add', p: [0, 0.08, 0], r: 0.02, st: 1}]);
    const more = me.stroke([{k: 'mflip'}, {k: 'mxf', d: [0.003, 0, 0]}]);
    const mine = own.concat(clay, more);
    mine.forEach((op) => assert.equal(e.local(op).ok, true));
    const before = meshOf(e.MD);
    const foreign = you.stroke([{k: 'mprim', sh: 'cube', p: [-0.05, 0, 0], r: 0.02}]);
    e.takePolyDirty();
    foreign.forEach((op, n) => assert.equal(e.confirmed(op, n + 1).ok, true));
    assert.equal(e.takePolyDirty(), true, 'the display changed');
    assert.ok(!meshOf(e.MD).equals(before));
    assert.ok(meshOf(e.MD).equals(rebuilt(e)), 'MD = MC ⊕ pending');
    assert.equal(e.stats().pending, mine.length);
    assert.equal(e.polyConfirmed.faces.size, 6, 'only the foreign cube is confirmed');
    assert.equal(e.MD.faces.size > 6, true, 'the display has both');

    // The same result as a client that saw the foreign op first, in sequence order.
    const f = await Engine.create(EMPTY);
    foreign.concat(mine).forEach((op, n) => f.confirmed(op, n + 1));
    mine.forEach((op, n) => e.confirmed(op, foreign.length + n + 1));
    assert.equal(e.stats().pending, 0);
    assert.ok(meshOf(e.MD).equals(meshOf(f.MD)));
    assert.ok(meshOf(e.MC).equals(meshOf(f.MC)));
    assert.ok(clayOf(e.confirmedGrid).equals(clayOf(f.confirmedGrid)));
    assert.ok(Buffer.from(await e.serialize(EPOCH)).equals(Buffer.from(await f.serialize(EPOCH))));
});

test('confirming the oldest pending mesh op recomputes nothing, and the display stays', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('me');
    const ops = w.stroke([{k: 'mprim', sh: 'cube', p: [0.05, 0, 0], r: 0.02}, {k: 'mxf', d: [0, 0.01, 0]}]);
    ops.forEach((op) => e.local(op));
    const md = e.MD;
    const before = meshOf(md);
    e.takePolyDirty();
    ops.forEach((op, n) => e.confirmed(op, n + 1));
    assert.equal(e.MD, md, 'the same document');
    assert.equal(e.takePolyDirty(), false, 'nothing to post');
    assert.ok(meshOf(e.MD).equals(before));
    assert.ok(meshOf(e.MC).equals(before));
});

test('a foreign op with nothing pending applies to both documents alike', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('you');
    const ops = w.stroke([{k: 'mprim', sh: 'cube', p: [0.05, 0, 0], r: 0.02}]);
    ops.forEach((op, n) => e.confirmed(op, n + 1));
    assert.equal(e.takePolyDirty(), true);
    assert.equal(e.MC.faces.size, 6);
    assert.ok(meshOf(e.MD).equals(meshOf(e.MC)));
    assert.notEqual(e.MD, e.MC, 'separate documents');
});

test('a lost pending mesh op is dropped when a later op of its author is confirmed', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('me');
    const lost = w.op({k: 'mprim', s: 1, sh: 'cube', p: [0.05, 0, 0], r: 0.02});
    const kept = w.op({k: 'mprim', s: 2, sh: 'cube', p: [-0.05, 0, 0], r: 0.02});
    e.local(lost);
    e.local(kept);
    assert.equal(e.MD.faces.size, 12);
    e.confirmed(kept, 1);
    assert.equal(e.stats().pending, 0);
    assert.equal(e.MD.faces.size, 6);
    assert.ok(meshOf(e.MD).equals(meshOf(e.MC)));
});

test('deleting what another person is working on refuses their later ops, and everyone converges', async() => {
    const me = writer('me');
    const you = writer('you');
    const start = me.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.03}]);
    const youSelect = you.op({k: 'msel', sm: 'all'});
    const youDelete = you.stroke([{k: 'mdel'}]);
    const myMove = me.stroke([{k: 'mxf', d: [0.01, 0, 0]}]);
    const sequence = start.concat([youSelect], youDelete, myMove);

    const e = await Engine.create(EMPTY);
    start.forEach((op, n) => {
        e.local(op);
        e.confirmed(op, n + 1);
    });
    assert.deepEqual(e.takeRefusals(), []);
    // My move is pending when the delete arrives: it applies locally, then there is nothing left to move.
    myMove.forEach((op) => e.local(op));
    assert.deepEqual(e.takeRefusals(), [], 'it still works locally');
    let seq = start.length;
    [youSelect].concat(youDelete).forEach((op) => e.confirmed(op, ++seq));
    assert.equal(e.MD.faces.size, 0, 'the display follows the delete');
    assert.ok(meshOf(e.MD).equals(rebuilt(e)));
    assert.deepEqual(e.takeRefusals(), [], 'not told until the sequencer decides');
    const r = e.confirmed(myMove[0], ++seq);
    assert.ok(r.ok);
    assert.ok(r.refused, 'refused on the confirmed document');
    const told = e.takeRefusals();
    assert.equal(told.length, 1);
    assert.equal(told[0].op.k, 'mxf');
    assert.equal(told[0].reason, r.refused);
    e.confirmed(myMove[1], ++seq);

    const f = await runClient(EMPTY, sequence, 'you', 2);
    assert.deepEqual(f.takeRefusals(), [], 'another person\'s refused op is not told');
    assert.ok(Buffer.from(await e.serialize(EPOCH)).equals(Buffer.from(await f.serialize(EPOCH))));
});

test('an op refused locally stays pending, is told once and takes its seq', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('me');
    const ops = w.stroke([{k: 'mxf', d: [0.01, 0, 0]}]);
    const md = meshOf(e.MD);
    const r = e.local(ops[0]);
    assert.equal(r.ok, true);
    assert.ok(r.refused);
    assert.ok(meshOf(e.MD).equals(md), 'a refused op changes nothing');
    assert.equal(e.stats().pending, 1);
    assert.equal(e.takeRefusals().length, 1);
    assert.deepEqual(e.takeRefusals(), [], 'collected');
    const c = e.confirmed(ops[0], 1);
    assert.equal(c.ok, true);
    assert.equal(c.refused, r.refused);
    assert.deepEqual(e.takeRefusals(), [], 'told once');
    assert.equal(e.seq, 1);
    assert.equal(e.stats().pending, 0);
    assert.deepEqual(e.stats().contributions, {}, 'a refused op does not count');
});

test('undo of a mesh stroke restores the document, redo brings the stroke back', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('ua');
    submitAll(e, w.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.03}]));
    const made = w.s();
    const before = meshOf(e.MC);
    submitAll(e, w.stroke([{k: 'mxf', d: [0.01, 0, 0]}, {k: 'mxf', d: [0, 0.003, 0]}, {k: 'mxf', d: [0, 0, -0.007]}]));
    const moved = w.s();
    const after = meshOf(e.MC);
    assert.ok(!after.equals(before));
    assert.ok(e.meshHistory.has('ua', moved));

    submit(e, w.op({k: 'undo', t: moved}));
    assert.ok(meshOf(e.MC).equals(before), 'undo');
    assert.ok(meshOf(e.MD).equals(before), 'undo shows');
    submit(e, w.op({k: 'undo', t: moved}));
    assert.ok(meshOf(e.MC).equals(before), 'a second undo is a no-op');
    submit(e, w.op({k: 'redo', t: moved}));
    assert.ok(meshOf(e.MC).equals(after), 'redo');
    assert.ok(meshOf(e.MD).equals(after), 'redo shows');
    submit(e, w.op({k: 'redo', t: moved}));
    assert.ok(meshOf(e.MC).equals(after), 'a second redo is a no-op');
    submit(e, w.op({k: 'undo', t: 99}));
    submit(e, writer('ub').op({k: 'undo', t: moved}));
    assert.ok(meshOf(e.MC).equals(after), 'unknown strokes and other authors cannot undo it');

    // Undoing the stroke that made the cube removes it; redo makes it again.
    submit(e, w.op({k: 'undo', t: moved}));
    submit(e, w.op({k: 'undo', t: made}));
    assert.equal(e.MC.faces.size, 0);
    assert.equal(e.MC.verts.size, 0);
    submit(e, w.op({k: 'redo', t: made}));
    assert.equal(e.MC.faces.size, 6);
    assert.equal(e.MC.verts.size, 8);
});

test('undoing a mesh stroke under own pending ops rebuilds the display on the new base', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('ua');
    submitAll(e, w.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.03}]));
    const made = w.s();
    const undo = w.op({k: 'undo', t: made});
    const next = w.stroke([{k: 'mprim', sh: 'cube', p: [0.05, 0, 0], r: 0.01}]);
    e.local(undo);
    next.forEach((op) => e.local(op));
    assert.equal(e.MD.faces.size, 12, 'undo is not optimistic');
    e.confirmed(undo, e.seq + 1);
    assert.equal(e.MC.faces.size, 0);
    assert.equal(e.MD.faces.size, 6, 'only the pending cube is left');
    assert.ok(meshOf(e.MD).equals(rebuilt(e)));
});

test('undoing a stroke keeps the other person\'s separate work and their later moves', async() => {
    const e = await Engine.create(EMPTY);
    const a = writer('ua');
    const b = writer('ub');
    submitAll(e, a.stroke([{k: 'mprim', sh: 'cube', p: [0.05, 0, 0], r: 0.02}]));
    submitAll(e, b.stroke([{k: 'mprim', sh: 'cube', p: [-0.05, 0, 0], r: 0.02}]));
    submitAll(e, a.stroke([{k: 'mxf', d: [0.01, 0, 0]}]));
    const moved = a.s();
    submitAll(e, b.stroke([{k: 'mxf', d: [0, 0.01, 0]}]));
    const withBoth = e.MC.copy();
    submit(e, a.op({k: 'undo', t: moved}));
    assert.equal(e.MC.faces.size, 12);
    let same = 0;
    let back = 0;
    e.MC.verts.forEach((p, id) => {
        const q = withBoth.verts.get(id);
        if (p[0] === q[0]) {
            same++;
        } else {
            assert.equal(Math.round((q[0] - p[0]) * 1e5), 1000);
            back++;
        }
        assert.equal(p[1], q[1]);
        assert.equal(p[2], q[2]);
    });
    assert.equal(same, 8);
    assert.equal(back, 8);
});

test('turning the mesh into clay, then undo, restores both layers exactly; redo repeats it', async() => {
    const e = await Engine.create(OPTS);
    const w = writer('ua');
    submitAll(e, w.stroke([{k: 'mprim', sh: 'cube', p: [0.06, 0.06, 0], r: 0.03}]));
    submitAll(e, w.stroke([{k: 'mxf', d: [0, 0.01, 0]}]));
    const clayBefore = clayOf(e.confirmedGrid);
    const meshBefore = meshOf(e.MC);
    const insideBefore = inside(e.confirmedGrid);

    const bake = w.stroke([{k: 'mbake'}]);
    const baked = w.s();
    assert.equal(e.local(bake[0]).ok, true);
    assert.ok(meshOf(e.MD).equals(meshBefore), 'not applied until confirmed');
    assert.ok(clayOf(e.display).equals(clayBefore));
    assert.equal(e.confirmed(bake[0], e.seq + 1).refused, undefined);
    assert.equal(e.MC.faces.size, 0);
    assert.equal(e.MC.verts.size, 0);
    assert.equal(e.MD.faces.size, 0, 'the mesh leaves the display');
    assert.ok(inside(e.confirmedGrid) > insideBefore, 'the clay grew');
    assert.ok(clayOf(e.display).equals(clayOf(e.confirmedGrid)), 'and shows');
    submit(e, bake[1]);
    const clayAfter = clayOf(e.confirmedGrid);
    const meshAfter = meshOf(e.MC);

    submit(e, w.op({k: 'undo', t: baked}));
    assert.ok(clayOf(e.confirmedGrid).equals(clayBefore), 'clay restored');
    assert.ok(clayOf(e.display).equals(clayBefore), 'clay restored on display');
    assert.ok(meshOf(e.MC).equals(meshBefore), 'mesh restored');
    assert.ok(meshOf(e.MD).equals(meshBefore), 'mesh restored on display');

    submit(e, w.op({k: 'redo', t: baked}));
    assert.ok(clayOf(e.confirmedGrid).equals(clayAfter), 'clay baked again');
    assert.ok(meshOf(e.MC).equals(meshAfter), 'mesh emptied again');
    assert.equal(e.MD.faces.size, 0);
});

test('baking is deterministic on every client, and voxelises a closed mesh', async() => {
    const w = writer('ua');
    const sequence = w.stroke([{k: 'mbake'}]);
    const options = {dims: 40, voxel: 0.006, model: 'meshcube'};
    const a = await runClient(options, sequence, 'ua', 2);
    const b = await runClient(options, sequence, null, 0);
    assert.ok(Buffer.from(await a.serialize(EPOCH)).equals(Buffer.from(await b.serialize(EPOCH))));
    assert.equal(a.MC.faces.size, 0);
    const g = a.confirmedGrid;
    assert.ok(g.get(20, 20, 20) < 0, 'the centre of the cube is inside');
    assert.ok(g.get(3, 3, 3) > 0, 'a far corner is outside');
    // The half-extent is 0.08 m, so the cube fills about (0.16 / 0.006)³ voxels.
    const count = inside(g);
    assert.ok(count > 0.8 * 26.67 * 26.67 * 26.67 && count < 1.2 * 26.67 * 26.67 * 26.67, 'count ' + count);
    const c = a.stats().contributions.ua;
    assert.equal(c.ops, 1);
    assert.equal(c.added, 0, 'the mesh was already their work: baking moves no new volume');
});

test('overlapping parts bake solid: their overlap is not left hollow', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('ua');
    submitAll(e, w.stroke([{k: 'mprim', sh: 'cube', p: [-0.02, 0, 0], r: 0.05}]));
    submitAll(e, w.stroke([{k: 'mprim', sh: 'cube', p: [0.02, 0, 0], r: 0.05}]));
    const baked = w.stroke([{k: 'mbake'}]);
    const made = w.s();
    const clay = clayOf(e.confirmedGrid);
    submitAll(e, baked);
    const g = e.confirmedGrid;
    assert.ok(g.get(20, 20, 20) < 0, 'the middle of the overlap is inside');
    // The union is 0.14 × 0.1 × 0.1 m, about 6481 voxels of 6 mm.
    const count = inside(g);
    assert.ok(count > 0.8 * 6481 && count < 1.2 * 6481, 'count ' + count);
    submit(e, w.op({k: 'undo', t: made}));
    assert.ok(clayOf(e.confirmedGrid).equals(clay), 'undo takes it all back');
    assert.equal(e.MC.faces.size, 12);
});

test('baking under pending ops of both layers rebases both, and an empty mesh refuses', async() => {
    const e = await Engine.create({dims: 40, voxel: 0.006, model: 'meshcube'});
    const you = writer('you');
    const me = writer('me');
    const clayOp = me.stroke([{k: 'add', p: [0, 0.1, 0], r: 0.02, st: 1}]);
    const meshOp = me.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.01}]);
    clayOp.concat(meshOp).forEach((op) => e.local(op));
    const bake = you.stroke([{k: 'mbake'}]);
    assert.equal(e.confirmed(bake[0], 1).refused, undefined);
    assert.equal(e.MC.faces.size, 0);
    assert.equal(e.MD.faces.size, 6, 'my pending cube is on display, over the baked mesh');
    assert.ok(meshOf(e.MD).equals(rebuilt(e)));
    // Refused on an empty mesh, with its seq taken.
    const none = await Engine.create(EMPTY);
    const op = me.stroke([{k: 'mbake'}])[0];
    none.local(op);
    assert.deepEqual(none.takeRefusals(), [], 'not looked at until confirmed');
    const r = none.confirmed(op, 1);
    assert.equal(r.ok, true);
    assert.equal(r.refused, 'empty');
    assert.equal(none.seq, 1);
    assert.deepEqual(none.takeRefusals().map((t) => t.reason), ['empty'], 'told when confirmed');
    assert.deepEqual(none.stats().contributions, {});
});

test('a mesh outside the grid cannot be baked: it would vanish, so it stays', async() => {
    const e = await Engine.create(EMPTY);
    const w = writer('ua');
    submitAll(e, w.stroke([{k: 'mprim', sh: 'cube', p: [0.37, 0.37, 0.37], r: 0.02}]));
    const clay = clayOf(e.confirmedGrid);
    const mesh = meshOf(e.MC);
    submitAll(e, w.stroke([{k: 'mbake'}]));
    assert.ok(meshOf(e.MC).equals(mesh));
    assert.ok(clayOf(e.confirmedGrid).equals(clay));
});

test('a preview shows on a copy and never changes the serialized state', async() => {
    const e = await Engine.create({dims: 40, voxel: 0.006, model: 'meshcube'});
    const w = writer('me');
    submit(e, w.op({k: 'msel', sm: 'set', md: 'f', ids: Array.from(e.MD.faces.keys())}));
    const bytes = Buffer.from(await e.serialize(EPOCH));
    const md = meshOf(e.MD);
    const shown = e.polyDisplay;
    assert.equal(shown, e.MD, 'no preview: the display document itself');
    e.takePolyDirty();

    assert.deepEqual(e.setPreview({k: 'minset', a: 'me', r: 0.01, m: 1}), {ok: true});
    assert.equal(e.takePolyDirty(), true);
    assert.ok(e.polyDisplay.faces.size > e.MD.faces.size, 'the inset shows');
    assert.notEqual(e.polyDisplay, e.MD);
    assert.equal(e.polyDisplay, e.polyDisplay, 'worked out once');
    assert.ok(meshOf(e.MD).equals(md), 'MD is untouched');
    assert.equal(e.stats().pending, 0, 'never pending');
    assert.equal(e.MC.rec, null);
    assert.ok(Buffer.from(await e.serialize(EPOCH)).equals(bytes), 'never in the file');

    // A foreign op under the preview: applied again on the new display.
    const foreign = writer('you').stroke([{k: 'mprim', sh: 'cube', p: [0.1, 0, 0], r: 0.01}]);
    const count = e.polyDisplay.faces.size;
    e.confirmed(foreign[0], e.seq + 1);
    assert.equal(e.polyDisplay.faces.size, count + 6);
    assert.equal(e.MD.faces.size, 12);
    assert.equal(e.takePolyDirty(), true);

    // Cleared, it is gone; cleared twice, nothing is new.
    assert.deepEqual(e.setPreview(null), {ok: true});
    assert.equal(e.takePolyDirty(), true);
    assert.equal(e.polyDisplay, e.MD);
    e.setPreview(null);
    assert.equal(e.takePolyDirty(), false);

    // Nothing selected: the document refuses the preview, and the display shows as it is.
    const unselected = await Engine.create({dims: 40, voxel: 0.006, model: 'meshcube'});
    assert.equal(unselected.setPreview({k: 'minset', a: 'me', r: 0.01, m: 1}).ok, true);
    assert.equal(unselected.polyDisplay, unselected.MD);
    assert.deepEqual(unselected.takeRefusals(), [], 'not told: it was only a preview');
});

test('a bad preview is refused and clears the previous one', async() => {
    const e = await Engine.create({dims: 40, voxel: 0.006, model: 'meshcube'});
    const w = writer('me');
    submit(e, w.op({k: 'msel', sm: 'set', md: 'f', ids: Array.from(e.MD.faces.keys())}));
    assert.equal(e.setPreview({k: 'minset', a: 'me', r: 0.01, m: 1}).ok, true);
    assert.notEqual(e.polyDisplay, e.MD);
    assert.deepEqual(e.setPreview({k: 'minset', a: 'me', r: 99}), {ok: false, reason: 'invalid'});
    assert.equal(e.polyDisplay, e.MD);
    assert.deepEqual(e.setPreview({k: 'add', a: 'me', p: [0, 0, 0], r: 0.01, st: 1}), {ok: false, reason: 'invalid'});
    assert.deepEqual(e.setPreview({k: 'mbake', a: 'me'}), {ok: false, reason: 'invalid'});
    assert.deepEqual(e.setPreview({k: 'msel', a: 'me', sm: 'none'}), {ok: false, reason: 'invalid'});
    assert.deepEqual(e.setPreview({k: 'minset', r: 0.01}), {ok: false, reason: 'noauthor'});
});

test('a version 1 snapshot loads with an empty mesh, and the next file is version 2', async() => {
    const made = await Engine.create(OPTS);
    const plain = await writeSnapshot(made.confirmedGrid, 7, EPOCH, {compress: false});
    const count = 40 * 40 * 40;
    const v1 = new Uint8Array(48 + count);
    v1.set(plain.subarray(0, 48), 0);
    v1.set(plain.subarray(52, 52 + count), 48);
    const dv = new DataView(v1.buffer);
    dv.setUint16(4, 1, true);
    dv.setUint32(44, count, true);

    const e = await Engine.create({snapshot: v1});
    assert.equal(e.seq, 7);
    assert.equal(e.epoch, EPOCH);
    assert.ok(clayOf(e.confirmedGrid).equals(clayOf(made.confirmedGrid)));
    assert.equal(e.MC.faces.size, 0);
    assert.equal(e.MC.verts.size, 0);
    assert.equal(e.MD.faces.size, 0);
    assert.equal(e.takePolyDirty(), true, 'an empty mesh is still posted once');
    assert.equal(header(await e.serialize()).version, 2);

    const f = await Engine.create({model: 'meshcube', dims: 40, voxel: 0.006});
    assert.equal(f.MC.faces.size, 6);
    const loaded = await f.load(v1);
    assert.deepEqual(loaded, {seq: 7, epoch: EPOCH});
    assert.equal(f.MC.faces.size, 0, 'load replaces the mesh');
    assert.equal(f.MD.faces.size, 0);
    await assert.rejects(f.load(v1.slice(0, 40)), /snapshotinvalid/);
});

test('a serialized engine carries the mesh and selections and continues byte-identically after loading', async() => {
    const e = await Engine.create(OPTS);
    const ops = authorOps('ua', 1);
    const cut = 12;
    ops.slice(0, cut).forEach((op, n) => e.confirmed(op, n + 1));
    const bytes = await e.serialize(EPOCH);
    const g = await Engine.create({snapshot: bytes});
    assert.equal(g.seq, cut);
    assert.ok(meshOf(g.MC).equals(meshOf(e.MC)));
    assert.ok(meshOf(g.MD).equals(meshOf(e.MC)));
    assert.deepEqual(g.MC.selectionOf('ua'), e.MC.selectionOf('ua'));
    const you = authorOps('ub', -1);
    you.forEach((op, n) => {
        e.confirmed(op, cut + n + 1);
        g.confirmed(op, cut + n + 1);
    });
    assert.ok(Buffer.from(await e.serialize(EPOCH)).equals(Buffer.from(await g.serialize(EPOCH))));
    const r = await readSnapshot(bytes);
    assert.ok(meshOf(r.mesh).equals(meshOf(r.mesh.copy())), 'a copy serializes the same');
});

test('the starting polygon cube: no clay, the same ids on every client, nobody\'s selection', async() => {
    const a = await Engine.create({dims: 40, voxel: 0.006, model: 'meshcube'});
    const b = await Engine.create({dims: 40, voxel: 0.006, model: 'meshcube'});
    assert.equal(a.MC.verts.size, 8);
    assert.equal(a.MC.faces.size, 6);
    assert.ok(meshOf(a.MC).equals(meshOf(b.MC)));
    assert.ok(meshOf(a.MD).equals(meshOf(a.MC)));
    assert.equal(inside(a.confirmedGrid), 0);
    a.MC.verts.forEach((p) => p.forEach((v) => assert.equal(Math.abs(v), 0.08)));
    assert.equal(a.MC.sel.size, 0);
    assert.equal(a.takePolyDirty(), true, 'sent once after init');
    assert.equal(a.takePolyDirty(), false);
    const clay = await Engine.create({dims: 40, voxel: 0.006, model: 'empty'});
    assert.equal(clay.MC.faces.size, 0);
    assert.ok(a.stats().seq === 0 && Object.keys(a.stats().contributions).length === 0);
});

test('contributions count confirmed mesh edits per author, not selections or refused ops', async() => {
    const e = await Engine.create(EMPTY);
    const a = writer('ua');
    const b = writer('ub');
    const first = a.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.02}]);
    e.local(first[0]);
    assert.deepEqual(e.stats().contributions, {}, 'pending ops do not count');
    e.confirmed(first[0], 1);
    e.confirmed(first[1], 2);
    e.confirmed(a.stroke([{k: 'mxf', d: [0.01, 0, 0]}])[0], 3);
    e.confirmed(b.op({k: 'msel', sm: 'all'}), 4);
    e.confirmed(b.stroke([{k: 'mdel'}])[0], 5);
    const c = e.stats().contributions;
    assert.deepEqual(c.ua, {ops: 2, added: 0, removed: 0});
    assert.deepEqual(c.ub, {ops: 1, added: 0, removed: 0});
});

test('mesh ops are deduplicated, and invalid ones refused, as clay ops are', async() => {
    const e = await Engine.create(EMPTY);
    const op = {k: 'mprim', a: 'ua', s: 1, i: 1, sh: 'cube', p: [0, 0, 0], r: 0.02};
    assert.equal(e.confirmed(op, 1).ok, true);
    const once = meshOf(e.MC);
    assert.equal(e.confirmed(op, 2).reason, 'duplicate');
    assert.equal(e.seq, 2);
    assert.ok(meshOf(e.MC).equals(once));
    assert.equal(e.local(op).reason, 'duplicate');
    assert.equal(e.local({k: 'mprim'}).reason, 'invalid');
    assert.equal(e.local({k: 'mprim', s: 2, i: 9, sh: 'cube', p: [0, 0, 0], r: 0.02}).reason, 'noauthor');
    assert.equal(e.confirmed({k: 'mprim', a: 'ua', s: 2, i: 9, sh: 'teapot', p: [0, 0, 0], r: 0.02}, 3).reason, 'invalid');
    assert.equal(e.seq, 3, 'an invalid op still takes its seq');
});

test('promote confirms pending mesh ops in order, a pending bake included', async() => {
    const e = await Engine.create(EMPTY);
    const f = await Engine.create(EMPTY);
    const w = writer('ua');
    const ops = w.stroke([{k: 'mprim', sh: 'cube', p: [0, 0, 0], r: 0.02}, {k: 'mxf', d: [0.01, 0, 0]}])
        .concat(w.stroke([{k: 'mbake'}]));
    ops.forEach((op) => e.local(op));
    assert.equal(e.promote(), ops.length);
    assert.equal(e.stats().pending, 0);
    ops.forEach((op, n) => f.confirmed(op, n + 1));
    assert.ok(Buffer.from(await e.serialize(EPOCH)).equals(Buffer.from(await f.serialize(EPOCH))));
    assert.ok(meshOf(e.MD).equals(meshOf(e.MC)));
    assert.deepEqual(e.stats(), f.stats());
});

test('hz: after a late join, an undo means the same on every client', async() => {
    const early = await Engine.create(OPTS);
    let i = 0;
    const both = [early];
    const send = (op, n) => {
        const clean = Object.assign({a: 'ua', i: ++i}, op);
        both.forEach((e) => assert.ok(e.confirmed(clean, n).ok));
    };
    send({k: 'mprim', s: 1, sh: 'cube', p: [0, 0, 0], r: 0.05}, 1);
    send({k: 'end', s: 1}, 2);
    send({k: 'add', s: 2, p: [0.1, 0, 0], r: 0.02, st: 1}, 3);
    send({k: 'end', s: 2}, 4);
    // The late joiner starts from the state, which holds no undo records, and asks the room to forget its own.
    const late = await Engine.create(OPTS);
    await late.load(await early.serialize(EPOCH));
    both.push(late);
    send({k: 'hz'}, 5);
    send({k: 'undo', t: 1}, 6);
    send({k: 'undo', t: 2}, 7);
    assert.equal(early.polyConfirmed.faces.size, 6, 'the mesh stroke made before the join stays');
    send({k: 'mprim', s: 3, sh: 'cube', p: [0.1, 0, 0], r: 0.02}, 8);
    send({k: 'end', s: 3}, 9);
    send({k: 'undo', t: 3}, 10);
    assert.equal(early.polyConfirmed.faces.size, 6, 'a stroke made after the join undoes');
    assert.deepEqual(clayOf(late.C), clayOf(early.C));
    assert.deepEqual(meshOf(late.polyConfirmed), meshOf(early.polyConfirmed));
});

test('mbake: an open sheet is refused and stays; a closed shape bakes', async() => {
    const e = await Engine.create(EMPTY);
    let i = 0;
    e.confirmed({k: 'mprim', a: 'ua', s: 1, i: ++i, sh: 'plane', p: [0, 0, 0], r: 0.05}, i);
    const refused = e.confirmed({k: 'mbake', a: 'ua', s: 2, i: ++i}, i);
    assert.equal(refused.refused, 'nosolid');
    assert.equal(e.polyConfirmed.faces.size, 1);
    e.confirmed({k: 'mext', a: 'ua', s: 3, i: ++i}, i);
    e.confirmed({k: 'mxf', a: 'ua', s: 3, i: ++i, d: [0, 0.05, 0]}, i);
    e.confirmed({k: 'end', a: 'ua', s: 3, i: ++i}, i);
    const baked = e.confirmed({k: 'mbake', a: 'ua', s: 4, i: ++i}, i);
    assert.equal(baked.refused, undefined);
    assert.equal(e.polyConfirmed.faces.size, 0);
});
