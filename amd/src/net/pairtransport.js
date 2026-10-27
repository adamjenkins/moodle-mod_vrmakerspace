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
 * Pair transport: one direct WebRTC connection between the two people sculpting a group's
 * sculpture together, with no server of its own.
 *
 * Moodle relays the signalling (web services mod_vrsculpt_pair_join, _signal, _poll and _leave)
 * and decides the roles: the host sequences the ops, the guest creates the offer. The poll is the
 * presence heartbeat too, so it never stops while the studio is open: every pollms while
 * connecting, every 5 s once the connection is up. When the host goes away, the poll tells the
 * guest that it is the host now ('role' event).
 *
 * The connection has two negotiated data channels: 'ops' (id 0, ordered, reliable) carries JSON
 * messages of at most 16 KB and the host's state transfer (a header, then binary pieces of at most
 * 16 KB), 'pose' (id 1, unordered, no retransmits) carries codec pose strings of at most 1 KB.
 * Everything received is size-checked; JSON messages must be objects with a string 't'.
 *
 * Events (detail objects):
 * - role    {role, previous}: our role changed ('host' or 'guest')
 * - peers   {peers}: the other active person (an array of 0 or 1 {userid, name, peerkey, role})
 * - open    {remote}: the connection to the other person is up
 * - close   {remote}: it went down
 * - message {message, remote}: a JSON message on the ops channel
 * - state   {seq, li, bytes, remote}: a complete state transfer (bytes an ArrayBuffer)
 * - pose    {data, remote}: a pose string on the pose channel
 * - failed  {errorcode, message}: the pair session cannot go on ('replaced' when another window
 *           of the same person took over)
 *
 * The two people see each other's network addresses (ICE candidates); the privacy metadata says
 * so. Link handling (batched candidates, ICE restart, watchdogs, pagehide leave) follows the
 * built-in mesh transport of vrroomruntime_builtin, which adapts mod_gear's collaborative mode.
 *
 * @module     mod_vrsculpt/net/pairtransport
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Ajax from 'core/ajax';
import Config from 'core/config';
import Log from 'core/log';
import {Emitter} from 'mod_vrsculpt/net/emitter';

/** Web-service request timeout in ms. */
const REQUEST_TIMEOUT = 10000;

/** Poll interval once connected (ms). */
const CONNECTED_POLL = 5000;

/** Smallest and largest poll interval accepted from the server (ms). */
const MIN_POLL = 500;
const MAX_POLL = 5000;

/** Retry delays after consecutive poll network errors (ms; the last one repeats). */
const POLL_BACKOFF = Object.freeze([2000, 4000, 8000, 10000]);

/** Join calls made while the server answers 'pairbusy' before giving up. */
const JOIN_BUSY_RETRIES = 3;

/** A 'peergone' within this time of the last good poll means another window took over (ms). */
const REPLACED_WINDOW = 15000;

/** Largest JSON message on the ops channel (characters) and largest binary piece (bytes). */
export const MAX_MESSAGE = 16384;

/** Largest state transfer in bytes. */
export const MAX_STATE = 8388608;

/** Largest pose message (characters). */
const MAX_POSE = 1024;

/** Largest signal payload (server limit, characters). */
const MAX_SIGNAL = 65536;

/** Local ICE candidates are batched for this long (ms). */
const CANDIDATE_BATCH_DELAY = 100;

/** Candidates per signal. */
const MAX_CANDIDATES_PER_SIGNAL = 30;

/** A new link that has not connected after this long is re-created (ms). */
const CONNECT_TIMEOUT = 20000;

/** After a failure (and an ICE restart), or a disconnect, wait this long for 'connected' (ms). */
const RESTART_GRACE = 15000;

/** While sending the state, wait when more than this many bytes are buffered. */
const SEND_HIGH_WATER = 1048576;

/** The channel tells us when the buffer is below this. */
const SEND_LOW_WATER = 262144;

/** Skip a pose while this many bytes wait on the pose channel. */
const POSE_BUFFER_LIMIT = 16384;

/** Data channel settings. */
const CHANNELS = Object.freeze({
    ops: Object.freeze({negotiated: true, id: 0, ordered: true}),
    pose: Object.freeze({negotiated: true, id: 1, ordered: false, maxRetransmits: 0}),
});

/** Prefix of debug log lines. */
const LOGPREFIX = 'mod_vrsculpt/net/pairtransport: ';

/**
 * Turn a web-service rejection into an Error carrying an errorcode.
 *
 * @param {*} exception The rejection value.
 * @returns {Error} With errorcode ('network' for network failures) and cause.
 */
