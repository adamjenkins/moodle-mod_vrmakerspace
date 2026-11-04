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

namespace mod_vrmakerspace\local;

/**
 * Template data for the activity, grading and studio pages.
 *
 * Every string returned for a template is plain text, escaped by Mustache; names are never marked up.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class view_helper {
    /**
     * One version in the history table.
     *
     * @param \stdClass $snapshot the vrmakerspace_snapshots row
     * @param \context_module $context the activity context
     * @param array $authors user id => full name, filled as users are looked up
     * @return array
     */
    public static function snapshot_row(\stdClass $snapshot, \context_module $context, array &$authors): array {
        $userid = (int)$snapshot->userid;
        return [
            'version' => (int)$snapshot->version,
            'savedby' => $userid ? self::user_name($userid, $context, $authors) : get_string('anonymised', 'vrmakerspace'),
            'timesaved' => userdate($snapshot->timecreated),
            'size' => display_size((int)$snapshot->filesize),
            'url' => session_manager::snapshot_url($snapshot, $context)->out(false),
            'viewurl' => self::studio_url($context, (int)$snapshot->sessionid, (int)$snapshot->version)->out(false),
        ];
    }

    /**
     * A user's full name, looked up once per page.
     *
     * @param int $userid the user
     * @param \context_module $context the activity context
     * @param array $names user id => full name, filled as users are looked up
     * @return string plain text ('' for a deleted user)
     */
    public static function user_name(int $userid, \context_module $context, array &$names): string {
        global $DB;
        if (!array_key_exists($userid, $names)) {
            $user = $DB->get_record('user', ['id' => $userid]);
            $names[$userid] = $user ? fullname($user, has_capability('moodle/site:viewfullnames', $context)) : '';
        }
        return $names[$userid];
    }

    /**
     * The name of a piece's owner: the group's name, or the user's full name.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param array $names user id => full name, filled as users are looked up
     * @return string plain text
     */
    public static function owner_name(\stdClass $session, \context_module $context, array &$names): string {
        if ((int)$session->groupid) {
            // Plain text for Mustache to escape: format_string() escapes "&", which would show doubled.
            return html_entity_decode(
                format_string((string)groups_get_group_name((int)$session->groupid), true, ['context' => $context]),
                ENT_QUOTES | ENT_HTML5,
                'UTF-8'
            );
        }
        return self::user_name((int)$session->userid, $context, $names);
    }

    /**
     * The address of the studio.
     *
     * @param \context_module $context the activity context
     * @param int $sessionid a piece, or 0 for the user's own
     * @param int $version a saved version to look at, or 0 for the current piece
     * @param int $groupid for the user's own group piece: which group (0 for the first)
     * @return \moodle_url
     */
    public static function studio_url(
        \context_module $context,
        int $sessionid = 0,
        int $version = 0,
        int $groupid = 0
    ): \moodle_url {
        $params = ['id' => $context->instanceid];
        if ($sessionid) {
            $params['session'] = $sessionid;
        }
        if ($version) {
            $params['version'] = $version;
        }
        if ($groupid) {
            $params['group'] = $groupid;
        }
        return new \moodle_url('/mod/vrmakerspace/studio.php', $params);
    }

    /**
     * Every piece of an activity a teacher may see: in separate groups without access to all
     * groups, only the work of the teacher's own groups and of their members.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \cm_info|\stdClass $cm the course module
     * @param \context_module $context the activity context
     * @return \stdClass[] vrmakerspace_sessions rows keyed by id, oldest first
     */
    public static function visible_sessions(\stdClass $vrmakerspace, $cm, \context_module $context): array {
        global $DB;
        $sessions = $DB->get_records('vrmakerspace_sessions', ['vrmakerspaceid' => $vrmakerspace->id], 'id ASC');
        if (groups_get_activity_groupmode($cm) != SEPARATEGROUPS || has_capability('moodle/site:accessallgroups', $context)) {
            return $sessions;
        }
        $allowedgroups = array_map('intval', array_keys(groups_get_activity_allowed_groups($cm)));
        $allowedusers = [];
        if ($allowedgroups) {
            [$insql, $params] = $DB->get_in_or_equal($allowedgroups);
            $allowedusers = array_map('intval', $DB->get_fieldset_select(
                'groups_members',
                'DISTINCT userid',
                "groupid $insql",
                $params
            ));
        }
        return array_filter($sessions, function ($session) use ($allowedgroups, $allowedusers) {
            return (int)$session->groupid ? in_array((int)$session->groupid, $allowedgroups, true)
                : in_array((int)$session->userid, $allowedusers, true);
        });
    }

    /**
     * The members' shares of a piece, for a table.
     *
     * @param int $sessionid the session id
     * @param \context_module $context the activity context
     * @param array $names user id => full name, filled as users are looked up
     * @return array list of ['userid', 'name', 'ops', 'share' (formatted percentage), 'added', 'removed']
     */
    public static function contribution_rows(int $sessionid, \context_module $context, array &$names): array {
        $rows = [];
        foreach (contribution_manager::summary($sessionid) as $item) {
            $rows[] = [
                'userid' => $item['userid'],
                'name' => self::user_name($item['userid'], $context, $names),
                'ops' => $item['ops'],
                'share' => format_float($item['share'], 1) . '%',
                'added' => format_float($item['added'] / 1000, 1),
                'removed' => format_float($item['removed'] / 1000, 1),
            ];
        }
        return $rows;
    }

    /**
     * The text of an activity's ways of making.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return string
     */
    public static function methods_text(\stdClass $vrmakerspace): string {
        return get_string('methods_' . session_manager::methods($vrmakerspace), 'vrmakerspace');
    }

    /**
     * The text of a status.
     *
     * @param \stdClass $session the session row
     * @return string
     */
    public static function status_text(\stdClass $session): string {
        return get_string((int)$session->status === session_manager::STATUS_OPEN ? 'statusopen' : 'statusclosed', 'vrmakerspace');
    }

    /**
     * The management links of a piece (close or reopen, reset), for users with managesessions.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param string $returnto the page to come back to: view or grade
     * @return array list of ['label' => string, 'url' => string]
     */
    public static function manage_links(\stdClass $session, \context_module $context, string $returnto = 'view'): array {
        $actions = [(int)$session->status === session_manager::STATUS_OPEN ? 'close' : 'reopen', 'reset'];
        $links = [];
        foreach ($actions as $action) {
            $links[] = [
                'action' => $action,
                'label' => get_string('manage_' . $action, 'vrmakerspace'),
                'url' => (new \moodle_url('/mod/vrmakerspace/manage.php', [
                    'id' => $context->instanceid,
                    'session' => (int)$session->id,
                    'action' => $action,
                    'returnto' => $returnto,
                ]))->out(false),
            ];
        }
        return $links;
    }
}
