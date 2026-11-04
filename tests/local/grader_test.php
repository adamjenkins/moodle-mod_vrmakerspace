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

namespace mod_vrmakerspace\local;

/**
 * Tests of grading and the gradebook.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\grader::class)]
final class grader_test extends \advanced_testcase {
    /**
     * The gradebook grade of a user.
     *
     * @param \stdClass $vrmakerspace the activity
     * @param int $userid the user
     * @return float|null
     */
    private function gradebook_grade(\stdClass $vrmakerspace, int $userid): ?float {
        global $CFG;
        require_once($CFG->libdir . '/gradelib.php');
        $grades = grade_get_grades($vrmakerspace->course, 'mod', 'vrmakerspace', $vrmakerspace->id, $userid);
        $grade = $grades->items[0]->grades[$userid]->grade ?? null;
        return $grade === null ? null : (float)$grade;
    }

    /**
     * Creating an activity creates a points grade item with its maximum.
     */
    public function test_grade_item_created(): void {
        global $CFG;
        require_once($CFG->libdir . '/gradelib.php');
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id, 'grade' => 40]);

        $item = \grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'vrmakerspace', 'iteminstance' => $vrmakerspace->id,
            'courseid' => $course->id]);
        $this->assertSame(GRADE_TYPE_VALUE, (int)$item->gradetype);
        $this->assertEquals(40, (float)$item->grademax);
    }

    /**
     * A saved grade reaches the gradebook; a changed one replaces it; null clears it.
     */
    public function test_save_grade_reaches_gradebook(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id, 'grade' => 50]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $teacher = $this->getDataGenerator()->create_and_enrol($course, 'editingteacher');

        grader::save_grade($vrmakerspace, (int)$student->id, 42.5, (int)$teacher->id);
        $this->assertEquals(42.5, $this->gradebook_grade($vrmakerspace, (int)$student->id));

        grader::save_grade($vrmakerspace, (int)$student->id, 30.0, (int)$teacher->id);
        $this->assertEquals(30.0, $this->gradebook_grade($vrmakerspace, (int)$student->id));
        $this->assertSame(1, $DB->count_records('vrmakerspace_grades', ['vrmakerspaceid' => $vrmakerspace->id]));

        grader::save_grade($vrmakerspace, (int)$student->id, null, (int)$teacher->id);
        $this->assertNull($this->gradebook_grade($vrmakerspace, (int)$student->id));
    }

    /**
     * A grade above the maximum is refused and not stored.
     */
    public function test_save_grade_refuses_out_of_range(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id, 'grade' => 10]);
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');

        try {
            grader::save_grade($vrmakerspace, (int)$student->id, 10.5, 2);
            $this->fail('An out-of-range grade was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('gradeoutofrange', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrmakerspace_grades'));
    }

    /**
     * get_user_grades returns one user's or everyone's grades in grade_update() form.
     */
    public function test_get_user_grades(): void {
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', ['course' => $course->id]);
        $one = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $two = $this->getDataGenerator()->create_and_enrol($course, 'student');
        grader::save_grade($vrmakerspace, (int)$one->id, 70.0, 2);
        grader::save_grade($vrmakerspace, (int)$two->id, 80.0, 2);

        $all = grader::get_user_grades($vrmakerspace);
        $this->assertEqualsCanonicalizing([(int)$one->id, (int)$two->id], array_keys($all));
        $mine = grader::get_user_grades($vrmakerspace, (int)$two->id);
        $this->assertSame([(int)$two->id], array_keys($mine));
        $this->assertEquals(80.0, $mine[(int)$two->id]->rawgrade);
    }
}
