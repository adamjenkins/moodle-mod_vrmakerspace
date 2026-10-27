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

/**
 * Data generator for mod_vrsculpt.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

use mod_vrsculpt\local\session_manager;

/**
 * Data generator for mod_vrsculpt: activities, sculptures and saved versions.
 */
class mod_vrsculpt_generator extends testing_module_generator {
    /**
     * Create an activity.
     *
     * @param array|stdClass|null $record fields of the vrsculpt row
     * @param array|null $options general options for course module creation
     * @return stdClass the activity record with cmid
     */
    public function create_instance($record = null, ?array $options = null) {
        $record = (array)($record ?? []) + [
            'startmodel' => 'lump',
            'workmode' => session_manager::MODE_INDIVIDUAL,
            'maxusers' => 8,
            'trackcontributions' => 0,
            'grade' => 100,
        ];
        return parent::create_instance($record, $options);
    }

    /**
     * Create (or find) a sculpture.
     *
     * @param array $record vrsculptid, and groupid or userid
     * @return stdClass the session row
     */
    public function create_session(array $record): stdClass {
        global $DB;
        $vrsculpt = $DB->get_record('vrsculpt', ['id' => $record['vrsculptid']], '*', MUST_EXIST);
        return session_manager::get_or_create($vrsculpt, (int)($record['groupid'] ?? 0), (int)($record['userid'] ?? 0));
    }

    /**
     * Save a version of a sculpture.
     *
     * @param stdClass $session the session row
     * @param int $userid who saves it
     * @param string $payload bytes after the magic number
     * @param int $opcount operations applied
     * @return stdClass the snapshot row
     */
    public function create_snapshot(stdClass $session, int $userid, string $payload = 'test', int $opcount = 1): stdClass {
        global $DB;
        $vrsculpt = $DB->get_record('vrsculpt', ['id' => $session->vrsculptid], '*', MUST_EXIST);
        $cm = get_coursemodule_from_instance('vrsculpt', $vrsculpt->id, $vrsculpt->course, false, MUST_EXIST);
        return session_manager::save_snapshot(
            $session,
            context_module::instance($cm->id),
            $userid,
            session_manager::SNAPSHOT_MAGIC . $payload,
            $opcount
        );
    }
}
