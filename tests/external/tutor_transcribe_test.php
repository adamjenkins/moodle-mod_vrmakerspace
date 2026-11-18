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
use mod_vrmakerspace\speech\rate_limiter;
use mod_vrmakerspace\speech\registry;
use mod_vrmakerspace\tests\fake_speech_engine;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/tests/fixtures/fake_speech_engine.php');

/**
 * Tests of the tutor_transcribe web service, with the speech engine replaced through the registry's test hook.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\external\tutor_transcribe::class)]
final class tutor_transcribe_test extends \core_external\tests\externallib_testcase {
    /** @var fake_speech_engine The engine in use. */
    private fake_speech_engine $fake;

    /**
     * A tutorial-mode activity whose students may speak to the tutor, the fake engine as the only speech
     * service, and a student.
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
            'tutorial' => 1,
            'tutorlisten' => 1,
        ]);
        $student = $gen->create_and_enrol($course, 'student');
        $this->setUser($student);
        return [$vrmakerspace, $student];
    }

    /**
     * A WAV recording is passed to the engine as WAV, with the language, and the text comes back; the
     * AI need not be on.
     */
    public function test_transcribes(): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity(['tutorai' => 0]);
        $wav = fake_speech_engine::wav(2.0);

        $result = tutor_transcribe::execute((int)$vrmakerspace->cmid, base64_encode($wav), 'fr-CA');
        $result = external_api::clean_returnvalue(tutor_transcribe::execute_returns(), $result);

        $this->assertSame('How do I carve a hole?', $result['text']);
        $this->assertSame([[$wav, 'audio/wav', 'fr-CA']], $this->fake->heard);
    }

    /**
     * An empty or malformed language gives way to the user's own.
     */
    public function test_language_falls_back(): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity();
        $audio = base64_encode(fake_speech_engine::wav());
        tutor_transcribe::execute((int)$vrmakerspace->cmid, $audio, '');
        tutor_transcribe::execute((int)$vrmakerspace->cmid, $audio, 'x-very-long-and-strange');
        $this->assertSame(tutorial::speech_language(), $this->fake->heard[0][2]);
        $this->assertSame(tutorial::speech_language(), $this->fake->heard[1][2]);
        $this->assertSame('pt-BR', tutor_transcribe::clean_language('pt_BR'));
    }

    /**
     * Recordings that are not base64, not WAV, or longer than 30 seconds are refused before any service
     * hears them.
     *
     * @param string $kind which bad recording
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('bad_audio_provider')]
    public function test_refuses_bad_audio(string $kind): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity();
        $audio = match ($kind) {
            'not base64' => '***',
            'not WAV' => base64_encode(str_repeat('OggS', 100)),
            'too long' => base64_encode(fake_speech_engine::wav(tutor_transcribe::MAX_SECONDS + 1)),
            'empty' => '',
        };
        try {
            tutor_transcribe::execute((int)$vrmakerspace->cmid, $audio, 'en');
            $this->fail('A bad recording was transcribed.');
        } catch (\invalid_parameter_exception $e) {
            $this->assertSame([], $this->fake->heard);
        }
    }

    /**
     * Bad recordings.
     *
     * @return array
     */
    public static function bad_audio_provider(): array {
        return [
            'not base64' => ['not base64'],
            'not WAV' => ['not WAV'],
            'too long' => ['too long'],
            'empty' => ['empty'],
        ];
    }

    /**
     * A recording of exactly 30 seconds is still taken.
     */
    public function test_thirty_seconds_accepted(): void {
        $this->assertTrue(tutor_transcribe::is_short_wav(fake_speech_engine::wav(tutor_transcribe::MAX_SECONDS)));
        $this->assertFalse(tutor_transcribe::is_short_wav('RIFF'));
    }

    /**
     * Refused when the activity is not in tutorial mode or its students may not speak to the tutor.
     *
     * @param array $settings activity settings
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('listening_off_provider')]
    public function test_refused_when_listening_off(array $settings): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity($settings);
        try {
            tutor_transcribe::execute((int)$vrmakerspace->cmid, base64_encode(fake_speech_engine::wav()), 'en');
            $this->fail('The tutor listened.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_tutorlistenoff', $e->errorcode);
        }
        $this->assertSame([], $this->fake->heard);
    }

    /**
     * Activities whose tutor does not listen.
     *
     * @return array
     */
    public static function listening_off_provider(): array {
        return [
            'not tutorial mode' => [['tutorial' => 0]],
            'listening off' => [['tutorlisten' => 0]],
        ];
    }

    /**
     * Refused when the site has no speech service that listens.
     */
    public function test_refused_without_engine(): void {
        $this->resetAfterTest();
        [$vrmakerspace] = $this->setup_activity();
        $this->fake->listens = false;
        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('error_speechnotconfigured', 'vrmakerspace'));
        tutor_transcribe::execute((int)$vrmakerspace->cmid, base64_encode(fake_speech_engine::wav()), 'en');
    }

    /**
     * Refused once the user has used up the minute's transcription budget.
     */
    public function test_rate_limited(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $student] = $this->setup_activity();
        for ($i = 0; $i < rate_limiter::LIMITS['transcribe']; $i++) {
            rate_limiter::check('transcribe', (int)$student->id);
        }
        try {
            tutor_transcribe::execute((int)$vrmakerspace->cmid, base64_encode(fake_speech_engine::wav()), 'en');
            $this->fail('Transcribed over the limit.');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechratelimit', $e->errorcode);
        }
        $this->assertSame([], $this->fake->heard);
    }

    #[\Override]
    protected function tearDown(): void {
        registry::set_engine(null, null);
        parent::tearDown();
    }
}
