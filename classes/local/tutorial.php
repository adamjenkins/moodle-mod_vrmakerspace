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

namespace mod_vrmakerspace\local;

use mod_vrmakerspace\speech\registry;

/**
 * Tutorial mode: the guided tour's steps, each student's progress through them, and the tutor's prompt.
 *
 * The step list here is the authority (the studio's amd/src/tutorialsteps.js holds the same keys with
 * their conditions): which steps an activity has depends on its ways of making, keys the client sends
 * that are not applicable steps are dropped, and a student has finished the tutorial when every
 * applicable step is done or skipped. Progress is one vrmakerspace_tutorial row per activity and user;
 * stepsdone and stepsskipped are comma-separated step keys, and a key is in at most one of them (done
 * wins).
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class tutorial {
    /** @var string The progress table. */
    public const TABLE = 'vrmakerspace_tutorial';

    /** @var string A step every activity has. */
    public const APPLIES_ALL = '*';

    /** @var string A step of activities with sculpting. */
    public const APPLIES_SCULPT = 'S';

    /** @var string A step of activities with modelling. */
    public const APPLIES_MODEL = 'M';

    /** @var string A step of activities with both sculpting and modelling. */
    public const APPLIES_BOTH = 'SM';

    /** @var string A step only for devices with VR (the client skips it without VR; the server counts it). */
    public const APPLIES_VR = 'VR';

    /** @var array<string, string> The steps in tour order: key => applies to (TUTORIAL-CONTRACT.md §3). */
    public const STEPS = [
        'welcome' => self::APPLIES_ALL,
        'orbit' => self::APPLIES_ALL,
        'zoom' => self::APPLIES_ALL,
        'pan' => self::APPLIES_ALL,
        'add' => self::APPLIES_SCULPT,
        'carve' => self::APPLIES_SCULPT,
        'smooth' => self::APPLIES_SCULPT,
        'size' => self::APPLIES_SCULPT,
        'strength' => self::APPLIES_SCULPT,
        'inflate' => self::APPLIES_SCULPT,
        'pinch' => self::APPLIES_SCULPT,
        'flatten' => self::APPLIES_SCULPT,
        'grab' => self::APPLIES_SCULPT,
        'twist' => self::APPLIES_SCULPT,
        'mirror' => self::APPLIES_SCULPT,
        'shape' => self::APPLIES_SCULPT,
        'cutshape' => self::APPLIES_SCULPT,
        'undo' => self::APPLIES_SCULPT,
        'redo' => self::APPLIES_SCULPT,
        'switchmodel' => self::APPLIES_BOTH,
        'addshape' => self::APPLIES_MODEL,
        'selectmode' => self::APPLIES_MODEL,
        'select' => self::APPLIES_MODEL,
        'move' => self::APPLIES_MODEL,
        'axis' => self::APPLIES_MODEL,
        'rotate' => self::APPLIES_MODEL,
        'scale' => self::APPLIES_MODEL,
        'extrude' => self::APPLIES_MODEL,
        'inset' => self::APPLIES_MODEL,
        'bevel' => self::APPLIES_MODEL,
        'loopcut' => self::APPLIES_MODEL,
        'merge' => self::APPLIES_MODEL,
        'delete' => self::APPLIES_MODEL,
        'bake' => self::APPLIES_BOTH,
        'save' => self::APPLIES_ALL,
        'versions' => self::APPLIES_ALL,
        'export' => self::APPLIES_ALL,
        'vr' => self::APPLIES_VR,
        'together' => self::APPLIES_ALL,
        'done' => self::APPLIES_ALL,
    ];

    /**
     * @var array<string, string> The steps whose action the tutor can demonstrate: step key => demo name
     * (TUTORIAL-CONTRACT.md §3, Demo column; the names of amd/src/tutordemos.js).
     */
    public const DEMOS = [
        'add' => 'add',
        'carve' => 'carve',
        'smooth' => 'smooth',
        'inflate' => 'inflate',
        'pinch' => 'pinch',
        'flatten' => 'flatten',
        'grab' => 'grab',
        'twist' => 'twist',
        'mirror' => 'mirror',
        'shape' => 'shape',
        'cutshape' => 'cutshape',
        'addshape' => 'addshape',
        'select' => 'select',
        'move' => 'move',
        'rotate' => 'rotate',
        'scale' => 'scale',
        'extrude' => 'extrude',
        'inset' => 'inset',
        'bevel' => 'bevel',
        'loopcut' => 'loopcut',
    ];

    /** @var string The user preference: the answer to the cloud speech recognition question. */
    public const CONSENT_PREFERENCE = 'mod_vrmakerspace_speechconsent';

    /** @var int Longest question a student may ask the tutor, in characters. */
    public const MAX_QUESTION_LENGTH = 500;

    /** @var int Most questions a student may ask the tutor in RATE_WINDOW seconds. */
    public const RATE_LIMIT = 20;

    /** @var int The window of the question limit, in seconds. */
    public const RATE_WINDOW = HOURSECS;

    /**
     * Whether an activity is in tutorial mode.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return bool
     */
    public static function is_enabled(\stdClass $vrmakerspace): bool {
        return !empty($vrmakerspace->tutorial);
    }

    /**
     * Whether the site has an AI provider that generates text (the tutor's answers need one).
     *
     * @return bool
     */
    public static function ai_available(): bool {
        if (!class_exists(\core_ai\manager::class)) {
            return false;
        }
        try {
            return \core\di::get(\core_ai\manager::class)->is_action_available(\core_ai\aiactions\generate_text::class);
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * Whether students of an activity may ask the tutor now: tutorial mode, the teacher's setting, an AI
     * provider for text, and text generation allowed in the activity's context.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \context_module $context its context
     * @return bool
     */
    public static function ai_enabled(\stdClass $vrmakerspace, \context_module $context): bool {
        if (!self::is_enabled($vrmakerspace) || empty($vrmakerspace->tutorai) || !self::ai_available()) {
            return false;
        }
        return \core\di::get(\core_ai\manager::class)
            ->is_action_enabled_in_context($context, \core_ai\aiactions\generate_text::class);
    }

    /**
     * Whether a step applies to an activity's ways of making.
     *
     * @param string $applies one of the APPLIES_* constants
     * @param string $methods one of session_manager::METHODS
     * @return bool
     */
    public static function step_applies(string $applies, string $methods): bool {
        $sculpt = $methods !== session_manager::METHODS_MODEL;
        $model = $methods !== session_manager::METHODS_SCULPT;
        return match ($applies) {
            self::APPLIES_SCULPT => $sculpt,
            self::APPLIES_MODEL => $model,
            self::APPLIES_BOTH => $sculpt && $model,
            default => true,
        };
    }

    /**
     * The steps of an activity with these ways of making, in tour order.
     *
     * @param string $methods the ways of making (cleaned here)
     * @return string[] step keys
     */
    public static function applicable_steps(string $methods): array {
        $methods = session_manager::clean_methods($methods);
        $steps = [];
        foreach (self::STEPS as $key => $applies) {
            if (self::step_applies($applies, $methods)) {
                $steps[] = $key;
            }
        }
        return $steps;
    }

    /**
     * Step keys kept only when they are among the given steps, once each, in tour order.
     *
     * @param array $keys keys (from the client or a backup: untrusted)
     * @param string[] $steps the steps to keep, e.g. applicable_steps()
     * @return string[]
     */
    public static function clean_keys(array $keys, array $steps): array {
        $keys = array_map('strval', $keys);
        return array_values(array_filter($steps, fn($step) => in_array($step, $keys, true)));
    }

    /**
     * Comma-separated keys as a list.
     *
     * @param string|null $list the stored value
     * @return string[]
     */
    public static function split_keys(?string $list): array {
        if ($list === null || trim($list) === '') {
            return [];
        }
        return array_values(array_filter(array_map('trim', explode(',', $list)), fn($key) => $key !== ''));
    }

    /**
     * A student's progress row.
     *
     * @param int $vrmakerspaceid the vrmakerspace id
     * @param int $userid the student
     * @return \stdClass|null
     */
    public static function get_progress(int $vrmakerspaceid, int $userid): ?\stdClass {
        global $DB;
        return $DB->get_record(self::TABLE, ['vrmakerspaceid' => $vrmakerspaceid, 'userid' => $userid]) ?: null;
    }

    /**
     * Every student's progress in an activity.
     *
     * @param int $vrmakerspaceid the vrmakerspace id
     * @return \stdClass[] rows keyed by user id
     */
    public static function get_all_progress(int $vrmakerspaceid): array {
        global $DB;
        $rows = [];
        foreach ($DB->get_records(self::TABLE, ['vrmakerspaceid' => $vrmakerspaceid], 'id ASC') as $row) {
            $rows[(int)$row->userid] = $row;
        }
        return $rows;
    }

    /**
     * A progress row's done and skipped steps, among an activity's steps.
     *
     * @param \stdClass|null $progress the row, or null when the student has not started
     * @param string $methods the activity's ways of making
     * @return array{steps: string[], done: string[], skipped: string[], laststep: string}
     */
    public static function state(?\stdClass $progress, string $methods): array {
        $steps = self::applicable_steps($methods);
        $done = self::clean_keys(self::split_keys($progress->stepsdone ?? ''), $steps);
        $skipped = array_values(array_diff(self::clean_keys(self::split_keys($progress->stepsskipped ?? ''), $steps), $done));
        $laststep = (string)($progress->laststep ?? '');
        return [
            'steps' => $steps,
            'done' => $done,
            'skipped' => $skipped,
            'laststep' => in_array($laststep, $steps, true) ? $laststep : '',
        ];
    }

    /**
     * Whether every applicable step is done or skipped.
     *
     * @param string[] $steps the applicable steps
     * @param string[] $done the steps done
     * @param string[] $skipped the steps skipped
     * @return bool
     */
    public static function is_finished(array $steps, array $done, array $skipped): bool {
        return $steps !== [] && array_diff($steps, $done, $skipped) === [];
    }

    /**
     * Add to a student's progress: keys are only ever added (a skipped step done later counts as done),
     * keys that are not steps of the activity are dropped, and the first time every step is done or
     * skipped the time is recorded.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param int $userid the student
     * @param string $laststep the step the student is on ('' or an unknown key keeps the stored one)
     * @param array $done steps done
     * @param array $skipped steps skipped
     * @return array{progress: \stdClass, finished: bool, newlyfinished: bool}
     */
    public static function save_progress(
        \stdClass $vrmakerspace,
        int $userid,
        string $laststep,
        array $done,
        array $skipped
    ): array {
        global $DB;

        $methods = session_manager::methods($vrmakerspace);
        $progress = self::get_progress((int)$vrmakerspace->id, $userid);
        $state = self::state($progress, $methods);
        $steps = $state['steps'];
        $newdone = self::clean_keys(array_merge($state['done'], $done), $steps);
        $newskipped = array_values(array_diff(self::clean_keys(array_merge($state['skipped'], $skipped), $steps), $newdone));
        $laststep = in_array($laststep, $steps, true) ? $laststep : $state['laststep'];
        $finished = self::is_finished($steps, $newdone, $newskipped);

        $now = time();
        $record = (object)[
            'laststep' => $laststep,
            'stepsdone' => implode(',', $newdone),
            'stepsskipped' => implode(',', $newskipped),
            'timemodified' => $now,
        ];
        $newlyfinished = false;
        if ($progress) {
            $record->id = $progress->id;
            $record->timecompleted = (int)$progress->timecompleted;
            if ($finished && !(int)$progress->timecompleted) {
                $record->timecompleted = $now;
                $newlyfinished = true;
            }
            $DB->update_record(self::TABLE, $record);
            $record = (object)((array)$record + (array)$progress);
        } else {
            $record->vrmakerspaceid = (int)$vrmakerspace->id;
            $record->userid = $userid;
            $record->timecompleted = $finished ? $now : 0;
            $newlyfinished = $finished;
            try {
                $record->id = $DB->insert_record(self::TABLE, $record);
            } catch (\dml_write_exception $e) {
                // Another request of the same student created the row first (unique vrmakerspaceid, userid).
                if (!self::get_progress((int)$vrmakerspace->id, $userid)) {
                    throw $e;
                }
                return self::save_progress($vrmakerspace, $userid, $laststep, $done, $skipped);
            }
        }
        return ['progress' => $record, 'finished' => (int)$record->timecompleted > 0, 'newlyfinished' => $newlyfinished];
    }

    /**
     * The studio's tutorial configuration (TUTORIAL-CONTRACT.md §2), or null outside tutorial mode.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \context_module $context its context
     * @param int $userid the student
     * @param bool $readonly whether the studio only shows a piece (no tour then)
     * @return array|null
     */
    public static function studio_config(\stdClass $vrmakerspace, \context_module $context, int $userid, bool $readonly): ?array {
        if (!self::is_enabled($vrmakerspace) || $readonly) {
            return null;
        }
        $state = self::state(self::get_progress((int)$vrmakerspace->id, $userid), session_manager::methods($vrmakerspace));
        $ai = self::ai_enabled($vrmakerspace, $context);
        return [
            'enabled' => true,
            'steps' => $state['steps'],
            'done' => $state['done'],
            'skipped' => $state['skipped'],
            'laststep' => $state['laststep'],
            'ai' => $ai,
            'aipolicy' => $ai && (bool)\core_ai\manager::get_user_policy_status($userid),
        ];
    }

    /**
     * A student's progress for the activity page.
     *
     * @param \stdClass|null $progress the row, or null when the student has not started
     * @param string $methods the activity's ways of making
     * @return array{started: bool, finished: bool, done: int, skipped: int, total: int, text: string}
     */
    public static function summary(?\stdClass $progress, string $methods): array {
        $state = self::state($progress, $methods);
        $finished = $progress && (int)$progress->timecompleted > 0;
        $started = $progress && ($state['done'] || $state['skipped'] || $state['laststep'] !== '');
        $counts = ['done' => count($state['done']), 'skipped' => count($state['skipped']), 'total' => count($state['steps'])];
        if ($finished) {
            $text = get_string('tutorialfinished', 'vrmakerspace', userdate((int)$progress->timecompleted));
        } else if ($started) {
            $text = get_string('tutorialprogress', 'vrmakerspace', (object)$counts);
        } else {
            $text = get_string('tutorialnotstarted', 'vrmakerspace');
        }
        return ['started' => (bool)$started, 'finished' => (bool)$finished, 'text' => $text] + $counts;
    }

    /**
     * Delete the progress of every student of an activity.
     *
     * @param int $vrmakerspaceid the vrmakerspace id
     * @return void
     */
    public static function delete_for_activity(int $vrmakerspaceid): void {
        global $DB;
        $DB->delete_records(self::TABLE, ['vrmakerspaceid' => $vrmakerspaceid]);
    }

    /**
     * Delete the progress of some students of an activity.
     *
     * @param int $vrmakerspaceid the vrmakerspace id
     * @param int[] $userids the students
     * @return void
     */
    public static function delete_for_users(int $vrmakerspaceid, array $userids): void {
        global $DB;
        if (!$userids) {
            return;
        }
        [$usersql, $params] = $DB->get_in_or_equal(array_map('intval', $userids), SQL_PARAMS_NAMED);
        $params['vrmakerspaceid'] = $vrmakerspaceid;
        $DB->delete_records_select(self::TABLE, "vrmakerspaceid = :vrmakerspaceid AND userid $usersql", $params);
    }

    /**
     * How many questions a user asked through the AI subsystem in a context in the last RATE_WINDOW seconds.
     *
     * @param int $userid the user
     * @param int $contextid the activity's context id
     * @return int
     */
    public static function recent_questions(int $userid, int $contextid): int {
        global $DB;
        return $DB->count_records_select(
            'ai_action_register',
            'userid = :userid AND contextid = :contextid AND actionname = :actionname AND timecreated > :since',
            [
                'userid' => $userid,
                'contextid' => $contextid,
                'actionname' => 'generate_text',
                'since' => time() - self::RATE_WINDOW,
            ]
        );
    }

    /**
     * The demos of an activity with these ways of making, in tour order.
     *
     * @param string $methods the ways of making (cleaned here)
     * @return string[] demo names
     */
    public static function applicable_demos(string $methods): array {
        $demos = [];
        foreach (self::applicable_steps($methods) as $step) {
            if (isset(self::DEMOS[$step]) && !in_array(self::DEMOS[$step], $demos, true)) {
                $demos[] = self::DEMOS[$step];
            }
        }
        return $demos;
    }

    /**
     * Whether students of an activity may speak to the tutor (tutorial mode and the teacher's setting;
     * whether the site can listen is the speech registry's question).
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return bool
     */
    public static function listen_enabled(\stdClass $vrmakerspace): bool {
        return self::is_enabled($vrmakerspace) && !empty($vrmakerspace->tutorlisten);
    }

    /**
     * Whether the tutor of an activity speaks (tutorial mode and the teacher's setting).
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return bool
     */
    public static function speak_enabled(\stdClass $vrmakerspace): bool {
        return self::is_enabled($vrmakerspace) && !empty($vrmakerspace->tutorspeak);
    }

    /**
     * The language the tutor speaks and listens in: the current user's, as a BCP 47 tag (e.g. en, pt-BR).
     *
     * As mod_talkwithai's attempt_manager::speech_language() without an activity setting.
     *
     * @return string
     */
    public static function speech_language(): string {
        $parts = explode('_', current_language());
        return $parts[0] . (isset($parts[1]) && strlen($parts[1]) === 2 ? '-' . strtoupper($parts[1]) : '');
    }

    /**
     * The tutor's voice, female or male: the site's default voice of the Ollama speech engine (the other
     * engines use their own default voice; the browser picks a voice of this kind).
     *
     * @return string
     */
    public static function voice_name(): string {
        $voice = (string)get_config('mod_vrmakerspace', 'ollamavoice');
        return in_array($voice, \mod_vrmakerspace\speech\engine\ollama::GENDERS, true) ? $voice : 'female';
    }

    /**
     * The studio's voice configuration (TUTORIAL-VOICE-CONTRACT.md §7): the order in which the browser tries
     * to listen and to speak (registry::client_order(), empty when the activity's switch is off or the
     * site has no way), the language, the voice, whether the browser's cloud recognition is allowed, and
     * whether the user agreed to it.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param int $userid the user
     * @return array
     */
    public static function voice_config(\stdClass $vrmakerspace, int $userid): array {
        return [
            'listen' => self::listen_enabled($vrmakerspace) ? registry::client_order(registry::LISTEN) : [],
            'speak' => self::speak_enabled($vrmakerspace) ? registry::client_order(registry::SPEAK) : [],
            'language' => self::speech_language(),
            'voicename' => self::voice_name(),
            'browserstt' => (bool)get_config('mod_vrmakerspace', 'browserstt'),
            'cloudconsent' => (bool)get_user_preferences(self::CONSENT_PREFERENCE, 0, $userid),
        ];
    }

    /**
     * A step's title and text as one plain text to be read aloud, or '' for an unknown step.
     *
     * @param string $key the step key
     * @return string
     */
    public static function step_speech(string $key): string {
        if (!isset(self::STEPS[$key])) {
            return '';
        }
        $title = self::plain_string('tutorial_step_' . $key . '_title');
        $text = self::plain_string('tutorial_step_' . $key . '_text');
        if ($title !== '' && $text !== '' && !preg_match('/[.!?:\x{3002}\x{FF01}\x{FF1F}]$/u', $title)) {
            $title .= '.';
        }
        return trim($title . ' ' . $text);
    }

    /**
     * The AI's reply as the answer and the demo to give (TUTORIAL-VOICE-CONTRACT.md §6), read leniently
     * as mod_talkwithai's response_parser (same author) reads its persona's: the JSON object, a JSON
     * object inside other text, a broken object's "answer", or else the whole reply as the answer. The
     * demo is kept only when it is one of $demos.
     *
     * @param string $text the generated text
     * @param string[] $demos the demos the activity has (applicable_demos())
     * @return array{answer: string, demo: string} the answer as plain text ('' when there is none), the demo or ''
     */
    public static function parse_answer(string $text, array $demos): array {
        $body = trim($text);
        // Code fences, if the AI wrapped the JSON in them.
        // phpcs:disable moodle.Strings.ForbiddenStrings.Found
        $body = preg_replace('/^```(?:json)?\s*/i', '', $body);
        $body = preg_replace('/\s*```$/', '', $body);
        // phpcs:enable moodle.Strings.ForbiddenStrings.Found

        $data = json_decode($body, true);
        if (!is_array($data) && preg_match('/\{.*\}/s', $body, $matches)) {
            // Some models add a sentence before or after the JSON object.
            $data = json_decode($matches[0], true);
        }

        $demo = '';
        if (is_array($data)) {
            $answer = $data['answer'] ?? $data['reply'] ?? $data['text'] ?? '';
            $answer = is_scalar($answer) ? (string)$answer : '';
            $demo = is_string($data['demo'] ?? null) ? $data['demo'] : '';
        } else if (preg_match('/"answer"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/s', $body, $matches)) {
            // Broken JSON: take the answer, and the demo if it is there.
            $answer = stripcslashes($matches[1]);
            if (preg_match('/"demo"\s*:\s*"([a-z]+)"/i', $body, $matches)) {
                $demo = $matches[1];
            }
        } else {
            $answer = $body;
        }
        $demo = strtolower(trim($demo));
        return [
            'answer' => self::clean_answer($answer),
            'demo' => in_array($demo, $demos, true) ? $demo : '',
        ];
    }

    /**
     * An answer as plain text without markup that would be shown or read aloud literally: tags, markdown
     * emphasis, headings, list bullets and emoji (as mod_talkwithai's response_parser::clean_for_speech()).
     *
     * @param string $text the answer
     * @return string plain text, '' when nothing is left
     */
    public static function clean_answer(string $text): string {
        $text = strip_tags($text);
        $text = preg_replace('/(\*\*|__)(.+?)\1/u', '$2', $text);
        $text = str_replace(['**', '__', '#', chr(96)], '', $text);
        $text = preg_replace('/^\s*[-*\x{2022}]\s+/mu', '', $text);
        $text = preg_replace('/[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{FE0F}]/u', '', $text);
        $text = preg_replace('/\s+/u', ' ', $text);
        return trim((string)clean_param($text, PARAM_TEXT));
    }

    /**
     * The cache key of a user's latest answer in an activity.
     *
     * @param int $userid the user
     * @param int $cmid the course module id
     * @return string
     */
    private static function answer_key(int $userid, int $cmid): string {
        return $userid . '_' . $cmid;
    }

    /**
     * Keep the tutor's latest answer to a user in an activity, the only AI text tutor_speak() speaks.
     *
     * @param int $userid the user
     * @param int $cmid the course module id
     * @param string $answer the answer
     * @return void
     */
    public static function remember_answer(int $userid, int $cmid, string $answer): void {
        \cache::make('mod_vrmakerspace', 'tutoranswer')->set(self::answer_key($userid, $cmid), $answer);
    }

    /**
     * The tutor's latest answer to a user in an activity, or null when there is none (or it has expired).
     *
     * @param int $userid the user
     * @param int $cmid the course module id
     * @return string|null
     */
    public static function latest_answer(int $userid, int $cmid): ?string {
        $answer = \cache::make('mod_vrmakerspace', 'tutoranswer')->get(self::answer_key($userid, $cmid));
        return is_string($answer) && $answer !== '' ? $answer : null;
    }

    /**
     * A lang string as plain text, or '' when the string does not exist.
     *
     * @param string $key the key in mod_vrmakerspace
     * @return string
     */
    private static function plain_string(string $key): string {
        if (!get_string_manager()->string_exists($key, 'vrmakerspace')) {
            return '';
        }
        $text = html_entity_decode(strip_tags(get_string($key, 'vrmakerspace')), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace('/\s+/u', ' ', $text));
    }

    /**
     * A step's title and text as plain text, one line.
     *
     * @param string $key the step key
     * @return string
     */
    private static function step_line(string $key): string {
        $title = self::plain_string('tutorial_step_' . $key . '_title');
        $text = self::plain_string('tutorial_step_' . $key . '_text');
        return trim($title . ($title !== '' && $text !== '' ? ': ' : '') . $text);
    }

    /**
     * The prompt sent to the AI for a student's question (TUTORIAL-CONTRACT.md §2): the fixed instruction,
     * the answer format (JSON with the answer and a demo, TUTORIAL-VOICE-CONTRACT.md §6), every applicable
     * step, the keyboard and VR help, the demos the tutor can give, the current step, then the question.
     *
     * Strings are in the current user's language.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param string $step the step the student is on (unknown keys are ignored)
     * @param string $question the student's question (already checked)
     * @return string
     */
    public static function build_prompt(\stdClass $vrmakerspace, string $step, string $question): string {
        $steps = self::applicable_steps(session_manager::methods($vrmakerspace));
        $name = self::plain_string('tutor_name');
        $parts = [get_string('tutor_aiprompt', 'vrmakerspace', (object)[
            'name' => $name !== '' ? $name : get_string('modulename', 'vrmakerspace'),
            'language' => get_string('thislanguage', 'langconfig'),
        ]), get_string('tutor_aipromptjson', 'vrmakerspace')];

        $lines = [];
        foreach ($steps as $key) {
            $line = self::step_line($key);
            if ($line !== '') {
                $lines[] = '- ' . $line;
            }
        }
        $parts[] = "Tutorial steps:\n" . implode("\n", $lines);

        $help = [];
        foreach (['shortcuts', 'modelshortcuts', 'vrhelp', 'vrmodelhelp'] as $key) {
            $text = self::plain_string($key);
            if ($text !== '') {
                $help[] = '- ' . $text;
            }
        }
        $parts[] = "Controls:\n" . implode("\n", $help);

        // The demonstrations the tutor can give in this activity, each with the step it belongs to.
        $demos = [];
        foreach ($steps as $key) {
            if (isset(self::DEMOS[$key])) {
                $line = self::step_line($key);
                $demos[] = '- ' . self::DEMOS[$key] . ($line !== '' ? ': ' . $line : '');
            }
        }
        $parts[] = "Demonstrations you can give (name: what it shows):\n" . ($demos ? implode("\n", $demos) : '- none');

        if (in_array($step, $steps, true)) {
            $parts[] = "The student is on this step:\n" . self::step_line($step);
        }
        $parts[] = "The student's question:\n" . trim($question);
        return implode("\n\n", $parts);
    }
}
