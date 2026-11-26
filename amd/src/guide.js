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
 * First-use help in the studio (templates/studio.mustache), so that someone who has never seen it can start without
 * a manual:
 *
 * - the next-step tip over the 3D view, which follows what the person does (pick a side, then drag it; drag on the
 *   clay), and goes once they have made a few changes or close it;
 * - three small pictures of the controls in a corner of the 3D view (mouse or touch, chosen by CSS), which fade
 *   after the first change, and the "?" that opens the help with the keys;
 * - "Saved ✓ · 2 minutes ago" beside Save now (the full date on hover);
 * - More tools / Fewer tools: the basic tools only, or all of them (a tool in use always shows);
 * - the people of a group piece: who is here now and who has not opened it yet;
 * - on a phone, the tools in a tray at the bottom of the 3D view, with a cue when the row goes on to the right; with
 *   More, the tray becomes a sheet holding every tool and the File group;
 * - Show me how: three small pictures of a first build for the method in use;
 * - the tools dock inside the 3D view, in a glass bar along its top edge (More grows it over the view, never pushing
 *   the view down).
 *
 * Every word comes from the template. The choice of fewer or more tools is kept in a cookie: Moodle clears the whole
 * localStorage at every login (core/storage_validation).
 *
 * @module     mod_vrmakerspace/guide
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Changes after which the next-step tip has done its job. */
const TIP_CHANGES = 3;

/** How long the "that's it" tip stays before it gets out of the way (ms). */
const DONE_TIME = 9000;

/** How often the "saved … min ago" text is brought up to date (ms). */
const SAVED_TICK = 20000;

/** Cookie: 'all' when the person chose More tools. */
const TOOLS_COOKIE = 'mod_vrmakerspace_tools';

/** Cookies last a year. */
const COOKIE_AGE = 365 * 24 * 3600;

/** Phones: the tools go into the tray at the bottom of the 3D view. */
const PHONE = '(max-width: 575.98px)';

/**
 * The pictures of the tools: 24 by 24 line drawings in the colour of the button's text, in the suite's icon style
 * (POLISH-ROUND-2026-11-26.md, Chrome: stroke 2, round caps and joins). Fixed strings, never built from data.
 */
