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
 * A small event emitter for the collaboration client (session and transports).
 *
 * Listener errors are caught and logged, never thrown into the emitting code, so one broken
 * listener cannot stop the network code. The same contract as the emitter of
 * vrroomruntime_builtin/live/transport.
 *
 * @module     mod_vrsculpt/net/emitter
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';

/**
 * Minimal event emitter.
 */
export class Emitter {
    /**
     * Constructor.
     */
    constructor() {
        /** @type {Map<string, Array<{fn: Function}>>} */
        this.listeners = new Map();
    }

    /**
     * Add a listener.
     *
     * @param {string} type Event type.
     * @param {Function} listener Called with the event detail.
     * @returns {Function} Call it to remove this listener again.
     */
    on(type, listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('Listener must be a function');
        }
        const entry = {fn: listener};
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push(entry);
        return () => {
            const list = this.listeners.get(type);
            if (!list) {
                return;
            }
            const index = list.indexOf(entry);
            if (index !== -1) {
                list.splice(index, 1);
            }
            if (!list.length) {
                this.listeners.delete(type);
            }
        };
    }

    /**
     * Call every listener of a type with the detail.
     *
     * @param {string} type Event type.
     * @param {*} detail Event detail.
     */
    emit(type, detail) {
        const list = this.listeners.get(type);
        if (!list) {
            return;
        }
        list.slice().forEach((entry) => {
            try {
                entry.fn(detail);
            } catch (error) {
                Log.error(error);
            }
        });
    }

    /**
     * Remove every listener.
     */
    removeAllListeners() {
        this.listeners.clear();
    }
}
