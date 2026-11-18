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

namespace mod_vrmakerspace\completion;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/lib.php');
require_once($CFG->libdir . '/completionlib.php');

/**
 * Tests of the custom completion rule "Finish the tutorial".
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\completion\custom_completion::class)]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrmakerspace_get_coursemodule_info')]
#[\PHPUnit\Framework\Attributes\CoversFunction('mod_vrmakerspace_get_completion_active_rule_descriptions')]
final class custom_completion_test extends \advanced_testcase {
    /**
     * The rule is complete once the student's progress has a completion time.
     */
    public function test_get_state(): void {
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '', 'enablecompletion' => 1]);
        $vrmakerspace = $gen->create_module('vrmakerspace', ['course' => $course->id, 'tutorial' => 1,
            'completion' => COMPLETION_TRACKING_AUTOMATIC, 'completiontutorial' => 1]);
        $student = $gen->create_and_enrol($course, 'student');
        $cm = get_fast_modinfo($course)->get_cm($vrmakerspace->cmid);

        $this->assertSame(['completiontutorial' => 1], $cm->customdata['customcompletionrules']);
        $completion = new custom_completion($cm, (int)$student->id);
        $this->assertSame(['completiontutorial'], custom_completion::get_defined_custom_rules());
        $this->assertSame(COMPLETION_INCOMPLETE, $completion->get_state('completiontutorial'));

        $maker = $gen->get_plugin_generator('mod_vrmakerspace');
        $progress = $maker->create_tutorial_progress($vrmakerspace, (int)$student->id, ['welcome']);
        $this->assertSame(COMPLETION_INCOMPLETE, $completion->get_state('completiontutorial'));

        global $DB;
        $DB->set_field('vrmakerspace_tutorial', 'timecompleted', time(), ['id' => $progress->id]);
        $this->assertSame(COMPLETION_COMPLETE, $completion->get_state('completiontutorial'));
        $this->assertSame(
            ['completiontutorial' => get_string('completiondetail:tutorial', 'vrmakerspace')],
            $completion->get_custom_rule_descriptions()
        );
        $this->assertSame(
            [get_string('completiontutorial_desc', 'vrmakerspace')],
            mod_vrmakerspace_get_completion_active_rule_descriptions($cm)
        );
    }

    /**
     * Outside tutorial mode the rule is never active, and without automatic completion it is not cached.
     */
    public function test_rule_needs_tutorial_mode(): void {
        $this->resetAfterTest();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '', 'enablecompletion' => 1]);
        $plain = $gen->create_module('vrmakerspace', ['course' => $course->id, 'tutorial' => 0,
            'completion' => COMPLETION_TRACKING_AUTOMATIC, 'completionview' => 1, 'completiontutorial' => 1]);
        $manual = $gen->create_module('vrmakerspace', ['course' => $course->id, 'tutorial' => 1,
            'completion' => COMPLETION_TRACKING_MANUAL, 'completiontutorial' => 1]);
        $modinfo = get_fast_modinfo($course);

        $cm = $modinfo->get_cm($plain->cmid);
        $this->assertSame(['completiontutorial' => 0], $cm->customdata['customcompletionrules']);
        $this->assertSame([], mod_vrmakerspace_get_completion_active_rule_descriptions($cm));
        $this->assertArrayNotHasKey('customcompletionrules', (array)$modinfo->get_cm($manual->cmid)->customdata);
    }
}
