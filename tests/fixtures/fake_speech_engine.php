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

namespace mod_vrmakerspace\tests;

use mod_vrmakerspace\speech\engine;
use mod_vrmakerspace\speech\registry;

/**
 * A speech engine for tests: records what it was asked and answers without any service.
 *
 * Put in place of a real engine with install(), which also makes it the only choice for
 * both directions.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class fake_speech_engine extends engine {
    /** @var bool Whether it speaks. */
    public bool $speaks = true;

    /** @var bool Whether it listens. */
    public bool $listens = true;

    /** @var bool Whether every call fails as a broken service would. */
    public bool $fails = false;

    /** @var string What it hears in every recording. */
    public string $transcript = 'How do I carve a hole?';

    /** @var array[] The synthesise() calls: [text, language, voice]. */
    public array $spoken = [];

    /** @var array[] The transcribe() calls: [audio, mimetype, language]. */
    public array $heard = [];

    /**
     * The engine's short name: it stands in for the OpenAI-style engine.
     *
     * @return string
     */
    public static function name(): string {
        return 'openai';
    }

    /**
     * Whether it speaks.
     *
     * @return bool
     */
    public function can_speak(): bool {
        return $this->speaks;
    }

    /**
     * Whether it listens.
     *
     * @return bool
     */
    public function can_listen(): bool {
        return $this->listens;
    }

    /**
     * Records the text and returns "audio" made of it.
     *
     * @param string $text
     * @param string $language
     * @param string $voice
     * @return array
     */
    public function synthesise(string $text, string $language, string $voice = ''): array {
        $this->spoken[] = [$text, $language, $voice];
        if ($this->fails) {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return ['mimetype' => 'audio/wav', 'audio' => 'AUDIO:' . $text];
    }

    /**
     * Records the recording and returns the transcript.
     *
     * @param string $audio
     * @param string $mimetype
     * @param string $language
     * @return string
     */
    public function transcribe(string $audio, string $mimetype, string $language = ''): string {
        $this->heard[] = [$audio, $mimetype, $language];
        if ($this->fails) {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return $this->transcript;
    }

    /**
     * No settings.
     *
     * @param \admin_settingpage $settings
     * @return void
     */
    public static function add_settings(\admin_settingpage $settings): void {
    }

    /**
     * Put a fake engine in place of the OpenAI-style one and make it the only choice for speaking and
     * listening (no browser, so client_order() is ['server']).
     *
     * @return self
     */
    public static function install(): self {
        $fake = new self();
        registry::set_engine(null, null);
        registry::set_engine('openai', $fake);
        foreach ([registry::SPEAK, registry::LISTEN] as $direction) {
            set_config($direction . 'order1', 'openai', 'mod_vrmakerspace');
            set_config($direction . 'order2', '', 'mod_vrmakerspace');
            set_config($direction . 'order3', '', 'mod_vrmakerspace');
        }
        return $fake;
    }

    /**
     * A WAV recording of silence: 16 kHz, mono, 16 bits.
     *
     * @param float $seconds its length
     * @return string
     */
    public static function wav(float $seconds = 1.0): string {
        $data = str_repeat("\0", (int)round($seconds * 32000));
        return 'RIFF' . pack('V', 36 + strlen($data)) . 'WAVE'
            . 'fmt ' . pack('VvvVVvv', 16, 1, 1, 16000, 32000, 2, 16)
            . 'data' . pack('V', strlen($data)) . $data;
    }
}
