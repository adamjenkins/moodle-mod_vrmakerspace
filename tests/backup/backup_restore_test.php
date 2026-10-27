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

namespace mod_vrsculpt\backup;

use mod_vrsculpt\local\grader;
use mod_vrsculpt\local\session_manager;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/backup/util/includes/backup_includes.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');

/**
 * Backup and restore of an activity with its sculptures, versions, files and grades.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\backup_vrsculpt_activity_structure_step::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\restore_vrsculpt_activity_structure_step::class)]
final class backup_restore_test extends \advanced_testcase {
    /**
     * Back up a course with user data and restore it as a new course.
     *
     * @param \stdClass $course the course
     * @return int the new course id
     */
    private function backup_and_restore(\stdClass $course): int {
        global $CFG, $USER;
        $bc = new \backup_controller(
            \backup::TYPE_1COURSE,
            $course->id,
            \backup::FORMAT_MOODLE,
            \backup::INTERACTIVE_NO,
            \backup::MODE_GENERAL,
            $USER->id
        );
        $bc->get_plan()->get_setting('users')->set_status(\backup_setting::NOT_LOCKED);
        $bc->get_plan()->get_setting('users')->set_value(true);
        $bc->execute_plan();
        // A general backup is a .mbz file: unpack it for the restore controller, as core's tests do.
        $backupid = 'vrsculpt-restore-' . $course->id;
        $bc->get_results()['backup_destination']->extract_to_pathname(
            get_file_packer('application/vnd.moodle.backup'),
            $CFG->tempdir . '/backup/' . $backupid
        );
        $bc->destroy();

        $newcourseid = \restore_dbops::create_new_course(
            $course->fullname . ' copy',
            $course->shortname . '_copy',
            $course->category
        );
        $rc = new \restore_controller(
            $backupid,
            $newcourseid,
            \backup::INTERACTIVE_NO,
            \backup::MODE_GENERAL,
            $USER->id,
            \backup::TARGET_NEW_COURSE
        );
        $rc->get_plan()->get_setting('users')->set_status(\backup_setting::NOT_LOCKED);
        $rc->get_plan()->get_setting('users')->set_value(true);
        $this->assertTrue($rc->execute_precheck());
        $rc->execute_plan();
        $rc->destroy();
        return (int)$newcourseid;
    }

    /**
     * Settings, a sculpture with two versions and their files, and a grade survive.
     */
    public function test_backup_restore_with_user_data(): void {
        global $DB;
        $this->resetAfterTest();
        $this->setAdminUser();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $course->id, 'startmodel' => 'cube',
            'maxusers' => 4]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt');
        $session = $generator->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $student->id]);
        $generator->create_snapshot($session, (int)$student->id, 'first', 2);
        $generator->create_snapshot($session, (int)$student->id, 'second', 5);
        grader::save_grade($vrsculpt, (int)$student->id, 75.0, 2);

        $newcourseid = $this->backup_and_restore($course);

        $restored = $DB->get_record('vrsculpt', ['course' => $newcourseid], '*', MUST_EXIST);
        $this->assertSame('cube', $restored->startmodel);
        $this->assertSame(4, (int)$restored->maxusers);
        $newsession = $DB->get_record('vrsculpt_sessions', ['vrsculptid' => $restored->id], '*', MUST_EXIST);
        $this->assertSame((int)$student->id, (int)$newsession->userid);
        $snapshots = array_values(session_manager::get_snapshots((int)$newsession->id));
        $this->assertSame([1, 2], array_map(fn($s) => (int)$s->version, $snapshots));
        $cm = get_coursemodule_from_instance('vrsculpt', $restored->id, $newcourseid, false, MUST_EXIST);
        $context = \context_module::instance($cm->id);
        $this->assertSame('VRSCsecond', session_manager::get_snapshot_file($snapshots[1], $context)->get_content());
        $this->assertSame('VRSCfirst', session_manager::get_snapshot_file($snapshots[0], $context)->get_content());
        $grade = $DB->get_record('vrsculpt_grades', ['vrsculptid' => $restored->id], '*', MUST_EXIST);
        $this->assertEquals(75.0, (float)$grade->grade);
    }
}
