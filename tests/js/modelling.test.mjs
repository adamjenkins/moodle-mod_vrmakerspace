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
 * Tests of the modelling tools: inflate, pinch, flatten, shapes and letters, and mirroring.
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOp, cleanOp, createWork, footprint, mirrorOp} from '../../js/engine/ops.js';
import {Engine} from '../../js/engine/engine.js';
import {Grid} from '../../js/engine/grid.js';
import {fillModel} from '../../js/engine/models.js';
import {CHARACTERS, isText, textSegments} from '../../js/engine/font.js';
import {SHAPES, prepare} from '../../js/engine/shapes.js';
import {meshManifold} from '../../js/engine/tetmesh.js';
import {check} from '../../js/engine/validate.js';

/** A 64³ grid of 6 mm voxels (band 18 mm) with a start model. */
const grid = (model) => fillModel(new Grid(64, 64, 64, 0.006, 0.018), model);

/** Voxels inside the clay. */
const inside = (g) => g.data.reduce((n, v) => n + (v < 0 ? 1 : 0), 0);

/** Volume inside the clay in m³. */
const volume = (g) => inside(g) * g.voxel * g.voxel * g.voxel;

/** Applies ops (cleaned) to a grid. */
const apply = (g, ...ops) => {
    const work = createWork();
    ops.forEach((op) => {
        const c = cleanOp(op);
        assert.ok(c, 'valid: ' + JSON.stringify(op));
        applyOp(g, c, work);
    });
    return g;
};

const OP = {a: 'u1', s: 1, i: 1, st: 0.5};

test('new keys are kept in wire order: m, sh, tx after the others', () => {
    const op = cleanOp({tx: 'HI', sh: 'text', m: 1, g: 0, x: [0, 0, 1], st: 0.5, r: 0.02, p: [0, 0, 0], i: 2, s: 1,
        a: 'u', k: 'shape'});
    assert.equal(JSON.stringify(op),
        '{"k":"shape","a":"u","s":1,"i":2,"p":[0,0,0],"r":0.02,"st":0.5,"x":[0,0,1],"g":0,"m":1,"sh":"text","tx":"HI"}');
    const flat = cleanOp({k: 'flatten', a: 'u', s: 1, i: 3, p: [0, 0, 0], r: 0.02, st: 1, x: [0, 2, 0], g: 0.0123456});
    assert.equal(flat.g, 0.01235, 'the plane offset is rounded to 1e-5');
});

test('malformed modelling ops are refused', () => {
    const shape = {k: 'shape', a: 'u', s: 1, i: 1, p: [0, 0, 0], r: 0.02, st: 0.5, x: [0, 1, 0], g: 0, sh: 'cube'};
    const bad = [
        Object.assign({}, shape, {sh: 'teapot'}),
        Object.assign({}, shape, {sh: undefined}),
        Object.assign({}, shape, {x: undefined}),
        Object.assign({}, shape, {g: 3.2}),
        Object.assign({}, shape, {sh: 'text'}),
        Object.assign({}, shape, {sh: 'text', tx: 'lower'}),
        Object.assign({}, shape, {sh: 'text', tx: '   '}),
        Object.assign({}, shape, {sh: 'text', tx: 'ABCDEFGHIJKLMNOPQ'}),
        Object.assign({}, shape, {sh: 'text', tx: 'ABCDEFGHIJKLMNOP', r: 0.08}),
        Object.assign({}, shape, {m: 0}),
        Object.assign({}, shape, {m: true}),
        {k: 'flatten', a: 'u', s: 1, i: 1, p: [0, 0, 0], r: 0.02, st: 1, x: [0, 1, 0], g: 1.5},
        {k: 'flatten', a: 'u', s: 1, i: 1, p: [0, 0, 0], r: 0.02, st: 1},
        {k: 'save', a: 'u', i: 1, m: 1},
    ];
    bad.forEach((op, n) => {
        const c = cleanOp(op);
        // m is dropped (not refused) on a kind that is not a stroke.
        if (op.k === 'save') {
            assert.equal(JSON.stringify(c), '{"k":"save","a":"u","i":1}');
        } else {
            assert.equal(c, null, 'case ' + n);
        }
    });
    assert.ok(cleanOp(Object.assign({}, shape, {sh: 'text', tx: 'HELLO 2026!'})));
});

test('every character of the font has strokes inside its glyph box, and isText checks the text', () => {
    for (const c of CHARACTERS) {
        if (c === ' ') {
            continue;
        }
        const {segments} = textSegments(c);
        assert.ok(segments.length >= 4, c);
        for (let n = 0; n < segments.length; n += 2) {
            assert.ok(segments[n] >= -2 && segments[n] <= 2 && segments[n + 1] >= -3 && segments[n + 1] <= 3, c);
        }
    }
    assert.equal(isText('MOODLE 5.2'), true);
    assert.equal(isText('Moodle'), false);
    assert.equal(isText(''), false);
});

