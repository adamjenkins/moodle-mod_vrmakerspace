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
 * Activity page: the user's sculpture and its versions, and for teachers every sculpture.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');
require_once($CFG->dirroot . '/mod/vrsculpt/lib.php');

use mod_vrsculpt\local\session_manager;
use mod_vrsculpt\local\view_helper;

$id = required_param('id', PARAM_INT);
$groupid = optional_param('group', 0, PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'vrsculpt');

require_login($course, true, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/vrsculpt:view', $context);

$vrsculpt = $DB->get_record('vrsculpt', ['id' => $cm->instance], '*', MUST_EXIST);

vrsculpt_view($vrsculpt, $course, $cm, $context);

$PAGE->set_url('/mod/vrsculpt/view.php', ['id' => $cm->id]);
$PAGE->set_title(format_string($vrsculpt->name, true, ['context' => $context]));
$PAGE->set_heading(format_string($course->fullname, true, ['context' => context_course::instance($course->id)]));

$isgroupwork = (int)$vrsculpt->workmode === session_manager::MODE_GROUP;
$templatecontext = [
    'startmodel' => get_string('startmodel_' . session_manager::clean_start_model($vrsculpt->startmodel), 'vrsculpt'),
    'workmode' => get_string($isgroupwork ? 'workmode_group' : 'workmode_individual', 'vrsculpt'),
    'hassculpture' => false,
    'nogroup' => false,
    'groupselector' => '',
    'canviewall' => false,
];

$authors = [];

// The user's own sculpture (or their group's).
if (has_capability('mod/vrsculpt:sculpt', $context)) {
    if ($isgroupwork) {
        $groups = session_manager::get_user_groups($cm, (int)$USER->id);
        if (count($groups) > 1) {
            $options = [];
            foreach ($groups as $group) {
                $options[$group->id] = format_string($group->name, true, ['context' => $context]);
            }
            $selected = isset($groups[$groupid]) ? $groupid : (int)array_key_first($groups);
            $select = new single_select($PAGE->url, 'group', $options, $selected, null);
            $select->set_label(get_string('yourgroup', 'vrsculpt'));
            $templatecontext['groupselector'] = $OUTPUT->render($select);
        }
    }
    $session = session_manager::get_or_create_for_user($vrsculpt, $cm, (int)$USER->id, $groupid);
    if ($session) {
        $snapshots = session_manager::get_snapshots((int)$session->id);
        $rows = [];
        foreach (array_reverse($snapshots) as $snapshot) {
            $rows[] = view_helper::snapshot_row($snapshot, $context, $authors);
        }
        $owner = get_string('yoursculpture', 'vrsculpt');
        if ((int)$session->groupid) {
            $owner = get_string('groupsculpture', 'vrsculpt', format_string(
                groups_get_group_name($session->groupid),
                true,
                ['context' => $context]
            ));
        }
        $templatecontext['hassculpture'] = true;
        $templatecontext['sculpture'] = [
            'sessionid' => (int)$session->id,
            'owner' => $owner,
            'status' => get_string(
                (int)$session->status === session_manager::STATUS_OPEN ? 'statusopen' : 'statusclosed',
                'vrsculpt'
            ),
            'versions' => $rows,
            'hasversions' => !empty($rows),
        ];
    } else if ($isgroupwork) {
        $templatecontext['nogroup'] = true;
    }
}

// Every sculpture, for teachers.
if (has_capability('mod/vrsculpt:viewallsubmissions', $context)) {
    $sessions = $DB->get_records('vrsculpt_sessions', ['vrsculptid' => $vrsculpt->id], 'id ASC');

    // In separate groups without access to all groups, only the teacher's own groups' work.
    $allowedgroups = null;
    if (groups_get_activity_groupmode($cm) == SEPARATEGROUPS && !has_capability('moodle/site:accessallgroups', $context)) {
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
        $sessions = array_filter($sessions, function ($session) use ($allowedgroups, $allowedusers) {
            return (int)$session->groupid ? in_array((int)$session->groupid, $allowedgroups, true)
                : in_array((int)$session->userid, $allowedusers, true);
        });
    }

    $rows = [];
    foreach ($sessions as $session) {
        if ((int)$session->groupid) {
            $owner = format_string(groups_get_group_name($session->groupid), true, ['context' => $context]);
        } else {
            $user = $DB->get_record('user', ['id' => $session->userid]);
            $owner = $user ? fullname($user) : '';
        }
        $latest = session_manager::get_latest_snapshot((int)$session->id);
        $rows[] = [
            'owner' => $owner,
            'versions' => $latest ? (int)$latest->version : 0,
            'lastsaved' => $latest ? userdate($latest->timecreated) : get_string('never'),
            'status' => get_string(
                (int)$session->status === session_manager::STATUS_OPEN ? 'statusopen' : 'statusclosed',
                'vrsculpt'
            ),
            'url' => $latest ? session_manager::snapshot_url($latest, $context)->out(false) : '',
        ];
    }
    $templatecontext['canviewall'] = true;
    $templatecontext['allsculptures'] = $rows;
    $templatecontext['hasallsculptures'] = !empty($rows);
}

echo $OUTPUT->header();
echo $OUTPUT->render_from_template('mod_vrsculpt/view', $templatecontext);
echo $OUTPUT->footer();
