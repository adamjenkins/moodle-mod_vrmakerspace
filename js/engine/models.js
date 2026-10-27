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
 * Starting models of a sculpture: a clay lump, a sphere, a rounded cube, or nothing (empty, for
 * building with the shape tools).
 *
 * Each model is a signed-distance function in sculpture-local metres, evaluated with the
 * deterministic maths of mathx.js only, so every client builds the same starting grid bit for bit.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/models
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {sin} from './mathx.js';
import {BORDER} from './grid.js';

/** Names of the starting models. */
export const MODELS = Object.freeze(['lump', 'sphere', 'cube', 'empty']);

/** Lump ellipsoid radii in metres. */
const LUMP_R = [0.11, 0.09, 0.10];

/** Sphere radius in metres. */
const SPHERE_R = 0.10;

/** Cube half-size and edge rounding in metres. */
const CUBE_H = 0.08;
const CUBE_ROUND = 0.01;

/**
 * Signed distance to the clay lump: an ellipsoid (radii 0.11, 0.09, 0.10 m) with three
 * low-frequency bumps whose amplitudes add up to 0.010 m.
 *
 * The ellipsoid distance is the usual first-order bound k0 (k0 − 1) / k1, with k0 = |p / r| and
 * k1 = |p / r²|, which is exact on the surface and close enough inside the 0.012 m band.
 *
 * @param {number} x Metres.
 * @param {number} y Metres.
 * @param {number} z Metres.
 * @returns {number} Signed distance in metres.
 */
export function lump(x, y, z) {
    const ax = x / LUMP_R[0];
    const ay = y / LUMP_R[1];
    const az = z / LUMP_R[2];
    const bx = ax / LUMP_R[0];
    const by = ay / LUMP_R[1];
    const bz = az / LUMP_R[2];
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    const ellipsoid = k1 > 0 ? k0 * (k0 - 1) / k1 : -LUMP_R[1];
    const bumps = 0.005 * sin(17 * x + 1.3) * sin(15 * y + 0.4) * sin(13 * z + 2.1) +
        0.003 * sin(23 * y + 31 * x + 0.7) +
        0.002 * sin(29 * z - 19 * y + 1.9);
    return ellipsoid - bumps;
}

/**
 * Signed distance to the sphere (radius 0.10 m).
 *
 * @param {number} x Metres.
 * @param {number} y Metres.
 * @param {number} z Metres.
 * @returns {number} Signed distance in metres.
 */
export function sphere(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z) - SPHERE_R;
}

/**
 * Signed distance to the rounded cube (half-size 0.08 m, edges rounded by 0.01 m).
 *
 * @param {number} x Metres.
 * @param {number} y Metres.
 * @param {number} z Metres.
 * @returns {number} Signed distance in metres.
 */
export function cube(x, y, z) {
    const inner = CUBE_H - CUBE_ROUND;
    const qx = Math.abs(x) - inner;
    const qy = Math.abs(y) - inner;
    const qz = Math.abs(z) - inner;
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    const oz = Math.max(qz, 0);
    const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
    return outside + inside - CUBE_ROUND;
}

/**
 * Signed distance of empty space: no clay anywhere.
 *
 * @returns {number} A distance beyond every band.
 */
export function empty() {
    return 1;
}

/** Distance functions by model name. */
const FUNCTIONS = Object.freeze({lump, sphere, cube, empty});

/**
 * Whether a model name is known.
 *
 * @param {string} name Model name.
 * @returns {boolean} True for lump, sphere, cube and empty.
 */
export function isModel(name) {
    return MODELS.indexOf(name) !== -1;
}

/**
 * Fills a grid with a starting model: quantised, clamped to the band, and +band on the outer
 * border voxels of every face.
 *
 * @param {import('./grid.js').Grid} grid The grid to fill (overwritten).
 * @param {string} name 'lump', 'sphere', 'cube' or 'empty'.
 * @returns {import('./grid.js').Grid} The grid.
 */
export function fillModel(grid, name) {
    const fn = FUNCTIONS[name];
    if (!fn || !isModel(name)) {
        throw new Error('unknown model: ' + String(name));
    }
    const {nx, ny, nz, voxel, data} = grid;
    const outside = grid.levels[grid.levels.length - 1];
    let idx = 0;
    for (let k = 0; k < nz; k++) {
        const z = (k - grid.cz) * voxel;
        const zb = k < BORDER || k >= nz - BORDER;
        for (let j = 0; j < ny; j++) {
            const y = (j - grid.cy) * voxel;
            const yb = zb || j < BORDER || j >= ny - BORDER;
            for (let i = 0; i < nx; i++, idx++) {
                if (yb || i < BORDER || i >= nx - BORDER) {
                    data[idx] = outside;
                } else {
                    data[idx] = grid.quant(fn((i - grid.cx) * voxel, y, z));
                }
            }
        }
    }
    return grid;
}
