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
 * The steps of the studio's guided tour (TUTORIAL-CONTRACT.md §3), as data: key, chapter, the ways of making a step
 * applies to, its kind, the tutor's demonstration, what it points at, the method the studio is put in for it, and,
 * for an action step, the condition that ends it.
 *
 * A condition takes the studio state (studio.js state()) at the step's start, the state now and a memo object kept
 * for the step, and says whether the student has done the thing. The server (classes/local/tutorial.php) holds the
 * same keys in the same order and decides which apply; this list only says how each one runs.
 *
 * It also lists the strings the tour, the tutor and its voice load, and builds the word lists that
 * mod_vrmakerspace/tutormatch matches a question against (demoWords()).
 *
 * No Moodle or three.js imports, so it can be tested in Node.
 *
 * @module     mod_vrmakerspace/tutorialsteps
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Total turn of the view that ends the orbit step (rad). */
export const ORBIT_TURN = 0.5;

/** Change of the camera's distance that ends the zoom step (fraction of the distance at the start). */
export const ZOOM_CHANGE = 0.2;

/** Movement of the view's centre that ends the pan step (m). */
export const PAN_MOVE = 0.03;

/**
 * How many ops of a kind the student had sent in a state.
 *
 * @param {Object} state Studio state.
 * @param {string} kind Op kind (or stroke tool name).
 * @returns {number}
 */
export const opCount = (state, kind) => {
    const ops = state && state.ops ? state.ops : {};
    return Number(ops[kind]) || 0;
};

/**
 * A condition: at least one new op (or stroke) of a kind since the step began.
 *
 * @param {string} kind Op kind or stroke tool name.
 * @returns {Function} (start, now) => boolean
 */
const newOp = (kind) => (start, now) => opCount(now, kind) > opCount(start, kind);

/**
 * A condition: a value of the state changed since the step began.
 *
 * @param {string} name Property of the state.
 * @returns {Function} (start, now) => boolean
 */
const changed = (name) => (start, now) => now[name] !== start[name];

/**
 * A condition: a counter of the state rose since the step began.
 *
 * @param {string} name Property of the state.
 * @returns {Function} (start, now) => boolean
 */
const rose = (name) => (start, now) => (Number(now[name]) || 0) > (Number(start[name]) || 0);

/**
 * The smallest difference between two angles (rad).
 *
 * @param {number} a Angle.
 * @param {number} b Angle.
 * @returns {number} In [-π, π].
 */
export const angleDelta = (a, b) => {
    let d = (Number(a) || 0) - (Number(b) || 0);
    while (d > Math.PI) {
        d -= 2 * Math.PI;
    }
    while (d < -Math.PI) {
        d += 2 * Math.PI;
    }
    return d;
};

/**
 * Remember the camera of the previous check in the memo and return it.
 *
 * @param {Object} memo The step's memo.
 * @param {Object} start Studio state at the step's start.
 * @param {Object} now Studio state now.
 * @returns {Object} The camera of the previous check.
 */
const previousCamera = (memo, start, now) => {
    const before = memo.camera || start.camera || now.camera;
    memo.camera = now.camera;
    return before;
};

/**
 * Orbit: the view turned by ORBIT_TURN in total (both ways count).
 *
 * @param {Object} start Studio state at the step's start.
 * @param {Object} now Studio state now.
 * @param {Object} memo The step's memo.
 * @returns {boolean}
 */
export const orbited = (start, now, memo) => {
    if (!now.camera) {
        return false;
    }
    const before = previousCamera(memo, start, now);
    memo.turn = (memo.turn || 0) + Math.abs(angleDelta(now.camera.azimuth, before.azimuth))
        + Math.abs((Number(now.camera.polar) || 0) - (Number(before.polar) || 0));
    return memo.turn >= ORBIT_TURN;
};

/**
 * Zoom: the camera came nearer or went further by ZOOM_CHANGE of where it began.
 *
 * @param {Object} start Studio state at the step's start.
 * @param {Object} now Studio state now.
 * @returns {boolean}
 */
export const zoomed = (start, now) => {
    if (!now.camera || !start.camera) {
        return false;
    }
    const from = Number(start.camera.distance) || 0;
    const to = Number(now.camera.distance) || 0;
    return from > 0 && Math.abs(to - from) / from >= ZOOM_CHANGE;
};

/**
 * Pan: the centre of the view moved by PAN_MOVE in total.
 *
 * @param {Object} start Studio state at the step's start.
 * @param {Object} now Studio state now.
 * @param {Object} memo The step's memo.
 * @returns {boolean}
 */
