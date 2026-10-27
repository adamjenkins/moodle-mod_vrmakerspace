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

namespace mod_vrsculpt\privacy;

use core_privacy\local\metadata\collection;
use core_privacy\local\request\approved_contextlist;
use core_privacy\local\request\approved_userlist;
use core_privacy\local\request\contextlist;
use core_privacy\local\request\helper;
use core_privacy\local\request\transform;
use core_privacy\local\request\userlist;
use core_privacy\local\request\writer;
use mod_vrsculpt\local\pair_manager;
use mod_vrsculpt\local\session_manager;

/**
 * Privacy provider for mod_vrsculpt.
 *
 * Personal data: a user's own sculptures (vrsculpt_sessions with their userid) with every saved version
 * (vrsculpt_snapshots and the snapshots file area), the versions they saved of a group's sculpture,
 * their grades (vrsculpt_grades: as the graded user and as the grader), their share of a sculpture
 * (vrsculpt_contrib), and, briefly, their live connections of pair work (vrsculpt_peers) with the
 * connection messages they sent (vrsculpt_signals). Live sculpting also sends data outside Moodle: to
 * the partner's browser (pair work) and to the companion service (companion work).
 *
 * Deleting one user deletes their own sculptures, grades, shares, connections and messages. A group's
 * sculpture is the group's shared work, so it is kept, and the versions the user saved are anonymised
 * (userid 0).
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class provider implements
    \core_privacy\local\metadata\provider,
    \core_privacy\local\request\core_userlist_provider,
    \core_privacy\local\request\plugin\provider {
    /** @var string This component. */
    private const COMPONENT = 'mod_vrsculpt';

    /**
     * Describe the personal data stored.
     *
     * @param collection $collection the collection to add to
     * @return collection
     */
    public static function get_metadata(collection $collection): collection {
        $collection->add_database_table('vrsculpt_sessions', [
            'userid' => 'privacy:metadata:sessions:userid',
            'groupid' => 'privacy:metadata:sessions:groupid',
            'timecreated' => 'privacy:metadata:sessions:timecreated',
            'timemodified' => 'privacy:metadata:sessions:timemodified',
        ], 'privacy:metadata:sessions');
        $collection->add_database_table('vrsculpt_snapshots', [
            'userid' => 'privacy:metadata:snapshots:userid',
            'version' => 'privacy:metadata:snapshots:version',
            'opcount' => 'privacy:metadata:snapshots:opcount',
            'timecreated' => 'privacy:metadata:snapshots:timecreated',
        ], 'privacy:metadata:snapshots');
        $collection->add_database_table('vrsculpt_grades', [
            'userid' => 'privacy:metadata:grades:userid',
            'grade' => 'privacy:metadata:grades:grade',
            'grader' => 'privacy:metadata:grades:grader',
            'timemodified' => 'privacy:metadata:grades:timemodified',
        ], 'privacy:metadata:grades');
        $collection->add_database_table('vrsculpt_contrib', [
            'userid' => 'privacy:metadata:contrib:userid',
            'ops' => 'privacy:metadata:contrib:ops',
            'added' => 'privacy:metadata:contrib:added',
            'removed' => 'privacy:metadata:contrib:removed',
            'timemodified' => 'privacy:metadata:contrib:timemodified',
        ], 'privacy:metadata:contrib');
        $collection->add_database_table('vrsculpt_peers', [
            'userid' => 'privacy:metadata:peers:userid',
            'role' => 'privacy:metadata:peers:role',
            'lastseen' => 'privacy:metadata:peers:lastseen',
            'timecreated' => 'privacy:metadata:peers:timecreated',
        ], 'privacy:metadata:peers');
        $collection->add_database_table('vrsculpt_signals', [
            'fromuserid' => 'privacy:metadata:signals:fromuserid',
            'payload' => 'privacy:metadata:signals:payload',
            'timecreated' => 'privacy:metadata:signals:timecreated',
        ], 'privacy:metadata:signals');
        $collection->add_subsystem_link('core_files', [], 'privacy:metadata:core_files');
        $collection->add_external_location_link('pairpartner', [
            'fullname' => 'privacy:metadata:pairpartner:fullname',
            'address' => 'privacy:metadata:pairpartner:address',
            'edits' => 'privacy:metadata:pairpartner:edits',
        ], 'privacy:metadata:pairpartner');
        $collection->add_external_location_link('vrroomsync', [
            'fullname' => 'privacy:metadata:vrroomsync:fullname',
            'peerid' => 'privacy:metadata:vrroomsync:peerid',
            'edits' => 'privacy:metadata:vrroomsync:edits',
        ], 'privacy:metadata:vrroomsync');
        return $collection;
    }

    /**
     * The SQL (one id column) of the activity ids with data of a user, and its parameters.
     *
     * @param int $userid the user
     * @return array [string $sql, array $params]
     */
    private static function activities_of_user_sql(int $userid): array {
        $sql = "SELECT s.vrsculptid
                  FROM {vrsculpt_sessions} s
                 WHERE s.userid = :u1
                 UNION
                SELECT s.vrsculptid
                  FROM {vrsculpt_sessions} s
                  JOIN {vrsculpt_snapshots} sn ON sn.sessionid = s.id
                 WHERE sn.userid = :u2
                 UNION
                SELECT g.vrsculptid
                  FROM {vrsculpt_grades} g
                 WHERE g.userid = :u3 OR g.grader = :u4
                 UNION
                SELECT s.vrsculptid
                  FROM {vrsculpt_sessions} s
                  JOIN {vrsculpt_contrib} c ON c.sessionid = s.id
                 WHERE c.userid = :u5
                 UNION
                SELECT s.vrsculptid
                  FROM {vrsculpt_sessions} s
                  JOIN {vrsculpt_peers} p ON p.sessionid = s.id
                 WHERE p.userid = :u6
                 UNION
                SELECT s.vrsculptid
                  FROM {vrsculpt_sessions} s
                  JOIN {vrsculpt_signals} sg ON sg.sessionid = s.id
                 WHERE sg.fromuserid = :u7";
        $params = [];
        foreach (range(1, 7) as $n) {
            $params['u' . $n] = $userid;
        }
        return [$sql, $params];
    }

    /**
     * The contexts holding data of a user.
     *
     * @param int $userid the user
     * @return contextlist
     */
    public static function get_contexts_for_userid(int $userid): contextlist {
        [$activitysql, $params] = self::activities_of_user_sql($userid);
        $sql = "SELECT ctx.id
                  FROM {context} ctx
                  JOIN {course_modules} cm ON cm.id = ctx.instanceid AND ctx.contextlevel = :contextlevel
                  JOIN {modules} m ON m.id = cm.module AND m.name = :modname
                 WHERE cm.instance IN ($activitysql)";
        $contextlist = new contextlist();
        $contextlist->add_from_sql($sql, $params + ['contextlevel' => CONTEXT_MODULE, 'modname' => 'vrsculpt']);
        return $contextlist;
    }

    /**
     * The users with data in a context.
     *
     * @param userlist $userlist the list to add to
     * @return void
     */
    public static function get_users_in_context(userlist $userlist): void {
        $context = $userlist->get_context();
        $vrsculptid = self::activity_id($context);
        if (!$vrsculptid) {
            return;
        }
        $params = ['id' => $vrsculptid];
        $userlist->add_from_sql('userid', 'SELECT userid FROM {vrsculpt_sessions} WHERE vrsculptid = :id AND userid > 0', $params);
        $userlist->add_from_sql('userid', 'SELECT sn.userid FROM {vrsculpt_snapshots} sn
                JOIN {vrsculpt_sessions} s ON s.id = sn.sessionid WHERE s.vrsculptid = :id AND sn.userid > 0', $params);
        $userlist->add_from_sql('userid', 'SELECT userid FROM {vrsculpt_grades} WHERE vrsculptid = :id', $params);
        $userlist->add_from_sql('grader', 'SELECT grader FROM {vrsculpt_grades} WHERE vrsculptid = :id AND grader > 0', $params);
        $live = ['vrsculpt_contrib' => 'userid', 'vrsculpt_peers' => 'userid', 'vrsculpt_signals' => 'fromuserid'];
        foreach ($live as $table => $field) {
            $userlist->add_from_sql($field, "SELECT t.{$field} AS {$field} FROM {{$table}} t
                    JOIN {vrsculpt_sessions} s ON s.id = t.sessionid WHERE s.vrsculptid = :id", $params);
        }
    }

    /**
     * Export the data of a user.
     *
     * @param approved_contextlist $contextlist the approved contexts
     * @return void
     */
    public static function export_user_data(approved_contextlist $contextlist): void {
        global $DB;

        $userid = (int)$contextlist->get_user()->id;
        foreach ($contextlist->get_contexts() as $context) {
            $vrsculptid = self::activity_id($context);
            if (!$vrsculptid) {
                continue;
            }
            $data = helper::get_context_data($context, $contextlist->get_user());
            helper::export_context_files($context, $contextlist->get_user());

            $sculptures = [];
            $sessions = $DB->get_records('vrsculpt_sessions', ['vrsculptid' => $vrsculptid], 'id ASC');
            foreach ($sessions as $session) {
                $own = (int)$session->userid === $userid;
                $versions = [];
                foreach (session_manager::get_snapshots((int)$session->id) as $snapshot) {
                    if (!$own && (int)$snapshot->userid !== $userid) {
                        continue;
                    }
                    $versions[] = (object)[
                        'version' => (int)$snapshot->version,
                        'savedbyyou' => transform::yesno((int)$snapshot->userid === $userid),
                        'operations' => (int)$snapshot->opcount,
                        'timesaved' => transform::datetime($snapshot->timecreated),
                    ];
                    writer::with_context($context)->export_area_files(
                        [get_string('privacy:path:sculpture', 'mod_vrsculpt', (int)$session->id)],
                        self::COMPONENT,
                        session_manager::FILEAREA,
                        (int)$snapshot->id
                    );
                }
                $live = self::live_data((int)$session->id, $userid);
                if (!$own && !$versions && !$live) {
                    continue;
                }
                $sculptures[] = (object)([
                    'sculpture' => (int)$session->id,
                    'yourown' => transform::yesno($own),
                    'timecreated' => transform::datetime($session->timecreated),
                    'timemodified' => transform::datetime($session->timemodified),
                    'versions' => $versions,
                ] + $live);
            }
            if ($sculptures) {
                $data->sculptures = $sculptures;
            }

            $grade = $DB->get_record('vrsculpt_grades', ['vrsculptid' => $vrsculptid, 'userid' => $userid]);
            if ($grade) {
                $data->grade = $grade->grade === null ? null : format_float((float)$grade->grade, 2);
                $data->timegraded = transform::datetime($grade->timemodified);
            }
            $given = $DB->count_records('vrsculpt_grades', ['vrsculptid' => $vrsculptid, 'grader' => $userid]);
            if ($given) {
                $data->gradesgiven = $given;
            }
            writer::with_context($context)->export_data([], $data);
        }
    }

    /**
     * Delete everyone's data in a context.
     *
     * @param \context $context the context
     * @return void
     */
    public static function delete_data_for_all_users_in_context(\context $context): void {
        global $DB;
        $vrsculptid = self::activity_id($context);
        if (!$vrsculptid) {
            return;
        }
        session_manager::delete_all((object)['id' => $vrsculptid], $context);
        $DB->delete_records('vrsculpt_grades', ['vrsculptid' => $vrsculptid]);
    }

    /**
     * Delete one user's data in the approved contexts.
     *
     * @param approved_contextlist $contextlist the approved contexts
     * @return void
     */
    public static function delete_data_for_user(approved_contextlist $contextlist): void {
        $userid = (int)$contextlist->get_user()->id;
        foreach ($contextlist->get_contexts() as $context) {
            self::delete_users_in_context($context, [$userid]);
        }
    }

    /**
     * Delete the data of several users in one context.
     *
     * @param approved_userlist $userlist the approved users
     * @return void
     */
    public static function delete_data_for_users(approved_userlist $userlist): void {
        self::delete_users_in_context($userlist->get_context(), array_map('intval', $userlist->get_userids()));
    }

    /**
     * Delete the data of users in one context.
     *
     * @param \context $context the context
     * @param int[] $userids the users
     * @return void
     */
    private static function delete_users_in_context(\context $context, array $userids): void {
        global $DB;
        $vrsculptid = self::activity_id($context);
        if (!$vrsculptid || !$userids) {
            return;
        }
        [$usersql, $userparams] = $DB->get_in_or_equal($userids, SQL_PARAMS_NAMED);
        $params = ['vrsculptid' => $vrsculptid] + $userparams;

        // Their own sculptures, with every version.
        $sessions = $DB->get_records_select('vrsculpt_sessions', "vrsculptid = :vrsculptid AND userid $usersql", $params);
        session_manager::delete_sessions($sessions, $context);

        // Versions of a group's sculpture they saved: kept for the group, anonymised.
        $DB->set_field_select(
            'vrsculpt_snapshots',
            'userid',
            0,
            "userid $usersql AND sessionid IN (SELECT id FROM {vrsculpt_sessions} WHERE vrsculptid = :vrsculptid)",
            $params
        );

        $DB->delete_records_select('vrsculpt_grades', "vrsculptid = :vrsculptid AND userid $usersql", $params);
        $DB->set_field_select('vrsculpt_grades', 'grader', 0, "vrsculptid = :vrsculptid AND grader $usersql", $params);

        // Their shares of the group's sculptures, their live connections and the messages they sent.
        $insessions = "sessionid IN (SELECT id FROM {vrsculpt_sessions} WHERE vrsculptid = :vrsculptid)";
        $DB->delete_records_select('vrsculpt_contrib', "userid $usersql AND $insessions", $params);
        $sessionids = array_map(
            'intval',
            $DB->get_fieldset_select('vrsculpt_sessions', 'id', 'vrsculptid = ?', [$vrsculptid])
        );
        foreach ($userids as $userid) {
            pair_manager::purge_user((int)$userid, $sessionids);
        }
    }

    /**
     * A user's share of a sculpture, live connections and messages sent, for the export.
     *
     * @param int $sessionid the session id
     * @param int $userid the user
     * @return array with the keys contribution, connections and connectionmessages, each only when there is data
     */
    private static function live_data(int $sessionid, int $userid): array {
        global $DB;
        $data = [];
        $contrib = $DB->get_record('vrsculpt_contrib', ['sessionid' => $sessionid, 'userid' => $userid]);
        if ($contrib) {
            $data['contribution'] = (object)[
                'operations' => (int)$contrib->ops,
                'addedmm3' => format_float((float)$contrib->added, 2),
                'removedmm3' => format_float((float)$contrib->removed, 2),
                'timemodified' => transform::datetime($contrib->timemodified),
            ];
        }
        $connections = [];
        foreach ($DB->get_records('vrsculpt_peers', ['sessionid' => $sessionid, 'userid' => $userid], 'id ASC') as $peer) {
            $connections[] = (object)[
                'role' => (string)$peer->role,
                'timecreated' => transform::datetime($peer->timecreated),
                'lastseen' => transform::datetime($peer->lastseen),
            ];
        }
        if ($connections) {
            $data['connections'] = $connections;
        }
        $messages = [];
        $signals = $DB->get_records('vrsculpt_signals', ['sessionid' => $sessionid, 'fromuserid' => $userid], 'id ASC');
        foreach ($signals as $signal) {
            $messages[] = (object)[
                'timecreated' => transform::datetime($signal->timecreated),
                'message' => (string)$signal->payload,
            ];
        }
        if ($messages) {
            $data['connectionmessages'] = $messages;
        }
        return $data;
    }

    /**
     * The activity id of a module context of this module.
     *
     * @param \context $context the context
     * @return int the vrsculpt id, or 0 when the context is not one of this module
     */
    private static function activity_id(\context $context): int {
        if ($context->contextlevel != CONTEXT_MODULE) {
            return 0;
        }
        $cm = get_coursemodule_from_id('vrsculpt', $context->instanceid);
        return $cm ? (int)$cm->instance : 0;
    }
}
