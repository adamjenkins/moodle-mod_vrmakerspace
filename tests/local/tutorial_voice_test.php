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

use mod_vrmakerspace\speech\registry;
use mod_vrmakerspace\tests\fake_speech_engine;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/tests/fixtures/fake_speech_engine.php');

/**
 * Tests of the tutor's demos, the reading of the AI's answer and the voice configuration.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\tutorial::class)]
final class tutorial_voice_test extends \advanced_testcase {
    /**
     * Every demo belongs to a step, and an activity has the demos of its ways of making only.
     */
    public function test_applicable_demos(): void {
        foreach (tutorial::DEMOS as $step => $demo) {
            $this->assertArrayHasKey($step, tutorial::STEPS);
            $this->assertMatchesRegularExpression('/^[a-z]+$/', $demo);
        }
        $sculpt = tutorial::applicable_demos('sculpt');
        $model = tutorial::applicable_demos('model');
        $this->assertContains('carve', $sculpt);
        $this->assertNotContains('extrude', $sculpt);
        $this->assertContains('extrude', $model);
        $this->assertNotContains('carve', $model);
        $this->assertSame(array_values(array_unique(array_merge($sculpt, $model))), tutorial::applicable_demos('both'));
        $this->assertSame(array_values(tutorial::DEMOS), tutorial::applicable_demos('both'));
    }

    /**
     * The AI's reply is read leniently, and the demo is kept only when the activity has it.
     *
     * @param string $reply the generated text
     * @param string $answer the expected answer
     * @param string $demo the expected demo
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('parse_provider')]
    public function test_parse_answer(string $reply, string $answer, string $demo): void {
        $this->assertSame(['answer' => $answer, 'demo' => $demo], tutorial::parse_answer($reply, ['carve', 'add']));
    }

    /**
     * Replies and how they are read.
     *
     * @return array
     */
    public static function parse_provider(): array {
        return [
            'JSON' => ['{"answer": "Watch me.", "demo": "carve"}', 'Watch me.', 'carve'],
            'JSON, demo in capitals with spaces' => ['{"answer": "Watch me.", "demo": " Carve "}', 'Watch me.', 'carve'],
            'JSON in a code fence' => [
                "\x60\x60\x60json\n{\"answer\": \"Watch me.\", \"demo\": \"add\"}\n\x60\x60\x60",
                'Watch me.',
                'add',
            ],
            'JSON after a sentence' => ['Here you go: {"answer": "Watch me.", "demo": "add"} Enjoy!', 'Watch me.', 'add'],
            'a demo the activity does not have' => ['{"answer": "Watch me.", "demo": "extrude"}', 'Watch me.', ''],
            'an invented demo' => ['{"answer": "Watch me.", "demo": "explode"}', 'Watch me.', ''],
            'demo null' => ['{"answer": "Drag on the clay.", "demo": null}', 'Drag on the clay.', ''],
            'demo not a string' => ['{"answer": "Drag on the clay.", "demo": ["carve"]}', 'Drag on the clay.', ''],
            'no demo key' => ['{"answer": "Drag on the clay."}', 'Drag on the clay.', ''],
            'broken JSON' => ['{"answer": "Drag on the \"clay\".", "demo": "carve"', 'Drag on the "clay".', 'carve'],
            'plain text' => ['Drag on the clay.', 'Drag on the clay.', ''],
            'markdown and tags' => ['{"answer": "**Drag** on the <b>clay</b>.\n- then let go"}',
                'Drag on the clay. then let go', ''],
            'an answer that is not text' => ['{"answer": {"text": "x"}, "demo": "carve"}', '', 'carve'],
        ];
    }

    /**
     * A step is spoken as its title and its text; an unknown key gives nothing.
     */
    public function test_step_speech(): void {
        $text = tutorial::step_speech('carve');
        $title = trim(strip_tags(get_string('tutorial_step_carve_title', 'vrmakerspace')));
        $this->assertStringStartsWith($title, $text);
        $this->assertStringNotContainsString('<', $text);
        $this->assertSame('', tutorial::step_speech('nonsense'));
        $this->assertSame('', tutorial::step_speech('tutor_name'));
    }

    /**
     * The voice configuration follows the activity's switches and the site's speech order.
     */
    public function test_voice_config(): void {
        $this->resetAfterTest();
        fake_speech_engine::install();
        set_config('speakorder2', registry::BROWSER, 'mod_vrmakerspace');
        set_config('browserstt', 0, 'mod_vrmakerspace');
        set_config('ollamavoice', 'male', 'mod_vrmakerspace');
        $user = $this->getDataGenerator()->create_user();

        $both = (object)['tutorial' => 1, 'tutorlisten' => 1, 'tutorspeak' => 1];
        $config = tutorial::voice_config($both, (int)$user->id);
        $this->assertSame(['server'], $config['listen']);
        $this->assertSame(['server', 'browser'], $config['speak']);
        $this->assertSame(tutorial::speech_language(), $config['language']);
        $this->assertSame('male', $config['voicename']);
        $this->assertFalse($config['browserstt']);
        $this->assertFalse($config['cloudconsent']);

        set_user_preference(tutorial::CONSENT_PREFERENCE, 1, $user);
        $off = (object)['tutorial' => 1, 'tutorlisten' => 0, 'tutorspeak' => 0];
        $config = tutorial::voice_config($off, (int)$user->id);
        $this->assertSame([], $config['listen']);
        $this->assertSame([], $config['speak']);
        $this->assertTrue($config['cloudconsent']);

        $nottutorial = (object)['tutorial' => 0, 'tutorlisten' => 1, 'tutorspeak' => 1];
        $config = tutorial::voice_config($nottutorial, (int)$user->id);
        $this->assertSame([], $config['listen']);
        $this->assertSame([], $config['speak']);
    }

    /**
     * The prompt asks for JSON, lists the activity's demos, and still ends with the question.
     */
    public function test_prompt_lists_demos(): void {
        $prompt = tutorial::build_prompt((object)['methods' => 'model'], 'extrude', 'How do I extrude?');
        $this->assertStringContainsString(get_string('tutor_aipromptjson', 'vrmakerspace'), $prompt);
        $this->assertStringContainsString("\n- extrude: ", $prompt);
        $this->assertStringContainsString("\n- addshape: ", $prompt);
        $this->assertStringNotContainsString("\n- carve: ", $prompt);
        $this->assertStringEndsWith('How do I extrude?', $prompt);
    }

    #[\Override]
    protected function tearDown(): void {
        registry::set_engine(null, null);
        parent::tearDown();
    }
}
