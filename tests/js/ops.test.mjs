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
 * Tests of the sculpting op format, footprints and field updates (js/engine/ops.js) and of the
 * deterministic maths they use (js/engine/mathx.js).
 *
 * Run from the repository root: node --test tests/js/ops.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KINDS, applyOp, cleanOp, createWork, footprint, isStrokeKind, READ_MARGIN} from '../../js/engine/ops.js';
import {MESH_EDIT_KINDS, MESH_KINDS, cleanMeshOp} from '../../js/engine/polyops.js';
import {Grid} from '../../js/engine/grid.js';
import {fillModel} from '../../js/engine/models.js';
import {sin, cos, R3, R4, R5} from '../../js/engine/mathx.js';

/** A small sphere grid: 40³ voxels of 6 mm (band 18 mm), sphere radius 0.10 m. */
const makeGrid = () => fillModel(new Grid(40, 40, 40, 0.006, 0.018), 'sphere');

const BASE = {a: 'u12', s: 3, i: 17, p: [0.1, 0, 0], r: 0.03, st: 0.8};

/** One valid op of every field-changing kind, centred on the sphere's surface. */
const STROKES = [
    Object.assign({k: 'add'}, BASE),
    Object.assign({k: 'carve'}, BASE),
    Object.assign({k: 'smooth'}, BASE, {st: 1}),
    Object.assign({k: 'grab'}, BASE, {d: [0.012, 0.004, 0]}),
    Object.assign({k: 'twist'}, BASE, {x: [1, 0, 0], g: 0.5, p: [0.09, 0.02, 0.02]}),
    Object.assign({k: 'inflate'}, BASE),
    Object.assign({k: 'pinch'}, BASE, {st: 1}),
    Object.assign({k: 'flatten'}, BASE, {x: [1, 0, 0], g: 0.09}),
    Object.assign({k: 'shape'}, BASE, {x: [0, 1, 0], g: 0.3, sh: 'cube'}),
    Object.assign({k: 'cutshape'}, BASE, {x: [0, 0, 1], g: -1.2, sh: 'cone'}),
    Object.assign({k: 'shape'}, BASE, {r: 0.015, x: [0, 0, 1], g: 0, sh: 'text', tx: 'AB'}),
    Object.assign({k: 'add'}, BASE, {p: [0.06, 0.06, 0], m: 1}),
    Object.assign({k: 'grab'}, BASE, {p: [0.07, 0.07, 0], d: [0.01, 0, 0.004], m: 1}),
    Object.assign({k: 'twist'}, BASE, {x: [1, 1, 0], g: 0.4, p: [0.07, 0.07, 0], m: 1}),
];

test('the polynomial sine and cosine match Math.sin/Math.cos closely', () => {
    for (let x = -20; x <= 20; x += 0.0137) {
        assert.ok(Math.abs(sin(x) - Math.sin(x)) < 1e-10, 'sin ' + x);
        assert.ok(Math.abs(cos(x) - Math.cos(x)) < 1e-10, 'cos ' + x);
    }
});

test('rounding helpers round and never return -0', () => {
    assert.equal(R5(0.123456789), 0.12346);
    assert.equal(R4(-0.123456), -0.1235);
    assert.equal(R3(0.9996), 1);
    assert.ok(Object.is(R5(-0.000001), 0));
});

test('cleanOp keeps only the keys of each kind, in wire order', () => {
    const add = cleanOp({st: 0.5, r: 0.02, p: [0, 0, 0], i: 2, s: 1, a: 'u2', k: 'add', extra: 1, d: [0, 0, 0]});
    assert.equal(JSON.stringify(add), '{"k":"add","a":"u2","s":1,"i":2,"p":[0,0,0],"r":0.02,"st":0.5}');
    const grab = cleanOp({k: 'grab', a: 'u2', s: 1, i: 3, p: [0, 0, 0], r: 0.02, st: 1, d: [0.01, 0, 0]});
    assert.equal(JSON.stringify(grab), '{"k":"grab","a":"u2","s":1,"i":3,"p":[0,0,0],"r":0.02,"st":1,"d":[0.01,0,0]}');
    const twist = cleanOp({k: 'twist', a: 'u2', s: 1, i: 4, p: [0, 0, 0], r: 0.02, st: 1, x: [0, 1, 0], g: 0.1});
    assert.equal(JSON.stringify(twist),
        '{"k":"twist","a":"u2","s":1,"i":4,"p":[0,0,0],"r":0.02,"st":1,"x":[0,1,0],"g":0.1}');
    assert.equal(JSON.stringify(cleanOp({k: 'end', a: 'x', s: 5, i: 9, p: [0, 0, 0]})), '{"k":"end","a":"x","s":5,"i":9}');
    assert.equal(JSON.stringify(cleanOp({k: 'undo', a: 'x', i: 10, t: 5, s: 2})), '{"k":"undo","a":"x","i":10,"t":5}');
    assert.equal(JSON.stringify(cleanOp({k: 'redo', i: 11, t: 5})), '{"k":"redo","i":11,"t":5}');
    assert.equal(JSON.stringify(cleanOp({k: 'lock', a: 'x', i: 12, p: [0, 0.1, 0], r: 0.15})),
        '{"k":"lock","a":"x","i":12,"p":[0,0.1,0],"r":0.15}');
    assert.equal(JSON.stringify(cleanOp({k: 'unlock', a: 'x', i: 13})), '{"k":"unlock","a":"x","i":13}');
    assert.equal(JSON.stringify(cleanOp({k: 'save', a: 'x', i: 14})), '{"k":"save","a":"x","i":14}');
    assert.equal(JSON.stringify(cleanOp({k: 'hz', a: 'x', i: 15, s: 3})), '{"k":"hz","a":"x","i":15}');
});

