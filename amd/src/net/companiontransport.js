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
 * Companion transport: one WebSocket to the site's vrroom-sync service (protocol 'vrroom-sync.1'
 * with the sculpting frames op, ops, replay, replayed and gap).
 *
 * Moodle (web service mod_vrsculpt_companion_join) runs the access checks and hands out a
 * short-lived token, sent in the first frame (never in the URL) and refreshed through Moodle
 * before it expires. Peer ids and names come from vrroom-sync, which takes them from the verified
 * token only. The server sequences every op; this transport only carries frames, the session
 * (mod_vrsculpt/net/session) applies them in order.
 *
 * Events (detail objects):
 * - state     {state, reason}: state 'joined', 'reconnecting', 'left' or 'failed'
 * - welcome   {frame, reconnect}: every welcome, the first one and after each reconnect
 * - ops       {frame}: an ops frame {ops: [{n, p, d}], r?}
 * - replayed  {seq}
 * - gap       {from, first}
 * - peerjoined {peer: {peerid, name}}
 * - peerleft  {peerid, reason}
 * - pose      {peerid, data}: a codec pose string of a known peer
 * - error     {code}: an error frame of the server (for example 'ratelimited')
 *
 * The socket handling (welcome watchdog, application ping, close-code table, back-off, token
 * refresh) follows vrroomruntime_companion/transport_companion, whose per-peer presence maps
 * adapt mod_gear's collaborative mode.
 *
 * Nothing about tokens or names is logged; core/log receives close codes and states only.
 *
 * @module     mod_vrsculpt/net/companiontransport
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Ajax from 'core/ajax';
import Log from 'core/log';
import {Emitter} from 'mod_vrsculpt/net/emitter';
import * as Frames from 'mod_vrsculpt/net/syncframes';

/** Web service that runs the access checks and returns the token. */
const JOIN_METHOD = 'mod_vrsculpt_companion_join';

/** Timeout of a join service call (ms). */
const REQUEST_TIMEOUT = 10000;

/** Wait this long for the welcome after opening the socket (ms). */
const WELCOME_TIMEOUT = 10000;

/** Application ping interval (ms). */
const PING_INTERVAL = 20000;

/** No pong within this time closes the socket and reconnects (ms). */
const PONG_TIMEOUT = 10000;

/** Pose frames are dropped while more than this many bytes wait to be sent. */
const POSE_BUFFER_LIMIT = 32768;

/** After a token refresh failed for a network reason, try again after this long (ms). */
const REFRESH_RETRY = 15000;

/** WebSocket readyState OPEN. */
const OPEN = 1;

/** Largest ping counter before it wraps. */
const MAX_PING = 2147483647;

/** Prefix of debug log lines. */
const LOGPREFIX = 'mod_vrsculpt/net/companiontransport: ';

/**
 * Turn a web-service rejection into an Error carrying an errorcode.
 *
 * Moodle exceptions arrive as objects with an errorcode; anything else is a network failure.
 *
 * @param {*} exception The rejection value.
 * @returns {Error} With errorcode ('network' for network failures) and cause.
 */
