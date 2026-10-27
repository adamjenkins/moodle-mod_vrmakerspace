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

namespace mod_vrsculpt\local;

/**
 * Tests of the sculpture and version data layer.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\local\session_manager::class)]
final class session_manager_test extends \advanced_testcase {
    /**
     * A course with an activity and its context.
     *
     * @param int $workmode session_manager::MODE_*
     * @return array [\stdClass $course, \stdClass $vrsculpt, \cm_info $cm, \context_module $context]
     */
    private function make_activity(int $workmode = session_manager::MODE_INDIVIDUAL): array {
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrsculpt = $this->getDataGenerator()->create_module('vrsculpt', [
            'course' => $course->id,
            'workmode' => $workmode,
            'startmodel' => 'sphere',
        ]);
        $cm = get_fast_modinfo($course)->get_cm($vrsculpt->cmid);
        return [$course, $vrsculpt, $cm, \context_module::instance($cm->id)];
    }

    /**
     * Individual work: one session per user, created once, with the activity's starting model.
     */
    public function test_individual_session_created_once(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrsculpt, $cm] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');

        $first = session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$user->id);
        $second = session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$user->id);

        $this->assertEquals($first->id, $second->id);
        $this->assertSame(0, (int)$first->groupid);
        $this->assertSame((int)$user->id, (int)$first->userid);
        $this->assertSame('sphere', $first->startmodel);
        $this->assertSame(1, $DB->count_records('vrsculpt_sessions', ['vrsculptid' => $vrsculpt->id]));
    }

    /**
     * Group work: the group's session for members, none for a user outside every group or a foreign group.
     */
    public function test_group_session_needs_membership(): void {
        $this->resetAfterTest();
        [$course, $vrsculpt, $cm] = $this->make_activity(session_manager::MODE_GROUP);
        $member = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $other = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $outsider = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $group = $this->getDataGenerator()->create_group(['courseid' => $course->id]);
        $othergroup = $this->getDataGenerator()->create_group(['courseid' => $course->id]);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $member->id]);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $other->id]);

        $session = session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$member->id);
        $this->assertSame((int)$group->id, (int)$session->groupid);
        $this->assertSame(0, (int)$session->userid);
        $this->assertEquals($session->id, session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$other->id)->id);

        $this->assertNull(session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$outsider->id));
        $this->assertNull(session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$member->id, (int)$othergroup->id));
    }

    /**
     * A session id of another activity is refused.
     */
    public function test_get_session_refuses_other_activity(): void {
        $this->resetAfterTest();
        [$course, $vrsculpt] = $this->make_activity();
        [, $othervrsculpt] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($othervrsculpt, 0, (int)$user->id);

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('invalidsession', 'mod_vrsculpt'));
        session_manager::get_session((int)$session->id, $vrsculpt);
    }

    /**
     * Who may view and sculpt: owners sculpt while open, teachers only view, other students neither.
     */
    public function test_access_rules(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrsculpt, , $context] = $this->make_activity();
        $owner = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $teacher = $this->getDataGenerator()->create_and_enrol($course, 'editingteacher');
        $session = session_manager::get_or_create($vrsculpt, 0, (int)$owner->id);

        $this->assertTrue(session_manager::can_view($session, $context, (int)$owner->id));
        $this->assertTrue(session_manager::can_sculpt($session, $context, (int)$owner->id));
        $this->assertFalse(session_manager::can_view($session, $context, (int)$student->id));
        $this->assertFalse(session_manager::can_sculpt($session, $context, (int)$student->id));
        $this->assertTrue(session_manager::can_view($session, $context, (int)$teacher->id));
        $this->assertFalse(session_manager::can_sculpt($session, $context, (int)$teacher->id));

        $DB->set_field('vrsculpt_sessions', 'status', session_manager::STATUS_CLOSED, ['id' => $session->id]);
        $session = $DB->get_record('vrsculpt_sessions', ['id' => $session->id]);
        $this->assertTrue(session_manager::can_view($session, $context, (int)$owner->id));
        $this->assertFalse(session_manager::can_sculpt($session, $context, (int)$owner->id));
    }

    /**
     * Saving numbers the versions and stores each as a file holding exactly the bytes sent.
     */
    public function test_save_snapshot_versions_and_files(): void {
        $this->resetAfterTest();
        [$course, $vrsculpt, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrsculpt, 0, (int)$user->id);

        $first = session_manager::save_snapshot($session, $context, (int)$user->id, 'VRSC one', 3);
        $second = session_manager::save_snapshot($session, $context, (int)$user->id, 'VRSC two', 7);

        $this->assertSame(1, (int)$first->version);
        $this->assertSame(2, (int)$second->version);
        $this->assertSame('VRSC two', session_manager::get_snapshot_file($second, $context)->get_content());
        $this->assertSame('VRSC one', session_manager::get_snapshot_file($first, $context)->get_content());
        $this->assertSame(7, (int)session_manager::get_latest_snapshot((int)$session->id)->opcount);
        $this->assertSame([1, 2], array_map(
            fn($s) => (int)$s->version,
            array_values(session_manager::get_snapshots((int)$session->id))
        ));
    }

    /**
     * Data without the magic number is refused, and nothing is stored.
     */
    public function test_save_snapshot_refuses_foreign_data(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrsculpt, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrsculpt, 0, (int)$user->id);

        try {
            session_manager::save_snapshot($session, $context, (int)$user->id, '<html>not a sculpture</html>', 1);
            $this->fail('Foreign data was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshotinvalid', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrsculpt_snapshots'));
    }

    /**
     * Data over the size limit is refused, and nothing is stored.
     */
    public function test_save_snapshot_refuses_oversize(): void {
        global $DB;
        $this->resetAfterTest();
        set_config('maxsnapshotsize', 16, 'mod_vrsculpt');
        [$course, $vrsculpt, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrsculpt, 0, (int)$user->id);

        try {
            session_manager::save_snapshot($session, $context, (int)$user->id, 'VRSC' . str_repeat('x', 13), 1);
            $this->fail('Oversize data was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshottoolarge', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrsculpt_snapshots'));
        // Exactly at the limit is accepted.
        session_manager::save_snapshot($session, $context, (int)$user->id, 'VRSC' . str_repeat('x', 12), 1);
        $this->assertSame(1, $DB->count_records('vrsculpt_snapshots'));
    }

    /**
     * Deleting sessions removes their versions and files and leaves other sessions alone.
     */
    public function test_delete_sessions(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrsculpt, , $context] = $this->make_activity();
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrsculpt');
        $one = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $two = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $s1 = $generator->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $one->id]);
        $s2 = $generator->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $two->id]);
        $generator->create_snapshot($s1, (int)$one->id);
        $kept = $generator->create_snapshot($s2, (int)$two->id);

        session_manager::delete_sessions([$s1], $context);

        $this->assertFalse($DB->record_exists('vrsculpt_sessions', ['id' => $s1->id]));
        $this->assertSame(0, $DB->count_records('vrsculpt_snapshots', ['sessionid' => $s1->id]));
        $files = get_file_storage()->get_area_files(
            $context->id,
            'mod_vrsculpt',
            session_manager::FILEAREA,
            false,
            'itemid',
            false
        );
        $this->assertSame([(int)$kept->id], array_values(array_map(fn($f) => (int)$f->get_itemid(), $files)));
    }
}
