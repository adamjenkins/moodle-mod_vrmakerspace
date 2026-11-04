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
 * The studio toolbar (templates/studio.mustache): the method switch, the Sculpt panel (tool buttons
 * with aria-pressed, the mirror switch, the shape tools' shape and letters, shown while a shape tool is
 * chosen, brush size and strength sliders), the Model panel (select modes and commands, the shapes menu,
 * tools, axis lock, segments, one-shot commands, the confirmation of Turn into clay), undo and redo, save
 * now, the export menu, Enter VR, full screen, the keyboard help of the method in use, and the status
 * region (a polite live region) with the connection state and the latest message.
 *
 * The toolbar only binds to the markup the template rendered; every label comes from the template
 * or from the strings the studio loaded.
 *
 * @module     mod_vrmakerspace/toolbar
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';

/**
 * Find one element of the studio by its data-region.
 *
 * @param {HTMLElement} root Studio root.
 * @param {string} name Region name.
 * @returns {HTMLElement|null}
 */
const region = (root, name) => root.querySelector(`[data-region="${name}"]`);

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
 * Show which of a set of buttons is the chosen one.
 *
 * @param {HTMLElement} root Studio root.
 * @param {string} action The buttons' data-action.
 * @param {Function} isChosen Takes a button, returns whether it is the chosen one.
 */
const press = (root, action, isChosen) => {
    root.querySelectorAll(`[data-action="${action}"]`).forEach((button) => {
        const pressed = !!isChosen(button);
        button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        button.classList.toggle('active', pressed);
    });
};

/**
 * Bind the toolbar.
 *
 * @param {HTMLElement} root Studio root element.
 * @param {Object} options {strings, tools (null when read-only), handlers: {save(), exportModel(format), vr(),
 *     fullscreen(), method(name), addShape(shape), selectLoop(), askBake(), confirmBake(), cancelBake()}}
 * @returns {Object} {refresh(), setTools(tools), setModel(model), setMethods(names), setMethod(name), setOpenEdges(count),
 *     showBakeConfirm(visible), setStatus(text), message(text, timeout), setVr(available, active), setFullscreen(active),
 *     setSaving(saving), setSaveAllowed(allowed), dispose()}
 */
