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
 * The op on the wire: what the session sends and accepts, clay and mesh alike.
 *
 * rebuildOp() keeps the known keys of an op, in the wire order, with the author the session gives
 * it, and checks their types only: value ranges are the engine's (ops.cleanOp, polyops.cleanMeshOp),
 * which every client applies in the same way. The key order matters: the engine tells that a confirmed
 * op is the one it already shows by comparing JSON.
 *
 * Dependency-free ES module (no imports) so that both grunt (AMD build) and node --test load it.
 *
 * @module     mod_vrmakerspace/net/opwire
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Largest op index and stroke id. */
export const MAX_INDEX = 2147483647;

/** Largest op JSON sent or accepted from the network, in characters. */
export const MAX_OP_TEXT = 1024;

/** Largest mesh op JSON the engine applies, in characters (polyops.MAX_MESH_BYTES). */
export const MAX_MESH_OP_TEXT = 1000;

/** Longest string value of an op (sh, tx, md, sm). */
const MAX_OP_STRING = 40;

/** Mesh op kinds (polyops.MESH_KINDS). */
export const MESH_KINDS = Object.freeze(['msel', 'mprim', 'mxf', 'mext', 'minset', 'mbevel', 'mloop', 'mmerge', 'mdel',
    'mfill', 'mflip', 'mmirror', 'mbake']);

/** Every op kind (ops.KINDS). */
export const OP_KINDS = Object.freeze(['add', 'carve', 'smooth', 'grab', 'twist', 'inflate', 'pinch', 'flatten', 'shape',
    'cutshape', 'end', 'undo', 'redo', 'lock', 'unlock', 'save', 'hz'].concat(MESH_KINDS));

/**
 * Whether a value is a finite number.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isNumber = (value) => typeof value === 'number' && isFinite(value);

/**
 * Whether a value is an array of three finite numbers.
 *
 * @param {*} value
 * @returns {boolean}
 */
export const isVec3 = (value) => Array.isArray(value) && value.length === 3 && value.every(isNumber);

/**
 * Whether a value is an integer 1..MAX_INDEX.
 *
 * @param {*} value
 * @returns {boolean}
 */
export const isIndex = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_INDEX;

/**
 * Whether a value is a short string.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isOpString = (value) => typeof value === 'string' && value.length <= MAX_OP_STRING;

/**
 * Whether a value is an array of safe non-negative integers: element ids, up to 2^53 − 1. A plain
 * loop, because every() would pass over the holes of a sparse array.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isIdList = (value) => {
    if (!Array.isArray(value)) {
        return false;
    }
    for (let i = 0; i < value.length; i++) {
        if (!Number.isSafeInteger(value[i]) || value[i] < 0) {
            return false;
        }
    }
    return true;
};

/**
 * Whether a value is an edge: two vertex ids.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isEdge = (value) => isIdList(value) && value.length === 2;

/** The keys after `i`, in the wire order, each with its type check. */
const WIRE_KEYS = Object.freeze([
    ['p', isVec3],
    ['r', isNumber],
    ['st', isNumber],
    ['d', isVec3],
    ['x', isVec3],
    ['g', isNumber],
    ['t', isIndex],
    ['m', isIndex],
    ['sh', isOpString],
    ['tx', isOpString],
    ['md', isOpString],
    ['sm', isOpString],
    ['ids', isIdList],
    ['e', isEdge],
    ['n', isIndex],
    ['sc', isVec3],
]);

/**
 * Rebuild an op from its known keys in the wire order, with the given author. Types are checked
 * here; ranges are the engine's.
 *
 * @param {*} source Op-like object.
 * @param {string} author Author id to stamp.
 * @returns {Object|null} A new op sharing no array with the source, or null when a known key has the wrong type.
 */
export const rebuildOp = (source, author) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || OP_KINDS.indexOf(source.k) === -1) {
        return null;
    }
    const op = {k: source.k, a: author};
    if (source.s !== undefined) {
        if (!isIndex(source.s)) {
            return null;
        }
        op.s = source.s;
    }
    if (!isIndex(source.i)) {
        return null;
    }
    op.i = source.i;
    for (let n = 0; n < WIRE_KEYS.length; n++) {
        const key = WIRE_KEYS[n][0];
        const value = source[key];
        if (value !== undefined) {
            if (!WIRE_KEYS[n][1](value)) {
                return null;
            }
            op[key] = Array.isArray(value) ? value.slice() : value;
        }
    }
    return op;
};

/**
 * Parse an op received from the network.
 *
 * @param {*} text Op JSON.
 * @param {string} author The sender's author id (from the transport, never from the op).
 * @returns {Object|null}
 */
export const parseOp = (text, author) => {
    if (typeof text !== 'string' || text === '' || text.length > MAX_OP_TEXT) {
        return null;
    }
    let source;
    try {
        source = JSON.parse(text);
    } catch (error) {
        return null;
    }
    return rebuildOp(source, author);
};

/**
 * Whether an op's JSON is short enough to send. A mesh op over its own limit would be refused by every
 * engine, so it is better not sent at all.
 *
 * @param {Object} op A rebuilt op.
 * @param {string} text Its JSON.
 * @returns {boolean}
 */
export const fitsWire = (op, text) => text.length <= (MESH_KINDS.indexOf(op.k) === -1 ? MAX_OP_TEXT : MAX_MESH_OP_TEXT);
