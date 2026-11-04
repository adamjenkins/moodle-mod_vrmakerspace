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
use mod_vrmakerspace\local\session_manager;

/**
 * Tests of the report_contribution and set_session_status web services.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\report_contribution::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\set_session_status::class)]
final class session_services_test extends \core_external\tests\externallib_testcase {
    /**
     * A group-work activity, a group with a member, another group with a member, and a teacher.
     *
     * @param int $track whether contributions are tracked
     * @return array [\stdClass $vrmakerspace, \stdClass $session, \stdClass $member, \stdClass $outsider,
     *     \stdClass $teacher, \stdClass $othersession]
     */
    private function setup_activity(int $track = 1): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', [
            'course' => $course->id,
            'workmode' => session_manager::MODE_GROUP,
            'trackcontributions' => $track,
        ]);
        $member = $gen->create_and_enrol($course, 'student');
        $outsider = $gen->create_and_enrol($course, 'student');
        $teacher = $gen->create_and_enrol($course, 'editingteacher');
        $group = $gen->create_group(['courseid' => $course->id]);
        $othergroup = $gen->create_group(['courseid' => $course->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $member->id]);
        $gen->create_group_member(['groupid' => $othergroup->id, 'userid' => $outsider->id]);
        $sculpt = $gen->get_plugin_generator('mod_vrmakerspace');
        $session = $sculpt->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'groupid' => $group->id]);
        $othersession = $sculpt->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'groupid' => $othergroup->id]);
        return [$vrmakerspace, $session, $member, $outsider, $teacher, $othersession];
    }

    /**
     * Assert that a call fails with an error code.
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
     * A member's report is recorded, capped; one sent at once after it is not accepted.
     */
    public function test_report_contribution(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $session, $member] = $this->setup_activity();
        $this->setUser($member);

        $result = external_api::clean_returnvalue(
            report_contribution::execute_returns(),
            report_contribution::execute((int)$vrmakerspace->cmid, (int)$session->id, 99999, 2e8, 12.5)
        );
        $this->assertTrue($result['accepted']);
        $record = $DB->get_record('vrmakerspace_contrib', ['sessionid' => $session->id, 'userid' => $member->id], '*', MUST_EXIST);
        $this->assertSame(5000, (int)$record->ops);
        $this->assertEquals(1e7, (float)$record->added);
        $this->assertEquals(12.5, (float)$record->removed);

        $again = report_contribution::execute((int)$vrmakerspace->cmid, (int)$session->id, 10, 1.0, 1.0);
        $this->assertFalse($again['accepted']);
        $this->assertSame(5000, (int)$DB->get_field('vrmakerspace_contrib', 'ops', ['id' => $record->id]));
    }

    /**
     * Refused: another group's sculpture, another activity's cmid, an activity that does not track.
     */
    public function test_report_contribution_refusals(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $session, $member, $outsider] = $this->setup_activity();

        $this->setUser($outsider);
        $this->assert_error('cannotsculpt', fn() => report_contribution::execute((int)$vrmakerspace->cmid, (int)$session->id, 1, 1, 1));

        $other = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $vrmakerspace->course,
            'workmode' => session_manager::MODE_GROUP, 'trackcontributions' => 1]);
        $this->setUser($member);
        $this->assert_error('invalidsession', fn() => report_contribution::execute((int)$other->cmid, (int)$session->id, 1, 1, 1));

        $DB->set_field('vrmakerspace', 'trackcontributions', 0, ['id' => $vrmakerspace->id]);
        $this->assert_error('contributionsnottracked', fn() => report_contribution::execute(
            (int)$vrmakerspace->cmid,
            (int)$session->id,
            1,
            1,
            1
        ));
        $this->assertSame(0, $DB->count_records('vrmakerspace_contrib'));
    }

    /**
     * A teacher closes and reopens; the state follows; a student cannot.
     */
    public function test_set_session_status(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $session, $member, , $teacher, $othersession] = $this->setup_activity();

        $this->setUser($teacher);
        $state = external_api::clean_returnvalue(
            set_session_status::execute_returns(),
            set_session_status::execute((int)$vrmakerspace->cmid, (int)$session->id, session_manager::STATUS_CLOSED)
        );
        $this->assertSame(session_manager::STATUS_CLOSED, $state['status']);
        $status = (int)$DB->get_field('vrmakerspace_sessions', 'status', ['id' => $session->id]);
        $this->assertSame(session_manager::STATUS_CLOSED, $status);
        $otherstatus = (int)$DB->get_field('vrmakerspace_sessions', 'status', ['id' => $othersession->id]);
        $this->assertSame(session_manager::STATUS_OPEN, $otherstatus);
        $this->assert_error('invalidstatus', fn() => set_session_status::execute((int)$vrmakerspace->cmid, (int)$session->id, 2));

        $state = set_session_status::execute((int)$vrmakerspace->cmid, (int)$session->id, session_manager::STATUS_OPEN);
        $this->assertSame(session_manager::STATUS_OPEN, $state['status']);

        // Another activity's cmid with this session id.
        $other = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $vrmakerspace->course]);
        $this->assert_error('invalidsession', fn() => set_session_status::execute((int)$other->cmid, (int)$session->id, 1));

        $this->setUser($member);
        $this->expectException(\required_capability_exception::class);
        set_session_status::execute((int)$vrmakerspace->cmid, (int)$session->id, session_manager::STATUS_CLOSED);
    }
}
