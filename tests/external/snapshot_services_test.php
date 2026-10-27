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
use mod_vrsculpt\local\session_manager;

/**
 * Tests of the save_snapshot and get_session_state web services.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\save_snapshot::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\get_session_state::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\external\helper::class)]
final class snapshot_services_test extends \core_external\tests\externallib_testcase {
    /**
     * A course with an activity, two students and a teacher.
     *
     * @return array [\stdClass $vrsculpt, \stdClass $owner, \stdClass $other, \stdClass $teacher, \stdClass $session]
     */
    private function setup_activity(): array {
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $course->id]);
        $owner = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $other = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $teacher = $this->getDataGenerator()->create_and_enrol($course, 'editingteacher');
        $session = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt')
            ->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $owner->id]);
        return [$vrsculpt, $owner, $other, $teacher, $session];
    }

    /**
     * The owner saves a version; the returned state and the stored file agree.
     */
    public function test_owner_saves(): void {
        $this->resetAfterTest();
        [$vrsculpt, $owner, , , $session] = $this->setup_activity();
        $this->setUser($owner);

        $result = save_snapshot::execute((int)$vrsculpt->cmid, (int)$session->id, base64_encode('VRSC data'), 12);
        $result = external_api::clean_returnvalue(save_snapshot::execute_returns(), $result);

        $this->assertSame(1, $result['version']);
        $this->assertSame(12, $result['opcount']);
        $this->assertTrue($result['cansculpt']);
        $snapshot = session_manager::get_latest_snapshot((int)$session->id);
        $this->assertSame('VRSC data', session_manager::get_snapshot_file(
            $snapshot,
            \context_module::instance($vrsculpt->cmid)
        )->get_content());

        $state = external_api::clean_returnvalue(
            get_session_state::execute_returns(),
            get_session_state::execute((int)$vrsculpt->cmid, (int)$session->id)
        );
        $this->assertSame(1, $state['version']);
        $this->assertStringContainsString('/mod_vrsculpt/snapshots/' . $snapshot->id . '/', $state['url']);
    }

    /**
     * Another student cannot save into, or read, someone else's sculpture.
     */
    public function test_other_student_refused(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrsculpt, , $other, , $session] = $this->setup_activity();
        $this->setUser($other);

        try {
            save_snapshot::execute((int)$vrsculpt->cmid, (int)$session->id, base64_encode('VRSC data'), 1);
            $this->fail('A student saved into another student\'s sculpture');
        } catch (\moodle_exception $e) {
            $this->assertSame('cannotsculpt', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrsculpt_snapshots'));

        $this->expectException(\required_capability_exception::class);
        get_session_state::execute((int)$vrsculpt->cmid, (int)$session->id);
    }

    /**
     * A session id of another activity is refused even for its owner.
     */
    public function test_session_of_other_activity_refused(): void {
        $this->resetAfterTest();
        [$vrsculpt, $owner, , , $session] = $this->setup_activity();
        $othercm = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $vrsculpt->course]);
        $this->setUser($owner);

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('invalidsession', 'mod_vrsculpt'));
        save_snapshot::execute((int)$othercm->cmid, (int)$session->id, base64_encode('VRSC data'), 1);
    }

    /**
     * The teacher can read the state but not save.
     */
    public function test_teacher_reads_but_cannot_save(): void {
        $this->resetAfterTest();
        [$vrsculpt, , , $teacher, $session] = $this->setup_activity();
        $this->setUser($teacher);

        $state = get_session_state::execute((int)$vrsculpt->cmid, (int)$session->id);
        $this->assertFalse($state['cansculpt']);

        $this->expectException(\required_capability_exception::class);
        save_snapshot::execute((int)$vrsculpt->cmid, (int)$session->id, base64_encode('VRSC data'), 1);
    }

    /**
     * Data that is not strict base64 is refused.
     */
    public function test_bad_base64_refused(): void {
        $this->resetAfterTest();
        [$vrsculpt, $owner, , , $session] = $this->setup_activity();
        $this->setUser($owner);

        try {
            save_snapshot::execute((int)$vrsculpt->cmid, (int)$session->id, 'not*base64!', 1);
            $this->fail('Bad base64 was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshotinvalid', $e->errorcode);
        }
    }
}
