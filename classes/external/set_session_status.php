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

/**
 * Close or reopen a sculpture.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class set_session_status extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'sessionid' => new external_value(PARAM_INT, 'Session id'),
            'status' => new external_value(PARAM_INT, '0 = open, 1 = closed'),
        ]);
    }

    /**
     * Change the status.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @param int $status 0 = open, 1 = closed
     * @return array the session's new state
     */
    public static function execute(int $cmid, int $sessionid, int $status): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'sessionid' => $sessionid,
            'status' => $status,
        ]);
        [$vrmakerspace, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        require_capability('mod/vrmakerspace:managesessions', $context);
        if (!session_manager::can_view($session, $context, (int)$USER->id)) {
            throw new \required_capability_exception($context, 'mod/vrmakerspace:viewallsubmissions', 'nopermissions', '');
        }
        session_manager::set_status($session, (int)$params['status']);
        return helper::state($vrmakerspace, $session, $context, (int)$USER->id);
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return helper::state_structure();
    }
}
