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
 * Tests of the vrroom-sync frames with the sculpting additions (mod_vrmakerspace/net/syncframes).
 *
 * Run from the repository root: node --test tests/js/syncframes.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    SUBPROTOCOL, MAX_OP, CLOSE, isPeerId, isEpoch, hello, auth, pose, op, replay, ping, leave, parse,
    closeAction, backoff, refreshDelay,
} from '../../amd/src/net/syncframes.js';
import {
    MAX_MESH_OP_TEXT, MAX_OP_TEXT, MESH_KINDS as WIRE_MESH_KINDS, OP_KINDS, fitsWire, isIndex, isVec3, parseOp, rebuildOp,
} from '../../amd/src/net/opwire.js';
import {KINDS} from '../../js/engine/ops.js';
import {MAX_MESH_BYTES, MESH_KINDS, cleanMeshOp} from '../../js/engine/polyops.js';

const PEER = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const EPOCH = '0123456789abcdef';

/**
 * A valid welcome frame object, with changes.
 *
 * @param {Object} [changes] Keys to replace.
 * @returns {Object}
 */
const welcome = (changes) => Object.assign({
    t: 'welcome',
    protocol: 1,
    server: 'vrroom-sync/1.1.0',
    self: {p: PEER, name: 'Ann', kind: 'attempt'},
    room: {max: 8},
    peers: [{p: OTHER, name: 'Bob', kind: 'attempt', s: null}],
    exp: 1800000000,
    posehz: 15,
    sculpt: {epoch: EPOCH, seq: 42},
}, changes || {});

test('constants', () => {
    assert.equal(SUBPROTOCOL, 'vrroom-sync.1');
    assert.equal(MAX_OP, 1024);
    assert.equal(CLOSE.FULL, 4503);
});

test('ids', () => {
    assert.ok(isPeerId(PEER));
    assert.ok(!isPeerId(PEER.toUpperCase()));
    assert.ok(!isPeerId(PEER + '0'));
    assert.ok(isEpoch(EPOCH));
    assert.ok(!isEpoch('0123'));
    assert.ok(!isEpoch(null));
});

test('client frames', () => {
    assert.deepEqual(JSON.parse(hello('tok')), {t: 'hello', token: 'tok'});
    assert.deepEqual(JSON.parse(auth('tok2')), {t: 'auth', token: 'tok2'});
    assert.deepEqual(JSON.parse(pose('{"t":"p"}')), {t: 'pose', d: '{"t":"p"}'});
    assert.deepEqual(JSON.parse(op('{"k":"add"}')), {t: 'op', d: '{"k":"add"}'});
    assert.equal(op(''), null);
    assert.equal(op('x'.repeat(MAX_OP + 1)), null);
    assert.equal(op(42), null);
    assert.notEqual(op('x'.repeat(MAX_OP)), null);
    assert.deepEqual(JSON.parse(replay(17)), {t: 'replay', from: 17});
    assert.deepEqual(JSON.parse(replay(-3)), {t: 'replay', from: 0});
    assert.deepEqual(JSON.parse(replay(1.5)), {t: 'replay', from: 0});
    assert.deepEqual(JSON.parse(ping(5)), {t: 'ping', n: 5});
    assert.deepEqual(JSON.parse(ping(-1)), {t: 'ping', n: 0});
    assert.deepEqual(JSON.parse(leave()), {t: 'leave'});
});

test('welcome with sculpt', () => {
    const frame = parse(JSON.stringify(welcome({extra: 'ignored'})));
    assert.deepEqual(frame, {
        t: 'welcome',
        protocol: 1,
        server: 'vrroom-sync/1.1.0',
        self: {p: PEER, name: 'Ann', kind: 'attempt'},
        room: {max: 8},
        peers: [{p: OTHER, name: 'Bob', kind: 'attempt'}],
        exp: 1800000000,
        posehz: 15,
        sculpt: {epoch: EPOCH, seq: 42},
    });
});

test('welcome without sculpt (an older server) parses with sculpt null', () => {
    const raw = welcome();
    delete raw.sculpt;
    assert.equal(parse(JSON.stringify(raw)).sculpt, null);
});

