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
use core_external\external_multiple_structure;
use core_external\external_single_structure;
use core_external\external_value;
use mod_vrmakerspace\local\tutorial;

/**
 * Record the tutorial steps the user has done or skipped, and the step they are on.
 *
 * Keys are only ever added, and only steps of the activity are kept (tutorial::save_progress()). The
 * first time every step is done or skipped, the tutorial_completed event is triggered and the activity's
 * completion state is updated.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class save_tutorial_progress extends external_api {
    /** @var int Most keys accepted in one list (more than the tour has steps). */
    private const MAX_KEYS = 100;

    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'laststep' => new external_value(PARAM_ALPHANUMEXT, 'The step the user is on', VALUE_DEFAULT, ''),
            'done' => new external_multiple_structure(
                new external_value(PARAM_ALPHANUMEXT, 'Step key'),
                'Steps done',
                VALUE_DEFAULT,
                []
            ),
            'skipped' => new external_multiple_structure(
                new external_value(PARAM_ALPHANUMEXT, 'Step key'),
                'Steps skipped',
                VALUE_DEFAULT,
                []
            ),
        ]);
    }

    /**
     * Save the progress.
     *
     * @param int $cmid course module id
     * @param string $laststep the step the user is on
     * @param string[] $done steps done
     * @param string[] $skipped steps skipped
     * @return array ['finished' => bool, 'timecompleted' => int]
     */
    public static function execute(int $cmid, string $laststep = '', array $done = [], array $skipped = []): array {
        global $CFG, $DB, $USER;
        require_once($CFG->libdir . '/completionlib.php');

        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'laststep' => $laststep,
            'done' => $done,
            'skipped' => $skipped,
        ]);
        [$course, $cm] = get_course_and_cm_from_cmid($params['cmid'], 'vrmakerspace');
        $context = \context_module::instance($cm->id);
        self::validate_context($context);
        require_capability('mod/vrmakerspace:view', $context);
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);
        if (!tutorial::is_enabled($vrmakerspace)) {
            throw new \moodle_exception('error_nottutorial', 'mod_vrmakerspace');
        }

        $result = tutorial::save_progress(
            $vrmakerspace,
            (int)$USER->id,
            (string)$params['laststep'],
            array_slice($params['done'], 0, self::MAX_KEYS),
            array_slice($params['skipped'], 0, self::MAX_KEYS)
        );
        $progress = $result['progress'];

        if ($result['newlyfinished']) {
            $event = \mod_vrmakerspace\event\tutorial_completed::create([
                'objectid' => (int)$progress->id,
                'context' => $context,
                'relateduserid' => (int)$USER->id,
                'other' => ['vrmakerspaceid' => (int)$vrmakerspace->id],
            ]);
            $event->add_record_snapshot('vrmakerspace', $vrmakerspace);
            $event->trigger();

            $completion = new \completion_info($course);
            if ($completion->is_enabled($cm) && !empty($vrmakerspace->completiontutorial)) {
                $completion->update_state($cm, COMPLETION_COMPLETE, (int)$USER->id);
            }
        }

        return ['finished' => $result['finished'], 'timecompleted' => (int)$progress->timecompleted];
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'finished' => new external_value(PARAM_BOOL, 'Whether every step is done or skipped'),
            'timecompleted' => new external_value(PARAM_INT, 'When the tutorial was first finished, 0 until then'),
        ]);
    }
}
