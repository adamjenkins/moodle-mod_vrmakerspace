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
use mod_vrmakerspace\speech\chunker;
use mod_vrmakerspace\speech\rate_limiter;
use mod_vrmakerspace\speech\registry;
use mod_vrmakerspace\tests\fake_speech_engine;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/tests/fixtures/fake_speech_engine.php');

/**
 * Tests of the tutor_speak web service, with the speech engine replaced through the registry's test hook.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\tutor_speak::class)]
final class tutor_speak_test extends \core_external\tests\externallib_testcase {
    /** @var fake_speech_engine The engine in use. */
    private fake_speech_engine $fake;

    /**
     * A tutorial-mode activity whose tutor speaks, the fake engine as the only speech service, and a student.
     *
     * @param array $settings activity settings
     * @return array [\stdClass $vrmakerspace, \stdClass $student]
     */
    private function setup_activity(array $settings = []): array {
        $this->fake = fake_speech_engine::install();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', $settings + [
            'course' => $course->id,
            'methods' => 'sculpt',
            'tutorial' => 1,
            'tutorspeak' => 1,
        ]);
        $student = $gen->create_and_enrol($course, 'student');
        $this->setUser($student);
        return [$vrmakerspace, $student];
    }

    /**
     * A step is read from the lang strings, chunk by chunk, in the user's language.
     */
    public function test_speaks_a_step(): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity();
        $chunks = chunker::split(tutorial::step_speech('carve'));
        $this->assertNotSame([''], $chunks);

        $result = tutor_speak::execute((int)$vrmakerspace->cmid, 0, 'carve');
        $result = external_api::clean_returnvalue(tutor_speak::execute_returns(), $result);

        $this->assertSame(base64_encode('AUDIO:' . $chunks[0]), $result['audio']);
        $this->assertSame('audio/wav', $result['mimetype']);
        $this->assertSame(count($chunks), $result['chunks']);
        $this->assertSame([[$chunks[0], tutorial::speech_language(), '']], $this->fake->spoken);
        // The step's own text, not the client's.
        $this->assertStringContainsString(
            html_entity_decode(strip_tags(get_string('tutorial_step_carve_title', 'vrmakerspace'))),
            $this->fake->spoken[0][0]
        );
    }

    /**
     * Only known steps of the activity's ways of making are spoken.
     *
     * @param string $step the step asked for
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('unknown_step_provider')]
    public function test_refuses_unknown_step(string $step): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity();
        try {
            tutor_speak::execute((int)$vrmakerspace->cmid, 0, $step);
            $this->fail('An unknown step was spoken.');
        } catch (\invalid_parameter_exception $e) {
            $this->assertSame([], $this->fake->spoken);
        }
    }

    /**
     * Steps that are not steps of a sculpting-only activity.
     *
     * @return array
     */
    public static function unknown_step_provider(): array {
        return [
            'not a step' => ['nonsense'],
            'a modelling step' => ['extrude'],
            'a string key that is not a step' => ['tutor_name'],
        ];
    }

    /**
     * Without a step, the latest answer is spoken; a chunk out of range is refused; without an answer there
     * is nothing to say.
     */
    public function test_speaks_latest_answer(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->setup_activity();
        $cmid = (int)$vrmakerspace->cmid;

        try {
            tutor_speak::execute($cmid, 0, '');
            $this->fail('Spoke without an answer.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutornothingtosay', $e->errorcode);
        }

        $answer = 'Pick the Carve tool from the toolbar first. Then drag it over the clay.';
        tutorial::remember_answer((int)$student->id, $cmid, $answer);
        $chunks = chunker::split($answer);
        $this->assertCount(2, $chunks);

        $result = tutor_speak::execute($cmid, 1, '');
        $this->assertSame(base64_encode('AUDIO:' . $chunks[1]), $result['audio']);
        $this->assertSame(2, $result['chunks']);

        try {
            tutor_speak::execute($cmid, 2, '');
            $this->fail('A chunk out of range was spoken.');
        } catch (\invalid_parameter_exception $e) {
            $this->assertCount(1, $this->fake->spoken);
        }

        // Another student's answer is not this student's.
        $other = $this->getDataGenerator()->create_and_enrol(get_course($vrmakerspace->course), 'student');
        $this->setUser($other);
        try {
            tutor_speak::execute($cmid, 0, '');
            $this->fail('Spoke another student\'s answer.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutornothingtosay', $e->errorcode);
        }
    }

    /**
     * Refused when the activity is not in tutorial mode or its tutor does not speak.
     *
     * @param array $settings activity settings
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('speaking_off_provider')]
    public function test_refused_when_speaking_off(array $settings): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity($settings);
        try {
            tutor_speak::execute((int)$vrmakerspace->cmid, 0, 'welcome');
            $this->fail('The tutor spoke.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutorspeakoff', $e->errorcode);
        }
        $this->assertSame([], $this->fake->spoken);
    }

    /**
     * Activities whose tutor does not speak.
     *
     * @return array
     */
    public static function speaking_off_provider(): array {
        return [
            'not tutorial mode' => [['tutorial' => 0]],
            'tutor silent' => [['tutorspeak' => 0]],
        ];
    }

    /**
     * Refused when the site has no speech service that speaks.
     */
    public function test_refused_without_engine(): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity();
        $this->fake->speaks = false;
        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('error_speechnotconfigured', 'vrmakerspace'));
        tutor_speak::execute((int)$vrmakerspace->cmid, 0, 'welcome');
    }

    /**
     * Refused once the user has used up the minute's speech budget.
     */
    public function test_rate_limited(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->setup_activity();
        for ($i = 0; $i < rate_limiter::LIMITS['speak']; $i++) {
            rate_limiter::check('speak', (int)$student->id);
        }
        try {
            tutor_speak::execute((int)$vrmakerspace->cmid, 0, 'welcome');
            $this->fail('Spoke over the limit.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechratelimit', $e->errorcode);
        }
        $this->assertSame([], $this->fake->spoken);
    }

    #[\Override]
    protected function tearDown(): void {
        registry::set_engine(null, null);
        parent::tearDown();
    }
}
