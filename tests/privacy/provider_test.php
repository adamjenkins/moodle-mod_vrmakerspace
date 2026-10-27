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

namespace mod_vrsculpt\privacy;

use core_privacy\local\request\approved_contextlist;
use core_privacy\local\request\approved_userlist;
use core_privacy\local\request\userlist;
use core_privacy\local\request\writer;
use core_privacy\tests\provider_testcase;
use mod_vrsculpt\local\grader;
use mod_vrsculpt\local\session_manager;

/**
 * Tests of the privacy provider.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\privacy\provider::class)]
final class provider_test extends provider_testcase {
    /** @var \stdClass the course */
    private \stdClass $course;

    /** @var \stdClass individual-work activity */
    private \stdClass $solo;

    /** @var \stdClass group-work activity */
    private \stdClass $team;

    /** @var \stdClass student with an own sculpture and a version of the group's */
    private \stdClass $alice;

    /** @var \stdClass student with an own sculpture */
    private \stdClass $bob;

    /** @var \stdClass teacher who grades */
    private \stdClass $teacher;

    /** @var \stdClass alice's own session */
    private \stdClass $alicesession;

    /** @var \stdClass the group's session */
    private \stdClass $groupsession;

    /**
     * Two activities with sculptures, versions and grades.
     */
    protected function setUp(): void {
        parent::setUp();
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $this->course = $gen->create_course(['summary' => '']);
        $this->solo = $gen->create_module('vrsculpt', ['course' => $this->course->id]);
        $this->team = $gen->create_module('vrsculpt', ['course' => $this->course->id,
            'workmode' => session_manager::MODE_GROUP]);
        $this->alice = $gen->create_and_enrol($this->course, 'student');
        $this->bob = $gen->create_and_enrol($this->course, 'student');
        $this->teacher = $gen->create_and_enrol($this->course, 'editingteacher');
        $group = $gen->create_group(['courseid' => $this->course->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $this->alice->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $this->bob->id]);

        $sculpt = $gen->get_plugin_generator('mod_vrsculpt');
        $this->alicesession = $sculpt->create_session(['vrsculptid' => $this->solo->id, 'userid' => $this->alice->id]);
        $sculpt->create_snapshot($this->alicesession, (int)$this->alice->id, 'alice');
        $bobsession = $sculpt->create_session(['vrsculptid' => $this->solo->id, 'userid' => $this->bob->id]);
        $sculpt->create_snapshot($bobsession, (int)$this->bob->id, 'bob');
        $this->groupsession = $sculpt->create_session(['vrsculptid' => $this->team->id, 'groupid' => $group->id]);
        $sculpt->create_snapshot($this->groupsession, (int)$this->alice->id, 'team1');
        $sculpt->create_snapshot($this->groupsession, (int)$this->bob->id, 'team2');
        grader::save_grade($this->solo, (int)$this->alice->id, 60.0, (int)$this->teacher->id);
    }

    /**
     * Every table is described.
     */
    public function test_get_metadata(): void {
        $collection = provider::get_metadata(new \core_privacy\local\metadata\collection('mod_vrsculpt'));
        $names = array_map(fn($item) => $item->get_name(), $collection->get_collection());
        $this->assertEqualsCanonicalizing(
            ['vrsculpt_sessions', 'vrsculpt_snapshots', 'vrsculpt_grades', 'core_files'],
            $names
        );
    }

    /**
     * Contexts: both activities for alice, the graded activity for the teacher.
     */
    public function test_get_contexts_for_userid(): void {
        $solo = \context_module::instance($this->solo->cmid);
        $team = \context_module::instance($this->team->cmid);
        $this->assertEqualsCanonicalizing(
            [$solo->id, $team->id],
            array_map('intval', provider::get_contexts_for_userid((int)$this->alice->id)->get_contextids())
        );
        $this->assertEquals(
            [$solo->id],
            array_map('intval', provider::get_contexts_for_userid((int)$this->teacher->id)->get_contextids())
        );
    }

    /**
     * Users in a context: owners, version authors, graded users and graders.
     */
    public function test_get_users_in_context(): void {
        $userlist = new userlist(\context_module::instance($this->solo->cmid), 'mod_vrsculpt');
        provider::get_users_in_context($userlist);
        $this->assertEqualsCanonicalizing(
            [(int)$this->alice->id, (int)$this->bob->id, (int)$this->teacher->id],
            array_map('intval', $userlist->get_userids())
        );
        $userlist = new userlist(\context_module::instance($this->team->cmid), 'mod_vrsculpt');
        provider::get_users_in_context($userlist);
        $this->assertEqualsCanonicalizing(
            [(int)$this->alice->id, (int)$this->bob->id],
            array_map('intval', $userlist->get_userids())
        );
    }

    /**
     * Export: alice's own sculpture with its file, only her version of the group's, and her grade.
     */
    public function test_export_user_data(): void {
        $solo = \context_module::instance($this->solo->cmid);
        $team = \context_module::instance($this->team->cmid);
        $this->export_context_data_for_user((int)$this->alice->id, $solo, 'mod_vrsculpt');
        $this->export_context_data_for_user((int)$this->alice->id, $team, 'mod_vrsculpt');

        $data = writer::with_context($solo)->get_data();
        $this->assertCount(1, $data->sculptures);
        $this->assertSame((int)$this->alicesession->id, $data->sculptures[0]->sculpture);
        $this->assertEquals('60.00', $data->grade);
        $path = [get_string('privacy:path:sculpture', 'mod_vrsculpt', (int)$this->alicesession->id)];
        $this->assertNotEmpty(writer::with_context($solo)->get_files($path));

        $data = writer::with_context($team)->get_data();
        $this->assertCount(1, $data->sculptures);
        $this->assertCount(1, $data->sculptures[0]->versions);
        $this->assertSame(1, $data->sculptures[0]->versions[0]->version);
    }

    /**
     * Deleting alice: her own sculpture and grade go, her group versions are anonymised, bob's stay.
     */
    public function test_delete_data_for_user(): void {
        global $DB;
        $solo = \context_module::instance($this->solo->cmid);
        $team = \context_module::instance($this->team->cmid);
        provider::delete_data_for_user(new approved_contextlist($this->alice, 'mod_vrsculpt', [$solo->id, $team->id]));

        $this->assertFalse($DB->record_exists('vrsculpt_sessions', ['id' => $this->alicesession->id]));
        $this->assertFalse($DB->record_exists('vrsculpt_grades', ['userid' => $this->alice->id]));
        $this->assertSame(0, $DB->count_records('vrsculpt_snapshots', ['userid' => $this->alice->id]));
        $this->assertSame(2, $DB->count_records('vrsculpt_snapshots', ['sessionid' => $this->groupsession->id]));
        $this->assertTrue($DB->record_exists('vrsculpt_sessions', ['vrsculptid' => $this->solo->id, 'userid' => $this->bob->id]));
        $itemids = array_map(
            fn($f) => (int)$f->get_itemid(),
            get_file_storage()->get_area_files($solo->id, 'mod_vrsculpt', 'snapshots', false, 'id', false)
        );
        $this->assertCount(1, $itemids);
    }

    /**
     * Deleting a list of users (the teacher) clears the grader without deleting the grade.
     */
    public function test_delete_data_for_users_grader(): void {
        global $DB;
        $solo = \context_module::instance($this->solo->cmid);
        provider::delete_data_for_users(new approved_userlist($solo, 'mod_vrsculpt', [(int)$this->teacher->id]));
        $grade = $DB->get_record('vrsculpt_grades', ['userid' => $this->alice->id], '*', MUST_EXIST);
        $this->assertSame(0, (int)$grade->grader);
    }

    /**
     * Deleting everyone in a context leaves the other activity alone.
     */
    public function test_delete_data_for_all_users_in_context(): void {
        global $DB;
        $solo = \context_module::instance($this->solo->cmid);
        provider::delete_data_for_all_users_in_context($solo);
        $this->assertSame(0, $DB->count_records('vrsculpt_sessions', ['vrsculptid' => $this->solo->id]));
        $this->assertSame(0, $DB->count_records('vrsculpt_grades', ['vrsculptid' => $this->solo->id]));
        $this->assertSame([], get_file_storage()->get_area_files($solo->id, 'mod_vrsculpt', 'snapshots', false, 'id', false));
        $this->assertSame(2, $DB->count_records('vrsculpt_snapshots', ['sessionid' => $this->groupsession->id]));
    }
}