export const createToolbar = (root, options) => {
    const strings = options.strings || {};
    let tools = options.tools || null;
    /** @type {Object|null} the modelling tools, in an activity that has the Model method */
    let model = null;
    let method = 'sculpt';
    let vravailable = false;
    const handlers = options.handlers || {};
    const toolbar = region(root, 'toolbar');
    const size = region(root, 'size');
    const strength = region(root, 'strength');
    const statustext = region(root, 'statustext');
    const messagetext = region(root, 'message');
    const vrbutton = root.querySelector('[data-action="vr"]');
    const fullbutton = root.querySelector('[data-action="fullscreen"]');
    const savebutton = root.querySelector('[data-action="save"]');
    const undobutton = root.querySelector('[data-action="undo"]');
    const redobutton = root.querySelector('[data-action="redo"]');
    const vrhelp = region(root, 'vrhelp');
    const mirrorbutton = root.querySelector('[data-action="mirror"]');
    const shapeoptions = region(root, 'shapeoptions');
    const shapeselect = region(root, 'shape');
    const textinput = region(root, 'text');
    const textfield = region(root, 'textfield');
    const methodswitch = region(root, 'methodswitch');
    const sculptpanel = region(root, 'sculptpanel');
    const modelpanel = region(root, 'modelpanel');
    const sculpthelp = region(root, 'sculpthelp');
    const modelhelp = region(root, 'modelhelp');
    const vrmodelhelp = region(root, 'vrmodelhelp');
    const segments = region(root, 'segments');
    const openedges = region(root, 'openedges');
    const bakeconfirm = region(root, 'bakeconfirm');
    let messagetimer = null;
    let saving = false;
    let saveallowed = true;

    /**
     * Run a handler, logging a failure.
     *
     * @param {string} name Handler name.
     * @param {...*} args Arguments.
     */
    const run = (name, ...args) => {
        if (typeof handlers[name] !== 'function') {
            return;
        }
        try {
            const result = handlers[name](...args);
            if (result && typeof result.catch === 'function') {
                result.catch((error) => Log.debug(error));
            }
        } catch (e) {
            Log.debug(e);
        }
    };

    /** The Select commands of the Model panel: data-select -> what it does. */
    const SELECT_COMMANDS = {
        all: () => model.selectAll(),
        none: () => model.selectNone(),
        linked: () => model.selectLinked(),
        loop: () => run('selectLoop'),
    };

    /** The Model panel's buttons: data-action -> what a click does. */
    const MODEL_ACTIONS = {
        selectmode: (button) => model.setSelectMode(button.dataset.mode),
        select: (button) => {
            if (SELECT_COMMANDS[button.dataset.select]) {
                SELECT_COMMANDS[button.dataset.select]();
            }
        },
        modelaction: (button) => model.setAction(button.dataset.tool),
        axis: (button) => model.setAxis(button.dataset.axis === 'free' ? null : button.dataset.axis),
        oneshot: (button) => {
            if (button.dataset.oneshot === 'bake') {
                run('askBake');
            } else {
                model.runOneShot(button.dataset.oneshot);
            }
        },
        addshape: (button) => run('addShape', button.dataset.shape),
        bakeconfirm: () => run('confirmBake'),
        bakecancel: () => run('cancelBake'),
    };

    /**
     * Whether a tool gesture is going on: nothing changes under it, undo included.
     *
     * @returns {boolean}
     */
    const busy = () => !!(model && model.active);

    /** The buttons that work the tools: data-action -> what a click does. */
    const TOOL_ACTIONS = {
        tool: (button) => tools.setTool(button.dataset.tool),
        undo: () => {
            if (!busy()) {
                tools.undo();
            }
        },
        redo: () => {
            if (!busy()) {
                tools.redo();
            }
        },
        mirror: () => tools.setMirror(!tools.mirror),
    };

    /**
     * Clicks anywhere in the toolbar.
     *
     * @param {MouseEvent} event The event.
     */
    const onClick = (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || !root.contains(button) || button.disabled) {
            return;
        }
        const action = button.dataset.action;
        if (MODEL_ACTIONS[action]) {
            if (model && !busy()) {
                MODEL_ACTIONS[action](button);
            }
            return;
        }
        if (TOOL_ACTIONS[action]) {
            if (tools) {
                TOOL_ACTIONS[action](button);
            }
            return;
        }
        switch (action) {
            case 'method':
                run('method', button.dataset.method);
                break;
            case 'save':
                run('save');
                break;
            case 'export':
                event.preventDefault();
                run('exportModel', button.dataset.format);
                break;
            case 'vr':
                run('vr');
                break;
            case 'fullscreen':
                run('fullscreen');
                break;
            default:
                break;
        }
    };

    /**
     * Slider changes.
     *
     * @param {Event} event The event.
     */
    const onInput = (event) => {
        if (event.target === segments) {
            const value = Number(segments.value);
            if (model && segments.value !== '' && Number.isInteger(value)) {
                model.setSegments(value);
            }
            return;
        }
        if (!tools) {
            return;
        }
        if (event.target === size) {
            tools.setSize(Number(size.value) / 1000);
        } else if (event.target === strength) {
            tools.setStrength(Number(strength.value) / 100);
        } else if (event.target === shapeselect) {
            tools.setShape(shapeselect.value);
        } else if (event.target === textinput) {
            tools.setText(textinput.value);
        }
    };

    root.addEventListener('click', onClick);
    if (toolbar) {
        toolbar.addEventListener('input', onInput);
    }

    /** Show the modelling tools' state: select mode, tool, axis lock and segments. */
    const refreshModel = () => {
        if (!model) {
            return;
        }
        press(root, 'selectmode', (button) => button.dataset.mode === model.selectMode);
        press(root, 'modelaction', (button) => button.dataset.tool === model.action);
        press(root, 'axis', (button) => button.dataset.axis === (model.axis || 'free'));
        if (segments) {
            // Bevel, Loop cut and the shapes each have their own range.
            const range = model.segmentRange();
            segments.min = String(range.min);
            segments.max = String(range.max);
            if (document.activeElement !== segments) {
                segments.value = String(model.segments);
            }
        }
    };

    /** Show the tools' state: pressed tool, sliders, undo and redo. */
    const refresh = () => {
        refreshModel();
        if (!tools) {
            return;
        }
        press(root, 'tool', (button) => button.dataset.tool === tools.tool);
        if (size && document.activeElement !== size) {
            size.value = String(Math.round(tools.size * 1000));
        }
        if (strength && document.activeElement !== strength) {
            strength.value = String(Math.round(tools.strength * 100));
        }
        if (undobutton) {
            undobutton.disabled = !tools.canUndo();
        }
        if (redobutton) {
            redobutton.disabled = !tools.canRedo();
        }
        if (mirrorbutton) {
            mirrorbutton.setAttribute('aria-pressed', tools.mirror ? 'true' : 'false');
            mirrorbutton.classList.toggle('active', tools.mirror);
        }
        const shapetool = tools.tool === 'shape' || tools.tool === 'cutshape';
        show(shapeoptions, shapetool);
        if (shapeselect && document.activeElement !== shapeselect) {
            shapeselect.value = tools.shape;
        }
        show(textfield, shapetool && tools.shape === 'text');
        if (textinput && document.activeElement !== textinput) {
            textinput.value = tools.text;
        }
    };

    /** Show the panel and the keyboard help of the method in use. */
    const refreshMethod = () => {
        const modelling = method === 'model';
        press(root, 'method', (button) => button.dataset.method === method);
        show(sculptpanel, !modelling);
        show(modelpanel, modelling);
        show(sculpthelp, !modelling);
        show(modelhelp, modelling);
        show(vrhelp, vravailable && !modelling);
        show(vrmodelhelp, vravailable && modelling);
        show(openedges, modelling && !!openedges && openedges.textContent !== '');
    };

    /** Enable the save button when saving is allowed and none is running. */
    const refreshSave = () => {
        if (savebutton) {
            savebutton.disabled = saving || !saveallowed;
        }
    };

    refresh();
    refreshSave();
    refreshMethod();

    return {
        refresh: refresh,

        /**
         * Bind the tools once the session has started.
         *
         * @param {Object|null} value Tools, or null when read-only.
         */
        setTools: (value) => {
            tools = value || null;
            refresh();
        },

        /**
         * Bind the modelling tools once the session has started.
         *
         * @param {Object|null} value Modelling tools, or null when the activity or the viewer has none.
         */
        setModel: (value) => {
            model = value || null;
            refresh();
        },

        /**
         * Say which methods the activity allows: the switch only shows when there is a choice.
         *
         * @param {string[]} names 'sculpt', 'model' or both.
         */
        setMethods: (names) => {
            const list = Array.isArray(names) ? names : [];
            show(methodswitch, list.length > 1);
        },

        /**
         * Show a method as the one in use.
         *
         * @param {string} name 'sculpt' or 'model'.
         */
        setMethod: (name) => {
            method = name === 'model' ? 'model' : 'sculpt';
            refreshMethod();
        },

        /**
         * Show how many open edges the mesh has (Model method only). Not in the live region: the number
         * changes while people work.
         *
         * @param {number} count Open edges.
         */
        setOpenEdges: (count) => {
            if (!openedges) {
                return;
            }
            const text = count > 0 ? String(strings.modelopenedges || '').split('{$a}').join(String(count)) : '';
            if (openedges.textContent !== text) {
                openedges.textContent = text;
                refreshMethod();
            }
        },

        /**
         * Show or hide the confirmation of Turn into clay, moving the focus into it.
         *
         * @param {boolean} visible Whether it shows.
         */
        showBakeConfirm: (visible) => {
            show(bakeconfirm, visible);
            if (visible && bakeconfirm) {
                const button = bakeconfirm.querySelector('[data-action="bakeconfirm"]');
                if (button) {
                    button.focus();
                }
            }
        },

        /**
         * Whether the confirmation of Turn into clay shows.
         *
         * @returns {boolean}
         */
        bakeConfirmShown: () => !!bakeconfirm && !bakeconfirm.classList.contains('d-none'),

        /**
         * Show the connection state.
         *
         * @param {string} text Status text.
         */
        setStatus: (text) => {
            if (statustext) {
                statustext.textContent = text || '';
            }
        },

        /**
         * Show a message, optionally only for a while.
         *
         * @param {string} text The message ('' clears it).
         * @param {number} [timeout] Milliseconds before it is cleared; 0 keeps it.
         */
        message: (text, timeout = 0) => {
            if (!messagetext) {
                return;
            }
            if (messagetimer) {
                window.clearTimeout(messagetimer);
                messagetimer = null;
            }
            messagetext.textContent = text || '';
            if (timeout > 0 && text) {
                messagetimer = window.setTimeout(() => {
                    messagetimer = null;
                    if (messagetext.textContent === text) {
                        messagetext.textContent = '';
                    }
                }, timeout);
            }
        },

        /**
         * Show the VR button.
         *
         * @param {boolean} available Whether immersive VR can start here.
         * @param {boolean} active Whether a VR session runs.
         */
        setVr: (available, active) => {
            vravailable = !!available;
            show(vrbutton, available);
            refreshMethod();
            if (vrbutton) {
                vrbutton.textContent = active ? (strings.exitvr || '') : (strings.entervr || '');
                vrbutton.setAttribute('aria-pressed', active ? 'true' : 'false');
            }
        },

        /**
         * Show the full screen state.
         *
         * @param {boolean} active Whether the studio fills the screen.
         */
        setFullscreen: (active) => {
            if (fullbutton) {
                fullbutton.setAttribute('aria-pressed', active ? 'true' : 'false');
            }
        },

        /**
         * Show that a save is running.
         *
         * @param {boolean} value Whether it is.
         */
        setSaving: (value) => {
            saving = !!value;
            refreshSave();
        },

        /**
         * Allow or forbid saving (a closed piece is not saved).
         *
         * @param {boolean} allowed Whether saving is allowed.
         */
        setSaveAllowed: (allowed) => {
            saveallowed = !!allowed;
            refreshSave();
        },

        /** Remove the listeners. */
        dispose: () => {
            root.removeEventListener('click', onClick);
            if (toolbar) {
                toolbar.removeEventListener('input', onInput);
            }
            if (messagetimer) {
                window.clearTimeout(messagetimer);
            }
        },
    };
};
