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
 * Presence in the studio: the other sculptors as a head with a visor, two hands and a name label.
 *
 * Everything lives under the sculpture's group, because poses are shared in the sculpture's
 * frame: each person sees the others where they stand relative to the sculpture, wherever each of
 * them has put it. Poses are shown a little in the past and interpolated
 * (vrroomruntime_builtin/live/interpolation). A person on a desktop ('3d') has no hands; their
 * tool cursor is shown as a small sphere instead. A person whose poses stopped for 10 s is
 * removed.
 *
 * The colour of a person comes from a hash of their peer id, as vrroom's avatars do it; the name
 * label is drawn on a canvas with fillText (plain text, never HTML).
 *
 * @module     mod_vrmakerspace/presence
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {createInterpolator} from 'vrroomruntime_builtin/live/interpolation';

/** A person whose poses stopped this long ago is removed (ms). */
const TIMEOUT = 10000;

/** Head sphere radius (m). */
const HEAD_RADIUS = 0.085;

/** Height of the name label above the head centre (m). */
const LABEL_HEIGHT = 0.16;

/** Width of the name label in the room (m). */
const LABEL_WIDTH = 0.22;

/** Label canvas size (px). */
const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 112;

/** Longest name shown on the label (characters, then an ellipsis). */
const NAME_MAX = 32;

/** Radius of a desktop person's tool cursor (m). */
const CURSOR_RADIUS = 0.012;

/**
 * A raycast that never hits (the desktop input must not pick the other people).
 *
 * @returns {undefined}
 */
const noRaycast = () => undefined;

/**
 * The hue of a peer id (0..359): the same id has the same colour on every screen.
 *
 * @param {string} peerid Peer id.
 * @returns {number}
 */
export const hueOf = (peerid) => {
    const text = String(peerid || '');
    // Polynomial string hash kept below 2^31 so it stays exact in floating point.
    let hash = 7;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) % 2147483647;
    }
    return hash % 360;
};

/**
 * A display name as one short line of plain text.
 *
 * @param {*} name Name.
 * @returns {string}
 */