const toError = (exception) => {
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
 * The default web-service call.
 *
 * @param {string} methodname Function name.
 * @param {Object} args Arguments.
 * @param {boolean} nosessionupdate Whether the call must not extend the Moodle session.
 * @returns {Promise<Object>}
 */
const defaultCall = (methodname, args, nosessionupdate) => Promise.resolve(
    Ajax.call([{methodname: methodname, args: args}], true, true, nosessionupdate, REQUEST_TIMEOUT)[0]
);

/**
 * Whether a value is a peer key issued by Moodle.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isPeerKey = (value) => typeof value === 'string' && /^[A-Za-z0-9]{1,32}$/.test(value);

/**
 * Whether a web-service error is worth trying again: a network failure, or the server's session lock
 * was busy ('pairbusy').
 *
 * @param {Error} error With errorcode.
 * @returns {boolean}
 */
const isTransient = (error) => error.errorcode === 'network' || error.errorcode === 'pairbusy';

/**
 * Clean the peer list of a join or poll result.
 *
 * @param {*} list Server peers.
 * @returns {Array<{userid: number, name: string, peerkey: string, role: string}>}
 */
const cleanPeers = (list) => (Array.isArray(list) ? list : []).filter((peer) => peer && isPeerKey(peer.peerkey)
        && Number(peer.userid) > 0).map((peer) => ({
    userid: Number(peer.userid),
    name: typeof peer.name === 'string' ? peer.name : '',
    peerkey: peer.peerkey,
    role: peer.role === 'host' ? 'host' : 'guest',
}));

/**
 * Clean the ICE servers of the join result for RTCPeerConnection.
 *
 * @param {*} list Server list [{urls: [string], username, credential}].
 * @returns {Array<Object>}
 */
const cleanIceServers = (list) => {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((server) => {
        if (!server || !Array.isArray(server.urls)) {
            return;
        }
        const urls = server.urls.filter((url) => typeof url === 'string' && /^(stun|turn|turns):/.test(url));
        if (!urls.length) {
            return;
        }
        const entry = {urls: urls};
        if (typeof server.username === 'string' && server.username !== '') {
            entry.username = server.username;
        }
        if (typeof server.credential === 'string' && server.credential !== '') {
            entry.credential = server.credential;
        }
        out.push(entry);
    });
    return out;
};

/**
 * Clamp the poll interval of the server.
 *
 * @param {*} value Milliseconds.
 * @returns {number}
 */
const clampPoll = (value) => {
    const ms = Number(value);
    if (!isFinite(ms)) {
        return 1000;
    }
    return Math.min(MAX_POLL, Math.max(MIN_POLL, Math.round(ms)));
};

/**
 * Copy a peer for listeners.
 *
 * @param {Object|null} peer
 * @returns {Object|null}
 */
const copyPeer = (peer) => (peer ? {userid: peer.userid, name: peer.name, peerkey: peer.peerkey, role: peer.role} : null);

/**
 * One RTCPeerConnection to the other person.
 */
class Link {
    /**
     * Constructor.
     *
     * @param {PairTransport} transport Owner.
     * @param {Object} remote The other peer {userid, name, peerkey, role}.
     * @param {number} gen Generation (a higher one from the guest replaces the link).
     * @param {boolean} initiator Whether this side sends the offer (the guest).
     */
    constructor(transport, remote, gen, initiator) {
        this.transport = transport;
        this.remote = remote;
        this.gen = gen;
        this.initiator = initiator;
        this.closed = false;
        this.open = false;
        this.queue = Promise.resolve();
        this.candidates = [];
        this.candidatetimer = null;
        this.pendingremote = [];
        this.watchdog = null;
        // State transfer being received.
        this.incoming = null;
        // State transfer being sent: messages wait behind it.
        this.sending = false;
        this.outqueue = [];
        this.pc = new transport.PeerConnection({iceServers: transport.iceservers, iceTransportPolicy: 'all'});
        this.channels = {
            ops: this.pc.createDataChannel('ops', CHANNELS.ops),
            pose: this.pc.createDataChannel('pose', CHANNELS.pose),
        };
        this.channels.ops.binaryType = 'arraybuffer';
        this.channels.ops.bufferedAmountLowThreshold = SEND_LOW_WATER;
        Object.keys(this.channels).forEach((name) => {
            const channel = this.channels[name];
            channel.onopen = () => this.updateOpen();
            channel.onclose = () => this.updateOpen();
            channel.onmessage = (e) => this.onData(name, e.data);
        });
        this.pc.onicecandidate = (e) => this.queueCandidate(e.candidate);
        this.pc.onconnectionstatechange = () => this.onConnectionState();
        this.pc.oniceconnectionstatechange = () => {
            if (typeof this.pc.connectionState !== 'string') {
                this.onConnectionState();
            }
        };
        this.arm(CONNECT_TIMEOUT);
        if (initiator) {
            this.offer(false);
        }
    }

    /**
     * Start (or restart) the watchdog.
     *
     * @param {number} delay Milliseconds.
     */
    arm(delay) {
        this.disarm();
        this.watchdog = setTimeout(() => {
            this.watchdog = null;
            if (!this.closed) {
                this.transport.onLinkTimeout(this);
            }
        }, delay);
    }

    /**
     * Stop the watchdog.
     */
    disarm() {
        if (this.watchdog) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
    }

    /**
     * The connection state, with a fallback for browsers without connectionState.
     *
     * @returns {string}
     */
    connectionState() {
        if (typeof this.pc.connectionState === 'string') {
            return this.pc.connectionState;
        }
        const ice = this.pc.iceConnectionState;
        return ice === 'completed' ? 'connected' : ice;
    }

    /**
     * React to connection state changes: an ICE restart on failure (the guest), a grace period on
     * a disconnect.
     */
    onConnectionState() {
        if (this.closed) {
            return;
        }
        const state = this.connectionState();
        if (state === 'connected') {
            this.disarm();
        } else if (state === 'failed') {
            if (this.initiator) {
                this.offer(true);
            }
            this.arm(RESTART_GRACE);
        } else if (state === 'disconnected') {
            this.arm(RESTART_GRACE);
        } else if (state === 'closed') {
            this.transport.onLinkTimeout(this);
            return;
        }
        this.updateOpen();
    }

    /**
     * Recompute "open": the connection is up and the ops channel is open.
     */
    updateOpen() {
        if (this.closed) {
            return;
        }
        const open = this.connectionState() === 'connected' && this.channels.ops.readyState === 'open';
        if (open !== this.open) {
            this.open = open;
            this.transport.onLinkOpen(this, open);
        }
    }

    /**
     * Create and send an offer (the guest).
     *
     * @param {boolean} restart Whether this is an ICE restart.
     */
    offer(restart) {
        this.queue = this.queue.then(() => {
            if (this.closed) {
                return undefined;
            }
            return Promise.resolve(this.pc.createOffer(restart ? {iceRestart: true} : {}))
                .then((description) => this.pc.setLocalDescription(description))
                .then(() => {
                    this.sendDescription();
                    return undefined;
                });
        }).catch((error) => Log.debug(error));
    }

    /**
     * Send the current local description.
     */
    sendDescription() {
        const description = this.pc.localDescription;
        if (this.closed || !description || (description.type !== 'offer' && description.type !== 'answer')) {
            return;
        }
        this.transport.signal(this.remote.peerkey, {gen: this.gen, type: description.type, sdp: description.sdp});
    }

    /**
     * Process a signal for this link, in order.
     *
     * @param {Object} payload {gen, type: 'offer'|'answer'|'candidates', sdp?, candidates?}.
     */
    handleSignal(payload) {
        this.queue = this.queue.then(() => {
            if (this.closed) {
                return undefined;
            }
            if (payload.type === 'candidates') {
                return this.onCandidates(payload.candidates);
            }
            return this.onDescription(payload);
        }).catch((error) => Log.debug(error));
    }

    /**
     * Apply a remote description; an offer is answered.
     *
     * @param {Object} payload {type, sdp}.
     * @returns {Promise|undefined}
     */
    onDescription(payload) {
        if (typeof payload.sdp !== 'string') {
            return undefined;
        }
        if (payload.type === 'offer' && this.initiator) {
            return undefined;
        }
        if (payload.type === 'answer' && (!this.initiator || this.pc.signalingState !== 'have-local-offer')) {
            return undefined;
        }
        return this.pc.setRemoteDescription({type: payload.type, sdp: payload.sdp}).then(() => {
            const pending = this.pendingremote;
            this.pendingremote = [];
            return this.onCandidates(pending);
        }).then(() => {
            if (payload.type !== 'offer' || this.closed) {
                return undefined;
            }
            return Promise.resolve(this.pc.createAnswer())
                .then((answer) => this.pc.setLocalDescription(answer))
                .then(() => {
                    this.sendDescription();
                    return undefined;
                });
        });
    }

    /**
     * Add remote ICE candidates (kept until the remote description is there).
     *
     * @param {*} list Candidate entries.
     * @returns {Promise}
     */
    onCandidates(list) {
        const entries = Array.isArray(list) ? list : [];
        if (!this.pc.remoteDescription) {
            entries.forEach((entry) => {
                if (this.pendingremote.length < 200) {
                    this.pendingremote.push(entry);
                }
            });
            return Promise.resolve();
        }
        let chain = Promise.resolve();
        entries.forEach((entry) => {
            if (!entry || typeof entry.candidate !== 'string' || entry.candidate.length > 512) {
                return;
            }
            const init = {candidate: entry.candidate};
            if (typeof entry.sdpMid === 'string') {
                init.sdpMid = entry.sdpMid;
            }
            if (Number.isInteger(entry.sdpMLineIndex)) {
                init.sdpMLineIndex = entry.sdpMLineIndex;
            }
            if (typeof entry.usernameFragment === 'string' && entry.usernameFragment !== '') {
                init.usernameFragment = entry.usernameFragment;
            }
            chain = chain.then(() => this.pc.addIceCandidate(init)).catch((error) => {
                // End-of-candidates is not understood everywhere.
                if (init.candidate !== '') {
                    Log.debug(error);
                }
            });
        });
        return chain;
    }

    /**
     * Batch a local candidate (null or '' = end of candidates).
     *
     * @param {RTCIceCandidate|null} candidate
     */
    queueCandidate(candidate) {
        if (this.closed) {
            return;
        }
        let entry;
        if (candidate && candidate.candidate) {
            if (candidate.candidate.length > 512) {
                return;
            }
            const mid = typeof candidate.sdpMid === 'string' && /^[A-Za-z0-9_-]{0,32}$/.test(candidate.sdpMid)
                ? candidate.sdpMid : null;
            const index = Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0
                && candidate.sdpMLineIndex <= 15 ? candidate.sdpMLineIndex : null;
            if (mid === null && index === null) {
                return;
            }
            const ufrag = typeof candidate.usernameFragment === 'string' && candidate.usernameFragment.length <= 64
                ? candidate.usernameFragment : null;
            entry = {candidate: candidate.candidate, sdpMid: mid, sdpMLineIndex: index, usernameFragment: ufrag};
        } else {
            const last = this.candidates[this.candidates.length - 1];
            if (last && last.candidate === '') {
                return;
            }
            entry = {candidate: '', sdpMid: null, sdpMLineIndex: null, usernameFragment: null};
        }
        this.candidates.push(entry);
        if (!this.candidatetimer) {
            this.candidatetimer = setTimeout(() => this.flushCandidates(), CANDIDATE_BATCH_DELAY);
        }
    }

    /**
     * Send batched candidates.
     */
    flushCandidates() {
        this.candidatetimer = null;
        if (this.closed) {
            return;
        }
        while (this.candidates.length) {
            const chunk = this.candidates.splice(0, MAX_CANDIDATES_PER_SIGNAL);
            this.transport.signal(this.remote.peerkey, {gen: this.gen, type: 'candidates', candidates: chunk});
        }
    }

    /**
     * Data arrived on a channel: size checks, then a message, a state piece or a pose.
     *
     * @param {string} name 'ops' or 'pose'.
     * @param {*} data String or ArrayBuffer.
     */
    onData(name, data) {
        if (this.closed) {
            return;
        }
        if (name === 'pose') {
            if (typeof data === 'string' && data.length <= MAX_POSE) {
                this.transport.emit('pose', {data: data, remote: copyPeer(this.remote)});
            }
            return;
        }
        if (typeof data === 'string') {
            this.onText(data);
            return;
        }
        if (data instanceof ArrayBuffer) {
            this.onPiece(data);
        }
    }

    /**
     * A JSON message on the ops channel.
     *
     * @param {string} data
     */
    onText(data) {
        if (data.length > MAX_MESSAGE) {
            return;
        }
        let message;
        try {
            message = JSON.parse(data);
        } catch (error) {
            return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.t !== 'string') {
            return;
        }
        if (message.t === 's0') {
            // A state transfer starts (any unfinished one is dropped).
            const size = message.size;
            if (!Number.isInteger(size) || size < 48 || size > MAX_STATE || !Number.isInteger(message.seq)
                    || message.seq < 0 || !Number.isInteger(message.li) || message.li < 0) {
                this.incoming = null;
                return;
            }
            this.incoming = {seq: message.seq, li: message.li, bytes: new Uint8Array(size), received: 0};
            return;
        }
        if (this.incoming) {
            // A message in the middle of a transfer breaks it.
            this.incoming = null;
        }
        this.transport.emit('message', {message: message, remote: copyPeer(this.remote)});
    }

    /**
     * A binary piece of the state transfer.
     *
     * @param {ArrayBuffer} data
     */
    onPiece(data) {
        const incoming = this.incoming;
        if (!incoming || data.byteLength === 0 || data.byteLength > MAX_MESSAGE
                || incoming.received + data.byteLength > incoming.bytes.length) {
            this.incoming = null;
            return;
        }
        incoming.bytes.set(new Uint8Array(data), incoming.received);
        incoming.received += data.byteLength;
        if (incoming.received === incoming.bytes.length) {
            this.incoming = null;
            this.transport.emit('state', {
                seq: incoming.seq,
                li: incoming.li,
                bytes: incoming.bytes.buffer,
                remote: copyPeer(this.remote),
            });
        }
    }

    /**
     * Send a JSON message on the ops channel (it waits behind a state transfer being sent).
     *
     * @param {Object} message
     * @returns {boolean} Whether it was sent or queued.
     */
    sendMessage(message) {
        const text = JSON.stringify(message);
        if (this.closed || !this.open || text.length > MAX_MESSAGE) {
            return false;
        }
        if (this.sending) {
            this.outqueue.push(text);
            return true;
        }
        return this.rawSend(this.channels.ops, text);
    }

    /**
     * Send on a channel.
     *
     * @param {RTCDataChannel} channel
     * @param {string|ArrayBuffer|Uint8Array} data
     * @returns {boolean}
     */
    rawSend(channel, data) {
        if (channel.readyState !== 'open') {
            return false;
        }
        try {
            channel.send(data);
            return true;
        } catch (error) {
            Log.debug(error);
            return false;
        }
    }

    /**
     * Wait until the ops channel buffer is low again.
     *
     * @returns {Promise<void>}
     */
    drain() {
        const channel = this.channels.ops;
        if (channel.bufferedAmount <= SEND_HIGH_WATER) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            /**
             * The buffer drained or the channel closed: stop listening and go on.
             */
            const done = () => {
                channel.removeEventListener('bufferedamountlow', done);
                channel.removeEventListener('close', done);
                resolve();
            };
            channel.addEventListener('bufferedamountlow', done);
            channel.addEventListener('close', done);
        });
    }

    /**
     * Send the confirmed state: a header, then binary pieces with back-pressure. Messages sent
     * meanwhile wait and follow it.
     *
     * @param {Uint8Array} bytes Serialized snapshot.
     * @param {number} seq Its sequence number.
     * @param {number} li The last op index of the guest's author already confirmed (0 for none).
     * @returns {Promise<boolean>} Whether all of it was handed to the channel.
     */
    sendState(bytes, seq, li) {
        if (this.closed || !this.open || bytes.length < 48 || bytes.length > MAX_STATE) {
            return Promise.resolve(false);
        }
        this.sending = true;
        const channel = this.channels.ops;
        const header = JSON.stringify({t: 's0', seq: seq, li: li, size: bytes.length});
        if (!this.rawSend(channel, header)) {
            this.sending = false;
            this.outqueue = [];
            return Promise.resolve(false);
        }
        let offset = 0;
        /**
         * Hand the channel the next pieces while its buffer has room.
         *
         * @returns {boolean|Promise<boolean>} Whether every piece was handed over (after the buffer drained).
         */
        const step = () => {
            if (this.closed || channel.readyState !== 'open') {
                return false;
            }
            while (offset < bytes.length && channel.bufferedAmount <= SEND_HIGH_WATER) {
                const end = Math.min(bytes.length, offset + MAX_MESSAGE);
                // A copy, so the piece is an ArrayBuffer of exactly its own bytes.
                if (!this.rawSend(channel, bytes.slice(offset, end).buffer)) {
                    return false;
                }
                offset = end;
            }
            if (offset >= bytes.length) {
                return true;
            }
            return this.drain().then(step);
        };
        return Promise.resolve().then(step).then((ok) => {
            this.sending = false;
            const queued = this.outqueue;
            this.outqueue = [];
            if (ok) {
                queued.forEach((text) => this.rawSend(channel, text));
            }
            return ok;
        });
    }

    /**
     * Send a pose (dropped while the pose channel is backed up).
     *
     * @param {string} data Codec pose string.
     * @returns {boolean}
     */
    sendPose(data) {
        const channel = this.channels.pose;
        if (this.closed || !this.open || data.length > MAX_POSE || channel.bufferedAmount >= POSE_BUFFER_LIMIT) {
            return false;
        }
        return this.rawSend(channel, data);
    }

    /**
     * Close the link for good.
     */
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.open = false;
        this.disarm();
        if (this.candidatetimer) {
            clearTimeout(this.candidatetimer);
            this.candidatetimer = null;
        }
        this.incoming = null;
        this.outqueue = [];
        Object.keys(this.channels).forEach((name) => {
            const channel = this.channels[name];
            channel.onopen = null;
            channel.onclose = null;
            channel.onmessage = null;
            try {
                channel.close();
            } catch (error) {
                Log.debug(error);
            }
        });
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        try {
            this.pc.close();
        } catch (error) {
            Log.debug(error);
        }
    }
}

