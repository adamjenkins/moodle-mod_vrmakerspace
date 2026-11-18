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
use core_external\external_function_parameters;
use core_external\external_single_structure;
use core_external\external_value;
use mod_vrmakerspace\local\tutorial;
use mod_vrmakerspace\speech\engine;
use mod_vrmakerspace\speech\rate_limiter;
use mod_vrmakerspace\speech\registry;

/**
 * Web service: turn a student's spoken question to the tutor into text with the site's speech services.
 *
 * The recording is a WAV file of at most 30 seconds (the studio records WAV, which every engine takes,
 * Ollama only that). It is passed straight to the speech engine and never stored in Moodle. Refused
 * unless the activity is in tutorial mode with students speaking to the tutor and the site has a speech
 * service that listens; each user's calls are rate limited.
 *
 * Modelled on mod_talkwithai's transcribe web service (same author).
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class tutor_transcribe extends external_api {
    /** @var int Longest recording accepted, in seconds. */
    public const MAX_SECONDS = 30;

    /** @var string The only recording type accepted. */
    public const MIMETYPE = 'audio/wav';

    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'audio' => new external_value(PARAM_RAW, 'Base64-encoded WAV recording, at most 30 seconds'),
            'language' => new external_value(
                PARAM_ALPHANUMEXT,
                'BCP 47 tag of the language spoken, e.g. en-GB; empty for the user\'s language',
                VALUE_DEFAULT,
                ''
            ),
        ]);
    }

    /**
     * Transcribe a question.
     *
     * @param int $cmid course module id
     * @param string $audio base64-encoded WAV
     * @param string $language BCP 47 tag, or '' for the user's language
     * @return array ['text' => string]
     */
    public static function execute(int $cmid, string $audio, string $language = ''): array {
        global $DB, $USER;

        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'audio' => $audio,
            'language' => $language,
        ]);
        [, $cm] = get_course_and_cm_from_cmid($params['cmid'], 'vrmakerspace');
        $context = \context_module::instance($cm->id);
        self::validate_context($context);
        require_capability('mod/vrmakerspace:view', $context);
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);

        if (!tutorial::listen_enabled($vrmakerspace)) {
            throw new \moodle_exception('error_tutorlistenoff', 'mod_vrmakerspace');
        }
        if (!registry::available(registry::LISTEN)) {
            throw new \moodle_exception('error_speechnotconfigured', 'mod_vrmakerspace');
        }

        $bytes = base64_decode((string)$params['audio'], true);
        if ($bytes === false || !self::is_short_wav($bytes)) {
            throw new \invalid_parameter_exception('audio');
        }
        $language = self::clean_language((string)$params['language']);

        rate_limiter::check('transcribe', (int)$USER->id);
        // Transcription can take a moment: do not hold the session lock meanwhile.
        \core\session\manager::write_close();
        $result = registry::transcribe($bytes, self::MIMETYPE, $language);
        return ['text' => trim((string)clean_param($result['text'], PARAM_TEXT))];
    }

    /**
     * Whether bytes are a WAV recording of at most MAX_SECONDS seconds (and within the engines' upload limit).
     *
     * The length is the data chunk's size (or, for a header written for streaming, the file's size)
     * divided by the format's bytes per second.
     *
     * @param string $bytes the recording
     * @return bool
     */
    public static function is_short_wav(string $bytes): bool {
        $length = strlen($bytes);
        if (
            $length < 44 || $length > engine::MAX_UPLOAD_BYTES
            || substr($bytes, 0, 4) !== 'RIFF' || substr($bytes, 8, 4) !== 'WAVE'
        ) {
            return false;
        }
        $byterate = 0;
        $datasize = null;
        $offset = 12;
        while ($offset + 8 <= $length) {
            $id = substr($bytes, $offset, 4);
            $size = unpack('V', substr($bytes, $offset + 4, 4))[1];
            if ($id === 'fmt ' && $offset + 20 <= $length) {
                $byterate = unpack('V', substr($bytes, $offset + 16, 4))[1];
            } else if ($id === 'data') {
                $datasize = min($size, $length - $offset - 8);
                break;
            }
            $offset += 8 + $size + ($size % 2);
        }
        if ($byterate <= 0 || $datasize === null) {
            return false;
        }
        return $datasize / $byterate <= self::MAX_SECONDS + 0.5;
    }

    /**
     * A BCP 47 tag from the client, or the user's language when it is empty or does not look like one.
     *
     * @param string $language the tag
     * @return string
     */
    public static function clean_language(string $language): string {
        $language = str_replace('_', '-', trim($language));
        if (!preg_match('/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/', $language)) {
            return tutorial::speech_language();
        }
        return $language;
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'text' => new external_value(PARAM_TEXT, 'What the student said'),
        ]);
    }
}