test('each shape on empty space has about the volume of the shape', () => {
    const r = 0.06;
    const expected = {
        sphere: 4 / 3 * Math.PI * r ** 3,
        cube: 8 * r ** 3,
        cylinder: Math.PI * (0.6 * r) ** 2 * 2 * r,
        cone: Math.PI * (0.75 * r) ** 2 * 2 * r / 3,
        torus: 2 * Math.PI ** 2 * 0.7 * r * (0.3 * r) ** 2,
    };
    for (const sh of SHAPES.filter((name) => name !== 'text')) {
        const g = apply(grid('empty'), Object.assign({k: 'shape', p: [0, 0, 0], r, x: [0, 1, 0], g: 0, sh}, OP, {st: 0}));
        const ratio = volume(g) / expected[sh];
        assert.ok(ratio > 0.85 && ratio < 1.15, sh + ' volume ratio ' + ratio.toFixed(3));
    }
    assert.equal(inside(grid('empty')), 0, 'the empty start model has no clay');
});

test('the shape distance functions are exact enough on the surface', () => {
    const r = 0.05;
    assert.ok(Math.abs(prepare('sphere', r)(r, 0, 0)) < 1e-12);
    assert.ok(Math.abs(prepare('cube', r)(r, 0, 0)) < 1e-12);
    assert.ok(Math.abs(prepare('cylinder', r)(0.6 * r, 0, 0)) < 1e-12);
    assert.ok(Math.abs(prepare('cone', r)(0, r, 0)) < 1e-12, 'the tip');
    assert.ok(Math.abs(prepare('torus', r)(r, 0, 0)) < 1e-12);
    assert.ok(prepare('cone', r)(0, 0, 0) < 0 && prepare('cone', r)(0, 1.2 * r, 0) > 0);
});

test('a turned cube is turned: its corner reaches where the turn puts it', () => {
    // A quarter turn about z leaves a cube the same; an eighth turn puts an edge on the x axis.
    const r = 0.05;
    const straight = apply(grid('empty'), Object.assign({k: 'shape', p: [0, 0, 0], r, x: [0, 0, 1], g: 0, sh: 'cube'},
        OP, {st: 0}));
    const turned = apply(grid('empty'), Object.assign({k: 'shape', p: [0, 0, 0], r, x: [0, 0, 1], g: 0.7854,
        sh: 'cube'}, OP, {st: 0}));
    const at = (g, x) => g.sample(x, 0, 0);
    assert.ok(at(straight, 0.062) > 0, 'straight: outside past the face');
    assert.ok(at(turned, 0.062) < 0, 'turned: the edge reaches out to r √2');
});

test('letters write clay that exports closed, and a cut shape takes it away', async() => {
    const engine = await Engine.create({dims: 64, voxel: 0.006, model: 'empty'});
    const op = {k: 'shape', a: 'u1', s: 1, i: 1, p: [0, 0, 0], r: 0.03, st: 0.2, x: [0, 1, 0], g: 0, sh: 'text',
        tx: 'HI'};
    assert.ok(engine.confirmed(op, 1).ok);
    const report = check(meshManifold(engine.display));
    assert.ok(report.triangles > 500, 'triangles ' + report.triangles);
    assert.equal(report.watertight, true);
    // H (two bars) and I are separate pieces: three lumps of clay along x near the top.
    const g = engine.display;
    const row = [];
    for (let i = 0; i < g.nx; i++) {
        row.push(g.get(i, Math.round(g.cy + 0.02 / g.voxel), Math.round(g.cz)) < 0 ? 1 : 0);
    }
    const pieces = row.join('').split(/0+/).filter((x) => x).length;
    assert.ok(pieces >= 3, 'pieces along the top of the letters: ' + row.join(''));
    assert.ok(engine.confirmed({k: 'end', a: 'u1', s: 1, i: 2}, 2).ok);
    const cut = {k: 'cutshape', a: 'u1', s: 3, i: 3, p: [0, 0, 0], r: 0.08, st: 0, x: [0, 1, 0], g: 0, sh: 'cube'};
    assert.ok(engine.confirmed(cut, 3).ok);
    assert.equal(inside(engine.display), 0, 'a big cut cube removes all of it');
});

test('undo of a shape restores the grid exactly', async() => {
    const engine = await Engine.create({dims: 48, voxel: 0.006, model: 'lump'});
    const before = engine.display.data.slice();
    engine.confirmed({k: 'shape', a: 'u1', s: 1, i: 1, p: [0.08, 0.02, 0], r: 0.04, st: 0.5, x: [1, 0, 0], g: 1,
        sh: 'torus', m: 1}, 1);
    engine.confirmed({k: 'end', a: 'u1', s: 1, i: 2}, 2);
    assert.notDeepEqual(engine.display.data, before);
    engine.confirmed({k: 'undo', a: 'u1', i: 3, t: 1}, 3);
    assert.deepEqual(engine.display.data, before);
});

