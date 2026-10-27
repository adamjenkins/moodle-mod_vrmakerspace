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
 * Tests of the grading page helper: who is graded, saving, group grading and the template data.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\local\grading_helper::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrsculpt\local\view_helper::class)]
final class grading_helper_test extends \advanced_testcase {
    /**
     * The gradebook grade of a user.
     *
     * @param \stdClass $vrsculpt the activity
     * @param int $userid the user
     * @return float|null
     */
    private function gradebook_grade(\stdClass $vrsculpt, int $userid): ?float {
        global $CFG;
        require_once($CFG->libdir . '/gradelib.php');
        $grades = grade_get_grades($vrsculpt->course, 'mod', 'vrsculpt', $vrsculpt->id, $userid);
        $grade = $grades->items[0]->grades[$userid]->grade ?? null;
        return $grade === null ? null : (float)$grade;
    }

    /**
     * Individual work: each sculpture grades its owner; saving changes only what changed.
     */
    public function test_individual_grading(): void {
        global $DB;
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrsculpt = $gen->create_module('vrsculpt', ['course' => $course->id, 'grade' => 20]);
        $cm = get_fast_modinfo($course)->get_cm($vrsculpt->cmid);
        $context = \context_module::instance($cm->id);
        $one = $gen->create_and_enrol($course, 'student');
        $two = $gen->create_and_enrol($course, 'student');
        $teacher = $gen->create_and_enrol($course, 'editingteacher');
        $sculpt = $gen->get_plugin_generator('mod_vrsculpt');
        $s1 = $sculpt->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $one->id]);
        $s2 = $sculpt->create_session(['vrsculptid' => $vrsculpt->id, 'userid' => $two->id]);
        $sculpt->create_snapshot($s1, (int)$one->id);
        $this->setUser($teacher);

        $gradable = grading_helper::gradable($vrsculpt, $cm, $context);
        $this->assertSame([(int)$one->id], $gradable[(int)$s1->id]['userids']);
        $this->assertSame([(int)$two->id], $gradable[(int)$s2->id]['userids']);

        $result = grading_helper::save($vrsculpt, $gradable, [(int)$one->id => '15.5', (int)$two->id => ''], [], (int)$teacher->id);
        $this->assertSame(['saved' => 1, 'errors' => []], $result);
        $this->assertEquals(15.5, $this->gradebook_grade($vrsculpt, (int)$one->id));
        $this->assertFalse($DB->record_exists('vrsculpt_grades', ['userid' => $two->id]));

        // Unchanged: nothing saved. Out of range and not a number: errors, nothing saved.
        $result = grading_helper::save($vrsculpt, $gradable, [(int)$one->id => '15.50'], [], (int)$teacher->id);
        $this->assertSame(0, $result['saved']);
        $result = grading_helper::save(
            $vrsculpt,
            $gradable,
            [(int)$one->id => '25', (int)$two->id => 'abc'],
            [],
            (int)$teacher->id
        );
        $this->assertSame(0, $result['saved']);
        $this->assertSame([(int)$one->id, (int)$two->id], array_keys($result['errors']));
        $this->assertSame(get_string('gradeinvalid', 'vrsculpt'), $result['errors'][(int)$two->id]);
        $this->assertEquals(15.5, $this->gradebook_grade($vrsculpt, (int)$one->id));

        // A user not on the page is never graded.
        $outsider = $gen->create_and_enrol($course, 'student');
        grading_helper::save($vrsculpt, $gradable, [(int)$outsider->id => '10'], [], (int)$teacher->id);
        $this->assertFalse($DB->record_exists('vrsculpt_grades', ['userid' => $outsider->id]));

        // Emptying a field clears the grade.
        grading_helper::save($vrsculpt, $gradable, [(int)$one->id => ''], [], (int)$teacher->id);
        $this->assertNull($this->gradebook_grade($vrsculpt, (int)$one->id));

        $data = grading_helper::template_data($vrsculpt, $context, $gradable);
        $this->assertCount(2, $data['sculptures']);
        $this->assertSame('20.00', $data['maxgrade']);
        $this->assertTrue($data['sculptures'][0]['hasversion']);
        $this->assertStringContainsString('studio.php', $data['sculptures'][0]['viewurl']);
        $this->assertFalse($data['sculptures'][1]['hasversion']);
        $this->assertSame(get_string('gradefor', 'vrsculpt', fullname($one)), $data['sculptures'][0]['members'][0]['label']);
    }

    /**
     * Group work: every member who may sculpt is graded; the group field gives all of them the same
     * grade, overriding their own fields; contributions show when tracked.
     */
    public function test_group_grading(): void {
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrsculpt = $gen->create_module('vrsculpt', ['course' => $course->id, 'workmode' => session_manager::MODE_GROUP,
            'trackcontributions' => 1, 'grade' => 100]);
        $cm = get_fast_modinfo($course)->get_cm($vrsculpt->cmid);
        $context = \context_module::instance($cm->id);
        $teacher = $gen->create_and_enrol($course, 'editingteacher');
        $group = $gen->create_group(['courseid' => $course->id, 'name' => 'Otters']);
        $members = [];
        foreach ([1, 2, 3] as $n) {
            $members[$n] = $gen->create_and_enrol($course, 'student');
            $gen->create_group_member(['groupid' => $group->id, 'userid' => $members[$n]->id]);
        }
        // The teacher is in the group too, but cannot sculpt: not graded.
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $teacher->id]);
        $sculpt = $gen->get_plugin_generator('mod_vrsculpt');
        $session = $sculpt->create_session(['vrsculptid' => $vrsculpt->id, 'groupid' => $group->id]);
        $sculpt->create_contribution($session, (int)$members[1]->id, 30, 300.0, 0.0);
        $sculpt->create_contribution($session, (int)$members[2]->id, 10, 100.0, 0.0);
        $this->setUser($teacher);

        $gradable = grading_helper::gradable($vrsculpt, $cm, $context);
        $ids = array_map(fn($u) => (int)$u->id, $members);
        sort($ids);
        $this->assertSame($ids, $gradable[(int)$session->id]['userids']);

        $grades = [(int)$members[1]->id => '50', (int)$members[2]->id => '60', (int)$members[3]->id => ''];
        $result = grading_helper::save($vrsculpt, $gradable, $grades, [(int)$session->id => '80'], (int)$teacher->id);
        $this->assertSame(3, $result['saved']);
        foreach ($members as $member) {
            $this->assertEquals(80.0, $this->gradebook_grade($vrsculpt, (int)$member->id));
        }

        // Without the group field, each member's own field.
        grading_helper::save($vrsculpt, $gradable, [(int)$members[2]->id => '61'], [(int)$session->id => ''], (int)$teacher->id);
        $this->assertEquals(61.0, $this->gradebook_grade($vrsculpt, (int)$members[2]->id));
        $this->assertEquals(80.0, $this->gradebook_grade($vrsculpt, (int)$members[1]->id));

        $data = grading_helper::template_data($vrsculpt, $context, $gradable);
        $sculpture = $data['sculptures'][0];
        $this->assertTrue($sculpture['isgroup']);
        $this->assertSame('Otters', $sculpture['owner']);
        $this->assertSame(get_string('gradeallmembers', 'vrsculpt', 'Otters'), $sculpture['grouplabel']);
        $this->assertTrue($sculpture['hascontributions']);
        $this->assertSame(['75.0%', '25.0%'], array_column($sculpture['contributions'], 'share'));
        $this->assertTrue($sculpture['hasmanagelinks']);
        $this->assertSame(['close', 'reset'], array_column($sculpture['managelinks'], 'action'));
    }

    /**
     * Separate groups: a teacher without access to all groups sees only their groups' sculptures.
     */
    public function test_separate_groups(): void {
        global $DB;
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrsculpt = $gen->create_module(
            'vrsculpt',
            ['course' => $course->id, 'workmode' => session_manager::MODE_GROUP],
            ['groupmode' => SEPARATEGROUPS]
        );
        $cm = get_fast_modinfo($course)->get_cm($vrsculpt->cmid);
        $context = \context_module::instance($cm->id);
        $teacher = $gen->create_and_enrol($course, 'teacher');
        $mine = $gen->create_group(['courseid' => $course->id]);
        $theirs = $gen->create_group(['courseid' => $course->id]);
        $gen->create_group_member(['groupid' => $mine->id, 'userid' => $teacher->id]);
        $role = $DB->get_field('role', 'id', ['shortname' => 'teacher']);
        assign_capability('moodle/site:accessallgroups', CAP_PROHIBIT, $role, $context->id, true);
        accesslib_clear_all_caches_for_unit_testing();
        $sculpt = $gen->get_plugin_generator('mod_vrsculpt');
        $visible = $sculpt->create_session(['vrsculptid' => $vrsculpt->id, 'groupid' => $mine->id]);
        $sculpt->create_session(['vrsculptid' => $vrsculpt->id, 'groupid' => $theirs->id]);
        $this->setUser($teacher);
        $this->assertFalse(has_capability('moodle/site:accessallgroups', $context));

        $this->assertSame([(int)$visible->id], array_keys(grading_helper::gradable($vrsculpt, $cm, $context)));
    }
}
