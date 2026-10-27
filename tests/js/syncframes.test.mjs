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
 * Tests of the vrroom-sync frames with the sculpting additions (mod_vrsculpt/net/syncframes).
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
