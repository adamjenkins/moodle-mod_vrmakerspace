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
 * The stroke font of the text shape: capital letters, digits and a little punctuation, each glyph a
 * few polylines on a grid 4 units wide and 6 high (baseline 0). Letters are made of round clay tubes
 * along these lines, so the font needs no outlines and every client builds the same text.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/font
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Glyph width and cap height in font units. */
export const GLYPH_WIDTH = 4;
export const CAP_HEIGHT = 6;

/** Distance from one glyph's left edge to the next one's, in font units. */
export const ADVANCE = 6;

/** Most characters of one text. */
export const MAX_TEXT = 16;

/** The outline of O, shared by O, Q and 0. */
const RING = [[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]];

/** The bowl of P, shared by P and R. */
const BOWL = [[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]];

/** Polylines of every glyph, by character. */
const GLYPHS = Object.freeze({
    'A': [[[0, 0], [2, 6], [4, 0]], [[0.67, 2], [3.33, 2]]],
    'B': [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
    'C': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
    'D': [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
    'E': [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
    'F': [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
    'G': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
    'H': [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
    'I': [[[2, 0], [2, 6]], [[1, 6], [3, 6]], [[1, 0], [3, 0]]],
    'J': [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
    'K': [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.33, 3.33], [4, 0]]],
    'L': [[[0, 6], [0, 0], [4, 0]]],
    'M': [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
    'N': [[[0, 0], [0, 6], [4, 0], [4, 6]]],
    'O': [RING],
    'P': [BOWL],
    'Q': [RING, [[2.5, 1.5], [4, 0]]],
    'R': [BOWL, [[2, 3], [4, 0]]],
    'S': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
    'T': [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
    'U': [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
    'V': [[[0, 6], [2, 0], [4, 6]]],
    'W': [[[0, 6], [1, 0], [2, 4], [3, 0], [4, 6]]],
    'X': [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
    'Y': [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
    'Z': [[[0, 6], [4, 6], [0, 0], [4, 0]]],
    '0': [RING, [[0.5, 1], [3.5, 5]]],
    '1': [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
    '2': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
    '3': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1.5, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
    '4': [[[3, 0], [3, 6], [0, 2], [4, 2]]],
    '5': [[[4, 6], [0, 6], [0, 3], [3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
    '6': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
    '7': [[[0, 6], [4, 6], [1.5, 0]]],
    '8': [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0],
        [4, 1], [4, 2], [3, 3]]],
    '9': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [4, 3]]],
    ' ': [],
    '.': [[[2, 0], [2, 0]]],
    '-': [[[0.5, 3], [3.5, 3]]],
    '!': [[[2, 6], [2, 2]], [[2, 0], [2, 0]]],
    '?': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [2, 2.5], [2, 1.8]], [[2, 0], [2, 0]]],
    '\'': [[[2, 6], [2, 4.5]]],
});

/** Every character the font has, for the text check. */
export const CHARACTERS = Object.freeze(Object.keys(GLYPHS).join(''));

/**
 * Whether a string is a text the font can write: 1 to MAX_TEXT of its characters, not only spaces.
 *
 * @param {*} text Candidate.
 * @returns {boolean} True when it can be written.
 */
export function isText(text) {
    if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT || text.trim() === '') {
        return false;
    }
    for (let n = 0; n < text.length; n++) {
        if (!Object.prototype.hasOwnProperty.call(GLYPHS, text[n])) {
            return false;
        }
    }
    return true;
}

/**
 * Width of a text in font units (from the first glyph's left edge to the last one's right edge).
 *
 * @param {string} text A text (isText()).
 * @returns {number} Width in font units.
 */
export function textWidth(text) {
    return (text.length - 1) * ADVANCE + GLYPH_WIDTH;
}

/**
 * The line segments of a text, centred on the origin, in font units: x to the right, y up.
 *
 * @param {string} text A text (isText()).
 * @returns {{segments: Float64Array, glyphs: number[][]}} segments: x0, y0, x1, y1 per segment;
 *     glyphs: [first segment, segment count, left x] per glyph that has any.
 */
export function textSegments(text) {
    const values = [];
    const glyphs = [];
    const left = -textWidth(text) / 2;
    const bottom = -CAP_HEIGHT / 2;
    for (let n = 0; n < text.length; n++) {
        const x0 = left + n * ADVANCE;
        const first = values.length / 4;
        for (const line of GLYPHS[text[n]]) {
            for (let m = 0; m + 1 < line.length; m++) {
                values.push(x0 + line[m][0], bottom + line[m][1], x0 + line[m + 1][0], bottom + line[m + 1][1]);
            }
            if (line.length === 1) {
                values.push(x0 + line[0][0], bottom + line[0][1], x0 + line[0][0], bottom + line[0][1]);
            }
        }
        const count = values.length / 4 - first;
        if (count > 0) {
            glyphs.push([first, count, x0]);
        }
    }
    return {segments: Float64Array.from(values), glyphs};
}
