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

namespace mod_vrmakerspace\speech;

use core\http_client;
use Psr\Http\Message\ResponseInterface;

/**
 * A speech service: text-to-speech, speech-to-text, or both.
 *
 * The language model always runs through core_ai. Speech is separate because
 * core_ai has no speech actions. Each engine is one service (Ollama, an
 * OpenAI-style audio server, ElevenLabs, Google Cloud…), with its own admin
 * settings. The site's preference order (see {@see registry}) decides which
 * engine is tried first; the others are fallbacks.
 *
 * To add a service, extend this class in classes/speech/engine/ and list it in
 * {@see registry::ENGINES}.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
abstract class engine {
    /** Longest audio upload accepted for transcription, in bytes (4 MB, about two minutes of 16 kHz WAV). */
    const MAX_UPLOAD_BYTES = 4194304;

    /** Audio types the browser may send, with the file extension used in uploads. */
    const UPLOAD_TYPES = [
        'audio/wav'  => 'wav',
        'audio/webm' => 'webm',
        'audio/ogg'  => 'ogg',
        'audio/mp4'  => 'mp4',
        'audio/mpeg' => 'mp3',
    ];

    /** Seconds a request may take before the next engine is tried. */
    const TIMEOUT = 30;

    /**
     * The engine's short name, as used in settings, e.g. "ollama".
     *
     * @return string
     */
    abstract public static function name(): string;

    /**
     * Whether the site has set this engine up well enough to speak.
     *
     * @return bool
     */
    abstract public function can_speak(): bool;

    /**
     * Whether the site has set this engine up well enough to listen.
     *
     * @return bool
     */
    abstract public function can_listen(): bool;

    /**
     * Turns text into audio.
     *
     * @param string $text The text to speak
     * @param string $language BCP 47 tag of the student's language, e.g. en-GB
     * @param string $voice The activity's voice name; empty for the engine's default
     * @return array {mimetype: string, audio: string (binary)}
     * @throws \moodle_exception error_speechfailed when the service fails
     */
    abstract public function synthesise(string $text, string $language, string $voice = ''): array;

    /**
     * Turns recorded speech into text.
     *
     * @param string $audio The audio bytes
     * @param string $mimetype A key of UPLOAD_TYPES
     * @param string $language BCP 47 tag of the student's language
     * @return string The transcript
     * @throws \moodle_exception error_speechfailed when the service fails
     */
    abstract public function transcribe(string $audio, string $mimetype, string $language = ''): string;

    /**
     * Adds the engine's settings to the plugin's settings page.
     *
     * @param \admin_settingpage $settings
     */
    abstract public static function add_settings(\admin_settingpage $settings): void;

    /**
     * The engine's name for people, e.g. "Ollama".
     *
     * @return string
     */
    public static function display_name(): string {
        return get_string('engine_' . static::name(), 'mod_vrmakerspace');
    }

    /**
     * The recording types this engine can transcribe.
     *
     * @return string[] Keys of UPLOAD_TYPES
     */
    public function accepted_types(): array {
        return array_keys(self::UPLOAD_TYPES);
    }

    /**
     * Reads one of this engine's settings.
     *
     * @param string $name The setting name without the engine prefix
     * @return string
     */
    protected function config(string $name): string {
        return trim((string) get_config('mod_vrmakerspace', static::name() . $name));
    }

    /**
     * Reads and decrypts one of this engine's encrypted settings.
     *
     * @param string $name The setting name without the engine prefix
     * @return string
     */
    protected function secret(string $name): string {
        $value = (string) get_config('mod_vrmakerspace', static::name() . $name);
        return $value === '' ? '' : (string) \core\encryption::decrypt($value);
    }

    /**
     * Sends a POST request.
     *
     * The client comes from the DI container, so tests can mock it. It applies the
     * site's cURL block list and proxy settings.
     *
     * @param string $url
     * @param array $options Guzzle request options
     * @return ResponseInterface
     * @throws \moodle_exception error_speechfailed on a network error
     */
    protected function post(string $url, array $options): ResponseInterface {
        $client = \core\di::get(http_client::class);
        try {
            return $client->post($url, $options + ['timeout' => self::TIMEOUT, 'http_errors' => false]);
        } catch (\GuzzleHttp\Exception\GuzzleException $e) {
            debugging('mod_vrmakerspace ' . static::name() . ': ' . $e->getMessage(), DEBUG_DEVELOPER);
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
    }

    /**
     * Throws error_speechfailed unless the response has the expected status.
     *
     * @param ResponseInterface $response
     * @param int $status
     * @throws \moodle_exception
     */
    protected function expect(ResponseInterface $response, int $status = 200): void {
        if ($response->getStatusCode() !== $status) {
            debugging('mod_vrmakerspace ' . static::name() . ': HTTP ' . $response->getStatusCode() . ' '
                . \core_text::substr((string) $response->getBody(), 0, 300), DEBUG_DEVELOPER);
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
    }

    /**
     * Checks an upload before it is sent.
     *
     * @param string $audio
     * @param string $mimetype
     * @return string The file extension for the upload
     * @throws \moodle_exception error_speechfailed for an empty, oversized or unsupported recording
     */
    protected function check_upload(string $audio, string $mimetype): string {
        if (
            $audio === '' || strlen($audio) > self::MAX_UPLOAD_BYTES
            || !isset(self::UPLOAD_TYPES[$mimetype]) || !in_array($mimetype, $this->accepted_types(), true)
        ) {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return self::UPLOAD_TYPES[$mimetype];
    }

    /**
     * Returns the primary language subtag of a BCP 47 tag, e.g. "fr" for "fr-CA", or ''.
     *
     * @param string $language
     * @return string
     */
    public static function primary_language(string $language): string {
        $primary = strtolower((string) strtok($language, '-_'));
        return preg_match('/^[a-z]{2,3}$/', $primary) ? $primary : '';
    }

    /**
     * Returns the audio's MIME type from the response, or a fallback.
     *
     * @param ResponseInterface $response
     * @param string $fallback
     * @return string
     */
    protected static function audio_type(ResponseInterface $response, string $fallback): string {
        $type = strtolower(trim((string) strtok($response->getHeaderLine('Content-Type'), ';')));
        return strpos($type, 'audio/') === 0 ? $type : $fallback;
    }
}
