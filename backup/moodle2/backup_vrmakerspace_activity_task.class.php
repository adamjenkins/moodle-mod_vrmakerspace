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
 * Backup task for mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once($CFG->dirroot . '/mod/vrmakerspace/backup/moodle2/backup_vrmakerspace_stepslib.php');

/**
 * Provides the steps to back up one VR Makerspace activity.
 */
class backup_vrmakerspace_activity_task extends backup_activity_task {
    /**
     * No specific settings for this activity.
     *
     * @return void
     */
    protected function define_my_settings() {
    }

    /**
     * One structure step.
     *
     * @return void
     */
    protected function define_my_steps() {
        $this->add_step(new backup_vrmakerspace_activity_structure_step('vrmakerspace_structure', 'vrmakerspace.xml'));
    }

    /**
     * Encode links to index.php and view.php.
     *
     * @param string $content some HTML text that may contain URLs to the activity instance scripts
     * @return string the content with the URLs encoded
     */
    public static function encode_content_links($content) {
        global $CFG;

        $base = preg_quote($CFG->wwwroot, '/');

        // Link to the list of VR Makerspace activities.
        $search = '/(' . $base . '\/mod\/vrmakerspace\/index.php\?id\=)([0-9]+)/';
        $content = preg_replace($search, '$@VRMAKERSPACEINDEX*$2@$', $content);

        // Link to a VR Makerspace activity by course module id.
        $search = '/(' . $base . '\/mod\/vrmakerspace\/view.php\?id\=)([0-9]+)/';
        $content = preg_replace($search, '$@VRMAKERSPACEVIEWBYID*$2@$', $content);

        return $content;
    }
}
