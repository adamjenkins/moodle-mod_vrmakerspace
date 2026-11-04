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
 * Restore task for mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once($CFG->dirroot . '/mod/vrmakerspace/backup/moodle2/restore_vrmakerspace_stepslib.php');

/**
 * Provides the steps to restore one VR sculpting activity.
 */
class restore_vrmakerspace_activity_task extends restore_activity_task {
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
        $this->add_step(new restore_vrmakerspace_activity_structure_step('vrmakerspace_structure', 'vrmakerspace.xml'));
    }

    /**
     * Content that the link decoder processes.
     *
     * @return restore_decode_content[]
     */
    public static function define_decode_contents() {
        return [
            new restore_decode_content('vrmakerspace', ['intro'], 'vrmakerspace'),
        ];
    }

    /**
     * Link decoding rules.
     *
     * @return restore_decode_rule[]
     */
    public static function define_decode_rules() {
        return [
            new restore_decode_rule('VRMAKERSPACEVIEWBYID', '/mod/vrmakerspace/view.php?id=$1', 'course_module'),
            new restore_decode_rule('VRMAKERSPACEINDEX', '/mod/vrmakerspace/index.php?id=$1', 'course'),
        ];
    }

    /**
     * Restore log rules for the activity (legacy log entries).
     *
     * @return restore_log_rule[]
     */
    public static function define_restore_log_rules() {
        return [
            new restore_log_rule('vrmakerspace', 'add', 'view.php?id={course_module}', '{vrmakerspace}'),
            new restore_log_rule('vrmakerspace', 'update', 'view.php?id={course_module}', '{vrmakerspace}'),
            new restore_log_rule('vrmakerspace', 'view', 'view.php?id={course_module}', '{vrmakerspace}'),
        ];
    }

    /**
     * Restore log rules for the course (legacy log entries not linked to an instance).
     *
     * @return restore_log_rule[]
     */
    public static function define_restore_log_rules_for_course() {
        return [
            new restore_log_rule('vrmakerspace', 'view all', 'index.php?id={course}', null),
        ];
    }
}
