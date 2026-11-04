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

namespace mod_vrmakerspace\privacy;

use core_privacy\local\request\approved_contextlist;
use core_privacy\local\request\approved_userlist;
use core_privacy\local\request\userlist;
use core_privacy\local\request\writer;
use core_privacy\tests\provider_testcase;
use mod_vrmakerspace\local\grader;
use mod_vrmakerspace\local\session_manager;

/**
 * Tests of the privacy provider.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\privacy\provider::class)]
final class provider_test extends provider_testcase {
    /** @var \stdClass the course */
    private \stdClass $course;

    /** @var \stdClass individual-work activity */
    private \stdClass $solo;

    /** @var \stdClass group-work activity */
    private \stdClass $team;

    /** @var \stdClass student with an own piece and a version of the group's */
    private \stdClass $alice;

    /** @var \stdClass student with an own piece */
    private \stdClass $bob;

    /** @var \stdClass teacher who grades */
    private \stdClass $teacher;

    /** @var \stdClass alice's own session */
    private \stdClass $alicesession;

    /** @var \stdClass the group's session */
    private \stdClass $groupsession;

    /**
     * Two activities with pieces, versions and grades.
     */
    protected function setUp(): void {
        parent::setUp();
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $this->course = $gen->create_course(['summary' => '']);
        $this->solo = $gen->create_module('vrmakerspace', ['course' => $this->course->id]);
        $this->team = $gen->create_module('vrmakerspace', ['course' => $this->course->id,
            'workmode' => session_manager::MODE_GROUP]);
        $this->alice = $gen->create_and_enrol($this->course, 'student');
        $this->bob = $gen->create_and_enrol($this->course, 'student');
        $this->teacher = $gen->create_and_enrol($this->course, 'editingteacher');
        $group = $gen->create_group(['courseid' => $this->course->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $this->alice->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $this->bob->id]);

        $maker = $gen->get_plugin_generator('mod_vrmakerspace');
        $this->alicesession = $maker->create_session(['vrmakerspaceid' => $this->solo->id, 'userid' => $this->alice->id]);
        $maker->create_snapshot($this->alicesession, (int)$this->alice->id, 'alice');
        $bobsession = $maker->create_session(['vrmakerspaceid' => $this->solo->id, 'userid' => $this->bob->id]);
        $maker->create_snapshot($bobsession, (int)$this->bob->id, 'bob');
        $this->groupsession = $maker->create_session(['vrmakerspaceid' => $this->team->id, 'groupid' => $group->id]);
        $maker->create_snapshot($this->groupsession, (int)$this->alice->id, 'team1');
        $maker->create_snapshot($this->groupsession, (int)$this->bob->id, 'team2');
        grader::save_grade($this->solo, (int)$this->alice->id, 60.0, (int)$this->teacher->id);

        // Shares of the group's piece, and alice's live connection with a message to bob's.
        $maker->create_contribution($this->groupsession, (int)$this->alice->id, 12, 400.0, 100.0);
        $maker->create_contribution($this->groupsession, (int)$this->bob->id, 3, 50.0, 0.0);
        $this->add_peer($this->alice, 'a', 'host');
        $this->add_peer($this->bob, 'b', 'guest');
        global $DB;
        $DB->insert_record('vrmakerspace_signals', (object)['sessionid' => $this->groupsession->id,
            'frompeerkey' => str_repeat('a', 32), 'topeerkey' => str_repeat('b', 32), 'fromuserid' => $this->alice->id,
            'payload' => '{"type":"description"}', 'timecreated' => time()]);
        $DB->insert_record('vrmakerspace_signals', (object)['sessionid' => $this->groupsession->id,
            'frompeerkey' => str_repeat('b', 32), 'topeerkey' => str_repeat('c', 32), 'fromuserid' => $this->bob->id,
            'payload' => '{"type":"candidates"}', 'timecreated' => time()]);
    }

    /**
     * A live connection to the group's piece.
     *
     * @param \stdClass $user the user
     * @param string $char the character the peer key repeats
     * @param string $role host or guest
     * @return void
     */
    private function add_peer(\stdClass $user, string $char, string $role): void {
        global $DB;
        $DB->insert_record('vrmakerspace_peers', (object)['sessionid' => $this->groupsession->id, 'userid' => $user->id,
            'peerkey' => str_repeat($char, 32), 'role' => $role, 'lastseen' => time(), 'timecreated' => time()]);
    }

    /**
     * Every table is described.
     */
    public function test_get_metadata(): void {
        $collection = provider::get_metadata(new \core_privacy\local\metadata\collection('mod_vrmakerspace'));
        $names = array_map(fn($item) => $item->get_name(), $collection->get_collection());
        $this->assertEqualsCanonicalizing(
            ['vrmakerspace_sessions', 'vrmakerspace_snapshots', 'vrmakerspace_grades', 'vrmakerspace_contrib', 'vrmakerspace_peers',
                'vrmakerspace_signals', 'core_files', 'pairpartner', 'vrroomsync'],
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
        $userlist = new userlist(\context_module::instance($this->solo->cmid), 'mod_vrmakerspace');
        provider::get_users_in_context($userlist);
        $this->assertEqualsCanonicalizing(
            [(int)$this->alice->id, (int)$this->bob->id, (int)$this->teacher->id],
            array_map('intval', $userlist->get_userids())
        );
        $userlist = new userlist(\context_module::instance($this->team->cmid), 'mod_vrmakerspace');
        provider::get_users_in_context($userlist);
        $this->assertEqualsCanonicalizing(
            [(int)$this->alice->id, (int)$this->bob->id],
            array_map('intval', $userlist->get_userids())
        );
    }

    /**
     * Export: alice's own piece with its file, only her version of the group's, and her grade.
     */
    public function test_export_user_data(): void {
        $solo = \context_module::instance($this->solo->cmid);
        $team = \context_module::instance($this->team->cmid);
        $this->export_context_data_for_user((int)$this->alice->id, $solo, 'mod_vrmakerspace');
        $this->export_context_data_for_user((int)$this->alice->id, $team, 'mod_vrmakerspace');

        $data = writer::with_context($solo)->get_data();
        $this->assertCount(1, $data->pieces);
        $this->assertSame((int)$this->alicesession->id, $data->pieces[0]->piece);
        $this->assertEquals('60.00', $data->grade);
        $path = [get_string('privacy:path:sculpture', 'mod_vrmakerspace', (int)$this->alicesession->id)];
        $this->assertNotEmpty(writer::with_context($solo)->get_files($path));

        $data = writer::with_context($team)->get_data();
        $this->assertCount(1, $data->pieces);
        $this->assertCount(1, $data->pieces[0]->versions);
        $this->assertSame(1, $data->pieces[0]->versions[0]->version);
        $this->assertSame(12, $data->pieces[0]->contribution->operations);
        $this->assertCount(1, $data->pieces[0]->connections);
        $this->assertSame('host', $data->pieces[0]->connections[0]->role);
        $this->assertCount(1, $data->pieces[0]->connectionmessages);
        $this->assertSame('{"type":"description"}', $data->pieces[0]->connectionmessages[0]->message);
    }

    /**
     * A user whose only data is a share or a connection is still found and exported.
     */
    public function test_live_data_only_user(): void {
        global $DB;
        $carol = $this->getDataGenerator()->create_and_enrol($this->course, 'student');
        $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')
            ->create_contribution($this->groupsession, (int)$carol->id, 1, 1.0, 0.0);
        $team = \context_module::instance($this->team->cmid);

        $this->assertEquals([$team->id], array_map('intval', provider::get_contexts_for_userid((int)$carol->id)->get_contextids()));
        $userlist = new userlist($team, 'mod_vrmakerspace');
        provider::get_users_in_context($userlist);
        $this->assertContains((int)$carol->id, array_map('intval', $userlist->get_userids()));

        $this->export_context_data_for_user((int)$carol->id, $team, 'mod_vrmakerspace');
        $data = writer::with_context($team)->get_data();
        $this->assertSame([], $data->pieces[0]->versions);
        $this->assertSame(1, $data->pieces[0]->contribution->operations);
        $DB->delete_records('vrmakerspace_contrib', ['userid' => $carol->id]);
        $this->assertSame([], provider::get_contexts_for_userid((int)$carol->id)->get_contextids());
    }

    /**
     * Deleting alice: her own piece and grade go, her group versions are anonymised, bob's stay.
     */
    public function test_delete_data_for_user(): void {
        global $DB;
        $solo = \context_module::instance($this->solo->cmid);
        $team = \context_module::instance($this->team->cmid);
        provider::delete_data_for_user(new approved_contextlist($this->alice, 'mod_vrmakerspace', [$solo->id, $team->id]));

        $this->assertFalse($DB->record_exists('vrmakerspace_sessions', ['id' => $this->alicesession->id]));
        $this->assertFalse($DB->record_exists('vrmakerspace_grades', ['userid' => $this->alice->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots', ['userid' => $this->alice->id]));
        $this->assertSame(2, $DB->count_records('vrmakerspace_snapshots', ['sessionid' => $this->groupsession->id]));
        $bobs = ['vrmakerspaceid' => $this->solo->id, 'userid' => $this->bob->id];
        $this->assertTrue($DB->record_exists('vrmakerspace_sessions', $bobs));
        $this->assertFalse($DB->record_exists('vrmakerspace_contrib', ['userid' => $this->alice->id]));
        $this->assertFalse($DB->record_exists('vrmakerspace_peers', ['userid' => $this->alice->id]));
        $this->assertFalse($DB->record_exists('vrmakerspace_signals', ['fromuserid' => $this->alice->id]));
        $this->assertTrue($DB->record_exists('vrmakerspace_contrib', ['userid' => $this->bob->id]));
        $this->assertTrue($DB->record_exists('vrmakerspace_peers', ['userid' => $this->bob->id]));
        $this->assertTrue($DB->record_exists('vrmakerspace_signals', ['fromuserid' => $this->bob->id]));
        $itemids = array_map(
            fn($f) => (int)$f->get_itemid(),
            get_file_storage()->get_area_files($solo->id, 'mod_vrmakerspace', 'snapshots', false, 'id', false)
        );
        $this->assertCount(1, $itemids);
    }

    /**
     * Deleting a list of users (the teacher) clears the grader without deleting the grade.
     */
    public function test_delete_data_for_users_grader(): void {
        global $DB;
        $solo = \context_module::instance($this->solo->cmid);
        provider::delete_data_for_users(new approved_userlist($solo, 'mod_vrmakerspace', [(int)$this->teacher->id]));
        $grade = $DB->get_record('vrmakerspace_grades', ['userid' => $this->alice->id], '*', MUST_EXIST);
        $this->assertSame(0, (int)$grade->grader);
    }

    /**
     * Deleting everyone in a context leaves the other activity alone.
     */
    public function test_delete_data_for_all_users_in_context(): void {
        global $DB;
        $solo = \context_module::instance($this->solo->cmid);
        provider::delete_data_for_all_users_in_context($solo);
        $this->assertSame(0, $DB->count_records('vrmakerspace_sessions', ['vrmakerspaceid' => $this->solo->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_grades', ['vrmakerspaceid' => $this->solo->id]));
        $this->assertSame([], get_file_storage()->get_area_files($solo->id, 'mod_vrmakerspace', 'snapshots', false, 'id', false));
        $this->assertSame(2, $DB->count_records('vrmakerspace_snapshots', ['sessionid' => $this->groupsession->id]));
        $this->assertSame(2, $DB->count_records('vrmakerspace_contrib'));

        $team = \context_module::instance($this->team->cmid);
        provider::delete_data_for_all_users_in_context($team);
        foreach (['vrmakerspace_contrib', 'vrmakerspace_peers', 'vrmakerspace_signals', 'vrmakerspace_sessions'] as $table) {
            $this->assertSame(0, $DB->count_records($table), $table);
        }
    }
}
