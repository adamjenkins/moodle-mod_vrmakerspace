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
 * The signed-distance voxel grid of a sculpture.
 *
 * Values are signed distances in metres (negative inside), x fastest, then y, then z. Voxel
 * (i, j, k) has its centre at ((i − (nx − 1) / 2) × voxel, …), the origin is the grid centre.
 *
 * Every value the engine stores is one of 255 levels q / 127 × band (q = −127..127), the exact
 * values a VRSC snapshot can hold. So a snapshot round trip is lossless and an engine loaded from
 * a snapshot continues bit-identically with the one that wrote it.
 *
 * Dependency-free ES module: it runs in a module Web Worker and in Node (node --test).
 *
 * @module     mod_vrsculpt/engine/grid
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {canon} from './mathx.js';

/** Voxels per chunk edge. */
export const CHUNK = 16;

/** Number of quantisation levels on each side of zero. */
export const QMAX = 127;

/** Width of the forced-outside border on every face, in voxels. */
export const BORDER = 2;

/**
 * A signed-distance voxel grid.
 */
export class Grid {
    /**
     * Creates a grid filled with +band (empty space).
     *
     * @param {number} nx Voxels along x.
     * @param {number} ny Voxels along y.
     * @param {number} nz Voxels along z.
     * @param {number} voxel Voxel edge in metres.
     * @param {number} band Distance band in metres: values are clamped to [−band, band].
     * @param {Float32Array} [data] Existing values (taken, not copied), nx × ny × nz long.
     */
    constructor(nx, ny, nz, voxel, band, data) {
        /** @type {number} */
        this.nx = nx;
        /** @type {number} */
        this.ny = ny;
        /** @type {number} */
        this.nz = nz;
        /** @type {number} */
        this.voxel = canon(voxel);
        /** @type {number} */
        this.band = canon(band);
        /** Multiplier from metres to quantisation levels. @type {number} */
        this.inv = QMAX / this.band;
        /** Level table: levels[q + 127] = float32(q / 127 × band). @type {Float32Array} */
        this.levels = new Float32Array(2 * QMAX + 1);
        for (let q = -QMAX; q <= QMAX; q++) {
            this.levels[q + QMAX] = q / QMAX * this.band;
        }
        /** Index of voxel (i, j, k) centre's x coordinate offset: (nx − 1) / 2. @type {number} */
        this.cx = (nx - 1) / 2;
        /** @type {number} */
        this.cy = (ny - 1) / 2;
        /** @type {number} */
        this.cz = (nz - 1) / 2;
        /** Chunks along each axis (voxel chunks of 16). @type {number[]} */
        this.chunks = [Math.ceil(nx / CHUNK), Math.ceil(ny / CHUNK), Math.ceil(nz / CHUNK)];
        if (data) {
            if (data.length !== nx * ny * nz) {
                throw new Error('grid data length does not match its dimensions');
            }
            /** @type {Float32Array} */
            this.data = data;
        } else {
            this.data = new Float32Array(nx * ny * nz);
            this.data.fill(this.levels[2 * QMAX]);
        }
    }

    /**
     * Index of voxel (i, j, k) in `data`.
     *
     * @param {number} i X index.
     * @param {number} j Y index.
     * @param {number} k Z index.
     * @returns {number} The array index.
     */
    index(i, j, k) {
        return i + this.nx * (j + this.ny * k);
    }

    /**
     * Value of voxel (i, j, k).
     *
     * @param {number} i X index.
     * @param {number} j Y index.
     * @param {number} k Z index.
     * @returns {number} Signed distance in metres.
     */
    get(i, j, k) {
        return this.data[i + this.nx * (j + this.ny * k)];
    }

    /**
     * Stores a value at voxel (i, j, k), quantised to the nearest level and clamped to the band.
     *
     * @param {number} i X index.
     * @param {number} j Y index.
     * @param {number} k Z index.
     * @param {number} v Signed distance in metres.
     * @returns {void}
     */
    set(i, j, k, v) {
        this.data[i + this.nx * (j + this.ny * k)] = this.quant(v);
    }

    /**
     * The level nearest to a value, clamped to [−band, band].
     *
     * @param {number} v Signed distance in metres.
     * @returns {number} The stored (float32) level.
     */
    quant(v) {
        let q = Math.round(v * this.inv);
        q = q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
        return this.levels[q + QMAX];
    }

    /**
     * The level number (−127..127) of a stored value.
     *
     * @param {number} v A stored value.
     * @returns {number} Its level.
     */
    level(v) {
        const q = Math.round(v * this.inv);
        return q < -QMAX ? -QMAX : (q > QMAX ? QMAX : q);
    }

    /**
     * A deep copy of this grid.
     *
     * @returns {Grid} The copy.
     */
    copy() {
        return new Grid(this.nx, this.ny, this.nz, this.voxel, this.band, this.data.slice());
    }

