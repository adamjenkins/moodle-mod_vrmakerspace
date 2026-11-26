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

use core_ai\aiactions\generate_text;
use core_ai\aiactions\responses\response_generate_text;
use core_external\external_api;
use mod_vrmakerspace\local\tutorial;
use mod_vrmakerspace\speech\chunker;
use mod_vrmakerspace\speech\registry;
use mod_vrmakerspace\tests\fake_speech_engine;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/tests/fixtures/fake_speech_engine.php');

/**
 * Tests of the ask_tutor web service, with the AI manager replaced by a stub.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\ask_tutor::class)]
final class ask_tutor_test extends \core_external\tests\externallib_testcase {
    /** @var generate_text|null the action the stub was given */
    private ?generate_text $sent = null;

    /**
     * Replace the AI manager: text generation available, answering with $answer (or failing).
     *
     * @param bool $available whether a provider offers text generation
     * @param string|null $answer the generated text, or null for a failed action
     * @return void
     */
    private function stub_ai(bool $available = true, ?string $answer = 'Hold the left button and drag on the clay.'): void {
        $manager = $this->getMockBuilder(\core_ai\manager::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['is_action_available', 'is_action_enabled_in_context', 'process_action'])
            ->getMock();
        $manager->method('is_action_available')->willReturn($available);
        $manager->method('is_action_enabled_in_context')->willReturn(true);
        $manager->method('process_action')->willReturnCallback(function ($action) use ($answer) {
            $this->sent = $action;
            if ($answer === null) {
                return new response_generate_text(success: false, errorcode: 500, error: 'failed', errormessage: 'Model offline');
            }
            $response = new response_generate_text(success: true);
            $response->set_response_data(['generatedcontent' => $answer]);
            return $response;
        });
        \core\di::set(\core_ai\manager::class, $manager);
    }

    /**
     * A tutorial-mode activity with the tutor on, and a student who accepted the AI policy.
     *
     * @param array $settings activity settings
     * @param bool $policy whether the student accepted the AI policy
     * @return array [\stdClass $vrmakerspace, \stdClass $student]
     */
    private function setup_activity(array $settings = [], bool $policy = true): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', $settings + [
            'course' => $course->id,
            'methods' => 'sculpt',
            'tutorial' => 1,
            'tutorai' => 1,
        ]);
        $student = $gen->create_and_enrol($course, 'student');
        if ($policy) {
            \core_ai\manager::user_policy_accepted((int)$student->id, \context_module::instance($vrmakerspace->cmid)->id);
        }
        $this->setUser($student);
        return [$vrmakerspace, $student];
    }

    /**
     * The question is sent with the tour as context, and the answer comes back as plain text.
     */
    public function test_answers(): void {
        $this->resetAfterTest();
        $this->stub_ai(true, 'Pick <b>Carve</b> and drag.<script>alert(1)</script>');
        [$vrmakerspace, $student] = $this->setup_activity();

        $result = ask_tutor::execute((int)$vrmakerspace->cmid, 'carve', '  How do I make a hole?  ');
        $result = external_api::clean_returnvalue(ask_tutor::execute_returns(), $result);

        $this->assertStringNotContainsString('<', $result['answer']);
        $this->assertStringContainsString('Carve', $result['answer']);
        $this->assertNotNull($this->sent);
        $this->assertSame((int)$student->id, $this->sent->get_configuration('userid'));
        $this->assertSame((int)\context_module::instance($vrmakerspace->cmid)->id, $this->sent->get_configuration('contextid'));
        $prompt = $this->sent->get_configuration('prompttext');
        $this->assertStringEndsWith('How do I make a hole?', $prompt);
        $this->assertSame(tutorial::build_prompt($vrmakerspace, 'carve', 'How do I make a hole?'), $prompt);
        // The AI is asked for JSON and told the demos of the activity's ways of making (sculpting only here).
        $this->assertStringContainsString(get_string('tutor_aipromptjson', 'vrmakerspace'), $prompt);
        $this->assertStringContainsString("\n- carve: ", $prompt);
        $this->assertStringNotContainsString("\n- extrude: ", $prompt);
        // A reply that is not JSON is the answer, with no demo and no audio.
        $this->assertSame('', $result['demo']);
        $this->assertSame(count(chunker::split($result['answer'])), $result['chunks']);
        $this->assertSame('', $result['audio']);
        $this->assertSame('', $result['mimetype']);
    }

    /**
     * The demo the AI names is given only when the activity has it; the answer is kept for tutor_speak.
     *
     * @param string $methods the activity's ways of making
     * @param string $reply what the AI generates
     * @param string $answer the expected answer
     * @param string $demo the expected demo
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('demo_provider')]
    public function test_demo(string $methods, string $reply, string $answer, string $demo): void {
        $this->resetAfterTest();
        $this->stub_ai(true, $reply);
        [$vrmakerspace, $student] = $this->setup_activity(['methods' => $methods]);

        $result = ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', 'How do I carve?');
        $result = external_api::clean_returnvalue(ask_tutor::execute_returns(), $result);

        $this->assertSame($answer, $result['answer']);
        $this->assertSame($demo, $result['demo']);
        $this->assertSame($answer, tutorial::latest_answer((int)$student->id, (int)$vrmakerspace->cmid));
    }

    /**
     * Replies with and without a demo the activity has.
     *
     * @return array
     */
    public static function demo_provider(): array {
        return [
            'JSON with a sculpting demo' => ['sculpt', '{"answer": "Watch me carve.", "demo": "carve"}',
                'Watch me carve.', 'carve'],
            'JSON in a code fence, with text around it' => ['both',
                "Sure!\n\x60\x60\x60json\n{\"answer\": \"I will show you.\", \"demo\": \"Extrude\"}\n\x60\x60\x60",
                'I will show you.', 'extrude'],
            'a sculpting demo in a modelling activity' => ['model', '{"answer": "Watch me carve.", "demo": "carve"}',
                'Watch me carve.', ''],
            'an unknown demo' => ['sculpt', '{"answer": "Like this.", "demo": "explode"}', 'Like this.', ''],
            'a step without a demo' => ['sculpt', '{"answer": "Press Undo.", "demo": "undo"}', 'Press Undo.', ''],
            'no demo' => ['sculpt', '{"answer": "Drag on the clay.", "demo": null}', 'Drag on the clay.', ''],
            'plain text' => ['sculpt', 'Drag on the **clay**.', 'Drag on the clay.', ''],
        ];
    }

    /**
     * With speak, and the tutor speaking, the first chunk of the answer comes back as audio.
     */
    public function test_speaks_first_chunk(): void {
        $this->resetAfterTest();
        $fake = fake_speech_engine::install();
        $first = 'You carve with the Carve tool, which takes clay away.';
        $this->stub_ai(true, json_encode(['answer' => $first . ' Drag it over the piece slowly.', 'demo' => 'carve']));
        [$vrmakerspace] = $this->setup_activity(['tutorspeak' => 1]);

        $result = ask_tutor::execute((int)$vrmakerspace->cmid, 'carve', 'How do I carve?', true);
        $result = external_api::clean_returnvalue(ask_tutor::execute_returns(), $result);

        $this->assertSame('carve', $result['demo']);
        $this->assertSame(2, $result['chunks']);
        $this->assertSame(base64_encode('AUDIO:' . $first), $result['audio']);
        $this->assertSame('audio/wav', $result['mimetype']);
        $this->assertSame([[$first, tutorial::speech_language(), '']], $fake->spoken);
    }

    /**
     * No audio without speak, with the tutor not speaking, or when the speech service fails; the answer
     * comes back all the same.
     */
    public function test_no_audio(): void {
        $this->resetAfterTest();
        $fake = fake_speech_engine::install();
        $this->stub_ai(true, '{"answer": "Drag on the clay.", "demo": null}');
        [$silent] = $this->setup_activity(['tutorspeak' => 0]);
        $result = ask_tutor::execute((int)$silent->cmid, 'add', 'How do I add clay?', true);
        $this->assertSame('', $result['audio']);

        [$speaking] = $this->setup_activity(['tutorspeak' => 1]);
        $result = ask_tutor::execute((int)$speaking->cmid, 'add', 'How do I add clay?', false);
        $this->assertSame('', $result['audio']);
        $this->assertSame([], $fake->spoken);

        $fake->fails = true;
        $result = ask_tutor::execute((int)$speaking->cmid, 'add', 'How do I add clay?', true);
        $this->assertSame('Drag on the clay.', $result['answer']);
        $this->assertSame('', $result['audio']);
        $this->assertCount(1, $fake->spoken);
    }

    #[\Override]
    protected function tearDown(): void {
        registry::set_engine(null, null);
        parent::tearDown();
    }

    /**
     * A failed action is reported calmly, and nobody is offered the Ask box for a while; the first answer clears it.
     */
    public function test_failure_reported(): void {
        $this->resetAfterTest();
        $this->stub_ai(true, null);
        [$vrmakerspace] = $this->setup_activity();
        try {
            ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', 'Hello?');
            $this->fail('A failed action must throw.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutoroffline', $e->errorcode);
        }
        $this->assertTrue(\mod_vrmakerspace\local\tutorial::ai_down());
        $this->assertFalse(\mod_vrmakerspace\local\tutorial::ai_available());
        $this->assertGreaterThan(0, \mod_vrmakerspace\local\tutorial::ai_down_since());
        \mod_vrmakerspace\local\tutorial::mark_ai_up();
        $this->assertFalse(\mod_vrmakerspace\local\tutorial::ai_down());
        $this->assertTrue(\mod_vrmakerspace\local\tutorial::ai_available());
    }

    /**
     * Refused when the activity is not in tutorial mode, the tutor is off, or there is no AI provider.
     *
     * @param array $settings activity settings
     * @param bool $available whether a provider offers text generation
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('not_available_provider')]
    public function test_refused_when_not_available(array $settings, bool $available): void {
        $this->resetAfterTest();
        $this->stub_ai($available);
        [$vrmakerspace] = $this->setup_activity($settings);
        try {
            ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', 'Hello?');
            $this->fail('The question was answered.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutornotavailable', $e->errorcode);
        }
        $this->assertNull($this->sent);
    }

    /**
     * Activities and sites where the tutor cannot answer.
     *
     * @return array
     */
    public static function not_available_provider(): array {
        return [
            'not tutorial mode' => [['tutorial' => 0], true],
            'tutor off' => [['tutorai' => 0], true],
            'no AI provider' => [[], false],
        ];
    }

    /**
     * Refused until the student has accepted the AI policy.
     */
    public function test_refused_without_policy(): void {
        $this->resetAfterTest();
        $this->stub_ai();
        [$vrmakerspace] = $this->setup_activity([], false);
        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('error_tutorpolicy', 'vrmakerspace'));
        ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', 'Hello?');
    }

    /**
     * Refused for an empty question and for one over 500 characters.
     *
     * @param string $question the question
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('bad_question_provider')]
    public function test_refused_question_length(string $question): void {
        $this->resetAfterTest();
        $this->stub_ai();
        [$vrmakerspace] = $this->setup_activity();
        try {
            ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', $question);
            $this->fail('The question was answered.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutorquestionlength', $e->errorcode);
        }
        $this->assertNull($this->sent);
    }

    /**
     * Questions that are too short or too long.
     *
     * @return array
     */
    public static function bad_question_provider(): array {
        return [
            'empty' => [''],
            'only spaces' => ['    '],
            'too long' => [str_repeat('a', tutorial::MAX_QUESTION_LENGTH + 1)],
        ];
    }

    /**
     * Refused after 20 questions in the last hour in this activity; older ones and other activities do not count.
     */
    public function test_refused_over_rate_limit(): void {
        global $DB;
        $this->resetAfterTest();
        $this->stub_ai();
        [$vrmakerspace, $student] = $this->setup_activity();
        $contextid = (int)\context_module::instance($vrmakerspace->cmid)->id;
        $row = fn(int $n, int $context, int $time) => (object)['actionname' => 'generate_text', 'actionid' => $n,
            'success' => 1, 'userid' => $student->id, 'contextid' => $context, 'provider' => 'aiprovider_test',
            'timecreated' => $time, 'timecompleted' => $time];
        for ($n = 1; $n < tutorial::RATE_LIMIT; $n++) {
            $DB->insert_record('ai_action_register', $row($n, $contextid, time() - 60));
        }
        $DB->insert_record('ai_action_register', $row(100, $contextid, time() - 2 * HOURSECS));
        $DB->insert_record('ai_action_register', $row(101, $contextid + 1000, time()));

        // The 20th question is still answered.
        ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', 'Hello?');
        $DB->insert_record('ai_action_register', $row(102, $contextid, time()));

        $this->sent = null;
        try {
            ask_tutor::execute((int)$vrmakerspace->cmid, 'welcome', 'Hello again?');
            $this->fail('The question was answered.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutorratelimit', $e->errorcode);
        }
        $this->assertNull($this->sent);
    }
}