/**
 * Pair transport over WebRTC with Moodle-relayed signalling.
 */
export class PairTransport extends Emitter {
    /**
     * Constructor.
     *
     * @param {Object} options {cmid, sessionid, call?: Function, RTCPeerConnection?: constructor} (the last
     *     two for tests).
     */
    constructor(options) {
        super();
        const opts = options || {};
        this.cmid = Number(opts.cmid) || 0;
        this.sessionid = Number(opts.sessionid) || 0;
        this.call = typeof opts.call === 'function' ? opts.call : defaultCall;
        this.PeerConnection = opts.RTCPeerConnection
            || (typeof window !== 'undefined' && window.RTCPeerConnection ? window.RTCPeerConnection : null);
        /** @type {{peerkey: string, role: string, userid: number, name: string}|null} */
        this.me = null;
        /** @type {{userid: number, name: string, peerkey: string, role: string}|null} */
        this.remote = null;
        /** @type {Link|null} */
        this.link = null;
        this.gen = 0;
        this.iceservers = [];
        this.pollms = 1000;
        this.afterid = 0;
        this.polltimer = null;
        this.polling = false;
        this.pollerrors = 0;
        this.lastgoodpoll = 0;
        this.stopped = false;
        this.sendchain = Promise.resolve();
        this.onPageHide = () => this.leaveOnUnload();
    }

