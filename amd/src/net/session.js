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
 * The sculpting session: who orders the ops, how they travel, saving and contributions.
 *
 * Modes:
 * - solo: one person; this client sequences its own ops.
 * - pair: two people over a direct WebRTC connection (mod_vrsculpt/net/pairtransport), no server
 *   of its own. The host sequences: its own ops like solo, the guest's ops with the guest's author
 *   id (from Moodle's peer list, never from the guest) and the next sequence number, and sends
 *   every confirmed op to the guest. A new connection starts with the host's confirmed state.
 *   When the host goes away, Moodle makes the guest the host and its pending ops are promoted.
 * - companion: up to eight people through vrroom-sync (mod_vrsculpt/net/companiontransport),
 *   which sequences every op; the author of an op is the peer id of the frame. Late joiners load
 *   the latest saved version and ask for the ops after it (replay); a gap in the server's ring is
 *   filled by asking the leader to save, then loading that version. Falls back to pair when the
 *   site has no companion service.
 * - view: read-only, a given version, no network.
 *
 * Every client applies the confirmed ops in sequence order, so all converge. An incoming op is
 * parsed with a size limit, rebuilt from its known keys, its author is set from the transport's
 * identity of the sender, then it goes to the engine; the engine's own checks (ops.cleanOp) run
 * in the worker.
 *
 * The leader saves (solo: self; pair: the host; companion: the connected peer with the smallest
 * peer id): every autosavems when the sequence moved, on saveNow(), when the page is hidden and on
 * stop(). A save sends the serialized confirmed state (header seq and epoch set to the room's
 * numbering) to mod_vrsculpt_save_snapshot.
 *
 * Events (detail objects):
 * - status   {state, text}: state solo|connecting|waiting|connected|reconnecting|resyncing|full|
 *            failed|closed|view
 * - peers    [{peerid, name}]: the other people present
 * - pose     {peerid, name, pose}: a decoded pose message of vrroomruntime_builtin/live/codec
 *            ({t, q, ts, sc, m, h, l, r}, sculpture-local)
 * - peerleft {peerid}
 * - notice   {text}: someone joined or left
 * - saving   {}
 * - saved    {version}
 * - savefailed {message}
 *
 * @module     mod_vrsculpt/net/session
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Ajax from 'core/ajax';
import Log from 'core/log';
import {getStrings} from 'core/str';
import {encode, decode} from 'vrroomruntime_builtin/live/codec';
import {Emitter} from 'mod_vrsculpt/net/emitter';
import {createPairTransport} from 'mod_vrsculpt/net/pairtransport';
import {createCompanionTransport} from 'mod_vrsculpt/net/companiontransport';

/** Grid size and voxel size of every sculpture (contract §2). */
const DIMS = 128;
const VOXEL = 0.004;

/** Op kinds (contract §3). */
const KINDS = Object.freeze(['add', 'carve', 'smooth', 'grab', 'twist', 'end', 'undo', 'redo', 'lock', 'unlock', 'save']);

/** Largest op JSON accepted from the network, in characters. */
const MAX_OP_TEXT = 1024;

/** Largest op index and stroke id. */
const MAX_INDEX = 2147483647;

/** Largest snapshot fetched from Moodle, in bytes. */
const MAX_SNAPSHOT = 33554432;

/** Smallest interval between two poses sent (ms): at most 15 Hz. */
const POSE_INTERVAL = 1000 / 15;

/** Pose messages accepted per peer per second. */
const MAX_POSE_PER_SECOND = 30;

/** Scene id of the pose messages (the codec requires one; the sculpture has a single scene). */
const POSE_SCENE = 'vrsculpt';

/** While filling a gap, look for a newer saved version this often (ms). */
const GAP_POLL = 3000;

/** Give up waiting for the leader's save after this long (ms) and take the latest version. */
const GAP_GIVE_UP = 60000;

/** The host keeps this many confirmed ops for a connection that is catching up. */
const HOST_LOG = 5000;

/** Most ops waiting for their turn (out of order) before the client starts again from a save. */
const MAX_FUTURE = 100000;

/** Ops per second sent to vrroom-sync (its limit is 60, burst 120). */
const SEND_RATE = 50;
const SEND_BURST = 100;

/** After the server refused an op for its rate limit, send the unconfirmed ops again after this long (ms). */
const RESEND_DELAY = 1000;

/** A lock counts only while its owner sent an op within this time (ms). */
const LOCK_IDLE = 20000;

/** Save at most this often when the page is hidden (ms). */
const HIDDEN_SAVE_INTERVAL = 10000;

/** Caps of one contribution report (the server's caps). */
const MAX_REPORT_OPS = 5000;
const MAX_REPORT_VOLUME = 10000000;

/** Retries of a replay that did not reach the announced sequence number before a reload. */
const MAX_REPLAY_RETRIES = 3;

/** Start of 2026 in seconds: op indexes count from here, so they keep growing across page loads. */
const INDEX_EPOCH = 1767225600;

/** Strings this module shows. */
const STRING_KEYS = Object.freeze([
    'status_solo', 'status_connecting', 'status_connected', 'status_waiting', 'status_reconnecting',
    'status_resyncing', 'status_full', 'status_failed', 'status_companionmissing', 'status_closed',
    'studio_readonly', 'peerjoined', 'peerleft', 'status_companionold', 'status_lost', 'status_replaced',
]);

/** Status states → string keys. */
const STATUS_KEYS = Object.freeze({
    solo: 'status_solo',
    connecting: 'status_connecting',
    waiting: 'status_waiting',
    connected: 'status_connected',
    reconnecting: 'status_reconnecting',
    resyncing: 'status_resyncing',
    full: 'status_full',
    failed: 'status_failed',
    closed: 'status_closed',
    view: 'studio_readonly',
});

/** Prefix of debug log lines. */
const LOGPREFIX = 'mod_vrsculpt/net/session: ';

/**
 * Turn a web-service rejection into an Error carrying an errorcode.
 *
 * @param {*} exception The rejection value.
 * @returns {Error} With errorcode ('network' for network failures).
 */
const toError = (exception) => {
    if (exception instanceof Error && typeof exception.errorcode === 'string') {
        return exception;
    }
    const code = exception && typeof exception === 'object' && typeof exception.errorcode === 'string'
        ? exception.errorcode : 'network';
    const message = exception && typeof exception === 'object' && typeof exception.message === 'string'
        ? exception.message : code;
    const error = new Error(message);
    error.errorcode = code;
    error.cause = exception;
    return error;
};

/**
 * Call one web service.
 *
 * @param {string} methodname
 * @param {Object} args
 * @param {boolean} [nosessionupdate] Whether the call must not extend the Moodle session.
 * @returns {Promise<Object>} Rejects with an Error carrying errorcode.
 */
const callService = async(methodname, args, nosessionupdate) => {
    try {
        return await Promise.resolve(Ajax.call([{methodname: methodname, args: args}], true, true, !!nosessionupdate)[0]);
    } catch (exception) {
        throw toError(exception);
    }
};

/**
 * Fill a string template: {$a} and {$a->name}.
 *
 * @param {string} template
 * @param {*} a
 * @returns {string}
 */
const fill = (template, a) => {
    let text = String(template);
    if (a !== undefined && a !== null && typeof a === 'object') {
        Object.keys(a).forEach((key) => {
            text = text.split('{$a->' + key + '}').join(String(a[key]));
        });
        return text;
    }
    return text.split('{$a}').join(a === undefined || a === null ? '' : String(a));
};

/**
 * View any bytes as a Uint8Array.
 *
 * @param {ArrayBuffer|Uint8Array|*} bytes
 * @returns {Uint8Array}
 */
const toBytes = (bytes) => {
    if (bytes instanceof Uint8Array) {
        return bytes;
    }
    if (bytes instanceof ArrayBuffer) {
        return new Uint8Array(bytes);
    }
    if (bytes && bytes.buffer instanceof ArrayBuffer) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    }
    return new Uint8Array(0);
};

