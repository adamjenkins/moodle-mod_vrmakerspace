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
 * Upgrade steps for mod_vrsculpt.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/**
 * Upgrade the plugin from an older version.
 *
 * Every step checks what exists before it changes anything, so a step interrupted on a database
 * without transactional DDL (MySQL, MariaDB) can be run again.
 *
 * @param int $oldversion the version installed before this upgrade
 * @return bool
 */
function xmldb_vrsculpt_upgrade($oldversion) {
    global $DB;
    $dbman = $DB->get_manager();

    if ($oldversion < 2026102701) {
        // The connection of group work: pair (built in) or companion (the companion service).
        $table = new xmldb_table('vrsculpt');
        $field = new xmldb_field('connectmode', XMLDB_TYPE_CHAR, '10', null, XMLDB_NOTNULL, null, 'pair', 'workmode');
        if (!$dbman->field_exists($table, $field)) {
            $dbman->add_field($table, $field);
        }

        // People connected to a group sculpture in pair work.
        $table = new xmldb_table('vrsculpt_peers');
        $table->add_field('id', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, XMLDB_SEQUENCE, null);
        $table->add_field('sessionid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('userid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('peerkey', XMLDB_TYPE_CHAR, '32', null, XMLDB_NOTNULL, null, null);
        $table->add_field('role', XMLDB_TYPE_CHAR, '5', null, XMLDB_NOTNULL, null, null);
        $table->add_field('lastseen', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_field('timecreated', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_key('primary', XMLDB_KEY_PRIMARY, ['id']);
        $table->add_key('sessionid', XMLDB_KEY_FOREIGN, ['sessionid'], 'vrsculpt_sessions', ['id']);
        $table->add_index('sessionuser', XMLDB_INDEX_UNIQUE, ['sessionid', 'userid']);
        $table->add_index('peerkey', XMLDB_INDEX_NOTUNIQUE, ['peerkey']);
        $table->add_index('userid', XMLDB_INDEX_NOTUNIQUE, ['userid']);
        if (!$dbman->table_exists($table)) {
            $dbman->create_table($table);
        }

        // Connection messages between the two browsers of pair work.
        $table = new xmldb_table('vrsculpt_signals');
        $table->add_field('id', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, XMLDB_SEQUENCE, null);
        $table->add_field('sessionid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('frompeerkey', XMLDB_TYPE_CHAR, '32', null, XMLDB_NOTNULL, null, null);
        $table->add_field('topeerkey', XMLDB_TYPE_CHAR, '32', null, XMLDB_NOTNULL, null, null);
        $table->add_field('fromuserid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('payload', XMLDB_TYPE_TEXT, null, null, XMLDB_NOTNULL, null, null);
        $table->add_field('timecreated', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_key('primary', XMLDB_KEY_PRIMARY, ['id']);
        $table->add_key('sessionid', XMLDB_KEY_FOREIGN, ['sessionid'], 'vrsculpt_sessions', ['id']);
        $table->add_index('sessionto', XMLDB_INDEX_NOTUNIQUE, ['sessionid', 'topeerkey']);
        $table->add_index('fromuserid', XMLDB_INDEX_NOTUNIQUE, ['fromuserid']);
        $table->add_index('timecreated', XMLDB_INDEX_NOTUNIQUE, ['timecreated']);
        if (!$dbman->table_exists($table)) {
            $dbman->create_table($table);
        }

        // Each member's share of a group sculpture.
        $table = new xmldb_table('vrsculpt_contrib');
        $table->add_field('id', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, XMLDB_SEQUENCE, null);
        $table->add_field('sessionid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('userid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, null);
        $table->add_field('ops', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_field('added', XMLDB_TYPE_NUMBER, '12, 2', null, XMLDB_NOTNULL, null, '0');
        $table->add_field('removed', XMLDB_TYPE_NUMBER, '12, 2', null, XMLDB_NOTNULL, null, '0');
        $table->add_field('timemodified', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_field('lastreport', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
        $table->add_key('primary', XMLDB_KEY_PRIMARY, ['id']);
        $table->add_key('sessionid', XMLDB_KEY_FOREIGN, ['sessionid'], 'vrsculpt_sessions', ['id']);
        $table->add_index('sessionuser', XMLDB_INDEX_UNIQUE, ['sessionid', 'userid']);
        $table->add_index('userid', XMLDB_INDEX_NOTUNIQUE, ['userid']);
        if (!$dbman->table_exists($table)) {
            $dbman->create_table($table);
        }

        upgrade_mod_savepoint(true, 2026102701, 'vrsculpt');
    }

    return true;
}
