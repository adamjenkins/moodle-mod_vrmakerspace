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
 * Speech with Google Cloud Text-to-Speech and Speech-to-Text (v1 REST, API key).
 *
 * - POST https://texttospeech.googleapis.com/v1/text:synthesize JSON {input: {text},
 *   voice: {languageCode, name}, audioConfig: {audioEncoding: MP3}} → {audioContent: base64}.
 * - POST https://speech.googleapis.com/v1/speech:recognize JSON {config: {encoding,
 *   languageCode, model, enableAutomaticPunctuation}, audio: {content: base64}} →
 *   {results: [{alternatives: [{transcript}]}]}. Sync requests take up to one minute of audio.
 *
 * The key goes in the x-goog-api-key header. Google documents API keys for Speech-to-Text v1;
 * for Text-to-Speech the key must be allowed to use that API. Written to the REST reference of
 * 2026-11; not tested against the live service.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class google extends engine {
    /** Text-to-Speech endpoint. */
    const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

    /** Speech-to-Text endpoint. */
    const STT_URL = 'https://speech.googleapis.com/v1/speech:recognize';

    /** Recording types with their Speech-to-Text encoding and sample rate (null: read from the header). */
    const ENCODINGS = [
        'audio/wav'  => ['LINEAR16', null],
        'audio/webm' => ['WEBM_OPUS', 48000],
        'audio/ogg'  => ['OGG_OPUS', 48000],
    ];

    /**
     * The engine's short name.
     *
     * @return string
     */
    public static function name(): string {
        return 'google';
    }

    /**
     * Whether the engine can speak.
     *
     * @return bool
     */
    public function can_speak(): bool {
        return $this->secret('apikey') !== '' && !empty(get_config('mod_vrmakerspace', 'googletts'));
    }

    /**
     * Whether the engine can listen.
     *
     * @return bool
     */
    public function can_listen(): bool {
        return $this->secret('apikey') !== '' && !empty(get_config('mod_vrmakerspace', 'googlestt'));
    }

    /**
     * The recording types Speech-to-Text accepts here.
     *
     * @return string[]
     */
    public function accepted_types(): array {
        return array_keys(self::ENCODINGS);
    }

    /**
     * Turns text into audio.
     *
     * @param string $text
     * @param string $language
     * @param string $voice A Google voice name such as en-GB-Neural2-A; anything else uses the default
     * @return array
     */
    public function synthesise(string $text, string $language, string $voice = ''): array {
        $voice = trim($voice);
        if (!self::is_voice_name($voice)) {
            $voice = $this->config('voice');
        }
        $selection = ['languageCode' => $language !== '' ? $language : 'en-US'];
        if (self::is_voice_name($voice)) {
            $selection['name'] = $voice;
            // The voice's own language wins, so the request is consistent.
            $selection['languageCode'] = implode('-', array_slice(explode('-', $voice), 0, 2));
        }
        $response = $this->post(self::TTS_URL, [
            'headers' => ['x-goog-api-key' => $this->secret('apikey'), 'Content-Type' => 'application/json'],
            'body' => json_encode([
                'input' => ['text' => $text],
                'voice' => $selection,
                'audioConfig' => ['audioEncoding' => 'MP3'],
            ]),
        ]);
        $this->expect($response);
        $data = json_decode((string) $response->getBody(), true);
        $audio = is_array($data) && isset($data['audioContent']) ? base64_decode((string) $data['audioContent'], true) : false;
        if ($audio === false || $audio === '') {
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
        $this->check_upload($audio, $mimetype);
        [$encoding, $rate] = self::ENCODINGS[$mimetype];
        $config = [
            'encoding' => $encoding,
            'languageCode' => $language !== '' ? $language : 'en-US',
            'model' => 'latest_short',
            'enableAutomaticPunctuation' => true,
        ];
        if ($rate !== null) {
            $config['sampleRateHertz'] = $rate;
        }
        $response = $this->post(self::STT_URL, [
            'headers' => ['x-goog-api-key' => $this->secret('apikey'), 'Content-Type' => 'application/json'],
            'body' => json_encode(['config' => $config, 'audio' => ['content' => base64_encode($audio)]]),
        ]);
        $this->expect($response);
        $data = json_decode((string) $response->getBody(), true);
        if (!is_array($data)) {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        // No results means no speech was recognised.
        $parts = [];
        foreach ($data['results'] ?? [] as $result) {
            $parts[] = trim((string) ($result['alternatives'][0]['transcript'] ?? ''));
        }
        return trim(implode(' ', array_filter($parts, fn($p) => $p !== '')));
    }

    /**
     * Whether a name looks like a Google voice name, e.g. en-GB-Neural2-A.
     *
     * @param string $voice
     * @return bool
     */
    private static function is_voice_name(string $voice): bool {
        return (bool) preg_match('/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/', $voice);
    }

    /**
     * Adds the engine's settings.
     *
     * @param \admin_settingpage $settings
     */
    public static function add_settings(\admin_settingpage $settings): void {
        $settings->add(new \admin_setting_heading(
            'mod_vrmakerspace/google_heading',
            get_string('engine_google', 'mod_vrmakerspace'),
            get_string('google_heading_desc', 'mod_vrmakerspace')
        ));
        $settings->add(new \admin_setting_encryptedpassword(
            'mod_vrmakerspace/googleapikey',
            get_string('apikey', 'mod_vrmakerspace'),
            get_string('googleapikey_desc', 'mod_vrmakerspace')
        ));
        $settings->add(new \admin_setting_configcheckbox(
            'mod_vrmakerspace/googletts',
            get_string('googletts', 'mod_vrmakerspace'),
            get_string('googletts_desc', 'mod_vrmakerspace'),
            1
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/googlevoice',
            get_string('defaultvoice', 'mod_vrmakerspace'),
            get_string('googlevoice_desc', 'mod_vrmakerspace'),
            '',
            PARAM_TEXT
        ));
        $settings->add(new \admin_setting_configcheckbox(
            'mod_vrmakerspace/googlestt',
            get_string('googlestt', 'mod_vrmakerspace'),
            get_string('googlestt_desc', 'mod_vrmakerspace'),
            1
        ));
    }
}
