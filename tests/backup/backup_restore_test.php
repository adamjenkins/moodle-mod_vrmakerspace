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

namespace mod_vrmakerspace\backup;

use mod_vrmakerspace\local\grader;
use mod_vrmakerspace\local\session_manager;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/backup/util/includes/backup_includes.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');

/**
 * Backup and restore of an activity with its pieces, versions, files and grades.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\backup_vrmakerspace_activity_structure_step::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\restore_vrmakerspace_activity_structure_step::class)]
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
        $backupid = 'vrmakerspace-restore-' . $course->id;
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
     * Settings, a group piece with two versions and their files, a member's share, a grade and
     * another activity's uploaded starting model survive; live connections do not.
     */
    public function test_backup_restore_with_user_data(): void {
        global $DB, $USER;
        $this->resetAfterTest();
        $this->setAdminUser();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id, 'startmodel' => 'cube',
            'methods' => 'sculpt', 'workmode' => session_manager::MODE_GROUP, 'connectmode' => 'companion', 'maxusers' => 4,
            'trackcontributions' => 1]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $group = $this->getDataGenerator()->create_group(['courseid' => $course->id, 'name' => 'Otters']);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $student->id]);
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $session = $generator->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'groupid' => $group->id]);
        $generator->create_snapshot($session, (int)$student->id, 'first', 2);
        $generator->create_snapshot($session, (int)$student->id, 'second', 5);
        $generator->create_contribution($session, (int)$student->id, 17, 1234.5, 67.25);
        // Live connections are never backed up.
        $DB->insert_record('vrmakerspace_peers', (object)['sessionid' => $session->id, 'userid' => $student->id,
            'peerkey' => str_repeat('a', 32), 'role' => 'host', 'lastseen' => time(), 'timecreated' => time()]);
        grader::save_grade($vrmakerspace, (int)$student->id, 75.0, 2);
        // A second activity starts from an uploaded model.
        $draftid = file_get_unused_draft_itemid();
        get_file_storage()->create_file_from_string(['contextid' => \context_user::instance($USER->id)->id,
            'component' => 'user', 'filearea' => 'draft', 'itemid' => $draftid, 'filepath' => '/',
            'filename' => 'owl.obj'], "v 0 0 0\n");
        $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id, 'name' => 'Owl',
            'startmodel' => 'upload', 'startmodelfile' => $draftid]);
        // A third is modelled from a polygon cube, with a student's saved piece of clay and mesh.
        $modelled = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id, 'name' => 'Boxes',
            'methods' => 'model', 'startmodel' => 'meshcube']);
        $modelledsession = $generator->create_session(['vrmakerspaceid' => $modelled->id, 'userid' => $student->id]);
        $generator->create_snapshot($modelledsession, (int)$student->id, 'boxes', 3);

        $newcourseid = $this->backup_and_restore($course);

        $boxes = $DB->get_record('vrmakerspace', ['course' => $newcourseid, 'name' => 'Boxes'], '*', MUST_EXIST);
        $this->assertSame(['model', 'meshcube'], [$boxes->methods, $boxes->startmodel]);
        $boxessession = $DB->get_record('vrmakerspace_sessions', ['vrmakerspaceid' => $boxes->id], '*', MUST_EXIST);
        $this->assertSame('meshcube', $boxessession->startmodel);
        $boxescm = get_coursemodule_from_instance('vrmakerspace', $boxes->id, $newcourseid, false, MUST_EXIST);
        $boxesversions = array_values(session_manager::get_snapshots((int)$boxessession->id));
        $this->assertSame(
            $generator->snapshot_data('boxes', 3),
            session_manager::get_snapshot_file($boxesversions[0], \context_module::instance($boxescm->id))->get_content()
        );

        $owl = $DB->get_record('vrmakerspace', ['course' => $newcourseid, 'name' => 'Owl'], '*', MUST_EXIST);
        $this->assertSame('upload', $owl->startmodel);
        $owlcm = get_coursemodule_from_instance('vrmakerspace', $owl->id, $newcourseid, false, MUST_EXIST);
        $owlfile = session_manager::start_model_file(\context_module::instance($owlcm->id));
        $this->assertSame("v 0 0 0\n", $owlfile->get_content());

        $restored = $DB->get_record('vrmakerspace', ['course' => $newcourseid, 'startmodel' => 'cube'], '*', MUST_EXIST);
        $this->assertSame('cube', $restored->startmodel);
        $this->assertSame('sculpt', $restored->methods);
        $this->assertSame('companion', $restored->connectmode);
        $this->assertSame(4, (int)$restored->maxusers);
        $newsession = $DB->get_record('vrmakerspace_sessions', ['vrmakerspaceid' => $restored->id], '*', MUST_EXIST);
        $newgroup = $DB->get_record('groups', ['id' => $newsession->groupid], '*', MUST_EXIST);
        $this->assertSame((int)$newcourseid, (int)$newgroup->courseid);
        $this->assertSame('Otters', $newgroup->name);
        $contrib = $DB->get_record('vrmakerspace_contrib', ['sessionid' => $newsession->id], '*', MUST_EXIST);
        $this->assertSame((int)$student->id, (int)$contrib->userid);
        $this->assertSame(17, (int)$contrib->ops);
        $this->assertEquals(1234.5, (float)$contrib->added);
        $this->assertEquals(67.25, (float)$contrib->removed);
        $this->assertSame(0, $DB->count_records('vrmakerspace_peers', ['sessionid' => $newsession->id]));
        $snapshots = array_values(session_manager::get_snapshots((int)$newsession->id));
        $this->assertSame([1, 2], array_map(fn($s) => (int)$s->version, $snapshots));
        $cm = get_coursemodule_from_instance('vrmakerspace', $restored->id, $newcourseid, false, MUST_EXIST);
        $context = \context_module::instance($cm->id);
        $second = session_manager::get_snapshot_file($snapshots[1], $context)->get_content();
        $this->assertSame($generator->snapshot_data('second', 5), $second);
        $first = session_manager::get_snapshot_file($snapshots[0], $context)->get_content();
        $this->assertSame($generator->snapshot_data('first', 2), $first);
        $this->assertSame([2, 5], array_map(fn($s) => (int)$s->opcount, $snapshots));
        $grade = $DB->get_record('vrmakerspace_grades', ['vrmakerspaceid' => $restored->id], '*', MUST_EXIST);
        $this->assertEquals(75.0, (float)$grade->grade);
    }
}
