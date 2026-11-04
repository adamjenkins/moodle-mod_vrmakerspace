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
 * Tests of the save_snapshot and get_session_state web services.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\save_snapshot::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\get_session_state::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\helper::class)]
final class snapshot_services_test extends \core_external\tests\externallib_testcase {
    /**
     * A course with an activity, two students and a teacher.
     *
     * @return array [\stdClass $vrmakerspace, \stdClass $owner, \stdClass $other, \stdClass $teacher, \stdClass $session]
     */
    private function setup_activity(): array {
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id]);
        $owner = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $other = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $teacher = $this->getDataGenerator()->create_and_enrol($course, 'editingteacher');
        $session = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')
            ->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $owner->id]);
        return [$vrmakerspace, $owner, $other, $teacher, $session];
    }

    /**
     * A valid snapshot file.
     *
     * @return string
     */
    private function valid_data(): string {
        return $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')->snapshot_data();
    }

    /**
     * The owner saves a version; the returned state and the stored file agree.
     */
    public function test_owner_saves(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $owner, , , $session] = $this->setup_activity();
        $this->setUser($owner);

        $data = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')->snapshot_data('data', 12);
        $result = save_snapshot::execute((int)$vrmakerspace->cmid, (int)$session->id, base64_encode($data), 12);
        $result = external_api::clean_returnvalue(save_snapshot::execute_returns(), $result);

        $this->assertSame(1, $result['version']);
        $this->assertSame(12, $result['opcount']);
        $this->assertTrue($result['cansculpt']);
        $this->assertSame('', $result['connection']);
        $snapshot = session_manager::get_latest_snapshot((int)$session->id);
        $this->assertSame($data, session_manager::get_snapshot_file(
            $snapshot,
            \context_module::instance($vrmakerspace->cmid)
        )->get_content());

        $state = external_api::clean_returnvalue(
            get_session_state::execute_returns(),
            get_session_state::execute((int)$vrmakerspace->cmid, (int)$session->id)
        );
        $this->assertSame(1, $state['version']);
        $this->assertStringContainsString('/mod_vrmakerspace/snapshots/' . $snapshot->id . '/', $state['url']);
    }

    /**
     * Another student cannot save into, or read, someone else's piece.
     */
    public function test_other_student_refused(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, , $other, , $session] = $this->setup_activity();
        $this->setUser($other);

        try {
            save_snapshot::execute((int)$vrmakerspace->cmid, (int)$session->id, base64_encode($this->valid_data()), 1);
            $this->fail('A student saved into another student\'s piece');
        } catch (\moodle_exception $e) {
            $this->assertSame('cannotsculpt', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots'));

        $this->expectException(\required_capability_exception::class);
        get_session_state::execute((int)$vrmakerspace->cmid, (int)$session->id);
    }

    /**
     * A session id of another activity is refused even for its owner.
     */
    public function test_session_of_other_activity_refused(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $owner, , , $session] = $this->setup_activity();
        $othercm = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $vrmakerspace->course]);
        $this->setUser($owner);

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('invalidsession', 'mod_vrmakerspace'));
        save_snapshot::execute((int)$othercm->cmid, (int)$session->id, base64_encode($this->valid_data()), 1);
    }

    /**
     * The teacher can read the state but not save.
     */
    public function test_teacher_reads_but_cannot_save(): void {
        $this->resetAfterTest();
        [$vrmakerspace, , , $teacher, $session] = $this->setup_activity();
        $this->setUser($teacher);

        $state = get_session_state::execute((int)$vrmakerspace->cmid, (int)$session->id);
        $this->assertFalse($state['cansculpt']);

        $this->expectException(\required_capability_exception::class);
        save_snapshot::execute((int)$vrmakerspace->cmid, (int)$session->id, base64_encode($this->valid_data()), 1);
    }

    /**
     * Data that is not strict base64 is refused.
     */
    public function test_bad_base64_refused(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $owner, , , $session] = $this->setup_activity();
        $this->setUser($owner);

        try {
            save_snapshot::execute((int)$vrmakerspace->cmid, (int)$session->id, 'not*base64!', 1);
            $this->fail('Bad base64 was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshotinvalid', $e->errorcode);
        }
    }

    /**
     * A file with a broken header is refused through the service too, and the opcount sent is not what
     * is stored: the header's sequence number is.
     */
    public function test_header_checked_and_seq_stored(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $owner, , , $session] = $this->setup_activity();
        $this->setUser($owner);
        $data = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')->snapshot_data('x', 33);

        try {
            save_snapshot::execute((int)$vrmakerspace->cmid, (int)$session->id, base64_encode(substr($data, 0, -1)), 33);
            $this->fail('A truncated file was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshotinvalid', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots'));

        $result = save_snapshot::execute((int)$vrmakerspace->cmid, (int)$session->id, base64_encode($data), 999);
        $this->assertSame(33, $result['opcount']);
    }

    /**
     * Group work reports its connection in the state.
     */
    public function test_state_reports_connection(): void {
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id,
            'workmode' => session_manager::MODE_GROUP, 'connectmode' => 'pair']);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $group = $this->getDataGenerator()->create_group(['courseid' => $course->id]);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $student->id]);
        $session = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')
            ->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'groupid' => $group->id]);
        $this->setUser($student);

        $state = external_api::clean_returnvalue(
            get_session_state::execute_returns(),
            get_session_state::execute((int)$vrmakerspace->cmid, (int)$session->id)
        );
        $this->assertSame('pair', $state['connection']);
        $this->assertTrue($state['cansculpt']);
    }
}
