<?php
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

namespace mod_vrsculpt\external;

use core_external\external_api;
use mod_vrsculpt\local\companion_manager;
use mod_vrsculpt\local\pair_manager;
use mod_vrsculpt\local\session_manager;

/**
 * Tests of the pair-work web services: join, poll, signal, leave.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\pair_join::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\pair_poll::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\pair_signal::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\pair_leave::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\local\pair_manager::class)]
final class pair_services_test extends \core_external\tests\externallib_testcase {
    /** @var \stdClass the group-work activity */
    private \stdClass $vrsculpt;

    /** @var \stdClass the group's session */
    private \stdClass $session;

    /** @var \stdClass the other group's session */
    private \stdClass $othersession;

    /** @var \stdClass[] students a, b, c in the group; d in the other group */
    private array $students = [];

    /** @var \stdClass a teacher */
    private \stdClass $teacher;

    /**
     * A group-work activity with pair work, a group of three and another group of one.
     */
    protected function setUp(): void {
        parent::setUp();
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $this->vrsculpt = $gen->create_module('vrsculpt', [
            'course' => $course->id,
            'workmode' => session_manager::MODE_GROUP,
            'connectmode' => session_manager::CONNECTION_PAIR,
        ]);
        $group = $gen->create_group(['courseid' => $course->id]);
        $othergroup = $gen->create_group(['courseid' => $course->id]);
        foreach (['a', 'b', 'c', 'd'] as $name) {
            $this->students[$name] = $gen->create_and_enrol($course, 'student', ['firstname' => strtoupper($name)]);
            $gen->create_group_member([
                'groupid' => $name === 'd' ? $othergroup->id : $group->id,
                'userid' => $this->students[$name]->id,
            ]);
        }
        $this->teacher = $gen->create_and_enrol($course, 'editingteacher');
        $sculpt = $gen->get_plugin_generator('mod_vrsculpt');
        $this->session = $sculpt->create_session(['vrsculptid' => $this->vrsculpt->id, 'groupid' => $group->id]);
        $this->othersession = $sculpt->create_session(['vrsculptid' => $this->vrsculpt->id, 'groupid' => $othergroup->id]);
    }

    /**
     * Join as a student.
     *
     * @param string $name a, b, c or d
     * @param int $sessionid the session, default the group's
     * @return array the cleaned result
     */
    private function join(string $name, int $sessionid = 0): array {
        $this->setUser($this->students[$name]);
        return external_api::clean_returnvalue(
            pair_join::execute_returns(),
            pair_join::execute((int)$this->vrsculpt->cmid, $sessionid ?: (int)$this->session->id)
        );
    }

    /**
     * Poll as a student.
     *
     * @param string $name a, b, c or d
     * @param string $peerkey the peer key
     * @param int $afterid last message id received
     * @return array the cleaned result
     */
    private function poll(string $name, string $peerkey, int $afterid = 0): array {
        $this->setUser($this->students[$name]);
        return external_api::clean_returnvalue(
            pair_poll::execute_returns(),
            pair_poll::execute((int)$this->vrsculpt->cmid, (int)$this->session->id, $peerkey, $afterid)
        );
    }

    /**
     * Assert that a call fails with a mod_vrsculpt error code.
     *
     * @param string $errorcode the expected code
     * @param callable $call the call
     * @return void
     */
    private function assert_error(string $errorcode, callable $call): void {
        try {
            $call();
            $this->fail("Expected the error {$errorcode}");
        } catch (\moodle_exception $e) {
            $this->assertSame($errorcode, $e->errorcode, $e->getMessage());
        }
    }

    /**
     * The first to join is the host, the second a guest who sees the host; the poll interval and the
     * caller's own name come back.
     */
    public function test_join_host_then_guest(): void {
        $a = $this->join('a');
        $this->assertSame('host', $a['role']);
        $this->assertSame([], $a['peers']);
        $this->assertSame(pair_manager::POLL_MS, $a['pollms']);
        $this->assertTrue(pair_manager::is_peerkey($a['peerkey']));
        $this->assertSame(fullname($this->students['a']), $a['name']);
        $this->assertIsArray($a['iceservers']);

        $b = $this->join('b');
        $this->assertSame('guest', $b['role']);
        $this->assertCount(1, $b['peers']);
        $this->assertSame($a['peerkey'], $b['peers'][0]['peerkey']);
        $this->assertSame((int)$this->students['a']->id, $b['peers'][0]['userid']);
        $this->assertSame('host', $b['peers'][0]['role']);

        $polled = $this->poll('a', $a['peerkey']);
        $this->assertSame('host', $polled['role']);
        $this->assertSame([$b['peerkey']], array_column($polled['peers'], 'peerkey'));
    }

    /**
     * A third member is refused while two are active; once one goes quiet, there is room again.
     */
    public function test_session_full(): void {
        global $DB;
        $a = $this->join('a');
        $this->join('b');
        $this->assert_error('sessionfull', fn() => $this->join('c'));

        $DB->set_field('vrsculpt_peers', 'lastseen', time() - pair_manager::ACTIVE - 5, ['peerkey' => $a['peerkey']]);
        $c = $this->join('c');
        $this->assertSame('host', $c['role']);
        $this->assertFalse($DB->record_exists('vrsculpt_peers', ['peerkey' => $a['peerkey']]));
    }

    /**
     * Joining again replaces the user's row: the old peer key is gone.
     */
    public function test_rejoin_replaces_row(): void {
        global $DB;
        $first = $this->join('a');
        $second = $this->join('a');
        $this->assertNotSame($first['peerkey'], $second['peerkey']);
        $this->assertSame(1, $DB->count_records('vrsculpt_peers', ['sessionid' => $this->session->id]));
        $this->assert_error('peergone', fn() => $this->poll('a', $first['peerkey']));
    }

    /**
     * A message reaches the partner as sent, and is deleted once confirmed with afterid.
     */
    public function test_signal_and_poll(): void {
        global $DB;
        $a = $this->join('a');
        $b = $this->join('b');
        $payload = json_encode(['type' => 'description', 'sdp' => "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n<b>&"]);

        $this->setUser($this->students['a']);
        $cmid = (int)$this->vrsculpt->cmid;
        $result = pair_signal::execute($cmid, (int)$this->session->id, $a['peerkey'], $b['peerkey'], $payload);
        $this->assertTrue($result['ok']);

        $polled = $this->poll('b', $b['peerkey']);
        $this->assertCount(1, $polled['signals']);
        $this->assertSame($a['peerkey'], $polled['signals'][0]['frompeerkey']);
        $this->assertSame($payload, $polled['signals'][0]['payload']);

        // Unconfirmed: delivered again; confirmed: deleted.
        $this->assertCount(1, $this->poll('b', $b['peerkey'])['signals']);
        $this->assertSame([], $this->poll('b', $b['peerkey'], $polled['signals'][0]['id'])['signals']);
        $this->assertSame(0, $DB->count_records('vrsculpt_signals'));
    }

    /**
     * Messages that are too large, empty, to oneself, or to someone not connected are refused.
     */
    public function test_signal_refusals(): void {
        $a = $this->join('a');
        $b = $this->join('b');
        $d = $this->join('d', (int)$this->othersession->id);
        $cmid = (int)$this->vrsculpt->cmid;
        $sessionid = (int)$this->session->id;
        $this->setUser($this->students['a']);

        $this->assert_error('signaltoolarge', fn() => pair_signal::execute(
            $cmid,
            $sessionid,
            $a['peerkey'],
            $b['peerkey'],
            str_repeat('x', pair_manager::MAX_PAYLOAD + 1)
        ));
        $this->assert_error('signalinvalid', fn() => pair_signal::execute($cmid, $sessionid, $a['peerkey'], $b['peerkey'], ''));
        $this->assert_error('peernotfound', fn() => pair_signal::execute($cmid, $sessionid, $a['peerkey'], $a['peerkey'], '{}'));
        // A peer of another session is never reachable.
        $this->assert_error('peernotfound', fn() => pair_signal::execute($cmid, $sessionid, $a['peerkey'], $d['peerkey'], '{}'));
        // Another user's peer key is not the caller's.
        $this->assert_error('peergone', fn() => pair_signal::execute($cmid, $sessionid, $b['peerkey'], $a['peerkey'], '{}'));
    }

    /**
     * When the host stops polling, the guest's next poll makes it the host and the old host is gone.
     */
    public function test_promotion_when_host_goes(): void {
        global $DB;
        $a = $this->join('a');
        $b = $this->join('b');
        $this->assertSame('guest', $b['role']);

        $DB->set_field('vrsculpt_peers', 'lastseen', time() - pair_manager::ACTIVE - 1, ['peerkey' => $a['peerkey']]);
        $polled = $this->poll('b', $b['peerkey']);
        $this->assertSame('host', $polled['role']);
        $this->assertSame([], $polled['peers']);
        $this->assert_error('peergone', fn() => $this->poll('a', $a['peerkey']));

        // The old host comes back as a guest.
        $again = $this->join('a');
        $this->assertSame('guest', $again['role']);
    }

    /**
     * Leaving deletes the row and its messages; the partner becomes the host; leaving twice is fine.
     */
    public function test_leave(): void {
        global $DB;
        $a = $this->join('a');
        $b = $this->join('b');
        $this->setUser($this->students['b']);
        pair_signal::execute((int)$this->vrsculpt->cmid, (int)$this->session->id, $b['peerkey'], $a['peerkey'], '{}');

        $this->setUser($this->students['a']);
        $result = pair_leave::execute((int)$this->vrsculpt->cmid, (int)$this->session->id, $a['peerkey']);
        $this->assertTrue($result['ok']);
        $this->assertFalse($DB->record_exists('vrsculpt_peers', ['peerkey' => $a['peerkey']]));
        $this->assertSame(0, $DB->count_records('vrsculpt_signals'));
        pair_leave::execute((int)$this->vrsculpt->cmid, (int)$this->session->id, $a['peerkey']);

        $this->assertSame('host', $this->poll('b', $b['peerkey'])['role']);
    }

    /**
     * Someone else's peer key cannot be used to leave: the other row stays.
     */
    public function test_leave_with_other_peerkey_does_nothing(): void {
        global $DB;
        $a = $this->join('a');
        $this->join('b');
        $this->setUser($this->students['b']);
        pair_leave::execute((int)$this->vrsculpt->cmid, (int)$this->session->id, $a['peerkey']);
        $this->assertTrue($DB->record_exists('vrsculpt_peers', ['peerkey' => $a['peerkey']]));
    }

    /**
     * IDOR: another group's session, a session id under another activity, another user's peer key.
     */
    public function test_idor_refused(): void {
        $a = $this->join('a');
        $this->join('b');

        // A member of another group cannot join this group's sculpture.
        $this->setUser($this->students['d']);
        $this->assert_error('cannotsculpt', fn() => pair_join::execute((int)$this->vrsculpt->cmid, (int)$this->session->id));
        $this->assert_error('cannotsculpt', fn() => pair_poll::execute(
            (int)$this->vrsculpt->cmid,
            (int)$this->session->id,
            $a['peerkey'],
            0
        ));

        // The session id under another activity's cmid.
        $other = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $this->vrsculpt->course,
            'workmode' => session_manager::MODE_GROUP]);
        $this->setUser($this->students['a']);
        $this->assert_error('invalidsession', fn() => pair_join::execute((int)$other->cmid, (int)$this->session->id));
        $this->assert_error('invalidsession', fn() => pair_poll::execute(
            (int)$other->cmid,
            (int)$this->session->id,
            $a['peerkey'],
            0
        ));

        // Another member's peer key.
        $this->assert_error('peergone', fn() => $this->poll('b', $a['peerkey']));
        $this->assert_error('peergone', fn() => $this->poll('a', 'notapeerkey'));
    }

    /**
     * A teacher may not join; a closed sculpture cannot be joined; individual work has no pairs.
     */
    public function test_gates(): void {
        global $DB;
        $this->setUser($this->teacher);
        try {
            pair_join::execute((int)$this->vrsculpt->cmid, (int)$this->session->id);
            $this->fail('A teacher joined');
        } catch (\required_capability_exception $e) {
            $this->assertSame('nopermissions', $e->errorcode);
        }

        $DB->set_field('vrsculpt_sessions', 'status', session_manager::STATUS_CLOSED, ['id' => $this->session->id]);
        $this->assert_error('cannotsculpt', fn() => $this->join('a'));

        $solo = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $this->vrsculpt->course]);
        $session = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt')
            ->create_session(['vrsculptid' => $solo->id, 'userid' => $this->students['a']->id]);
        $this->setUser($this->students['a']);
        $this->assert_error('notpairwork', fn() => pair_join::execute((int)$solo->cmid, (int)$session->id));
    }

    /**
     * An activity that chose the companion service falls back to pair work while the service is not
     * available, and refuses pair work once it is.
     */
    public function test_companion_activity_falls_back_to_pair(): void {
        global $DB;
        $DB->set_field('vrsculpt', 'connectmode', session_manager::CONNECTION_COMPANION, ['id' => $this->vrsculpt->id]);
        if (!companion_manager::is_available()) {
            $this->assertSame('host', $this->join('a')['role']);
        }
        if (!companion_manager::is_installed()) {
            return;
        }
        set_config('url', 'https://companion.example.org', 'vrroomruntime_companion');
        set_config('secret', str_repeat('s', 40), 'vrroomruntime_companion');
        $this->assertTrue(companion_manager::is_available());
        $this->assert_error('notpairwork', fn() => $this->join('b'));
    }

    /**
     * The scheduled task's purge removes peers and messages older than an hour only.
     */
    public function test_purge_expired(): void {
        global $DB;
        $a = $this->join('a');
        $b = $this->join('b');
        $this->setUser($this->students['a']);
        pair_signal::execute((int)$this->vrsculpt->cmid, (int)$this->session->id, $a['peerkey'], $b['peerkey'], '{}');

        $old = time() - pair_manager::EXPIRY - 10;
        $DB->set_field('vrsculpt_peers', 'lastseen', $old, ['peerkey' => $a['peerkey']]);
        $counts = pair_manager::purge_expired();

        $this->assertSame(1, $counts['peers']);
        $this->assertSame(1, $counts['signals']);
        $this->assertFalse($DB->record_exists('vrsculpt_peers', ['peerkey' => $a['peerkey']]));
        $this->assertTrue($DB->record_exists('vrsculpt_peers', ['peerkey' => $b['peerkey']]));
        $this->assertSame(0, $DB->count_records('vrsculpt_signals'));
    }
}
