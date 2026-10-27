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
     * Settings, a group sculpture with two versions and their files, a member's share and a grade
     * survive; live connections do not.
     */
    public function test_backup_restore_with_user_data(): void {
        global $DB;
        $this->resetAfterTest();
        $this->setAdminUser();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $course->id, 'startmodel' => 'cube',
            'workmode' => session_manager::MODE_GROUP, 'connectmode' => 'companion', 'maxusers' => 4,
            'trackcontributions' => 1]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $group = $this->getDataGenerator()->create_group(['courseid' => $course->id, 'name' => 'Otters']);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $student->id]);
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt');
        $session = $generator->create_session(['vrsculptid' => $vrsculpt->id, 'groupid' => $group->id]);
        $generator->create_snapshot($session, (int)$student->id, 'first', 2);
        $generator->create_snapshot($session, (int)$student->id, 'second', 5);
        $generator->create_contribution($session, (int)$student->id, 17, 1234.5, 67.25);
        // Live connections are never backed up.
        $DB->insert_record('vrsculpt_peers', (object)['sessionid' => $session->id, 'userid' => $student->id,
            'peerkey' => str_repeat('a', 32), 'role' => 'host', 'lastseen' => time(), 'timecreated' => time()]);
        grader::save_grade($vrsculpt, (int)$student->id, 75.0, 2);

        $newcourseid = $this->backup_and_restore($course);

        $restored = $DB->get_record('vrsculpt', ['course' => $newcourseid], '*', MUST_EXIST);
        $this->assertSame('cube', $restored->startmodel);
        $this->assertSame('companion', $restored->connectmode);
        $this->assertSame(4, (int)$restored->maxusers);
        $newsession = $DB->get_record('vrsculpt_sessions', ['vrsculptid' => $restored->id], '*', MUST_EXIST);
        $newgroup = $DB->get_record('groups', ['id' => $newsession->groupid], '*', MUST_EXIST);
        $this->assertSame((int)$newcourseid, (int)$newgroup->courseid);
        $this->assertSame('Otters', $newgroup->name);
        $contrib = $DB->get_record('vrsculpt_contrib', ['sessionid' => $newsession->id], '*', MUST_EXIST);
        $this->assertSame((int)$student->id, (int)$contrib->userid);
        $this->assertSame(17, (int)$contrib->ops);
        $this->assertEquals(1234.5, (float)$contrib->added);
        $this->assertEquals(67.25, (float)$contrib->removed);
        $this->assertSame(0, $DB->count_records('vrsculpt_peers', ['sessionid' => $newsession->id]));
        $snapshots = array_values(session_manager::get_snapshots((int)$newsession->id));
        $this->assertSame([1, 2], array_map(fn($s) => (int)$s->version, $snapshots));
        $cm = get_coursemodule_from_instance('vrsculpt', $restored->id, $newcourseid, false, MUST_EXIST);
        $context = \context_module::instance($cm->id);
        $second = session_manager::get_snapshot_file($snapshots[1], $context)->get_content();
        $this->assertSame($generator->snapshot_data('second', 5), $second);
        $first = session_manager::get_snapshot_file($snapshots[0], $context)->get_content();
        $this->assertSame($generator->snapshot_data('first', 2), $first);
        $this->assertSame([2, 5], array_map(fn($s) => (int)$s->opcount, $snapshots));
        $grade = $DB->get_record('vrsculpt_grades', ['vrsculptid' => $restored->id], '*', MUST_EXIST);
        $this->assertEquals(75.0, (float)$grade->grade);
    }
}
