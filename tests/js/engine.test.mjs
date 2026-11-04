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
 * Tests of the sculpting engine (js/engine/engine.js): determinism across interleavings, the
 * rebase rule, promote, undo/redo, contributions, dedupe and dirty chunks.
 *
 * Run from the repository root: node --test tests/js/engine.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../js/engine/engine.js';
import {applyOp, createWork, footprint, cleanOp} from '../../js/engine/ops.js';

/** A small grid keeps the tests fast: 40³ voxels of 6 mm, a 0.10 m sphere. */
const OPTS = {dims: 40, voxel: 0.006, model: 'sphere'};

/**
 * Bytes of a grid's values.
 *
 * @param {object} grid Grid.
 * @returns {Buffer} Its bytes.
 */
const bytesOf = (grid) => Buffer.from(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);

/**
 * A point on the sphere's surface (radius 0.1 m) at an angle around the z axis.
 *
 * @param {number} angle Radians.
 * @param {number} z Height in metres.
 * @returns {number[]} [x, y, z].
 */
const onSurface = (angle, z) => [0.1 * Math.cos(angle), 0.1 * Math.sin(angle), z];

/**
 * The ops one author sends: strokes of every kind with locks, undo and redo.
 *
 * @param {string} author Author id.
 * @param {number} offset Angle offset in radians (small, so both authors' strokes overlap).
 * @returns {object[]} Ops in the author's order.
 */
function authorOps(author, offset) {
    const ops = [];
    let i = 0;
    const push = (o) => ops.push(Object.assign({a: author, i: ++i}, o));
    for (let n = 0; n < 4; n++) {
        push({k: 'add', s: 1, p: onSurface(offset + n * 0.08, 0.01), r: 0.03, st: 0.7});
    }
    push({k: 'end', s: 1});
    push({k: 'lock', p: onSurface(offset + 0.3, 0), r: 0.045});
    for (let n = 0; n < 3; n++) {
        push({k: 'grab', s: 2, p: onSurface(offset + 0.3, 0.004 * n), r: 0.03, st: 1, d: [0.004, 0.002, 0.004]});
    }
    push({k: 'unlock'});
    push({k: 'end', s: 2});
    for (let n = 0; n < 3; n++) {
        push({k: 'carve', s: 3, p: onSurface(offset + 0.15 + n * 0.05, -0.02), r: 0.025, st: 0.9});
    }
    push({k: 'end', s: 3});
    push({k: 'undo', t: 3});
    for (let n = 0; n < 3; n++) {
        push({k: 'smooth', s: 4, p: onSurface(offset + n * 0.1, 0), r: 0.04, st: 1});
    }
    push({k: 'end', s: 4});
    push({k: 'redo', t: 3});
    const axis = onSurface(offset + 0.2, 0);
    for (let n = 0; n < 3; n++) {
        push({k: 'twist', s: 5, p: onSurface(offset + 0.2, 0.01), r: 0.035, st: 1, x: axis, g: 0.3});
    }
    push({k: 'end', s: 5});
    push({k: 'save'});
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
 * D rebuilt from scratch: a copy of C with every pending op applied in order.
 *
 * @param {Engine} engine Engine.
 * @returns {object} The rebuilt grid.
 */
function rebuild(engine) {
    const grid = engine.confirmedGrid.copy();
    const work = createWork();
    engine.pendingOps.forEach((op) => applyOp(grid, cleanOp(op), work));
    return grid;
}

/**
 * Runs one client over a sequence: it applies its own ops locally `lag` positions ahead of their
 * confirmation and checks the rebase invariant D = C ⊕ pending after every confirmation.
 *
 * @param {object[]} sequence Sequenced ops.
 * @param {string|null} author This client's author id (null: a client with no own ops).
 * @param {number} lag How far ahead own ops are applied locally.
 * @returns {Promise<Engine>} The engine after the whole sequence.
 */
async function runClient(sequence, author, lag) {
    const engine = await Engine.create(OPTS);
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
        const r = engine.confirmed(sequence[n], n + 1);
        assert.equal(r.ok, true, 'op ' + n + ' confirmed');
        assert.ok(bytesOf(engine.display).equals(bytesOf(rebuild(engine))), 'D = C ⊕ pending after op ' + n);
    }
    assert.equal(engine.stats().pending, 0);
    return engine;
}