test('cleanOp rounds (R5 positions, R3 strength, R4 twist) and is idempotent', () => {
    const op = cleanOp({k: 'twist', a: 'u1', s: 1, i: 1, p: [0.0123456, -0.1000049, 0.3999999], r: 0.0234567,
        st: 0.12345, x: [0.123456, 0, -1.000049], g: -0.123456});
    assert.deepEqual(op.p, [0.01235, -0.1, 0.4]);
    assert.equal(op.r, 0.02346);
    assert.equal(op.st, 0.123);
    assert.deepEqual(op.x, [0.1235, 0, -1]);
    assert.equal(op.g, -0.1235);
    assert.deepEqual(cleanOp(op), op);
    assert.equal(JSON.stringify(cleanOp(cleanOp(op))), JSON.stringify(op));
    STROKES.forEach((s) => assert.deepEqual(cleanOp(cleanOp(s)), cleanOp(s)));
});

test('cleanOp rejects anything out of range or malformed', () => {
    const bad = [
        null, 7, 'add', [], {}, {k: 'paint', a: 'u', s: 1, i: 1},
        Object.assign({}, STROKES[0], {a: 'bad author!'}),
        Object.assign({}, STROKES[0], {a: ''}),
        Object.assign({}, STROKES[0], {a: 'x'.repeat(41)}),
        Object.assign({}, STROKES[0], {s: undefined}),
        Object.assign({}, STROKES[0], {s: 0}),
        Object.assign({}, STROKES[0], {i: 1.5}),
        Object.assign({}, STROKES[0], {i: 2147483648}),
        Object.assign({}, STROKES[0], {i: '3'}),
        Object.assign({}, STROKES[0], {p: [0, 0]}),
        Object.assign({}, STROKES[0], {p: [0.41, 0, 0]}),
        Object.assign({}, STROKES[0], {p: [0, NaN, 0]}),
        Object.assign({}, STROKES[0], {p: [0, '0', 0]}),
        Object.assign({}, STROKES[0], {r: 0.0039}),
        Object.assign({}, STROKES[0], {r: 0.081}),
        Object.assign({}, STROKES[0], {st: 1.01}),
        Object.assign({}, STROKES[0], {st: -0.01}),
        Object.assign({}, STROKES[0], {st: undefined}),
        Object.assign({}, STROKES[3], {d: [0.03, 0.001, 0]}),
        Object.assign({}, STROKES[3], {d: undefined}),
        Object.assign({}, STROKES[4], {x: [0, 0, 0]}),
        Object.assign({}, STROKES[4], {x: [0.00001, 0, 0]}),
        Object.assign({}, STROKES[4], {g: 0.51}),
        Object.assign({}, STROKES[4], {g: Infinity}),
        {k: 'undo', a: 'u', i: 2},
        {k: 'undo', a: 'u', i: 2, t: 0},
        {k: 'lock', a: 'u', i: 2, p: [0, 0, 0], r: 0.21},
        {k: 'end', a: 'u', i: 2},
    ];
    bad.forEach((op, n) => assert.equal(cleanOp(op), null, 'case ' + n));
    // A lock may be larger than a brush.
    assert.ok(cleanOp({k: 'lock', a: 'u', i: 2, p: [0, 0, 0], r: 0.2}));
    // |d| = r exactly is allowed.
    assert.ok(cleanOp(Object.assign({}, STROKES[3], {d: [0.03, 0, 0]})));
});

