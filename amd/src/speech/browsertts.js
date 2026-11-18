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
 * The tutor's voice through the browser's own speech synthesiser (Web Speech API).
 *
 * A text is spoken one sentence chunk at a time: that avoids Chrome cutting
 * off long utterances. The browser's voice cannot go through Web Audio, so it
 * does not come from the tutor's place, and the mouth moves with a babble that
 * follows the word boundary events when the voice sends them.
 *
 * Voice loading waits for the asynchronous voice list with a timeout, an
 * approach also used by EasySpeech (Jan Küster, MIT); voices are ranked by
 * language match, an explicit name, on-device availability and quality hints
 * in the name, an idea also used by Saylor's AI Course Assistant for Moodle.
 *
 * Some browsers accept an utterance and never speak it (no voice installed, no
 * audio output, Firefox on some Linux desktops): when nothing has started
 * after 2.5 s the voice is taken not to work, and the caller falls back.
 *
 * Copied from mod_talkwithai/speech/browsertts (same author), renamed, and
 * reduced to a babble lip sync.
 *
 * @module     mod_vrmakerspace/speech/browsertts
 * @copyright  2021 Jan Küster
 * @copyright  2025 AI Course Assistant
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** If the synthesiser has not started speaking after this long, it is taken not to work, in ms. */
const START_TIMEOUT = 2500;

/** Words in voice names that usually mean a better voice. */
const QUALITY = /natural|neural|premium|enhanced|online|wavenet|siri/i;

/** Longest time allowed per character before a chunk is taken as finished, in ms. */
const MS_PER_CHAR = 200;

/**
 * Speaks with speechSynthesis.
 */
export class BrowserSpeaker {
    /**
     * Whether the browser can speak.
     *
     * @returns {boolean}
     */
    static supported() {
        return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    }

    /**
     * Waits for the voice list (it loads asynchronously in Chrome) and returns it.
     *
     * @returns {Promise<SpeechSynthesisVoice[]>}
     */
    static loadVoices() {
        return new Promise(resolve => {
            const now = window.speechSynthesis.getVoices();
            if (now.length) {
                resolve(now);
                return;
            }
            let done = false;
            const finish = () => {
                if (!done) {
                    done = true;
                    resolve(window.speechSynthesis.getVoices());
                }
            };
            window.speechSynthesis.addEventListener('voiceschanged', finish, {once: true});
            // Some browsers never fire the event; poll briefly, then give up.
            let tries = 0;
            const poll = setInterval(() => {
                tries++;
                if (window.speechSynthesis.getVoices().length || tries > 20) {
                    clearInterval(poll);
                    finish();
                }
            }, 100);
        });
    }