    /**
     * Whether another grid has the same dimensions, voxel and band.
     *
     * @param {Grid} other The other grid.
     * @returns {boolean} True when they are compatible.
     */
    sameShape(other) {
        return other.nx === this.nx && other.ny === this.ny && other.nz === this.nz &&
            other.voxel === this.voxel && other.band === this.band;
    }

    /**
     * Voxel-space coordinate (fractional index) of a sculpture-local x coordinate.
     *
     * @param {number} x Metres.
     * @returns {number} Fractional voxel index.
     */
    toVoxelX(x) {
        return x / this.voxel + this.cx;
    }

    /**
     * Voxel-space coordinate of a sculpture-local y coordinate.
     *
     * @param {number} y Metres.
     * @returns {number} Fractional voxel index.
     */
    toVoxelY(y) {
        return y / this.voxel + this.cy;
    }

    /**
     * Voxel-space coordinate of a sculpture-local z coordinate.
     *
     * @param {number} z Metres.
     * @returns {number} Fractional voxel index.
     */
    toVoxelZ(z) {
        return z / this.voxel + this.cz;
    }

    /**
     * Trilinear sample of the field at a sculpture-local point (clamped to the grid).
     *
     * @param {number} x Metres.
     * @param {number} y Metres.
     * @param {number} z Metres.
     * @returns {number} Interpolated signed distance in metres.
     */
    sample(x, y, z) {
        return trilinear(this.data, 0, 0, 0, this.nx, this.ny, this.nz,
            this.toVoxelX(x), this.toVoxelY(y), this.toVoxelZ(z));
    }

    /**
     * Copies the voxels of chunk (cx, cy, cz) from another grid of the same shape.
     *
     * @param {Grid} from Source grid.
     * @param {number} cx Chunk x index.
     * @param {number} cy Chunk y index.
     * @param {number} cz Chunk z index.
     * @returns {void}
     */
    copyChunkFrom(from, cx, cy, cz) {
        const nx = this.nx;
        const ny = this.ny;
        const i0 = cx * CHUNK;
        const i1 = Math.min(nx, i0 + CHUNK);
        const j0 = cy * CHUNK;
        const j1 = Math.min(ny, j0 + CHUNK);
        const k0 = cz * CHUNK;
        const k1 = Math.min(this.nz, k0 + CHUNK);
        const src = from.data;
        const dst = this.data;
        for (let k = k0; k < k1; k++) {
            for (let j = j0; j < j1; j++) {
                const row = nx * (j + ny * k);
                dst.set(src.subarray(row + i0, row + i1), row + i0);
            }
        }
    }
}

/**
 * Trilinear interpolation inside a box of values (a whole grid or a copied region of one).
 *
 * The box holds sx × sy × sz values, x fastest, whose first value is voxel (ox, oy, oz). The sample
 * point (fx, fy, fz) is in absolute voxel coordinates and is clamped to the box.
 *
 * @param {Float32Array} buf Values.
 * @param {number} ox Voxel x of the box's first value.
 * @param {number} oy Voxel y of the box's first value.
 * @param {number} oz Voxel z of the box's first value.
 * @param {number} sx Box size along x.
 * @param {number} sy Box size along y.
 * @param {number} sz Box size along z.
 * @param {number} fx Sample x in voxel coordinates.
 * @param {number} fy Sample y in voxel coordinates.
 * @param {number} fz Sample z in voxel coordinates.
 * @returns {number} The interpolated value.
 */
export function trilinear(buf, ox, oy, oz, sx, sy, sz, fx, fy, fz) {
    let x = fx - ox;
    let y = fy - oy;
    let z = fz - oz;
    const mx = sx - 1;
    const my = sy - 1;
    const mz = sz - 1;
    x = x < 0 ? 0 : (x > mx ? mx : x);
    y = y < 0 ? 0 : (y > my ? my : y);
    z = z < 0 ? 0 : (z > mz ? mz : z);
    let i = Math.floor(x);
    let j = Math.floor(y);
    let k = Math.floor(z);
    if (i >= mx) {
        i = mx > 0 ? mx - 1 : 0;
    }
    if (j >= my) {
        j = my > 0 ? my - 1 : 0;
    }
    if (k >= mz) {
        k = mz > 0 ? mz - 1 : 0;
    }
    const tx = x - i;
    const ty = y - j;
    const tz = z - k;
    const di = mx > 0 ? 1 : 0;
    const dj = my > 0 ? sx : 0;
    const dk = mz > 0 ? sx * sy : 0;
    const b = i + sx * (j + sy * k);
    const c00 = buf[b] + (buf[b + di] - buf[b]) * tx;
    const c10 = buf[b + dj] + (buf[b + dj + di] - buf[b + dj]) * tx;
    const c01 = buf[b + dk] + (buf[b + dk + di] - buf[b + dk]) * tx;
    const c11 = buf[b + dk + dj] + (buf[b + dk + dj + di] - buf[b + dk + dj]) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
}
