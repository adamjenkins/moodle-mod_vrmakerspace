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
use mod_vrmakerspace\speech\chunker;
use mod_vrmakerspace\speech\rate_limiter;
use mod_vrmakerspace\speech\registry;

/**
 * Ask the tutor of a tutorial-mode activity a question about using the studio.
 *
 * The question goes, with the tour's own texts and the demos the tutor can give as context
 * (tutorial::build_prompt()), to Moodle's AI subsystem as a generate_text action through the manager, so
 * the site's providers, their rate limits and the AI action register all apply. The AI is asked for JSON
 * with the answer and, when a demonstration shows what the student asks about, its name; the reply is read
 * leniently (tutorial::parse_answer()) and a demo the activity does not have is dropped. Refused unless the
 * activity is in tutorial mode with the tutor turned on and an AI provider for text, the user has accepted
 * the AI policy, the question is 1 to 500 characters, and the user has asked fewer than 20 questions in the
 * last hour. The latest answer is kept in a cache for tutor_speak (the plugin stores nothing in the
 * database). With $speak, and the activity's tutor speaking, the first sentence comes back as audio too
 * (as mod_talkwithai's send_message, same author); a speech service that fails never fails the answer.
 *
 * The AI policy check and the session-lock release follow mod_letsaskai's ask web service.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class ask_tutor extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'step' => new external_value(PARAM_ALPHANUMEXT, 'The step the user is on', VALUE_DEFAULT, ''),
            'question' => new external_value(PARAM_TEXT, 'The question, 1 to 500 characters'),
            'speak' => new external_value(
                PARAM_BOOL,
                'Also return the first sentence of the answer as audio from the site\'s speech services',
                VALUE_DEFAULT,
                false
            ),
        ]);
    }

    /**
     * Ask the question.
     *
     * @param int $cmid course module id
     * @param string $step the step the user is on
     * @param string $question the question
     * @param bool $speak whether to return the first sentence as audio
     * @return array ['answer' => string, 'demo' => string, 'chunks' => int, 'audio' => string, 'mimetype' => string]
     */
    public static function execute(int $cmid, string $step, string $question, bool $speak = false): array {
        global $DB, $USER;

        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'step' => $step,
            'question' => $question,
            'speak' => $speak,
        ]);
        [, $cm] = get_course_and_cm_from_cmid($params['cmid'], 'vrmakerspace');
        $context = \context_module::instance($cm->id);
        self::validate_context($context);
        require_capability('mod/vrmakerspace:view', $context);
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);

        if (!tutorial::ai_enabled($vrmakerspace, $context)) {
            throw new \moodle_exception('error_tutornotavailable', 'mod_vrmakerspace');
        }
        if (!\core_ai\manager::get_user_policy_status((int)$USER->id)) {
            throw new \moodle_exception('error_tutorpolicy', 'mod_vrmakerspace');
        }
        $question = trim((string)$params['question']);
        $length = \core_text::strlen($question);
        if ($length < 1 || $length > tutorial::MAX_QUESTION_LENGTH) {
            throw new \moodle_exception('error_tutorquestionlength', 'mod_vrmakerspace', '', tutorial::MAX_QUESTION_LENGTH);
        }
        if (tutorial::recent_questions((int)$USER->id, (int)$context->id) >= tutorial::RATE_LIMIT) {
            throw new \moodle_exception('error_tutorratelimit', 'mod_vrmakerspace', '', tutorial::RATE_LIMIT);
        }

        $prompt = tutorial::build_prompt($vrmakerspace, (string)$params['step'], $question);
        $demos = tutorial::applicable_demos(\mod_vrmakerspace\local\session_manager::methods($vrmakerspace));

        // A model can take a while: do not hold the session lock while it thinks.
        \core\session\manager::write_close();

        $action = new \core_ai\aiactions\generate_text(
            contextid: (int)$context->id,
            userid: (int)$USER->id,
            prompttext: $prompt,
        );
        $response = \core\di::get(\core_ai\manager::class)->process_action($action);
        if (!$response->get_success()) {
            $message = trim((string)$response->get_errormessage());
            throw new \moodle_exception('error_tutorfailed', 'mod_vrmakerspace', '', $message !== '' ? $message : '-');
        }
        $data = $response->get_response_data();
        $parsed = tutorial::parse_answer((string)($data['generatedcontent'] ?? ''), $demos);
        $answer = $parsed['answer'];
        if ($answer === '') {
            throw new \moodle_exception('error_tutorfailed', 'mod_vrmakerspace', '', '-');
        }
        tutorial::remember_answer((int)$USER->id, (int)$cm->id, $answer);

        $result = [
            'answer' => $answer,
            'demo' => $parsed['demo'],
            'chunks' => count(chunker::split($answer)),
            'audio' => '',
            'mimetype' => '',
        ];
        if ($params['speak'] && tutorial::speak_enabled($vrmakerspace) && registry::available(registry::SPEAK)) {
            try {
                rate_limiter::check('speak', (int)$USER->id);
                $audio = tutor_speak::chunk_audio($answer, 0);
                $result['audio'] = $audio['audio'];
                $result['mimetype'] = $audio['mimetype'];
            } catch (\moodle_exception $e) {
                // No audio (no engine worked, or the speech limit is reached): the browser speaks the
                // answer another way, or only shows it.
                $result['audio'] = '';
            }
        }
        return $result;
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'answer' => new external_value(PARAM_TEXT, 'The tutor\'s answer, plain text (show it as text, never as HTML)'),
            'demo' => new external_value(PARAM_ALPHANUMEXT, 'The demo the tutor gives with the answer, or empty'),
            'chunks' => new external_value(PARAM_INT, 'How many sentence chunks the answer is spoken in'),
            'audio' => new external_value(PARAM_RAW, 'Base64-encoded audio of the first chunk, or empty'),
            'mimetype' => new external_value(PARAM_RAW, 'The audio\'s MIME type, or empty'),
        ]);
    }
}
