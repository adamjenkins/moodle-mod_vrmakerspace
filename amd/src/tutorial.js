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
 * The guided tour of the studio in tutorial mode (TUTORIAL-CONTRACT.md §3 and §4): a bubble like a user tour's
 * (templates/tutorial_bubble.mustache) that goes through the steps of mod_vrmakerspace/tutorialsteps, marks the
 * control a step is about with a ring, has the tutor point at the piece or show the step (Show me), waits for the
 * student to do what an action step asks, and saves the progress (steps done and skipped, the last step) through
 * mod_vrmakerspace_save_tutorial_progress.
 *
 * The student can ask the tutor how to do something (TUTORIAL-VOICE-CONTRACT.md §6 and §7), typed or spoken: with
 * the tutor (AI) on, through mod_vrmakerspace_ask_tutor (after accepting the site's AI policy), whose answer can
 * name a demonstration; with it off, mod_vrmakerspace/tutormatch finds the demonstration in the browser from the
 * names of the tools and their synonyms, and the tutor answers with that step's text ("I can show you these" when
 * nothing matches). Either way the tutor then shows it on the practice piece, starting when its voice starts. Push to
 * talk: holding the Talk button (or Space in the bubble, or the VR talk button, through talk()) records, letting go sends;
 * a short tap listens until the student pauses. The voice (mod_vrmakerspace/tutorvoice) comes from where the tutor
 * is, its mouth follows it, and with Read aloud on the tutor also reads each step (say()).
 *
 * The bubble is not modal: the studio keeps working, its keyboard shortcuts included, and the bubble's own key
 * (Escape closes it) only acts while the focus is in it. Its position is worked out from the target's box on every
 * check, kept inside the studio; at phone width it docks under the 3D view. In VR the step text goes to the VR
 * message panel; information steps go on by themselves after a while, action steps once they are done, and the
 * steps about desktop controls are passed over.
 *
 * @module     mod_vrmakerspace/tutorial
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Ajax from 'core/ajax';
import Log from 'core/log';
import Pending from 'core/pending';
import Templates from 'core/templates';
import Policy from 'core_ai/policy';
import {demoWords, offerAt, offersIn, opCount, stepsFor} from 'mod_vrmakerspace/tutorialsteps';
import {match as matchDemo} from 'mod_vrmakerspace/tutormatch';
import {createTutorVoice} from 'mod_vrmakerspace/tutorvoice';
import {reveal as revealAboveBar, startBelowTopBar} from 'mod_vrmakerspace/bottombar';

/** How often the current step's condition and the bubble's position are checked (s). */
const CHECK_INTERVAL = 0.1;

/** How long after the last change the progress is saved (ms). */
const SAVE_DELAY = 1500;

/** How long a done action step stays before the next one (s). */
const DONE_PAUSE = 1.6;

/** In VR: an information step goes on after this long (s). */
const VR_INFO_TIME = 6;

/** In VR: the text of a step not done yet is shown again this often (s). */
const VR_REPEAT = 8;

/** Below this width of the studio (CSS px) the bubble docks under the 3D view. */
const DOCK_WIDTH = 576;

/** The errors of mod_vrmakerspace_ask_tutor that mean the AI cannot answer now (not a fault in the question). */
const OFFLINE_ERRORS = Object.freeze(['error_tutoroffline', 'error_tutornotavailable']);

/** From this studio width (px) the bubble is a panel beside the 3D view, which narrows to make room for it. */
const SIDE_WIDTH = 860;

/** Space between the bubble and what it points at, and the least space to the studio's edges (CSS px). */
const GAP = 12;

/** How far (px) the bubble keeps from the tutor's head on screen, so the robot and its name stay visible. */
const TUTOR_CLEAR = 90;
const EDGE = 8;

/** How far from the view's centre, towards the viewer, the tutor points on the piece (m). */
const PIECE_POINT = 0.045;

/** Longest question (characters), as the server's limit. */
const MAX_QUESTION = 500;

/** A press of Talk shorter than this is a tap: the tutor then listens until the student pauses (ms). */
const HOLD_MS = 350;

/** A click on Talk this soon after a press by pointer or Space is that press's own click, not a tap (ms). */
const CLICK_AFTER_PRESS = 800;

/** Where the Read aloud choice is kept in this browser. */
const READALOUD_KEY = 'mod_vrmakerspace_tutorreadaloud';

/**
 * Whether Read aloud is on in this browser (on unless it was turned off).
 *
 * @returns {boolean}
 */
const readAloudStored = () => {
    try {
        return window.localStorage.getItem(READALOUD_KEY) !== '0';
    } catch (e) {
        return true;
    }
};

/**
 * Keep the Read aloud choice in this browser.
 *
 * @param {boolean} on Whether it is on.
 */
const storeReadAloud = (on) => {
    try {
        window.localStorage.setItem(READALOUD_KEY, on ? '1' : '0');
    } catch (e) {
        // Storage may be blocked: the choice then lasts for this page.
    }
};

/** What a voice error code is said as. */
const VOICE_ERRORS = {
    nolisten: 'tutorvoice_nolisten',
    micdenied: 'tutorvoice_micdenied',
    listenfailed: 'tutorvoice_listenfailed',
    consent: 'tutorvoice_consentvr',
};

/**
 * Whether the page has had a click or a key press (browsers only let it speak after one).
 *
 * @returns {boolean}
 */
const pageActivated = () => !!(navigator.userActivation && navigator.userActivation.hasBeenActive);

/**
 * Whether an element is one whose own keys (Space, Enter) must be left to it.
 *
 * @param {Element} element The element.
 * @returns {boolean}
 */
const ownsKeys = (element) => !!element && !!element.closest('button, a, input, textarea, select, [contenteditable="true"]');

/**
 * Put values into a string fetched without them ({$a} or {$a->name}).
 *
 * @param {string} template The string.
 * @param {*} a A value, or an object of values.
 * @returns {string}
 */
const fill = (template, a) => {
    let text = String(template || '');
    if (a !== null && typeof a === 'object') {
        text = text.replace(/\{\$a->([A-Za-z0-9_]+)\}/g, (match, name) => (a[name] !== undefined ? String(a[name]) : match));
    } else if (a !== undefined) {
        text = text.split('{$a}').join(String(a));
    }
    return text;
};

/**
 * A step text without its markup, for VR and for reading out.
 *
 * @param {string} text Step text (may hold <strong>).
 * @returns {string}
 */
export const plainText = (text) => String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/**
 * Show a step text in an element: plain text, with <strong>…</strong> kept as bold. Nothing else is taken as markup.
 *
 * @param {HTMLElement} element The element.
 * @param {string} text Step text.
 */
const setRichText = (element, text) => {
    element.textContent = '';
    String(text || '').split(/(<strong>[\s\S]*?<\/strong>)/).forEach((part) => {
        const bold = /^<strong>([\s\S]*)<\/strong>$/.exec(part);
        if (bold) {
            const strong = document.createElement('strong');
            strong.textContent = plainText(bold[1]);
            element.appendChild(strong);
        } else if (part) {
            element.appendChild(document.createTextNode(part.replace(/<[^>]*>/g, '')));
        }
    });
};

/**
 * Show or hide an element.
 *
 * @param {HTMLElement|null} element The element.
 * @param {boolean} visible Whether it is shown.
 */
const show = (element, visible) => {
    if (element) {
        element.classList.toggle('d-none', !visible);
    }
};

/**
 * Call a web service.
 *
 * @param {string} methodname Function name.
 * @param {Object} args Arguments.
 * @returns {Promise}
 */
const call = (methodname, args) => Ajax.call([{methodname: methodname, args: args}])[0];

/**
 * The text of an error.
 *
 * @param {*} error The error.
 * @returns {string}
 */
const errorText = (error) => {
    if (error && error.message) {
        return String(error.message);
    }
    if (error && error.error) {
        return String(error.error);
    }
    return String(error || '');
};

/**
 * Whether an element can be seen (it, and everything around it, is shown).
 *
 * @param {HTMLElement|null} element The element.
 * @returns {boolean}
 */
const isShown = (element) => !!element && element.getClientRects().length > 0;

/**
 * A number brought into a range (the upper end wins when the range is empty).
 *
 * @param {number} value The number.
 * @param {number} low Lowest.
 * @param {number} high Highest.
 * @returns {number}
 */
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * A point on the piece facing the viewer, in the sculpture's frame: where the tutor points for a step on the piece.
 *
 * @param {Object} state Studio state.
 * @returns {number[]} [x, y, z]
 */
