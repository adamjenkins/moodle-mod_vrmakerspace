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
 * Deterministic maths for the sculpting engine.
 *
 * Every browser (and Node) must compute bit-identical sculptures from the same ops, so the engine
 * uses only + - * /, Math.sqrt, Math.min/max/abs/floor/round/fround. Math.sin, Math.cos, Math.exp,
 * Math.pow and friends are implementation-defined and differ across engines; this module gives a
 * polynomial sine and cosine built from the allowed operations only, plus the rounding helpers of
 * the op wire format and small vector helpers.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/mathx
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** π, as the double literal (identical in every engine). */
export const PI = 3.141592653589793;

/** 2π. */
export const TWO_PI = 6.283185307179586;

/** π / 2. */
export const HALF_PI = 1.5707963267948966;

/** Taylor coefficients of sin(y) / y in powers of y²: 1, −1/3!, 1/5!, … −1/15!. */
const S1 = -1 / 6;
const S2 = 1 / 120;
const S3 = -1 / 5040;
const S4 = 1 / 362880;
const S5 = -1 / 39916800;
const S6 = 1 / 6227020800;
const S7 = -1 / 1307674368000;

/**
 * Sine computed with a fixed polynomial (absolute error below 1e-11 for |x| up to a few
 * thousand), bit-identical in every JavaScript engine.
 *
 * @param {number} x Angle in radians.
 * @returns {number} sin(x).
 */
export function sin(x) {
    // Reduce to [−π, π), then fold into [−π/2, π/2] using sin(π − y) = sin(y).
    let y = x - TWO_PI * Math.floor((x + PI) / TWO_PI);
    if (y > HALF_PI) {
        y = PI - y;
    } else if (y < -HALF_PI) {
        y = -PI - y;
    }
    const y2 = y * y;
    return y * (1 + y2 * (S1 + y2 * (S2 + y2 * (S3 + y2 * (S4 + y2 * (S5 + y2 * (S6 + y2 * S7)))))));
}

/**
 * Cosine from the polynomial sine: cos(x) = sin(x + π/2).
 *
 * @param {number} x Angle in radians.
 * @returns {number} cos(x).
 */
export function cos(x) {
    return sin(x + HALF_PI);
}

/**
 * Rounds to 3 decimals (op strengths). Never returns −0.
 *
 * @param {number} v Value.
 * @returns {number} Rounded value.
 */
export function R3(v) {
    return Math.round(v * 1e3) / 1e3 + 0;
}

/**
 * Rounds to 4 decimals (twist axes and angles). Never returns −0.
 *
 * @param {number} v Value.
 * @returns {number} Rounded value.
 */
export function R4(v) {
    return Math.round(v * 1e4) / 1e4 + 0;
}

/**
 * Rounds to 5 decimals (positions, radii, displacements in metres). Never returns −0.
 *
 * @param {number} v Value.
 * @returns {number} Rounded value.
 */
export function R5(v) {
    return Math.round(v * 1e5) / 1e5 + 0;
}

/**
 * Rounds to 7 decimals: the canonical form of a voxel size or band read back from a float32, so an
 * engine created from 0.004 and one loaded from a snapshot (float32 0.0040000002) use the same double.
 *
 * @param {number} v Value.
 * @returns {number} Rounded value.
 */
export function canon(v) {
    return Math.round(v * 1e7) / 1e7 + 0;
}

/**
 * Clamps a value to a range.
 *
 * @param {number} v Value.
 * @param {number} lo Lower bound.
 * @param {number} hi Upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Length of a 3-vector.
 *
 * @param {number[]} v [x, y, z].
 * @returns {number} |v|.
 */
export function len3(v) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/**
 * Dot product of two 3-vectors.
 *
 * @param {number[]} a [x, y, z].
 * @param {number[]} b [x, y, z].
 * @returns {number} a · b.
 */
export function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Normalises a 3-vector into `out` (deterministically: one sqrt and three divisions).
 *
 * @param {number[]} v [x, y, z], non-zero.
 * @param {number[]|Float64Array} out Receives the unit vector (may be v itself).
 * @returns {number[]|Float64Array} out, or out filled with zeros when v is zero.
 */
export function normalize3(v, out) {
    const l = len3(v);
    if (l === 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        return out;
    }
    out[0] = v[0] / l;
    out[1] = v[1] / l;
    out[2] = v[2] / l;
    return out;
}

/**
 * Falloff of a brush: w(t) = (1 − t²)² for t < 1, else 0.
 *
 * @param {number} t Distance from the brush centre divided by its radius (≥ 0).
 * @returns {number} Weight in [0, 1].
 */
export function falloff(t) {
    if (t >= 1) {
        return 0;
    }
    const u = 1 - t * t;
    return u * u;
}
