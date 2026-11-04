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
use mod_vrmakerspace\local\pair_manager;

/**
 * Send a connection message (WebRTC offer, answer or candidates) to the partner's browser.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class pair_signal extends external_api {
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
            'topeerkey' => new external_value(PARAM_ALPHANUM, 'The recipient\'s peer key'),
            'payload' => new external_value(PARAM_RAW, 'The message, at most 65536 bytes'),
        ]);
    }

    /**
     * Send.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @param string $peerkey the caller's peer key
     * @param string $topeerkey the recipient's peer key
     * @param string $payload the message
     * @return array ['ok' => true]
     */
    public static function execute(int $cmid, int $sessionid, string $peerkey, string $topeerkey, string $payload): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'sessionid' => $sessionid,
            'peerkey' => $peerkey,
            'topeerkey' => $topeerkey,
            'payload' => $payload,
        ]);
        [$vrmakerspace, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        helper::require_sculptor($session, $context, (int)$USER->id);
        helper::require_pair_work($vrmakerspace);

        pair_manager::signal($session, (int)$USER->id, $params['peerkey'], $params['topeerkey'], $params['payload']);
        return ['ok' => true];
    }

    /**
     * Return structure.
     *
     * @return external_single_structure
     */
    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'ok' => new external_value(PARAM_BOOL, 'Always true: failures are errors'),
        ]);
    }
}
