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
 * A small store-only (uncompressed) zip writer, enough for 3MF packages.
 *
 * Writes the classic PKZIP format (APPNOTE 6.3): one local file header and data per entry, then the
 * central directory and the end-of-central-directory record. Names are UTF-8 (general purpose flag
 * bit 11). No Zip64: an archive is limited to 65 535 entries and 4 GiB, which a 3MF of one sculpture
 * never reaches. Dependency-free; runs in a Web Worker and in Node.
 *
 * @module     mod_vrsculpt/engine/zip
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** The CRC-32 lookup table (IEEE 802.3 polynomial, reflected), built on first use. */
let crcTable = null;

/**
 * Returns the CRC-32 lookup table, building it once.
 *
 * @returns {Uint32Array} 256 entries.
 */
function table() {
    if (crcTable) {
        return crcTable;
    }
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let b = 0; b < 8; b++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

/**
 * Computes the CRC-32 of some bytes (the checksum zip, PNG and gzip use).
 *
 * @param {Uint8Array} bytes The data.
 * @param {number} [previous=0] The CRC of the data before these bytes, to continue a running CRC.
 * @returns {number} The CRC as an unsigned 32-bit integer.
 */
export function crc32(bytes, previous = 0) {
    const t = table();
    let c = (previous ^ 0xFFFFFFFF) >>> 0;
    for (let n = 0; n < bytes.length; n++) {
        c = t[(c ^ bytes[n]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Converts a date to the MS-DOS time and date fields zip headers use (local time, 2-second steps,
 * years 1980..2107).
 *
 * @param {Date} date The date.
 * @returns {{time: number, date: number}} The two 16-bit fields.
 */
function dosDateTime(date) {
    let year = date.getFullYear();
    if (!(year >= 1980)) {
        return {time: 0, date: (1 << 5) | 1};
    }
    year = Math.min(year, 2107);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/**
 * Builds a store-only zip archive.
 *
 * @param {Array<{name: string, data: (Uint8Array|string)}>} entries The files, in order. A string is
 *     written as UTF-8. Names use '/' as the separator, must not start with '/' and must be unique.
 * @param {{date: (Date|undefined)}} [options] `date`: modification time of every entry (default now).
 * @returns {Uint8Array} The archive bytes.
 */
export function createZip(entries, options = {}) {
    if (!Array.isArray(entries)) {
        throw new TypeError('createZip: entries must be an array');
    }
    if (entries.length > 0xFFFF) {
        throw new RangeError('createZip: too many entries');
    }
    const encoder = new TextEncoder();
    const stamp = dosDateTime(options.date instanceof Date ? options.date : new Date());
    const seen = new Set();
    const files = entries.map((entry) => {
        const name = String(entry.name);
        if (name === '' || name.startsWith('/') || name.includes('\\') || seen.has(name)) {
            throw new Error('createZip: invalid or duplicate entry name "' + name + '"');
        }
        seen.add(name);
        const nameBytes = encoder.encode(name);
        if (nameBytes.length > 0xFFFF) {
            throw new RangeError('createZip: entry name too long');
        }
        const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
        if (!(data instanceof Uint8Array)) {
            throw new TypeError('createZip: entry data must be a Uint8Array or a string');
        }
        return {nameBytes, data, crc: crc32(data), offset: 0};
    });

    let size = 22;
    for (const f of files) {
        size += 30 + f.nameBytes.length + f.data.length + 46 + f.nameBytes.length;
    }
    if (size > 0xFFFFFFFF) {
        throw new RangeError('createZip: archive larger than 4 GiB');
    }
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    const flags = 0x0800;
    let o = 0;

    for (const f of files) {
        f.offset = o;
        dv.setUint32(o, 0x04034B50, true);
        dv.setUint16(o + 4, 20, true);
        dv.setUint16(o + 6, flags, true);
        dv.setUint16(o + 8, 0, true);
        dv.setUint16(o + 10, stamp.time, true);
        dv.setUint16(o + 12, stamp.date, true);
        dv.setUint32(o + 14, f.crc, true);
        dv.setUint32(o + 18, f.data.length, true);
        dv.setUint32(o + 22, f.data.length, true);
        dv.setUint16(o + 26, f.nameBytes.length, true);
        dv.setUint16(o + 28, 0, true);
        out.set(f.nameBytes, o + 30);
        o += 30 + f.nameBytes.length;
        out.set(f.data, o);
        o += f.data.length;
    }

    const cdStart = o;
    for (const f of files) {
        dv.setUint32(o, 0x02014B50, true);
        dv.setUint16(o + 4, 20, true);
        dv.setUint16(o + 6, 20, true);
        dv.setUint16(o + 8, flags, true);
        dv.setUint16(o + 10, 0, true);
        dv.setUint16(o + 12, stamp.time, true);
        dv.setUint16(o + 14, stamp.date, true);
        dv.setUint32(o + 16, f.crc, true);
        dv.setUint32(o + 20, f.data.length, true);
        dv.setUint32(o + 24, f.data.length, true);
        dv.setUint16(o + 28, f.nameBytes.length, true);
        dv.setUint16(o + 30, 0, true);
        dv.setUint16(o + 32, 0, true);
        dv.setUint16(o + 34, 0, true);
        dv.setUint16(o + 36, 0, true);
        dv.setUint32(o + 38, 0, true);
        dv.setUint32(o + 42, f.offset, true);
        out.set(f.nameBytes, o + 46);
        o += 46 + f.nameBytes.length;
    }
    const cdSize = o - cdStart;

    dv.setUint32(o, 0x06054B50, true);
    dv.setUint16(o + 4, 0, true);
    dv.setUint16(o + 6, 0, true);
    dv.setUint16(o + 8, files.length, true);
    dv.setUint16(o + 10, files.length, true);
    dv.setUint32(o + 12, cdSize, true);
    dv.setUint32(o + 16, cdStart, true);
    dv.setUint16(o + 20, 0, true);
    return out;
}