test('clients with different local/confirmed interleavings converge byte-identically', async() => {
    const a = authorOps('ua', 0);
    const b = authorOps('ub', 0.12);
    const sequence = merge(a, b, 2);
    const ea = await runClient(sequence, 'ua', 4);
    const eb = await runClient(sequence, 'ub', 7);
    const ref = await runClient(sequence, null, 0);
    const ea2 = await runClient(sequence, 'ua', 1);
    [ea, eb, ea2].forEach((e) => {
        assert.ok(bytesOf(e.confirmedGrid).equals(bytesOf(ref.confirmedGrid)), 'C identical');
        assert.ok(bytesOf(e.display).equals(bytesOf(ref.display)), 'D identical');
        assert.deepEqual(e.stats(), ref.stats(), 'same seq and contributions');
    });
    assert.ok(bytesOf(ref.display).equals(bytesOf(ref.confirmedGrid)));
    assert.equal(ref.seq, sequence.length);
});

test('a different sequencer order also converges, and differs from the first order', async() => {
    const a = authorOps('ua', 0);
    const b = authorOps('ub', 0.12);
    const s1 = merge(a, b, 2);
    const s2 = merge(b, a, 3);
    const x = await runClient(s2, 'ua', 5);
    const y = await runClient(s2, 'ub', 2);
    assert.ok(bytesOf(x.display).equals(bytesOf(y.display)));
    const z = await runClient(s1, null, 0);
    assert.ok(!bytesOf(x.display).equals(bytesOf(z.display)), 'overlapping strokes do not commute');
});

test('a foreign op confirmed under pending ops rebases the display exactly', async() => {
    const e = await Engine.create(OPTS);
    const own = [
        {k: 'add', a: 'me', s: 1, i: 1, p: onSurface(0, 0), r: 0.04, st: 1},
        {k: 'grab', a: 'me', s: 1, i: 2, p: onSurface(0, 0), r: 0.04, st: 1, d: [0.01, 0, 0]},
        {k: 'add', a: 'me', s: 2, i: 3, p: onSurface(2.5, 0), r: 0.02, st: 1},
    ];
    own.forEach((op) => assert.equal(e.local(op).ok, true));
    const foreign = {k: 'carve', a: 'you', s: 1, i: 1, p: onSurface(0.05, 0), r: 0.05, st: 1};
    assert.equal(e.confirmed(foreign, 1).ok, true);
    assert.ok(bytesOf(e.display).equals(bytesOf(rebuild(e))));
    assert.equal(e.stats().pending, 3);
    // The same result as a client that saw the foreign op first.
    const f = await Engine.create(OPTS);
    f.confirmed(foreign, 1);
    own.forEach((op, n) => f.confirmed(op, n + 2));
    own.forEach((op, n) => e.confirmed(op, n + 2));
    assert.ok(bytesOf(e.display).equals(bytesOf(f.display)));
    assert.ok(bytesOf(e.confirmedGrid).equals(bytesOf(f.confirmedGrid)));
});

test('promote confirms every pending op in order with the next seqs', async() => {
    const e = await Engine.create(OPTS);
    const f = await Engine.create(OPTS);
    const ops = authorOps('ua', 0.5).slice(0, 10);
    e.confirmed({k: 'add', a: 'host', s: 1, i: 1, p: onSurface(1, 0), r: 0.02, st: 1}, 1);
    f.confirmed({k: 'add', a: 'host', s: 1, i: 1, p: onSurface(1, 0), r: 0.02, st: 1}, 1);
    ops.forEach((op) => e.local(op));
    assert.equal(e.stats().pending, ops.length);
    assert.equal(e.promote(), ops.length);
    assert.equal(e.seq, ops.length + 1);
    assert.equal(e.stats().pending, 0);
    ops.forEach((op, n) => f.confirmed(op, n + 2));
    assert.ok(bytesOf(e.display).equals(bytesOf(e.confirmedGrid)));
    assert.ok(bytesOf(e.confirmedGrid).equals(bytesOf(f.confirmedGrid)));
    assert.deepEqual(e.stats(), f.stats());
});

/**
 * Applies an op as a solo client does: locally, then confirmed with the next seq.
 *
 * @param {Engine} e Engine.
 * @param {object} op Op.
 * @returns {void}
 */
function submit(e, op) {
    assert.equal(e.local(op).ok, true);
    assert.equal(e.confirmed(op, e.seq + 1).ok, true);
}

test('undo restores the state before a stroke exactly, redo restores it after', async() => {
    const e = await Engine.create(OPTS);
    const before = Buffer.from(bytesOf(e.confirmedGrid));
    let i = 0;
    for (let n = 0; n < 5; n++) {
        submit(e, {k: 'add', a: 'ua', s: 1, i: ++i, p: onSurface(n * 0.1, 0), r: 0.03, st: 1});
    }
    submit(e, {k: 'end', a: 'ua', s: 1, i: ++i});
    const after = Buffer.from(bytesOf(e.confirmedGrid));
    assert.ok(!after.equals(before));
    submit(e, {k: 'undo', a: 'ua', i: ++i, t: 1});
    assert.ok(bytesOf(e.confirmedGrid).equals(before), 'undo');
    assert.ok(bytesOf(e.display).equals(before), 'undo shows');
    submit(e, {k: 'undo', a: 'ua', i: ++i, t: 1});
    assert.ok(bytesOf(e.confirmedGrid).equals(before), 'a second undo is a no-op');
    submit(e, {k: 'redo', a: 'ua', i: ++i, t: 1});
    assert.ok(bytesOf(e.confirmedGrid).equals(after), 'redo');
    assert.ok(bytesOf(e.display).equals(after), 'redo shows');
    submit(e, {k: 'redo', a: 'ua', i: ++i, t: 1});
    submit(e, {k: 'undo', a: 'ua', i: ++i, t: 99});
    submit(e, {k: 'undo', a: 'ub', i: 1, t: 1});
    assert.ok(bytesOf(e.confirmedGrid).equals(after), 'unknown strokes and other authors cannot undo it');
});

