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
 * The tutor's voice from the site's speech server, played with Web Audio.
 *
 * What is spoken is always text the server has: the latest answer of the AI
 * (kept in the session), or a tour step's title and text from the language
 * strings. It is fetched one sentence chunk at a time
 * (mod_vrmakerspace_tutor_speak), the next chunk while the current one plays.
 * The first chunk of an answer usually comes with the answer itself
 * (mod_vrmakerspace_ask_tutor with speak), which saves a round trip.
 *
 * The sound goes through a gain, an analyser (the tutor's mouth follows its
 * loudness, with the sigmoid curve used by pixiv's ChatVRM, MIT) and the
 * output node given (the tutor's PannerNode, so the voice comes from where the
 * tutor is).
 *
 * Copied from mod_talkwithai/speech/servertts (same author), renamed, and
 * reduced to loudness lip sync.
 *
 * @module     mod_vrmakerspace/speech/servertts
 * @copyright  2023 pixiv Inc.
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Ajax from 'core/ajax';

/**
 * Decodes base64 to an ArrayBuffer.
 *
 * @param {string} b64
 * @returns {ArrayBuffer}
 */
const decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes.buffer;
};

/**
 * Speaks with audio from the speech server.
 */
export class ServerSpeaker {
    /**
     * @param {Object} options
     * @param {AudioContext} options.audioctx An audio context created in a user gesture
     * @param {number} options.cmid
     * @param {AudioNode} [options.output] Where the sound goes (the context's destination when not given)
     */
    constructor(options) {
        this.ctx = options.audioctx;
        this.cmid = options.cmid;
        this.gain = this.ctx.createGain();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.samples = new Float32Array(this.analyser.fftSize);
        this.gain.connect(this.analyser);
        this.analyser.connect(options.output || this.ctx.destination);
        this.active = false;
        this.current = null;
    }

    /**
     * Nothing to prepare (kept for the same shape as the browser speaker).
     *
     * @returns {Promise<void>}
     */
    init() {
        return Promise.resolve();
    }

    /**
     * Fetches one chunk.
     *
     * @param {string} step A tour step's key, or '' for the latest answer
     * @param {number} chunk
     * @returns {Promise<{count: number, buffer: AudioBuffer}>}
     */
    fetchChunk(step, chunk) {
        return Ajax.call([{
            methodname: 'mod_vrmakerspace_tutor_speak',
            args: {cmid: this.cmid, chunk: chunk, step: step || ''},
        }])[0].then(r => this.decodeChunk(r));
    }

    /**
     * Decodes a chunk as returned by the server.
     *
     * @param {Object} r {audio (base64), mimetype, chunks}
     * @returns {Promise<{count: number, buffer: AudioBuffer}>}
     */
    decodeChunk(r) {
        if (!r || !r.audio) {
            return Promise.reject(new Error('nospeech'));
        }
        return this.ctx.decodeAudioData(decode(r.audio)).then(buffer => ({
            count: Math.max(1, Number(r.chunks) || 1),
            buffer,
        }));
    }

    /**
     * Speaks a step, or the latest answer.
     *
     * @param {string} step A tour step's key, or '' for the latest answer
     * @param {Object} handlers {onchunk(index)}
     * @param {Object|null} [first] The first chunk, when it came with the answer
     * @returns {Promise<boolean>} true when everything was spoken, false when cancelled
     */
    speak(step, handlers = {}, first = null) {
        this.cancel();
        this.active = true;
        this.index = 0;
        const run = this.runid = (this.runid || 0) + 1;

        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            let play = null;
            // Plays one decoded chunk, prefetching the next while it plays.
            const begin = ({count, buffer}) => {
                if (run !== this.runid) {
                    return;
                }
                const index = this.index;
                const nextpending = index + 1 < count ? this.fetchChunk(step, index + 1) : null;
                if (nextpending) {
                    nextpending.catch(() => null);
                }
                const source = this.ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(this.gain);
                this.source = source;
                this.current = {started: this.ctx.currentTime, duration: buffer.duration};
                if (handlers.onchunk) {
                    handlers.onchunk(index);
                }
                source.onended = () => {
                    if (run !== this.runid) {
                        return;
                    }
                    this.current = null;
                    this.index++;
                    if (nextpending) {
                        play(nextpending);
                    } else {
                        this.active = false;
                        resolve(true);
                    }
                };
                source.start();
            };
            play = (pending) => {
                pending.then(begin).catch(err => {
                    if (run !== this.runid) {
                        return;
                    }
                    this.active = false;
                    reject(err);
                });
            };
            play(first ? this.decodeChunk(first) : this.fetchChunk(step, 0));
        });
    }

    /**
     * Loudness of the audio being played, 0..1, with ChatVRM's curve and gate.
     *
     * @returns {number}
     */
    loudness() {
        if (!this.current) {
            return 0;
        }
        this.analyser.getFloatTimeDomainData(this.samples);
        let peak = 0;
        for (let i = 0; i < this.samples.length; i++) {
            peak = Math.max(peak, Math.abs(this.samples[i]));
        }
        let volume = 1 / (1 + Math.exp(-45 * peak + 5));
        if (volume < 0.1) {
            volume = 0;
        }
        return volume;
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
     * Turns the voice down (or back up), e.g. while the student starts to talk.
     *
     * @param {boolean} on
     */
    duck(on) {
        this.gain.gain.setTargetAtTime(on ? 0.3 : 1, this.ctx.currentTime, 0.05);
    }

    /**
     * Stops speaking.
     */
    cancel() {
        this.runid = (this.runid || 0) + 1;
        const wasactive = this.active;
        this.active = false;
        this.current = null;
        if (this.source) {
            try {
                this.source.onended = null;
                this.source.stop();
            } catch (e) {
                // Already stopped.
            }
            this.source = null;
        }
        this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.gain.gain.setValueAtTime(1, this.ctx.currentTime);
        if (wasactive && this.resolve) {
            this.resolve(false);
        }
    }

    /**
     * Disconnects the nodes.
     */
    destroy() {
        this.cancel();
        try {
            this.gain.disconnect();
            this.analyser.disconnect();
        } catch (e) {
            // Already disconnected.
        }
    }
}
