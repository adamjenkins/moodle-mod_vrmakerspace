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
 * Listening through the site's speech services (Ollama, an OpenAI-style server…).
 *
 * The student holds the Talk button (or B/Y in VR) while speaking: the
 * question is recorded as 16 kHz WAV (speech/wavrecorder, with a lead-in so
 * the first syllable is kept) and, when the button is let go, sent to
 * mod_vrmakerspace_tutor_transcribe, which passes it to the site's speech
 * engines in their order. The audio is not kept anywhere.
 *
 * Copied from mod_talkwithai/speech/serverstt (same author), renamed, and
 * turned from turn-taking by the voice activity detector into push to talk.
 *
 * @module     mod_vrmakerspace/speech/serverstt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Ajax from 'core/ajax';
import {WavRecorder} from 'mod_vrmakerspace/speech/wavrecorder';

/** Longest question recorded, in ms (speech models take clips of up to 30 s; the server's limit too). */
const MAXLENGTH = 30000;

/** Shortest recording worth sending, in bytes (a WAV header and about 0.2 s of 16 kHz audio). */
const MINBYTES = 44 + 6400;

/**
 * Reads a Blob as base64 (without the data: prefix).
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
const toBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
});

/**
 * Speech recognition by the site's speech services.
 */
export class ServerListener {
    /**
     * Whether the browser can record audio this way.
     *
     * @returns {boolean}
     */
    static supported() {
        return WavRecorder.supported();
    }

    /**
     * @param {Object} options
     * @param {AudioContext} options.audioctx
     * @param {MediaStream} options.stream Microphone stream
     * @param {number} options.cmid
     * @param {string} options.lang BCP 47 tag
     */
    constructor(options) {
        this.options = options;
        this.recorder = new WavRecorder(options.audioctx, options.stream, {maxlength: MAXLENGTH});
        this.limit = null;
    }

    /**
     * Connects the recorder to the microphone.
     *
     * @returns {Promise<void>}
     */
    init() {
        return this.recorder.init();
    }

    /**
     * Starts recording a question.
     *
     * @param {Function} [onlimit] Called when the longest recording is reached
     */
    begin(onlimit) {
        if (this.recorder.isRecording()) {
            return;
        }
        this.recorder.start();
        this.limit = setTimeout(() => {
            if (onlimit) {
                onlimit();
            }
        }, MAXLENGTH);
    }

    /**
     * Whether a question is being recorded.
     *
     * @returns {boolean}
     */
    isRecording() {
        return this.recorder.isRecording();
    }

    /**
     * Ends the recording and transcribes it.
     *
     * @param {number} [trim=0] Silence at the end to leave out, in ms
     * @returns {Promise<string>} The text ('' when nothing was said); rejects when the service failed
     */
    async finish(trim = 0) {
        clearTimeout(this.limit);
        const wav = this.recorder.stop(trim);
        if (!wav || wav.size < MINBYTES) {
            return '';
        }
        const audio = await toBase64(wav);
        const result = await Ajax.call([{
            methodname: 'mod_vrmakerspace_tutor_transcribe',
            args: {cmid: this.options.cmid, audio: audio, language: this.options.lang || ''},
        }])[0];
        return String(result && result.text ? result.text : '').trim();
    }

    /**
     * Drops a recording in progress.
     */
    discard() {
        clearTimeout(this.limit);
        this.recorder.cancel();
    }

    /**
     * Disconnects from the microphone.
     */
    destroy() {
        this.discard();
        this.recorder.destroy();
    }
}