export const labelText = (name) => {
    const chars = Array.from(String(name === null || name === undefined ? '' : name)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
    return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join('') + '…' : chars.join('');
};

/**
 * A rounded rectangle path.
 *
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius.
 */
const roundRect = (ctx, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
};

/**
 * Set an object's position and rotation from a pose.
 *
 * @param {Object} object THREE.Object3D
 * @param {number[]} pose [x, y, z, qx, qy, qz, qw]
 */
const applyPose = (object, pose) => {
    object.position.set(pose[0], pose[1], pose[2]);
    object.quaternion.set(pose[3], pose[4], pose[5], pose[6]);
};

/**
 * Create the presence layer.
 *
 * Options: delay (interpolation delay in ms, default 120).
 *
 * update() takes the pose message of a peer: {q (or seq): sequence number, ts: sender time in
 * ms, m: '3d' or 'vr', h, l, r: [x, y, z, qx, qy, qz, qw] in the sculpture's frame (l and r
 * null when absent)}. A missing sequence number or time is filled in on arrival.
 *
 * @param {Object} THREE three.js namespace.
 * @param {Object} parent The sculpture's group (THREE.Object3D).
 * @param {Object} options Options.
 * @returns {Object} Presence {update(peerid, name, pose, nowms), remove(peerid), tick(nowms), peers(), dispose()}
 */
export const createPresence = (THREE, parent, options = {}) => {
    const delay = Number.isFinite(Number(options.delay)) ? Math.max(0, Number(options.delay)) : 120;
    const group = new THREE.Group();
    group.name = 'vrmakerspace-presence';
    parent.add(group);

    // Shared by every person.
    const headgeometry = new THREE.SphereGeometry(HEAD_RADIUS, 20, 14);
    const visorgeometry = new THREE.BoxGeometry(HEAD_RADIUS * 1.5, HEAD_RADIUS * 0.55, HEAD_RADIUS * 0.6);
    const handgeometry = new THREE.CapsuleGeometry(0.022, 0.05, 4, 10);
    // Lying along the grip's forward axis (-z).
    handgeometry.rotateX(Math.PI / 2);
    const cursorgeometry = new THREE.SphereGeometry(CURSOR_RADIUS, 14, 10);
    const visormaterial = new THREE.MeshStandardMaterial({color: 0x1b1f24, roughness: 0.25, metalness: 0.4});

    const people = new Map();
    let disposed = false;

    /**
     * A mesh that is not picked by raycasts.
     *
     * @param {Object} geometry Geometry.
     * @param {Object} material Material.
     * @param {string} name Object name.
     * @returns {Object} THREE.Mesh
     */
    const mesh = (geometry, material, name) => {
        const m = new THREE.Mesh(geometry, material);
        m.name = name;
        m.raycast = noRaycast;
        return m;
    };

    /**
     * Draw a person's name label.
     *
     * @param {Object} person Person record.
     */
    const drawLabel = (person) => {
        const ctx = person.canvas.getContext('2d');
        if (!ctx) {
            return;
        }
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.fillStyle = 'rgba(20, 24, 28, 0.78)';
        roundRect(ctx, 0, 6, CANVAS_WIDTH, CANVAS_HEIGHT - 12, 20);
        ctx.fill();
        ctx.fillStyle = person.css;
        ctx.beginPath();
        ctx.arc(34, CANVAS_HEIGHT / 2, 14, 0, Math.PI * 2);
        ctx.fill();
        const text = person.name;
        const space = CANVAS_WIDTH - 80;
        let size = 44;
        ctx.font = `600 ${size}px sans-serif`;
        while (size > 20 && ctx.measureText(text).width > space) {
            size -= 2;
            ctx.font = `600 ${size}px sans-serif`;
        }
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 62, CANVAS_HEIGHT / 2 + 1, space);
        person.texture.needsUpdate = true;
    };

    /**
     * Create the figure of a person.
     *
     * @param {string} peerid Peer id.
     * @param {string} name Plain text name.
     * @returns {Object} Person record.
     */
    const createPerson = (peerid, name) => {
        const hue = hueOf(peerid);
        const colour = new THREE.Color().setHSL(hue / 360, 0.55, 0.55);
        const material = new THREE.MeshStandardMaterial({color: colour, roughness: 0.6, metalness: 0});
        const cursormaterial = new THREE.MeshBasicMaterial({color: colour, transparent: true, opacity: 0.7, depthWrite: false});

        const figure = new THREE.Group();
        figure.name = 'vrmakerspace-peer';
        figure.visible = false;

        const head = new THREE.Group();
        head.name = 'head';
        head.add(mesh(headgeometry, material, 'skull'));
        const visor = mesh(visorgeometry, visormaterial, 'visor');
        // On the face: the head looks along -z.
        visor.position.set(0, HEAD_RADIUS * 0.12, -HEAD_RADIUS * 0.72);
        head.add(visor);
        figure.add(head);

        const lefthand = mesh(handgeometry, material, 'lefthand');
        const righthand = mesh(handgeometry, material, 'righthand');
        const cursor = mesh(cursorgeometry, cursormaterial, 'cursor');
        lefthand.visible = false;
        righthand.visible = false;
        cursor.visible = false;
        figure.add(lefthand);
        figure.add(righthand);
        figure.add(cursor);

        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const labelmaterial = new THREE.SpriteMaterial({map: texture, transparent: true, depthTest: true});
        const label = new THREE.Sprite(labelmaterial);
        label.name = 'label';
        label.raycast = noRaycast;
        label.scale.set(LABEL_WIDTH, LABEL_WIDTH * CANVAS_HEIGHT / CANVAS_WIDTH, 1);
        figure.add(label);

        group.add(figure);
        const person = {
            peerid: peerid,
            name: name,
            css: '#' + colour.getHexString(),
            mode: 'vr',
            seq: 0,
            lastseen: 0,
            interpolator: createInterpolator({delay: delay}),
            figure, head, lefthand, righthand, cursor, label, canvas, texture, material, cursormaterial, labelmaterial,
        };
        drawLabel(person);
        return person;
    };

    /**
     * Remove a person's figure and release what is theirs alone.
     *
     * @param {Object} person Person record.
     */
    const destroy = (person) => {
        group.remove(person.figure);
        person.material.dispose();
        person.cursormaterial.dispose();
        person.labelmaterial.dispose();
        person.texture.dispose();
    };

    /**
     * Show a person at an interpolated pose.
     *
     * @param {Object} person Person record.
     * @param {Object} sample {h, l, r}
     */
    const show = (person, sample) => {
        applyPose(person.head, sample.h);
        person.label.position.set(sample.h[0], sample.h[1] + LABEL_HEIGHT, sample.h[2]);
        if (person.mode === '3d') {
            person.lefthand.visible = false;
            person.righthand.visible = false;
            person.cursor.visible = !!sample.r;
            if (sample.r) {
                person.cursor.position.set(sample.r[0], sample.r[1], sample.r[2]);
            }
        } else {
            person.cursor.visible = false;
            person.lefthand.visible = !!sample.l;
            person.righthand.visible = !!sample.r;
            if (sample.l) {
                applyPose(person.lefthand, sample.l);
            }
            if (sample.r) {
                applyPose(person.righthand, sample.r);
            }
        }
        person.figure.visible = true;
    };

    const api = {
        /**
         * A pose of a person arrived.
         *
         * @param {string} peerid Peer id.
         * @param {string} name Display name (plain text).
         * @param {Object} pose Pose message.
         * @param {number} nowms Local time (ms).
         * @returns {boolean} Whether the pose was kept.
         */
        update(peerid, name, pose, nowms) {
            if (disposed || !pose || typeof peerid !== 'string' || peerid === '') {
                return false;
            }
            const now = Number.isFinite(Number(nowms)) ? Number(nowms) : Date.now();
            const text = labelText(name);
            let person = people.get(peerid);
            if (!person) {
                person = createPerson(peerid, text);
                people.set(peerid, person);
            } else if (person.name !== text) {
                person.name = text;
                drawLabel(person);
            }
            person.mode = pose.m === '3d' ? '3d' : 'vr';
            const given = Number(pose.seq !== undefined ? pose.seq : pose.q);
            person.seq = Number.isFinite(given) ? given : person.seq + 1;
            const ts = Number(pose.ts);
            const kept = person.interpolator.push({
                seq: person.seq,
                ts: Number.isFinite(ts) ? ts : now,
                h: pose.h,
                l: pose.l || null,
                r: pose.r || null,
            }, now);
            if (kept) {
                person.lastseen = now;
            }
            return kept;
        },

        /**
         * A person left.
         *
         * @param {string} peerid Peer id.
         */
        remove(peerid) {
            const person = people.get(peerid);
            if (person) {
                people.delete(peerid);
                destroy(person);
            }
        },

        /**
         * Move every figure to its pose for this frame; remove people gone quiet.
         *
         * @param {number} nowms Local time (ms).
         */
        tick(nowms) {
            if (disposed) {
                return;
            }
            const now = Number(nowms);
            people.forEach((person, peerid) => {
                if (now - person.lastseen > TIMEOUT) {
                    api.remove(peerid);
                    return;
                }
                const sample = person.interpolator.sample(now);
                if (sample) {
                    show(person, sample);
                }
            });
        },

        /**
         * The peer ids shown.
         *
         * @returns {string[]}
         */
        peers() {
            return Array.from(people.keys());
        },

        /** Remove every figure and release all resources. */
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            people.forEach((person) => destroy(person));
            people.clear();
            if (group.parent) {
                group.parent.remove(group);
            }
            headgeometry.dispose();
            visorgeometry.dispose();
            handgeometry.dispose();
            cursorgeometry.dispose();
            visormaterial.dispose();
        },
    };
    return api;
};