test('footprints contain the brush, stay inside the interior and skip non-stroke ops', () => {
    const grid = makeGrid();
    STROKES.forEach((s) => {
        const op = cleanOp(s);
        const box = footprint(op, grid);
        assert.ok(box, op.k);
        const c = [op.p[0] / grid.voxel + grid.cx, op.p[1] / grid.voxel + grid.cy, op.p[2] / grid.voxel + grid.cz];
        for (let a = 0; a < 3; a++) {
            assert.ok(box.min[a] >= 2 && box.max[a] <= 37, op.k + ' inside the interior');
            const reachv = Math.min(c[a] - 2, op.r / grid.voxel);
            assert.ok(box.min[a] <= c[a] - reachv && box.max[a] >= c[a] + Math.min(37 - c[a], op.r / grid.voxel),
                op.k + ' covers the brush');
        }
    });
    // Default grid of the build contract: 128³, 4 mm.
    const box = footprint(cleanOp({k: 'add', a: 'u', s: 1, i: 1, p: [0, 0, 0], r: 0.04, st: 1}));
    assert.ok(box.min[0] >= 2 && box.max[0] <= 125);
    assert.ok(box.min[0] <= 63.5 - 10 && box.max[0] >= 63.5 + 10);
    // Entirely outside the grid: nothing to write.
    assert.equal(footprint(cleanOp({k: 'add', a: 'u', s: 1, i: 1, p: [0.39, 0.39, 0.39], r: 0.01, st: 1}), grid), null);
    ['end', 'undo', 'redo', 'lock', 'unlock', 'save'].forEach((k) => {
        assert.equal(footprint(cleanOp({k, a: 'u', s: 1, i: 1, t: 1, p: [0, 0, 0], r: 0.05})), null, k);
    });
});

test('each kind changes the field only inside its footprint, and keeps values within the band', () => {
    STROKES.forEach((s) => {
        const grid = makeGrid();
        const before = grid.data.slice();
        const op = cleanOp(s);
        const box = footprint(op, grid);
        const written = applyOp(grid, op, createWork());
        assert.deepEqual(written, box, op.k + ' returns its footprint');
        let inside = 0;
        for (let k = 0; k < grid.nz; k++) {
            for (let j = 0; j < grid.ny; j++) {
                for (let i = 0; i < grid.nx; i++) {
                    const idx = grid.index(i, j, k);
                    const v = grid.data[idx];
                    assert.ok(v >= -grid.band && v <= grid.band);
                    const inBox = i >= box.min[0] && i <= box.max[0] && j >= box.min[1] && j <= box.max[1] &&
                        k >= box.min[2] && k <= box.max[2];
                    if (v !== before[idx]) {
                        assert.ok(inBox, op.k + ' changed voxel ' + [i, j, k] + ' outside its footprint');
                        inside++;
                    }
                }
            }
        }
        assert.ok(inside > 0, op.k + ' changed something');
    });
});

test('an op near the grid edge never writes the outer 2 voxels', () => {
    const grid = new Grid(24, 24, 24, 0.006, 0.018);
    fillModel(grid, 'cube');
    const work = createWork();
    const edge = 11.5 * 0.006;
    applyOp(grid, cleanOp({k: 'add', a: 'u', s: 1, i: 1, p: [edge, 0, 0], r: 0.03, st: 1}), work);
    applyOp(grid, cleanOp({k: 'grab', a: 'u', s: 1, i: 2, p: [edge, 0, 0], r: 0.03, st: 1, d: [0.02, 0, 0]}), work);
    for (let k = 0; k < 24; k++) {
        for (let j = 0; j < 24; j++) {
            for (let i = 0; i < 24; i++) {
                if (i < 2 || j < 2 || k < 2 || i > 21 || j > 21 || k > 21) {
                    assert.equal(grid.get(i, j, k), grid.levels[254]);
                }
            }
        }
    }
});

