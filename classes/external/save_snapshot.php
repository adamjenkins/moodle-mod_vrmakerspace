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
use mod_vrsculpt\local\session_manager;

/**
 * Save the current sculpture of a session as a new version.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class save_snapshot extends external_api {
    /**
     * Parameters.
     *
     * @return external_function_parameters
     */
    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'cmid' => new external_value(PARAM_INT, 'Course module id'),
            'sessionid' => new external_value(PARAM_INT, 'Session id'),
            'data' => new external_value(PARAM_RAW, 'The sculpture, base64-encoded'),
            'opcount' => new external_value(PARAM_INT, 'Operations applied since the session started', VALUE_DEFAULT, 0),
        ]);
    }

    /**
     * Save the version.
     *
     * @param int $cmid course module id
     * @param int $sessionid session id
     * @param string $data base64 sculpture data
     * @param int $opcount operations applied
     * @return array the session's new state
     */
    public static function execute(int $cmid, int $sessionid, string $data, int $opcount = 0): array {
        global $USER;
        $params = self::validate_parameters(self::execute_parameters(), [
            'cmid' => $cmid,
            'sessionid' => $sessionid,
            'data' => $data,
            'opcount' => $opcount,
        ]);
        [, , $context, $session] = helper::load($params['cmid'], $params['sessionid']);
        require_capability('mod/vrsculpt:sculpt', $context);
        if (!session_manager::can_sculpt($session, $context, (int)$USER->id)) {
            throw new \moodle_exception('cannotsculpt', 'mod_vrsculpt');
        }

        // Base64 is a third larger than the data: refuse oversize input before decoding it.
        if (strlen($params['data']) > intdiv(session_manager::max_snapshot_size() * 4, 3) + 4) {
            throw new \moodle_exception('snapshottoolarge', 'mod_vrsculpt', '', display_size(session_manager::max_snapshot_size()));
        }
        $bytes = base64_decode($params['data'], true);
        if ($bytes === false) {
            throw new \moodle_exception('snapshotinvalid', 'mod_vrsculpt');
        }
        session_manager::save_snapshot($session, $context, (int)$USER->id, $bytes, $params['opcount']);
        return helper::state($session, $context, (int)$USER->id);
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
