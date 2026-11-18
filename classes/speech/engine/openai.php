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

namespace mod_vrmakerspace\speech\engine;

use mod_vrmakerspace\speech\engine;

/**
 * Speech with any server that has the widely implemented OpenAI-style audio API.
 *
 * The same two endpoints are offered by many servers, hosted and self-hosted
 * (for example Speaches, Kokoro-FastAPI, LocalAI, openedai-speech, vLLM), so
 * the site is not tied to one vendor:
 *
 * - POST {base}/audio/speech         JSON {model, input, voice, response_format} → audio bytes
 * - POST {base}/audio/transcriptions multipart {file, model, language} → JSON {text}
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class openai extends engine {
    /** Audio formats the server may be asked to produce, with their MIME types. */
    const OUTPUT_FORMATS = [
        'mp3'  => 'audio/mpeg',
        'opus' => 'audio/ogg',
        'wav'  => 'audio/wav',
        'aac'  => 'audio/aac',
        'flac' => 'audio/flac',
    ];

    /**
     * The engine's short name.
     *
     * @return string
     */
    public static function name(): string {
        return 'openai';
    }

    /**
     * The configured base URL without a trailing slash, e.g. "https://speech.example.org/v1".
     *
     * @return string
     */
    public function base_url(): string {
        return rtrim($this->config('url'), '/');
    }

    /**
     * Whether the engine can speak.
     *
     * @return bool
     */
    public function can_speak(): bool {
        return $this->base_url() !== '' && $this->config('ttsmodel') !== '';
    }

    /**
     * Whether the engine can listen.
     *
     * @return bool
     */
    public function can_listen(): bool {
        return $this->base_url() !== '' && $this->config('sttmodel') !== '';
    }

    /**
     * Turns text into audio.
     *
     * @param string $text
     * @param string $language
     * @param string $voice
     * @return array
     */
    public function synthesise(string $text, string $language, string $voice = ''): array {
        $format = $this->config('format');
        if (!isset(self::OUTPUT_FORMATS[$format])) {
            $format = 'mp3';
        }
        $voice = trim($voice) !== '' ? trim($voice) : $this->config('voice');

        $response = $this->post($this->base_url() . '/audio/speech', [
            'headers' => $this->headers() + ['Content-Type' => 'application/json'],
            'body' => json_encode([
                'model' => $this->config('ttsmodel'),
                'input' => $text,
                'voice' => $voice,
                'response_format' => $format,
            ]),
        ]);
        $this->expect($response);
        $audio = (string) $response->getBody();
        if ($audio === '') {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return ['mimetype' => self::audio_type($response, self::OUTPUT_FORMATS[$format]), 'audio' => $audio];
    }

    /**
     * Turns recorded speech into text.
     *
     * @param string $audio
     * @param string $mimetype
     * @param string $language
     * @return string
     */
    public function transcribe(string $audio, string $mimetype, string $language = ''): string {
        $extension = $this->check_upload($audio, $mimetype);
        $multipart = [
            ['name' => 'file', 'contents' => $audio, 'filename' => 'speech.' . $extension,
                'headers' => ['Content-Type' => $mimetype]],
            ['name' => 'model', 'contents' => $this->config('sttmodel')],
            ['name' => 'response_format', 'contents' => 'json'],
        ];
        $primary = self::primary_language($language);
        if ($primary !== '') {
            $multipart[] = ['name' => 'language', 'contents' => $primary];
        }

        $response = $this->post($this->base_url() . '/audio/transcriptions', [
            'headers' => $this->headers(),
            'multipart' => $multipart,
        ]);
        $this->expect($response);
        $data = json_decode((string) $response->getBody(), true);
        if (!is_array($data) || !isset($data['text'])) {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return trim((string) $data['text']);
    }

    /**
     * The request headers, with the API key when one is set.
     *
     * @return array
     */
    private function headers(): array {
        $key = $this->secret('apikey');
        return $key !== '' ? ['Authorization' => 'Bearer ' . $key] : [];
    }

    /**
     * Adds the engine's settings.
     *
     * @param \admin_settingpage $settings
     */
    public static function add_settings(\admin_settingpage $settings): void {
        $settings->add(new \admin_setting_heading(
            'mod_vrmakerspace/openai_heading',
            get_string('engine_openai', 'mod_vrmakerspace'),
            get_string('openai_heading_desc', 'mod_vrmakerspace')
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/openaiurl',
            get_string('openaiurl', 'mod_vrmakerspace'),
            get_string('openaiurl_desc', 'mod_vrmakerspace'),
            '',
            PARAM_URL,
            60
        ));
        $settings->add(new \admin_setting_encryptedpassword(
            'mod_vrmakerspace/openaiapikey',
            get_string('apikey', 'mod_vrmakerspace'),
            get_string('openaiapikey_desc', 'mod_vrmakerspace')
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/openaittsmodel',
            get_string('ttsmodel', 'mod_vrmakerspace'),
            get_string('openaittsmodel_desc', 'mod_vrmakerspace'),
            '',
            PARAM_TEXT
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/openaivoice',
            get_string('defaultvoice', 'mod_vrmakerspace'),
            get_string('openaivoice_desc', 'mod_vrmakerspace'),
            '',
            PARAM_TEXT
        ));
        $settings->add(new \admin_setting_configselect(
            'mod_vrmakerspace/openaiformat',
            get_string('openaiformat', 'mod_vrmakerspace'),
            get_string('openaiformat_desc', 'mod_vrmakerspace'),
            'mp3',
            array_combine(array_keys(self::OUTPUT_FORMATS), array_keys(self::OUTPUT_FORMATS))
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/openaisttmodel',
            get_string('sttmodel', 'mod_vrmakerspace'),
            get_string('openaisttmodel_desc', 'mod_vrmakerspace'),
            '',
            PARAM_TEXT
        ));
    }
}