test('ops read only inside footprint ± 2 voxels', () => {
    STROKES.forEach((s) => {
        const op = cleanOp(s);
        const a = makeGrid();
        const b = makeGrid();
        const box = footprint(op, a);
        // Scramble b outside footprint ± READ_MARGIN; the result inside the footprint must not change.
        for (let k = 0; k < b.nz; k++) {
            for (let j = 0; j < b.ny; j++) {
                for (let i = 0; i < b.nx; i++) {
                    const near = i >= box.min[0] - READ_MARGIN && i <= box.max[0] + READ_MARGIN &&
                        j >= box.min[1] - READ_MARGIN && j <= box.max[1] + READ_MARGIN &&
                        k >= box.min[2] - READ_MARGIN && k <= box.max[2] + READ_MARGIN;
                    if (!near) {
                        b.data[b.index(i, j, k)] = b.levels[(i * 7 + j * 3 + k) % 255];
                    }
                }
            }
        }
        applyOp(a, op, createWork());
        applyOp(b, op, createWork());
        for (let k = box.min[2]; k <= box.max[2]; k++) {
            for (let j = box.min[1]; j <= box.max[1]; j++) {
                for (let i = box.min[0]; i <= box.max[0]; i++) {
                    assert.equal(a.get(i, j, k), b.get(i, j, k), op.k);
                }
            }
        }
    });
});

test('add grows and carve shrinks the sculpture', () => {
    const inside = (g) => g.data.reduce((n, v) => n + (v < 0 ? 1 : 0), 0);
    const ref = inside(makeGrid());
    const g1 = makeGrid();
    applyOp(g1, cleanOp(STROKES[0]), createWork());
    assert.ok(inside(g1) > ref);
    const g2 = makeGrid();
    applyOp(g2, cleanOp(STROKES[1]), createWork());
    assert.ok(inside(g2) < ref);
    const g3 = makeGrid();
    applyOp(g3, cleanOp(Object.assign({}, STROKES[0], {st: 0})), createWork());
    assert.deepEqual(g3.data, makeGrid().data, 'strength 0 changes nothing');
});

test('the mesh kinds share the op stream: cleanOp hands them over, and they have no footprint', () => {
    MESH_KINDS.forEach((k) => {
        assert.ok(KINDS.includes(k), k + ' is a kind');
        assert.equal(isStrokeKind(k), false, k + ' does not touch the field');
    });
    assert.equal(MESH_KINDS.length, 13);
    assert.deepEqual(KINDS.filter((k) => k[0] === 'm').sort(), Array.from(MESH_KINDS).sort(), 'the two lists agree');
    assert.equal(MESH_EDIT_KINDS.length, 12);
    assert.equal(MESH_EDIT_KINDS.includes('msel'), false);
    const samples = [
        {k: 'msel', a: 'u1', i: 1, sm: 'all'},
        {k: 'msel', a: 'u1', i: 2, md: 'v', sm: 'set', ids: [1, 2, 3]},
        {k: 'mprim', a: 'u1', s: 1, i: 3, p: [0.012344, 0, 0], r: 0.05, sh: 'cube'},
        {k: 'mxf', a: 'u1', s: 2, i: 4, d: [0.01, 0, 0]},
        {k: 'mext', a: 'u1', s: 3, i: 5},
        {k: 'minset', a: 'u1', s: 4, i: 6, r: 0.01},
        {k: 'mdel', a: 'u1', s: 5, i: 7},
        {k: 'mbake', a: 'u1', s: 6, i: 8},
    ];
    samples.forEach((op) => {
        const clean = cleanOp(op);
        assert.ok(clean, op.k);
        assert.deepEqual(clean, cleanMeshOp(op), op.k + ' is cleaned by polyops');
        assert.deepEqual(cleanOp(clean), clean, op.k + ' idempotent');
        assert.equal(footprint(clean), null, op.k + ' has no footprint');
        const grid = makeGrid();
        const before = grid.data.slice();
        assert.equal(applyOp(grid, clean, createWork()), null, op.k + ' writes no voxel');
        assert.deepEqual(grid.data, before);
    });
    assert.equal(cleanOp({k: 'mprim', a: 'u1', s: 1, i: 1, p: [0, 0, 0], r: 0.05, sh: 'teapot'}), null);
    assert.equal(cleanOp({k: 'mext', a: 'bad author!', s: 1, i: 1}), null);
    assert.equal(cleanOp({k: 'mext', a: 'u1', i: 1}), null, 'an edit needs its stroke');
    assert.equal(cleanOp({k: 'mfake', a: 'u1', s: 1, i: 1}), null);
});

test('a mesh op may be longer than a clay op, up to 1000 bytes', () => {
    const ids = [];
    while (JSON.stringify(ids).length < 800) {
        ids.push(1000000 + ids.length);
    }
    assert.ok(cleanOp({k: 'msel', a: 'u1', i: 1, md: 'v', sm: 'add', ids}));
    while (JSON.stringify(ids).length < 1100) {
        ids.push(1000000 + ids.length);
    }
    assert.equal(cleanOp({k: 'msel', a: 'u1', i: 1, md: 'v', sm: 'add', ids}), null);
});
