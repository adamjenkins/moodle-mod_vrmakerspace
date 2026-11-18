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
 * The tutor of tutorial mode: a small floating maker robot beside the piece, which points at where to act and,
 * on "Show me", does the action itself (mod_vrmakerspace/tutordemos).
 *
 * The robot is our own design: a rounded white body about 12 cm tall at the piece's scale, with an amber band and
 * antenna, a dark face screen with two bright eyes and a mouth, two floating hands and a name label. It floats
 * beside the piece to the viewer's left (in VR across the table, at eye height), turns to face the viewer, blinks,
 * talks while a bubble is new and cheers when a step is done. Everything lives under the sculpture's group, in its
 * frame, like the presence of the other makers (mod_vrmakerspace/presence): the label is drawn on a canvas with
 * fillText (plain text, never HTML). Nothing of it is picked by raycasts.
 *
 * Demos run on the tutor's own frames (update()), so they work on a desktop and in VR; while one runs `busy` is
 * true, so the tour does not count its ops as the student's. A demo first flies the robot to its working spot on
 * the piece (the demo reports it through ctx.onSpot): an eased flight of about 0.8 s that arcs up and a little
 * away from the viewer, ending beside the spot (never between the viewer and it), turned towards it; afterwards,
 * and when it is called off or fails, the robot flies back to its place.
 *
 * Talking with it (TUTORIAL-VOICE-CONTRACT.md §2): while it listens its eyes widen and a ring pulses round its
 * face, while it thinks three dots run across its screen, and while it speaks its mouth follows the sound's level
 * (setMouth); worldPosition() gives where its face is, for the sound's panner.
 *
 * @module     mod_vrmakerspace/tutor
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';
import {demo as runDemo, ease, vec3, viewBasis} from 'mod_vrmakerspace/tutordemos';

/** Colours: body, accent (band, antenna, hands, beam), face screen, eyes. */
const BODY_COLOUR = 0xf3f5f7;
const ACCENT_COLOUR = 0xffa62b;
const ACCENT_GLOW = 0x5a3300;
const SCREEN_COLOUR = 0x15181d;
const EYE_COLOUR = 0xaef9ff;

/** Body: radius, height of its centre and its stretch (m); the robot's origin is at its foot. */
const BODY_RADIUS = 0.04;
const BODY_Y = 0.055;
const BODY_STRETCH = [1, 1.15, 0.95];

/** Height of the face's centre (m): where a bubble about the tutor points. */
const FACE_Y = 0.068;

/** Height of the name label above the foot (m), and its width (m). */
const LABEL_Y = 0.15;
const LABEL_WIDTH = 0.13;

/** Label canvas size (px). */
const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 112;

/** Longest name shown on the label (characters, then an ellipsis). */
const NAME_MAX = 32;

/** Hands: radius, where they rest in the robot's frame (m), and how far one reaches out to point (m). */
const HAND_RADIUS = 0.011;
const HAND_REST = [0.058, 0.04, 0.014];
const HAND_REACH = 0.07;

/** Where the robot floats on a desktop: to the viewer's left, a little towards them, at the foot's height (m). */
const SIDE = 0.24;
const MIN_SIDE = 0.15;
const FORWARD = 0.04;
const FOOT_Y = -0.03;

/** In VR: across the table from the viewer, a little to their left, a little below the eye (m). */
const ACROSS = 0.34;
const VR_SIDE = 0.1;
const EYE_DROP = 0.08;
const VR_MIN_Y = 0;
const VR_MAX_Y = 0.6;

/** Where the viewer is when nobody has said (sculpture-local): the studio camera's start. */
const DEFAULT_VIEWER = [0, 0.12, 0.62];

/** Rates of following (1/s): the place, the turn, a hand, a hand in a demo. */
const FOLLOW_PLACE = 3;
const FOLLOW_TURN = 5;
const FOLLOW_HAND = 8;
const FOLLOW_DEMO_HAND = 16;

/** Floating: how high (m), how fast (rad/s). */
const FLOAT_HEIGHT = 0.006;
const FLOAT_SPEED = 1.7;

/** Blinks: the gap between them (s, shortest and longest) and how long one lasts (s). */
const BLINK_MIN = 2.5;
const BLINK_MAX = 5.5;
const BLINK_TIME = 0.14;

/** A cheer: how long (s), how high it jumps (m). */
const CHEER_TIME = 1.2;
const CHEER_JUMP = 0.03;

/** Longest talk (s). */
const MAX_TALK = 10;

/** Flights: how long (s), how high the arc rises (m) and how far it bows away from the viewer (m). */
const FLY_TIME = 0.8;
const ARC_UP = 0.08;
const ARC_BACK = 0.05;
/** A flight shorter than this is a hop (m): its arc is lower. Shorter than the least, it is no flight at all (m). */
const HOP = 0.25;
const NO_FLIGHT = 0.005;
/** A flight that has not ended by its time plus this (s, when frames do not come) ends at once. */
const FLY_GRACE = 1;

/** Working beside a spot: how far to its side (m), how far back from it, away from the viewer (m). */
const WORK_SIDE = 0.12;
const WORK_BACK = 0.02;
/** The robot keeps at least this far from the piece's upright axis while working and flying (m). */
const WORK_CLEAR = 0.15;
/** Lowest and highest the foot goes while working (m). */
const WORK_MIN_Y = -0.12;
const WORK_MAX_Y = 0.3;