test('undoing one author keeps the other author\'s separate work', async() => {
    const e = await Engine.create(OPTS);
    const addA = {k: 'add', a: 'ua', s: 1, i: 1, p: onSurface(0, 0), r: 0.03, st: 1};
    const addB = {k: 'add', a: 'ub', s: 1, i: 1, p: onSurface(Math.PI, 0), r: 0.03, st: 1};
    submit(e, addA);
    submit(e, {k: 'end', a: 'ua', s: 1, i: 2});
    submit(e, addB);
    submit(e, {k: 'end', a: 'ub', s: 1, i: 2});
    const withBoth = e.confirmedGrid.copy();
    submit(e, {k: 'undo', a: 'ua', i: 3, t: 1});
    const boxB = footprint(cleanOp(addB), e.confirmedGrid);
    const boxA = footprint(cleanOp(addA), e.confirmedGrid);
    let changedInA = 0;
    for (let k = 0; k < 40; k++) {
        for (let j = 0; j < 40; j++) {
            for (let n = 0; n < 40; n++) {
                const inB = n >= boxB.min[0] && n <= boxB.max[0] && j >= boxB.min[1] && j <= boxB.max[1] &&
                    k >= boxB.min[2] && k <= boxB.max[2];
                const inA = n >= boxA.min[0] && n <= boxA.max[0] && j >= boxA.min[1] && j <= boxA.max[1] &&
                    k >= boxA.min[2] && k <= boxA.max[2];
                if (inB) {
                    assert.equal(e.confirmedGrid.get(n, j, k), withBoth.get(n, j, k));
                }
                if (inA && e.confirmedGrid.get(n, j, k) !== withBoth.get(n, j, k)) {
                    changedInA++;
                }
            }
        }
    }
    assert.ok(changedInA > 0);
});

test('contributions count confirmed strokes and the volume added and removed, per author', async() => {
    const e = await Engine.create(OPTS);
    e.local({k: 'add', a: 'ua', s: 1, i: 1, p: onSurface(0, 0), r: 0.03, st: 1});
    assert.deepEqual(e.stats().contributions, {}, 'pending ops do not count');
    e.confirmed({k: 'add', a: 'ua', s: 1, i: 1, p: onSurface(0, 0), r: 0.03, st: 1}, 1);
    e.confirmed({k: 'add', a: 'ua', s: 1, i: 2, p: onSurface(0.2, 0), r: 0.03, st: 1}, 2);
    e.confirmed({k: 'end', a: 'ua', s: 1, i: 3}, 3);
    e.confirmed({k: 'carve', a: 'ub', s: 1, i: 1, p: onSurface(Math.PI, 0), r: 0.03, st: 1}, 4);
    const c = e.stats().contributions;
    assert.equal(c.ua.ops, 1, 'two dabs of one stroke are one edit');
    assert.ok(c.ua.added > 0);
    assert.equal(c.ua.removed, 0);
    assert.equal(c.ub.ops, 1);
    assert.ok(c.ub.removed > 0);
    assert.equal(c.ub.added, 0);
    // Whole voxels of 6 mm: 216 mm³ each.
    assert.ok(Math.abs(c.ua.added / 216 - Math.round(c.ua.added / 216)) < 1e-9);
});

test('duplicates, stale seqs and invalid ops are refused', async() => {
    const e = await Engine.create(OPTS);
    const op = {k: 'add', a: 'ua', s: 1, i: 1, p: onSurface(0, 0), r: 0.03, st: 1};
    assert.equal(e.confirmed(op, 1).ok, true);
    const once = Buffer.from(bytesOf(e.confirmedGrid));
    assert.equal(e.confirmed(op, 2).reason, 'duplicate');
    assert.equal(e.seq, 2);
    assert.ok(bytesOf(e.confirmedGrid).equals(once));
    assert.equal(e.confirmed(Object.assign({}, op, {i: 5}), 2).reason, 'stale');
    assert.equal(e.local(op).reason, 'duplicate');
    assert.equal(e.local({k: 'add'}).reason, 'invalid');
    assert.equal(e.local({k: 'add', s: 1, i: 9, p: [0, 0, 0], r: 0.02, st: 1}).reason, 'noauthor');
    assert.equal(e.confirmed({k: 'nonsense'}, 3).reason, 'invalid');
    assert.equal(e.seq, 3, 'an invalid op still takes its seq');
    assert.equal(e.local(Object.assign({}, op, {i: 4})).ok, true);
    assert.equal(e.local(Object.assign({}, op, {i: 4})).reason, 'duplicate');
});