test('welcome with a broken sculpt block is refused', () => {
    assert.equal(parse(JSON.stringify(welcome({sculpt: {epoch: 'xyz', seq: 1}}))), null);
    assert.equal(parse(JSON.stringify(welcome({sculpt: {epoch: EPOCH, seq: -1}}))), null);
    assert.equal(parse(JSON.stringify(welcome({sculpt: {epoch: EPOCH, seq: 1.5}}))), null);
    assert.equal(parse(JSON.stringify(welcome({sculpt: 'yes'}))), null);
});

test('welcome shape checks', () => {
    assert.equal(parse(JSON.stringify(welcome({protocol: 2}))), null);
    assert.equal(parse(JSON.stringify(welcome({self: {p: 'nope', name: 'Ann', kind: 'attempt'}}))), null);
    assert.equal(parse(JSON.stringify(welcome({posehz: 0}))), null);
    assert.equal(parse(JSON.stringify(welcome({peers: [{p: OTHER, name: '', kind: 'attempt'}]}))), null);
    assert.equal(parse(JSON.stringify(welcome({peers: [{p: OTHER, name: 'B\u0001', kind: 'attempt'}]}))), null);
});

test('ops frames', () => {
    const live = parse(JSON.stringify({t: 'ops', ops: [{n: 1, p: PEER, d: '{"k":"add"}', x: 1}]}));
    assert.deepEqual(live, {t: 'ops', ops: [{n: 1, p: PEER, d: '{"k":"add"}'}]});
    const replayed = parse(JSON.stringify({t: 'ops', r: 1, ops: [{n: 7, p: OTHER, d: '{}'}]}));
    assert.deepEqual(replayed, {t: 'ops', r: 1, ops: [{n: 7, p: OTHER, d: '{}'}]});
    assert.deepEqual(parse(JSON.stringify({t: 'ops', ops: []})), {t: 'ops', ops: []});
});

test('ops frames with bad entries are refused whole', () => {
    const bad = [
        {t: 'ops', ops: [{n: 0, p: PEER, d: '{}'}]},
        {t: 'ops', ops: [{n: 1.5, p: PEER, d: '{}'}]},
        {t: 'ops', ops: [{n: 1, p: 'x', d: '{}'}]},
        {t: 'ops', ops: [{n: 1, p: PEER, d: ''}]},
        {t: 'ops', ops: [{n: 1, p: PEER, d: 'x'.repeat(MAX_OP + 1)}]},
        {t: 'ops', ops: [{n: 1, p: PEER, d: {k: 'add'}}]},
        {t: 'ops', ops: 'none'},
        {t: 'ops', r: 2, ops: []},
        {t: 'ops', ops: [null]},
    ];
    bad.forEach((frame) => assert.equal(parse(JSON.stringify(frame)), null, JSON.stringify(frame)));
});

test('replayed and gap', () => {
    assert.deepEqual(parse('{"t":"replayed","seq":12,"x":1}'), {t: 'replayed', seq: 12});
    assert.equal(parse('{"t":"replayed","seq":-1}'), null);
    assert.deepEqual(parse('{"t":"gap","from":3,"first":90}'), {t: 'gap', from: 3, first: 90});
    assert.equal(parse('{"t":"gap","from":3}'), null);
    assert.equal(parse('{"t":"gap","from":"3","first":9}'), null);
});

test('presence frames', () => {
    assert.deepEqual(parse(JSON.stringify({t: 'join', peer: {p: OTHER, name: 'Bob', kind: 'attempt'}})),
        {t: 'join', peer: {p: OTHER, name: 'Bob', kind: 'attempt'}});
    assert.deepEqual(parse(JSON.stringify({t: 'leave', p: OTHER, r: 'timeout'})), {t: 'leave', p: OTHER, r: 'timeout'});
    assert.equal(parse(JSON.stringify({t: 'leave', p: OTHER, r: 'Time Out'})), null);
    assert.deepEqual(parse(JSON.stringify({t: 'poses', b: [[OTHER, '{"t":"p"}']]})), {t: 'poses', b: [[OTHER, '{"t":"p"}']]});
    assert.equal(parse(JSON.stringify({t: 'poses', b: [[OTHER]]})), null);
    assert.deepEqual(parse('{"t":"pong","n":3}'), {t: 'pong', n: 3});
    assert.deepEqual(parse('{"t":"authok","exp":5}'), {t: 'authok', exp: 5});
    assert.deepEqual(parse('{"t":"error","code":"ratelimited"}'), {t: 'error', code: 'ratelimited'});
    assert.equal(parse('{"t":"error","code":"<b>"}'), null);
});

