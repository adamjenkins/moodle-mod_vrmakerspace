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
 * Records the microphone as 16 kHz mono 16-bit WAV, with a short lead-in.
 *
 * Speech services take WAV everywhere (Ollama takes nothing else), and 16 kHz
 * mono is what speech models listen at, so the upload is small and needs no
 * conversion on the server. The recorder always keeps the last half second,
 * so the first syllable, said just before the Talk button was pressed, is not
 * lost.
 *
 * The audio worklet is only loaded when the recorder connects (the first time
 * the student talks), and only where the browser has one: Firefox offers
 * AudioWorklet in secure contexts only. Without it, a ScriptProcessor is used.
 *
 * Copied from mod_talkwithai/speech/wavrecorder (same author) and renamed.
 *
 * @module     mod_vrmakerspace/speech/wavrecorder
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Sample rate of the recording, in Hz. */
const RATE = 16000;

/** Name of the worklet processor. */
const PROCESSOR = 'vrmakerspace-tap';

/** Audio worklet that passes the microphone samples on in blocks of 2048. */
const WORKLET = `
class VrmakerspaceTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.block = new Float32Array(2048);
        this.used = 0;
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) {
            for (let i = 0; i < channel.length; i++) {
                this.block[this.used++] = channel[i];
                if (this.used === this.block.length) {
                    this.port.postMessage(this.block.slice(0));
                    this.used = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('${PROCESSOR}', VrmakerspaceTap);
`;

/** Audio contexts that already have the worklet (a processor can be registered only once per context). */
const withWorklet = new WeakSet();

/**
 * Downsamples mono audio, averaging each output sample's span (a simple low-pass against aliasing).
 *
 * @param {Float32Array} input
 * @param {number} from Input rate
 * @param {number} to Output rate, at most the input rate
 * @returns {Float32Array}
 */
const resample = (input, from, to) => {
    if (from <= to) {
        return input;
    }
    const ratio = from / to;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < output.length; i++) {
        const first = Math.floor(i * ratio);
        const last = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = first; j < last; j++) {
            sum += input[j];
        }
        output[i] = sum / Math.max(1, last - first);
    }
    return output;
};

/**
 * Encodes mono samples as a 16-bit PCM WAV file.
 *
 * @param {Float32Array} samples
 * @param {number} rate
 * @returns {Blob}
 */
export const encodeWav = (samples, rate) => {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], {type: 'audio/wav'});
};

/**
 * Microphone recorder producing WAV.
 */
export class WavRecorder {
    /**
     * Whether the browser can record this way.
     *
     * @returns {boolean}
     */
    static supported() {
        return !!window.AudioContext;
    }

    /**
     * @param {AudioContext} audioctx
     * @param {MediaStream} stream Microphone stream
     * @param {Object} [options]
     * @param {number} [options.preroll=500] Lead-in kept before start(), in ms
     * @param {number} [options.maxlength=30000] Longest recording, in ms
     */
    constructor(audioctx, stream, options = {}) {
        this.ctx = audioctx;
        this.stream = stream;
        this.preroll = Math.round((options.preroll || 500) * audioctx.sampleRate / 1000);
        this.max = Math.round((options.maxlength || 30000) * audioctx.sampleRate / 1000);
        this.ring = [];
        this.ringlength = 0;
        this.blocks = [];
        this.length = 0;
        this.recording = false;
        this.node = null;
    }

    /**
     * Makes the worklet node, loading the worklet into the context the first time.
     *
     * @param {Function} take Receives each block
     * @returns {Promise<AudioWorkletNode|null>}
     */
    async workletNode(take) {
        if (!this.ctx.audioWorklet || !window.AudioWorkletNode) {
            return null;
        }
        try {
            if (!withWorklet.has(this.ctx)) {
                const url = URL.createObjectURL(new Blob([WORKLET], {type: 'application/javascript'}));
                try {
                    await this.ctx.audioWorklet.addModule(url);
                } finally {
                    URL.revokeObjectURL(url);
                }
                withWorklet.add(this.ctx);
            }
            const node = new window.AudioWorkletNode(this.ctx, PROCESSOR);
            node.port.onmessage = (e) => take(e.data);
            return node;
        } catch (e) {
            return null;
        }
    }

    /**
     * Connects to the microphone.
     *
     * @returns {Promise<void>}
     */
    async init() {
        this.source = this.ctx.createMediaStreamSource(this.stream);
        this.sink = this.ctx.createGain();
        this.sink.gain.value = 0;
        this.sink.connect(this.ctx.destination);
        const take = (block) => this.take(block);
        this.node = await this.workletNode(take);
        if (!this.node) {
            // Older browsers, Firefox on a plain http page, or a page that does not allow blob: worklets.
            this.node = this.ctx.createScriptProcessor(4096, 1, 1);
            this.node.onaudioprocess = (e) => take(e.inputBuffer.getChannelData(0).slice(0));
        }
        this.source.connect(this.node);
        this.node.connect(this.sink);
    }

    /**
     * Receives a block of samples.
     *
     * @param {Float32Array} block
     */
    take(block) {
        if (this.recording) {
            if (this.length < this.max) {
                this.blocks.push(block);
                this.length += block.length;
            }
            return;
        }
        this.ring.push(block);
        this.ringlength += block.length;
        while (this.ring.length > 1 && this.ringlength - this.ring[0].length >= this.preroll) {
            this.ringlength -= this.ring.shift().length;
        }
    }

    /**
     * Starts a recording, beginning with the lead-in.
     */
    start() {
        this.blocks = this.ring.slice();
        this.length = this.ringlength;
        this.recording = true;
    }

    /**
     * Whether a recording is running.
     *
     * @returns {boolean}
     */
    isRecording() {
        return this.recording;
    }

    /**
     * Ends the recording.
     *
     * @param {number} [trim=0] Silence at the end to leave out, in ms
     * @returns {Blob|null} The WAV, or null when nothing was recorded
     */
    stop(trim = 0) {
        if (!this.recording) {
            return null;
        }
        this.recording = false;
        let length = this.length - Math.round(trim * this.ctx.sampleRate / 1000);
        length = Math.max(0, Math.min(length, this.length));
        const all = new Float32Array(length);
        let offset = 0;
        for (const block of this.blocks) {
            if (offset >= length) {
                break;
            }
            const part = block.subarray(0, Math.min(block.length, length - offset));
            all.set(part, offset);
            offset += part.length;
        }
        this.blocks = [];
        this.length = 0;
        this.ring = [];
        this.ringlength = 0;
        const rate = Math.min(RATE, this.ctx.sampleRate);
        return length ? encodeWav(resample(all, this.ctx.sampleRate, rate), rate) : null;
    }

    /**
     * Drops the recording.
     */
    cancel() {
        this.recording = false;
        this.blocks = [];
        this.length = 0;
    }

    /**
     * Disconnects from the microphone.
     */
    destroy() {
        this.cancel();
        try {
            this.source.disconnect();
            this.node.disconnect();
            this.sink.disconnect();
        } catch (e) {
            // Already disconnected.
        }
        if (this.node && this.node.port) {
            this.node.port.onmessage = null;
        }
    }
}