    /**
     * Our role ('host' or 'guest'; '' before joining).
     *
     * @returns {string}
     */
    role() {
        return this.me ? this.me.role : '';
    }

    /**
     * Our own peer.
     *
     * @returns {{peerkey: string, role: string, userid: number, name: string}|null}
     */
    self() {
        return this.me ? {peerkey: this.me.peerkey, role: this.me.role, userid: this.me.userid, name: this.me.name} : null;
    }

    /**
     * The other active person, or null.
     *
     * @returns {Object|null}
     */
    other() {
        return copyPeer(this.remote);
    }

    /**
     * Whether the direct connection is up.
     *
     * @returns {boolean}
     */
    isOpen() {
        return !!this.link && this.link.open;
    }

    /**
     * Join the pair session.
     *
     * @returns {Promise<Object>} {peerkey, role, userid, name}; rejects with an Error carrying errorcode
     *     (for example 'sessionfull'). A busy server ('pairbusy') is asked again a few times.
     */
    join() {
        if (this.stopped) {
            return Promise.reject(toError({errorcode: 'closed', message: 'closed'}));
        }
        if (!this.PeerConnection) {
            return Promise.reject(toError({errorcode: 'nowebrtc', message: 'WebRTC is not available'}));
        }
        /**
         * One join call; a busy server is asked again after a pause.
         *
         * @param {number} attempt Calls made so far.
         * @returns {Promise<Object>} The pair_join result.
         */
        const attemptJoin = (attempt) => this.call('mod_vrsculpt_pair_join', {cmid: this.cmid, sessionid: this.sessionid},
            false).catch((exception) => {
            const error = toError(exception);
            if (error.errorcode !== 'pairbusy' || attempt >= JOIN_BUSY_RETRIES || this.stopped) {
                throw error;
            }
            return new Promise((resolve) => setTimeout(resolve, POLL_BACKOFF[0])).then(() => attemptJoin(attempt + 1));
        });
        return attemptJoin(1).then((result) => {
            if (!result || !isPeerKey(result.peerkey)) {
                throw toError({errorcode: 'invalidresponse', message: 'Invalid join result'});
            }
            if (this.stopped) {
                throw toError({errorcode: 'closed', message: 'closed'});
            }
            this.takeJoin(result);
            if (typeof window !== 'undefined') {
                window.addEventListener('pagehide', this.onPageHide);
            }
            this.schedulePoll(0);
            return this.self();
        }, (exception) => {
            throw toError(exception);
        });
    }

