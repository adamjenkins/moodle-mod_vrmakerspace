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
 * Upgrade steps for mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/**
 * Upgrade the plugin from an older version.
 *
 * @param int $oldversion the version installed before this upgrade
 * @return bool
 */
function xmldb_vrmakerspace_upgrade($oldversion) {
    global $DB;
    $dbman = $DB->get_manager();

    if ($oldversion < 2026111800) {
        // Tutorial mode: five activity settings and each student's progress.
        $table = new xmldb_table('vrmakerspace');
        $fields = [
            new xmldb_field('tutorial', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0', 'grade'),
            new xmldb_field('tutorai', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0', 'tutorial'),
            new xmldb_field('completiontutorial', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0', 'tutorai'),
            new xmldb_field('tutorlisten', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0', 'completiontutorial'),
            new xmldb_field('tutorspeak', XMLDB_TYPE_INTEGER, '1', null, XMLDB_NOTNULL, null, '0', 'tutorlisten'),
        ];
        foreach ($fields as $field) {
            if (!$dbman->field_exists($table, $field)) {
                $dbman->add_field($table, $field);
            }
        }

        $table = new xmldb_table('vrmakerspace_tutorial');
        $table->add_field('id', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, XMLDB_SEQUENCE, null);
        $table->add_field('vrmakerspaceid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('userid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('laststep', XMLDB_TYPE_CHAR, '40', null, XMLDB_NOTNULL, null, null);
        $table->add_field('stepsdone', XMLDB_TYPE_TEXT, null, null, null, null, null);
        $table->add_field('stepsskipped', XMLDB_TYPE_TEXT, null, null, null, null, null);
        $table->add_field('timecompleted', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_field('timemodified', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_key('primary', XMLDB_KEY_PRIMARY, ['id']);
        $table->add_key('vrmakerspaceid', XMLDB_KEY_FOREIGN, ['vrmakerspaceid'], 'vrmakerspace', ['id']);
        $table->add_index('vrmakerspaceuser', XMLDB_INDEX_UNIQUE, ['vrmakerspaceid', 'userid']);
        $table->add_index('userid', XMLDB_INDEX_NOTUNIQUE, ['userid']);
        if (!$dbman->table_exists($table)) {
            $dbman->create_table($table);
        }

        upgrade_mod_savepoint(true, 2026111800, 'vrmakerspace');
    }

    return true;
}
