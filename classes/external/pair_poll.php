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
 * Stay connected to a pair-work piece and fetch the partner's connection messages.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class pair_poll extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'sessionid' => new external_value(PARAM_INT, 'Session id'),
            'peerkey' => new external_value(PARAM_ALPHANUM, 'The caller\'s peer key'),
            'afterid' => new external_value(
                PARAM_INT,
                'Id of the last message received (deleted with older ones)',
                VALUE_DEFAULT,
                0
            ),
        ]);
    }

    /**
     * Poll.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @param string $peerkey the caller's peer key
     * @param int $afterid id of the last message received
     * @return array the caller's role, the others connected, the waiting messages
     */
    public static function execute(int $cmid, int $sessionid, string $peerkey, int $afterid = 0): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'sessionid' => $sessionid,
            'peerkey' => $peerkey,
            'afterid' => $afterid,
        ]);
        [$vrmakerspace, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        helper::require_sculptor($session, $context, (int)$USER->id);
        helper::require_pair_work($vrmakerspace);

        $polled = pair_manager::poll($session, $context, (int)$USER->id, $params['peerkey'], $params['afterid']);
        return [
            'role' => (string)$polled['peer']->role,
            'peers' => $polled['peers'],
            'signals' => $polled['signals'],
        ];
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'role' => new external_value(PARAM_ALPHA, 'The caller\'s role now: host or guest'),
            'peers' => helper::peers_structure(),
            'signals' => new external_multiple_structure(new external_single_structure([
                'id' => new external_value(PARAM_INT, 'Message id: send the highest as afterid next time'),
                'frompeerkey' => new external_value(PARAM_ALPHANUM, 'The sender\'s peer key'),
                'payload' => new external_value(PARAM_RAW, 'The message as sent'),
            ])),
        ]);
    }
}
