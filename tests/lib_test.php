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

namespace mod_vrsculpt;

use mod_vrsculpt\local\grader;
use mod_vrsculpt\local\session_manager;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrsculpt/lib.php');

/**
 * Tests of the lib.php callbacks: instance lifecycle and course reset.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversFunction('vrsculpt_add_instance')]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrsculpt_delete_instance')]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrsculpt_reset_userdata')]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrsculpt_clean_instance_data')]
final class lib_test extends \advanced_testcase {
    /**
     * Out-of-range settings are normalised on save.
     */
    public function test_settings_normalised(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', [
            'course' => $course->id,
            'startmodel' => 'teapot',
            'workmode' => 7,
            'maxusers' => 99,
        ]);
        $record = $DB->get_record('vrsculpt', ['id' => $vrsculpt->id]);
        $this->assertSame('lump', $record->startmodel);
        $this->assertSame(session_manager::MODE_INDIVIDUAL, (int)$record->workmode);
        $this->assertSame(8, (int)$record->maxusers);
    }

    /**
     * Deleting the activity deletes its sculptures, versions, files, grades and grade item.
     */
    public function test_delete_instance_removes_everything(): void {
        global $DB, $CFG;
        require_once($CFG->libdir . '/gradelib.php');
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $course->id]);
        $context = \context_module::instance($vrsculpt->cmid);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt');
        $session = $generator->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $student->id]);
        $generator->create_snapshot($session, (int)$student->id);
        grader::save_grade($vrsculpt, (int)$student->id, 50.0, 2);

        $this->assertTrue(vrsculpt_delete_instance((int)$vrsculpt->id));

        $this->assertFalse($DB->record_exists('vrsculpt', ['id' => $vrsculpt->id]));
        $this->assertSame(0, $DB->count_records('vrsculpt_sessions'));
        $this->assertSame(0, $DB->count_records('vrsculpt_snapshots'));
        $this->assertSame(0, $DB->count_records('vrsculpt_grades'));
        $this->assertSame([], get_file_storage()->get_area_files($context->id, 'mod_vrsculpt', 'snapshots', false, 'id', false));
        $this->assertFalse(\grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'vrsculpt',
            'iteminstance' => $vrsculpt->id, 'courseid' => $course->id]));
    }

    /**
     * Course reset with the box ticked deletes the sculptures of every activity in the course only.
     */
    public function test_reset_userdata(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $othercourse = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $course->id]);
        $othervrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $othercourse->id]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt');
        $generator->create_snapshot(
            $generator->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $student->id]),
            (int)$student->id
        );
        $kept = $generator->create_session(['vrsculptid' => $othervrsculpt->id, 'userid' => $student->id]);
        grader::save_grade($vrsculpt, (int)$student->id, 10.0, 2);

        $status = vrsculpt_reset_userdata((object)['courseid' => $course->id, 'reset_vrsculpt_sessions' => 1]);

        $this->assertCount(1, $status);
        $this->assertFalse($status[0]['error']);
        $this->assertSame(0, $DB->count_records('vrsculpt_sessions', ['vrsculptid' => $vrsculpt->id]));
        $this->assertSame(0, $DB->count_records('vrsculpt_grades', ['vrsculptid' => $vrsculpt->id]));
        $this->assertTrue($DB->record_exists('vrsculpt_sessions', ['id' => $kept->id]));
    }

    /**
     * Course reset with the box unticked keeps everything.
     */
    public function test_reset_userdata_unticked(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', ['course' => $course->id]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt')
            ->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $student->id]);

        $this->assertSame([], vrsculpt_reset_userdata((object)['courseid' => $course->id, 'reset_vrsculpt_sessions' => 0]));
        $this->assertSame(1, $DB->count_records('vrsculpt_sessions'));
    }
}
