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

namespace mod_vrmakerspace\external;

use core_external\external_api;
use mod_vrmakerspace\local\tutorial;

/**
 * Tests of the save_tutorial_progress web service.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\save_tutorial_progress::class)]
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\event\tutorial_completed::class)]
final class save_tutorial_progress_test extends \core_external\tests\externallib_testcase {
    /**
     * A course with completion and a tutorial-mode activity that completes when the tutorial is finished.
     *
     * @param array $settings activity settings
     * @return array [\stdClass $course, \stdClass $vrmakerspace, \stdClass $student]
     */
    private function setup_activity(array $settings = []): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '', 'enablecompletion' => 1]);
        $vrmakerspace = $gen->create_module('vrmakerspace', $settings + [
            'course' => $course->id,
            'methods' => 'sculpt',
            'tutorial' => 1,
            'completion' => COMPLETION_TRACKING_AUTOMATIC,
            'completiontutorial' => 1,
        ]);
        $student = $gen->create_and_enrol($course, 'student');
        return [$course, $vrmakerspace, $student];
    }

    /**
     * Call the service and clean its result.
     *
     * @param \stdClass $vrmakerspace the activity
     * @param string $laststep the step
     * @param string[] $done steps done
     * @param string[] $skipped steps skipped
     * @return array
     */
    private function save(\stdClass $vrmakerspace, string $laststep, array $done, array $skipped = []): array {
        $result = save_tutorial_progress::execute((int)$vrmakerspace->cmid, $laststep, $done, $skipped);
        return external_api::clean_returnvalue(save_tutorial_progress::execute_returns(), $result);
    }

    /**
     * Progress is saved and merged; unknown and inapplicable keys are dropped.
     */
    public function test_saves_and_merges(): void {
        $this->resetAfterTest();
        [, $vrmakerspace, $student] = $this->setup_activity();
        $this->setUser($student);

        $result = $this->save($vrmakerspace, 'orbit', ['welcome', 'extrude', 'nope'], ['orbit']);
        $this->assertSame(['finished' => false, 'timecompleted' => 0], $result);
        $result = $this->save($vrmakerspace, 'zoom', ['orbit'], []);
        $this->assertFalse($result['finished']);

        $progress = tutorial::get_progress((int)$vrmakerspace->id, (int)$student->id);
        $this->assertSame('welcome,orbit', $progress->stepsdone);
        $this->assertSame('', $progress->stepsskipped);
        $this->assertSame('zoom', $progress->laststep);
    }

    /**
     * Finishing records the time once, triggers the event once and completes the activity.
     */
    public function test_finishing_completes(): void {
        global $CFG;
        require_once($CFG->libdir . '/completionlib.php');
        $this->resetAfterTest();
        [$course, $vrmakerspace, $student] = $this->setup_activity();
        $this->setUser($student);
        $steps = tutorial::applicable_steps('sculpt');
        $cm = get_fast_modinfo($course)->get_cm($vrmakerspace->cmid);
        $completion = new \completion_info($course);
        $this->assertSame(COMPLETION_INCOMPLETE, (int)$completion->get_data($cm, false, (int)$student->id)->completionstate);

        $sink = $this->redirectEvents();
        $result = $this->save($vrmakerspace, 'done', array_values(array_diff($steps, ['vr'])), ['vr']);
        $this->assertTrue($result['finished']);
        $this->assertGreaterThan(0, $result['timecompleted']);
        $events = array_values(array_filter(
            $sink->get_events(),
            fn($event) => $event instanceof \mod_vrmakerspace\event\tutorial_completed
        ));
        $this->assertCount(1, $events);
        $this->assertSame((int)$student->id, (int)$events[0]->relateduserid);
        $this->assertSame((int)$vrmakerspace->id, (int)$events[0]->other['vrmakerspaceid']);

        $again = $this->save($vrmakerspace, 'done', ['done'], []);
        $this->assertSame($result['timecompleted'], $again['timecompleted']);
        $count = count(array_filter(
            $sink->get_events(),
            fn($event) => $event instanceof \mod_vrmakerspace\event\tutorial_completed
        ));
        $this->assertSame(1, $count);
        $sink->close();

        $completion = new \completion_info($course);
        $cm = get_fast_modinfo($course, (int)$student->id)->get_cm($vrmakerspace->cmid);
        $this->assertSame(COMPLETION_COMPLETE, (int)$completion->get_data($cm, false, (int)$student->id)->completionstate);
    }

    /**
     * Refused for an activity that is not in tutorial mode.
     */
    public function test_refused_outside_tutorial_mode(): void {
        $this->resetAfterTest();
        [, $vrmakerspace, $student] = $this->setup_activity(['tutorial' => 0, 'completiontutorial' => 0]);
        $this->setUser($student);
        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('error_nottutorial', 'vrmakerspace'));
        save_tutorial_progress::execute((int)$vrmakerspace->cmid, 'welcome', ['welcome'], []);
    }

    /**
     * Refused for a user who is not in the course.
     */
    public function test_refused_not_enrolled(): void {
        $this->resetAfterTest();
        [, $vrmakerspace] = $this->setup_activity();
        $this->setUser($this->getDataGenerator()->create_user());
        $this->expectException(\require_login_exception::class);
        save_tutorial_progress::execute((int)$vrmakerspace->cmid, 'welcome', ['welcome'], []);
    }

    /**
     * Refused without the view capability (core then treats the activity as hidden from the student).
     */
    public function test_refused_without_capability(): void {
        global $DB;
        $this->resetAfterTest();
        [, $vrmakerspace, $student] = $this->setup_activity();
        $role = $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
        assign_capability('mod/vrmakerspace:view', CAP_PROHIBIT, $role, \context_module::instance($vrmakerspace->cmid));
        $this->setUser($student);
        $this->expectException(\require_login_exception::class);
        save_tutorial_progress::execute((int)$vrmakerspace->cmid, 'welcome', ['welcome'], []);
    }
}
