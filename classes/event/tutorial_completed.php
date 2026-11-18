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

namespace mod_vrmakerspace\event;

/**
 * A student finished the tutorial of a tutorial-mode activity: every step done or skipped.
 *
 * objectid is the vrmakerspace_tutorial row, relateduserid the student, other['vrmakerspaceid'] the
 * activity.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class tutorial_completed extends \core\event\base {
    /**
     * Init method.
     *
     * @return void
     */
    protected function init() {
        $this->data['crud'] = 'u';
        $this->data['edulevel'] = self::LEVEL_PARTICIPATING;
        $this->data['objecttable'] = 'vrmakerspace_tutorial';
    }

    /**
     * The event's name.
     *
     * @return string
     */
    public static function get_name() {
        return get_string('event_tutorial_completed', 'mod_vrmakerspace');
    }

    /**
     * What happened, for the logs (not translated, as core's descriptions).
     *
     * @return string
     */
    public function get_description() {
        return "The user with id '{$this->relateduserid}' finished the tutorial of the VR Makerspace activity "
            . "with course module id '{$this->contextinstanceid}'.";
    }

    /**
     * The activity page.
     *
     * @return \moodle_url
     */
    public function get_url() {
        return new \moodle_url('/mod/vrmakerspace/view.php', ['id' => $this->contextinstanceid]);
    }

    /**
     * Check the event's data.
     *
     * @return void
     * @throws \coding_exception when the student or the activity is missing
     */
    protected function validate_data() {
        parent::validate_data();
        if (!isset($this->relateduserid)) {
            throw new \coding_exception('The \'relateduserid\' must be set.');
        }
        if (!isset($this->other['vrmakerspaceid'])) {
            throw new \coding_exception('The \'vrmakerspaceid\' value must be set in other.');
        }
        if ($this->contextlevel != CONTEXT_MODULE) {
            throw new \coding_exception('Context level must be CONTEXT_MODULE.');
        }
    }

    /**
     * Mapping of the object id for backup/restore.
     *
     * @return array
     */
    public static function get_objectid_mapping() {
        return ['db' => 'vrmakerspace_tutorial', 'restore' => 'vrmakerspace_tutorial'];
    }

    /**
     * Mapping of the other values for backup/restore.
     *
     * @return array
     */
    public static function get_other_mapping() {
        return ['vrmakerspaceid' => ['db' => 'vrmakerspace', 'restore' => 'vrmakerspace']];
    }
}