    /**
     * Take over a join result.
     *
     * @param {Object} result The pair_join result.
     */
    takeJoin(result) {
        const previous = this.me ? this.me.role : '';
        this.me = {
            peerkey: result.peerkey,
            role: result.role === 'host' ? 'host' : 'guest',
            userid: Number(result.userid) || 0,
            name: typeof result.name === 'string' ? result.name : '',
        };
        this.iceservers = cleanIceServers(result.iceservers);
        this.pollms = clampPoll(result.pollms);
        this.afterid = 0;
        this.lastgoodpoll = Date.now();
        if (previous && previous !== this.me.role) {
            this.emit('role', {role: this.me.role, previous: previous});
        }
        this.updatePeers(result.peers);
    }

    /**
     * Schedule the next poll.
     *
     * @param {number} delay Milliseconds.
     */
    schedulePoll(delay) {
        if (this.stopped) {
            return;
        }
        if (this.polltimer) {
            clearTimeout(this.polltimer);
        }
        this.polltimer = setTimeout(() => {
            this.polltimer = null;
            this.poll();
        }, Math.max(0, delay));
    }

    /**
     * The poll interval now.
     *
     * @returns {number}
     */
    interval() {
        return this.isOpen() ? CONNECTED_POLL : this.pollms;
    }

