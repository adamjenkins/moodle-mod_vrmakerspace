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

namespace mod_vrsculpt\external;

use core_external\external_api;
use core_external\external_function_parameters;
use core_external\external_single_structure;
use core_external\external_value;
use mod_vrsculpt\local\contribution_manager;

/**
 * Add to the caller's recorded share of a sculpture.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class report_contribution extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'sessionid' => new external_value(PARAM_INT, 'Session id'),
            'ops' => new external_value(PARAM_INT, 'Operations made since the last accepted report'),
            'added' => new external_value(PARAM_FLOAT, 'Clay added since the last accepted report, mm³'),
            'removed' => new external_value(PARAM_FLOAT, 'Clay removed since the last accepted report, mm³'),
        ]);
    }

    /**
     * Record the report.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @param int $ops operations made
     * @param float $added clay added, mm³
     * @param float $removed clay removed, mm³
     * @return array ['accepted' => bool]: false when too soon after the last accepted report (send it again later)
     */
    public static function execute(int $cmid, int $sessionid, int $ops, float $added, float $removed): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'sessionid' => $sessionid,
            'ops' => $ops,
            'added' => $added,
            'removed' => $removed,
        ]);
        [$vrsculpt, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        helper::require_sculptor($session, $context, (int)$USER->id);
        if (empty($vrsculpt->trackcontributions)) {
            throw new \moodle_exception('contributionsnottracked', 'mod_vrsculpt');
        }
        $accepted = contribution_manager::report(
            $session,
            (int)$USER->id,
            (int)$params['ops'],
            (float)$params['added'],
            (float)$params['removed']
        );
        return ['accepted' => $accepted];
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'accepted' => new external_value(PARAM_BOOL, 'Whether the report was counted'),
        ]);
    }
}
