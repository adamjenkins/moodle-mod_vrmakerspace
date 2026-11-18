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
 * Speech with ElevenLabs (hosted).
 *
 * - POST {base}/v1/text-to-speech/{voice_id}?output_format=… JSON {text, model_id, language_code,
 *   voice_settings} → audio bytes. The Flash models are the fastest (about 100 ms).
 * - POST {base}/v1/speech-to-text multipart {model_id, file, language_code} → JSON {text}.
 *
 * The key is sent in the xi-api-key header. Written to the API reference of 2026-11 (OpenAPI spec
 * api-reference-2.json); not tested against the live service.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class elevenlabs extends engine {
    /** Default API address. */
    const DEFAULT_URL = 'https://api.elevenlabs.io';

    /** Default speech model (Flash v2.5: about 100 ms, 32 languages). */
    const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5';

    /** Default transcription model. */
    const DEFAULT_STT_MODEL = 'scribe_v2';

    /** Default voice: "George", the voice of ElevenLabs' own examples. */
    const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

    /** Compact MP3, plays in every browser. */
    const OUTPUT_FORMAT = 'mp3_44100_64';

    /**
     * The engine's short name.
     *
     * @return string
     */
    public static function name(): string {
        return 'elevenlabs';
    }

    /**
     * Whether the engine can speak.
     *
     * @return bool
     */
    public function can_speak(): bool {
        return $this->secret('apikey') !== '' && $this->setting('ttsmodel', self::DEFAULT_TTS_MODEL) !== '';
    }

    /**
     * Whether the engine can listen.
     *
     * @return bool
     */
    public function can_listen(): bool {
        return $this->secret('apikey') !== '' && $this->setting('sttmodel', self::DEFAULT_STT_MODEL) !== '';
    }

    /**
     * Turns text into audio.
     *
     * @param string $text
     * @param string $language
     * @param string $voice An ElevenLabs voice id; anything else uses the default voice
     * @return array
     */
    public function synthesise(string $text, string $language, string $voice = ''): array {
        $voice = trim($voice);
        if (!preg_match('/^[A-Za-z0-9]{16,40}$/', $voice)) {
            $voice = $this->setting('voice', self::DEFAULT_VOICE);
        }
        $body = [
            'text' => $text,
            'model_id' => $this->setting('ttsmodel', self::DEFAULT_TTS_MODEL),
            'voice_settings' => ['use_speaker_boost' => false],
        ];
        $primary = self::primary_language($language);
        if ($primary !== '' && strpos($body['model_id'], 'multilingual_v2') === false) {
            $body['language_code'] = $primary;
        }
        $response = $this->post(
            $this->base_url() . '/v1/text-to-speech/' . rawurlencode($voice) . '?output_format=' . self::OUTPUT_FORMAT,
            [
                'headers' => ['xi-api-key' => $this->secret('apikey'), 'Content-Type' => 'application/json',
                    'Accept' => 'audio/mpeg'],
                'body' => json_encode($body),
            ]
        );
        $this->expect($response);
        $audio = (string) $response->getBody();
        if ($audio === '') {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return ['mimetype' => 'audio/mpeg', 'audio' => $audio];
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
            ['name' => 'model_id', 'contents' => $this->setting('sttmodel', self::DEFAULT_STT_MODEL)],
            ['name' => 'tag_audio_events', 'contents' => 'false'],
            ['name' => 'timestamps_granularity', 'contents' => 'none'],
        ];
        $primary = self::primary_language($language);
        if ($primary !== '') {
            $multipart[] = ['name' => 'language_code', 'contents' => $primary];
        }
        $response = $this->post($this->base_url() . '/v1/speech-to-text', [
            'headers' => ['xi-api-key' => $this->secret('apikey')],
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
     * The API address without a trailing slash.
     *
     * @return string
     */
    private function base_url(): string {
        return rtrim($this->setting('url', self::DEFAULT_URL), '/');
    }

    /**
     * A setting, or its default when it was never saved (an empty model switches that direction off).
     *
     * @param string $name
     * @param string $default
     * @return string
     */
    private function setting(string $name, string $default): string {
        $value = get_config('mod_vrmakerspace', 'elevenlabs' . $name);
        if ($value === false || ($name !== 'ttsmodel' && $name !== 'sttmodel' && trim((string) $value) === '')) {
            return $default;
        }
        return trim((string) $value);
    }

    /**
     * Adds the engine's settings.
     *
     * @param \admin_settingpage $settings
     */
    public static function add_settings(\admin_settingpage $settings): void {
        $settings->add(new \admin_setting_heading(
            'mod_vrmakerspace/elevenlabs_heading',
            get_string('engine_elevenlabs', 'mod_vrmakerspace'),
            get_string('elevenlabs_heading_desc', 'mod_vrmakerspace')
        ));
        $settings->add(new \admin_setting_encryptedpassword(
            'mod_vrmakerspace/elevenlabsapikey',
            get_string('apikey', 'mod_vrmakerspace'),
            get_string('elevenlabsapikey_desc', 'mod_vrmakerspace')
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/elevenlabsurl',
            get_string('elevenlabsurl', 'mod_vrmakerspace'),
            get_string('elevenlabsurl_desc', 'mod_vrmakerspace'),
            self::DEFAULT_URL,
            PARAM_URL,
            60
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/elevenlabsttsmodel',
            get_string('ttsmodel', 'mod_vrmakerspace'),
            get_string('elevenlabsttsmodel_desc', 'mod_vrmakerspace'),
            self::DEFAULT_TTS_MODEL,
            PARAM_TEXT
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/elevenlabsvoice',
            get_string('defaultvoice', 'mod_vrmakerspace'),
            get_string('elevenlabsvoice_desc', 'mod_vrmakerspace'),
            self::DEFAULT_VOICE,
            PARAM_ALPHANUM
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/elevenlabssttmodel',
            get_string('sttmodel', 'mod_vrmakerspace'),
            get_string('elevenlabssttmodel_desc', 'mod_vrmakerspace'),
            self::DEFAULT_STT_MODEL,
            PARAM_TEXT
        ));
    }
}
