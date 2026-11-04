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
use mod_vrmakerspace\local\companion_manager;
use mod_vrmakerspace\local\session_manager;

/**
 * A short-lived token to work on a group piece over the companion service (vrroom-sync).
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class companion_join extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'sessionid' => new external_value(PARAM_INT, 'Session id'),
        ]);
    }

    /**
     * Make the token.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @return array the service address, the token and the room
     */
    public static function execute(int $cmid, int $sessionid): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), ['cmid' => $cmid, 'sessionid' => $sessionid]);
        [$vrmakerspace, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        helper::require_sculptor($session, $context, (int)$USER->id);
        if (
            !session_manager::is_group_work($vrmakerspace)
                || session_manager::connection($vrmakerspace) !== session_manager::CONNECTION_COMPANION
        ) {
            throw new \moodle_exception('notcompanionwork', 'mod_vrmakerspace');
        }
        return companion_manager::join($vrmakerspace, $session, $USER);
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'url' => new external_value(PARAM_RAW, 'WebSocket address of the companion service'),
            'token' => new external_value(PARAM_RAW, 'Join token (a JWT)'),
            'expires' => new external_value(PARAM_INT, 'When the token expires'),
            'room' => new external_value(PARAM_ALPHANUM, 'The piece\'s room id'),
            'peerid' => new external_value(PARAM_ALPHANUM, 'The caller\'s peer id in the room'),
            'name' => new external_value(PARAM_RAW, 'The caller\'s display name, plain text'),
            'max' => new external_value(PARAM_INT, 'Most people in the room'),
        ]);
    }
}
