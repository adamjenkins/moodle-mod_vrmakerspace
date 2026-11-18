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
 * Text helpers: sentence chunks for speech, and words for comparing transcripts.
 *
 * split() must stay identical to \mod_vrmakerspace\speech\chunker::split(), so
 * the browser and the speech server cut a text into the same chunks.
 *
 * Copied from mod_talkwithai/textsplit (same author) and renamed. No Moodle
 * imports, so it can be tested in Node.
 *
 * @module     mod_vrmakerspace/speech/textsplit
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Chunks shorter than this are merged with the next sentence. */
const MIN_CHUNK = 40;

/** Hard cap on the number of chunks. */
const MAX_CHUNKS = 12;

/**
 * Splits text into sentence chunks; joining them with single spaces gives the (whitespace-normalised) text.
 *
 * @param {string} text
 * @returns {string[]} At least one chunk
 */
export const split = (text) => {
    text = (text || '').replace(/\s+/gu, ' ').trim();
    if (text === '') {
        return [''];
    }
    const sentences = text.split(/(?<=[.!?。！？…])\s+/u).filter(s => s !== '');
    let chunks = [];
    let current = '';
    sentences.forEach(sentence => {
        current = current === '' ? sentence : current + ' ' + sentence;
        if ([...current].length >= MIN_CHUNK) {
            chunks.push(current);
            current = '';
        }
    });
    if (current !== '') {
        if (chunks.length && [...current].length < MIN_CHUNK / 2) {
            chunks[chunks.length - 1] += ' ' + current;
        } else {
            chunks.push(current);
        }
    }
    if (chunks.length > MAX_CHUNKS) {
        const tail = chunks.slice(MAX_CHUNKS - 1).join(' ');
        chunks = chunks.slice(0, MAX_CHUNKS - 1);
        chunks.push(tail);
    }
    return chunks;
};

/**
 * Lower-case word tokens, for comparing transcripts.
 *
 * @param {string} text
 * @returns {string[]}
 */
export const tokens = (text) => (text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

/** Short acknowledgements that are not a question. */
const BACKCHANNELS = ['mm', 'mhm', 'hmm', 'uh', 'um', 'ah', 'oh', 'ok', 'okay', 'yeah', 'yes', 'yep', 'right',
    'uh-huh', 'aha', 'sure', 'cool', 'nice', 'wow', 'ja', 'oui', 'si', 'sí'];

/**
 * Whether a transcript is only a backchannel ("mm", "ok", "yeah").
 *
 * @param {string} text
 * @returns {boolean}
 */
export const isBackchannel = (text) => {
    const t = tokens(text);
    return t.length > 0 && t.length <= 2 && t.every(w => BACKCHANNELS.includes(w));
};

/**
 * Share of the transcript's words that also occur in the reference (0..1).
 *
 * Used to recognise the tutor's own voice picked up by the microphone.
 *
 * @param {string} transcript
 * @param {string} reference
 * @returns {number}
 */
export const overlap = (transcript, reference) => {
    const t = tokens(transcript);
    if (!t.length) {
        return 0;
    }
    const ref = new Set(tokens(reference));
    return t.filter(w => ref.has(w)).length / t.length;
};