test('mirrored ops leave a symmetric sculpture symmetric', () => {
    const ops = [
        {k: 'add', p: [0.07, 0.03, 0.01], r: 0.03, st: 0.8},
        {k: 'carve', p: [0.05, -0.05, 0.06], r: 0.02, st: 1},
        {k: 'grab', p: [0.08, 0.05, 0], r: 0.03, st: 1, d: [0.01, 0.006, -0.004]},
        {k: 'twist', p: [0.06, 0.06, 0.02], r: 0.04, st: 1, x: [0.3, 1, 0.2], g: 0.4},
        {k: 'inflate', p: [0.09, 0, 0.03], r: 0.03, st: 1},
        {k: 'pinch', p: [0.08, -0.02, 0], r: 0.03, st: 1},
        {k: 'flatten', p: [0.1, 0, 0], r: 0.04, st: 1, x: [1, 0.2, 0], g: 0.09},
        {k: 'smooth', p: [0.1, 0.01, 0], r: 0.03, st: 1},
        {k: 'shape', p: [0.06, 0.07, 0.02], r: 0.025, st: 0.4, x: [0.2, 0.5, 1], g: 0.9, sh: 'cone'},
        {k: 'cutshape', p: [0.09, 0.02, 0.04], r: 0.02, st: 0.4, x: [1, 0, 1], g: -0.6, sh: 'cube'},
    ];
    const g = grid('sphere');
    let i = 0;
    ops.forEach((op) => apply(g, Object.assign({a: 'u1', s: 1, i: ++i, m: 1}, op)));
    // The grid's x = 0 plane lies between voxel columns 31 and 32: voxel i mirrors to 63 − i.
    let differ = 0;
    for (let k = 0; k < g.nz; k++) {
        for (let j = 0; j < g.ny; j++) {
            for (let n = 0; n < g.nx; n++) {
                if (g.get(n, j, k) !== g.get(g.nx - 1 - n, j, k)) {
                    differ++;
                }
            }
        }
    }
    // Trilinear reads may round the last bit differently on the two sides; a handful of voxels at most.
    assert.ok(differ <= g.nx * 2, differ + ' voxels differ from their mirror image');
    assert.ok(inside(g) !== inside(grid('sphere')), 'the ops changed the sculpture');
});

test('mirrorOp mirrors points, plane normals and turning axes', () => {
    const twist = mirrorOp(cleanOp({k: 'twist', a: 'u', s: 1, i: 1, p: [0.1, 0.2, 0.3], r: 0.02, st: 1, x: [1, 2, 3],
        g: 0.2, m: 1}));
    assert.deepEqual([twist.p, twist.x, twist.g, twist.m], [[-0.1, 0.2, 0.3], [1, -2, -3], 0.2, undefined]);
    const flat = mirrorOp(cleanOp({k: 'flatten', a: 'u', s: 1, i: 1, p: [0.1, 0, 0], r: 0.02, st: 1, x: [1, 2, 3],
        g: 0.2}));
    assert.deepEqual(flat.x, [-1, 2, 3]);
    const grab = mirrorOp(cleanOp({k: 'grab', a: 'u', s: 1, i: 1, p: [0.1, 0, 0], r: 0.02, st: 1, d: [0.01, 0, 0]}));
    assert.deepEqual(grab.d, [-0.01, 0, 0]);
    const op = cleanOp({k: 'add', a: 'u', s: 1, i: 1, p: [0.1, 0, 0], r: 0.02, st: 1, m: 1});
    const box = footprint(op);
    assert.ok(box.min[0] < 63.5 - 0.1 / 0.004 && box.max[0] > 63.5 + 0.1 / 0.004, 'the footprint holds both sides');
});

test('inflate grows, pinch keeps the volume roughly, flatten cuts a bump to its plane', () => {
    const ref = inside(grid('sphere'));
    const inflated = apply(grid('sphere'), Object.assign({k: 'inflate', p: [0.1, 0, 0], r: 0.04}, OP, {st: 1}));
    assert.ok(inside(inflated) > ref);
    const pinched = apply(grid('sphere'), Object.assign({k: 'pinch', p: [0.1, 0, 0], r: 0.04}, OP, {st: 1}));
    assert.ok(Math.abs(inside(pinched) - ref) / ref < 0.05);
    assert.notDeepEqual(pinched.data, grid('sphere').data);
    // Flatten the sphere's side at x = 0.08: no clay is left beyond the plane near the brush centre.
    const flat = apply(grid('sphere'), ...Array.from({length: 6}, (v, n) => Object.assign({k: 'flatten', p: [0.1, 0, 0],
        r: 0.05, x: [1, 0, 0], g: 0.08}, OP, {i: n + 1, st: 1})));
    assert.ok(flat.sample(0.092, 0, 0) > 0, 'beyond the plane: outside');
    assert.ok(flat.sample(0.07, 0, 0) < 0, 'before the plane: still clay');
});