const toServiceError = (exception) => {
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
 * An Error for a failed join or an ended session.
 *
 * @param {string} reason Reason ('full', 'network', 'notallowed', 'replaced', 'closed', 'error', or a
 *     web-service error code).
 * @param {*} [cause] Original error.
 * @returns {Error} With reason, errorcode and cause.
 */
const joinError = (reason, cause) => {
    const error = new Error(cause && cause.message ? cause.message : reason);
    error.reason = reason;
    error.errorcode = cause && cause.errorcode ? cause.errorcode : reason;
    error.cause = cause;
    return error;
};

/**
 * An Error for a socket that closed before the welcome.
 *
 * @param {number} code Close code.
 * @param {boolean} aborted Whether this side closed it on purpose.
 * @returns {Error} With closefailure true, code and aborted.
 */
const closeFailure = (code, aborted) => {
    const error = new Error('Socket closed (' + code + ')');
    error.closefailure = true;
    error.code = code;
    error.aborted = aborted;
    return error;
};

/**
 * Whether a join service error is a network failure (not an answer of Moodle).
 *
 * @param {*} error Error with errorcode.
 * @returns {boolean}
 */
const isNetworkError = (error) => !error || error.errorcode === 'network';

/**
 * The default join service call.
 *
 * @param {Object} args {cmid, sessionid}.
 * @param {boolean} nosessionupdate Whether the call must not extend the Moodle session.
 * @returns {Promise<Object>}
 */
const defaultCall = (args, nosessionupdate) => Promise.resolve(
    Ajax.call([{methodname: JOIN_METHOD, args: args}], true, true, nosessionupdate, REQUEST_TIMEOUT)[0]
);

/**
 * Check and normalise a join service result.
 *
 * @param {*} result {url, token, expires, room, peerid, name, max}.
 * @returns {Object|null}
 */
const normaliseResult = (result) => {
    if (!result || typeof result !== 'object' || !Frames.isPeerId(result.peerid)) {
        return null;
    }
    if (typeof result.url !== 'string' || !/^wss?:\/\//.test(result.url)
            || typeof result.token !== 'string' || result.token === '') {
        return null;
    }
    return {
        url: result.url,
        token: result.token,
        expires: Number(result.expires) || 0,
        room: String(result.room || ''),
        peerid: result.peerid,
        name: String(result.name || ''),
        max: Number(result.max) || 0,
    };
};

/**
 * Transport over the companion service.
 */
export class CompanionTransport extends Emitter {
    /**
     * Constructor.
     *
     * @param {Object} options {cmid, sessionid, WebSocket?: constructor, call?: Function} (the last two for tests).
     */
    constructor(options) {
        super();
        const opts = options || {};
        this.cmid = Number(opts.cmid) || 0;
        this.sessionid = Number(opts.sessionid) || 0;
        this.WebSocket = opts.WebSocket
            || (typeof window !== 'undefined' && window.WebSocket ? window.WebSocket : null);
        this.call = typeof opts.call === 'function' ? opts.call : defaultCall;
        this.state = 'idle';
        /** @type {{peerid: string, name: string}|null} */
        this.selfpeer = null;
        /** @type {Map<string, {peerid: string, name: string}>} */
        this.roster = new Map();
        this.result = null;
        this.tokenreceived = 0;
        this.maxpeers = 0;
        this.posehz = 15;
        this.joining = null;
        this.disposed = false;
        this.ws = null;
        this.welcomed = false;
        this.everwelcomed = false;
        this.connecting = null;
        this.welcometimer = null;
        this.pingtimer = null;
        this.pongtimer = null;
        this.pingcount = 0;
        this.refreshtimer = null;
        this.refreshing = false;
        this.retrytimer = null;
        this.retrying = false;
        this.retryattempt = 0;
        this.retrystart = 0;
        this.refreshfirst = false;
        /** @type {Set<{timer: *, reject: Function}>} */
        this.waits = new Set();
    }

    /**
     * Our own peer as vrroom-sync knows it.
     *
     * @returns {{peerid: string, name: string}|null}
     */
    self() {
        return this.selfpeer ? {peerid: this.selfpeer.peerid, name: this.selfpeer.name} : null;
    }

    /**
     * The other peers in the room.
     *
     * @returns {Array<{peerid: string, name: string}>}
     */
    peers() {
        return Array.from(this.roster.values()).map((peer) => ({peerid: peer.peerid, name: peer.name}));
    }

    /**
     * Largest number of people in the room (from the welcome).
     *
     * @returns {number}
     */
    max() {
        return this.maxpeers;
    }

    /**
     * Pose rate the server ticks at (from the welcome).
     *
     * @returns {number}
     */
    poseRate() {
        return this.posehz;
    }

    /**
     * Whether a welcomed socket is open now.
     *
     * @returns {boolean}
     */
    isOpen() {
        return this.welcomed && !!this.ws && this.ws.readyState === OPEN;
    }

    /**
     * Change state and tell listeners.
     *
     * @param {string} state
     * @param {string} reason
     */
    setState(state, reason) {
        this.state = state;
        Log.debug(LOGPREFIX + 'state ' + state + (reason ? ' (' + reason + ')' : ''));
        this.emit('state', {state: state, reason: reason});
    }

    /**
     * Whether the session is in use (joined or reconnecting).
     *
     * @returns {boolean}
     */
    isActive() {
        return this.state === 'joined' || this.state === 'reconnecting';
    }

    /**
     * Wait for a while; rejected with a 'closed' error when the transport stops.
     *
     * @param {number} ms Milliseconds.
     * @returns {Promise<void>}
     */
    wait(ms) {
        return new Promise((resolve, reject) => {
            const entry = {timer: null, reject: reject};
            entry.timer = setTimeout(() => {
                this.waits.delete(entry);
                resolve();
            }, ms);
            this.waits.add(entry);
        });
    }

    /**
     * Cancel every pending wait.
     */
    cancelWaits() {
        this.waits.forEach((entry) => {
            clearTimeout(entry.timer);
            entry.reject(joinError('closed'));
        });
        this.waits.clear();
    }

    /**
     * Call the join service.
     *
     * @param {boolean} refresh Whether this only renews the token of an open session.
     * @returns {Promise<Object>} The normalised result; rejects with an Error carrying errorcode.
     */
    fetchJoin(refresh) {
        const args = {cmid: this.cmid, sessionid: this.sessionid};
        return Promise.resolve().then(() => this.call(args, !!refresh)).then((raw) => {
            const result = normaliseResult(raw);
            if (!result) {
                const error = new Error('Invalid join result');
                error.errorcode = 'invalidresponse';
                throw error;
            }
            return result;
        }, (exception) => {
            throw toServiceError(exception);
        });
    }

    /**
     * Take over a join service result.
     *
     * @param {Object} result Normalised result.
     */
    applyResult(result) {
        this.result = result;
        this.tokenreceived = Date.now();
        if (!this.maxpeers) {
            this.maxpeers = result.max;
        }
    }

    /**
     * Whether the token is past its refresh point (measured on the local clock).
     *
     * @returns {boolean}
     */
    tokenStale() {
        return !this.result || Date.now() >= this.tokenreceived + Frames.refreshDelay(this.result.expires, this.tokenreceived);
    }

    /**
     * Join the room.
     *
     * @returns {Promise<Object>} The first welcome frame; rejects with an Error carrying reason and
     *     errorcode (for example 'companionnotconfigured' from Moodle, or 'full').
     */
    join() {
        if (this.disposed) {
            return Promise.reject(joinError('closed'));
        }
        if (this.joining) {
            return this.joining;
        }
        if (!this.WebSocket) {
            this.setState('failed', 'error');
            return Promise.reject(joinError('error'));
        }
        this.setState('joining', '');
        this.joining = this.fetchJoin(false).then((result) => {
            if (this.state !== 'joining') {
                throw joinError('closed');
            }
            this.applyResult(result);
            return this.connectWhileJoining(false, false);
        }).then((welcome) => {
            this.joining = null;
            if (this.state !== 'joining') {
                this.closeSocket(Frames.CLOSE.NORMAL);
                throw joinError('closed');
            }
            this.setState('joined', '');
            this.takeWelcome(welcome);
            return welcome;
        }).catch((error) => {
            this.joining = null;
            const reason = error && error.reason ? error.reason
                : (error && typeof error.errorcode === 'string' ? error.errorcode : 'error');
            if (this.state === 'joining') {
                this.stopEverything();
                this.setState('failed', reason);
            }
            throw error && error.reason ? error : joinError(reason, error);
        });
        return this.joining;
    }

    /**
     * Open the socket while joining: one retry after a lost connection, one token refresh after a
     * refused token.
     *
     * @param {boolean} retried Whether a retry was already made.
     * @param {boolean} refreshed Whether a refresh was already made.
     * @returns {Promise<Object>} The welcome frame; rejects with a join error.
     */
    connectWhileJoining(retried, refreshed) {
        return this.connectOnce().catch((failure) => {
            if (this.state !== 'joining') {
                throw joinError('closed');
            }
            const code = failure && failure.code ? failure.code : 1006;
            Log.debug(LOGPREFIX + 'socket closed while joining (' + code + ')');
            const action = Frames.closeAction(code, false);
            if (action.action === 'retry') {
                if (retried) {
                    throw joinError('network');
                }
                return this.wait(Frames.backoff(0)).then(() => this.connectWhileJoining(true, refreshed));
            }
            if (action.action === 'refresh') {
                if (refreshed) {
                    throw joinError(action.reason);
                }
                return this.fetchJoin(true).then((result) => {
                    if (this.state !== 'joining') {
                        throw joinError('closed');
                    }
                    this.applyResult(result);
                    return this.connectWhileJoining(retried, true);
                }, (error) => {
                    throw joinError(isNetworkError(error) ? 'network' : 'notallowed', error);
                });
            }
            throw joinError(action.reason || 'error');
        });
    }

    /**
     * Open one socket and wait for the welcome.
     *
     * @returns {Promise<Object>} The welcome frame; rejects with {code} when the socket closes first.
     */
    connectOnce() {
        this.closeSocket(Frames.CLOSE.NORMAL);
        return new Promise((resolve, reject) => {
            let ws;
            try {
                ws = new this.WebSocket(this.result.url, [Frames.SUBPROTOCOL]);
            } catch (error) {
                Log.debug(error);
                reject(closeFailure(1006, false));
                return;
            }
            this.ws = ws;
            this.welcomed = false;
            this.connecting = {resolve: resolve, reject: reject};
            this.welcometimer = setTimeout(() => {
                this.welcometimer = null;
                if (this.ws === ws && !this.welcomed) {
                    this.dropSocket(ws, 1006);
                }
            }, WELCOME_TIMEOUT);
            ws.onopen = () => {
                if (this.ws === ws) {
                    this.sendFrame(Frames.hello(this.result.token));
                }
            };
            ws.onmessage = (e) => {
                if (this.ws === ws) {
                    this.onFrame(e.data);
                }
            };
            ws.onerror = () => {
                // A close event follows.
            };
            ws.onclose = (e) => {
                if (this.ws === ws) {
                    this.onSocketClosed(e && e.code ? e.code : 1006);
                }
            };
        });
    }

    /**
     * Give up a socket as lost (watchdogs).
     *
     * @param {WebSocket} ws The socket.
     * @param {number} code The code to handle it with.
     */
    dropSocket(ws, code) {
        this.detachSocket();
        try {
            ws.close(Frames.CLOSE.PROTOCOL);
        } catch (error) {
            Log.debug(error);
        }
        this.onSocketClosed(code);
    }

    /**
     * Stop listening to the current socket and its timers.
     *
     * @returns {WebSocket|null} The detached socket.
     */
    detachSocket() {
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
        }
        if (this.welcometimer) {
            clearTimeout(this.welcometimer);
            this.welcometimer = null;
        }
        this.stopPing();
        return ws;
    }

    /**
     * Close the current socket on purpose (no reconnect). A pending connect is rejected.
     *
     * @param {number} code Close code.
     */
    closeSocket(code) {
        const ws = this.detachSocket();
        this.welcomed = false;
        if (ws) {
            try {
                ws.close(code);
            } catch (error) {
                Log.debug(error);
            }
        }
        const connecting = this.connecting;
        this.connecting = null;
        if (connecting) {
            connecting.reject(closeFailure(code, true));
        }
    }

    /**
     * The current socket closed (or was given up).
     *
     * @param {number} code Close code.
     */
    onSocketClosed(code) {
        this.detachSocket();
        const waswelcomed = this.welcomed;
        this.welcomed = false;
        const connecting = this.connecting;
        this.connecting = null;
        if (connecting) {
            connecting.reject(closeFailure(code, false));
            return;
        }
        if (waswelcomed && this.isActive()) {
            Log.debug(LOGPREFIX + 'socket closed (' + code + ')');
            this.onLost(code);
        }
    }

    /**
     * Send a frame on the open socket.
     *
     * @param {string} frame
     * @returns {boolean} Whether it was sent.
     */
    sendFrame(frame) {
        const ws = this.ws;
        if (!ws || ws.readyState !== OPEN) {
            return false;
        }
        try {
            ws.send(frame);
            return true;
        } catch (error) {
            Log.debug(error);
            return false;
        }
    }

    /**
     * Send an op to the room (only on a welcomed socket).
     *
     * @param {string} d The op as a JSON string.
     * @returns {boolean} Whether it was sent.
     */
    sendOp(d) {
        const frame = Frames.op(d);
        if (!frame || !this.welcomed) {
            return false;
        }
        return this.sendFrame(frame);
    }

    /**
     * Ask for every op after a sequence number.
     *
     * @param {number} from Last sequence number already applied (0 for all).
     * @returns {boolean} Whether it was sent.
     */
    sendReplay(from) {
        if (!this.welcomed) {
            return false;
        }
        return this.sendFrame(Frames.replay(from));
    }

    /**
     * Send a pose; dropped while the socket's send buffer is full.
     *
     * @param {string} codecstring Codec pose string.
     * @returns {boolean} Whether it was sent.
     */
    sendPose(codecstring) {
        const ws = this.ws;
        if (!this.welcomed || !ws || ws.bufferedAmount > POSE_BUFFER_LIMIT) {
            return false;
        }
        return this.sendFrame(Frames.pose(codecstring));
    }

    /**
     * A frame from the server.
     *
     * @param {*} data Message data.
     */
    onFrame(data) {
        const frame = Frames.parse(data);
        if (!frame) {
            return;
        }
        if (frame.t === 'welcome') {
            if (!this.welcomed && this.connecting) {
                this.welcomed = true;
                if (this.welcometimer) {
                    clearTimeout(this.welcometimer);
                    this.welcometimer = null;
                }
                const connecting = this.connecting;
                this.connecting = null;
                connecting.resolve(frame);
            }
            return;
        }
        if (frame.t === 'error') {
            Log.debug(LOGPREFIX + 'server error ' + frame.code);
            this.emit('error', {code: frame.code});
            return;
        }
        if (!this.welcomed) {
            return;
        }
        switch (frame.t) {
            case 'join':
                this.addPeer(frame.peer);
                break;
            case 'leave':
                this.removePeer(frame.p, frame.r);
                break;
            case 'poses':
                frame.b.forEach((entry) => {
                    if (this.roster.has(entry[0])) {
                        this.emit('pose', {peerid: entry[0], data: entry[1]});
                    }
                });
                break;
            case 'ops':
                this.emit('ops', {frame: frame});
                break;
            case 'replayed':
                this.emit('replayed', {seq: frame.seq});
                break;
            case 'gap':
                this.emit('gap', {from: frame.from, first: frame.first});
                break;
            case 'pong':
                if (this.pongtimer) {
                    clearTimeout(this.pongtimer);
                    this.pongtimer = null;
                }
                break;
            default:
                // State frames of vrroom clients and authok carry nothing the studio needs.
                break;
        }
    }

    /**
     * Take over a welcome: self, room size, the roster (a diff, so a reconnect keeps the people
     * who are still there), then tell the session.
     *
     * @param {Object} welcome Parsed welcome frame.
     */
    takeWelcome(welcome) {
        const reconnect = this.everwelcomed;
        this.everwelcomed = true;
        this.selfpeer = {peerid: welcome.self.p, name: welcome.self.name};
        this.maxpeers = welcome.room.max;
        this.posehz = welcome.posehz;
        const seen = new Set();
        welcome.peers.forEach((entry) => {
            if (entry.p === this.selfpeer.peerid) {
                return;
            }
            seen.add(entry.p);
            this.addPeer(entry);
        });
        Array.from(this.roster.keys()).forEach((peerid) => {
            if (!seen.has(peerid)) {
                this.removePeer(peerid, 'left');
            }
        });
        this.retrying = false;
        this.retryattempt = 0;
        this.retrystart = 0;
        this.refreshfirst = false;
        this.startPing();
        this.scheduleRefresh(Frames.refreshDelay(this.result.expires, this.tokenreceived)
            - (Date.now() - this.tokenreceived));
        this.emit('welcome', {frame: welcome, reconnect: reconnect});
    }

    /**
     * Add (or rename) a peer of the roster.
     *
     * @param {{p: string, name: string}} entry
     */
    addPeer(entry) {
        if (this.selfpeer && entry.p === this.selfpeer.peerid) {
            return;
        }
        const peer = this.roster.get(entry.p);
        if (!peer) {
            const added = {peerid: entry.p, name: entry.name};
            this.roster.set(entry.p, added);
            this.emit('peerjoined', {peer: {peerid: added.peerid, name: added.name}});
        } else if (peer.name !== entry.name) {
            peer.name = entry.name;
            this.emit('peerjoined', {peer: {peerid: peer.peerid, name: peer.name}});
        }
    }

    /**
     * Remove a peer of the roster.
     *
     * @param {string} peerid
     * @param {string} reason
     */
    removePeer(peerid, reason) {
        if (!this.roster.has(peerid)) {
            return;
        }
        this.roster.delete(peerid);
        this.emit('peerleft', {peerid: peerid, reason: reason});
    }

    /**
     * Start the application ping.
     */
    startPing() {
        this.stopPing();
        this.pingtimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || !this.welcomed || this.pongtimer) {
                return;
            }
            this.pingcount = this.pingcount >= MAX_PING ? 0 : this.pingcount + 1;
            if (!this.sendFrame(Frames.ping(this.pingcount))) {
                return;
            }
            this.pongtimer = setTimeout(() => {
                this.pongtimer = null;
                if (this.ws === ws && this.welcomed) {
                    Log.debug(LOGPREFIX + 'no pong');
                    this.dropSocket(ws, 1006);
                }
            }, PONG_TIMEOUT);
        }, PING_INTERVAL);
    }

    /**
     * Stop the application ping.
     */
    stopPing() {
        if (this.pingtimer) {
            clearInterval(this.pingtimer);
            this.pingtimer = null;
        }
        if (this.pongtimer) {
            clearTimeout(this.pongtimer);
            this.pongtimer = null;
        }
    }

    /**
     * Schedule the next token refresh.
     *
     * @param {number} delay Milliseconds (at least 1 s is waited).
     */
    scheduleRefresh(delay) {
        if (this.refreshtimer) {
            clearTimeout(this.refreshtimer);
        }
        this.refreshtimer = setTimeout(() => {
            this.refreshtimer = null;
            this.refreshToken();
        }, Math.max(1000, Number(delay) || 0));
    }

    /**
     * Renew the token through Moodle (which re-runs every access check) and send it.
     */
    refreshToken() {
        if (this.state !== 'joined' || this.refreshing) {
            return;
        }
        this.refreshing = true;
        this.fetchJoin(true).then((result) => {
            this.refreshing = false;
            if (!this.isActive()) {
                return;
            }
            this.applyResult(result);
            if (this.welcomed) {
                this.sendFrame(Frames.auth(result.token));
            }
            this.scheduleRefresh(Frames.refreshDelay(result.expires, this.tokenreceived));
            return;
        }, (error) => {
            this.refreshing = false;
            if (!this.isActive()) {
                return;
            }
            if (isNetworkError(error)) {
                // Try again; vrroom-sync closes the session (4410) if the token runs out first.
                this.scheduleRefresh(REFRESH_RETRY);
                return;
            }
            Log.debug(LOGPREFIX + 'access ended');
            this.shutdown('left', 'closed');
        }).catch((error) => Log.debug(error));
    }

    /**
     * The welcomed socket closed: act on the close code.
     *
     * @param {number} code Close code.
     */
    onLost(code) {
        const action = Frames.closeAction(code, true);
        if (action.action === 'left') {
            this.shutdown('left', action.reason);
            return;
        }
        if (action.action === 'fail') {
            this.shutdown('failed', action.reason);
            return;
        }
        this.startReconnect(action.action === 'refresh');
    }

    /**
     * Start (or continue) reconnecting with back-off.
     *
     * @param {boolean} refreshfirst Whether the next attempt needs a new token first.
     */
    startReconnect(refreshfirst) {
        if (refreshfirst) {
            this.refreshfirst = true;
        }
        if (this.refreshtimer) {
            clearTimeout(this.refreshtimer);
            this.refreshtimer = null;
        }
        if (!this.retrying) {
            this.retrying = true;
            this.retryattempt = 0;
            this.retrystart = Date.now();
        }
        if (this.state === 'joined') {
            this.setState('reconnecting', 'network');
        }
        if (Date.now() - this.retrystart >= Frames.GIVE_UP_AFTER) {
            this.shutdown('left', 'network');
            return;
        }
        const delay = Frames.backoff(this.retryattempt);
        this.retryattempt++;
        if (this.retrytimer) {
            clearTimeout(this.retrytimer);
        }
        this.retrytimer = setTimeout(() => {
            this.retrytimer = null;
            this.reconnectAttempt();
        }, delay);
    }

    /**
     * One reconnect attempt: refresh the token when needed, open the socket, take over the welcome.
     */
    reconnectAttempt() {
        if (this.state !== 'reconnecting') {
            return;
        }
        const needtoken = this.refreshfirst || this.tokenStale();
        const token = needtoken ? this.fetchJoin(true).then((result) => {
            if (this.state !== 'reconnecting') {
                throw joinError('closed');
            }
            this.applyResult(result);
            this.refreshfirst = false;
            return undefined;
        }, (error) => {
            if (isNetworkError(error)) {
                // Moodle not reachable: count it as a failed attempt.
                throw closeFailure(1006, false);
            }
            throw joinError('closed', error);
        }) : Promise.resolve();
        token.then(() => this.connectOnce()).then((welcome) => {
            if (this.state !== 'reconnecting') {
                this.closeSocket(Frames.CLOSE.NORMAL);
                return;
            }
            this.setState('joined', '');
            this.takeWelcome(welcome);
            return;
        }).catch((failure) => {
            if (this.state !== 'reconnecting' || (failure && failure.aborted)) {
                return;
            }
            if (!failure || !failure.closefailure) {
                Log.debug(LOGPREFIX + 'access ended');
                this.shutdown('left', 'closed');
                return;
            }
            const code = failure.code ? failure.code : 1006;
            Log.debug(LOGPREFIX + 'reconnect failed (' + code + ')');
            this.onLost(code);
        });
    }

    /**
     * Stop the socket, timers and waits.
     */
    stopEverything() {
        this.cancelWaits();
        this.closeSocket(Frames.CLOSE.NORMAL);
        [this.refreshtimer, this.retrytimer].forEach((timer) => {
            if (timer) {
                clearTimeout(timer);
            }
        });
        this.refreshtimer = null;
        this.retrytimer = null;
        this.retrying = false;
        this.refreshing = false;
    }

    /**
     * End the session locally.
     *
     * @param {string} state 'left' or 'failed'.
     * @param {string} reason Reason.
     */
    shutdown(state, reason) {
        this.stopEverything();
        Array.from(this.roster.keys()).forEach((peerid) => this.removePeer(peerid, 'left'));
        this.setState(state, reason);
    }

    /**
     * Leave the room on purpose: a leave frame, then the socket closes. Safe to call more than once.
     */
    leave() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.welcomed) {
            this.sendFrame(Frames.leave());
        }
        const wasactive = this.isActive() || this.state === 'joining';
        this.stopEverything();
        this.roster.clear();
        if (wasactive) {
            this.setState('left', '');
        }
    }
}

/**
 * Create a companion transport.
 *
 * @param {Object} options {cmid, sessionid, WebSocket?, call?}.
 * @returns {CompanionTransport}
 */
export const createCompanionTransport = (options) => new CompanionTransport(options);
