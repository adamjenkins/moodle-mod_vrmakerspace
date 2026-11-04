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
 * The shapes of the shape tools: signed distances in the shape's own frame (metres, size r), where
 * local Y is the shape's up (the surface normal it was placed on) and text lies in the local XY
 * plane, facing +Z. Deterministic maths only (+, −, ×, ÷, sqrt, min, max, abs), as the engine.
 *
 * - sphere: radius r; cube: edge 2r, edges rounded by 0.15 r; cylinder: radius 0.6 r, height 2r;
 *   cone: base radius 0.75 r at y = −r, tip at y = r; torus: ring radius 0.7 r, tube radius 0.3 r;
 *   text: capital letters 2r high written as clay tubes of radius 0.2 r (font.js).
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrmakerspace/engine/shapes
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {CAP_HEIGHT, GLYPH_WIDTH, textSegments, textWidth} from './font.js';

/** Shape names. */
export const SHAPES = Object.freeze(['sphere', 'cube', 'cylinder', 'cone', 'torus', 'text']);

/** Tube radius of text as a share of r. */
export const TEXT_TUBE = 0.2;

/** Cube edge rounding as a share of r. */
const CUBE_ROUND = 0.15;

/** Cylinder radius, cone base radius, torus ring and tube radius as shares of r. */
const CYLINDER_R = 0.6;
const CONE_R = 0.75;
const TORUS_R = 0.7;
const TORUS_TUBE = 0.3;

/**
 * Whether a name is a shape.
 *
 * @param {*} name Candidate.
 * @returns {boolean} True for one of SHAPES.
 */
export function isShape(name) {
    return typeof name === 'string' && SHAPES.indexOf(name) !== -1;
}

/**
 * The radius around the shape's centre that holds all of it.
 *
 * @param {string} shape Shape name.
 * @param {number} r Size in metres.
 * @param {string} [text] The text of a text shape.
 * @returns {number} Metres.
 */
export function boundingRadius(shape, r, text) {
    switch (shape) {
        case 'cube':
            return r * 1.7321;
        case 'cylinder':
            return r * 1.1662;
        case 'cone':
            return r * 1.25;
        case 'text': {
            const unit = 2 * r / CAP_HEIGHT;
            const hw = textWidth(text) / 2 * unit;
            return Math.sqrt(hw * hw + r * r) + TEXT_TUBE * r;
        }
        default:
            return r;
    }
}

/**
 * A prepared shape: its distance function in the local frame.
 *
 * @param {string} shape Shape name.
 * @param {number} r Size in metres.
 * @param {string} [text] The text of a text shape.
 * @param {number} [cull] Distance beyond which a value only has to be known to be at least that big
 *     (text skips glyphs farther away than this).
 * @returns {function(number, number, number): number} (x, y, z) local metres → signed distance.
 */
export function prepare(shape, r, text, cull) {
    switch (shape) {
        case 'sphere':
            return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r;
        case 'cube': {
            const round = CUBE_ROUND * r;
            const inner = r - round;
            return (x, y, z) => {
                const qx = Math.abs(x) - inner;
                const qy = Math.abs(y) - inner;
                const qz = Math.abs(z) - inner;
                const ox = Math.max(qx, 0);
                const oy = Math.max(qy, 0);
                const oz = Math.max(qz, 0);
                return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - round;
            };
        }
        case 'cylinder': {
            const radius = CYLINDER_R * r;
            return (x, y, z) => {
                const dx = Math.sqrt(x * x + z * z) - radius;
                const dy = Math.abs(y) - r;
                const ox = Math.max(dx, 0);
                const oy = Math.max(dy, 0);
                return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy);
            };
        }
        case 'cone':
            return coneDistance(r);
        case 'torus': {
            const ring = TORUS_R * r;
            const tube = TORUS_TUBE * r;
            return (x, y, z) => {
                const qx = Math.sqrt(x * x + z * z) - ring;
                return Math.sqrt(qx * qx + y * y) - tube;
            };
        }
        case 'text':
            return textDistance(r, text, cull === undefined ? Infinity : cull);
        default:
            throw new Error('unknown shape: ' + String(shape));
    }
}

/**
 * Distance to a capped cone (after Inigo Quilez's sdCappedCone): base radius 0.75 r at y = −r, tip at y = r.
 *
 * @param {number} r Size in metres.
 * @returns {function(number, number, number): number} The distance function.
 */
function coneDistance(r) {
    const h = r;
    const r1 = CONE_R * r;
    // k1 = (r2, h) with r2 = 0; k2 = (r2 − r1, 2h).
    const k2x = -r1;
    const k2y = 2 * h;
    const k2k2 = k2x * k2x + k2y * k2y;
    return (x, y, z) => {
        const qx = Math.sqrt(x * x + z * z);
        const qy = y;
        const cax = qx - Math.min(qx, qy < 0 ? r1 : 0);
        const cay = Math.abs(qy) - h;
        let t = ((0 - qx) * k2x + (h - qy) * k2y) / k2k2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const cbx = qx + k2x * t;
        const cby = qy - h + k2y * t;
        const s = cbx < 0 && cay < 0 ? -1 : 1;
        return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
    };
}

/**
 * Distance to a text of clay tubes in the local XY plane, centred on the origin.
 *
 * @param {number} r Half the letter height in metres.
 * @param {string} text The text.
 * @param {number} cull Glyphs farther than this (bounding-box distance) are skipped.
 * @returns {function(number, number, number): number} The distance function.
 */
function textDistance(r, text, cull) {
    const unit = 2 * r / CAP_HEIGHT;
    const tube = TEXT_TUBE * r;
    const {segments, glyphs} = textSegments(text);
    const seg = segments.map((v) => v * unit);
    const boxes = glyphs.map(([first, count, left]) => [first, count, left * unit, (left + GLYPH_WIDTH) * unit]);
    const halfheight = r;
    return (x, y, z) => {
        let best = Infinity;
        for (let g = 0; g < boxes.length; g++) {
            const [first, count, x0, x1] = boxes[g];
            // Distance to the glyph's box: a lower bound of its distance.
            const bx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
            const by = Math.abs(y) > halfheight ? Math.abs(y) - halfheight : 0;
            const lower = Math.sqrt(bx * bx + by * by + z * z) - tube;
            if (lower >= best || lower > cull) {
                continue;
            }
            for (let s = first; s < first + count; s++) {
                const o = s * 4;
                const ax = seg[o];
                const ay = seg[o + 1];
                const ex = seg[o + 2] - ax;
                const ey = seg[o + 3] - ay;
                const px = x - ax;
                const py = y - ay;
                const ee = ex * ex + ey * ey;
                let t = ee > 0 ? (px * ex + py * ey) / ee : 0;
                t = t < 0 ? 0 : (t > 1 ? 1 : t);
                const dx = px - ex * t;
                const dy = py - ey * t;
                const d = Math.sqrt(dx * dx + dy * dy + z * z) - tube;
                if (d < best) {
                    best = d;
                }
            }
        }
        return best === Infinity ? cull : best;
    };
}