test('parse refuses anything else', () => {
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
    assert.equal(parse('not json'), null);
    assert.equal(parse('[]'), null);
    assert.equal(parse('{"t":"unknown"}'), null);
    assert.equal(parse('{"t":"__proto__"}'), null);
    assert.equal(parse('{"t":"toString"}'), null);
    assert.equal(parse('"x"'.padEnd(1048577, ' ')), null);
});

test('close actions', () => {
    assert.deepEqual(closeAction(1006, true), {action: 'retry', reason: 'network'});
    assert.deepEqual(closeAction(undefined, true), {action: 'retry', reason: 'network'});
    assert.deepEqual(closeAction(1005, false), {action: 'retry', reason: 'network'});
    assert.deepEqual(closeAction(4410, true), {action: 'refresh', reason: 'closed'});
    assert.deepEqual(closeAction(4503, false), {action: 'fail', reason: 'full'});
    assert.deepEqual(closeAction(4503, true), {action: 'left', reason: 'full'});
    assert.deepEqual(closeAction(4409, true), {action: 'left', reason: 'replaced'});
    assert.deepEqual(closeAction(4999, false), {action: 'fail', reason: 'error'});
    assert.deepEqual(closeAction(4999, true), {action: 'retry', reason: 'network'});
});

test('back-off', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(backoff), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    assert.equal(backoff(-1), 1000);
});

test('refresh delay', () => {
    const now = 1800000000 * 1000;
    assert.equal(refreshDelay(1800000000 + 300, now), 180000);
    assert.equal(refreshDelay(1800000000 + 100, now), 60000);
    // A lifetime that looks wrong (clocks apart) counts as 300 s.
    assert.equal(refreshDelay(1800000000 + 5, now), 180000);
    assert.equal(refreshDelay(1800000000 + 99999, now), 180000);
    assert.equal(refreshDelay('nonsense', now), 180000);
});

/** The largest safe element id: 16 digits on the wire. */
const BIG_ID = Number.MAX_SAFE_INTEGER;

/** A well-formed op of every mesh kind and form, keys in the wire order but for the author, which rebuildOp adds. */
const MESH_OPS = Object.freeze([
    {k: 'msel', i: 1, md: 'v', sm: 'set', ids: [0, 4096, BIG_ID]},
    {k: 'msel', i: 2, md: 'e', sm: 'add', ids: [4096, 8192, 8192, BIG_ID]},
    {k: 'msel', i: 3, sm: 'all'},
    {k: 'msel', i: 4, sm: 'none'},
    {k: 'msel', i: 5, sm: 'linked', ids: [8192]},
    {k: 'msel', i: 6, md: 'e', sm: 'loop', e: [8192, BIG_ID]},
    {k: 'mprim', s: 1, i: 7, p: [0, 0.1, 0], r: 0.08, x: [0, 1, 0], g: 3.1416, sh: 'torus', n: 48},
    {k: 'mprim', s: 2, i: 8, p: [0, 0, 0], r: 0.05, sh: 'cube'},
    {k: 'mxf', s: 3, i: 9, d: [0.01, -0.02, 0.8]},
    {k: 'mxf', s: 3, i: 10, p: [0, 0, 0], x: [0, 0, 1], g: -0.5},
    {k: 'mxf', s: 3, i: 11, p: [0, 0, 0], sc: [0.05, 1.5, 20]},
    {k: 'mext', s: 4, i: 12},
    {k: 'minset', s: 5, i: 13, r: 0.01},
    {k: 'minset', s: 5, i: 14, r: 0.2, m: 1},
    {k: 'mbevel', s: 6, i: 15, r: 0.1, n: 4},
    {k: 'mloop', s: 7, i: 16, st: 0.5, e: [4096, BIG_ID], n: 8},
    {k: 'mmerge', s: 8, i: 17},
    {k: 'mmerge', s: 8, i: 18, sm: 'first'},
    {k: 'mmerge', s: 8, i: 19, r: 0.05, sm: 'dist'},
    {k: 'mdel', s: 9, i: 20},
    {k: 'mfill', s: 10, i: 21},
    {k: 'mflip', s: 11, i: 22},
    {k: 'mmirror', s: 12, i: 23},
    {k: 'mbake', s: 13, i: 24},
]);

