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
 * Speech with an Ollama server and an audio model such as lfm3-audio.
 *
 * Ollama serves speech through its OpenAI-compatible endpoints:
 *
 * - POST /v1/audio/speech JSON {model, input, voice, response_format: wav}. The voice is
 *   "female" or "male", optionally followed by a language, e.g. "male-french". The WAV
 *   comes with the streaming placeholder sizes (0xFFFFFFFF) in its header, which are
 *   corrected here so every browser decodes it.
 * - POST /v1/audio/transcriptions multipart {model, file, language} → {text}. Only WAV
 *   is accepted (WebM and Ogg Opus are refused), so the browser records WAV.
 *
 * Without its own address, the engine uses the site's Ollama AI provider (core_ai), with
 * that provider's basic authentication, so a site that already talks to Ollama needs no
 * extra set-up apart from pulling the audio model.
 *
 * Checked against Ollama 0.40.13 with lfm3-audio on 2026-11-18.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class ollama extends engine {
    /** Default model for both directions. */
    const DEFAULT_MODEL = 'lfm3-audio';

    /** Voices the model offers. */
    const GENDERS = ['female', 'male'];

    /** Ollama's voice language names by BCP 47 tag (lower case); a region tag is tried before its language. */
    const LANGUAGES = [
        'en-gb' => 'british-english', 'en-us' => 'american-english', 'en' => 'american-english',
        'ar' => 'arabic', 'zh' => 'chinese', 'da' => 'danish', 'nl' => 'dutch', 'fi' => 'finnish',
        'fr' => 'french', 'de' => 'german', 'el' => 'greek', 'he' => 'hebrew', 'it' => 'italian',
        'ja' => 'japanese', 'ko' => 'korean', 'pl' => 'polish', 'pt' => 'portuguese', 'es' => 'spanish',
        'sv' => 'swedish', 'tr' => 'turkish',
    ];

    /**
     * The engine's short name.
     *
     * @return string
     */
    public static function name(): string {
        return 'ollama';
    }

    /**
     * Whether the engine can speak.
     *
     * @return bool
     */
    public function can_speak(): bool {
        return $this->endpoint() !== null && $this->model('ttsmodel') !== '';
    }

    /**
     * Whether the engine can listen.
     *
     * @return bool
     */
    public function can_listen(): bool {
        return $this->endpoint() !== null && $this->model('sttmodel') !== '';
    }

    /**
     * Only WAV can be transcribed.
     *
     * @return string[]
     */
    public function accepted_types(): array {
        return ['audio/wav'];
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
        [$base, $headers] = $this->endpoint() ?? [null, []];
        if ($base === null) {
            throw new \moodle_exception('error_speechnotconfigured', 'mod_vrmakerspace');
        }
        $response = $this->post($base . '/v1/audio/speech', [
            'headers' => $headers + ['Content-Type' => 'application/json'],
            'body' => json_encode([
                'model' => $this->model('ttsmodel'),
                'input' => $text,
                'voice' => $this->voice($voice, $language),
                'response_format' => 'wav',
            ]),
        ]);
        $this->expect($response);
        $audio = (string) $response->getBody();
        if ($audio === '') {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return ['mimetype' => 'audio/wav', 'audio' => self::fix_wav($audio)];
    }

    /**
     * Turns a WAV recording into text.
     *
     * @param string $audio
     * @param string $mimetype
     * @param string $language
     * @return string
     */
    public function transcribe(string $audio, string $mimetype, string $language = ''): string {
        [$base, $headers] = $this->endpoint() ?? [null, []];
        if ($base === null) {
            throw new \moodle_exception('error_speechnotconfigured', 'mod_vrmakerspace');
        }
        $extension = $this->check_upload($audio, $mimetype);
        $multipart = [
            ['name' => 'file', 'contents' => $audio, 'filename' => 'speech.' . $extension,
                'headers' => ['Content-Type' => $mimetype]],
            ['name' => 'model', 'contents' => $this->model('sttmodel')],
            ['name' => 'response_format', 'contents' => 'json'],
        ];
        $primary = self::primary_language($language);
        if ($primary !== '') {
            $multipart[] = ['name' => 'language', 'contents' => $primary];
        }
        $response = $this->post($base . '/v1/audio/transcriptions', ['headers' => $headers, 'multipart' => $multipart]);
        $this->expect($response);
        $data = json_decode((string) $response->getBody(), true);
        if (!is_array($data) || !isset($data['text'])) {
            throw new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        }
        return trim((string) $data['text']);
    }

    /**
     * The model for a direction, with the default.
     *
     * @param string $setting ttsmodel or sttmodel
     * @return string
     */
    private function model(string $setting): string {
        $value = get_config('mod_vrmakerspace', 'ollama' . $setting);
        return $value === false ? self::DEFAULT_MODEL : trim((string) $value);
    }

    /**
     * The server address and request headers, or null when there is no server.
     *
     * The engine's own address wins; otherwise the first enabled Ollama AI provider's
     * address and basic authentication are used.
     *
     * @return array|null [base url without trailing slash, headers]
     */
    public function endpoint(): ?array {
        $url = $this->config('url');
        $headers = [];
        if ($url === '') {
            $provider = self::ai_provider();
            if ($provider === null) {
                return null;
            }
            $url = trim((string) ($provider['endpoint'] ?? ''));
            if (!empty($provider['enablebasicauth'])) {
                $headers['Authorization'] = 'Basic '
                    . base64_encode(($provider['username'] ?? '') . ':' . ($provider['password'] ?? ''));
            }
        }
        if ($url === '') {
            return null;
        }
        if (!preg_match('~^https?://~i', $url)) {
            $url = 'http://' . $url;
        }
        $url = rtrim($url, '/');
        // An address given with the OpenAI path still works.
        $url = preg_replace('~/v1$~', '', $url);
        return [$url, $headers];
    }

    /**
     * The configuration of the first enabled Ollama provider of core_ai, or null.
     *
     * @return array|null
     */
    public static function ai_provider(): ?array {
        $manager = \core\di::get(\core_ai\manager::class);
        foreach ($manager->get_provider_records(['provider' => 'aiprovider_ollama\\provider', 'enabled' => 1]) as $record) {
            $config = json_decode((string) $record->config, true);
            if (is_array($config) && !empty($config['endpoint'])) {
                return $config;
            }
        }
        return null;
    }

    /**
     * Works out the Ollama voice from the activity's voice name and language.
     *
     * A full Ollama voice ("male-french") is used as it is. Otherwise the name only
     * picks the gender (a browser voice name such as "Google UK English Female"
     * does that too), and the language is added from the conversation language.
     *
     * @param string $voice The activity's voice name
     * @param string $language BCP 47 tag
     * @return string
     */
    public function voice(string $voice, string $language): string {
        $voice = strtolower(trim($voice));
        if (preg_match('/^(female|male)-[a-z]+(-[a-z]+)?$/', $voice)) {
            return $voice;
        }
        if (strpos($voice, 'female') !== false || strpos($voice, 'woman') !== false) {
            $gender = 'female';
        } else if (preg_match('/\bmale\b|\bman\b/', $voice)) {
            $gender = 'male';
        } else {
            $gender = $this->config('voice');
            $gender = in_array($gender, self::GENDERS, true) ? $gender : 'female';
        }
        $tag = strtolower(str_replace('_', '-', trim($language)));
        $name = self::LANGUAGES[$tag] ?? self::LANGUAGES[self::primary_language($tag)] ?? null;
        return $name === null ? $gender : $gender . '-' . $name;
    }

    /**
     * Corrects the sizes in a WAV header written for streaming (0xFFFFFFFF).
     *
     * @param string $wav
     * @return string
     */
    public static function fix_wav(string $wav): string {
        $length = strlen($wav);
        if ($length < 44 || substr($wav, 0, 4) !== 'RIFF' || substr($wav, 8, 4) !== 'WAVE') {
            return $wav;
        }
        $wav = substr_replace($wav, pack('V', $length - 8), 4, 4);
        // Walk the chunks to the data chunk.
        $offset = 12;
        while ($offset + 8 <= $length) {
            $id = substr($wav, $offset, 4);
            $size = unpack('V', substr($wav, $offset + 4, 4))[1];
            if ($id === 'data') {
                return substr_replace($wav, pack('V', $length - $offset - 8), $offset + 4, 4);
            }
            $offset += 8 + $size + ($size % 2);
        }
        return $wav;
    }

    /**
     * Adds the engine's settings.
     *
     * @param \admin_settingpage $settings
     */
    public static function add_settings(\admin_settingpage $settings): void {
        $provider = self::ai_provider();
        $settings->add(new \admin_setting_heading(
            'mod_vrmakerspace/ollama_heading',
            get_string('engine_ollama', 'mod_vrmakerspace'),
            get_string('ollama_heading_desc', 'mod_vrmakerspace', $provider ? s($provider['endpoint']) : '-')
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/ollamaurl',
            get_string('ollamaurl', 'mod_vrmakerspace'),
            get_string('ollamaurl_desc', 'mod_vrmakerspace'),
            '',
            PARAM_URL,
            60
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/ollamattsmodel',
            get_string('ollamattsmodel', 'mod_vrmakerspace'),
            get_string('ollamattsmodel_desc', 'mod_vrmakerspace'),
            self::DEFAULT_MODEL,
            PARAM_TEXT
        ));
        $settings->add(new \admin_setting_configselect(
            'mod_vrmakerspace/ollamavoice',
            get_string('ollamavoice', 'mod_vrmakerspace'),
            get_string('ollamavoice_desc', 'mod_vrmakerspace'),
            'female',
            ['female' => get_string('voice_female', 'mod_vrmakerspace'), 'male' => get_string('voice_male', 'mod_vrmakerspace')]
        ));
        $settings->add(new \admin_setting_configtext(
            'mod_vrmakerspace/ollamasttmodel',
            get_string('ollamasttmodel', 'mod_vrmakerspace'),
            get_string('ollamasttmodel_desc', 'mod_vrmakerspace'),
            self::DEFAULT_MODEL,
            PARAM_TEXT
        ));
    }
}
