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

use core_external\external_multiple_structure;
use core_external\external_single_structure;
use core_external\external_value;
use mod_vrsculpt\local\pair_manager;
use mod_vrsculpt\local\session_manager;

/**
 * Shared code of the mod_vrsculpt web services.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class helper {
    /**
     * The activity, context and session of a request; the session must belong to the activity.
     *
     * Validates the context (login, course access) as a side effect.
     *
     * @param int $cmid the course module id
     * @param int $sessionid the session id
     * @return array [\stdClass $vrsculpt, \cm_info $cm, \context_module $context, \stdClass $session]
     */
    public static function load(int $cmid, int $sessionid): array {
        global $DB;
        [, $cm] = get_course_and_cm_from_cmid($cmid, 'vrsculpt');
        $context = \context_module::instance($cm->id);
        \core_external\external_api::validate_context($context);
        $vrsculpt = $DB->get_record('vrsculpt', ['id' => $cm->instance], '*', MUST_EXIST);
        $session = session_manager::get_session($sessionid, $vrsculpt);
        return [$vrsculpt, $cm, $context, $session];
    }

    /**
     * Refuse a user who may not sculpt a session: the capability, an open session, one of its owners.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user
     * @return void
     * @throws \required_capability_exception without mod/vrsculpt:sculpt
     * @throws \moodle_exception cannotsculpt
     */
    public static function require_sculptor(\stdClass $session, \context_module $context, int $userid): void {
        require_capability('mod/vrsculpt:sculpt', $context);
        if (!session_manager::can_sculpt($session, $context, $userid)) {
            throw new \moodle_exception('cannotsculpt', 'mod_vrsculpt');
        }
    }

    /**
     * The state of a session.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user asking
     * @return array see state_structure()
     */
    public static function state(\stdClass $vrsculpt, \stdClass $session, \context_module $context, int $userid): array {
        $latest = session_manager::get_latest_snapshot((int)$session->id);
        return [
            'sessionid' => (int)$session->id,
            'connection' => session_manager::is_group_work($vrsculpt) ? session_manager::connection($vrsculpt) : '',
            'startmodel' => session_manager::clean_start_model((string)$session->startmodel),
            'status' => (int)$session->status,
            'cansculpt' => session_manager::can_sculpt($session, $context, $userid),
            'version' => $latest ? (int)$latest->version : 0,
            'opcount' => $latest ? (int)$latest->opcount : 0,
            'timesaved' => $latest ? (int)$latest->timecreated : 0,
            'url' => $latest ? session_manager::snapshot_url($latest, $context)->out(false) : '',
        ];
    }

    /**
     * Structure of a session's state.
     *
     * @return external_single_structure
     */
    public static function state_structure(): external_single_structure {
        return new external_single_structure([
            'sessionid' => new external_value(PARAM_INT, 'Session id'),
            'connection' => new external_value(PARAM_ALPHA, 'Group work: pair or companion; empty for individual work'),
            'startmodel' => new external_value(PARAM_ALPHA, 'Starting model: lump, sphere or cube'),
            'status' => new external_value(PARAM_INT, '0 = open, 1 = closed'),
            'cansculpt' => new external_value(PARAM_BOOL, 'Whether the user may save versions'),
            'version' => new external_value(PARAM_INT, 'Latest saved version, 0 when none'),
            'opcount' => new external_value(PARAM_INT, 'Operations applied up to the latest version'),
            'timesaved' => new external_value(PARAM_INT, 'When the latest version was saved, 0 when none'),
            'url' => new external_value(PARAM_URL, 'URL of the latest version\'s data, empty when none'),
        ]);
    }

    /**
     * Refuse a pair-work call for an activity whose sculptures are not sculpted in pairs.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @return void
     * @throws \moodle_exception notpairwork
     */
    public static function require_pair_work(\stdClass $vrsculpt): void {
        if (!pair_manager::allowed($vrsculpt)) {
            throw new \moodle_exception('notpairwork', 'mod_vrsculpt');
        }
    }

    /**
     * Structure of the other people connected to a pair-work sculpture.
     *
     * @return external_multiple_structure
     */
    public static function peers_structure(): external_multiple_structure {
        return new external_multiple_structure(new external_single_structure([
            'userid' => new external_value(PARAM_INT, 'User id'),
            'name' => new external_value(PARAM_RAW, 'Display name, plain text (escape it where it is shown)'),
            'peerkey' => new external_value(PARAM_ALPHANUM, 'Peer key (32 hex)'),
            'role' => new external_value(PARAM_ALPHA, 'host or guest'),
        ]));
    }
}