export const panned = (start, now, memo) => {
    if (!now.camera || !Array.isArray(now.camera.target)) {
        return false;
    }
    const before = previousCamera(memo, start, now);
    const a = Array.isArray(before.target) ? before.target : now.camera.target;
    const b = now.camera.target;
    memo.moved = (memo.moved || 0) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return memo.moved >= PAN_MOVE;
};

/**
 * A condition: a setting was turned on (or away from its start), and after that one more op of a kind was sent.
 *
 * @param {Function} isOn Takes a state, says whether the setting is on.
 * @param {string} kind Op kind counted after it.
 * @returns {Function} (start, now, memo) => boolean
 */
const onThen = (isOn, kind) => (start, now, memo) => {
    if (memo.countAt === undefined) {
        if (!isOn(now)) {
            return false;
        }
        memo.countAt = opCount(now, kind);
        return false;
    }
    return opCount(now, kind) > memo.countAt;
};

/**
 * Mirror: mirroring turned on, then a mirrored stroke.
 *
 * @param {Object} start Studio state at the step's start.
 * @param {Object} now Studio state now.
 * @returns {boolean}
 */
export const mirrored = (start, now) => !!now.mirror && opCount(now, 'mirrored') > opCount(start, 'mirrored');

/**
 * Select: the selection grew from the smallest it was during the step.
 *
 * @param {Object} start Studio state at the step's start.
 * @param {Object} now Studio state now.
 * @param {Object} memo The step's memo.
 * @returns {boolean}
 */
export const selected = (start, now, memo) => {
    const count = Number(now.selectionCount) || 0;
    if (memo.least === undefined) {
        memo.least = Math.min(count, Number(start.selectionCount) || 0);
    }
    memo.least = Math.min(memo.least, count);
    return count > memo.least;
};

/**
 * A selector of a toolbar button by its data-action (and one more data attribute).
 *
 * @param {string} action data-action.
 * @param {string} [attribute] Name of the other data attribute, e.g. 'tool'.
 * @param {string} [value] Its value.
 * @returns {Object} Target {selector}
 */
const button = (action, attribute, value) => ({
    selector: attribute ? `[data-action="${action}"][data-${attribute}="${value}"]` : `[data-action="${action}"]`,
});

/**
 * A sculpting step with a stroke of a tool.
 *
 * @param {string} key Step key, the same as the tool name.
 * @param {boolean} [piece] Whether the tutor points at the piece too.
 * @returns {Object} The step.
 */
const sculptTool = (key, piece) => ({
    key: key, chapter: 'sculpt', applies: 'S', kind: 'action', demo: key, method: 'sculpt',
    target: Object.assign({piece: !!piece}, button('tool', 'tool', key)), done: newOp(key),
});

/**
 * A modelling step that ends with an op of a kind.
 *
 * @param {string} key Step key, the same as the model action.
 * @param {string} kind Op kind it waits for.
 * @param {boolean} demo Whether the tutor can show it.
 * @param {Object} target What it points at.
 * @returns {Object} The step.
 */
const modelStep = (key, kind, demo, target) => ({
    key: key, chapter: 'model', applies: 'M', kind: 'action', demo: demo ? key : '', method: 'model', target: target,
    done: newOp(kind),
});

/**
 * Every step, in the order of the tour.
 *
 * Fields: key, chapter (start, view, sculpt, model, finish), applies ('*', 'S', 'M', 'SM', 'VR'), kind ('info' or
 * 'action'), demo (the tutor's demonstration, '' for none), method (the method the studio is put in, or ''), desktop
 * (passed over in VR), target ({tutor} | {canvas} | {selector, closest, piece} | {}), done (action steps).
 *
 * @type {Object[]}
 */
