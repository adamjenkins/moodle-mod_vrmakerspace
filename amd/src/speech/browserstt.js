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
 * Listening through the browser's speech recognition (Web Speech API).
 *
 * Recognition runs while the student holds the Talk button, with interim
 * results, and restarts itself when the browser ends a session early (Chrome
 * does after a silence or a network hiccup). When the button is let go,
 * finish() stops it and gives everything heard. Where the browser offers
 * on-device recognition (Chrome 139+ "processLocally"), it is used, so no
 * audio leaves the computer. Firefox has no speech recognition: there,
 * supported() is false and the next way in the site's order is used.
 *
 * Copied from mod_talkwithai/speech/browserstt (same author), renamed, and
 * given finish() for push to talk.
 *
 * @module     mod_vrmakerspace/speech/browserstt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** How long finish() waits for the last results after stopping, in ms. */
const FINISH_WAIT = 1500;

/**
 * The SpeechRecognition constructor, or null.
 *
 * @returns {Function|null}
 */
const recognitionClass = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

/**
 * Speech recognition in the browser.
 */
export class BrowserListener {
    /**
     * Whether the browser can recognise speech at all.
     *
     * @returns {boolean}
     */
    static supported() {
        return !!recognitionClass();
    }

    /**
     * Whether on-device recognition is available for a language.
     *
     * @param {string} lang BCP 47 tag
     * @returns {Promise<string>} 'available', 'downloadable', 'downloading' or 'unavailable'
     */
    static async local(lang) {
        const R = recognitionClass();
        if (!R || typeof R.available !== 'function') {
            return 'unavailable';
        }
        try {
            return await R.available({langs: [lang], processLocally: true});
        } catch (e) {
            return 'unavailable';
        }
    }

    /**
     * @param {Object} options
     * @param {string} options.lang BCP 47 tag
     * @param {boolean} options.local Use on-device recognition
     * @param {Function} [options.ontext] Called with (text, isfinal) as words come in
     * @param {Function} [options.onerror] Called with an error code ('not-allowed', 'network', 'stopped'...)
     */
    constructor(options) {
        this.options = options;
        this.running = false;
        this.failures = 0;
        this.finals = [];
        this.interim = '';
        this.ended = null;
    }

    /**
     * Starts listening (a new question: what was heard before is forgotten).
     */
    start() {
        if (this.running) {
            return;
        }
        this.finals = [];
        this.interim = '';
        this.running = true;
        this.open();
    }

    /**
     * Everything heard so far.
     *
     * @returns {string}
     */
    heard() {
        return this.finals.concat(this.interim ? [this.interim] : []).join(' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * Takes the results of a recognition event.
     *
     * @param {SpeechRecognitionEvent} e
     */
    results(e) {
        this.failures = 0;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const text = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                if (text.trim() !== '') {
                    this.finals.push(text.trim());
                    if (this.options.ontext) {
                        this.options.ontext(text.trim(), true);
                    }
                }
            } else {
                interim += text;
            }
        }
        this.interim = interim.trim();
        if (this.interim !== '' && this.options.ontext) {
            this.options.ontext(this.interim, false);
        }
    }

    /**
     * Opens a recognition session.
     */
    open() {
        const R = recognitionClass();
        const rec = new R();
        rec.lang = this.options.lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        if (this.options.local && 'processLocally' in rec) {
            rec.processLocally = true;
        }
        rec.onresult = (e) => this.results(e);
        rec.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') {
                return;
            }
            this.failures++;
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') {
                this.running = false;
            }
            if (this.options.onerror) {
                this.options.onerror(e.error);
            }
        };
        rec.onend = () => {
            if (this.rec !== rec) {
                return;
            }
            this.rec = null;
            if (this.ended) {
                this.ended();
                return;
            }
            if (this.running && this.failures < 5) {
                // Restart after a short pause; back off when the service keeps failing.
                setTimeout(() => {
                    if (this.running && !this.rec) {
                        this.open();
                    }
                }, 150 + this.failures * 500);
            } else if (this.running) {
                this.running = false;
                if (this.options.onerror) {
                    this.options.onerror('stopped');
                }
            }
        };
        this.rec = rec;
        try {
            rec.start();
        } catch (e) {
            // Already started.
        }
    }

    /**
     * Stops listening and gives what was heard, once the last results are in.
     *
     * @returns {Promise<string>}
     */
    finish() {
        this.running = false;
        const rec = this.rec;
        if (!rec) {
            return Promise.resolve(this.heard());
        }
        return new Promise((resolve) => {
            let done = false;
            const end = () => {
                if (!done) {
                    done = true;
                    this.ended = null;
                    if (this.rec === rec) {
                        this.rec = null;
                    }
                    resolve(this.heard());
                }
            };
            this.ended = end;
            setTimeout(end, FINISH_WAIT);
            try {
                // Calling stop(), not abort(), lets the recogniser send what it heard last.
                rec.stop();
            } catch (e) {
                end();
            }
        });
    }

    /**
     * Stops listening and drops what was heard.
     */
    stop() {
        this.running = false;
        this.ended = null;
        if (this.rec) {
            const rec = this.rec;
            this.rec = null;
            try {
                rec.abort();
            } catch (e) {
                // Already stopped.
            }
        }
        this.finals = [];
        this.interim = '';
    }

    /**
     * Stops listening (the same shape as the server listener).
     */
    destroy() {
        this.stop();
    }
}
