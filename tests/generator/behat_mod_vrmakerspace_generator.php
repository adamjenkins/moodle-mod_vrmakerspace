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
 * Behat data generator for mod_vrmakerspace: saved versions of a student's sculpture.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class behat_mod_vrmakerspace_generator extends behat_generator_base {
    /**
     * The entities Behat can create: Given the following "mod_vrmakerspace > versions" exist.
     *
     * @return array
     */
    protected function get_creatable_entities(): array {
        return [
            'versions' => [
                'singular' => 'version',
                'datagenerator' => 'version',
                'required' => ['activity', 'user'],
                'switchids' => ['activity' => 'vrmakerspaceid', 'user' => 'userid'],
            ],
        ];
    }

    /**
     * The vrmakerspace id of an activity, from its idnumber.
     *
     * @param string $idnumber the course module idnumber
     * @return int
     */
    protected function get_activity_id(string $idnumber): int {
        global $DB;
        $cm = $DB->get_record('course_modules', ['idnumber' => $idnumber], 'instance', MUST_EXIST);
        return (int)$cm->instance;
    }
}
