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
 * Tests of the AI-free question matching (mod_vrmakerspace/tutormatch): normalising and stemming, phrase and demo
 * scores, the method preference, and real questions against the word lists built from the English language file
 * (mod_vrmakerspace/tutorialsteps demoWords()).
 *
 * Run from the repository root: node --test tests/js/tutormatch.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {match, nearlySame, normalise, phraseScore, prepare, rank, splitList, stem, words, THRESHOLD}
    from '../../amd/src/tutormatch.js';
import {DEMO_NAMES, DEMO_NAME_KEYS, STEP_KEYS, demoWords, demoWordsKey, stepsFor} from '../../amd/src/tutorialsteps.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The plugin's English strings, read from the language file.
 *
 * @returns {Object<string, string>}
 */
const englishStrings = () => {
    const source = readFileSync(join(here, '..', '..', 'lang', 'en', 'vrmakerspace.php'), 'utf8');
    const strings = {};
    const pattern = /\$string\['([^']+)'\]\s*=\s*'((?:[^'\\]|\\.)*)';/g;
    let found;
    while ((found = pattern.exec(source)) !== null) {
        strings[found[1]] = found[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    return strings;
};

const STRINGS = englishStrings();
const ALL_STEPS = stepsFor(STEP_KEYS);
const LIST = demoWords(ALL_STEPS, STRINGS);
const SCULPT = LIST.filter((entry) => entry.method === 'sculpt').map((entry) => entry.demo);
const MODEL = LIST.filter((entry) => entry.method === 'model').map((entry) => entry.demo);

/**
 * The demo a question goes to, with the studio in a method.
 *
 * @param {string} question
 * @param {string} method 'sculpt' or 'model'
 * @param {Object[]} [list]
 * @returns {string|null}
 */
const demoFor = (question, method, list = LIST) => {
    const hit = match(question, list, {prefer: method === 'model' ? MODEL : SCULPT});
    return hit ? hit.demo : null;
};

test('normalise lowers case and takes away accents and punctuation', () => {
    assert.equal(normalise('  How do I SMOOTH it?! '), 'how do i smooth it');
    assert.equal(normalise('Glätten, bitte'), 'glatten bitte');
    assert.equal(normalise("what's this"), 'whats this');
    assert.equal(normalise(null), '');
});

test('stem brings word forms together', () => {
    assert.equal(stem('smoothing'), stem('smooth'));
    assert.equal(stem('carving'), stem('carve'));
    assert.equal(stem('carved'), stem('carve'));
    assert.equal(stem('shapes'), stem('shape'));
    assert.equal(stem('cutting'), stem('cut'));
    assert.equal(stem('grabbing'), stem('grab'));
    assert.equal(stem('extruding'), stem('extrude'));
    assert.equal(stem('pulling'), stem('pull'));
    assert.equal(stem('adding'), 'add');
    assert.equal(stem('add'), 'add');
    assert.equal(stem('press'), 'press');
});

test('words drops filler and keeps the meaningful stems', () => {
    assert.deepEqual(words('So how do I add a shape?'), ['add', 'shap']);
    assert.deepEqual(words(''), []);
});

test('splitList takes commas, semicolons and other scripts\' commas', () => {
    assert.deepEqual(splitList('a, b ;c،d、e，f,,'), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('nearlySame allows one letter off', () => {
    assert.ok(nearlySame('extrud', 'extrod'));
    assert.ok(nearlySame('bevel', 'bevell'));
    assert.ok(nearlySame('smooth', 'smoth'));
    assert.ok(!nearlySame('smooth', 'smash'));
});

test('a phrase scores by its length, in order scores more, part of a phrase a little', () => {
    const asked = words('how do I make a loop cut here');
    assert.equal(phraseScore(['loop', 'cut'], asked).score, 3.5);
    assert.equal(phraseScore(['cut', 'loop'], asked).score, 3);
    assert.equal(phraseScore(['loop', 'edg'], asked).score, 0.5);
    assert.equal(phraseScore(['cut'], asked).score, 2);
    assert.equal(phraseScore(['bevel'], asked).score, 0);
});

test('prepare accepts an object and drops repeated phrases', () => {
    const prepared = prepare({smooth: ['Smooth', 'smoothing', 'blend'], add: {step: 'add', phrases: 'add, build up'}});
    assert.deepEqual(prepared[0], {demo: 'smooth', step: 'smooth', phrases: [['smooth'], ['blend']]});
    assert.deepEqual(prepared[1].phrases, [['add'], ['build']]);
});

test('no match below the threshold, and none for an empty question', () => {
    assert.equal(match('', LIST), null);
    assert.equal(match('what is the weather like', LIST), null);
    assert.equal(rank('how do I', LIST).length, 0);
    assert.ok(THRESHOLD > 0);
});

test('every demonstration has a word list in the English strings, and its own name finds it', () => {
    assert.equal(DEMO_NAMES.length, 20);
    DEMO_NAMES.forEach((name) => {
        assert.ok(STRINGS[demoWordsKey(name)], `missing ${demoWordsKey(name)}`);
        (DEMO_NAME_KEYS[name] || []).forEach((key) => assert.ok(STRINGS[key], `missing ${key}`));
        const step = ALL_STEPS.find((s) => s.demo === name);
        assert.equal(demoFor(`how do I use ${STRINGS[DEMO_NAME_KEYS[name][0]]}?`, step.method), name, name);
    });
});

test('student questions find the right demonstration', () => {
    const cases = [
        ['So how do I do smoothing?', 'sculpt', 'smooth'],
        ['How can I make the surface less bumpy and blend it', 'sculpt', 'smooth'],
        ['how do I dig a hollow into the clay', 'sculpt', 'carve'],
        ['how do i build up more clay', 'sculpt', 'add'],
        ['How do I cut a hole in it?', 'sculpt', 'cutshape'],
        ['how do I put letters on it', 'sculpt', 'shape'],
        ['how do I add a cube', 'sculpt', 'shape'],
        ['how do I add a cube', 'model', 'addshape'],
        ['make both sides the same', 'sculpt', 'mirror'],
        ['how do I pull a face out', 'model', 'extrude'],
        ['how do I round the edges', 'model', 'bevel'],
        ['how do I add an edge loop', 'model', 'loopcut'],
        ['how do I make it bigger', 'model', 'scale'],
        ['how do I turn it around', 'model', 'rotate'],
        ['how do I twist the clay', 'sculpt', 'twist'],
        ['how do I move this part', 'model', 'move'],
        ['can you show me how to pinch a sharp crease', 'sculpt', 'pinch'],
        ['how do I make it puff up', 'sculpt', 'inflate'],
        ['how do I flatten the bottom', 'sculpt', 'flatten'],
        ['how do I pick a face', 'model', 'select'],
        ['how do I extude this', 'model', 'extrude'],
    ];
    cases.forEach(([question, method, demo]) => {
        assert.equal(demoFor(question, method), demo, question);
    });
});

test('only the tour\'s own demonstrations can match', () => {
    const sculptonly = demoWords(ALL_STEPS.filter((step) => step.applies !== 'M'), STRINGS);
    assert.equal(demoFor('how do I add a cube', 'sculpt', sculptonly), 'shape');
    assert.equal(demoFor('how do I extrude a face', 'sculpt', sculptonly), null);
});

test('the step of a match is the demonstration\'s step', () => {
    assert.deepEqual(match('smooth', LIST), {demo: 'smooth', step: 'smooth'});
});