/**
 * A copy of bytes in a fresh ArrayBuffer of exactly their length.
 *
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
const toArrayBuffer = (bytes) => bytes.slice().buffer;

/**
 * Base64 of bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const toBase64 = (bytes) => {
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + step)));
    }
    return btoa(binary);
};

/**
 * Read the sequence number and epoch of a "VRSC" snapshot header.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{seq: number, epoch: string}|null} epoch '' when the header has none; null when the data is
 *     not a snapshot.
 */
export const readHeader = (data) => {
    const bytes = toBytes(data);
    if (bytes.length < 48 || bytes[0] !== 0x56 || bytes[1] !== 0x52 || bytes[2] !== 0x53 || bytes[3] !== 0x43) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seq = view.getUint32(24, true);
    let epoch = '';
    for (let i = 28; i < 44; i++) {
        epoch += String.fromCharCode(bytes[i]);
    }
    return {seq: seq, epoch: /^[0-9a-f]{16}$/.test(epoch) ? epoch : ''};
};

/**
 * Set the sequence number and epoch of a snapshot header (in place).
 *
 * @param {Uint8Array} bytes A snapshot.
 * @param {number} seq
 * @param {string} epoch 16 hex characters or ''.
 */
const stampHeader = (bytes, seq, epoch) => {
    if (bytes.length < 48) {
        return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(24, Math.max(0, Math.min(0xffffffff, seq)), true);
    for (let i = 0; i < 16; i++) {
        bytes[28 + i] = /^[0-9a-f]{16}$/.test(epoch) ? epoch.charCodeAt(i) : 0;
    }
};

/**
 * A clean epoch: 16 hex characters or ''.
 *
 * @param {*} value
 * @returns {string}
 */
const cleanEpoch = (value) => (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : '');

/**
 * Whether a value is an array of three finite numbers.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isVec3 = (value) => Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && isFinite(v));

/**
 * Whether a value is an integer 1..MAX_INDEX.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isIndex = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_INDEX;

/**
 * Rebuild an op from its known keys in the wire order, with the given author. Types are checked
 * here; ranges are the engine's (ops.cleanOp).
 *
 * @param {*} source Op-like object.
 * @param {string} author Author id to stamp.
 * @returns {Object|null}
 */
const rebuildOp = (source, author) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || KINDS.indexOf(source.k) === -1) {
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
    const vectors = ['p', 'd', 'x'];
    const numbers = ['r', 'st', 'g'];
    ['p', 'r', 'st', 'd', 'x', 'g', 't'].forEach((key) => {
        if (source[key] === undefined) {
            return;
        }
        if (vectors.indexOf(key) !== -1) {
            op[key] = isVec3(source[key]) ? source[key].slice() : undefined;
        } else if (numbers.indexOf(key) !== -1) {
            op[key] = typeof source[key] === 'number' && isFinite(source[key]) ? source[key] : undefined;
        } else {
            op[key] = isIndex(source[key]) ? source[key] : undefined;
        }
    });
    for (const key of Object.keys(op)) {
        if (op[key] === undefined) {
            return null;
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
const parseOp = (text, author) => {
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
 * The first op index of this page: it grows with the clock (20 per second since 2026), so a
 * reloaded page continues above the indexes it used before.
 *
 * @returns {number}
 */
const firstIndex = () => {
    const base = (Math.floor(Date.now() / 1000) - INDEX_EPOCH) * 20;
    if (!(base > 0)) {
        return 1;
    }
    return (base % 2000000000) + 1;
};

/**
 * Whether two spheres overlap.
 *
 * @param {number[]} a Centre.
 * @param {number} ra Radius.
 * @param {number[]} b Centre.
 * @param {number} rb Radius.
 * @returns {boolean}
 */
const overlaps = (a, ra, b, rb) => {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    const reach = ra + rb;
    return dx * dx + dy * dy + dz * dz < reach * reach;
};

/**
 * The sculpting session.
 */
class Session extends Emitter {
    /**
     * Constructor.
     *
     * @param {Object} config {mode, cmid, sessionid, engine, user: {id, name}, model, modelurl, modelformat,
     *     snapshoturl, readonly, autosavems, contributionms, trackcontributions, strings}.
     */
    constructor(config) {
        super();
        const c = config || {};
        this.config = c;
        this.engine = c.engine;
        this.cmid = Number(c.cmid) || 0;
        this.sessionid = Number(c.sessionid) || 0;
        this.user = {id: Number(c.user && c.user.id) || 0, name: String((c.user && c.user.name) || '')};
        this.mode = c.readonly ? 'view' : (['solo', 'pair', 'companion', 'view'].indexOf(c.mode) === -1 ? 'solo' : c.mode);
        this.autosavems = Math.max(5000, Number(c.autosavems) || 60000);
        this.contributionms = Math.max(10000, Number(c.contributionms) || 30000);
        this.trackcontributions = !!c.trackcontributions;
        /** @type {Object<string, string>} string templates */
        this.texts = {};
        if (c.strings && typeof c.strings === 'object') {
            Object.keys(c.strings).forEach((key) => {
                if (typeof c.strings[key] === 'string') {
                    this.texts[key] = c.strings[key];
                }
            });
        }
        this.textfn = typeof c.strings === 'function' ? c.strings : null;
        /** @type {Object|null} the uploaded starting model {bytes, format}, once fetched */
        this.upload = null;
        // Role: 'sequencer' (solo, pair host), 'client' (pair guest, companion), 'detached', 'view'.
        this.role = 'detached';
        this.myauthor = 'u' + this.user.id;
        this.index = firstIndex();
        // Confirmed sequence in the room's numbering; the engine's numbering is seq + offset.
        this.seq = 0;
        this.offset = 0;
        this.epoch = '';
        this.lastsavedseq = 0;
        this.version = 0;
        this.closed = false;
        this.stopped = false;
        this.started = false;
        this.fallback = false;
        this.status = '';
        this.statusarg = undefined;
        /** @type {Map<string, string>} author id → display name */
        this.names = new Map();
        /** @type {Map<string, {p: number[], r: number}>} confirmed locks by author */
        this.locks = new Map();
        /** @type {Map<string, number>} author id → when its last confirmed op arrived (ms) */
        this.activity = new Map();
        // Own ops sent but not confirmed yet: {op, text, sentgen}.
        this.outbox = [];
        this.sendgen = 1;
        this.tokens = SEND_BURST;
        this.tokenstime = Date.now();
        this.flushtimer = null;
        this.resendtimer = null;
        this.synced = false;
        this.loading = false;
        this.saving = null;
        this.lasthiddensave = 0;
        this.reporting = false;
        this.reported = {ops: 0, added: 0, removed: 0};
        this.timers = [];
        this.poseq = 0;
        this.lastpose = 0;
        /** @type {Map<string, number[]>} peer → receive times of recent poses */
        this.posetimes = new Map();
        // Companion.
        this.companion = null;
        this.roomepoch = '';
        this.future = new Map();
        this.replaying = false;
        this.replayretries = 0;
        this.gap = null;
        this.gaptimer = null;
        // Pair.
        this.pair = null;
        this.remote = null;
        this.linkopen = false;
        this.guestsynced = false;
        this.transfer = 0;
        this.hostlog = [];
        /** @type {Map<string, number>} author → last confirmed op index (host dedupe) */
        this.lastindex = new Map();
        this.pairqueue = [];
        this.onPageHide = () => this.pageHidden(true);
        this.onVisibility = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                this.pageHidden(false);
            }
        };
    }

    // Public API.

    /**
     * Our author id (ops are stamped with it).
     *
     * @returns {string}
     */
    author() {
        return this.myauthor;
    }

    /**
     * The other people present.
     *
     * @returns {Array<{peerid: string, name: string}>}
     */
    peers() {
        if (this.companion) {
            return this.companion.peers().map((peer) => ({peerid: peer.peerid, name: peer.name}));
        }
        if (this.pair && this.remote && this.linkopen) {
            const author = 'u' + this.remote.userid;
            return [{peerid: author, name: this.remote.name}];
        }
        return [];
    }

    /**
     * Whether this client is the one that saves.
     *
     * @returns {boolean}
     */
    isLeader() {
        if (this.closed) {
            return false;
        }
        if (this.role === 'sequencer') {
            return true;
        }
        if (this.companion && this.role === 'client') {
            return this.synced && this.smallestPeer('') === this.myauthor;
        }
        return false;
    }

    /**
     * The name of another person whose lock overlaps a sphere.
     *
     * @param {number[]} p Centre (sculpture-local).
     * @param {number} r Radius.
     * @returns {string|null} Their display name, or null when the place is free.
     */
    lockOwner(p, r) {
        if (!isVec3(p) || !(r >= 0)) {
            return null;
        }
        const now = Date.now();
        for (const [author, lock] of this.locks) {
            if (author === this.myauthor) {
                continue;
            }
            if (now - (this.activity.get(author) || 0) > LOCK_IDLE) {
                continue;
            }
            if (overlaps(p, r, lock.p, lock.r)) {
                return this.names.get(author) || '';
            }
        }
        return null;
    }

    /**
     * Start: load the strings, initialise the engine with the latest version (or the given one),
     * then connect.
     *
     * @returns {Promise<void>}
     */
    async start() {
        if (this.started) {
            return;
        }
        this.started = true;
        await this.loadStrings();
        if (this.mode === 'view') {
            const bytes = this.config.snapshoturl ? await this.fetchSnapshot(this.config.snapshoturl) : null;
            await this.initEngine(bytes);
            this.role = 'view';
            this.setStatus('view');
            return;
        }
        const state = await callService('mod_vrsculpt_get_session_state', {cmid: this.cmid, sessionid: this.sessionid});
        this.version = Number(state.version) || 0;
        const url = this.config.snapshoturl || state.url || '';
        const bytes = url ? await this.fetchSnapshot(url) : null;
        await this.initEngine(bytes);
        if (Number(state.status) === 1 || !state.cansculpt) {
            this.closed = true;
            this.role = 'detached';
            this.setStatus('closed');
            return;
        }
        this.names.set(this.myauthor, this.user.name);
        if (this.mode === 'solo') {
            this.role = 'sequencer';
            this.setStatus('solo');
        } else if (this.mode === 'companion') {
            await this.startCompanion();
        } else {
            await this.startPair();
        }
        this.startTimers();
    }

    /**
     * Submit an op of this person: stamped with our author id and the next op index, applied
     * locally, then sequenced (solo, host) or sent to the sequencer.
     *
     * @param {Object} source The op (contract §3; 'a' and 'i' are set here).
     * @returns {boolean} Whether it was taken.
     */
    submit(source) {
        if (this.stopped || this.role === 'view' || !this.engine) {
            return false;
        }
        const op = rebuildOp(Object.assign({}, source, {i: this.nextIndex()}), this.myauthor);
        const text = op ? JSON.stringify(op) : '';
        if (!op || text.length > MAX_OP_TEXT) {
            return false;
        }
        if (this.role === 'sequencer') {
            this.engine.local(op);
            this.sequence(op);
            return true;
        }
        if (this.role === 'client') {
            // While a state loads, the op is applied on top of it afterwards (loadEngine).
            if (!this.loading) {
                this.engine.local(op);
            }
            this.outbox.push({op: op, text: text, sentgen: 0, local: !this.loading});
            this.flushOutbox();
            return true;
        }
        // Detached: the change shows here only.
        this.engine.local(op);
        return true;
    }

    /**
     * Send our pose to the others (at most 15 times a second).
     *
     * @param {{h: number[], l: (number[]|null), r: (number[]|null), m: (string|undefined)}|null} pose
     *     Sculpture-local [x, y, z, qx, qy, qz, qw] arrays; m 'vr' in VR, otherwise '3d'.
     * @returns {boolean} Whether it was sent.
     */
    sendPose(pose) {
        if (!pose || !Array.isArray(pose.h) || this.stopped) {
            return false;
        }
        const transport = this.companion || this.pair;
        if (!transport) {
            return false;
        }
        const now = Date.now();
        let interval = POSE_INTERVAL;
        if (this.companion) {
            interval = Math.max(interval, 1000 / Math.max(1, this.companion.poseRate()));
        }
        if (now - this.lastpose < interval) {
            return false;
        }
        if (this.companion ? !this.companion.isOpen() || !this.companion.peers().length : !this.linkopen) {
            return false;
        }
        this.poseq = this.poseq >= MAX_INDEX ? 0 : this.poseq + 1;
        const text = encode('pose', {
            t: 'p',
            q: this.poseq,
            ts: now,
            sc: POSE_SCENE,
            m: pose.m === 'vr' ? 'vr' : '3d',
            h: pose.h,
            l: Array.isArray(pose.l) ? pose.l : null,
            r: Array.isArray(pose.r) ? pose.r : null,
        });
        if (!text) {
            return false;
        }
        this.lastpose = now;
        return transport.sendPose(text);
    }

    /**
     * Save a version now.
     *
     * A client that is in step with the others saves the shared confirmed state itself; one that is
     * still catching up asks the leader with a 'save' op.
     *
     * @returns {Promise<{version: number}>}
     */
    async saveNow() {
        if (this.role === 'view' || this.closed || this.stopped) {
            throw new Error(this.text('status_closed'));
        }
        if (this.role === 'sequencer' || (this.role === 'client' && this.synced && !this.loading)) {
            return this.save();
        }
        if (this.role === 'client') {
            this.submit({k: 'save'});
            return {version: 0};
        }
        throw new Error(this.text(STATUS_KEYS[this.status] || 'status_failed', this.statusarg));
    }

    /**
     * Stop: the leader's final save, the last contribution report, then leave.
     *
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.stopped) {
            return;
        }
        const leader = this.isLeader();
        this.stopped = true;
        this.stopTimers();
        if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', this.onPageHide);
        }
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.onVisibility);
        }
        if (leader && this.seq !== this.lastsavedseq) {
            try {
                await this.save();
            } catch (error) {
                Log.debug(error);
            }
        }
        await this.reportContribution();
        if (this.companion) {
            this.companion.leave();
        }
        if (this.pair) {
            await this.pair.leave();
        }
    }

    // Strings and status.

    /**
     * Fetch the string templates this module shows (without parameters, so {$a} stays in them).
     *
     * @returns {Promise<void>}
     */
    async loadStrings() {
        const missing = STRING_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(this.texts, key));
        if (!missing.length || this.textfn) {
            return;
        }
        try {
            const values = await getStrings(missing.map((key) => ({key: key, component: 'mod_vrsculpt'})));
            missing.forEach((key, index) => {
                this.texts[key] = values[index];
            });
        } catch (error) {
            Log.debug(error);
        }
    }

    /**
     * A shown text.
     *
     * @param {string} key String key.
     * @param {*} [a] Parameter.
     * @returns {string}
     */
    text(key, a) {
        if (this.textfn) {
            return String(this.textfn(key, a));
        }
        return fill(Object.prototype.hasOwnProperty.call(this.texts, key) ? this.texts[key] : key, a);
    }

    /**
     * Change the status and tell listeners. A closed sculpture stays 'closed'.
     *
     * @param {string} state
     * @param {*} [a] Parameter of the text ('failed': the reason text).
     */
    setStatus(state, a) {
        if (this.closed && state !== 'closed') {
            return;
        }
        this.status = state;
        this.statusarg = a;
        let text;
        if (state === 'connected') {
            const names = this.peers().map((peer) => peer.name).filter((name) => name !== '');
            text = this.text('status_connected', names.join(', '));
        } else {
            text = this.text(STATUS_KEYS[state] || 'status_failed', a);
        }
        if (this.fallback && ['closed', 'view'].indexOf(state) === -1) {
            text = this.text('status_companionmissing') + ' ' + text;
        }
        this.emit('status', {state: state, text: text});
    }

    /**
     * Work out the status of a live mode from its state.
     */
    updateStatus() {
        if (this.stopped || this.role === 'detached' || this.role === 'view') {
            return;
        }
        if (this.companion) {
            if (!this.synced || this.loading) {
                this.setStatus('resyncing');
            } else {
                this.setStatus(this.companion.peers().length ? 'connected' : 'waiting');
            }
            return;
        }
        if (this.pair) {
            if (this.role === 'sequencer') {
                if (!this.remote) {
                    this.setStatus('waiting');
                } else {
                    this.setStatus(this.linkopen && this.guestsynced ? 'connected' : 'connecting');
                }
                return;
            }
            if (!this.remote) {
                this.setStatus(this.synced ? 'waiting' : 'connecting');
            } else if (this.linkopen && !this.synced) {
                this.setStatus('resyncing');
            } else {
                this.setStatus(this.linkopen && this.synced ? 'connected' : 'connecting');
            }
        }
    }

    /**
     * Tell listeners who is here.
     */
    emitPeers() {
        this.emit('peers', this.peers());
    }

    // Snapshots and engine.

    /**
     * Fetch a saved version.
     *
     * @param {string} url
     * @returns {Promise<Uint8Array|null>} null when there is nothing at the URL.
     */
    async fetchSnapshot(url) {
        const response = await fetch(url, {credentials: 'same-origin'});
        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            throw new Error('HTTP ' + response.status);
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_SNAPSHOT) {
            throw new Error('Snapshot too large');
        }
        return buffer.byteLength ? new Uint8Array(buffer) : null;
    }

    /**
     * The latest saved version.
     *
     * @returns {Promise<{version: number, bytes: (Uint8Array|null), header: (Object|null)}>}
     */
    async latestSnapshot() {
        const state = await callService('mod_vrsculpt_get_session_state', {cmid: this.cmid, sessionid: this.sessionid}, true);
        const version = Number(state.version) || 0;
        if (Number(state.status) === 1) {
            this.markClosed();
        }
        if (!state.url) {
            return {version: version, bytes: null, header: null};
        }
        const bytes = await this.fetchSnapshot(state.url);
        return {version: version, bytes: bytes, header: bytes ? readHeader(bytes) : null};
    }

    /**
     * The uploaded starting model, fetched once.
     *
     * @returns {Promise<{bytes: Uint8Array, format: string}>}
     */
    async uploadedModel() {
        if (!this.upload) {
            const bytes = await this.fetchSnapshot(this.config.modelurl);
            if (!bytes) {
                throw new Error('The starting model could not be fetched');
            }
            this.upload = {bytes: bytes, format: String(this.config.modelformat || '')};
        }
        return this.upload;
    }

    /**
     * Initialise the engine with a version (or the starting model).
     *
     * @param {Uint8Array|null} bytes
     * @returns {Promise<void>}
     */
    async initEngine(bytes) {
        const header = bytes ? readHeader(bytes) : null;
        const upload = !bytes && this.config.model === 'upload' ? await this.uploadedModel() : null;
        const result = await this.engine.init({
            dims: DIMS,
            voxel: VOXEL,
            model: this.config.model,
            upload: upload,
            snapshot: bytes ? toArrayBuffer(bytes) : null,
        });
        const engineseq = Number(result && result.seq) || 0;
        this.seq = header ? header.seq : engineseq;
        this.offset = engineseq - this.seq;
        this.epoch = cleanEpoch((result && result.epoch) || (header && header.epoch));
        this.lastsavedseq = this.seq;
    }

    /**
     * Replace the engine's state with a version that stands at a sequence number of the room.
     * Our own unconfirmed ops are applied on top again.
     *
     * @param {Uint8Array|null} bytes The version, or null to keep the current state.
     * @param {number} roomseq The room's sequence number the version stands at.
     * @returns {Promise<void>}
     */
    async loadEngine(bytes, roomseq) {
        if (bytes) {
            const result = await this.engine.load(toArrayBuffer(bytes));
            const engineseq = Number(result && result.seq) || 0;
            this.offset = engineseq - roomseq;
            if (this.role !== 'client' || !this.companion) {
                this.epoch = cleanEpoch(result && result.epoch);
            }
        } else {
            this.offset += this.seq - roomseq;
        }
        this.seq = roomseq;
        this.lastsavedseq = roomseq;
        this.locks.clear();
        this.outbox.forEach((entry) => {
            // A load drops every pending op; without a load only the ops held back are applied.
            if (bytes || !entry.local) {
                this.engine.local(entry.op);
                entry.local = true;
            }
        });
    }

    /**
     * The next own op index.
     *
     * @returns {number}
     */
    nextIndex() {
        this.index = this.index >= MAX_INDEX ? 1 : this.index + 1;
        return this.index;
    }

    // Sequencing and confirmed ops.

    /**
     * Sequence an op here (solo, host): next number, confirmed, sent on.
     *
     * @param {Object} op A stamped op.
     */
    sequence(op) {
        const n = this.seq + 1;
        this.engine.confirmed(op, n + this.offset);
        this.afterConfirmed(op, n);
    }

    /**
     * Book-keeping after a confirmed op: sequence, locks, activity, save requests, the host's log
     * and the guest.
     *
     * @param {Object} op
     * @param {number} n Its sequence number.
     */
    afterConfirmed(op, n) {
        this.seq = n;
        this.activity.set(op.a, Date.now());
        const last = this.lastindex.get(op.a) || 0;
        if (op.i > last) {
            this.lastindex.set(op.a, op.i);
        }
        if (op.k === 'lock') {
            this.locks.set(op.a, {p: op.p, r: op.r});
        } else if (op.k === 'unlock') {
            this.locks.delete(op.a);
        } else if (op.k === 'save' && this.servesSaveFor(op.a)) {
            this.save().catch((error) => Log.debug(error));
        }
        if (this.pair && this.role === 'sequencer') {
            const text = JSON.stringify(op);
            this.hostlog.push({n: n, text: text});
            if (this.hostlog.length > HOST_LOG) {
                this.hostlog.splice(0, this.hostlog.length - HOST_LOG);
            }
            if (this.linkopen && this.guestsynced) {
                this.pair.sendMessage({t: 'o', n: n, d: text});
            }
        }
    }

    /**
     * Our own op came back confirmed: it and every older one leave the outbox.
     *
     * @param {number} index Its op index.
     */
    ownConfirmed(index) {
        while (this.outbox.length && this.outbox[0].op.i <= index) {
            this.outbox.shift();
        }
    }

    /**
     * Whether this client answers a 'save' op of an author: the leader among the others.
     *
     * @param {string} requester Author of the save op.
     * @returns {boolean}
     */
    servesSaveFor(requester) {
        if (this.closed || this.stopped) {
            return false;
        }
        if (this.role === 'sequencer') {
            return requester !== this.myauthor;
        }
        if (this.companion && this.role === 'client' && this.synced && !this.loading) {
            return this.smallestPeer(requester) === this.myauthor;
        }
        return false;
    }

    /**
     * The smallest peer id of the room (us included), leaving one out.
     *
     * @param {string} except Peer id to leave out ('' for none).
     * @returns {string}
     */
    smallestPeer(except) {
        const ids = this.companion.peers().map((peer) => peer.peerid);
        ids.push(this.myauthor);
        return ids.filter((id) => id !== except).sort()[0] || '';
    }

    /**
     * Forget an author's locks (they left).
     *
     * @param {string} author
     */
    dropAuthor(author) {
        this.locks.delete(author);
        this.posetimes.delete(author);
    }

    /**
     * Send our unsent ops to the sequencer (rate-limited for vrroom-sync).
     */
    flushOutbox() {
        if (this.flushtimer) {
            clearTimeout(this.flushtimer);
            this.flushtimer = null;
        }
        if (this.role !== 'client' || !this.synced || this.loading) {
            return;
        }
        const now = Date.now();
        this.tokens = Math.min(SEND_BURST, this.tokens + (now - this.tokenstime) * SEND_RATE / 1000);
        this.tokenstime = now;
        for (const entry of this.outbox) {
            if (entry.sentgen === this.sendgen) {
                continue;
            }
            if (this.companion && this.tokens < 1) {
                this.flushtimer = setTimeout(() => {
                    this.flushtimer = null;
                    this.flushOutbox();
                }, 100);
                return;
            }
            const sent = this.companion ? this.companion.sendOp(entry.text)
                : this.pair.sendMessage({t: 'o', d: entry.text});
            if (!sent) {
                return;
            }
            entry.sentgen = this.sendgen;
            if (this.companion) {
                this.tokens -= 1;
            }
        }
    }

    /**
     * The server refused a frame of ours for its rate limit (an op, or a replay request): after a pause,
     * ask for the replay again when one is still awaited, and send every unconfirmed op again. Ops it
     * did take come back twice at most; every engine ignores the second copy (dedupe by author and op
     * index).
     */
    resendLater() {
        if (this.resendtimer || this.stopped) {
            return;
        }
        this.resendtimer = setTimeout(() => {
            this.resendtimer = null;
            if (this.stopped || !this.companion) {
                return;
            }
            if (this.replaying && !this.loading && !this.gap) {
                this.requestReplay(this.seq);
            }
            this.sendgen++;
            this.flushOutbox();
        }, RESEND_DELAY);
    }

    // Saving.

    /**
     * Save the confirmed state as a new version (one save at a time).
     *
     * @returns {Promise<{version: number}>}
     */
    save() {
        if (this.saving) {
            return this.saving;
        }
        this.saving = this.doSave().then((result) => {
            this.saving = null;
            return result;
        }, (error) => {
            this.saving = null;
            throw error;
        });
        return this.saving;
    }

    /**
     * Serialize, upload, report.
     *
     * @returns {Promise<{version: number}>}
     */
    async doSave() {
        if (this.closed) {
            throw new Error(this.text('status_closed'));
        }
        const seq = this.seq;
        const offset = this.offset;
        const epoch = this.companion ? this.roomepoch : this.epoch;
        this.emit('saving', {});
        let result;
        try {
            const serialized = await this.engine.serialize(epoch);
            const bytes = toBytes(serialized && serialized.bytes);
            const engineseq = Number(serialized && serialized.seq);
            // The confirmed state may have moved on between the request and the answer.
            const roomseq = isFinite(engineseq) ? engineseq - offset : seq;
            stampHeader(bytes, roomseq, epoch);
            result = await callService('mod_vrsculpt_save_snapshot', {
                cmid: this.cmid,
                sessionid: this.sessionid,
                data: toBase64(bytes),
                opcount: roomseq,
            });
            this.lastsavedseq = Math.max(this.lastsavedseq, roomseq);
        } catch (error) {
            const failure = toError(error);
            if (failure.errorcode === 'cannotsculpt') {
                this.markClosed();
            }
            this.emit('savefailed', {message: failure.message});
            throw failure;
        }
        this.version = Number(result && result.version) || this.version;
        if (result && Number(result.status) === 1) {
            this.markClosed();
        }
        this.emit('saved', {version: this.version});
        return {version: this.version};
    }

    /**
     * The sculpture was closed by a teacher: nothing more is saved.
     */
    markClosed() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.setStatus('closed');
    }

    /**
     * The page is hidden or unloads: the leader saves when the sequence moved, contributions are
     * reported.
     *
     * @param {boolean} unloading Whether the page unloads (pagehide).
     */
    pageHidden(unloading) {
        if (this.stopped) {
            return;
        }
        const now = Date.now();
        if (this.isLeader() && this.seq !== this.lastsavedseq && (unloading || now - this.lasthiddensave >= HIDDEN_SAVE_INTERVAL)) {
            this.lasthiddensave = now;
            this.save().catch((error) => Log.debug(error));
        }
        this.reportContribution().catch((error) => Log.debug(error));
        if (unloading && this.companion) {
            this.companion.leave();
        }
    }

    /**
     * Start autosave, contribution reports and the page listeners.
     */
    startTimers() {
        if (this.stopped || this.closed || this.role === 'view') {
            return;
        }
        this.timers.push(setInterval(() => {
            if (this.isLeader() && this.seq !== this.lastsavedseq) {
                this.save().catch((error) => Log.debug(error));
            }
        }, this.autosavems));
        if (this.trackcontributions) {
            this.timers.push(setInterval(() => {
                this.reportContribution().catch((error) => Log.debug(error));
            }, this.contributionms));
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', this.onPageHide);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.onVisibility);
        }
    }

    /**
     * Stop every timer of the session.
     */
    stopTimers() {
        this.timers.forEach((timer) => clearInterval(timer));
        this.timers = [];
        [this.flushtimer, this.gaptimer, this.resendtimer].forEach((timer) => {
            if (timer) {
                clearTimeout(timer);
            }
        });
        this.flushtimer = null;
        this.gaptimer = null;
        this.resendtimer = null;
    }

    /**
     * Report our own author's new contributions (ops, added and removed mm³) to Moodle.
     *
     * @returns {Promise<void>}
     */
    async reportContribution() {
        if (!this.trackcontributions || this.reporting || this.role === 'view' || this.closed || !this.engine) {
            return;
        }
        this.reporting = true;
        try {
            const stats = await this.engine.stats();
            const mine = stats && stats.contributions ? stats.contributions[this.myauthor] : null;
            if (!mine) {
                return;
            }
            const current = {
                ops: Number(mine.ops) || 0,
                added: Number(mine.added) || 0,
                removed: Number(mine.removed) || 0,
            };
            if (current.ops < this.reported.ops || current.added < this.reported.added
                    || current.removed < this.reported.removed) {
                // The engine started counting again (a state was loaded).
                this.reported = {ops: 0, added: 0, removed: 0};
            }
            const delta = {
                ops: Math.min(MAX_REPORT_OPS, Math.round(current.ops - this.reported.ops)),
                added: Math.min(MAX_REPORT_VOLUME, Math.round((current.added - this.reported.added) * 100) / 100),
                removed: Math.min(MAX_REPORT_VOLUME, Math.round((current.removed - this.reported.removed) * 100) / 100),
            };
            if (delta.ops <= 0 && delta.added <= 0 && delta.removed <= 0) {
                return;
            }
            const result = await callService('mod_vrsculpt_report_contribution', {
                cmid: this.cmid,
                sessionid: this.sessionid,
                ops: Math.max(0, delta.ops),
                added: Math.max(0, delta.added),
                removed: Math.max(0, delta.removed),
            }, true);
            if (result && result.accepted) {
                this.reported.ops += Math.max(0, delta.ops);
                this.reported.added += Math.max(0, delta.added);
                this.reported.removed += Math.max(0, delta.removed);
            }
        } catch (error) {
            Log.debug(error);
        } finally {
            this.reporting = false;
        }
    }

    // Poses.

    /**
     * A pose string from someone: rate-limited, decoded, passed on.
     *
     * @param {string} peerid Their author id.
     * @param {string} data Codec pose string.
     */
    receivePose(peerid, data) {
        const now = Date.now();
        let times = this.posetimes.get(peerid);
        if (!times) {
            times = [];
            this.posetimes.set(peerid, times);
        }
        while (times.length && now - times[0] >= 1000) {
            times.shift();
        }
        if (times.length >= MAX_POSE_PER_SECOND) {
            return;
        }
        times.push(now);
        const pose = decode('pose', data);
        if (pose) {
            this.emit('pose', {peerid: peerid, name: this.names.get(peerid) || '', pose: pose});
        }
    }

    // Companion mode.

    /**
     * Join the companion room; fall back to pair work when the site has no companion service.
     *
     * @returns {Promise<void>}
     */
    async startCompanion() {
        this.role = 'client';
        this.synced = false;
        this.setStatus('connecting');
        const transport = createCompanionTransport({cmid: this.cmid, sessionid: this.sessionid});
        this.companion = transport;
        transport.on('welcome', (detail) => this.onWelcome(detail.frame, detail.reconnect));
        transport.on('ops', (detail) => this.onOpsFrame(detail.frame));
        transport.on('replayed', (detail) => this.onReplayed(detail.seq));
        transport.on('gap', (detail) => this.onGap(detail.from, detail.first));
        transport.on('peerjoined', (detail) => {
            const known = this.names.has(detail.peer.peerid);
            this.names.set(detail.peer.peerid, detail.peer.name);
            if (!known) {
                this.emit('notice', {text: this.text('peerjoined', detail.peer.name)});
            }
            this.emitPeers();
            this.updateStatus();
        });
        transport.on('peerleft', (detail) => {
            const name = this.names.get(detail.peerid) || '';
            this.dropAuthor(detail.peerid);
            this.emit('peerleft', {peerid: detail.peerid});
            this.emit('notice', {text: this.text('peerleft', name)});
            this.emitPeers();
            this.updateStatus();
        });
        transport.on('pose', (detail) => this.receivePose(detail.peerid, detail.data));
        transport.on('error', (detail) => {
            Log.debug(LOGPREFIX + 'server error ' + detail.code);
            if (detail.code === 'ratelimited') {
                this.resendLater();
            }
        });
        transport.on('state', (detail) => this.onCompanionState(detail.state, detail.reason));
        try {
            await transport.join();
        } catch (error) {
            if (this.stopped) {
                return;
            }
            const code = error && error.errorcode ? error.errorcode : '';
            transport.removeAllListeners();
            this.companion = null;
            if (code === 'companionnotconfigured') {
                Log.debug(LOGPREFIX + 'no companion service: pair work');
                this.fallback = true;
                await this.startPair();
                return;
            }
            this.role = 'detached';
            if (error && error.reason === 'full') {
                this.setStatus('full');
            } else {
                this.setStatus('failed', error && error.message ? error.message : code);
            }
        }
    }

    /**
     * The companion transport's state changed after joining.
     *
     * @param {string} state
     * @param {string} reason
     */
    onCompanionState(state, reason) {
        if (this.stopped || !this.companion) {
            return;
        }
        if (state === 'reconnecting') {
            this.synced = false;
            this.replaying = false;
            this.setStatus('reconnecting');
        } else if (state === 'left' || state === 'failed') {
            if (this.status === 'connecting' && state === 'failed') {
                // Joining failed: startCompanion() reports it.
                return;
            }
            this.role = 'detached';
            this.synced = false;
            if (reason === 'full') {
                this.setStatus('full');
            } else if (reason === 'replaced') {
                this.setStatus('failed', this.text('status_replaced'));
            } else {
                this.setStatus('failed', this.text('status_lost'));
            }
        }
    }

    /**
     * A welcome: the first one, or after a reconnect.
     *
     * @param {Object} frame Parsed welcome.
     * @param {boolean} reconnect Whether it follows a reconnect.
     */
    onWelcome(frame, reconnect) {
        if (this.stopped) {
            return;
        }
        if (!frame.sculpt) {
            this.role = 'detached';
            this.setStatus('failed', this.text('status_companionold'));
            this.companion.leave();
            return;
        }
        this.myauthor = frame.self.p;
        this.names.set(this.myauthor, frame.self.name);
        this.sendgen++;
        this.synced = false;
        this.replaying = false;
        this.emitPeers();
        const epoch = frame.sculpt.epoch;
        if (!reconnect) {
            this.roomepoch = epoch;
            if (cleanEpoch(this.epoch) !== epoch) {
                // Our version belongs to an earlier room: the room's ops count from 0 on top of it.
                this.offset += this.seq;
                this.seq = 0;
                this.lastsavedseq = 0;
            }
            this.requestReplay(this.seq);
            return;
        }
        if (epoch === this.roomepoch) {
            this.requestReplay(this.seq);
            return;
        }
        this.roomepoch = epoch;
        this.reloadForRoom().catch((error) => Log.debug(error));
    }

    /**
     * The room started again (a new epoch): load the latest version and catch up from it.
     *
     * @returns {Promise<void>}
     */
    async reloadForRoom() {
        this.loading = true;
        this.setStatus('resyncing');
        const epoch = this.roomepoch;
        try {
            const latest = await this.latestSnapshot();
            if (epoch !== this.roomepoch) {
                return;
            }
            const sameroom = latest.header && latest.header.epoch === epoch;
            await this.loadEngine(latest.bytes, sameroom ? latest.header.seq : 0);
            this.version = latest.version;
        } catch (error) {
            Log.debug(error);
            await this.loadEngine(null, 0);
        } finally {
            this.loading = false;
        }
        this.requestReplay(this.seq);
    }

    /**
     * Ask for every op after a sequence number; live ops wait meanwhile.
     *
     * @param {number} from
     */
    requestReplay(from) {
        this.synced = false;
        this.replaying = true;
        Array.from(this.future.keys()).forEach((n) => {
            if (n <= from) {
                this.future.delete(n);
            }
        });
        this.updateStatus();
        if (!this.companion.sendReplay(from)) {
            // The socket closed; the next welcome asks again.
            this.replaying = false;
        }
    }

    /**
     * An ops frame (live or replayed).
     *
     * @param {Object} frame {ops: [{n, p, d}], r?}.
     */
    onOpsFrame(frame) {
        if (this.stopped || this.role !== 'client') {
            return;
        }
        let missing = false;
        frame.ops.forEach((entry) => {
            if (entry.n <= this.seq) {
                return;
            }
            if (!this.loading && entry.n === this.seq + 1) {
                this.applyEntry(entry);
                this.drainFuture();
                return;
            }
            if (this.future.size < MAX_FUTURE) {
                this.future.set(entry.n, entry);
            }
            if (!this.loading && this.synced && frame.r !== 1) {
                missing = true;
            }
        });
        if (missing && !this.replaying && !this.gap) {
            Log.debug(LOGPREFIX + 'missing ops after ' + this.seq);
            this.requestReplay(this.seq);
        }
    }

    /**
     * Apply one sequenced op of the room.
     *
     * @param {{n: number, p: string, d: string}} entry
     */
    applyEntry(entry) {
        const op = parseOp(entry.d, entry.p);
        if (op) {
            this.engine.confirmed(op, entry.n + this.offset);
            if (entry.p === this.myauthor) {
                this.ownConfirmed(op.i);
            }
            this.afterConfirmed(op, entry.n);
        } else {
            // An op nobody can apply still takes its number.
            this.seq = entry.n;
        }
    }

    /**
     * Apply the waiting ops that are next in line.
     */
    drainFuture() {
        while (this.future.has(this.seq + 1)) {
            const entry = this.future.get(this.seq + 1);
            this.future.delete(this.seq + 1);
            this.applyEntry(entry);
        }
    }

    /**
     * The replay is complete up to a sequence number.
     *
     * @param {number} seq
     */
    onReplayed(seq) {
        if (this.stopped || this.role !== 'client' || this.loading) {
            return;
        }
        this.drainFuture();
        this.replaying = false;
        if (this.seq < seq) {
            this.replayretries++;
            if (this.replayretries > MAX_REPLAY_RETRIES) {
                this.replayretries = 0;
                this.onGap(this.seq, this.seq + 1);
                return;
            }
            this.requestReplay(this.seq);
            return;
        }
        this.replayretries = 0;
        this.synced = true;
        this.gap = null;
        this.updateStatus();
        this.flushOutbox();
    }

    /**
     * The room no longer holds the ops we need: ask the leader to save, then load that version.
     *
     * @param {number} from
     * @param {number} first Oldest op the room holds.
     */
    onGap(from, first) {
        if (this.stopped || this.role !== 'client') {
            return;
        }
        this.replaying = false;
        this.synced = false;
        this.gap = {first: first, started: Date.now(), version: -1};
        this.setStatus('resyncing');
        // Not kept in the outbox: if it is lost, the poll below gives up after a while anyway.
        const op = rebuildOp({k: 'save', i: this.nextIndex()}, this.myauthor);
        this.companion.sendOp(JSON.stringify(op));
        this.scheduleGapPoll(0);
    }

    /**
     * Look for the version that fills the gap again after a while.
     *
     * @param {number} delay Milliseconds.
     */
    scheduleGapPoll(delay) {
        if (this.gaptimer) {
            clearTimeout(this.gaptimer);
        }
        this.gaptimer = setTimeout(() => {
            this.gaptimer = null;
            this.gapPoll().catch((error) => Log.debug(error));
        }, delay);
    }

    /**
     * One look for a version of this room at or after the gap; after a minute (or when nobody else
     * is here to save) the latest version is taken as it is.
     *
     * @returns {Promise<void>}
     */
    async gapPoll() {
        const gap = this.gap;
        if (!gap || this.stopped || !this.companion) {
            return;
        }
        const giveup = Date.now() - gap.started > GAP_GIVE_UP || !this.companion.peers().length;
        let latest = null;
        try {
            const state = await callService('mod_vrsculpt_get_session_state', {cmid: this.cmid, sessionid: this.sessionid},
                true);
            const version = Number(state.version) || 0;
            if (state.url && (version !== gap.version || giveup)) {
                gap.version = version;
                const bytes = await this.fetchSnapshot(state.url);
                latest = {bytes: bytes, header: bytes ? readHeader(bytes) : null, version: version};
            }
        } catch (error) {
            Log.debug(error);
        }
        if (gap !== this.gap) {
            return;
        }
        const fits = latest && latest.header && latest.header.epoch === this.roomepoch
            && latest.header.seq >= gap.first - 1;
        if (!fits && !giveup) {
            this.scheduleGapPoll(GAP_POLL);
            return;
        }
        this.loading = true;
        try {
            if (fits) {
                await this.loadEngine(latest.bytes, latest.header.seq);
            } else {
                // Nobody can fill the gap: continue from the oldest op the room still holds.
                Log.debug(LOGPREFIX + 'gap not filled; continuing from ' + (gap.first - 1));
                await this.loadEngine(latest ? latest.bytes : null, Math.max(0, gap.first - 1));
            }
            if (latest) {
                this.version = latest.version;
            }
        } finally {
            this.loading = false;
        }
        this.gap = null;
        this.sendgen++;
        this.requestReplay(this.seq);
    }

    // Pair mode.

    /**
     * Join the pair session.
     *
     * @returns {Promise<void>}
     */
    async startPair() {
        this.myauthor = 'u' + this.user.id;
        this.names.set(this.myauthor, this.user.name);
        this.role = 'client';
        this.synced = false;
        this.setStatus('connecting');
        const transport = createPairTransport({cmid: this.cmid, sessionid: this.sessionid});
        this.pair = transport;
        transport.on('role', (detail) => this.onPairRole(detail.role));
        transport.on('peers', (detail) => this.onPairPeers(detail.peers));
        transport.on('open', () => this.onPairOpen());
        transport.on('close', () => this.onPairClose());
        transport.on('message', (detail) => this.onPairMessage(detail.message));
        transport.on('state', (detail) => {
            this.onPairState(detail.seq, detail.li, detail.bytes).catch((error) => Log.debug(error));
        });
        transport.on('pose', (detail) => {
            if (this.remote && this.linkopen) {
                this.receivePose('u' + this.remote.userid, detail.data);
            }
        });
        transport.on('failed', (detail) => {
            this.role = 'detached';
            this.linkopen = false;
            if (detail.errorcode === 'sessionfull') {
                this.setStatus('full');
                return;
            }
            if (detail.errorcode === 'cannotsculpt') {
                this.markClosed();
                return;
            }
            this.setStatus('failed', detail.errorcode === 'replaced' ? this.text('status_replaced') : detail.message);
        });
        try {
            const me = await transport.join();
            this.myauthor = 'u' + (me.userid || this.user.id);
            this.names.set(this.myauthor, me.name || this.user.name);
            if (me.role === 'host') {
                this.becomeHost();
            } else {
                this.role = 'client';
                this.synced = false;
            }
            this.remote = transport.other();
            if (this.remote) {
                this.names.set('u' + this.remote.userid, this.remote.name);
            }
            this.updateStatus();
        } catch (error) {
            if (this.stopped) {
                return;
            }
            transport.removeAllListeners();
            this.pair = null;
            this.role = 'detached';
            if (error && error.errorcode === 'sessionfull') {
                this.setStatus('full');
            } else {
                this.setStatus('failed', error && error.message ? error.message : '');
            }
        }
    }

    /**
     * Our role changed: a guest that becomes the host promotes its pending ops; a host that
     * becomes a guest waits for the other host's state.
     *
     * @param {string} role 'host' or 'guest'.
     */
    onPairRole(role) {
        if (this.stopped || this.role === 'detached') {
            return;
        }
        if (role === 'host' && this.role !== 'sequencer') {
            Log.debug(LOGPREFIX + 'now the host');
            this.becomeHost();
        } else if (role === 'guest' && this.role === 'sequencer') {
            Log.debug(LOGPREFIX + 'now a guest');
            this.role = 'client';
            this.synced = false;
            this.guestsynced = false;
            this.hostlog = [];
        }
        this.updateStatus();
    }

    /**
     * Become the host: our unconfirmed ops are confirmed in order (engine.promote) and we sequence
     * from now on.
     */
    becomeHost() {
        const held = this.outbox.filter((entry) => !entry.local);
        const pending = this.outbox.filter((entry) => entry.local).map((entry) => entry.op);
        this.outbox = [];
        this.role = 'sequencer';
        this.synced = true;
        this.guestsynced = false;
        this.hostlog = [];
        if (pending.length) {
            this.engine.promote();
            pending.forEach((op) => this.afterConfirmed(op, this.seq + 1));
        }
        held.forEach((entry) => {
            this.engine.local(entry.op);
            this.sequence(entry.op);
        });
    }

    /**
     * The other person changed (arrived, left, another window, new role).
     *
     * @param {Array<Object>} peers 0 or 1 peers.
     */
    onPairPeers(peers) {
        const next = peers.length ? peers[0] : null;
        const before = this.remote;
        if (before && (!next || next.peerkey !== before.peerkey)) {
            const author = 'u' + before.userid;
            this.dropAuthor(author);
            if (!next || next.userid !== before.userid) {
                this.emit('notice', {text: this.text('peerleft', before.name)});
            }
            // A new page of the guest counts its op indexes afresh.
            this.lastindex.delete(author);
        }
        this.remote = next;
        if (next) {
            this.names.set('u' + next.userid, next.name);
        }
        this.updateStatus();
    }

    /**
     * The direct connection is up: the host sends its state, the guest waits for it.
     */
    onPairOpen() {
        this.linkopen = true;
        this.remote = this.pair.other() || this.remote;
        if (this.remote) {
            this.names.set('u' + this.remote.userid, this.remote.name);
            this.emit('notice', {text: this.text('peerjoined', this.remote.name)});
        }
        this.emitPeers();
        if (this.role === 'sequencer') {
            this.sendHostState().catch((error) => Log.debug(error));
        } else if (this.role === 'client') {
            this.synced = false;
        }
        this.updateStatus();
    }

    /**
     * The direct connection went down.
     */
    onPairClose() {
        const wasopen = this.linkopen;
        this.linkopen = false;
        this.guestsynced = false;
        this.transfer++;
        if (this.role === 'client') {
            this.synced = false;
        }
        if (wasopen && this.remote) {
            const author = 'u' + this.remote.userid;
            this.dropAuthor(author);
            this.emit('peerleft', {peerid: author});
        }
        this.emitPeers();
        this.updateStatus();
    }

    /**
     * The host sends its confirmed state, then the ops confirmed since, then its locks.
     *
     * @returns {Promise<void>}
     */
    async sendHostState() {
        const transfer = ++this.transfer;
        this.guestsynced = false;
        const offset = this.offset;
        const serialized = await this.engine.serialize(this.epoch);
        if (transfer !== this.transfer || this.role !== 'sequencer' || !this.linkopen || !this.remote) {
            return;
        }
        const bytes = toBytes(serialized && serialized.bytes);
        const engineseq = Number(serialized && serialized.seq);
        const roomseq = isFinite(engineseq) ? engineseq - offset : this.seq;
        stampHeader(bytes, roomseq, this.epoch);
        const guest = 'u' + this.remote.userid;
        const ok = await this.pair.sendState(bytes, roomseq, this.lastindex.get(guest) || 0);
        if (!ok || transfer !== this.transfer || this.role !== 'sequencer' || !this.linkopen) {
            return;
        }
        const following = this.hostlog.filter((entry) => entry.n > roomseq);
        if (roomseq < this.seq && (!following.length || following[0].n !== roomseq + 1)) {
            // The log no longer reaches back to the state: send a newer state.
            await this.sendHostState();
            return;
        }
        following.forEach((entry) => this.pair.sendMessage({t: 'o', n: entry.n, d: entry.text}));
        const locks = [];
        this.locks.forEach((lock, author) => locks.push([author, lock.p, lock.r]));
        this.pair.sendMessage({t: 'lk', l: locks.slice(0, 16)});
        this.guestsynced = true;
        this.updateStatus();
    }

    /**
     * A JSON message from the other person.
     *
     * @param {Object} message {t, ...}.
     */
    onPairMessage(message) {
        if (this.stopped || !this.remote) {
            return;
        }
        const remoteauthor = 'u' + this.remote.userid;
        if (this.role === 'sequencer') {
            if (message.t === 'o') {
                // The guest's op: its author comes from Moodle's peer list.
                const op = parseOp(message.d, remoteauthor);
                if (!op || op.i <= (this.lastindex.get(remoteauthor) || 0)) {
                    return;
                }
                this.sequence(op);
            } else if (message.t === 'sync') {
                this.sendHostState().catch((error) => Log.debug(error));
            }
            return;
        }
        if (this.role !== 'client') {
            return;
        }
        if (this.loading) {
            this.pairqueue.push(message);
            return;
        }
        this.guestMessage(message, remoteauthor);
    }

    /**
     * A message from the host, for the guest.
     *
     * @param {Object} message
     * @param {string} hostauthor The host's author id.
     */
    guestMessage(message, hostauthor) {
        if (message.t === 'o') {
            if (!this.synced || !Number.isInteger(message.n) || message.n <= this.seq) {
                return;
            }
            if (message.n !== this.seq + 1) {
                Log.debug(LOGPREFIX + 'ops out of step: asking for the state');
                this.synced = false;
                this.pair.sendMessage({t: 'sync'});
                this.updateStatus();
                return;
            }
            let author = '';
            try {
                const parsed = JSON.parse(String(message.d).slice(0, MAX_OP_TEXT + 1));
                author = parsed && typeof parsed.a === 'string' ? parsed.a : '';
            } catch (error) {
                author = '';
            }
            // The host stamps the author: only the two of us are possible.
            if (author !== hostauthor && author !== this.myauthor) {
                this.seq = message.n;
                return;
            }
            const op = parseOp(message.d, author);
            if (!op) {
                this.seq = message.n;
                return;
            }
            this.engine.confirmed(op, message.n + this.offset);
            if (author === this.myauthor) {
                this.ownConfirmed(op.i);
            }
            this.afterConfirmed(op, message.n);
        } else if (message.t === 'lk' && Array.isArray(message.l)) {
            message.l.slice(0, 16).forEach((entry) => {
                if (Array.isArray(entry) && entry.length === 3 && (entry[0] === hostauthor) && isVec3(entry[1])
                        && typeof entry[2] === 'number' && isFinite(entry[2])) {
                    this.locks.set(entry[0], {p: entry[1].slice(), r: entry[2]});
                    this.activity.set(entry[0], Date.now());
                }
            });
        }
    }

    /**
     * The host's state arrived (the guest): load it, put our unconfirmed ops on top, send them.
     *
     * @param {number} seq The state's sequence number.
     * @param {number} li Our last op index the host has confirmed.
     * @param {ArrayBuffer} bytes
     * @returns {Promise<void>}
     */
    async onPairState(seq, li, bytes) {
        if (this.stopped || this.role !== 'client' || !readHeader(bytes)) {
            return;
        }
        this.loading = true;
        this.updateStatus();
        try {
            this.outbox = this.outbox.filter((entry) => entry.op.i > li);
            await this.loadEngine(toBytes(bytes), seq);
            this.synced = true;
        } finally {
            this.loading = false;
        }
        const hostauthor = this.remote ? 'u' + this.remote.userid : '';
        const queued = this.pairqueue;
        this.pairqueue = [];
        queued.forEach((message) => this.guestMessage(message, hostauthor));
        this.sendgen++;
        this.updateStatus();
        this.flushOutbox();
    }
}

/**
 * Create a session (contract §10).
 *
 * @param {Object} config {mode, cmid, sessionid, engine, user, model, snapshoturl, readonly, autosavems,
 *     contributionms, trackcontributions, strings}.
 * @returns {Session}
 */
export const createSession = (config) => new Session(config);

export {Session};
