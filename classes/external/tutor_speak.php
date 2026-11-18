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
use mod_vrmakerspace\local\session_manager;
use mod_vrmakerspace\local\tutorial;
use mod_vrmakerspace\speech\chunker;
use mod_vrmakerspace\speech\rate_limiter;
use mod_vrmakerspace\speech\registry;

/**
 * Web service: one sentence chunk of what the tutor says, as audio from the site's speech services.
 *
 * With a step, the step's title and text from the lang strings in the user's language (so the tutor can
 * read the tour aloud); without one, the tutor's latest AI answer to this user in this activity (kept by
 * ask_tutor). Never text from the client, so the service cannot be used as an open text-to-speech
 * service. Refused unless the activity is in tutorial mode with the tutor speaking and the site has a
 * speech service; each user's calls are rate limited.
 *
 * Modelled on mod_talkwithai's speak web service (same author).
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class tutor_speak extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'chunk' => new external_value(PARAM_INT, 'Index of the sentence chunk', VALUE_DEFAULT, 0),
            'step' => new external_value(
                PARAM_ALPHANUMEXT,
                'A step of the tour to read aloud; empty for the tutor\'s latest answer',
                VALUE_DEFAULT,
                ''
            ),
        ]);
    }

    /**
     * Speak one chunk.
     *
     * @param int $cmid course module id
     * @param int $chunk index of the sentence chunk
     * @param string $step a step key, or '' for the latest answer
     * @return array ['audio' => string (base64), 'mimetype' => string, 'chunks' => int]
     */
    public static function execute(int $cmid, int $chunk = 0, string $step = ''): array {
        global $DB, $USER;

        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'chunk' => $chunk,
            'step' => $step,
        ]);
        [, $cm] = get_course_and_cm_from_cmid($params['cmid'], 'vrmakerspace');
        $context = \context_module::instance($cm->id);
        self::validate_context($context);
        require_capability('mod/vrmakerspace:view', $context);
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);

        if (!tutorial::speak_enabled($vrmakerspace)) {
            throw new \moodle_exception('error_tutorspeakoff', 'mod_vrmakerspace');
        }
        if (!registry::available(registry::SPEAK)) {
            throw new \moodle_exception('error_speechnotconfigured', 'mod_vrmakerspace');
        }

        $step = (string)$params['step'];
        if ($step !== '') {
            if (!in_array($step, tutorial::applicable_steps(session_manager::methods($vrmakerspace)), true)) {
                throw new \invalid_parameter_exception('step');
            }
            $text = tutorial::step_speech($step);
        } else {
            $text = (string)tutorial::latest_answer((int)$USER->id, (int)$cm->id);
        }
        if ($text === '') {
            throw new \moodle_exception('error_tutornothingtosay', 'mod_vrmakerspace');
        }

        rate_limiter::check('speak', (int)$USER->id);
        // Speech can take a moment: do not hold the session lock meanwhile.
        \core\session\manager::write_close();
        return self::chunk_audio($text, (int)$params['chunk']);
    }

    /**
     * Synthesises one chunk of a text with the first speech engine that works.
     *
     * @param string $text the text (an answer or a step)
     * @param int $chunk index of the sentence chunk
     * @return array ['audio' => string (base64), 'mimetype' => string, 'chunks' => int]
     * @throws \invalid_parameter_exception for a chunk out of range
     * @throws \moodle_exception error_speechnotconfigured or error_speechfailed
     */
    public static function chunk_audio(string $text, int $chunk): array {
        $chunks = chunker::split($text);
        if ($chunk < 0 || $chunk >= count($chunks)) {
            throw new \invalid_parameter_exception('chunk');
        }
        // No voice name: each engine uses its own default voice (Ollama's is the site's female or male,
        // tutorial::voice_name()). A name such as "female" would be sent as is to an OpenAI-style server.
        $result = registry::synthesise($chunks[$chunk], tutorial::speech_language(), '');
        return [
            'audio' => base64_encode($result['audio']),
            'mimetype' => (string)$result['mimetype'],
            'chunks' => count($chunks),
        ];
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'audio' => new external_value(PARAM_RAW, 'Base64-encoded audio'),
            'mimetype' => new external_value(PARAM_RAW, 'Audio MIME type'),
            'chunks' => new external_value(PARAM_INT, 'How many chunks the text has'),
        ]);
    }
}
