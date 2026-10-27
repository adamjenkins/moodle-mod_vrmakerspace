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
 * The studio toolbar (templates/studio.mustache): tool buttons (aria-pressed), brush size and
 * strength sliders, undo and redo, save now, the export menu, Enter VR, full screen, and the status
 * region (a polite live region) with the connection state and the latest message.
 *
 * The toolbar only binds to the markup the template rendered; every label comes from the template
 * or from the strings the studio loaded.
 *
 * @module     mod_vrsculpt/toolbar
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
 * Bind the toolbar.
 *
 * @param {HTMLElement} root Studio root element.
 * @param {Object} options {strings, tools (null when read-only), handlers: {save(), exportModel(format), vr(),
 *     fullscreen()}}
 * @returns {Object} {refresh(), setTools(tools), setStatus(text), message(text, timeout), setVr(available, active),
 *     setFullscreen(active), setSaving(saving), setSaveAllowed(allowed), dispose()}
 */
export const createToolbar = (root, options) => {
    const strings = options.strings || {};
    let tools = options.tools || null;
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
        switch (action) {
            case 'tool':
                if (tools) {
                    tools.setTool(button.dataset.tool);
                }
                break;
            case 'undo':
                if (tools) {
                    tools.undo();
                }
                break;
            case 'redo':
                if (tools) {
                    tools.redo();
                }
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
        if (!tools) {
            return;
        }
        if (event.target === size) {
            tools.setSize(Number(size.value) / 1000);
        } else if (event.target === strength) {
            tools.setStrength(Number(strength.value) / 100);
        }
    };

    root.addEventListener('click', onClick);
    if (toolbar) {
        toolbar.addEventListener('input', onInput);
    }

    /** Show the tools' state: pressed tool, sliders, undo and redo. */
    const refresh = () => {
        if (!tools) {
            return;
        }
        root.querySelectorAll('[data-action="tool"]').forEach((button) => {
            const pressed = button.dataset.tool === tools.tool;
            button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
            button.classList.toggle('active', pressed);
        });
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
    };

    /** Enable the save button when saving is allowed and none is running. */
    const refreshSave = () => {
        if (savebutton) {
            savebutton.disabled = saving || !saveallowed;
        }
    };

    refresh();
    refreshSave();

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
            show(vrbutton, available);
            show(vrhelp, available);
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
         * Allow or forbid saving (a closed sculpture is not saved).
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
