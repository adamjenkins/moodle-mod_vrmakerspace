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

namespace mod_vrsculpt\task;

use mod_vrsculpt\local\pair_manager;

/**
 * Remove the leftovers of pair work: connection messages and connections nobody polled for an hour.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class cleanup extends \core\task\scheduled_task {
    /**
     * The task's name in the admin pages.
     *
     * @return string
     */
    public function get_name() {
        return get_string('taskcleanup', 'mod_vrsculpt');
    }

    /**
     * Delete expired rows.
     *
     * @return void
     */
    public function execute() {
        $counts = pair_manager::purge_expired();
        mtrace('mod_vrsculpt: removed ' . $counts['peers'] . ' expired connections and ' . $counts['signals']
            . ' expired connection messages.');
    }
}