export const STEPS = Object.freeze([
    {key: 'welcome', chapter: 'start', applies: '*', kind: 'info', demo: '', method: '', target: {tutor: true}},
    {key: 'orbit', chapter: 'view', applies: '*', kind: 'action', demo: '', method: '', desktop: true,
        target: {canvas: true}, done: orbited},
    {key: 'zoom', chapter: 'view', applies: '*', kind: 'action', demo: '', method: '', desktop: true,
        target: {canvas: true}, done: zoomed},
    {key: 'pan', chapter: 'view', applies: '*', kind: 'action', demo: '', method: '', desktop: true,
        target: {canvas: true}, done: panned},
    sculptTool('add', true),
    sculptTool('carve'),
    sculptTool('smooth'),
    {key: 'size', chapter: 'sculpt', applies: 'S', kind: 'action', demo: '', method: 'sculpt',
        target: {selector: '[data-region="size"]', closest: '.mod_vrmakerspace-slider'}, done: changed('size')},
    {key: 'strength', chapter: 'sculpt', applies: 'S', kind: 'action', demo: '', method: 'sculpt',
        target: {selector: '[data-region="strength"]', closest: '.mod_vrmakerspace-slider'}, done: changed('strength')},
    sculptTool('inflate'),
    sculptTool('pinch'),
    sculptTool('flatten'),
    sculptTool('grab'),
    sculptTool('twist'),
    {key: 'mirror', chapter: 'sculpt', applies: 'S', kind: 'action', demo: 'mirror', method: 'sculpt',
        target: button('mirror'), done: mirrored},
    sculptTool('shape'),
    sculptTool('cutshape'),
    {key: 'undo', chapter: 'sculpt', applies: 'S', kind: 'action', demo: '', method: 'sculpt', target: button('undo'),
        done: rose('undos')},
    {key: 'redo', chapter: 'sculpt', applies: 'S', kind: 'action', demo: '', method: 'sculpt', target: button('redo'),
        done: rose('redos')},
    {key: 'switchmodel', chapter: 'model', applies: 'SM', kind: 'action', demo: '', method: 'sculpt',
        target: {selector: '[data-region="methodswitch"]'}, done: (start, now) => now.method === 'model'},
    modelStep('addshape', 'mprim', true, {selector: '[data-region="addshapemenu"]'}),
    {key: 'selectmode', chapter: 'model', applies: 'M', kind: 'action', demo: '', method: 'model',
        target: {selector: '[data-region="selectmodes"]'}, done: changed('selectMode')},
    {key: 'select', chapter: 'model', applies: 'M', kind: 'action', demo: 'select', method: 'model',
        target: {piece: true}, done: selected},
    modelStep('move', 'mxf_move', true, button('modelaction', 'tool', 'move')),
    {key: 'axis', chapter: 'model', applies: 'M', kind: 'action', demo: '', method: 'model',
        target: {selector: '[data-region="axislock"]'}, done: onThen((state) => !!state.axis && state.axis !== 'free', 'mxf')},
    modelStep('rotate', 'mxf_rotate', true, button('modelaction', 'tool', 'rotate')),
    modelStep('scale', 'mxf_scale', true, button('modelaction', 'tool', 'scale')),
    modelStep('extrude', 'mext', true, button('modelaction', 'tool', 'extrude')),
    modelStep('inset', 'minset', true, button('modelaction', 'tool', 'inset')),
    modelStep('bevel', 'mbevel', true, button('modelaction', 'tool', 'bevel')),
    modelStep('loopcut', 'mloop', true, button('modelaction', 'tool', 'loopcut')),
    modelStep('merge', 'mmerge', false, button('oneshot', 'oneshot', 'merge')),
    modelStep('delete', 'mdel', false, button('oneshot', 'oneshot', 'delete')),
    {key: 'bake', chapter: 'model', applies: 'SM', kind: 'action', demo: '', method: 'model',
        target: button('oneshot', 'oneshot', 'bake'), done: newOp('mbake')},
    {key: 'save', chapter: 'finish', applies: '*', kind: 'action', demo: '', method: '', desktop: true,
        target: button('save'), done: rose('saves')},
    {key: 'versions', chapter: 'finish', applies: '*', kind: 'info', demo: '', method: '', target: {}},
    {key: 'export', chapter: 'finish', applies: '*', kind: 'action', demo: '', method: '', desktop: true,
        target: {selector: '[data-region="exportmenu"]'}, done: rose('exports')},
    {key: 'vr', chapter: 'finish', applies: 'VR', kind: 'info', demo: '', method: '', target: button('vr')},
    {key: 'together', chapter: 'finish', applies: '*', kind: 'info', demo: '', method: '', target: {}},
    {key: 'done', chapter: 'finish', applies: '*', kind: 'info', demo: '', method: '', target: {tutor: true}},
]);

/** Every step key, in order. */
export const STEP_KEYS = Object.freeze(STEPS.map((step) => step.key));

/** The tour's own strings (besides the step titles and texts). */
export const UI_STRING_KEYS = Object.freeze(['tutorial_next', 'tutorial_back', 'tutorial_skip', 'tutorial_finish',
    'tutorial_close', 'tutorial_showme', 'tutorial_stepof', 'tutorial_done', 'tutorial_button', 'tutorial_ask',
    'tutorial_askplaceholder', 'tutorial_thinking', 'tutorial_askfailed', 'tutorial_saved', 'tutorial_reopen',
    'tutorial_showmefailed']);

/** The tutor's strings (mod_vrmakerspace/tutor). */
export const TUTOR_STRING_KEYS = Object.freeze(['tutor_name', 'tutor_demofailed', 'tutor_demonomesh', 'tutor_watch']);