/** How fast the mouth follows the sound's level (1/s); a level below this is silence. */
const FOLLOW_MOUTH = 25;
const MOUTH_QUIET = 0.02;

/** Longest frame step (s). */
const MAX_STEP = 0.1;

/** When the studio's frames do not come (a hidden tab), a demo steps on a timer instead (ms, s). */
const FALLBACK_WAIT = 120;
const FALLBACK_STEP = 0.12;

/**
 * A raycast that never hits (the tools and the VR pointers must not pick the tutor).
 *
 * @returns {undefined}
 */
const noRaycast = () => undefined;

/**
 * A number brought within a range.
 *
 * @param {number} v Value.
 * @param {number} min Least.
 * @param {number} max Most.
 * @returns {number}
 */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * How much of the way to go this frame, to follow at a rate.
 *
 * @param {number} rate Rate (1/s).
 * @param {number} dt Seconds.
 * @returns {number} 0 to 1.
 */
const follow = (rate, dt) => 1 - Math.exp(-rate * dt);

/**
 * Between two points.
 *
 * @param {number[]} a From.
 * @param {number[]} b To.
 * @param {number} t How far, 0 to 1.
 * @returns {number[]}
 */
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * The distance between two points.
 *
 * @param {number[]} a Point.
 * @param {number[]} b Point.
 * @returns {number}
 */
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The shortest turn from one angle to another.
 *
 * @param {number} from Angle (rad).
 * @param {number} to Angle (rad).
 * @returns {number} In -π..π.
 */
const angleTo = (from, to) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) {
        d -= Math.PI * 2;
    } else if (d < -Math.PI) {
        d += Math.PI * 2;
    }
    return d;
};

/**
 * A point of the robot's own frame (turned by yaw about its foot) in the sculpture's.
 *
 * @param {number[]} foot Where the foot is.
 * @param {number} yaw The robot's turn (rad).
 * @param {number[]} v The point in the robot's frame.
 * @returns {number[]}
 */
const fromRobot = (foot, yaw, v) => {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return [foot[0] + v[0] * cos + v[2] * sin, foot[1] + v[1], foot[2] - v[0] * sin + v[2] * cos];
};

/**
 * A display name as one short line of plain text.
 *
 * @param {*} name Name.
 * @returns {string}
 */
const labelText = (name) => {
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
 * Where the robot's foot goes for a viewer: beside the piece to their right (the toolbar's bubbles hang down on the
 * left), or across the table in VR, to their left.
 *
 * @param {number[]} viewer The viewer, sculpture-local.
 * @param {boolean} invr Whether in VR.
 * @param {number} halfwidth Half the width the view shows at the piece's distance (m); 0 when not known.
 * @returns {number[]}
 */
const restingPlace = (viewer, invr, halfwidth) => {
    const flat = Math.hypot(viewer[0], viewer[2]);
    const h = flat > 1e-6 ? [viewer[0] / flat, 0, viewer[2] / flat] : [0, 0, 1];
    // The viewer's left, looking at the piece along -h.
    const left = [-h[2], 0, h[0]];
    if (invr) {
        const y = clamp(viewer[1] - EYE_DROP, VR_MIN_Y, VR_MAX_Y);
        return [-h[0] * ACROSS + left[0] * VR_SIDE, y, -h[2] * ACROSS + left[2] * VR_SIDE];
    }
    // A narrow view (a phone) brings the robot in, and a little nearer the viewer, so it stays on screen.
    const side = halfwidth > 0 ? clamp(halfwidth * 0.7, MIN_SIDE, SIDE) : SIDE;
    const forward = FORWARD + (SIDE - side) * 0.5;
    return [-left[0] * side + h[0] * forward, FOOT_Y, -left[2] * side + h[2] * forward];
};

/**
 * The viewer's direction from the piece, level (y = 0), as a unit vector.
 *
 * @param {number[]} viewer The viewer, sculpture-local.
 * @returns {number[]}
 */
const levelTowards = (viewer) => {
    const flat = Math.hypot(viewer[0], viewer[2]);
    return flat > 1e-6 ? [viewer[0] / flat, 0, viewer[2] / flat] : [0, 0, 1];
};

/**
 * Where the robot's foot goes to work on a spot: beside it as the viewer sees it (on the spot's own side, so it
 * never stands between the viewer and the spot), a little behind it, clear of the piece, its body level with it.
 *
 * @param {number[]} spot The working spot, sculpture-local.
 * @param {number[]} viewer The viewer, sculpture-local.
 * @returns {number[]}
 */
export const workPlace = (spot, viewer) => {
    const basis = viewBasis(viewer);
    const right = basis.right;
    const h = levelTowards(viewer);
    const side = spot[0] * right[0] + spot[2] * right[2] >= 0 ? 1 : -1;
    /**
     * The place at a distance to the side.
     *
     * @param {number} lateral Metres to the side.
     * @returns {number[]}
     */
    const at = (lateral) => [spot[0] + right[0] * side * lateral - h[0] * WORK_BACK, 0,
        spot[2] + right[2] * side * lateral - h[2] * WORK_BACK];
    let lateral = WORK_SIDE;
    let place = at(lateral);
    for (let i = 0; i < 8 && Math.hypot(place[0], place[2]) < WORK_CLEAR; i++) {
        lateral += 0.02;
        place = at(lateral);
    }
    place[1] = clamp(spot[1] - BODY_Y, WORK_MIN_Y, WORK_MAX_Y);
    return place;
};

