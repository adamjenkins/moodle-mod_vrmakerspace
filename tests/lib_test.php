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

namespace mod_vrmakerspace;

use mod_vrmakerspace\local\grader;
use mod_vrmakerspace\local\session_manager;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/lib.php');

/**
 * Tests of the lib.php callbacks: instance lifecycle and course reset.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversFunction('vrmakerspace_add_instance')]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrmakerspace_delete_instance')]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrmakerspace_reset_userdata')]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrmakerspace_clean_instance_data')]
final class lib_test extends \advanced_testcase {
    /**
     * Out-of-range settings are normalised on save.
     */
    public function test_settings_normalised(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', [
            'course' => $course->id,
            'startmodel' => 'teapot',
            'workmode' => 7,
            'maxusers' => 99,
        ]);
        $record = $DB->get_record('vrmakerspace', ['id' => $vrmakerspace->id]);
        $this->assertSame('lump', $record->startmodel);
        $this->assertSame(session_manager::MODE_INDIVIDUAL, (int)$record->workmode);
        $this->assertSame('pair', $record->connectmode);
        $this->assertSame(2, (int)$record->maxusers);
    }

    /**
     * The connection: pair forces two people; companion keeps 2..8; individual work is always pair;
     * an unknown value becomes pair.
     */
    public function test_connection_normalised(): void {
        $group = session_manager::MODE_GROUP;
        $clean = fn(array $data) => vrmakerspace_clean_instance_data((object)$data);

        $data = $clean(['workmode' => $group, 'connectmode' => 'pair', 'maxusers' => 6]);
        $this->assertSame(['pair', 2], [$data->connectmode, $data->maxusers]);
        $data = $clean(['workmode' => $group, 'connectmode' => 'companion', 'maxusers' => 6]);
        $this->assertSame(['companion', 6], [$data->connectmode, $data->maxusers]);
        $data = $clean(['workmode' => $group, 'connectmode' => 'companion', 'maxusers' => 99]);
        $this->assertSame(['companion', 8], [$data->connectmode, $data->maxusers]);
        $data = $clean(['workmode' => $group, 'connectmode' => 'telepathy', 'maxusers' => 6]);
        $this->assertSame(['pair', 2], [$data->connectmode, $data->maxusers]);
        $data = $clean(['workmode' => session_manager::MODE_INDIVIDUAL, 'connectmode' => 'companion', 'maxusers' => 6]);
        $this->assertSame('pair', $data->connectmode);
    }

    /**
     * Deleting the activity deletes its sculptures, versions, files, grades and grade item.
     */
    public function test_delete_instance_removes_everything(): void {
        global $DB, $CFG;
        require_once($CFG->libdir . '/gradelib.php');
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id]);
        $context = \context_module::instance($vrmakerspace->cmid);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $session = $generator->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $student->id]);
        $generator->create_snapshot($session, (int)$student->id);
        $generator->create_contribution($session, (int)$student->id, 3, 1.0, 1.0);
        $DB->insert_record('vrmakerspace_peers', (object)['sessionid' => $session->id, 'userid' => $student->id,
            'peerkey' => str_repeat('a', 32), 'role' => 'host', 'lastseen' => time(), 'timecreated' => time()]);
        $DB->insert_record('vrmakerspace_signals', (object)['sessionid' => $session->id, 'frompeerkey' => str_repeat('a', 32),
            'topeerkey' => str_repeat('b', 32), 'fromuserid' => $student->id, 'payload' => '{}', 'timecreated' => time()]);
        grader::save_grade($vrmakerspace, (int)$student->id, 50.0, 2);

        $this->assertTrue(vrmakerspace_delete_instance((int)$vrmakerspace->id));
        $this->assertSame(0, $DB->count_records('vrmakerspace_contrib'));
        $this->assertSame(0, $DB->count_records('vrmakerspace_peers'));
        $this->assertSame(0, $DB->count_records('vrmakerspace_signals'));

        $this->assertFalse($DB->record_exists('vrmakerspace', ['id' => $vrmakerspace->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_sessions'));
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots'));
        $this->assertSame(0, $DB->count_records('vrmakerspace_grades'));
        $this->assertSame([], get_file_storage()->get_area_files($context->id, 'mod_vrmakerspace', 'snapshots', false, 'id', false));
        $this->assertFalse(\grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'vrmakerspace',
            'iteminstance' => $vrmakerspace->id, 'courseid' => $course->id]));
    }

    /**
     * Course reset with the box ticked deletes the sculptures of every activity in the course only.
     */
    public function test_reset_userdata(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $othercourse = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id]);
        $othervrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $othercourse->id]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $resetsession = $generator->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $student->id]);
        $generator->create_snapshot($resetsession, (int)$student->id);
        $generator->create_contribution($resetsession, (int)$student->id, 3, 1.0, 1.0);
        $kept = $generator->create_session(['vrmakerspaceid' => $othervrmakerspace->id, 'userid' => $student->id]);
        grader::save_grade($vrmakerspace, (int)$student->id, 10.0, 2);

        $status = vrmakerspace_reset_userdata((object)['courseid' => $course->id, 'reset_vrmakerspace_sessions' => 1]);

        $this->assertCount(1, $status);
        $this->assertFalse($status[0]['error']);
        $this->assertSame(0, $DB->count_records('vrmakerspace_sessions', ['vrmakerspaceid' => $vrmakerspace->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_grades', ['vrmakerspaceid' => $vrmakerspace->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_contrib', ['sessionid' => $resetsession->id]));
        $this->assertTrue($DB->record_exists('vrmakerspace_sessions', ['id' => $kept->id]));
    }

    /**
     * Course reset with the box unticked keeps everything.
     */
    public function test_reset_userdata_unticked(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')
            ->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $student->id]);

        $this->assertSame([], vrmakerspace_reset_userdata((object)['courseid' => $course->id, 'reset_vrmakerspace_sessions' => 0]));
        $this->assertSame(1, $DB->count_records('vrmakerspace_sessions'));
    }
}