const ICONS = {
    'method:sculpt': '<path d="M6 17c-2-3 0-8 4-9 2-3 7-2 8 2 3 2 2 7-1 8-3 2-8 2-11-1z"/>',
    'method:model': '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4M12 11v8"/>',
    'undo': '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    'redo': '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    'tool:add': '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
    'tool:carve': '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
    'tool:smooth': '<path d="M3 13c3-4 5-4 9 0s6 4 9 0"/><path d="M3 19h18"/>',
    'tool:grab': '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1'
        + 'a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.3-2L8 13"/>',
    'tool:shape': '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4M12 11v8"/>',
    'selectmode:v': '<path d="M5 5h14v14H5z" opacity=".35"/><circle cx="5" cy="5" r="2.4" fill="currentColor"/>'
        + '<circle cx="19" cy="5" r="2.4" fill="currentColor"/><circle cx="19" cy="19" r="2.4" fill="currentColor"/>',
    'selectmode:e': '<path d="M5 5h14v14H5z" opacity=".35"/><path d="M5 5h14" stroke-width="3.2"/>',
    'selectmode:f': '<path d="M5 5h14v14H5z" fill="currentColor" fill-opacity=".45"/>',
    'modelaction:select': '<path d="M6 3l13 7-6 2-2 7z"/>',
    'modelaction:move': '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    'modelaction:rotate': '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/>',
    'modelaction:scale': '<path d="M4 20L20 4M14 4h6v6M10 20H4v-6"/>',
    'modelaction:extrude': '<path d="M4 20h16v-4H4z"/><path d="M12 13V3M8 7l4-4 4 4"/>',
    'addshapemenu': '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4M12 11v8"/>',
    'oneshot:delete': '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    'modelaction:inset': '<rect x="4" y="4" width="16" height="16"/><rect x="8" y="8" width="8" height="8"/>',
    'modelaction:bevel': '<path d="M4 20V4h9a7 7 0 0 1 7 7v9z"/>',
    'modelaction:loopcut': '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M12 3v18" stroke-dasharray="2 2"/>',
    'oneshot:merge': '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><path d="M6.5 7.5L12 15l5.5-7.5"/>'
        + '<circle cx="12" cy="18" r="2.2" fill="currentColor"/>',
    'oneshot:fill': '<path d="M4 4h16v16H4z"/><path d="M8 8h8v8H8z" fill="currentColor" fill-opacity=".45"/>',
    'oneshot:flip': '<path d="M12 3v18"/><path d="M9 7l-5 5 5 5z"/>'
        + '<path d="M15 7l5 5-5 5z" fill="currentColor" fill-opacity=".45"/>',
    'oneshot:mirror': '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6H5v12h4M15 6h4v12h-4"/>',
    'oneshot:bake': '<path d="M3 9l4-2 4 2v5l-4 2-4-2z"/><path d="M12 12h3M14 10l2 2-2 2"/>'
        + '<path d="M17 17c-1.5-2 0-5 2.5-5s3 2.5 2 4.5-3 2-4.5.5z"/>',
    'select:all': '<rect x="4" y="4" width="16" height="16" fill="currentColor" fill-opacity=".35"/>',
    'select:none': '<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 2"/>',
    'select:linked': '<rect x="3" y="3" width="10" height="10" fill="currentColor" fill-opacity=".35"/>'
        + '<rect x="11" y="11" width="10" height="10" fill="currentColor" fill-opacity=".35"/>',
    'select:loop': '<ellipse cx="12" cy="12" rx="9" ry="4.5"/><path d="M3 12h18" opacity=".35"/>',
    'tool:twist': '<path d="M12 12a2 2 0 1 1 2 2 4 4 0 1 1-4-4 6 6 0 1 1-6 6"/>',
    'tool:inflate': '<circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    'tool:pinch': '<path d="M3 12h6M15 12h6M7 8l4 4-4 4M17 8l-4 4 4 4"/>',
    'tool:flatten': '<path d="M3 18h18"/><path d="M6 18c0-4 3-6 6-6s6 2 6 6"/><path d="M12 3v5M9.5 6l2.5 2.5L14.5 6"/>',
    'tool:cutshape': '<circle cx="12" cy="12" r="8"/><path d="M9 9h6v6H9z" stroke-dasharray="2 2"/>',
    'mirror': '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6H5v12h4M15 6h4v12h-4"/>',
    'brush': '<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12c-3 0-5 2-5 5 0 2-1 3-2 4 4 0 9-1 9-6"/>',
};

/**
 * The picture key of a control, if it has one.
 *
 * @param {HTMLElement} button The control.
 * @returns {string} A key of ICONS, or ''.
 */
const iconKey = (button) => {
    const action = button.dataset.action || '';
    const detail = {method: 'method', tool: 'tool', modelaction: 'tool', selectmode: 'mode', oneshot: 'oneshot',
        select: 'select'}[action];
    if (detail) {
        return `${action}:${button.dataset[detail] || ''}`;
    }
    if (['undo', 'redo', 'mirror', 'brush'].includes(action)) {
        return action;
    }
    return button.dataset.region === 'addshapemenu' ? 'addshapemenu' : '';
};

/**
 * Give the tools a picture above their name, and make them bigger, so every row of tools looks the same.
 *
 * @param {HTMLElement} root The studio root.
 */
const decorate = (root) => {
    root.querySelectorAll('button[data-action], button[data-region="addshapemenu"]').forEach((button) => {
        const key = iconKey(button);
        if (!ICONS[key] || button.querySelector('svg')) {
            return;
        }
        const label = document.createElement('span');
        label.className = 'mod_vrmakerspace-tilelabel';
        while (button.firstChild) {
            label.appendChild(button.firstChild);
        }
        button.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
            + `${ICONS[key]}</svg>`);
        if (key === 'undo' || key === 'redo') {
            // Undo and redo are known by their arrows: the word stays for screen readers and the tooltip.
            label.classList.add('visually-hidden');
        }
        button.appendChild(label);
        button.classList.add('mod_vrmakerspace-tile');
    });
};

/** The modelling actions that use the number box, and the label each gives it. */
const SEGMENT_ACTIONS = ['bevel', 'loopcut'];