test('a lost pending op is dropped when a later op of its author is confirmed', async() => {
    const e = await Engine.create(OPTS);
    const lost = {k: 'add', a: 'ua', s: 1, i: 1, p: onSurface(0, 0), r: 0.03, st: 1};
    const kept = {k: 'add', a: 'ua', s: 1, i: 2, p: onSurface(1, 0), r: 0.03, st: 1};
    e.local(lost);
    e.local(kept);
    e.confirmed(kept, 1);
    assert.equal(e.stats().pending, 0);
    const f = await Engine.create(OPTS);
    f.confirmed(kept, 1);
    assert.ok(bytesOf(e.display).equals(bytesOf(f.display)));
});

test('a serialized engine continues bit-identically after loading', async() => {
    const e = await Engine.create(OPTS);
    const ops = authorOps('ua', 0);
    ops.slice(0, 12).forEach((op, n) => e.confirmed(op, n + 1));
    const bytes = await e.serialize('0123456789abcdef');
    assert.equal(e.epoch, '0123456789abcdef');
    const g = await Engine.create({snapshot: bytes});
    assert.equal(g.seq, 12);
    assert.equal(g.epoch, '0123456789abcdef');
    assert.ok(bytesOf(g.confirmedGrid).equals(bytesOf(e.confirmedGrid)));
    const other = authorOps('ub', 0.1);
    other.forEach((op, n) => {
        e.confirmed(op, n + 13);
        g.confirmed(op, n + 13);
    });
    assert.ok(bytesOf(g.display).equals(bytesOf(e.display)));
    const h = await Engine.create(OPTS);
    const loaded = await h.load(bytes);
    assert.deepEqual(loaded, {seq: 12, epoch: '0123456789abcdef'});
    assert.equal(h.stats().pending, 0);
});

test('new engines get a random epoch, start at seq 0 and mark every chunk dirty', async() => {
    const e = await Engine.create(OPTS);
    const f = await Engine.create(OPTS);
    assert.match(e.epoch, /^[0-9a-f]{16}$/);
    assert.notEqual(e.epoch, f.epoch);
    assert.equal(e.seq, 0);
    assert.equal(e.takeDirtyChunks().length, 27);
    assert.equal(e.takeDirtyChunks().length, 0);
    e.local({k: 'add', a: 'ua', s: 1, i: 1, p: [0.1, 0, 0], r: 0.01, st: 1});
    const dirty = e.takeDirtyChunks();
    assert.ok(dirty.length > 0 && dirty.length < 27);
    dirty.forEach((c) => assert.ok(c[0] >= 1, 'only chunks near +x'));
    // Confirming one's own oldest pending op changes nothing visible.
    e.confirmed({k: 'add', a: 'ua', s: 1, i: 1, p: [0.1, 0, 0], r: 0.01, st: 1}, 1);
    assert.equal(e.takeDirtyChunks().length, 0);
    await assert.rejects(Engine.create({model: 'teapot', dims: 16}));
    await assert.rejects(Engine.create({dims: 4}));
});

test('the default engine is the 128³, 4 mm lump of the build contract', async() => {
    const e = await Engine.create();
    const g = e.display;
    assert.equal(g.nx, 128);
    assert.equal(g.voxel, 0.004);
    assert.equal(g.band, 0.012);
    assert.ok(g.get(64, 64, 64) < 0, 'the centre is inside');
    assert.equal(g.get(0, 0, 0), g.levels[254], 'corners are outside (+band)');
    assert.equal(e.takeDirtyChunks().length, 512);
});

test('undoing and redoing a stroke is not counted as new work', async() => {
    const e = await Engine.create(OPTS);
    e.confirmed({k: 'add', a: 'ua', s: 1, i: 1, p: onSurface(0, 0), r: 0.03, st: 1}, 1);
    e.confirmed({k: 'end', a: 'ua', s: 1, i: 2}, 2);
    const before = Object.assign({}, e.stats().contributions.ua);
    assert.ok(before.added > 0);
    e.confirmed({k: 'undo', a: 'ua', i: 3, t: 1}, 3);
    e.confirmed({k: 'redo', a: 'ua', i: 4, t: 1}, 4);
    assert.deepEqual(e.stats().contributions.ua, before);
});
