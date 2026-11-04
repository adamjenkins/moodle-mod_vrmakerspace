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
use mod_vrmakerspace\local\pair_manager;

/**
 * Join a group sculpture to sculpt it with one partner, browser to browser.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class pair_join extends external_api {
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
     * Join.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @return array the caller's peer key and role, the others connected, the ICE servers
     */
    public static function execute(int $cmid, int $sessionid): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), ['cmid' => $cmid, 'sessionid' => $sessionid]);
        [$vrmakerspace, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        helper::require_sculptor($session, $context, (int)$USER->id);
        helper::require_pair_work($vrmakerspace);

        $joined = pair_manager::join($session, $context, (int)$USER->id);
        $peer = $joined['peer'];
        return [
            'peerkey' => (string)$peer->peerkey,
            'role' => (string)$peer->role,
            'userid' => (int)$USER->id,
            'name' => pair_manager::display_name(fullname($USER)),
            'peers' => $joined['peers'],
            'iceservers' => pair_manager::ice_servers((string)$peer->peerkey),
            'pollms' => pair_manager::POLL_MS,
        ];
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'peerkey' => new external_value(PARAM_ALPHANUM, 'The caller\'s peer key (32 hex): send it with every pair call'),
            'role' => new external_value(PARAM_ALPHA, 'host (orders the edits) or guest'),
            'userid' => new external_value(PARAM_INT, 'The caller\'s user id'),
            'name' => new external_value(PARAM_RAW, 'The caller\'s display name, plain text'),
            'peers' => helper::peers_structure(),
            'iceservers' => new external_multiple_structure(new external_single_structure([
                'urls' => new external_multiple_structure(new external_value(PARAM_RAW, 'A STUN or TURN URL')),
                'username' => new external_value(PARAM_RAW, 'TURN user name, empty for none'),
                'credential' => new external_value(PARAM_RAW, 'TURN credential, empty for none'),
            ])),
            'pollms' => new external_value(PARAM_INT, 'How often to call pair_poll, milliseconds'),
        ]);
    }
}