/**
 * The op's JSON with the author key second, as rebuildOp lays it out.
 *
 * @param {Object} source An op of MESH_OPS.
 * @param {string} author
 * @returns {string}
 */
const stamped = (source, author) => {
    const {k, ...rest} = source;
    return JSON.stringify({k, a: author, ...rest});
};

test('the wire knows the same kinds as the engine', () => {
    assert.deepEqual([...OP_KINDS].sort(), [...KINDS].sort());
    assert.deepEqual([...WIRE_MESH_KINDS], [...MESH_KINDS]);
    assert.equal(MAX_MESH_OP_TEXT, MAX_MESH_BYTES);
    assert.equal(MAX_OP_TEXT, MAX_OP);
    MESH_KINDS.forEach((kind) => assert.ok(MESH_OPS.some((source) => source.k === kind), kind));
});

test('rebuildOp keeps every mesh key, in the wire order, and the engine agrees with it', () => {
    MESH_OPS.forEach((source) => {
        const op = rebuildOp(source, 'u7');
        const text = JSON.stringify(op);
        assert.equal(text, stamped(source, 'u7'));
        // The engine's clean copy is the same text: its fast path compares JSON.
        assert.equal(JSON.stringify(cleanMeshOp(op)), text, source.k);
    });
});

test('rebuildOp puts scrambled keys in the wire order, drops unknown ones and stamps the author', () => {
    const op = rebuildOp({sc: [1, 1, 1], p: [0, 0, 0], i: 5, zz: 1, a: 'forged', s: 2, k: 'mxf'}, 'u7');
    assert.equal(JSON.stringify(op), '{"k":"mxf","a":"u7","s":2,"i":5,"p":[0,0,0],"sc":[1,1,1]}');
});

test('a mesh op that went through the relay (no author, same order) comes out as the sender made it', () => {
    MESH_OPS.forEach((source) => {
        const sent = rebuildOp(source, PEER);
        const relayed = JSON.stringify(source);
        assert.equal(JSON.stringify(parseOp(relayed, PEER)), JSON.stringify(sent), source.k);
    });
});

test('rebuildOp shares no array with its source', () => {
    const source = {k: 'msel', i: 1, sm: 'set', ids: [1, 2], e: [1, 2]};
    const op = rebuildOp(source, 'u7');
    source.ids.push(3);
    source.e[0] = 9;
    assert.deepEqual(op.ids, [1, 2]);
    assert.deepEqual(op.e, [1, 2]);
});

test('rebuildOp refuses wrong types', () => {
    const bad = [
        null,
        [],
        'msel',
        {k: 'erase', i: 1},
        {k: 'msel'},
        {k: 'msel', i: 0},
        {k: 'mxf', s: 0, i: 1},
        {k: 'msel', i: 1, md: 1},
        {k: 'msel', i: 1, sm: null},
        {k: 'msel', i: 1, sm: 'x'.repeat(41)},
        {k: 'msel', i: 1, ids: 5},
        {k: 'msel', i: 1, ids: {0: 1, length: 1}},
        {k: 'msel', i: 1, ids: [-1]},
        {k: 'msel', i: 1, ids: [1.5]},
        {k: 'msel', i: 1, ids: ['1']},
        {k: 'msel', i: 1, ids: [null]},
        {k: 'msel', i: 1, ids: [[1]]},
        {k: 'msel', i: 1, ids: [BIG_ID + 1]},
        // eslint-disable-next-line no-sparse-arrays
        {k: 'msel', i: 1, ids: [1, , 2]},
        {k: 'mloop', s: 1, i: 1, e: [1]},
        {k: 'mloop', s: 1, i: 1, e: [1, 2, 3]},
        {k: 'mloop', s: 1, i: 1, e: [1, -2]},
        {k: 'mloop', s: 1, i: 1, e: '1_2'},
        {k: 'mbevel', s: 1, i: 1, n: 0},
        {k: 'mbevel', s: 1, i: 1, n: 1.5},
        {k: 'mbevel', s: 1, i: 1, n: '2'},
        {k: 'minset', s: 1, i: 1, m: true},
        {k: 'mxf', s: 1, i: 1, sc: [1, 1]},
        {k: 'mxf', s: 1, i: 1, sc: [1, '1', 1]},
        {k: 'mxf', s: 1, i: 1, sc: 2},
        {k: 'mxf', s: 1, i: 1, d: [0, 0, null]},
    ];
    bad.forEach((source) => assert.equal(rebuildOp(source, 'u7'), null, JSON.stringify(source)));
});

