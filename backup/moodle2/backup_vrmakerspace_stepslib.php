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
 * Backup structure step for mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/**
 * Defines the structure of vrmakerspace.xml.
 *
 * The activity always; with user data, the pieces (sessions) with their versions (snapshots, and
 * their files) and their members' shares (contributions), and the grades. A grade is written as
 * usergrade so no element contains a child of its own name. Live connections of pair work (peers and
 * their messages) last minutes and are never backed up.
 */
class backup_vrmakerspace_activity_structure_step extends backup_activity_structure_step {
    /**
     * Build the element tree.
     *
     * @return backup_nested_element
     */
    protected function define_structure() {
        $userinfo = $this->get_setting_value('userinfo');

        $vrmakerspace = new backup_nested_element('vrmakerspace', ['id'], [
            'name', 'intro', 'introformat', 'methods', 'startmodel', 'workmode', 'connectmode', 'maxusers',
            'trackcontributions', 'grade', 'timecreated', 'timemodified',
        ]);

        $sessions = new backup_nested_element('sessions');
        $session = new backup_nested_element('session', ['id'], [
            'groupid', 'userid', 'startmodel', 'status', 'timecreated', 'timemodified',
        ]);

        $snapshots = new backup_nested_element('snapshots');
        $snapshot = new backup_nested_element('snapshot', ['id'], [
            'version', 'userid', 'opcount', 'filesize', 'timecreated',
        ]);

        $contributions = new backup_nested_element('contributions');
        $contribution = new backup_nested_element('contribution', ['id'], [
            'userid', 'ops', 'added', 'removed', 'timemodified', 'lastreport',
        ]);

        $usergrades = new backup_nested_element('usergrades');
        $usergrade = new backup_nested_element('usergrade', ['id'], [
            'userid', 'grade', 'grader', 'timecreated', 'timemodified',
        ]);

        $vrmakerspace->add_child($sessions);
        $sessions->add_child($session);
        $session->add_child($snapshots);
        $snapshots->add_child($snapshot);
        $session->add_child($contributions);
        $contributions->add_child($contribution);
        $vrmakerspace->add_child($usergrades);
        $usergrades->add_child($usergrade);

        $vrmakerspace->set_source_table('vrmakerspace', ['id' => backup::VAR_ACTIVITYID]);
        if ($userinfo) {
            $session->set_source_table('vrmakerspace_sessions', ['vrmakerspaceid' => backup::VAR_PARENTID], 'id ASC');
            $snapshot->set_source_table('vrmakerspace_snapshots', ['sessionid' => backup::VAR_PARENTID], 'version ASC');
            $contribution->set_source_table('vrmakerspace_contrib', ['sessionid' => backup::VAR_PARENTID], 'id ASC');
            $usergrade->set_source_table('vrmakerspace_grades', ['vrmakerspaceid' => backup::VAR_PARENTID], 'id ASC');
        }

        $session->annotate_ids('group', 'groupid');
        $session->annotate_ids('user', 'userid');
        $snapshot->annotate_ids('user', 'userid');
        $contribution->annotate_ids('user', 'userid');
        $usergrade->annotate_ids('user', 'userid');
        $usergrade->annotate_ids('user', 'grader');

        $vrmakerspace->annotate_files('mod_vrmakerspace', 'intro', null);
        $vrmakerspace->annotate_files('mod_vrmakerspace', 'startmodel', null);
        $snapshot->annotate_files('mod_vrmakerspace', 'snapshots', 'id');

        return $this->prepare_activity_structure($vrmakerspace);
    }
}
