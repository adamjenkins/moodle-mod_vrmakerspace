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
 * A small voice activity detector on the microphone, by loudness.
 *
 * It measures the RMS level of the microphone in decibels every 30 ms and
 * keeps an adaptive noise floor. Speech starts when the level stays a margin
 * above the floor for a minimum time, and ends after a "redemption" period of
 * quiet, so short pauses inside a sentence do not end it. Very short bursts
 * are reported as misfires. This start/end hysteresis with redemption and
 * minimum speech length follows the structure of ricky0123's vad-web (ISC),
 * with a loudness measure in place of its neural model.
 *
 * The tutor uses it for the level meter on the Talk button, and to end a
 * question by itself when the student tapped Talk (instead of holding it) and
 * then stopped speaking.
 *
 * While the tutor is speaking, its own voice leaks into the microphone on
 * laptop speakers; the detector then also learns an "echo floor" and asks for
 * a bigger margin above it.
 *
 * Copied from mod_talkwithai/speech/vad (same author) and renamed.
 *
 * @module     mod_vrmakerspace/speech/vad
 * @copyright  2022 ricky0123
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/**
 * Loudness-based voice activity detector.
 */
export class Vad {
    /**
     * @param {AudioContext} audioctx
     * @param {MediaStream} stream Microphone stream
     * @param {Object} handlers {onstart(), onend(durationms), onmisfire(), onlevel(level 0..1)}
     */
    constructor(audioctx, stream, handlers = {}) {
        this.ctx = audioctx;
        this.handlers = handlers;
        this.source = audioctx.createMediaStreamSource(stream);
        this.analyser = audioctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.source.connect(this.analyser);
        this.buffer = new Float32Array(this.analyser.fftSize);

        this.floor = -60;
        this.echofloor = -70;
        this.echo = false;
        this.speaking = false;
        this.above = 0;
        this.below = 0;
        this.started = 0;
        this.headphones = false;
        this.enabled = true;

        /** Margin above the noise floor that counts as speech, in dB. */
        this.margin = 12;
        /** Extra margin above the tutor's echo, in dB. */
        this.echomargin = 9;
        /** Time above the threshold before speech starts, in ms. */
        this.minstart = 120;
        /** Quiet time that ends speech, in ms. */
        this.redemption = 900;
        /** Speech shorter than this is a misfire, in ms. */
        this.minspeech = 250;

        this.last = performance.now();
        this.tick = this.tick.bind(this);
        this.timer = setInterval(this.tick, 30);
    }

    /**
     * Current level in dB.
     *
     * @returns {number}
     */
    measure() {
        this.analyser.getFloatTimeDomainData(this.buffer);
        let sum = 0;
        for (let i = 0; i < this.buffer.length; i++) {
            sum += this.buffer[i] * this.buffer[i];
        }
        const rms = Math.sqrt(sum / this.buffer.length);
        return 20 * Math.log10(Math.max(rms, 1e-6));
    }

    /**
     * Tells the detector whether the tutor is speaking now.
     *
     * @param {boolean} on
     */
    setEcho(on) {
        this.echo = on && !this.headphones;
    }

    /**
     * Headphones mode: no echo, so lower margins.
     *
     * @param {boolean} on
     */
    setHeadphones(on) {
        this.headphones = on;
        this.margin = on ? 10 : 12;
        if (on) {
            this.echo = false;
        }
    }

    /**
     * Forgets a speech in progress (a new question starts).
     */
    reset() {
        this.speaking = false;
        this.above = 0;
        this.below = 0;
    }

    /**
     * Updates the noise and echo floors from a level.
     *
     * @param {number} db
     */
    learn(db) {
        // The floor follows quiet levels quickly and loud ones very slowly.
        if (!this.speaking) {
            const k = db < this.floor ? 0.2 : 0.004;
            this.floor += (db - this.floor) * k;
            this.floor = Math.max(-90, Math.min(-25, this.floor));
        }
        if (this.echo && !this.speaking) {
            const k = db > this.echofloor ? 0.1 : 0.02;
            this.echofloor += (db - this.echofloor) * k;
        } else if (!this.echo) {
            this.echofloor = this.floor;
        }
    }

    /**
     * Measurement step.
     */
    tick() {
        const now = performance.now();
        const dt = now - this.last;
        this.last = now;
        if (!this.enabled) {
            return;
        }
        const db = this.measure();
        if (this.handlers.onlevel) {
            this.handlers.onlevel(Math.max(0, Math.min(1, (db - this.floor) / 40)));
        }
        this.learn(db);

        let threshold = this.floor + this.margin;
        if (this.echo) {
            threshold = Math.max(threshold, this.echofloor + this.echomargin);
        }

        if (db > threshold) {
            this.above += dt;
            this.below = 0;
        } else {
            this.below += dt;
            if (!this.speaking) {
                this.above = Math.max(0, this.above - dt);
            }
        }

        if (!this.speaking && this.above >= this.minstart) {
            this.speaking = true;
            this.started = now - this.above;
            if (this.handlers.onstart) {
                this.handlers.onstart();
            }
        } else if (this.speaking && this.below >= this.redemption) {
            this.speaking = false;
            const duration = now - this.started - this.below;
            this.above = 0;
            if (duration < this.minspeech) {
                if (this.handlers.onmisfire) {
                    this.handlers.onmisfire();
                }
            } else if (this.handlers.onend) {
                this.handlers.onend(duration);
            }
        }
    }

    /**
     * How long the current speech has lasted, in ms (0 when silent).
     *
     * @returns {number}
     */
    speechDuration() {
        return this.speaking ? performance.now() - this.started : 0;
    }

    /**
     * Stops measuring.
     */
    destroy() {
        clearInterval(this.timer);
        try {
            this.source.disconnect();
        } catch (e) {
            // Already disconnected.
        }
    }
}