export const piecePoint = (state) => {
    const camera = state && state.camera ? state.camera : null;
    if (!camera) {
        return [0, 0, PIECE_POINT];
    }
    const target = Array.isArray(camera.target) ? camera.target : [0, 0, 0];
    const polar = Number(camera.polar) || Math.PI / 2;
    const azimuth = Number(camera.azimuth) || 0;
    return [
        target[0] + PIECE_POINT * Math.sin(polar) * Math.sin(azimuth),
        target[1] + PIECE_POINT * Math.cos(polar),
        target[2] + PIECE_POINT * Math.sin(polar) * Math.cos(azimuth),
    ];
};

/**
 * Where the tour starts: at the last step, else at the first one neither done nor skipped, else at the beginning.
 *
 * @param {Object[]} steps The tour's steps.
 * @param {string} laststep Key of the last step shown.
 * @param {Set} done Keys done.
 * @param {Set} skipped Keys skipped.
 * @returns {number} Index.
 */
export const startIndex = (steps, laststep, done, skipped) => {
    const last = steps.findIndex((step) => step.key === laststep);
    if (last >= 0 && laststep !== 'done') {
        return last;
    }
    const open = steps.findIndex((step) => !done.has(step.key) && !skipped.has(step.key));
    return open >= 0 ? open : 0;
};

/**
 * Create the guided tour.
 *
 * @param {Object} options {root, canvas, camera, config: config.tutorial, cmid, strings, state() → studio state,
 *     tutor (or null), xr (or null), toolbar, context (the tutor's demo context), onClose(), audioContext (an
 *     AudioContext, or a function giving one, for the voice; optional: the voice makes its own)}
 * @returns {Object} {open(focus), close(), update(dt), dispose(), isOpen, finished(), talk(pressed), say(stepKey),
 *     ask(question), canTalk}
 */