/**
 * How a flight between two places bends: up over the piece, and away from the viewer, so it does not cross in
 * front of what the viewer looks at.
 *
 * @param {number[]} from Where it starts.
 * @param {number[]} to Where it ends.
 * @param {number[]} viewer The viewer, sculpture-local.
 * @returns {{up: number, back: number[]}} How high the arc rises (m) and how far, and which way, it bows (m).
 */
export const flightArc = (from, to, viewer) => {
    const length = distance(from, to);
    const mid = lerp3(from, to, 0.5);
    const over = Math.max(0, WORK_CLEAR - Math.hypot(mid[0], mid[2]));
    const share = clamp(length / HOP, 0.3, 1);
    const h = levelTowards(viewer);
    return {up: (ARC_UP + over) * share, back: [-h[0] * ARC_BACK * share, 0, -h[2] * ARC_BACK * share]};
};

/**
 * A point of a flight.
 *
 * @param {number[]} from Where it starts.
 * @param {number[]} to Where it ends.
 * @param {Object} arc From flightArc().
 * @param {number} s How far in time, 0 to 1 (eased here).
 * @returns {number[]}
 */
export const flightPoint = (from, to, arc, s) => {
    const e = ease(s);
    const bow = Math.sin(Math.PI * e);
    const p = lerp3(from, to, e);
    return [p[0] + arc.back[0] * bow, p[1] + arc.up * bow, p[2] + arc.back[2] * bow];
};

/**
 * Create the tutor.
 *
 * @param {Object} options {THREE, scene, camera, sculptureRoot, strings: {tutor_name, tutor_watch, tutor_demofailed,
 *     tutor_demonomesh}}
 * @returns {Object} Tutor {group, busy, setVisible(on), setInVr(on), update(dt, viewerLocal, opts), pointAt(point),
 *     talk(seconds), cheer(), screenPosition(camera, canvas), worldPosition(out), flyTo(localPoint), goHome(),
 *     setListening(on), setThinking(on), setMouth(level), demo(name, ctx), stopDemo(), dispose()}
 */