    /**
     * Voices for a language, best first.
     *
     * @param {SpeechSynthesisVoice[]} voices
     * @param {string} lang BCP 47 tag
     * @param {string} preferred A voice name, or 'female' / 'male' as a hint
     * @returns {SpeechSynthesisVoice[]}
     */
    static rank(voices, lang, preferred) {
        const want = (lang || 'en').toLowerCase();
        const primary = want.split('-')[0];
        const hint = preferred === 'female' || preferred === 'male' ? new RegExp(`\\b${preferred}\\b`, 'i') : null;
        const score = (v) => {
            const vl = (v.lang || '').toLowerCase().replace('_', '-');
            let s = 0;
            if (preferred && v.name === preferred) {
                s += 1000;
            }
            if (vl === want) {
                s += 100;
            } else if (vl.split('-')[0] === primary) {
                s += 60;
            } else {
                return -1;
            }
            if (hint && hint.test(v.name)) {
                s += 30;
            }
            if (QUALITY.test(v.name)) {
                s += 20;
            }
            if (v.localService) {
                s += 10;
            }
            if (v.default) {
                s += 2;
            }
            return s;
        };
        return voices.map(v => ({v, s: score(v)})).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.v);
    }

    /**
     * @param {Object} options
     * @param {string} options.lang BCP 47 tag
     * @param {string} [options.voice] Preferred voice name, or 'female' / 'male'
     */
    constructor(options) {
        this.lang = options.lang;
        this.preferred = options.voice || '';
        this.voice = null;
        this.active = false;
        this.talking = false;
        this.pulse = 0;
        this.rate = 1;
        this.volume = 1;
        this.mute = false;
    }

    /**
     * Picks the voice.
     *
     * @returns {Promise<SpeechSynthesisVoice|null>}
     */
    async init() {
        const voices = await BrowserSpeaker.loadVoices();
        this.voice = BrowserSpeaker.rank(voices, this.lang, this.preferred)[0] || null;
        return this.voice;
    }

    /**
     * Makes the utterance of one chunk.
     *
     * @param {string} text
     * @returns {SpeechSynthesisUtterance}
     */
    utterance(text) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = this.voice ? this.voice.lang : this.lang;
        if (this.voice) {
            u.voice = this.voice;
        }
        u.rate = this.rate;
        u.volume = this.volume;
        return u;
    }

    /**
     * Speaks a text chunk by chunk.
     *
     * @param {string[]} chunks Sentence chunks (speech/textsplit split())
     * @param {Object} handlers {onchunk(index)}
     * @returns {Promise<boolean>} true when everything was spoken, false when cancelled; rejects when the voice
     *     never started (then this speaker stays mute)
     */
    speak(chunks, handlers = {}) {
        this.cancel();
        this.active = true;
        this.index = 0;
        const run = this.runid = (this.runid || 0) + 1;
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            if (this.mute) {
                this.active = false;
                reject(new Error('mute'));
                return;
            }
            let started = false;
            const next = () => {
                if (run !== this.runid || !this.active) {
                    return;
                }
                if (this.index >= chunks.length) {
                    this.active = false;
                    this.talking = false;
                    resolve(true);
                    return;
                }
                const text = chunks[this.index];
                const u = this.utterance(text);
                const nostart = setTimeout(() => {
                    if (run === this.runid && !started) {
                        // Accepted but never spoken: give up on this voice for the page.
                        this.mute = true;
                        this.runid++;
                        this.active = false;
                        window.speechSynthesis.cancel();
                        reject(new Error('mute'));
                    }
                }, START_TIMEOUT);
                const toolong = setTimeout(() => {
                    if (run === this.runid) {
                        finished();
                    }
                }, Math.max(4000, text.length * MS_PER_CHAR));
                u.onstart = () => {
                    clearTimeout(nostart);
                    if (run !== this.runid) {
                        return;
                    }
                    started = true;
                    this.talking = true;
                    this.pulse = performance.now();
                    if (handlers.onchunk) {
                        handlers.onchunk(this.index);
                    }
                };
                u.onboundary = (e) => {
                    if (run === this.runid && e.name !== 'sentence') {
                        this.pulse = performance.now();
                    }
                };
                const finished = () => {
                    clearTimeout(nostart);
                    clearTimeout(toolong);
                    if (run !== this.runid) {
                        return;
                    }
                    this.talking = false;
                    this.index++;
                    next();
                };
                u.onend = finished;
                u.onerror = (e) => {
                    if (e.error === 'interrupted' || e.error === 'canceled') {
                        return;
                    }
                    finished();
                };
                // Keep a reference: Chrome may garbage-collect an utterance and never fire onend.
                this.current = u;
                window.speechSynthesis.speak(u);
            };
            // Chrome can drop an utterance queued in the same tick as cancel().
            setTimeout(next, 60);
        });
    }

    /**
     * How open the mouth is now, 0..1: a babble while a chunk is spoken, a little wider just after a word starts.
     *
     * @returns {number}
     */
    loudness() {
        if (!this.talking) {
            return 0;
        }
        const now = performance.now();
        const sinceword = (now - this.pulse) / 1000;
        const babble = 0.35 + 0.3 * Math.abs(Math.sin(now / 1000 * 11));
        return Math.min(1, babble + Math.max(0, 0.35 - sinceword * 1.5));
    }

    /**
     * Whether something is being spoken.
     *
     * @returns {boolean}
     */
    isSpeaking() {
        return this.active;
    }

    /**
     * Speech synthesis cannot be turned down while it speaks.
     */
    duck() {
        // Nothing to do.
    }

    /**
     * Stops speaking.
     */
    cancel() {
        this.runid = (this.runid || 0) + 1;
        const wasactive = this.active;
        this.active = false;
        this.talking = false;
        if (BrowserSpeaker.supported()) {
            window.speechSynthesis.cancel();
        }
        if (wasactive && this.resolve) {
            this.resolve(false);
        }
    }

    /**
     * Stops speaking (the same shape as the server speaker).
     */
    destroy() {
        this.cancel();
    }
}