/** The strings of talking to the tutor and asking it (mod_vrmakerspace/tutorial, mod_vrmakerspace/tutorvoice). */
export const VOICE_STRING_KEYS = Object.freeze(['tutorvoice_talk', 'tutorvoice_talkhint', 'tutorvoice_stop',
    'tutorvoice_listening', 'tutorvoice_listeningvr', 'tutorvoice_heard', 'tutorvoice_nothingheard',
    'tutorvoice_nothingheardvr', 'tutorvoice_micdenied',
    'tutorvoice_listenfailed', 'tutorvoice_nolisten', 'tutorvoice_consentvr', 'tutorvoice_speechconsent',
    'tutorvoice_speechconsent_title', 'tutorvoice_speechconsent_accept', 'tutorvoice_canshow', 'tutorvoice_demos',
    'tutorvoice_nowyoutry', 'tutorvoice_readaloud', 'tutorvoice_showdemo', 'error_tutorpolicy']);

/** The demonstrations the tutor can give, in the order of the tour (each has a step of the same key). */
export const DEMO_NAMES = Object.freeze(STEPS.filter((step) => !!step.demo).map((step) => step.demo));

/**
 * The names the student sees in the studio for each demonstration's tool or action (lang string keys), matched
 * against a question together with tutor_demo_<name>_words.
 *
 * @type {Object<string, string[]>}
 */
export const DEMO_NAME_KEYS = Object.freeze({
    add: ['tool_add'],
    carve: ['tool_carve'],
    smooth: ['tool_smooth'],
    inflate: ['tool_inflate'],
    pinch: ['tool_pinch'],
    flatten: ['tool_flatten'],
    grab: ['tool_grab'],
    twist: ['tool_twist'],
    mirror: ['mirror'],
    shape: ['tool_shape'],
    cutshape: ['tool_cutshape'],
    addshape: ['addshape', 'mshape_cube', 'mshape_plane', 'mshape_cylinder', 'mshape_sphere', 'mshape_cone',
        'mshape_torus'],
    select: ['action_select'],
    move: ['action_move'],
    rotate: ['action_rotate'],
    scale: ['action_scale'],
    extrude: ['action_extrude'],
    inset: ['action_inset'],
    bevel: ['action_bevel'],
    loopcut: ['action_loopcut'],
});

/**
 * The lang string key of a demonstration's word list.
 *
 * @param {string} name Demo name.
 * @returns {string}
 */
export const demoWordsKey = (name) => `tutor_demo_${name}_words`;

/**
 * The keys of the names and word lists of every demonstration.
 *
 * @returns {string[]}
 */
const demoStringKeys = () => {
    const keys = [];
    DEMO_NAMES.forEach((name) => {
        (DEMO_NAME_KEYS[name] || []).forEach((key) => {
            if (keys.indexOf(key) < 0) {
                keys.push(key);
            }
        });
        keys.push(demoWordsKey(name));
    });
    return keys;
};

/**
 * Every string key the tour and the tutor use.
 *
 * @returns {string[]}
 */
export const stringKeys = () => {
    const keys = [];
    STEP_KEYS.forEach((key) => {
        keys.push(`tutorial_step_${key}_title`, `tutorial_step_${key}_text`);
    });
    return keys.concat(UI_STRING_KEYS, TUTOR_STRING_KEYS, VOICE_STRING_KEYS, demoStringKeys());
};

/**
 * The word lists for mod_vrmakerspace/tutormatch: for each demonstration whose step is in the tour, its visible
 * names and its synonyms, from the strings.
 *
 * @param {Object[]} steps The tour's steps (stepsFor()).
 * @param {Object} strings Strings by key.
 * @returns {Object[]} [{demo, step, method, phrases: string[]}]
 */
export const demoWords = (steps, strings) => {
    /**
     * A string's text, or '' when it is missing.
     *
     * @param {string} key String key.
     * @returns {string}
     */
    const text = (key) => {
        const value = strings && strings[key] ? String(strings[key]) : '';
        // A string missing from the language pack comes back as [[key]].
        return value.indexOf('[[') === 0 ? '' : value;
    };
    return (Array.isArray(steps) ? steps : []).filter((step) => !!step.demo).map((step) => {
        const phrases = (DEMO_NAME_KEYS[step.demo] || []).map(text).filter((name) => name !== '');
        text(demoWordsKey(step.demo)).split(/[,;،、，]+/u).forEach((word) => {
            if (word.trim() !== '') {
                phrases.push(word.trim());
            }
        });
        return {demo: step.demo, step: step.key, method: step.method, phrases: phrases};
    });
};

/**
 * The steps of an activity's tour, in order: the ones the server listed (unknown keys are dropped).
 *
 * @param {string[]} keys config.tutorial.steps.
 * @returns {Object[]}
 */
export const stepsFor = (keys) => {
    const wanted = new Set(Array.isArray(keys) ? keys.map(String) : []);
    return STEPS.filter((step) => wanted.has(step.key));
};