export const createTutor = (options) => {
    const {THREE, sculptureRoot} = options;
    const strings = options.strings || {};
    const defaultcamera = options.camera || null;

    const group = new THREE.Group();
    group.name = 'vrmakerspace-tutor';
    sculptureRoot.add(group);

    const geometries = [];
    const materials = [];

    /**
     * Keep a geometry to dispose of later.
     *
     * @param {Object} geometry THREE.BufferGeometry.
     * @returns {Object} The geometry.
     */
    const keepGeometry = (geometry) => {
        geometries.push(geometry);
        return geometry;
    };

    /**
     * Keep a material to dispose of later.
     *
     * @param {Object} material THREE.Material.
     * @returns {Object} The material.
     */
    const keepMaterial = (material) => {
        materials.push(material);
        return material;
    };

    const bodymaterial = keepMaterial(new THREE.MeshStandardMaterial({color: BODY_COLOUR, roughness: 0.45, metalness: 0.05}));
    const accentmaterial = keepMaterial(new THREE.MeshStandardMaterial({color: ACCENT_COLOUR, emissive: ACCENT_GLOW,
        roughness: 0.5, metalness: 0}));
    const screenmaterial = keepMaterial(new THREE.MeshStandardMaterial({color: SCREEN_COLOUR, roughness: 0.25, metalness: 0.35}));
    const eyematerial = keepMaterial(new THREE.MeshBasicMaterial({color: EYE_COLOUR}));
    const glowmaterial = keepMaterial(new THREE.MeshBasicMaterial({color: ACCENT_COLOUR, transparent: true, opacity: 0.3,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}));

    /**
     * A part of the robot that is not picked by raycasts.
     *
     * @param {Object} geometry Geometry.
     * @param {Object} material Material.
     * @param {string} name Object name.
     * @param {Object} parent Where it goes.
     * @returns {Object} THREE.Mesh
     */
    const part = (geometry, material, name, parent) => {
        const m = new THREE.Mesh(geometry, material);
        m.name = name;
        m.raycast = noRaycast;
        parent.add(m);
        return m;
    };

    // The figure: its origin at the foot, facing +z (Object3D's own forward).
    const figure = new THREE.Group();
    figure.name = 'figure';
    group.add(figure);

    const body = part(keepGeometry(new THREE.SphereGeometry(BODY_RADIUS, 24, 18)), bodymaterial, 'body', figure);
    body.position.set(0, BODY_Y, 0);
    body.scale.set(BODY_STRETCH[0], BODY_STRETCH[1], BODY_STRETCH[2]);
    const band = part(keepGeometry(new THREE.TorusGeometry(BODY_RADIUS * 0.985, 0.004, 8, 40)), accentmaterial, 'band', figure);
    band.rotation.x = Math.PI / 2;
    band.position.set(0, BODY_Y - 0.012, 0);
    const screen = part(keepGeometry(new THREE.SphereGeometry(0.028, 24, 12)), screenmaterial, 'screen', figure);
    screen.position.set(0, FACE_Y, 0.028);
    screen.scale.set(1, 0.62, 0.35);

    const face = new THREE.Group();
    face.name = 'face';
    face.position.set(0, FACE_Y, 0.0385);
    figure.add(face);
    const eyegeometry = keepGeometry(new THREE.SphereGeometry(0.0045, 12, 8));
    const lefteye = part(eyegeometry, eyematerial, 'lefteye', face);
    const righteye = part(eyegeometry, eyematerial, 'righteye', face);
    lefteye.position.set(-0.009, 0.003, 0);
    righteye.position.set(0.009, 0.003, 0);
    const mouth = part(keepGeometry(new THREE.BoxGeometry(0.009, 0.0018, 0.001)), eyematerial, 'mouth', face);
    mouth.position.set(0, -0.0065, 0);
    // Thinking: three dots across the screen, where the mouth is.
    const dotgeometry = keepGeometry(new THREE.SphereGeometry(0.0022, 10, 6));
    const thinkdots = [-1, 0, 1].map((i) => {
        const d = part(dotgeometry, eyematerial, 'thinkdot', face);
        d.position.set(i * 0.0075, -0.006, 0);
        d.visible = false;
        return d;
    });
    // Listening: a ring that pulses round the face, facing out of it.
    const listenmaterial = keepMaterial(new THREE.MeshBasicMaterial({color: EYE_COLOUR, transparent: true, opacity: 0.5,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}));
    const listenring = part(keepGeometry(new THREE.RingGeometry(0.032, 0.0365, 40)), listenmaterial, 'listenring', figure);
    listenring.position.set(0, FACE_Y, 0.032);
    listenring.visible = false;
    listenring.renderOrder = 3;

    const antenna = part(keepGeometry(new THREE.CylinderGeometry(0.0015, 0.0015, 0.016, 6)), bodymaterial, 'antenna', figure);
    antenna.position.set(0, BODY_Y + BODY_RADIUS * BODY_STRETCH[1] + 0.006, 0);
    const tip = part(keepGeometry(new THREE.SphereGeometry(0.005, 12, 8)), accentmaterial, 'antennatip', figure);
    tip.position.set(0, BODY_Y + BODY_RADIUS * BODY_STRETCH[1] + 0.016, 0);

    // Hands float free in the sculpture's frame: they reach out to the piece.
    const handgeometry = keepGeometry(new THREE.SphereGeometry(HAND_RADIUS, 16, 12));
    const fingergeometry = keepGeometry(new THREE.ConeGeometry(0.0042, 0.013, 10));
    // The finger's tip along +y from the hand's centre.
    fingergeometry.translate(0, HAND_RADIUS + 0.004, 0);
    const hands = [-1, 1].map((side) => {
        const hand = new THREE.Group();
        hand.name = side < 0 ? 'lefthand' : 'righthand';
        part(handgeometry, accentmaterial, 'palm', hand).scale.set(1, 0.85, 1.1);
        part(fingergeometry, accentmaterial, 'finger', hand);
        group.add(hand);
        return {side: side, object: hand, position: [0, 0, 0], placed: false};
    });

    // The beam from the pointing hand and the ring where it points.
    const beamgeometry = keepGeometry(new THREE.CylinderGeometry(0.0022, 0.0035, 1, 10, 1, true));
    // From its base at the origin up to y = 1.
    beamgeometry.translate(0, 0.5, 0);
    const beam = part(beamgeometry, glowmaterial, 'beam', group);
    beam.visible = false;
    beam.renderOrder = 3;
    const ring = part(keepGeometry(new THREE.RingGeometry(0.006, 0.0095, 28)), glowmaterial, 'ring', group);
    ring.visible = false;
    ring.renderOrder = 3;

    // The name label.
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const labelmaterial = keepMaterial(new THREE.SpriteMaterial({map: texture, transparent: true, depthTest: true}));
    const label = new THREE.Sprite(labelmaterial);
    label.name = 'label';
    label.raycast = noRaycast;
    label.scale.set(LABEL_WIDTH, LABEL_WIDTH * CANVAS_HEIGHT / CANVAS_WIDTH, 1);
    label.position.set(0, LABEL_Y, 0);
    figure.add(label);

    /** Draw the name label (hidden when there is no name). */
    const drawLabel = () => {
        const text = labelText(strings.tutor_name);
        const ctx = canvas.getContext('2d');
        label.visible = text !== '' && !!ctx;
        if (!label.visible) {
            return;
        }
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.fillStyle = 'rgba(20, 24, 28, 0.78)';
        roundRect(ctx, 0, 6, CANVAS_WIDTH, CANVAS_HEIGHT - 12, 20);
        ctx.fill();
        ctx.fillStyle = '#' + new THREE.Color(ACCENT_COLOUR).getHexString();
        ctx.beginPath();
        ctx.arc(34, CANVAS_HEIGHT / 2, 14, 0, Math.PI * 2);
        ctx.fill();
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
        texture.needsUpdate = true;
    };
    drawLabel();

    const work = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const towards = new THREE.Vector3();
    const facing = new THREE.Vector3(0, 0, 1);

    /** State of the figure. */
    const state = {
        time: 0,
        placed: false,
        foot: [0, FOOT_Y, 0],
        yaw: 0,
        invr: false,
        viewer: DEFAULT_VIEWER.slice(),
        nextblink: BLINK_MIN,
        blink: 0,
        talk: 0,
        cheer: 0,
        /** @type {?number[]} where the tutor points (pointAt) */
        pointing: null,
        /** @type {?Object} where a demo holds the hand: {position, target} */
        held: null,
        /** Which hand points or works: 0 left, 1 right. */
        active: 1,
        /** @type {?Object} where the robot works, away from its place: {foot, spot} (flyTo) */
        away: null,
        listening: false,
        thinking: false,
        /** The sound's level the mouth follows (setMouth), and the mouth's own, 0 to 1. */
        mouthlevel: 0,
        mouth: 0,
    };

    /**
     * @type {?Object} the flight under way: {from, to (null: home), spot (null: home), arc, time, resolve, timer}
     */
    let flight = null;

    let busy = false;
    let cancelled = false;
    let disposed = false;
    /** @type {function(number)[]} demos waiting for the next frame */
    let waiters = [];

    /**
     * Half the width the camera shows at the distance of the piece (m).
     *
     * @returns {number} 0 when not known.
     */
    const halfWidth = () => {
        const cam = defaultcamera;
        if (!cam || !cam.isPerspectiveCamera || !(cam.aspect > 0)) {
            return 0;
        }
        const dist = Math.hypot(state.viewer[0], state.viewer[1], state.viewer[2]);
        return Math.tan((cam.fov * Math.PI / 180) / 2) * dist * cam.aspect;
    };

    /**
     * The hand nearer a point.
     *
     * @param {number[]} point The point.
     * @returns {number} 0 or 1.
     */
    const nearerHand = (point) => {
        const left = fromRobot(state.foot, state.yaw, [-HAND_REST[0], HAND_REST[1], HAND_REST[2]]);
        const right = fromRobot(state.foot, state.yaw, HAND_REST);
        return distance(left, point) <= distance(right, point) ? 0 : 1;
    };

    /**
     * End the flight under way.
     *
     * @param {Object} f The flight.
     * @param {boolean} arrived Whether it got there; false: it was called off and the robot waits where it is.
     */
    const endFlight = (f, arrived) => {
        if (flight !== f) {
            return;
        }
        flight = null;
        clearTimeout(f.timer);
        if (arrived) {
            const to = f.to || restingPlace(state.viewer, state.invr, halfWidth());
            state.foot = to.slice();
            state.away = f.spot ? {foot: to.slice(), spot: f.spot} : null;
        } else {
            state.away = {foot: state.foot.slice(), spot: f.spot};
        }
        f.resolve(arrived);
    };

    /**
     * Fly to a place: to work on a spot, or home (to: null).
     *
     * @param {?number[]} to Where the foot goes, or null for the robot's own place (which follows the viewer).
     * @param {?number[]} spot What it turns to there, or null.
     * @returns {Promise<boolean>} True when it got there, false when called off (by another flight, stopDemo or
     *     dispose); it never rejects.
     */
    const startFlight = (to, spot) => new Promise((resolve) => {
        if (flight) {
            endFlight(flight, false);
        }
        if (disposed) {
            resolve(false);
            return;
        }
        const home = restingPlace(state.viewer, state.invr, halfWidth());
        if (!state.placed) {
            state.foot = home.slice();
            state.placed = true;
        }
        const target = to || home;
        if (distance(state.foot, target) < NO_FLIGHT) {
            state.away = spot ? {foot: target.slice(), spot: spot} : null;
            resolve(true);
            return;
        }
        const f = {from: state.foot.slice(), to: to ? to.slice() : null, spot: spot, time: 0, resolve: resolve, timer: null,
            arc: flightArc(state.foot, target, state.viewer)};
        // Frames may not come (a hidden tab): the flight ends in time all the same.
        f.timer = setTimeout(() => endFlight(f, true), (FLY_TIME + FLY_GRACE) * 1000);
        flight = f;
        state.away = null;
    });

    /**
     * Where the foot is this frame: along a flight, at the working place, or following its own place.
     *
     * @param {number} dt Seconds.
     * @param {number[]} home The robot's own place now.
     */
    const placeFoot = (dt, home) => {
        if (flight) {
            const f = flight;
            f.time += dt;
            const s = Math.min(1, f.time / FLY_TIME);
            state.foot = flightPoint(f.from, f.to || home, f.arc, s);
            if (s >= 1) {
                endFlight(f, true);
            }
            return;
        }
        const goal = state.away ? state.away.foot : home;
        state.foot = state.placed ? lerp3(state.foot, goal, follow(FOLLOW_PLACE, dt)) : goal;
    };

    /**
     * Which way the robot wants to face: the spot it flies to or works on, otherwise the viewer.
     *
     * @returns {number} Yaw (rad).
     */
    const wantedYaw = () => {
        let spot = state.away ? state.away.spot : null;
        if (flight) {
            spot = flight.spot;
        }
        const at = spot || state.viewer;
        return Math.atan2(at[0] - state.foot[0], at[2] - state.foot[2]);
    };

    /**
     * Move the figure: follow its place (or fly), float, turn to the viewer or its work, jump when cheering.
     *
     * @param {number} dt Seconds.
     */
    const moveFigure = (dt) => {
        placeFoot(dt, restingPlace(state.viewer, state.invr, halfWidth()));
        const wanted = wantedYaw();
        state.yaw = state.placed ? state.yaw + angleTo(state.yaw, wanted) * follow(FOLLOW_TURN, dt) : wanted;
        state.placed = true;
        const p = state.cheer > 0 ? 1 - state.cheer / CHEER_TIME : 0;
        const jump = state.cheer > 0 ? Math.sin(Math.PI * p) * CHEER_JUMP : 0;
        const bob = Math.sin(state.time * FLOAT_SPEED) * FLOAT_HEIGHT;
        figure.position.set(state.foot[0], state.foot[1] + bob + jump, state.foot[2]);
        figure.rotation.set(Math.sin(state.time * FLOAT_SPEED * 0.5) * 0.03, state.yaw + (state.cheer > 0 ? p * Math.PI * 2 : 0),
            Math.sin(state.time * FLOAT_SPEED * 0.7) * 0.04);
    };

    /**
     * The eyes: blinks, a happy squint when cheering, wide while listening, looking up while thinking.
     *
     * @param {number} dt Seconds.
     */
    const moveEyes = (dt) => {
        if (state.blink > 0) {
            state.blink = Math.max(0, state.blink - dt);
        } else if (state.time >= state.nextblink) {
            state.blink = BLINK_TIME;
            state.nextblink = state.time + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        }
        const squint = state.cheer > 0 ? 0.45 : 1;
        const wide = state.listening ? 1.3 : 1;
        const eyey = state.blink > 0 ? 0.15 : 1.4 * squint * wide;
        const eyeup = state.thinking ? 0.0055 : 0.003;
        lefteye.scale.set(wide, eyey, 0.5);
        righteye.scale.set(wide, eyey, 0.5);
        lefteye.position.y = eyeup;
        righteye.position.y = eyeup;
    };

    /**
     * The mouth: the sound's level while it speaks, moving while a bubble is new, dots while it thinks.
     *
     * @param {number} dt Seconds.
     */
    const moveMouth = (dt) => {
        state.mouth += (state.mouthlevel - state.mouth) * follow(FOLLOW_MOUTH, dt);
        const speaking = state.mouth >= MOUTH_QUIET;
        if (state.talk > 0) {
            state.talk = Math.max(0, state.talk - dt);
        }
        const dots = state.thinking && !speaking;
        mouth.visible = !dots;
        thinkdots.forEach((d, i) => {
            d.visible = dots;
            if (dots) {
                d.scale.setScalar(0.6 + 0.7 * Math.max(0, Math.sin(state.time * 6 - i * 0.9)));
            }
        });
        if (speaking) {
            mouth.scale.set(1 + 0.4 * state.mouth, 1 + 4.5 * state.mouth, 1);
        } else if (state.talk > 0) {
            mouth.scale.set(1 + 0.3 * Math.abs(Math.sin(state.time * 9)), 1 + 2.5 * Math.abs(Math.sin(state.time * 16)), 1);
        } else {
            mouth.scale.set(state.cheer > 0 ? 1.6 : 1, state.cheer > 0 ? 2.2 : 1, 1);
        }
        tip.scale.setScalar(state.talk > 0 || speaking ? 1 + 0.25 * Math.abs(Math.sin(state.time * 8)) : 1);
    };

    /** The ring round the face while it listens. */
    const moveListenRing = () => {
        listenring.visible = state.listening;
        if (!state.listening) {
            return;
        }
        const pulse = 0.5 + 0.5 * Math.sin(state.time * 5);
        listenring.scale.setScalar(1 + 0.18 * pulse);
        listenmaterial.opacity = 0.6 - 0.35 * pulse;
    };

    /**
     * The face: eyes, mouth and the listening ring.
     *
     * @param {number} dt Seconds.
     */
    const moveFace = (dt) => {
        moveEyes(dt);
        moveMouth(dt);
        moveListenRing();
    };

    /**
     * Where a hand wants to be, and what it points at.
     *
     * @param {Object} hand The hand.
     * @param {number} index 0 or 1.
     * @returns {{goal: number[], target: ?number[], rate: number}}
     */
    const handGoal = (hand, index) => {
        const lift = state.cheer > 0 ? Math.sin(Math.PI * (1 - state.cheer / CHEER_TIME)) * 0.04 : 0;
        const rest = fromRobot(state.foot, state.yaw, [hand.side * HAND_REST[0],
            HAND_REST[1] + lift + Math.sin(state.time * FLOAT_SPEED + hand.side) * 0.004, HAND_REST[2]]);
        if (index !== state.active) {
            return {goal: rest, target: null, rate: FOLLOW_HAND};
        }
        if (state.held) {
            return {goal: state.held.position, target: state.held.target, rate: FOLLOW_DEMO_HAND};
        }
        if (state.pointing) {
            const dist = distance(rest, state.pointing);
            const reach = dist > 1e-6 ? Math.min(HAND_REACH, dist * 0.5) / dist : 0;
            return {goal: lerp3(rest, state.pointing, reach), target: state.pointing, rate: FOLLOW_HAND};
        }
        return {goal: rest, target: null, rate: FOLLOW_HAND};
    };

    /**
     * Show the beam from a hand to a point, and the ring there facing the viewer.
     *
     * @param {number[]} from The hand.
     * @param {?number[]} target The point, or null to hide them.
     */
    const showBeam = (from, target) => {
        const length = target ? distance(from, target) : 0;
        beam.visible = length > 0.005;
        ring.visible = !!target;
        if (!target) {
            return;
        }
        glowmaterial.opacity = 0.24 + 0.1 * Math.sin(state.time * 6);
        if (beam.visible) {
            beam.position.set(from[0], from[1], from[2]);
            towards.set(target[0] - from[0], target[1] - from[1], target[2] - from[2]).normalize();
            beam.quaternion.setFromUnitVectors(up, towards);
            beam.scale.set(1, length, 1);
        }
        ring.position.set(target[0], target[1], target[2]);
        towards.set(state.viewer[0] - target[0], state.viewer[1] - target[1], state.viewer[2] - target[2]);
        if (towards.lengthSq() > 1e-12) {
            ring.quaternion.setFromUnitVectors(facing, towards.normalize());
        }
        ring.scale.setScalar(1 + 0.2 * Math.sin(state.time * 5));
    };

    /**
     * Move the hands, the finger of the active one towards what it points at, and the beam.
     *
     * @param {number} dt Seconds.
     */
    const moveHands = (dt) => {
        let beamfrom = null;
        let beamto = null;
        hands.forEach((hand, index) => {
            const {goal, target, rate} = handGoal(hand, index);
            hand.position = hand.placed ? lerp3(hand.position, goal, follow(rate, dt)) : goal;
            hand.placed = true;
            hand.object.position.set(hand.position[0], hand.position[1], hand.position[2]);
            const aim = target || fromRobot(state.foot, state.yaw, [hand.side * HAND_REST[0], 0, HAND_REST[2] + 0.1]);
            towards.set(aim[0] - hand.position[0], aim[1] - hand.position[1], aim[2] - hand.position[2]);
            if (towards.lengthSq() > 1e-12) {
                hand.object.quaternion.setFromUnitVectors(up, towards.normalize());
            }
            if (target) {
                beamfrom = hand.position;
                beamto = target;
            }
        });
        showBeam(beamfrom || [0, 0, 0], beamto);
    };

    /**
     * Let the demos waiting for a frame go on.
     *
     * @param {number} dt Seconds of this frame.
     */
    const releaseWaiters = (dt) => {
        const list = waiters;
        waiters = [];
        list.forEach((resolve) => resolve(dt));
    };

    /**
     * A promise of the next frame's seconds; on a timer when the frames do not come.
     *
     * @returns {Promise<number>}
     */
    const nextFrame = () => new Promise((resolve) => {
        let done = false;
        /**
         * Resolve once.
         *
         * @param {number} dt Seconds.
         */
        const finish = (dt) => {
            if (!done) {
                done = true;
                resolve(dt);
            }
        };
        waiters.push(finish);
        setTimeout(() => finish(FALLBACK_STEP), FALLBACK_WAIT);
    });

    /**
     * What a demo is given on top of the studio's context.
     *
     * @param {Object} ctx The studio's context.
     * @returns {Object} The demo's context.
     */
    const demoContext = (ctx) => Object.assign({}, ctx, {
        THREE: THREE,
        sculptureRoot: sculptureRoot,
        strings: Object.assign({}, strings, ctx.strings || {}),
        view: () => state.viewer.slice(),
        /**
         * Hold the active hand at a point (null lets it go back to floating).
         *
         * @param {?number[]} position Where the hand is, sculpture-local.
         * @param {?number[]} target What it points at, sculpture-local.
         */
        hand: (position, target) => {
            const at = vec3(position);
            state.held = at ? {position: at, target: vec3(target)} : null;
        },
        handPosition: () => hands[state.active].position.slice(),
        /**
         * The demo's working spot: the robot flies beside it, and the hand nearer it works (unless one is held).
         *
         * @param {number[]} point Sculpture-local.
         * @returns {Promise<boolean>} When the flight is over: whether it got there.
         */
        onSpot: (point) => {
            const spot = vec3(point);
            if (!spot || cancelled || disposed) {
                return Promise.resolve(false);
            }
            return startFlight(workPlace(spot, state.viewer), spot).then((arrived) => {
                if (arrived && !state.held) {
                    state.active = nearerHand(spot);
                }
                return arrived;
            });
        },
        frame: nextFrame,
        cancelled: () => cancelled || disposed,
        log: (error) => Log.debug(error),
    });

    const api = {
        group: group,

        /** @returns {boolean} Whether a demo is running: its ops are not the student's. */
        get busy() {
            return busy;
        },

        /**
         * Show or hide the tutor.
         *
         * @param {boolean} on Whether it shows.
         */
        setVisible: (on) => {
            group.visible = !!on;
        },

        /**
         * Tell the tutor whether the student is in VR: it stands across the table then.
         *
         * @param {boolean} on Whether in VR.
         */
        setInVr: (on) => {
            state.invr = !!on;
        },

        /**
         * Per frame: float, blink, face the viewer, move the hands, and step a demo.
         *
         * @param {number} dt Seconds since the last frame.
         * @param {?Object|number[]} viewerLocal The viewer's eye in the sculpture's frame (THREE.Vector3 or [x, y, z]).
         * @param {Object} [opts] {inVr: boolean}, the same as setInVr().
         */
        update: (dt, viewerLocal, opts) => {
            if (disposed) {
                return;
            }
            const step = clamp(Number(dt) || 0, 0, MAX_STEP);
            state.time += step;
            const viewer = vec3(viewerLocal);
            if (viewer) {
                state.viewer = viewer;
            }
            if (opts && typeof opts.inVr === 'boolean') {
                state.invr = opts.inVr;
            }
            state.cheer = Math.max(0, state.cheer - step);
            moveFigure(step);
            moveFace(step);
            moveHands(step);
            releaseWaiters(step);
        },

        /**
         * Point at a spot on the piece, or stop pointing.
         *
         * @param {?Object|number[]} localPoint Sculpture-local point, or null.
         */
        pointAt: (localPoint) => {
            state.pointing = vec3(localPoint);
            if (state.pointing && !busy) {
                state.active = nearerHand(state.pointing);
            }
        },

        /**
         * Talk for a while (the mouth moves): while a bubble is new.
         *
         * @param {number} seconds How long.
         */
        talk: (seconds) => {
            state.talk = Math.max(state.talk, clamp(Number(seconds) || 0, 0, MAX_TALK));
        },

        /** A short happy jump and spin: a step is done. */
        cheer: () => {
            state.cheer = CHEER_TIME;
        },

        /**
         * Where the tutor's face is on screen, to anchor a bubble that is about the tutor.
         *
         * @param {Object} [camera] THREE.Camera; the studio's camera when not given.
         * @param {HTMLElement} canvas The canvas.
         * @returns {{x: number, y: number, clientX: number, clientY: number, visible: boolean}} CSS pixels: x and y
         *     from the canvas's top left, clientX and clientY in the viewport; visible false when behind the camera,
         *     off the canvas or hidden.
         */
        screenPosition: (camera, canvas) => {
            const cam = camera || defaultcamera;
            const rect = canvas && typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
            if (!cam || !rect) {
                return {x: 0, y: 0, clientX: 0, clientY: 0, visible: false};
            }
            figure.updateWorldMatrix(true, false);
            work.set(0, FACE_Y, 0);
            figure.localToWorld(work);
            work.project(cam);
            const x = (work.x + 1) / 2 * rect.width;
            const y = (1 - work.y) / 2 * rect.height;
            const visible = group.visible && work.z > -1 && work.z < 1 && Math.abs(work.x) <= 1 && Math.abs(work.y) <= 1;
            return {x: x, y: y, clientX: rect.left + x, clientY: rect.top + y, visible: visible};
        },

        /**
         * Show how a step is done: the tutor flies beside the demo's working spot, does it on the practice piece and
         * flies back to its place (also when the demo fails or is called off; the promise does not wait for that).
         *
         * @param {string} name A demo name (mod_vrmakerspace/tutordemos DEMO_NAMES).
         * @param {Object} ctx {tools, modeltools, engine, session, setMethod, method, toolbar, message (optional)}
         * @returns {Promise<boolean>} Whether it was shown in full (false: refused, not possible here, called off, or
         *     another demo is running). It never rejects, and the tools are left as they were.
         */
        demo: (name, ctx) => {
            if (disposed || busy) {
                return Promise.resolve(false);
            }
            busy = true;
            cancelled = false;
            state.pointing = null;
            state.active = nearerHand([0, 0, 0]);
            api.talk(1.5);
            return runDemo(name, demoContext(ctx || {}))
                .catch((error) => {
                    Log.debug(error);
                    return false;
                })
                .then((shown) => {
                    busy = false;
                    state.held = null;
                    if (!disposed) {
                        if (shown) {
                            api.cheer();
                        }
                        // Back to its place, shown in full or not; the student can try at once (not awaited).
                        startFlight(null, null);
                    }
                    return !!shown;
                });
        },

        /**
         * Call off a demo that is running: it stops where it is, keeping what it has done, puts the tools back, and
         * the robot flies back to its place.
         */
        stopDemo: () => {
            cancelled = true;
            if (flight && flight.spot) {
                endFlight(flight, false);
            }
            releaseWaiters(0);
            if (!busy && state.away) {
                startFlight(null, null);
            }
        },

        /**
         * Fly beside a spot on the piece and turn to it (a demo does this by itself, through ctx.onSpot).
         *
         * @param {?Object|number[]} localPoint The spot, sculpture-local.
         * @returns {Promise<boolean>} When the flight is over: whether it got there; it never rejects.
         */
        flyTo: (localPoint) => {
            const spot = vec3(localPoint);
            return spot ? startFlight(workPlace(spot, state.viewer), spot) : Promise.resolve(false);
        },

        /**
         * Fly back to its own place beside the piece (across the table in VR).
         *
         * @returns {Promise<boolean>} When it is there (true at once when it already is); it never rejects.
         */
        goHome: () => (!flight && !state.away ? Promise.resolve(true) : startFlight(null, null)),

        /**
         * Listening (push to talk is held): the eyes widen and a ring pulses round the face.
         *
         * @param {boolean} on Whether it listens.
         */
        setListening: (on) => {
            state.listening = !!on;
        },

        /**
         * Thinking (an answer is on its way): three dots run across the face screen.
         *
         * @param {boolean} on Whether it thinks.
         */
        setThinking: (on) => {
            state.thinking = !!on;
        },

        /**
         * The level of the sound it speaks, which the mouth follows; 0 when silent.
         *
         * @param {number} level 0 to 1.
         */
        setMouth: (level) => {
            state.mouthlevel = clamp(Number(level) || 0, 0, 1);
        },

        /**
         * Where the tutor's face is in the world (for the panner its voice comes from).
         *
         * @param {Object|number[]} [out] THREE.Vector3 (or an array of 3) to write to; a new Vector3 when not given.
         * @returns {Object|number[]} out
         */
        worldPosition: (out) => {
            figure.updateWorldMatrix(true, false);
            work.set(0, FACE_Y, 0);
            figure.localToWorld(work);
            if (Array.isArray(out)) {
                out[0] = work.x;
                out[1] = work.y;
                out[2] = work.z;
                return out;
            }
            const target = out && typeof out.set === 'function' ? out : new THREE.Vector3();
            return target.set(work.x, work.y, work.z);
        },

        /** Remove the tutor and release all its resources. */
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            cancelled = true;
            if (flight) {
                endFlight(flight, false);
            }
            releaseWaiters(0);
            if (group.parent) {
                group.parent.remove(group);
            }
            geometries.forEach((geometry) => geometry.dispose());
            materials.forEach((material) => material.dispose());
            texture.dispose();
        },
    };
    return api;
};
