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
 * Restore structure step for mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

use mod_vrmakerspace\local\session_manager;

/**
 * Restores vrmakerspace.xml.
 *
 * Restore input is untrusted: the activity's settings are normalised as the form's are, a piece
 * whose owner (user or group) was not restored is skipped with its versions and shares, and a grade
 * or share of a user who was not restored is skipped.
 */
class restore_vrmakerspace_activity_structure_step extends restore_activity_structure_step {
    /**
     * The paths of the XML.
     *
     * @return restore_path_element[]
     */
    protected function define_structure() {
        $paths = [new restore_path_element('vrmakerspace', '/activity/vrmakerspace')];
        if ($this->get_setting_value('userinfo')) {
            $paths[] = new restore_path_element('vrmakerspace_session', '/activity/vrmakerspace/sessions/session');
            $paths[] = new restore_path_element(
                'vrmakerspace_snapshot',
                '/activity/vrmakerspace/sessions/session/snapshots/snapshot'
            );
            $paths[] = new restore_path_element(
                'vrmakerspace_contribution',
                '/activity/vrmakerspace/sessions/session/contributions/contribution'
            );
            $paths[] = new restore_path_element('vrmakerspace_usergrade', '/activity/vrmakerspace/usergrades/usergrade');
        }
        return $this->prepare_activity_structure($paths);
    }

    /**
     * The activity.
     *
     * @param array $data the element's data
     * @return void
     */
    protected function process_vrmakerspace($data) {
        global $DB, $CFG;
        require_once($CFG->dirroot . '/mod/vrmakerspace/lib.php');

        $data = vrmakerspace_clean_instance_data((object)$data);
        $data->course = $this->get_courseid();
        $newid = $DB->insert_record('vrmakerspace', $data);
        $this->apply_activity_instance($newid);
    }

    /**
     * One piece.
     *
     * @param array $data the element's data
     * @return void
     */
    protected function process_vrmakerspace_session($data) {
        global $DB;

        $data = (object)$data;
        $oldid = $data->id;
        $data->vrmakerspaceid = $this->get_new_parentid('vrmakerspace');
        $groupid = (int)$data->groupid;
        $userid = (int)$data->userid;
        if (($groupid > 0) === ($userid > 0)) {
            return;
        }
        if ($groupid) {
            $data->groupid = $this->get_mappingid('group', $groupid);
            $data->userid = 0;
        } else {
            $data->userid = $this->get_mappingid('user', $userid);
            $data->groupid = 0;
        }
        if (!$data->groupid && !$data->userid) {
            return;
        }
        $data->startmodel = session_manager::clean_start_model((string)$data->startmodel);
        $data->status = (int)$data->status === session_manager::STATUS_CLOSED
            ? session_manager::STATUS_CLOSED : session_manager::STATUS_OPEN;
        $conditions = ['vrmakerspaceid' => $data->vrmakerspaceid, 'groupid' => $data->groupid, 'userid' => $data->userid];
        if ($DB->record_exists('vrmakerspace_sessions', $conditions)) {
            return;
        }
        $newid = $DB->insert_record('vrmakerspace_sessions', $data);
        $this->set_mapping('vrmakerspace_session', $oldid, $newid);
    }

    /**
     * One version of a piece.
     *
     * @param array $data the element's data
     * @return void
     */
    protected function process_vrmakerspace_snapshot($data) {
        global $DB;

        $data = (object)$data;
        $oldid = $data->id;
        $data->sessionid = $this->get_new_parentid('vrmakerspace_session');
        if (!$data->sessionid) {
            return;
        }
        $data->userid = (int)$data->userid ? (int)$this->get_mappingid('user', $data->userid) : 0;
        $data->version = max(1, (int)$data->version);
        $data->opcount = max(0, (int)$data->opcount);
        if ($DB->record_exists('vrmakerspace_snapshots', ['sessionid' => $data->sessionid, 'version' => $data->version])) {
            return;
        }
        $newid = $DB->insert_record('vrmakerspace_snapshots', $data);
        $this->set_mapping('vrmakerspace_snapshot', $oldid, $newid, true);
    }

    /**
     * One member's share of a piece.
     *
     * @param array $data the element's data
     * @return void
     */
    protected function process_vrmakerspace_contribution($data) {
        global $DB;

        $data = (object)$data;
        $data->sessionid = $this->get_new_parentid('vrmakerspace_session');
        $data->userid = (int)$this->get_mappingid('user', $data->userid);
        if (!$data->sessionid || !$data->userid) {
            return;
        }
        if ($DB->record_exists('vrmakerspace_contrib', ['sessionid' => $data->sessionid, 'userid' => $data->userid])) {
            return;
        }
        $data->ops = max(0, (int)$data->ops);
        $data->added = max(0.0, (float)$data->added);
        $data->removed = max(0.0, (float)$data->removed);
        $data->timemodified = (int)$data->timemodified;
        $data->lastreport = (int)$data->lastreport;
        $DB->insert_record('vrmakerspace_contrib', $data);
    }

    /**
     * One grade.
     *
     * @param array $data the element's data
     * @return void
     */
    protected function process_vrmakerspace_usergrade($data) {
        global $DB;

        $data = (object)$data;
        $data->vrmakerspaceid = $this->get_new_parentid('vrmakerspace');
        $data->userid = $this->get_mappingid('user', $data->userid);
        if (!$data->userid) {
            return;
        }
        if ($DB->record_exists('vrmakerspace_grades', ['vrmakerspaceid' => $data->vrmakerspaceid, 'userid' => $data->userid])) {
            return;
        }
        $data->grader = (int)$data->grader ? (int)$this->get_mappingid('user', $data->grader) : 0;
        $DB->insert_record('vrmakerspace_grades', $data);
    }

    /**
     * Restore the files once the rows exist.
     *
     * @return void
     */
    protected function after_execute() {
        $this->add_related_files('mod_vrmakerspace', 'intro', null);
        $this->add_related_files('mod_vrmakerspace', 'startmodel', null);
        $this->add_related_files('mod_vrmakerspace', 'snapshots', 'vrmakerspace_snapshot');
    }
}