    /**
     * One poll: role, peers and signals; it keeps our presence fresh too.
     */
    poll() {
        if (this.stopped || this.polling || !this.me) {
            return;
        }
        this.polling = true;
        const peerkey = this.me.peerkey;
        const args = {cmid: this.cmid, sessionid: this.sessionid, peerkey: peerkey, afterid: this.afterid};
        this.call('mod_vrsculpt_pair_poll', args, true).then((result) => {
            this.polling = false;
            if (this.stopped || !this.me || this.me.peerkey !== peerkey) {
                return;
            }
            this.pollerrors = 0;
            this.lastgoodpoll = Date.now();
            this.takePoll(result || {});
            this.schedulePoll(this.interval());
            return;
        }, (exception) => {
            this.polling = false;
            if (this.stopped) {
                return;
            }
            this.onPollError(toError(exception));
        }).catch((error) => Log.debug(error));
    }

    /**
     * Take over a poll result.
     *
     * @param {Object} result {role, peers, signals}.
     */
    takePoll(result) {
        const role = result.role === 'host' ? 'host' : 'guest';
        if (role !== this.me.role) {
            const previous = this.me.role;
            this.me.role = role;
            Log.debug(LOGPREFIX + 'role ' + role);
            if (this.link) {
                // The roles of the link are no longer right: start again.
                this.dropLink();
            }
            this.emit('role', {role: role, previous: previous});
        }
        this.updatePeers(result.peers);
        (Array.isArray(result.signals) ? result.signals : []).forEach((signal) => {
            const id = Number(signal && signal.id);
            if (!Number.isInteger(id) || id <= 0) {
                return;
            }
            if (id > this.afterid) {
                this.afterid = id;
            }
            this.onSignal(signal);
        });
        this.ensureLink();
    }

