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

namespace mod_vrmakerspace\external;

use core_external\external_api;
use mod_vrmakerspace\local\companion_manager;
use mod_vrmakerspace\local\session_manager;

/**
 * Tests of the companion_join web service.
 *
 * The configured case needs the optional plugin vrroomruntime_companion and is skipped without it.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\companion_join::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\companion_manager::class)]
final class companion_join_test extends \core_external\tests\externallib_testcase {
    /**
     * A group-work activity over the companion service with one group and its sculpture.
     *
     * @param string $connection the activity's connection
     * @return array [\stdClass $vrmakerspace, \stdClass $session, \stdClass $member, \stdClass $outsider]
     */
    private function setup_activity(string $connection = session_manager::CONNECTION_COMPANION): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', [
            'course' => $course->id,
            'workmode' => session_manager::MODE_GROUP,
            'connectmode' => $connection,
            'maxusers' => 5,
        ]);
        $member = $gen->create_and_enrol($course, 'student');
        $outsider = $gen->create_and_enrol($course, 'student');
        $group = $gen->create_group(['courseid' => $course->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $member->id]);
        $session = $gen->get_plugin_generator('mod_vrmakerspace')
            ->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'groupid' => $group->id]);
        return [$vrmakerspace, $session, $member, $outsider];
    }

    /**
     * Not configured (or not installed): companionnotconfigured, the studio's cue to fall back to pairs.
     */
    public function test_not_configured(): void {
        $this->resetAfterTest();
        if (companion_manager::is_installed()) {
            set_config('url', '', 'vrroomruntime_companion');
            set_config('secret', '', 'vrroomruntime_companion');
        }
        [$vrmakerspace, $session, $member] = $this->setup_activity();
        $this->setUser($member);
        $this->assertFalse(companion_manager::is_available());

        try {
            companion_join::execute((int)$vrmakerspace->cmid, (int)$session->id);
            $this->fail('A token was made without the companion service');
        } catch (\moodle_exception $e) {
            $this->assertSame('companionnotconfigured', $e->errorcode);
        }
    }

    /**
     * Configured: a token for the sculpture's room, with the peer id and room made from pseudonyms, and
     * the activity's maximum; the same user and sculpture always get the same peer id.
     */
    public function test_configured(): void {
        $this->resetAfterTest();
        if (!companion_manager::is_installed()) {
            $this->markTestSkipped('vrroomruntime_companion is not installed.');
        }
        set_config('url', 'https://companion.example.org', 'vrroomruntime_companion');
        set_config('secret', str_repeat('k', 40), 'vrroomruntime_companion');
        [$vrmakerspace, $session, $member] = $this->setup_activity();
        $this->setUser($member);

        $result = external_api::clean_returnvalue(
            companion_join::execute_returns(),
            companion_join::execute((int)$vrmakerspace->cmid, (int)$session->id)
        );
        $this->assertSame('wss://companion.example.org/sync', $result['url']);
        $this->assertNotEmpty($result['token']);
        $this->assertGreaterThan(time(), $result['expires']);
        $this->assertSame(companion_manager::room_id((int)$session->id), $result['room']);
        $this->assertMatchesRegularExpression('/^r[0-9a-f]{32}$/', $result['room']);
        $this->assertSame(companion_manager::peer_id((int)$member->id, (int)$session->id), $result['peerid']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $result['peerid']);
        $this->assertSame(fullname($member), $result['name']);
        $this->assertSame(5, $result['max']);

        $again = companion_join::execute((int)$vrmakerspace->cmid, (int)$session->id);
        $this->assertSame($result['peerid'], $again['peerid']);
    }

    /**
     * IDOR and gates: a non-member, another activity's cmid, a pair-work activity.
     */
    public function test_refusals(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $session, $member, $outsider] = $this->setup_activity();

        $this->setUser($outsider);
        try {
            companion_join::execute((int)$vrmakerspace->cmid, (int)$session->id);
            $this->fail('A non-member got a token');
        } catch (\moodle_exception $e) {
            $this->assertSame('cannotsculpt', $e->errorcode);
        }

        $other = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $vrmakerspace->course]);
        $this->setUser($member);
        try {
            companion_join::execute((int)$other->cmid, (int)$session->id);
            $this->fail('A session of another activity was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('invalidsession', $e->errorcode);
        }

        [$pairs, $pairsession, $pairmember] = $this->setup_activity(session_manager::CONNECTION_PAIR);
        $this->setUser($pairmember);
        try {
            companion_join::execute((int)$pairs->cmid, (int)$pairsession->id);
            $this->fail('A pair-work activity gave a companion token');
        } catch (\moodle_exception $e) {
            $this->assertSame('notcompanionwork', $e->errorcode);
        }
    }
}