test('clay ops still rebuild as before', () => {
    const add = {k: 'add', s: 1, i: 2, p: [0, 0, 0], r: 0.02, st: 0.5, m: 1};
    assert.equal(JSON.stringify(rebuildOp(add, 'u7')), stamped(add, 'u7'));
    const text = {k: 'shape', s: 1, i: 3, p: [0, 0, 0], r: 0.02, st: 0.5, x: [0, 1, 0], g: 0, sh: 'text', tx: 'HI'};
    assert.equal(JSON.stringify(rebuildOp(text, 'u7')), stamped(text, 'u7'));
    assert.equal(JSON.stringify(rebuildOp({k: 'undo', i: 4, t: 1}, 'u7')), '{"k":"undo","a":"u7","i":4,"t":1}');
    assert.ok(isVec3([0, 0, 0]));
    assert.ok(!isVec3([0, 0]));
    assert.ok(isIndex(2147483647));
    assert.ok(!isIndex(2147483648));
});

test('parseOp limits', () => {
    assert.equal(parseOp('', 'u7'), null);
    assert.equal(parseOp('not json', 'u7'), null);
    assert.equal(parseOp(42, 'u7'), null);
    assert.equal(parseOp('{"k":"msel","i":1,"ids":[9007199254740992]}', 'u7'), null);
    assert.equal(parseOp('{"k":"msel","i":1,"zz":"' + 'x'.repeat(MAX_OP_TEXT) + '"}', 'u7'), null);
});

test('a mesh op over the engine\'s limit does not fit the wire; a clay op of that length does', () => {
    const op = rebuildOp({k: 'msel', i: 1, sm: 'add', ids: []}, 'u7');
    assert.ok(fitsWire(op, 'x'.repeat(MAX_MESH_OP_TEXT)));
    assert.ok(!fitsWire(op, 'x'.repeat(MAX_MESH_OP_TEXT + 1)));
    const clay = rebuildOp({k: 'save', i: 1}, 'u7');
    assert.ok(fitsWire(clay, 'x'.repeat(MAX_OP_TEXT)));
    assert.ok(!fitsWire(clay, 'x'.repeat(MAX_OP_TEXT + 1)));
});

test('the largest selection op fits an op frame of the relay', () => {
    // As many of the longest ids as the engine takes, each 17 characters with its comma.
    const ids = [];
    const source = {k: 'msel', i: 2147483647, md: 'v', sm: 'add', ids};
    while (JSON.stringify(rebuildOp(source, PEER)).length + 17 <= MAX_MESH_OP_TEXT) {
        ids.push(BIG_ID);
    }
    const built = rebuildOp(source, PEER);
    const text = JSON.stringify(built);
    assert.ok(text.length <= MAX_MESH_OP_TEXT);
    assert.notEqual(cleanMeshOp(built), null);
    const frame = op(text);
    assert.notEqual(frame, null);
    assert.ok(Buffer.byteLength(frame) <= 2048);
    // The relay's copy has no author and comes back through the ops frame.
    const entry = {n: 9, p: PEER, d: JSON.stringify(source)};
    assert.deepEqual(parse(JSON.stringify({t: 'ops', ops: [entry]})), {t: 'ops', ops: [entry]});
});