/**
 * Read a cookie.
 *
 * @param {string} name Cookie name.
 * @returns {string} Its value, '' when not set.
 */
const readCookie = (name) => {
    const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.indexOf(name + '=') === 0);
    return found ? decodeURIComponent(found.substring(name.length + 1)) : '';
};

/**
 * Write a cookie for the whole site.
 *
 * @param {string} name Cookie name.
 * @param {string} value Value.
 */
const writeCookie = (name, value) => {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_AGE}; samesite=lax`;
};

/**
 * Which label the number box takes for a modelling action.
 *
 * @param {string} action The action in use.
 * @returns {string} 'bevel', 'loopcut' or 'shape'.
 */
export const segmentsLabelKey = (action) => (SEGMENT_ACTIONS.includes(action) ? action : 'shape');

/**
 * Which next-step tip shows, if any.
 *
 * @param {Object} state {method: 'sculpt'|'model', changes: number (own changes this visit), selected: number (items
 *     picked), emptystart: boolean, meshstart: boolean (a polygon cube, no clay), closed: boolean}
 * @returns {string} 'clay', 'claydone', 'clayempty', 'claymesh', 'shapespick', 'shapesact', 'shapesdone', 'shapesempty' or ''
 *     for none.
 */
export const tipFor = (state) => {
    if (state.closed || state.changes >= TIP_CHANGES) {
        return '';
    }
    if (state.method === 'model') {
        if (state.emptystart && state.changes === 0 && !state.selected) {
            return 'shapesempty';
        }
        if (state.changes > 0) {
            return 'shapesdone';
        }
        return state.selected ? 'shapesact' : 'shapespick';
    }
    if (state.meshstart && state.changes === 0) {
        return 'claymesh';
    }
    if (state.changes > 0) {
        return 'claydone';
    }
    return state.emptystart ? 'clayempty' : 'clay';
};

/**
 * How long ago, in words, in the browser's own language ("2 minutes ago", "3 weeks ago").
 *
 * @param {number} then When (ms since the epoch).
 * @param {number} now The time now (ms since the epoch).
 * @param {string} justnow The words for under a minute.
 * @returns {string}
 */
export const agoText = (then, now, justnow) => {
    const seconds = Math.max(0, (now - then) / 1000);
    if (seconds < 60) {
        return justnow;
    }
    const units = [['minute', 60, 60], ['hour', 3600, 24], ['day', 86400, 7], ['week', 604800, 4.35],
        ['month', 2629800, 12], ['year', 31557600, Infinity]];
    const [unit, size] = units.find(([, length, count]) => seconds / length < count);
    const amount = -Math.floor(seconds / size);
    if (typeof Intl === 'object' && typeof Intl.RelativeTimeFormat === 'function') {
        return new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'}).format(amount, unit);
    }
    return new Date(then).toLocaleString();
};

/**
 * The words beside Save now.
 *
 * @param {Object} words {never, saved, justnow, pending}
 * @param {number} lastsaved When it was last saved (ms since the epoch), 0 for never.
 * @param {boolean} pending Whether there are changes not saved yet.
 * @param {number} now The time now (ms since the epoch).
 * @returns {string}
 */
export const savedText = (words, lastsaved, pending, now) => {
    if (!lastsaved) {
        return pending ? words.pending : words.never;
    }
    return `${words.saved} \u00b7 ${agoText(lastsaved, now, words.justnow)}`;
};

/**
 * Start the first-use help.
 *
 * @param {HTMLElement} root The studio root.
 * @param {Object} options {readonly, state(): {method, tool, action, selected}, onToolsChange()}
 * @returns {Object} {refresh(), setMethod(name), changed(), saved(), peers(names), dispose()}
 */
export const createGuide = (root, options) => {
    const readonly = !!options.readonly;
    const state = typeof options.state === 'function' ? options.state : () => ({});
    const onToolsChange = typeof options.onToolsChange === 'function' ? options.onToolsChange : () => undefined;
    const region = (name) => root.querySelector(`[data-region="${name}"]`);
    const hint = region('hint');
    const legend = region('legend');
    const savedstate = region('savedstate');
    const members = region('members');
    const modelscroll = region('modelscroll');
    const modelpanel = region('modelpanel');
    const moretools = root.querySelector('[data-action="moretools"]');
    const helppanel = region('helppanel');
    const helpbutton = root.querySelector('.mod_vrmakerspace-helpbutton');
    const tray = region('tray');
    const sculptpanel = region('sculptpanel');
    const toolbar = region('toolbar');
    const filegroup = region('filegroup');
    const showme = region('showme');
    const showmebutton = root.querySelector('[data-action="showme"]');
    const brush = region('brush');
    const brushbutton = root.querySelector('[data-action="brush"]');
    const listeners = [];
    let method = 'sculpt';
    let changes = 0;
    let tipclosed = false;
    let pending = false;
    let lastsaved = savedstate ? Number(savedstate.dataset.lastsaved || 0) * 1000 : 0;
    let timer = null;
    let donetimer = null;

    /**
     * Listen, remembering how to stop.
     *
     * @param {EventTarget} target Target.
     * @param {string} type Event type.
     * @param {Function} fn Listener.
     */
    const on = (target, type, fn) => {
        if (target) {
            target.addEventListener(type, fn);
            listeners.push(() => target.removeEventListener(type, fn));
        }
    };

    /** Show the tip that fits what the person is doing. */
    const refreshTip = () => {
        if (!hint) {
            return;
        }
        const now = state() || {};
        const key = tipFor({
            method: method,
            changes: changes,
            selected: Number(now.selected) || 0,
            emptystart: hint.dataset.emptystart === '1',
            meshstart: hint.dataset.meshstart === '1',
            closed: tipclosed || readonly,
        });
        let targets = '';
        hint.querySelectorAll('[data-hint]').forEach((span) => {
            span.classList.toggle('d-none', span.dataset.hint !== key);
            if (span.dataset.hint === key) {
                targets = span.dataset.highlight || '';
            }
        });
        hint.classList.toggle('d-none', key === '');
        // The tip that says it worked gets out of the way by itself.
        if ((key === 'shapesdone' || key === 'claydone') && !donetimer) {
            donetimer = window.setTimeout(() => {
                tipclosed = true;
                refreshTip();
            }, DONE_TIME);
        }
        // The buttons the tip names glow, so the eye goes from the words to the button.
        root.querySelectorAll('.mod_vrmakerspace-glow').forEach((element) => element.classList.remove('mod_vrmakerspace-glow'));
        targets.split(' ').filter((target) => target !== '').forEach((target) => {
            const [action, value] = target.split(':');
            const element = value === undefined ? root.querySelector(`[data-region="${action}"]`)
                : root.querySelector(`[data-action="${action}"][data-tool="${value}"]`);
            if (element) {
                element.classList.add('mod_vrmakerspace-glow');
            }
        });
    };

    /** Bring the saved state up to date. */
    const refreshSaved = () => {
        if (!savedstate) {
            return;
        }
        savedstate.textContent = savedText({
            never: savedstate.dataset.never || '',
            saved: savedstate.dataset.saved || '',
            justnow: savedstate.dataset.justnow || '',
            pending: savedstate.dataset.pending || '',
        }, lastsaved, pending, Date.now());
        savedstate.title = lastsaved ? new Date(lastsaved).toLocaleString() : '';
        // For the phone, where only a sign shows: saved, changes waiting, or nothing yet.
        savedstate.dataset.state = (pending && 'pending') || (lastsaved && 'saved') || 'never';
        savedstate.classList.toggle('mod_vrmakerspace-saved', !!lastsaved && !pending);
    };

    /**
     * Show the basic tools only, or all of them.
     *
     * @param {boolean} all Whether all show.
     */
    const setAll = (all) => {
        if (!moretools) {
            return;
        }
        root.classList.toggle('mod_vrmakerspace-basic', !all);
        moretools.setAttribute('aria-pressed', all ? 'true' : 'false');
        moretools.textContent = all ? (moretools.dataset.fewer || '') : (moretools.dataset.more || '');
        onToolsChange();
        placeBrush();
        refreshCue();
        window.setTimeout(refreshScrollHints, 50);
    };

    /**
     * Open or close the help panel.
     *
     * @param {boolean} open Whether it shows.
     */
    const setHelp = (open) => {
        if (!helppanel) {
            return;
        }
        helppanel.classList.toggle('d-none', !open);
        window.setTimeout(refreshScrollHints, 50);
        if (helpbutton) {
            helpbutton.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
    };

    /**
     * On a phone the tools sit in a tray at the bottom of the 3D view; elsewhere above it, in the toolbar.
     *
     * @param {boolean} phone Whether the window is phone-sized.
     */
    const placeTools = (phone) => {
        if (!tray || !toolbar) {
            return;
        }
        [sculptpanel, modelscroll, filegroup].forEach((panel) => {
            if (!panel) {
                return;
            }
            if (phone && panel.parentNode !== tray) {
                tray.appendChild(panel);
            } else if (!phone && panel.parentNode !== toolbar) {
                toolbar.appendChild(panel);
            }
        });
        root.classList.toggle('mod_vrmakerspace-phone', phone);
        placeBrush();
        refreshCue();
    };

    /**
     * With the basic tools, Size and Strength sit in a small glass popover under the Brush button, so the bar stays one
     * row; with all the tools (and in tutorial mode) they sit in the row as before.
     */
    function placeBrush() {
        if (!brush || !sculptpanel) {
            return;
        }
        const stage = region('stage');
        const popover = !!stage && root.classList.contains('mod_vrmakerspace-basic')
            && root.classList.contains('mod_vrmakerspace-docked');
        if (popover && brush.parentNode !== stage) {
            stage.appendChild(brush);
            brush.classList.add('mod_vrmakerspace-brushpop', 'd-none');
        } else if (!popover && brush.parentNode !== sculptpanel) {
            sculptpanel.appendChild(brush);
            brush.classList.remove('mod_vrmakerspace-brushpop', 'd-none');
        }
        if (brushbutton) {
            brushbutton.setAttribute('aria-expanded', popover && !brush.classList.contains('d-none') ? 'true' : 'false');
        }
    }

    /**
     * Open or close the Brush popover, under its button.
     *
     * @param {boolean} open Whether it shows.
     */
    function openBrush(open) {
        if (!brush || !brush.classList.contains('mod_vrmakerspace-brushpop')) {
            return;
        }
        brush.classList.toggle('d-none', !open);
        if (brushbutton) {
            brushbutton.setAttribute('aria-expanded', open ? 'true' : 'false');
            brushbutton.classList.toggle('active', open);
        }
        const stage = region('stage');
        if (open && stage && brushbutton && !root.classList.contains('mod_vrmakerspace-phone')) {
            const stagebox = stage.getBoundingClientRect();
            const buttonbox = brushbutton.getBoundingClientRect();
            const barbox = toolbar ? toolbar.getBoundingClientRect() : buttonbox;
            brush.style.left = `${Math.max(8, Math.round(buttonbox.left - stagebox.left))}px`;
            brush.style.top = `${Math.round(barbox.bottom - stagebox.top + 8)}px`;
        } else {
            brush.style.left = '';
            brush.style.top = '';
        }
    }

    /** On a phone the shape tools scroll sideways: show that more follow while they do. */
    function refreshCue() {
        if (!modelscroll || !modelpanel) {
            return;
        }
        const more = modelpanel.scrollWidth - modelpanel.scrollLeft - modelpanel.clientWidth > 4;
        modelscroll.classList.toggle('mod_vrmakerspace-hasmore', more);
    }

    on(root, 'click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || !root.contains(button)) {
            return;
        }
        switch (button.dataset.action) {
            case 'moretools':
                setAll(root.classList.contains('mod_vrmakerspace-basic'));
                writeCookie(TOOLS_COOKIE, root.classList.contains('mod_vrmakerspace-basic') ? 'basic' : 'all');
                break;
            case 'help':
                setHelp(!!helppanel && helppanel.classList.contains('d-none'));
                break;
            case 'brush':
                openBrush(!!brush && brush.classList.contains('d-none'));
                break;
            case 'showme':
                if (showme) {
                    const open = showme.classList.contains('d-none');
                    showme.classList.toggle('d-none', !open);
                    if (showmebutton) {
                        showmebutton.setAttribute('aria-expanded', open ? 'true' : 'false');
                    }
                }
                break;
            case 'hidehint':
                tipclosed = true;
                refreshTip();
                break;
            default:
                break;
        }
    });
    const cue = modelscroll ? modelscroll.querySelector('.mod_vrmakerspace-morecue') : null;
    on(cue, 'click', () => {
        if (modelpanel) {
            modelpanel.scrollBy({left: Math.round(modelpanel.clientWidth * 0.6), behavior: 'smooth'});
        }
    });
    on(modelpanel, 'scroll', refreshCue);
    on(window, 'resize', refreshCue);
    on(region('canvas'), 'pointerdown', () => openBrush(false));
    // The tutorial asks for all the tools when a step points at one behind More (not remembered as the person's choice).
    on(root, 'mod_vrmakerspace:alltools', () => setAll(true));

    // Panels that scroll up and down (the phone's More sheet, the help) end on a fade with a chevron while more
    // follows below, so nothing looks cut off.
    const scrollers = [tray, helppanel].filter((element) => !!element).map((element) => {
        const hint = document.createElement('div');
        hint.className = 'mod_vrmakerspace-morebelow d-none';
        hint.setAttribute('aria-hidden', 'true');
        element.appendChild(hint);
        on(element, 'scroll', () => refreshScrollHints());
        return {element, hint};
    });
    /** Show each panel's "more below" while it has more below. */
    function refreshScrollHints() {
        scrollers.forEach(({element, hint}) => {
            // Tools moved into the tray after the hint was made: keep the hint last, where it sticks to the bottom.
            if (element.lastElementChild !== hint) {
                element.appendChild(hint);
            }
            const more = element.scrollHeight - element.clientHeight - element.scrollTop > 4;
            hint.classList.toggle('d-none', !more);
        });
    }
    on(window, 'resize', refreshScrollHints);

    decorate(root);
    if (moretools && readCookie(TOOLS_COOKIE) === 'all') {
        setAll(true);
    }
    // The tools dock inside the 3D view, in a glass bar along its top edge: the view keeps its height, and desktop
    // and phone look the same.
    const stage = region('stage');
    if (stage && toolbar && toolbar.parentNode !== stage) {
        stage.insertBefore(toolbar, stage.firstChild);
        root.classList.add('mod_vrmakerspace-docked');
    }
    if (typeof window.matchMedia === 'function') {
        const phonequery = window.matchMedia(PHONE);
        placeTools(phonequery.matches);
        on(phonequery, 'change', () => placeTools(phonequery.matches));
    }
    refreshSaved();
    timer = window.setInterval(refreshSaved, SAVED_TICK);

    return {
        /** Follow a change of tool, action or selection. */
        refresh: () => {
            refreshTip();
        },

        /**
         * Follow the method in use.
         *
         * @param {string} name 'sculpt' or 'model'.
         */
        setMethod: (name) => {
            method = name === 'model' ? 'model' : 'sculpt';
            root.classList.toggle('mod_vrmakerspace-method-model', method === 'model');
            root.classList.toggle('mod_vrmakerspace-method-sculpt', method !== 'model');
            if (modelscroll) {
                modelscroll.classList.toggle('d-none', method !== 'model');
            }
            refreshTip();
            refreshCue();
        },

        /** The person changed the piece. */
        changed: () => {
            changes++;
            // They have found how it works: the pictures of the controls fade, the "?" stays.
            if (legend) {
                legend.classList.add('mod_vrmakerspace-legendfaded');
            }
            if (!pending) {
                pending = true;
                refreshSaved();
            }
            refreshTip();
        },

        /** The piece was saved. */
        saved: () => {
            lastsaved = Date.now();
            pending = false;
            refreshSaved();
        },

        /**
         * Show who is here in a group piece.
         *
         * @param {string[]} names The names of the others present.
         */
        peers: (names) => {
            if (!members) {
                return;
            }
            const here = new Set((names || []).map(String));
            members.querySelectorAll('[data-name]').forEach((item) => {
                if (item.dataset.you === '1') {
                    return;
                }
                const present = here.has(item.dataset.name);
                item.classList.toggle('mod_vrmakerspace-here', present);
                item.title = present ? (item.dataset.hereLabel || '') : (item.dataset.awayLabel || '');
            });
        },

        /** Stop. */
        dispose: () => {
            listeners.forEach((off) => off());
            if (timer) {
                window.clearInterval(timer);
            }
            window.clearTimeout(donetimer);
        },
    };
};