    /**
     * A poll failed.
     *
     * @param {Error} error With errorcode.
     */
    onPollError(error) {
        if (error.errorcode === 'peergone') {
            if (Date.now() - this.lastgoodpoll < REPLACED_WINDOW) {
                Log.debug(LOGPREFIX + 'replaced by another window');
                this.fail('replaced', error.message);
                return;
            }
            this.rejoin();
            return;
        }
        if (isTransient(error)) {
            const delay = POLL_BACKOFF[Math.min(this.pollerrors, POLL_BACKOFF.length - 1)];
            this.pollerrors++;
            this.schedulePoll(delay);
            return;
        }
        this.fail(error.errorcode, error.message);
    }

    /**
     * Join again after our presence expired on the server (a long sleep of the device).
     */
    rejoin() {
        this.dropLink();
        this.call('mod_vrsculpt_pair_join', {cmid: this.cmid, sessionid: this.sessionid}, false).then((result) => {
            if (this.stopped) {
                return;
            }
            if (!result || !isPeerKey(result.peerkey)) {
                this.fail('invalidresponse', 'Invalid join result');
                return;
            }
            this.takeJoin(result);
            this.schedulePoll(0);
            return;
        }, (exception) => {
            if (this.stopped) {
                return;
            }
            const error = toError(exception);
            if (isTransient(error)) {
                this.pollerrors++;
                this.lastgoodpoll = 0;
                setTimeout(() => {
                    if (!this.stopped) {
                        this.rejoin();
                    }
                }, POLL_BACKOFF[Math.min(this.pollerrors, POLL_BACKOFF.length - 1)]);
                return;
            }
            this.fail(error.errorcode, error.message);
        }).catch((error) => Log.debug(error));
    }

    /**
     * The pair session cannot go on.
     *
     * @param {string} errorcode
     * @param {string} message
     */
    fail(errorcode, message) {
        this.shutdown();
        this.emit('failed', {errorcode: errorcode, message: message || errorcode});
    }

    /**
     * Take over the peer list: the other active person (at most one).
     *
     * @param {*} list Server peers.
     */
    updatePeers(list) {
        const others = cleanPeers(list).filter((peer) => !this.me || peer.peerkey !== this.me.peerkey);
        const next = others.length ? others[0] : null;
        const before = this.remote;
        if (before && (!next || next.peerkey !== before.peerkey)) {
            this.dropLink();
        }
        const changed = !before !== !next || (before && next && (before.peerkey !== next.peerkey
            || before.name !== next.name || before.role !== next.role || before.userid !== next.userid));
        this.remote = next;
        if (this.link && next) {
            this.link.remote = next;
        }
        if (changed) {
            this.emit('peers', {peers: next ? [copyPeer(next)] : []});
        }
    }

    /**
     * The guest opens the link to the host when there is none.
     */
    ensureLink() {
        if (this.stopped || !this.me || this.me.role !== 'guest' || !this.remote || this.remote.role !== 'host') {
            return;
        }
        if (this.link && !this.link.closed) {
            return;
        }
        this.gen++;
        this.link = new Link(this, this.remote, this.gen, true);
    }

