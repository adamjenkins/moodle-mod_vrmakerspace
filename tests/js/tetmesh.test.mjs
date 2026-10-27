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
 * Tests of the export mesher (marching tetrahedra): closed and manifold whatever was sculpted.
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../js/engine/engine.js';
import {meshManifold} from '../../js/engine/tetmesh.js';
import {check} from '../../js/engine/validate.js';

/**
 * A small deterministic random number generator (LCG), giving numbers in [0, 1).
 *
 * @param {number} seed The seed.
 * @returns {Function} The generator.
 */
const random = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
};

/**
 * Sculpt a starting model with random strokes of every kind, including thin carved slots.
 *
 * @param {string} model The starting model.
 * @param {number} seed The random seed.
 * @param {number} count The number of strokes.
 * @returns {Promise<Engine>} The engine.
 */
const sculpt = async(model, seed, count) => {
    const engine = await Engine.create({dims: 64, voxel: 0.008, model, snapshot: null});
    const rand = random(seed);
    const r5 = (v) => Math.round(v * 1e5) / 1e5;
    const kinds = ['add', 'carve', 'smooth', 'grab', 'twist'];
    let i = 0;
    for (let s = 1; s <= count; s++) {
        const k = kinds[Math.floor(rand() * kinds.length)];
        const p = [r5((rand() - 0.5) * 0.25), r5((rand() - 0.5) * 0.25), r5((rand() - 0.5) * 0.25)];
        const r = r5(0.01 + rand() * 0.05);
        const op = {k, a: 'u1', s, i: ++i, p, r, st: Math.round(rand() * 1000) / 1000};
        if (k === 'grab') {
            op.d = [r5((rand() - 0.5) * r), r5((rand() - 0.5) * r), r5((rand() - 0.5) * r)];
        } else if (k === 'twist') {
            op.x = [0, 1, 0];
            op.g = Math.round((rand() - 0.5) * 0.9 * 1e4) / 1e4;
        }
        engine.confirmed(op, i);
        engine.confirmed({k: 'end', a: 'u1', s, i: ++i}, i);
    }
    return engine;
};

for (const [model, seed] of [['lump', 1], ['sphere', 7], ['cube', 42], ['lump', 2026]]) {
    test(`export mesh of a sculpted ${model} (seed ${seed}) is watertight and manifold`, async() => {
        const engine = await sculpt(model, seed, 120);
        const mesh = meshManifold(engine.display);
        const report = check(mesh);
        assert.ok(report.triangles > 1000, 'triangles: ' + report.triangles);
        assert.equal(report.boundaryedges, 0, 'open edges');
        assert.equal(report.nonmanifoldedges, 0, 'edges shared by more than two faces');
        assert.equal(report.watertight, true);
        assert.ok(report.volumemm3 > 0, 'outward winding gives a positive volume: ' + report.volumemm3);
    });
}

test('a sphere exports with the volume of a sphere', async() => {
    const engine = await Engine.create({dims: 64, voxel: 0.008, model: 'sphere', snapshot: null});
    const report = check(meshManifold(engine.display));
    const expected = 4 / 3 * Math.PI * 100 * 100 * 100;
    assert.ok(Math.abs(report.volumemm3 - expected) / expected < 0.05, 'volume ' + report.volumemm3);
    assert.equal(report.watertight, true);
});
