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

namespace mod_vrsculpt\local;

/**
 * Template data for the activity page.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class view_helper {
    /**
     * One version in the history table.
     *
     * @param \stdClass $snapshot the vrsculpt_snapshots row
     * @param \context_module $context the activity context
     * @param array $authors user id => full name, filled as users are looked up
     * @return array
     */
    public static function snapshot_row(\stdClass $snapshot, \context_module $context, array &$authors): array {
        global $DB;
        $userid = (int)$snapshot->userid;
        if ($userid && !array_key_exists($userid, $authors)) {
            $user = $DB->get_record('user', ['id' => $userid]);
            $authors[$userid] = $user ? fullname($user) : '';
        }
        return [
            'version' => (int)$snapshot->version,
            'savedby' => $userid ? $authors[$userid] : get_string('anonymised', 'vrsculpt'),
            'timesaved' => userdate($snapshot->timecreated),
            'size' => display_size((int)$snapshot->filesize),
            'url' => session_manager::snapshot_url($snapshot, $context)->out(false),
        ];
    }
}