    /**
     * A polled signal.
     *
     * @param {{id: number, frompeerkey: string, payload: string}} signal
     */
    onSignal(signal) {
        if (!this.remote || signal.frompeerkey !== this.remote.peerkey || typeof signal.payload !== 'string'
                || signal.payload.length > MAX_SIGNAL) {
            return;
        }
        let payload;
        try {
            payload = JSON.parse(signal.payload);
        } catch (error) {
            return;
        }
        if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.gen) || payload.gen < 1
                || ['offer', 'answer', 'candidates'].indexOf(payload.type) === -1) {
            return;
        }
        if (this.me.role === 'host') {
            if (payload.type === 'offer' && (!this.link || this.link.closed || payload.gen > this.link.gen)) {
                this.dropLink();
                this.link = new Link(this, this.remote, payload.gen, false);
            }
        }
        if (this.link && !this.link.closed && payload.gen === this.link.gen) {
            this.link.handleSignal(payload);
        }
    }

    /**
     * Send a signal to the other person through Moodle (in order, one call at a time).
     *
     * @param {string} topeerkey
     * @param {Object} payload
     */
    signal(topeerkey, payload) {
        const text = JSON.stringify(payload);
        if (text.length > MAX_SIGNAL || !this.me) {
            return;
        }
        const args = {
            cmid: this.cmid,
            sessionid: this.sessionid,
            peerkey: this.me.peerkey,
            topeerkey: topeerkey,
            payload: text,
        };
        this.sendchain = this.sendchain.then(() => {
            if (this.stopped) {
                return undefined;
            }
            return this.call('mod_vrsculpt_pair_signal', args, true);
        }).catch((exception) => Log.debug(exception));
    }

    /**
     * A link opened or closed.
     *
     * @param {Link} link
     * @param {boolean} open
     */
    onLinkOpen(link, open) {
        if (link !== this.link) {
            return;
        }
        if (open) {
            Log.debug(LOGPREFIX + 'connected');
            this.emit('open', {remote: copyPeer(link.remote)});
            // Slow down the poll now.
            this.schedulePoll(this.interval());
        } else {
            Log.debug(LOGPREFIX + 'connection lost');
            this.emit('close', {remote: copyPeer(link.remote)});
        }
    }

    /**
     * A link did not connect (or reconnect) in time: the guest starts a new one, the host waits
     * for its offer.
     *
     * @param {Link} link
     */
    onLinkTimeout(link) {
        if (link !== this.link) {
            link.close();
            return;
        }
        Log.debug(LOGPREFIX + 'link timed out');
        this.dropLink();
        this.ensureLink();
        this.schedulePoll(this.interval());
    }

    /**
     * Close the current link (a 'close' event when it was open).
     */
    dropLink() {
        const link = this.link;
        this.link = null;
        if (!link) {
            return;
        }
        const wasopen = link.open;
        link.close();
        if (wasopen) {
            this.emit('close', {remote: copyPeer(link.remote)});
        }
    }

    /**
     * Send a JSON message on the ops channel.
     *
     * @param {Object} message An object with a string 't'.
     * @returns {boolean} Whether it was sent (or queued behind a state transfer).
     */
    sendMessage(message) {
        return !!this.link && this.link.sendMessage(message);
    }

    /**
     * Send the confirmed state to the other person (the host).
     *
     * @param {Uint8Array} bytes Serialized snapshot.
     * @param {number} seq Its sequence number.
     * @param {number} li Last confirmed op index of the guest's author (0 for none).
     * @returns {Promise<boolean>}
     */
    sendState(bytes, seq, li) {
        if (!this.link) {
            return Promise.resolve(false);
        }
        return this.link.sendState(bytes, seq, li);
    }

    /**
     * Send a pose string.
     *
     * @param {string} data
     * @returns {boolean}
     */
    sendPose(data) {
        return !!this.link && this.link.sendPose(data);
    }

    /**
     * Stop polling and close the link (no leave call).
     */
    shutdown() {
        this.stopped = true;
        if (this.polltimer) {
            clearTimeout(this.polltimer);
            this.polltimer = null;
        }
        this.dropLink();
        if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', this.onPageHide);
        }
    }

    /**
     * Leave the pair session.
     *
     * @returns {Promise<void>}
     */
    leave() {
        const me = this.me;
        const wasstopped = this.stopped;
        this.shutdown();
        if (!me || wasstopped) {
            return Promise.resolve();
        }
        const args = {cmid: this.cmid, sessionid: this.sessionid, peerkey: me.peerkey};
        return this.call('mod_vrsculpt_pair_leave', args, true).then(() => undefined, (exception) => {
            Log.debug(exception);
        });
    }

    /**
     * Best-effort leave while the page unloads (pagehide); no answer awaited. When it does not
     * arrive, the server counts the presence as gone after 20 seconds.
     */
    leaveOnUnload() {
        const me = this.me;
        const wasstopped = this.stopped;
        this.shutdown();
        if (!me || wasstopped) {
            return;
        }
        const methodname = 'mod_vrsculpt_pair_leave';
        const url = Config.wwwroot + '/lib/ajax/service.php?sesskey=' + encodeURIComponent(Config.sesskey)
            + '&info=' + methodname;
        const body = JSON.stringify([{index: 0, methodname: methodname,
            args: {cmid: this.cmid, sessionid: this.sessionid, peerkey: me.peerkey}}]);
        try {
            if (typeof fetch === 'function') {
                fetch(url, {
                    method: 'POST',
                    keepalive: true,
                    credentials: 'same-origin',
                    headers: {'Content-Type': 'application/json'},
                    body: body,
                }).catch(() => undefined);
            } else if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
                navigator.sendBeacon(url, new Blob([body], {type: 'application/json'}));
            }
        } catch (error) {
            // Unloading: nothing more can be done.
        }
    }
}

/**
 * Create a pair transport.
 *
 * @param {Object} options {cmid, sessionid, call?, RTCPeerConnection?}.
 * @returns {PairTransport}
 */
export const createPairTransport = (options) => new PairTransport(options);
