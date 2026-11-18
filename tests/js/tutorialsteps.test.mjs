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
 * Tests of the tour's order and its offers of the other way of making (mod_vrmakerspace/tutorialsteps stepsFor(),
 * offerAt(), offersIn()), with the orders classes/local/tutorial.php applicable_steps() gives.
 *
 * Run from the repository root: node --test tests/js/tutorialsteps.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STEP_KEYS, STEPS, offerAt, offersIn, stepsFor} from '../../amd/src/tutorialsteps.js';

const keysOf = (steps) => steps.map((step) => step.key);
const chapterKeys = (chapter) => STEPS.filter((step) => step.chapter === chapter && step.applies !== 'SM')
    .map((step) => step.key);

/** Both ways, starting with clay: the contract's order. */
const CLAY_FIRST = STEP_KEYS.slice();

/** Both ways, starting with a mesh: as tutorial::applicable_steps('both', true). */
const MODEL_FIRST = [].concat(['welcome', 'orbit', 'zoom', 'pan'], chapterKeys('model'), ['bake'],
    chapterKeys('sculpt'), ['save', 'versions', 'export', 'vr', 'together', 'done']);

test('the tour keeps the server\'s order and drops unknown and repeated keys', () => {
    assert.deepEqual(keysOf(stepsFor(MODEL_FIRST)), MODEL_FIRST);
    assert.deepEqual(keysOf(stepsFor(['zoom', 'teapot', 'welcome', 'zoom'])), ['zoom', 'welcome']);
    assert.deepEqual(stepsFor(null), []);
});

test('starting with clay, the switch to modelling offers the modelling steps, and Turn into clay offers nothing', () => {
    const steps = stepsFor(CLAY_FIRST);
    const offers = offersIn(steps);
    assert.equal(offers.length, 1);
    const offer = offers[0];
    assert.equal(offer.key, 'switchmodel');
    assert.equal(offer.chapter, 'model');
    assert.equal(steps[offer.from].key, 'addshape');
    assert.equal(steps[offer.to - 1].key, 'bake');
    assert.equal(steps[offer.to].key, 'save');
    assert.equal(offerAt(steps, keysOf(steps).indexOf('bake')), null);
});

test('starting with a mesh, Turn into clay offers the sculpting steps', () => {
    const steps = stepsFor(MODEL_FIRST);
    const offers = offersIn(steps);
    assert.equal(offers.length, 1);
    const offer = offers[0];
    assert.equal(offer.key, 'bake');
    assert.equal(offer.chapter, 'sculpt');
    assert.equal(steps[offer.from].key, 'add');
    assert.equal(steps[offer.to - 1].key, 'redo');
    assert.equal(steps[offer.to].key, 'save');
});

test('one way of making has no offers', () => {
    assert.deepEqual(offersIn(stepsFor(STEP_KEYS.filter((key) => !['switchmodel', 'bake'].includes(key)
        && !chapterKeys('model').includes(key)))), []);
    assert.deepEqual(offersIn(stepsFor(STEP_KEYS.filter((key) => !['switchmodel', 'bake'].includes(key)
        && !chapterKeys('sculpt').includes(key)))), []);
});
