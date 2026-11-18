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
 * Tests of tutorial mode's steps, progress and prompt.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\tutorial::class)]
final class tutorial_test extends \advanced_testcase {
    /**
     * A tutorial-mode activity and a student.
     *
     * @param string $methods the ways of making
     * @param string $startmodel the starting model ('' for a lump, or the polygon cube for modelling only)
     * @return array [\stdClass $vrmakerspace, \stdClass $student]
     */
    private function make_activity(string $methods = 'both', string $startmodel = ''): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', ['course' => $course->id, 'tutorial' => 1, 'methods' => $methods,
            'startmodel' => $startmodel ?: ($methods === 'model' ? 'meshcube' : 'lump')]);
        $student = $gen->create_and_enrol($course, 'student');
        return [$vrmakerspace, $student];
    }

    /**
     * The steps follow the contract's order, and the ways of making choose the chapters.
     */
    public function test_applicable_steps(): void {
        $both = tutorial::applicable_steps('both');
        $this->assertSame(array_keys(tutorial::STEPS), $both);
        $this->assertCount(40, $both);
        $this->assertSame('welcome', $both[0]);
        $this->assertSame('done', end($both));
        $this->assertLessThan(array_search('switchmodel', $both), array_search('redo', $both));
        $this->assertLessThan(array_search('addshape', $both), array_search('switchmodel', $both));

        $sculpt = tutorial::applicable_steps('sculpt');
        $this->assertCount(25, $sculpt);
        $this->assertContains('carve', $sculpt);
        $this->assertContains('vr', $sculpt);
        foreach (['switchmodel', 'addshape', 'extrude', 'bake'] as $key) {
            $this->assertNotContains($key, $sculpt);
        }

        $model = tutorial::applicable_steps('model');
        $this->assertCount(23, $model);
        $this->assertContains('extrude', $model);
        foreach (['add', 'carve', 'undo', 'switchmodel', 'bake'] as $key) {
            $this->assertNotContains($key, $model);
        }

        // An unknown value is the default (both).
        $this->assertSame($both, tutorial::applicable_steps('teapot'));
    }

    /**
     * A tour that starts with a mesh teaches modelling first, then offers Turn into clay and the sculpting steps;
     * the switch to modelling is left out. Only both ways of making are reordered.
     */
    public function test_applicable_steps_model_first(): void {
        $steps = tutorial::applicable_steps('both', true);
        $this->assertCount(39, $steps);
        $this->assertNotContains('switchmodel', $steps);
        $this->assertSame(['welcome', 'orbit', 'zoom', 'pan', 'addshape'], array_slice($steps, 0, 5));
        $bake = array_search('bake', $steps);
        $this->assertSame('delete', $steps[$bake - 1]);
        $this->assertSame('add', $steps[$bake + 1]);
        $this->assertSame('redo', $steps[array_search('save', $steps) - 1]);
        $this->assertSame('done', end($steps));
        $this->assertEqualsCanonicalizing(array_diff(tutorial::applicable_steps('both'), ['switchmodel']), $steps);

        $this->assertSame(tutorial::applicable_steps('sculpt'), tutorial::applicable_steps('sculpt', true));
        $this->assertSame(tutorial::applicable_steps('model'), tutorial::applicable_steps('model', true));
    }

    /**
     * The studio opens with a mesh for modelling only, or both ways with the polygon cube to start from.
     */
    public function test_model_first(): void {
        $row = fn(string $methods, string $startmodel) => (object)['methods' => $methods, 'startmodel' => $startmodel];
        $this->assertTrue(tutorial::model_first($row('model', 'lump')));
        $this->assertTrue(tutorial::model_first($row('both', 'meshcube')));
        $this->assertFalse(tutorial::model_first($row('both', 'lump')));
        $this->assertFalse(tutorial::model_first($row('both', 'empty')));
        $this->assertFalse(tutorial::model_first($row('sculpt', 'lump')));
    }

    /**
     * A tour that starts with a mesh is finished without the switch to modelling, and the studio gets the
     * modelling steps first.
     */
    public function test_model_first_progress(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->make_activity('both', 'meshcube');
        $steps = tutorial::applicable_steps('both', true);
        $result = tutorial::save_progress($vrmakerspace, (int)$student->id, 'done', $steps, []);
        $this->assertTrue($result['finished']);
        $context = \context_module::instance((int)$vrmakerspace->cmid);
        $config = tutorial::studio_config($vrmakerspace, $context, (int)$student->id, false);
        $this->assertSame($steps, $config['steps']);
    }

    /**
     * Unknown keys are dropped, duplicates removed and the tour's order kept.
     */
    public function test_clean_and_split_keys(): void {
        $steps = tutorial::applicable_steps('sculpt');
        $this->assertSame(['welcome', 'carve'], tutorial::clean_keys(['carve', 'nonsense', 'extrude', 'welcome', 'carve'], $steps));
        $this->assertSame([], tutorial::split_keys(''));
        $this->assertSame([], tutorial::split_keys(null));
        $this->assertSame(['a', 'b'], tutorial::split_keys(' a, ,b,'));
    }

    /**
     * Saving merges and never removes; a step done after being skipped counts as done; unknown keys go.
     */
    public function test_save_progress_merges(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->make_activity();

        $result = tutorial::save_progress($vrmakerspace, (int)$student->id, 'zoom', ['welcome', 'bogus'], ['orbit']);
        $this->assertFalse($result['finished']);
        $this->assertFalse($result['newlyfinished']);
        $progress = tutorial::get_progress((int)$vrmakerspace->id, (int)$student->id);
        $this->assertSame('welcome', $progress->stepsdone);
        $this->assertSame('orbit', $progress->stepsskipped);
        $this->assertSame('zoom', $progress->laststep);
        $this->assertSame(0, (int)$progress->timecompleted);

        // Nothing sent removes nothing; an unknown last step keeps the stored one.
        tutorial::save_progress($vrmakerspace, (int)$student->id, 'nowhere', [], []);
        $progress = tutorial::get_progress((int)$vrmakerspace->id, (int)$student->id);
        $this->assertSame('welcome', $progress->stepsdone);
        $this->assertSame('zoom', $progress->laststep);

        tutorial::save_progress($vrmakerspace, (int)$student->id, 'pan', ['orbit', 'zoom'], []);
        $progress = tutorial::get_progress((int)$vrmakerspace->id, (int)$student->id);
        $this->assertSame('welcome,orbit,zoom', $progress->stepsdone);
        $this->assertSame('', $progress->stepsskipped);
        $this->assertSame(1, $this->count_rows());
    }

    /**
     * The tutorial is finished once every step is done or skipped; the time is recorded once.
     */
    public function test_finished(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->make_activity('model');
        $steps = tutorial::applicable_steps('model');

        $result = tutorial::save_progress($vrmakerspace, (int)$student->id, '', array_slice($steps, 0, 5), array_slice($steps, 5));
        $this->assertTrue($result['finished']);
        $this->assertTrue($result['newlyfinished']);
        $first = (int)$result['progress']->timecompleted;
        $this->assertGreaterThan(0, $first);

        $this->waitForSecond();
        $result = tutorial::save_progress($vrmakerspace, (int)$student->id, 'done', $steps, []);
        $this->assertTrue($result['finished']);
        $this->assertFalse($result['newlyfinished']);
        $this->assertSame($first, (int)$result['progress']->timecompleted);

        $this->assertTrue(tutorial::is_finished(['a', 'b'], ['a'], ['b']));
        $this->assertFalse(tutorial::is_finished(['a', 'b'], ['a'], []));
        $this->assertFalse(tutorial::is_finished([], [], []));
    }

    /**
     * The studio's configuration: only in tutorial mode, never read-only, with the stored progress.
     */
    public function test_studio_config(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->make_activity('sculpt');
        $context = \context_module::instance($vrmakerspace->cmid);
        $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace')
            ->create_tutorial_progress($vrmakerspace, (int)$student->id, ['welcome', 'extrude'], ['orbit', 'welcome'], 0, 'zoom');

        $config = tutorial::studio_config($vrmakerspace, $context, (int)$student->id, false);
        $this->assertTrue($config['enabled']);
        $this->assertSame(tutorial::applicable_steps('sculpt'), $config['steps']);
        $this->assertSame(['welcome'], $config['done']);
        $this->assertSame(['orbit'], $config['skipped']);
        $this->assertSame('zoom', $config['laststep']);
        $this->assertFalse($config['ai']);
        $this->assertFalse($config['aipolicy']);

        $this->assertNull(tutorial::studio_config($vrmakerspace, $context, (int)$student->id, true));
        $vrmakerspace->tutorial = 0;
        $this->assertNull(tutorial::studio_config($vrmakerspace, $context, (int)$student->id, false));
    }

    /**
     * The activity page's summary: not started, in progress, finished.
     */
    public function test_summary(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->make_activity('sculpt');
        $summary = tutorial::summary(null, 'sculpt');
        $this->assertFalse($summary['started']);
        $this->assertSame(get_string('tutorialnotstarted', 'vrmakerspace'), $summary['text']);

        $maker = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $progress = $maker->create_tutorial_progress($vrmakerspace, (int)$student->id, ['welcome', 'orbit'], ['zoom']);
        $summary = tutorial::summary($progress, 'sculpt');
        $this->assertTrue($summary['started']);
        $this->assertFalse($summary['finished']);
        $this->assertSame([2, 1, 25], [$summary['done'], $summary['skipped'], $summary['total']]);
        $this->assertSame(
            get_string('tutorialprogress', 'vrmakerspace', (object)['done' => 2, 'skipped' => 1, 'total' => 25]),
            $summary['text']
        );

        $progress->timecompleted = 1800000000;
        $summary = tutorial::summary($progress, 'sculpt');
        $this->assertTrue($summary['finished']);
        $this->assertSame(get_string('tutorialfinished', 'vrmakerspace', userdate(1800000000)), $summary['text']);
    }

    /**
     * The prompt: the instruction, every applicable step, the controls, the current step, the question last.
     */
    public function test_build_prompt(): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->make_activity('sculpt');
        $prompt = tutorial::build_prompt($vrmakerspace, 'carve', 'How do I make a hole?');

        $instruction = get_string('tutor_aiprompt', 'vrmakerspace', (object)[
            'name' => get_string_manager()->string_exists('tutor_name', 'vrmakerspace')
                ? get_string('tutor_name', 'vrmakerspace') : get_string('modulename', 'vrmakerspace'),
            'language' => get_string('thislanguage', 'langconfig'),
        ]);
        $this->assertStringStartsWith(strip_tags($instruction), strip_tags($prompt));
        $this->assertStringEndsWith('How do I make a hole?', $prompt);
        $this->assertStringContainsString(strip_tags(get_string('shortcuts', 'vrmakerspace')), $prompt);
        $this->assertStringContainsString(strip_tags(get_string('vrhelp', 'vrmakerspace')), $prompt);
        $this->assertStringNotContainsString('<', $prompt);
        if (get_string_manager()->string_exists('tutorial_step_carve_title', 'vrmakerspace')) {
            $this->assertStringContainsString(get_string('tutorial_step_carve_title', 'vrmakerspace'), $prompt);
            $this->assertStringNotContainsString(get_string('tutorial_step_extrude_title', 'vrmakerspace'), $prompt);
        }
    }

    /**
     * Deleting by activity and by user.
     */
    public function test_delete(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->make_activity();
        [$other, $otherstudent] = $this->make_activity();
        $maker = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $maker->create_tutorial_progress($vrmakerspace, (int)$student->id, ['welcome']);
        $maker->create_tutorial_progress($vrmakerspace, (int)$otherstudent->id, ['welcome']);
        $maker->create_tutorial_progress($other, (int)$otherstudent->id, ['welcome']);

        tutorial::delete_for_users((int)$vrmakerspace->id, [(int)$student->id]);
        $this->assertSame(2, $this->count_rows());
        $this->assertNull(tutorial::get_progress((int)$vrmakerspace->id, (int)$student->id));
        tutorial::delete_for_activity((int)$vrmakerspace->id);
        $this->assertSame(1, $this->count_rows());
        $this->assertNotNull(tutorial::get_progress((int)$other->id, (int)$otherstudent->id));
    }

    /**
     * The number of progress rows.
     *
     * @return int
     */
    private function count_rows(): int {
        global $DB;
        return $DB->count_records(tutorial::TABLE);
    }
}