export const createTutorial = (options) => {
    const root = options.root;
    const canvas = options.canvas;
    const config = options.config || {};
    const strings = options.strings || {};
    const tutor = options.tutor || null;
    const toolbar = options.toolbar || null;
    const cmid = Number(options.cmid) || 0;
    const steps = stepsFor(config.steps);
    /** The steps that offer the other way of making (mod_vrmakerspace/tutorialsteps offersIn()). */
    const offers = offersIn(steps);
    /** The method and the student's Turn into clay count when last looked at, to see a change of way of making. */
    let seen = null;
    const done = new Set(Array.isArray(config.done) ? config.done.map(String) : []);
    const skipped = new Set(Array.isArray(config.skipped) ? config.skipped.map(String) : []);
    const stage = root.querySelector('[data-region="stage"]');
    const uniqid = 'mod_vrmakerspace-tour-' + Math.random().toString(36).slice(2, 10);
    let laststep = String(config.laststep || '');
    /** @type {Object} the bubble's parts, once rendered */
    let parts = null;
    let layer = null;
    let rendering = null;
    let opened = false;
    /** Whether the AI failed to answer in this visit: then no Ask box and no Talk until the page is opened again. */
    let offline = false;
    /** Whether the tour opened More itself (it closes it again when a step needs only the basic tools). */
    let openedmore = false;
    let disposed = false;
    /** @type {Object|null} {index, step, start, memo, completed, elapsed, advanceAt, vrclock} */
    let current = null;
    let checkclock = 0;
    let crossclock = 0;
    let busy = false;
    let asking = false;
    let invr = false;
    let savetimer = null;
    let dirty = false;
    let saving = Promise.resolve(null);
    /** Whether the student was told the tour is finished (it may have been before this visit). */
    let toldfinished = steps.length > 0 && steps.every((step) => done.has(step.key) || skipped.has(step.key));
    const voiceconfig = config.voice || {};
    const haslisten = Array.isArray(voiceconfig.listen) && voiceconfig.listen.length > 0;
    const hasspeak = Array.isArray(voiceconfig.speak) && voiceconfig.speak.length > 0;
    /** @type {Object|null} the tutor's ears and voice (mod_vrmakerspace/tutorvoice), when the activity has them */
    let voice = null;
    if (haslisten || hasspeak) {
        try {
            voice = createTutorVoice({cmid: cmid, config: voiceconfig, strings: strings, audioContext: options.audioContext,
                inVr: () => invr});
        } catch (e) {
            Log.debug(e);
            voice = null;
        }
    }
    /** The Ask box: always in tutorial mode (unless the server says no); with the AI off it answers in the browser. */
    const canask = config.canask !== false;
    /** Whether questions go to the AI now (it is on, and the student accepted the AI policy). */
    let aiready = !!config.ai && !!config.aipolicy;
    let readaloud = readAloudStored();
    let gestured = false;
    /** Push to talk: when the press began, whether its release is to be ignored, whether it is still held. */
    let pressedat = 0;
    let ignorerelease = false;
    let held = false;
    let lastpress = 0;
    /** Counts answers, so a demonstration waiting for an answer's voice is called off by a newer one or by Stop. */
    let answerrun = 0;
    /** Whether a demonstration asked for runs now. */
    let answering = false;
    let mouth = 0;
    let worldpoint = null;
    /** The text of the reply line now, so "Now you try" can be added under it. */
    let replytext = '';

    /**
     * The studio state now.
     *
     * @returns {Object}
     */
    const state = () => {
        try {
            return options.state() || {};
        } catch (e) {
            Log.debug(e);
            return {};
        }
    };

    /**
     * Run a call on the tutor, if there is one and it has it.
     *
     * @param {string} name Method name.
     * @param {...*} args Arguments.
     * @returns {*} What it returned, or undefined.
     */
    const tutorCall = (name, ...args) => {
        if (!tutor || typeof tutor[name] !== 'function') {
            return undefined;
        }
        try {
            return tutor[name](...args);
        } catch (e) {
            Log.debug(e);
            return undefined;
        }
    };

    /**
     * A string by key ('' when missing).
     *
     * @param {string} key String key.
     * @param {*} [a] Value for it.
     * @returns {string}
     */
    const str = (key, a) => fill(strings[key] || '', a);

    // Saving the progress.

    /**
     * Save the progress now, if anything changed.
     *
     * @returns {Promise}
     */
    const flush = () => {
        if (savetimer) {
            window.clearTimeout(savetimer);
            savetimer = null;
        }
        if (!dirty || !cmid) {
            return saving;
        }
        dirty = false;
        const known = new Set(steps.map((step) => step.key));
        const args = {
            cmid: cmid,
            laststep: known.has(laststep) ? laststep : '',
            done: Array.from(done).filter((key) => known.has(key)),
            skipped: Array.from(skipped).filter((key) => known.has(key) && !done.has(key)),
        };
        saving = saving.then(() => call('mod_vrmakerspace_save_tutorial_progress', args)).then((result) => {
            if (result && result.finished && !toldfinished && toolbar && strings.tutorial_saved) {
                toldfinished = true;
                toolbar.message(strings.tutorial_saved, 5000);
            }
            return result;
        }).catch((error) => {
            // Tried again with the next change.
            dirty = true;
            Log.debug(error);
            return null;
        });
        return saving;
    };

    /** Save the progress a moment after the last change. */
    const scheduleSave = () => {
        dirty = true;
        if (savetimer) {
            window.clearTimeout(savetimer);
        }
        savetimer = window.setTimeout(() => {
            savetimer = null;
            flush();
        }, SAVE_DELAY);
    };

    // Finding and marking the target.

    /**
     * The element a step is about, when it can be seen.
     *
     * @param {Object} step The step.
     * @returns {HTMLElement|null}
     */
    const targetElement = (step) => {
        const target = step.target || {};
        if (target.canvas) {
            return isShown(stage) ? stage : null;
        }
        if (!target.selector) {
            return null;
        }
        let element = root.querySelector(target.selector);
        if (element && target.closest) {
            element = element.closest(target.closest) || element;
        }
        // The studio starts with its basic tools (mod_vrmakerspace/guide): a step about a tool behind More shows them all,
        // and the next step about a basic tool goes back to the basic ones, so the bar stays small over the piece.
        const behindmore = !!element && !!element.closest('[data-advanced], [data-region="brush"]');
        if (element && !isShown(element) && root.classList.contains('mod_vrmakerspace-basic') && behindmore) {
            root.dispatchEvent(new CustomEvent('mod_vrmakerspace:alltools'));
            openedmore = true;
        } else if (element && openedmore && !behindmore) {
            root.dispatchEvent(new CustomEvent('mod_vrmakerspace:basictools'));
            openedmore = false;
        }
        return isShown(element) ? element : null;
    };

    /**
     * Where the tutor's head is, in the studio root's CSS pixels.
     *
     * @param {DOMRect} rootbox The root's box.
     * @returns {{x: number, y: number}|null}
     */
    const tutorPoint = (rootbox) => {
        const point = tutorCall('screenPosition', options.camera, canvas);
        if (!point || point.visible === false || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            return null;
        }
        const box = canvas.getBoundingClientRect();
        return {x: box.left - rootbox.left + point.x, y: box.top - rootbox.top + point.y};
    };

    /**
     * Put the ring around an element, or hide it.
     *
     * @param {HTMLElement|null} element The element.
     * @param {DOMRect} rootbox The root's box.
     */
    const placeRing = (element, rootbox) => {
        if (!element || invr) {
            show(parts.ring, false);
            return;
        }
        const box = element.getBoundingClientRect();
        const ring = parts.ring;
        ring.style.left = `${box.left - rootbox.left - 4}px`;
        ring.style.top = `${box.top - rootbox.top - 4}px`;
        ring.style.width = `${box.width + 8}px`;
        ring.style.height = `${box.height + 8}px`;
        show(ring, true);
    };

    /**
     * Put the bubble at a place in the root (kept inside it), with the arrow pointing at x when given.
     *
     * @param {number} left Wanted left (px).
     * @param {number} top Wanted top (px).
     * @param {DOMRect} rootbox The root's box.
     * @param {Object} [arrow] {x, side: 'top'|'bottom'}
     */
    const putBubble = (left, top, rootbox, arrow) => {
        const bubble = parts.bubble;
        const width = bubble.offsetWidth;
        const height = bubble.offsetHeight;
        const x = clamp(left, EDGE, rootbox.width - width - EDGE);
        const y = clamp(top, EDGE, Math.max(EDGE, rootbox.height - height - EDGE));
        bubble.style.left = `${Math.round(x)}px`;
        bubble.style.top = `${Math.round(y)}px`;
        bubble.classList.toggle('mod_vrmakerspace-tour-arrow-top', !!arrow && arrow.side === 'top');
        bubble.classList.toggle('mod_vrmakerspace-tour-arrow-bottom', !!arrow && arrow.side === 'bottom');
        show(parts.arrow, !!arrow);
        if (arrow) {
            parts.arrow.style.left = `${Math.round(clamp(arrow.x - x, 16, width - 16))}px`;
        }
    };

    /**
     * Put the bubble next to an element: under it when there is room, else over it.
     *
     * @param {HTMLElement} element The element.
     * @param {DOMRect} rootbox The root's box.
     */
    const besideElement = (element, rootbox) => {
        const box = element.getBoundingClientRect();
        const height = parts.bubble.offsetHeight;
        const width = parts.bubble.offsetWidth;
        const centre = box.left - rootbox.left + box.width / 2;
        // A tool in the bar docked over the 3D view: open below the whole bar, so the bubble never covers other tools.
        const dock = element.closest('.mod_vrmakerspace-docked [data-region="toolbar"]');
        const bottom = dock ? Math.max(box.bottom, dock.getBoundingClientRect().bottom) : box.bottom;
        const below = bottom - rootbox.top + GAP;
        const above = box.top - rootbox.top - GAP - height;
        const room = below + height <= rootbox.height - EDGE || above < EDGE;
        putBubble(centre - width / 2, room ? below : above, rootbox, {x: centre, side: room ? 'top' : 'bottom'});
    };

    /**
     * The bottom of the bar of tools docked over the 3D view (mod_vrmakerspace/guide), 0 when it is not docked.
     *
     * @returns {number} Viewport y (px).
     */
    const dockBottom = () => {
        const dock = root.querySelector('.mod_vrmakerspace-docked [data-region="toolbar"]')
            || (root.classList.contains('mod_vrmakerspace-docked') ? root.querySelector('[data-region="toolbar"]') : null);
        return dock ? dock.getBoundingClientRect().bottom : 0;
    };

    /**
     * Put the bubble in the 3D view: next to the tutor's head, or in the view's top corner.
     *
     * @param {DOMRect} rootbox The root's box.
     * @param {boolean} attutor Whether it goes by the tutor.
     */
    const inStage = (rootbox, attutor) => {
        const head = attutor ? tutorPoint(rootbox) : null;
        if (head) {
            const width = parts.bubble.offsetWidth;
            const right = head.x + TUTOR_CLEAR + width <= rootbox.width - EDGE;
            // Beside the tutor, but never over the bar of tools docked at the top of the view.
            const top = Math.max(head.y - parts.bubble.offsetHeight / 2, dockBottom() - rootbox.top + GAP);
            putBubble(right ? head.x + TUTOR_CLEAR : head.x - TUTOR_CLEAR - width, top, rootbox);
            return;
        }
        const box = (stage || canvas).getBoundingClientRect();
        putBubble(box.right - rootbox.left - parts.bubble.offsetWidth - GAP, Math.max(box.top, dockBottom()) - rootbox.top + GAP,
            rootbox);
    };

    /**
     * Move the bubble sideways off the tutor when it covers the robot, keeping its height and arrow side.
     *
     * @param {DOMRect} rootbox The root's box.
     */
    const clearTutor = (rootbox) => {
        const head = tutorPoint(rootbox);
        if (!head) {
            return;
        }
        const bubble = parts.bubble;
        const left = bubble.offsetLeft;
        const top = bubble.offsetTop;
        const width = bubble.offsetWidth;
        const covers = head.x > left - TUTOR_CLEAR && head.x < left + width + TUTOR_CLEAR
            && head.y > top - TUTOR_CLEAR && head.y < top + bubble.offsetHeight + TUTOR_CLEAR;
        if (!covers) {
            return;
        }
        const toleft = head.x - TUTOR_CLEAR - width;
        const x = toleft >= EDGE ? toleft : head.x + TUTOR_CLEAR;
        const arrowx = parts.arrow && !parts.arrow.classList.contains('d-none')
            ? left + parseFloat(parts.arrow.style.left || '0') : null;
        const side = bubble.classList.contains('mod_vrmakerspace-tour-arrow-bottom') ? 'bottom' : 'top';
        putBubble(x, top, rootbox, arrowx === null ? undefined : {x: arrowx, side: side});
    };

    /** Place the ring and the bubble for the current step, from the boxes as they are now. */
    const position = () => {
        if (!parts || !current || !opened) {
            return;
        }
        const rootbox = root.getBoundingClientRect();
        const step = current.step;
        const element = targetElement(step);
        const docked = rootbox.width < DOCK_WIDTH;
        const side = !docked && rootbox.width >= SIDE_WIDTH && !invr;
        // The bubble never covers the tools or the way out: a panel beside the 3D view, or a sheet under it on a
        // phone; the view takes the room that is left (its size observer redraws it).
        root.classList.toggle('mod_vrmakerspace-tourside', side);
        root.classList.toggle('mod_vrmakerspace-tourbottom', docked && !invr);
        parts.bubble.classList.toggle('mod_vrmakerspace-tour-docked', docked);
        parts.bubble.classList.toggle('mod_vrmakerspace-tour-side', side);
        // While the site's AI policy is on its own, no step is being pointed at yet.
        placeRing(parts.bubble.classList.contains('mod_vrmakerspace-tour-policymode') ? null : element, rootbox);
        if (docked || side) {
            const view = stage || canvas;
            parts.bubble.style.left = '';
            parts.bubble.style.top = side && view ? `${view.offsetTop}px` : '';
            parts.bubble.style.maxHeight = side && view ? `${view.offsetHeight}px` : '';
            show(parts.arrow, false);
            return;
        }
        parts.bubble.style.maxHeight = '';
        if (element && !(step.target && step.target.canvas)) {
            besideElement(element, rootbox);
            clearTutor(rootbox);
        } else {
            inStage(rootbox, !!(step.target && step.target.tutor));
        }
    };

    // Showing a step.

    /**
     * Show which buttons the current step has.
     */
    const refreshButtons = () => {
        if (!parts || !current) {
            return;
        }
        const step = current.step;
        const last = step.key === 'done';
        const canshow = !!step.demo && !!tutor && typeof tutor.demo === 'function' && !invr;
        if (offline) {
            // The AI did not answer in this visit: the Ask box and Talk stay away.
            show(parts.ask, false);
            show(parts.talk, false);
        }
        show(parts.buttons.showme, canshow);
        show(parts.buttons.back, current.index > 0);
        show(parts.buttons.skip, step.kind === 'action' && !current.completed);
        // An offer of the other way of making is turned down with Not now, which passes over its steps.
        parts.buttons.skip.textContent = offerAt(steps, current.index) ? str('tutorial_notnow') : str('tutorial_skip');
        show(parts.buttons.next, !last && (step.kind === 'info' || current.completed));
        show(parts.buttons.finish, last);
        Object.keys(parts.buttons).forEach((name) => {
            if (name !== 'close' && parts.buttons[name]) {
                parts.buttons[name].disabled = busy;
            }
        });
        if (parts.askbutton) {
            parts.askbutton.disabled = asking;
        }
        refreshTalk();
    };

    /**
     * Whether the tutor is talking or showing something: Talk then stops it.
     *
     * @returns {boolean}
     */
    const talking = () => !!(voice && voice.speaking) || answering || !!(tutor && tutor.busy);

    /**
     * Show the Talk button's state: Talk, or Stop while listening or talking; the ring pulses while listening.
     */
    const refreshTalk = () => {
        const button = parts ? parts.talk : null;
        if (!button) {
            return;
        }
        const listening = !!(voice && voice.listening);
        const stoppable = listening || talking();
        button.classList.toggle('mod_vrmakerspace-tour-talk-listening', listening);
        button.setAttribute('aria-pressed', listening ? 'true' : 'false');
        const label = str(stoppable ? 'tutorvoice_stop' : 'tutorvoice_talk');
        if (parts.talklabel && parts.talklabel.textContent !== label) {
            parts.talklabel.textContent = label;
        }
        button.disabled = asking && !stoppable;
        if (!listening) {
            button.style.removeProperty('--mod_vrmakerspace-level');
        }
    };

    /**
     * Show a reply under the step text (the tutor's answer, "Well done!" or a failure), or hide it.
     *
     * @param {string} text Plain text ('' hides it).
     * @param {boolean} [thinking] Whether it is the "thinking" state.
     */
    const reply = (text, thinking = false) => {
        replytext = thinking ? '' : String(text || '');
        if (!parts) {
            return;
        }
        parts.reply.textContent = text || '';
        parts.reply.classList.toggle('mod_vrmakerspace-tour-thinking', !!thinking);
        show(parts.reply, !!text);
    };

    /**
     * Say a text in VR, where the bubble cannot be seen.
     *
     * @param {string} text Plain text.
     */
    const sayInVr = (text) => {
        if (invr && options.xr && typeof options.xr.showMessage === 'function') {
            try {
                options.xr.showMessage(text);
            } catch (e) {
                Log.debug(e);
            }
        }
    };

    /**
     * Show the tutor's reply in the bubble, and in VR on the message panel.
     *
     * @param {string} text Plain text.
     * @param {boolean} [thinking] Whether it is the "thinking" state.
     */
    const tell = (text, thinking = false) => {
        reply(text, thinking);
        if (text) {
            sayInVr(text);
        }
    };

    /**
     * A step as one line of plain text, for the VR message panel.
     *
     * @param {Object} step The step.
     * @returns {string}
     */
    const speech = (step) => `${str(`tutorial_step_${step.key}_title`)}: ${plainText(str(`tutorial_step_${step.key}_text`))}`;

    /**
     * Show the "You asked" line, or hide it.
     *
     * @param {string} text What the student said ('' hides it).
     */
    const heard = (text) => {
        if (parts && parts.heard) {
            parts.heard.textContent = text ? str('tutorvoice_heard', text) : '';
            show(parts.heard, !!text);
        }
    };

    /**
     * Hide the list of demonstrations.
     */
    const hideDemos = () => {
        if (parts && parts.demos) {
            parts.demos.textContent = '';
            show(parts.demos, false);
        }
    };

    /** Fill the bubble with the current step. */
    const renderStep = () => {
        const step = current.step;
        parts.title.textContent = str(`tutorial_step_${step.key}_title`);
        setRichText(parts.text, str(`tutorial_step_${step.key}_text`));
        parts.stepof.textContent = str('tutorial_stepof', {current: current.index + 1, total: steps.length});
        reply('');
        heard('');
        hideDemos();
        refreshButtons();
        show(parts.bubble, opened && !invr);
        sayInVr(speech(step));
    };

    /**
     * Put the studio in the method the step is about (the switch step starts from Sculpt, so it can be done).
     *
     * @param {Object} step The step.
     */
    const prepare = (step) => {
        const context = options.context || {};
        if (!step.method || typeof context.setMethod !== 'function') {
            return;
        }
        if (state().method !== step.method) {
            try {
                context.setMethod(step.method);
            } catch (e) {
                Log.debug(e);
            }
        }
    };

    /**
     * Have the tutor point at what the step is about.
     *
     * @param {Object} step The step.
     */
    const point = (step) => {
        tutorCall('pointAt', step.target && step.target.piece ? piecePoint(state()) : null);
        tutorCall('talk', 2.5);
    };

    /**
     * Scroll the phone's tool sheet so a control sits in its middle, clear of the fade at its foot.
     *
     * @param {HTMLElement} sheet The sheet (it scrolls on its own).
     * @param {HTMLElement} element The control.
     */
    const centreInSheet = (sheet, element) => {
        const box = element.getBoundingClientRect();
        const frame = sheet.getBoundingClientRect();
        sheet.scrollTop += (box.top + box.height / 2) - (frame.top + frame.height / 2);
    };

    /**
     * Bring the step's control into view (the Model panel scrolls sideways on phones).
     *
     * @param {Object} step The step.
     */
    const reveal = (step) => {
        const element = step.target && !step.target.canvas ? targetElement(step) : null;
        if (element && typeof element.scrollIntoView === 'function' && !invr) {
            // In the phone's tool sheet (which scrolls on its own and fades at its foot), into the middle of it, clear of
            // the fade; elsewhere only as far as needed.
            const sheet = element.closest('[data-region="tray"]');
            element.scrollIntoView({block: sheet ? 'center' : 'nearest', inline: 'nearest'});
            if (sheet) {
                // The sheet fills in its tools (More) after this: centre the control again once it has.
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => centreInSheet(sheet, element)));
            }
            // Not under the site's top bar or a bar at the window's bottom, where a click would miss it.
            revealAboveBar(root, element);
        }
    };

    /**
     * Whether a step is passed over here: VR without VR, or a desktop control in VR.
     *
     * @param {Object} step The step.
     * @returns {boolean}
     */
    const passedOver = (step) => (step.key === 'vr' && !state().vrAvailable) || (!!step.desktop && invr);

    let go = null;

    /**
     * Show a step.
     *
     * @param {number} index Its index.
     * @param {number} direction 1 going on, -1 going back: a step passed over is passed in that direction.
     */
    const showStep = (index, direction) => {
        let i = index;
        while (i >= 0 && i < steps.length && passedOver(steps[i])) {
            if (!done.has(steps[i].key)) {
                skipped.add(steps[i].key);
            }
            i += direction;
        }
        if (i < 0) {
            i = 0;
        }
        if (i >= steps.length) {
            go(steps.length);
            return;
        }
        const step = steps[i];
        // A demonstration of the step being left is called off (it puts the tools back).
        if (tutor && tutor.busy) {
            tutorCall('stopDemo');
        }
        prepare(step);
        current = {index: i, step: step, start: state(), memo: {}, completed: false, elapsed: 0, advanceAt: 0, vrclock: 0};
        laststep = step.key;
        scheduleSave();
        renderStep();
        point(step);
        reveal(step);
        position();
        if (parts.bubble.classList.contains('mod_vrmakerspace-tour-docked') && !invr) {
            // A sheet under the 3D view (narrow windows): the page starts at the view, so the piece and the sheet
            // (which scrolls on its own) are on the screen together.
            startBelowTopBar(root, stage || canvas);
        }
        readStep(step.key);
    };

    /**
     * The tour has been gone through: save, close and say how to open it again.
     */
    const finish = () => {
        done.add('done');
        dirty = true;
        flush();
        close();
        if (toolbar && strings.tutorial_reopen) {
            toolbar.message(strings.tutorial_reopen, 8000);
        }
    };

    /**
     * Go to a step by index; past the end finishes the tour.
     *
     * @param {number} index The index.
     * @param {number} [direction] 1 or -1.
     */
    go = (index, direction = 1) => {
        if (index >= steps.length) {
            finish();
            return;
        }
        showStep(Math.max(0, index), direction);
    };

    /** The current action step's condition holds: done, cheer, and go on in a moment. */
    const complete = () => {
        current.completed = true;
        current.advanceAt = current.elapsed + DONE_PAUSE;
        done.add(current.step.key);
        scheduleSave();
        tutorCall('cheer');
        reply(str('tutorial_done'));
        refreshButtons();
        sayInVr(str('tutorial_done'));
    };

    /** Next: an information step counts as done. */
    const next = () => {
        if (current.step.kind === 'info') {
            done.add(current.step.key);
        }
        go(current.index + 1);
    };

    /** Skip step; Not now on an offer of the other way of making passes over that way's steps too. */
    const skip = () => {
        const offer = offerAt(steps, current.index);
        const last = offer ? offer.to : current.index + 1;
        steps.slice(current.index, last).forEach((step) => {
            if (!done.has(step.key)) {
                skipped.add(step.key);
            }
        });
        go(last);
    };

    /**
     * The student changed the way of making without the tour (Turn into clay, or the switch to Model) while its
     * steps have not been gone through: the tour opens at them and says why. Turn into clay changes what is on
     * screen (the mesh is gone), so the modelling steps not reached yet are passed over; the switch only offers
     * the modelling steps once the student said Not now to them, or the tour is past them or closed.
     */
    const watchCrossing = () => {
        if (!offers.length || busy || (tutor && tutor.busy)) {
            return;
        }
        const now = state();
        const was = seen;
        seen = {method: String(now.method || ''), bakes: opCount(now, 'mbake')};
        if (!was) {
            return;
        }
        offers.some((offer) => {
            const crossed = offer.chapter === 'sculpt' ? seen.bakes > was.bakes
                : was.method !== 'model' && seen.method === 'model';
            const chapter = steps.slice(offer.from, offer.to);
            if (!crossed || chapter.some((step) => done.has(step.key))) {
                return false;
            }
            const at = opened && current ? current.index : -1;
            if (at === offer.index || (at >= offer.from && at < offer.to)) {
                // On the offer itself (its own condition ends it) or already in those steps.
                return false;
            }
            if (offer.chapter === 'model' && opened && at < offer.index) {
                // Trying the switch before the tour gets there: the sculpting steps go on.
                return false;
            }
            if (at >= 0 && at < offer.index) {
                steps.slice(at, offer.index).forEach((step) => {
                    if (!done.has(step.key)) {
                        skipped.add(step.key);
                    }
                });
            }
            done.add(offer.key);
            skipped.delete(offer.key);
            chapter.forEach((step) => skipped.delete(step.key));
            dirty = true;
            scheduleSave();
            const message = str(`tutorial_offer_${offer.chapter}`);
            const shown = opened ? Promise.resolve(showStep(offer.from, 1)) : open(false, offer.from);
            shown.then(() => {
                reply(message);
                sayInVr(message);
                return null;
            }).catch((error) => Log.debug(error));
            return true;
        });
    };

    /**
     * The tutor shows a demonstration on the practice piece. What it did is not the student's: the current step
     * starts again from there, so the student's own try completes it.
     *
     * @param {string} name Demo name.
     * @returns {Promise<boolean>} Whether it was shown; never rejects
     */
    const demonstrate = (name) => {
        if (busy || !tutor || typeof tutor.demo !== 'function' || !name) {
            return Promise.resolve(false);
        }
        busy = true;
        refreshButtons();
        const pending = new Pending('mod_vrmakerspace/tutorial:demo');
        // The demo resolves true (shown) or false (not possible here, or called off); it never rejects and shows its
        // own message when it cannot be done.
        return new Promise((resolve) => resolve(tutor.demo(name, options.context || {}))).catch((error) => {
            Log.debug(error);
            reply(str('tutorial_showmefailed') || errorText(error));
            return false;
        }).then((shown) => {
            busy = false;
            if (current) {
                current.start = state();
                current.memo = {};
                // A demo stops the tutor pointing: point again for the step, while the tour is open.
                if (opened) {
                    point(current.step);
                }
            }
            refreshButtons();
            pending.resolve();
            return !!shown;
        });
    };

    /** Show me: the tutor shows the step on the practice piece. */
    const showMe = () => {
        if (busy || !current.step.demo) {
            return;
        }
        reply(str('tutor_watch'));
        demonstrate(current.step.demo).then(() => {
            reply('');
            return null;
        }).catch((error) => Log.debug(error));
    };

    // Speaking.

    /**
     * Whether the tutor speaks now: the activity lets it, the browser can, and Read aloud is on.
     *
     * @returns {boolean}
     */
    const speakingOn = () => !!voice && voice.canSpeak() && readaloud;

    /**
     * Whether the browser lets the page make sound yet (after a click or key press).
     *
     * @returns {boolean}
     */
    const maySound = () => gestured || pageActivated();

    /**
     * The plain text the browser voice speaks for a step: its title, then its text.
     *
     * @param {string} key Step key.
     * @returns {string}
     */
    const stepSpeech = (key) => `${str(`tutorial_step_${key}_title`)}. ${plainText(str(`tutorial_step_${key}_text`))}`;

    /**
     * Read a step aloud (when speaking is on): the server speaks the step from its own strings, the browser from ours.
     *
     * @param {string} key Step key.
     * @param {Object} [handlers] {onstart()}
     * @returns {Promise<boolean>} Whether it was all spoken
     */
    const say = (key, handlers = {}) => {
        if (!speakingOn() || !steps.some((step) => step.key === key)) {
            return Promise.resolve(false);
        }
        return voice.speak({step: key, text: stepSpeech(key)}, handlers);
    };

    /**
     * A new step: stop reading the last one, and read this one when Read aloud is on and the page may make sound.
     *
     * @param {string} key Step key.
     */
    const readStep = (key) => {
        if (!voice || answering) {
            return;
        }
        voice.stop();
        if (speakingOn() && maySound()) {
            say(key).catch((error) => Log.debug(error));
        }
    };

    /**
     * Stop the tutor talking and showing (Talk pressed while it does, or the tour closes).
     */
    const stopTalking = () => {
        answerrun++;
        if (voice) {
            voice.stop();
        }
        if (answering || (tutor && tutor.busy)) {
            tutorCall('stopDemo');
        }
        tutorCall('setMouth', 0);
        mouth = 0;
        refreshTalk();
    };

    /**
     * Add "Now you try" under the reply.
     */
    const nowYouTry = () => {
        const text = str('tutorvoice_nowyoutry');
        reply(replytext ? `${replytext}\n${text}` : text);
        sayInVr(text);
    };

    /**
     * Answer: speak (when speaking is on) and then show the demonstration, starting it when the voice starts (or at
     * once without a voice).
     *
     * @param {Object|null} source What tutorvoice speaks ({step, text, first}), or null for nothing.
     * @param {string} demo Demo name, or ''.
     */
    const respond = (source, demo) => {
        const run = ++answerrun;
        let started = false;
        /** Start the demonstration, once, unless a newer answer or Stop came first. */
        const start = () => {
            if (started || run !== answerrun) {
                return;
            }
            started = true;
            if (!demo) {
                return;
            }
            answering = true;
            refreshTalk();
            demonstrate(demo).then((shown) => {
                answering = false;
                if (shown && run === answerrun) {
                    nowYouTry();
                }
                refreshTalk();
                return shown;
            }).catch((error) => Log.debug(error));
        };
        if (source && speakingOn()) {
            voice.speak(source, {onstart: start}).then(() => {
                // The voice failed or was stopped before it began: show it anyway (unless Stop was pressed).
                start();
                return null;
            }).catch((error) => Log.debug(error));
        } else {
            tutorCall('talk', Math.min(8, 1 + replytext.length / 20));
            start();
        }
        refreshTalk();
    };

    // Asking the tutor.

    /**
     * Whether a demo name is one of this tour's (only those can be shown here).
     *
     * @param {*} name Demo name.
     * @returns {string} The name, or ''.
     */
    const knownDemo = (name) => (name && steps.some((step) => step.demo === String(name)) ? String(name) : '');

    /**
     * The demonstration a question is about, found in the browser (mod_vrmakerspace/tutormatch).
     *
     * @param {string} question The question.
     * @returns {{demo: string, step: string}|null}
     */
    const localMatch = (question) => {
        const method = state().method;
        const list = demoWords(steps, strings);
        const prefer = list.filter((entry) => entry.method && entry.method === method).map((entry) => entry.demo);
        try {
            return matchDemo(question, list, {prefer: prefer});
        } catch (e) {
            Log.debug(e);
            return null;
        }
    };

    /**
     * Offer demonstrations as buttons (in VR, where they cannot be pressed, they are listed on the message panel).
     *
     * @param {string[]} names Demo names.
     * @param {boolean} [single] Whether the button says "Show me: …" (one demo offered under an answer).
     */
    const offerDemos = (names, single = false) => {
        const offered = names.filter((name) => !!knownDemo(name));
        if (!parts || !parts.demos || !offered.length) {
            return;
        }
        parts.demos.textContent = '';
        offered.forEach((name) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-sm btn-outline-secondary';
            button.dataset.demo = name;
            const title = str(`tutorial_step_${name}_title`);
            button.textContent = single ? str('tutorvoice_showdemo', title) : title;
            parts.demos.appendChild(button);
        });
        show(parts.demos, true);
        if (invr && !single) {
            sayInVr(`${str('tutorvoice_canshow')} ${offered.map((name) => str(`tutorial_step_${name}_title`)).join(', ')}`);
        }
        position();
    };

    /**
     * Answer with a step: its title and text in the bubble, read aloud, then the demonstration.
     *
     * @param {string} key Step key.
     * @param {string} demo Demo name.
     */
    const answerWithStep = (key, demo) => {
        hideDemos();
        tell(`${str(`tutorial_step_${key}_title`)}: ${plainText(str(`tutorial_step_${key}_text`))}`);
        respond({step: key, text: stepSpeech(key)}, demo);
    };

    /**
     * Answer a question in the browser: the demonstration it is about, or the list of what the tutor can show.
     *
     * @param {string} question The question.
     */
    const answerLocally = (question) => {
        const hit = localMatch(question);
        if (hit) {
            answerWithStep(hit.step, hit.demo);
            return;
        }
        tell(str('tutorvoice_canshow'));
        offerDemos(steps.filter((step) => !!step.demo).map((step) => step.demo));
    };

    /**
     * The AI cannot answer now (mod_vrmakerspace_ask_tutor said so): say it once, calmly, and take the Ask box and Talk
     * away for the rest of this visit. The steps and Show me go on as before.
     */
    const goOffline = () => {
        aiready = false;
        offline = true;
        stopTalking();
        tell(str('tutorial_offline'));
        if (parts) {
            show(parts.ask, false);
            show(parts.talk, false);
        }
        refreshButtons();
        position();
    };

    /**
     * Ask the AI (mod_vrmakerspace_ask_tutor); its answer may name a demonstration.
     *
     * @param {string} question The question.
     * @returns {Promise}
     */
    const askAi = (question) => {
        // The first sentence comes back as audio with the answer when the server speaks first: one round trip less.
        const serveraudio = speakingOn() && voice.speaksOnServer();
        const args = {cmid: cmid, step: current.step.key, question: question, speak: serveraudio};
        return call('mod_vrmakerspace_ask_tutor', args).then((result) => {
            tutorCall('setThinking', false);
            const answer = String(result && result.answer ? result.answer : '');
            const demo = knownDemo(result && result.demo);
            tell(answer);
            let first = null;
            if (serveraudio) {
                first = result && result.audio ? {audio: result.audio, mimetype: result.mimetype, chunks: result.chunks} : false;
            }
            respond({step: '', text: answer, first: first}, demo);
            if (!demo) {
                // The AI named nothing to show: offer what the question seems to be about, if anything.
                const hit = localMatch(question);
                if (hit) {
                    offerDemos([hit.demo], true);
                }
            }
            return answer;
        }).catch((error) => {
            Log.debug(error);
            if (error && OFFLINE_ERRORS.includes(error.errorcode)) {
                // The AI did not answer: one calm line, and no Ask box or Talk for the rest of this visit.
                goOffline();
                return;
            }
            tell(str('tutorial_askfailed', errorText(error)));
            const hit = localMatch(question);
            if (hit) {
                offerDemos([hit.demo], true);
            }
        });
    };

    /**
     * Ask the tutor a question, typed or heard.
     *
     * @param {string} text The question.
     * @returns {Promise}
     */
    const ask = (text) => {
        const question = String(text || '').trim().slice(0, MAX_QUESTION);
        if (asking || !question || !current) {
            return Promise.resolve(null);
        }
        stopTalking();
        hideDemos();
        asking = true;
        refreshButtons();
        tutorCall('setThinking', true);
        tell(str('tutorial_thinking'), true);
        const pending = new Pending('mod_vrmakerspace/tutorial:ask');
        const answered = aiready ? askAi(question) : Promise.resolve().then(() => answerLocally(question));
        return answered.catch((error) => {
            Log.debug(error);
            tell(str('tutorial_askfailed', errorText(error)));
        }).then(() => {
            asking = false;
            tutorCall('setThinking', false);
            if (parts && parts.question) {
                parts.question.value = '';
            }
            refreshButtons();
            position();
            pending.resolve();
            return null;
        });
    };

    /** Ask the question in the box. */
    const askTyped = () => {
        if (parts && parts.question) {
            ask(parts.question.value);
        }
    };

    // Talking to the tutor.

    /**
     * Whether the student can talk to the tutor here.
     *
     * @returns {boolean}
     */
    const canTalk = () => canask && !!voice && voice.canListen() && (!config.ai || aiready || !parts || !parts.askform
        || !parts.askform.hidden);

    /**
     * Listen to a question, then ask it.
     */
    const startListening = () => {
        gestured = true;
        tutorCall('setListening', true);
        heard('');
        hideDemos();
        tell(str(invr ? 'tutorvoice_listeningvr' : 'tutorvoice_listening'), true);
        const talkbutton = parts ? parts.talk : null;
        const listening = voice.listen({
            onlevel: (level) => {
                if (talkbutton) {
                    talkbutton.style.setProperty('--mod_vrmakerspace-level', level.toFixed(2));
                }
            },
            oninterim: (text) => heard(text),
        });
        refreshTalk();
        listening.then((text) => {
            tutorCall('setListening', false);
            refreshTalk();
            if (!text) {
                tell(str(invr ? 'tutorvoice_nothingheardvr' : 'tutorvoice_nothingheard'));
                return null;
            }
            heard(text);
            return ask(text);
        }).catch((error) => {
            tutorCall('setListening', false);
            Log.debug(error);
            if (!error || error.code !== 'busy') {
                tell(str(VOICE_ERRORS[error && error.code] || 'tutorvoice_listenfailed'));
            }
            if (parts && parts.talk && !voice.canListen()) {
                show(parts.talk, false);
            }
            refreshTalk();
        });
    };

    /**
     * Push to talk (the Talk button, Space in the bubble, the VR talk button). Pressed: start listening (while the tutor
     * talks or shows something: stop it; while it listens after a tap: send). Let go: send, or after a short tap
     * listen on until the student pauses.
     *
     * @param {boolean} pressed Whether the button went down (true) or up (false).
     */
    const talk = (pressed) => {
        if (disposed || !voice) {
            return;
        }
        held = !!pressed;
        if (!pressed) {
            if (ignorerelease) {
                ignorerelease = false;
            } else if (voice.listening) {
                if (Date.now() - pressedat < HOLD_MS) {
                    voice.setAuto(true);
                } else {
                    voice.stopListening();
                }
            }
            refreshTalk();
            return;
        }
        gestured = true;
        pressedat = Date.now();
        ignorerelease = true;
        if (voice.listening) {
            voice.stopListening();
        } else if (talking()) {
            stopTalking();
        } else if (asking) {
            // An answer is on its way.
        } else if (!opened) {
            open(false).then(() => {
                if (held && opened && canTalk()) {
                    ignorerelease = false;
                    startListening();
                }
                return null;
            }).catch((error) => Log.debug(error));
        } else if (canTalk()) {
            ignorerelease = false;
            startListening();
        } else if (config.ai && !aiready && voice.canListen()) {
            // The AI policy is shown in the bubble first (on the desktop).
            tell(str('error_tutorpolicy'));
        } else if (parts && parts.question && parts.askform && !parts.askform.hidden && !invr) {
            parts.question.focus();
        }
        refreshTalk();
    };

    /**
     * Talk pressed with the pointer or Space: the press itself (its click is then ignored).
     *
     * @param {boolean} pressed Down or up.
     */
    const press = (pressed) => {
        lastpress = Date.now();
        talk(pressed);
    };

    /** Talk clicked without a press (Enter, or an assistive technology): a tap. */
    const tapTalk = () => {
        if (Date.now() - lastpress < CLICK_AFTER_PRESS) {
            return;
        }
        talk(true);
        talk(false);
    };

    /**
     * The site's AI policy on its own in the bubble (before the first step), or the steps.
     *
     * @param {boolean} on Whether only the policy shows.
     */
    const setPolicyMode = (on) => {
        parts.bubble.classList.toggle('mod_vrmakerspace-tour-policymode', on);
        // The step controls are a flex row (Bootstrap's d-flex wins over a stylesheet): hidden by d-none.
        const controls = parts.bubble.lastElementChild;
        if (controls) {
            controls.classList.toggle('d-none', on);
        }
    };

    /** The student accepted the AI policy: show the question box. */
    const acceptPolicy = () => {
        Promise.resolve(Policy.acceptPolicy()).then(() => {
            aiready = true;
            parts.policy.hidden = true;
            setPolicyMode(false);
            parts.askform.hidden = false;
            parts.question.focus();
            refreshButtons();
            position();
            return null;
        }).catch((error) => {
            Log.debug(error);
            reply(errorText(error));
        });
    };

    /** The student declined the AI policy: the tutor answers in the browser this time (no AI). */
    const declinePolicy = () => {
        aiready = false;
        parts.policy.hidden = true;
        setPolicyMode(false);
        parts.askform.hidden = false;
        refreshButtons();
        position();
    };

    // Events of the bubble.

    /** What the bubble's buttons do. */
    const BUTTONS = {
        next: () => next(),
        /** Finish: the last step is done, and the tour closes. */
        finish: () => {
            done.add('done');
            finish();
        },
        back: () => go(current.index - 1, -1),
        skip: () => skip(),
        showme: () => showMe(),
        talk: () => tapTalk(),
        close: () => close(),
    };

    /**
     * A demonstration offered as a button was chosen.
     *
     * @param {string} name Demo name.
     */
    const chooseDemo = (name) => {
        if (busy || asking || !knownDemo(name)) {
            return;
        }
        gestured = true;
        stopTalking();
        answerWithStep(name, name);
    };

    /**
     * Clicks in the bubble.
     *
     * @param {MouseEvent} event The event.
     */
    const onClick = (event) => {
        const policy = event.target.closest('.ai-policy-block [data-action]');
        if (policy) {
            event.preventDefault();
            if (policy.dataset.action === 'accept') {
                acceptPolicy();
            } else if (policy.dataset.action === 'decline') {
                declinePolicy();
            }
            return;
        }
        const demo = event.target.closest('[data-demo]');
        if (demo && current) {
            event.preventDefault();
            chooseDemo(demo.dataset.demo);
            return;
        }
        const button = event.target.closest('[data-tutorial]');
        if (!button || button.disabled || !current || !BUTTONS[button.dataset.tutorial]) {
            return;
        }
        event.preventDefault();
        // While the tutor shows something, only Close, and Talk (which stops it), work.
        if (button.dataset.tutorial !== 'close' && button.dataset.tutorial !== 'talk' && busy) {
            return;
        }
        BUTTONS[button.dataset.tutorial]();
    };

    /**
     * Whether a key event is the Space of push to talk: on the Talk button, or in the bubble outside its controls.
     *
     * @param {KeyboardEvent} event The event.
     * @returns {boolean}
     */
    const isTalkKey = (event) => event.key === ' ' && !!parts && !!parts.talk && isShown(parts.talk)
        && !event.ctrlKey && !event.metaKey && !event.altKey
        && (event.target.closest('[data-tutorial="talk"]') !== null || !ownsKeys(event.target));

    /**
     * The pointer went down in the bubble: on Talk, push to talk starts.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerDown = (event) => {
        gestured = true;
        const button = event.target.closest('[data-tutorial="talk"]');
        if (!button || button.disabled || event.button !== 0) {
            return;
        }
        event.preventDefault();
        try {
            button.setPointerCapture(event.pointerId);
        } catch (e) {
            // Not every browser captures every pointer.
        }
        button.focus({preventScroll: true});
        press(true);
    };

    /**
     * The pointer went up (or was taken away) after a press on Talk: push to talk ends.
     *
     * @param {PointerEvent} event The event.
     */
    const onPointerUp = (event) => {
        if (held && event.target.closest('[data-tutorial="talk"]')) {
            press(false);
        }
    };

    /**
     * A long press on Talk (phones) is push to talk, not the context menu.
     *
     * @param {Event} event The event.
     */
    const onContextMenu = (event) => {
        if (event.target.closest('[data-tutorial="talk"]')) {
            event.preventDefault();
        }
    };

    /**
     * Read aloud was switched.
     *
     * @param {Event} event The event.
     */
    const onChange = (event) => {
        if (!parts || event.target !== parts.readaloud) {
            return;
        }
        readaloud = !!parts.readaloud.checked;
        storeReadAloud(readaloud);
        gestured = true;
        if (!readaloud) {
            if (voice) {
                voice.stop();
            }
        } else if (current) {
            say(current.step.key).catch((error) => Log.debug(error));
        }
    };

    /**
     * A key let go in the bubble: Space ends push to talk.
     *
     * @param {KeyboardEvent} event The event.
     */
    const onKeyUp = (event) => {
        if (isTalkKey(event) && held) {
            event.preventDefault();
            event.stopPropagation();
            press(false);
        }
    };

    /**
     * The question box is sent.
     *
     * @param {Event} event The event.
     */
    const onSubmit = (event) => {
        event.preventDefault();
        gestured = true;
        askTyped();
    };

    /**
     * Keys in the bubble: Escape closes the tour, Space (outside the bubble's controls, or on Talk) is push to talk.
     * Other keys are left to the studio.
     *
     * @param {KeyboardEvent} event The event.
     */
    const onKeyDown = (event) => {
        gestured = true;
        if (isTalkKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat && !held) {
                press(true);
            }
            return;
        }
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    };

    /** Place the bubble again when the window changes. */
    const onResize = () => position();

    /**
     * Find the bubble's parts in the rendered template.
     *
     * @returns {Object}
     */
    const findParts = () => {
        const bubble = layer.querySelector('[data-region="tutorial"]');
        const buttons = {};
        ['showme', 'back', 'skip', 'next', 'finish', 'close', 'talk'].forEach((name) => {
            buttons[name] = bubble.querySelector(`[data-tutorial="${name}"]`);
        });
        return {
            bubble: bubble,
            ring: layer.querySelector('[data-region="tutorialring"]'),
            arrow: bubble.querySelector('[data-region="tutorialarrow"]'),
            title: bubble.querySelector('[data-region="tutorialtitle"]'),
            stepof: bubble.querySelector('[data-region="tutorialstepof"]'),
            text: bubble.querySelector('[data-region="tutorialtext"]'),
            reply: bubble.querySelector('[data-region="tutorialreply"]'),
            ask: bubble.querySelector('[data-region="tutorialask"]'),
            policy: bubble.querySelector('[data-region="tutorialpolicy"]'),
            askform: bubble.querySelector('[data-region="tutorialaskform"]'),
            question: bubble.querySelector('[data-region="tutorialquestion"]'),
            askbutton: bubble.querySelector('[data-tutorial="ask"]'),
            talk: bubble.querySelector('[data-tutorial="talk"]'),
            talklabel: bubble.querySelector('[data-region="tutorialtalklabel"]'),
            readaloud: bubble.querySelector('[data-region="tutorialreadaloud"]'),
            heard: bubble.querySelector('[data-region="tutorialheard"]'),
            demos: bubble.querySelector('[data-region="tutorialdemos"]'),
            buttons: buttons,
        };
    };

    /**
     * Render the bubble once.
     *
     * @returns {Promise}
     */
    const render = () => {
        if (rendering) {
            return rendering;
        }
        const ai = !!config.ai;
        if (ai && typeof M !== 'undefined' && M.cfg) {
            Policy.preconfigurePolicyState(M.cfg.userId, !!config.aipolicy);
        }
        layer = document.createElement('div');
        layer.className = 'mod_vrmakerspace-tourlayer';
        if (stage) {
            stage.after(layer);
        } else {
            root.appendChild(layer);
        }
        const context = {
            uniqid: uniqid,
            ai: ai,
            aipolicy: !!config.aipolicy,
            canask: canask,
            listen: canask && !!voice && voice.canListen(),
            speak: !!voice && voice.canSpeak(),
            readaloud: readaloud,
        };
        rendering = Templates.renderForPromise('mod_vrmakerspace/tutorial_bubble', context).then(({html, js}) => {
            Templates.appendNodeContents(layer, html, js);
            parts = findParts();
            parts.bubble.addEventListener('click', onClick);
            parts.bubble.addEventListener('keydown', onKeyDown);
            parts.bubble.addEventListener('keyup', onKeyUp);
            parts.bubble.addEventListener('pointerdown', onPointerDown);
            parts.bubble.addEventListener('pointerup', onPointerUp);
            parts.bubble.addEventListener('pointercancel', onPointerUp);
            parts.bubble.addEventListener('change', onChange);
            parts.bubble.addEventListener('contextmenu', onContextMenu);
            if (parts.askform) {
                parts.askform.addEventListener('submit', onSubmit);
            }
            window.addEventListener('resize', onResize);
            return parts;
        });
        return rendering;
    };

    /**
     * Close the tour (it keeps where it was).
     */
    const close = () => {
        if (!opened) {
            return;
        }
        opened = false;
        if (parts) {
            show(parts.bubble, false);
            show(parts.ring, false);
        }
        root.classList.remove('mod_vrmakerspace-tourside', 'mod_vrmakerspace-tourbottom');
        stopTalking();
        if (voice) {
            // The microphone is let go while the tour is closed.
            voice.release();
        }
        held = false;
        ignorerelease = false;
        tutorCall('setListening', false);
        tutorCall('setThinking', false);
        tutorCall('stopDemo');
        tutorCall('pointAt', null);
        tutorCall('setVisible', false);
        if (toolbar && typeof toolbar.setTutorial === 'function') {
            toolbar.setTutorial(false);
        }
        flush();
        if (typeof options.onClose === 'function') {
            try {
                options.onClose();
            } catch (e) {
                Log.debug(e);
            }
        }
    };

    /**
     * Open the tour where the student left it.
     *
     * @param {boolean} [focus] Whether the focus moves to the bubble (opened with the Tutorial button).
     * @param {number} [at] The index of the step to open at (an offer taken up), instead of where the student was.
     * @returns {Promise}
     */
    const open = (focus = false, at = -1) => {
        if (disposed || !steps.length) {
            return Promise.resolve(null);
        }
        const pending = new Pending('mod_vrmakerspace/tutorial:open');
        return render().then(() => {
            if (disposed || opened) {
                return null;
            }
            opened = true;
            invr = !!(options.xr && options.xr.active);
            // The site's AI policy comes first, on its own, until it is accepted or declined; then only the steps.
            setPolicyMode(!!parts.policy && !parts.policy.hidden);
            tutorCall('setVisible', true);
            if (toolbar && typeof toolbar.setTutorial === 'function') {
                toolbar.setTutorial(true);
            }
            let index = current && current.step.key !== 'done' ? current.index : startIndex(steps, laststep, done, skipped);
            if (at >= 0) {
                index = at;
            }
            showStep(index, 1);
            if (focus && parts.title && !invr) {
                parts.title.focus({preventScroll: true});
            }
            return null;
        }).catch((error) => {
            Log.debug(error);
            return null;
        }).then((value) => {
            pending.resolve();
            return value;
        });
    };

    /**
     * Entering or leaving VR: the bubble hides in VR, and a step that does not work there is passed over.
     *
     * @param {boolean} nowvr Whether VR runs now.
     */
    const vrChanged = (nowvr) => {
        invr = nowvr;
        if (invr && passedOver(current.step)) {
            showStep(current.index, 1);
            return;
        }
        renderStep();
        position();
    };

    /**
     * The VR rules: information steps go on after a while, the text of an open step comes back now and then.
     *
     * @param {number} dt Seconds since the last frame.
     */
    const updateVr = (dt) => {
        current.vrclock += dt;
        if (current.step.kind === 'info' && current.elapsed >= VR_INFO_TIME) {
            if (current.step.key === 'done') {
                finish();
            } else {
                next();
            }
            return;
        }
        if (!current.completed && current.vrclock >= VR_REPEAT) {
            current.vrclock = 0;
            sayInVr(speech(current.step));
        }
    };

    /**
     * Check the current step's condition.
     */
    const check = () => {
        const step = current.step;
        if (step.kind !== 'action' || current.completed || busy || typeof step.done !== 'function'
                || (tutor && tutor.busy)) {
            return;
        }
        let holds = false;
        try {
            holds = !!step.done(current.start, state(), current.memo);
        } catch (e) {
            Log.debug(e);
        }
        if (holds) {
            complete();
        }
    };

    /**
     * The voice follows the tutor (its panner), the listener follows the camera, the tutor's mouth the voice.
     */
    const updateVoice = () => {
        if (!voice) {
            return;
        }
        if (voice.panner && tutor && typeof tutor.worldPosition === 'function') {
            if (!worldpoint && options.camera && options.camera.position && typeof options.camera.position.clone === 'function') {
                // A THREE.Vector3 to be filled in, without importing three.js here.
                worldpoint = options.camera.position.clone();
            }
            const position = worldpoint ? tutorCall('worldPosition', worldpoint) : null;
            if (position) {
                voice.setPosition(position);
            }
            voice.setListener(options.camera);
        }
        const level = voice.speaking ? voice.level() : 0;
        if (level > 0 || mouth > 0) {
            mouth = level;
            tutorCall('setMouth', level);
        }
    };

    /**
     * Frame update: the voice, the condition and the position at most 10 times a second, the pause after a done
     * step, VR.
     *
     * @param {number} dt Seconds since the last frame.
     */
    const update = (dt) => {
        if (disposed) {
            return;
        }
        crossclock += Math.max(0, Number(dt) || 0);
        if (crossclock >= CHECK_INTERVAL) {
            crossclock = 0;
            watchCrossing();
        }
        if (!opened || !current || !parts) {
            return;
        }
        updateVoice();
        const seconds = Math.max(0, Number(dt) || 0);
        current.elapsed += seconds;
        const nowvr = !!(options.xr && options.xr.active);
        if (nowvr !== invr) {
            vrChanged(nowvr);
            return;
        }
        if (current.advanceAt && current.elapsed >= current.advanceAt) {
            go(current.index + 1);
            return;
        }
        if (invr) {
            updateVr(seconds);
        }
        checkclock += seconds;
        if (checkclock < CHECK_INTERVAL || !current) {
            return;
        }
        checkclock = 0;
        check();
        refreshTalk();
        if (!invr) {
            position();
        }
    };

    /**
     * Remove the tour (the studio stops): save what is left.
     *
     * @returns {Promise}
     */
    const dispose = () => {
        if (disposed) {
            return saving;
        }
        close();
        disposed = true;
        const ending = flush();
        window.removeEventListener('resize', onResize);
        if (parts) {
            parts.bubble.removeEventListener('click', onClick);
            parts.bubble.removeEventListener('keydown', onKeyDown);
            parts.bubble.removeEventListener('keyup', onKeyUp);
            parts.bubble.removeEventListener('pointerdown', onPointerDown);
            parts.bubble.removeEventListener('pointerup', onPointerUp);
            parts.bubble.removeEventListener('pointercancel', onPointerUp);
            parts.bubble.removeEventListener('change', onChange);
            parts.bubble.removeEventListener('contextmenu', onContextMenu);
            if (parts.askform) {
                parts.askform.removeEventListener('submit', onSubmit);
            }
        }
        if (voice) {
            voice.dispose();
            voice = null;
        }
        if (layer) {
            layer.remove();
        }
        return ending;
    };

    return {
        open: open,
        close: close,
        update: update,
        dispose: dispose,

        /** @returns {boolean} Whether the bubble is open. */
        get isOpen() {
            return opened;
        },

        /**
         * Whether every step has been done or skipped.
         *
         * @returns {boolean}
         */
        finished: () => steps.every((step) => done.has(step.key) || skipped.has(step.key)),

        talk: talk,
        say: say,
        ask: ask,

        /** @returns {boolean} Whether the student can talk to the tutor (the activity and the browser allow it). */
        get canTalk() {
            return canask && !!voice && voice.canListen();
        },
    };
};
