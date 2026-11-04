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
 * Activity page: the user's piece and its versions, and for teachers every piece.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');
require_once($CFG->dirroot . '/mod/vrmakerspace/lib.php');

use mod_vrmakerspace\local\session_manager;
use mod_vrmakerspace\local\view_helper;

$id = required_param('id', PARAM_INT);
$groupid = optional_param('group', 0, PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'vrmakerspace');

require_login($course, true, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/vrmakerspace:view', $context);

$vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);

vrmakerspace_view($vrmakerspace, $course, $cm, $context);

$PAGE->set_url('/mod/vrmakerspace/view.php', ['id' => $cm->id]);
$PAGE->set_title(format_string($vrmakerspace->name, true, ['context' => $context]));
$PAGE->set_heading(format_string($course->fullname, true, ['context' => context_course::instance($course->id)]));

$isgroupwork = session_manager::is_group_work($vrmakerspace);
$tracked = $isgroupwork && !empty($vrmakerspace->trackcontributions);
$templatecontext = [
    'methods' => view_helper::methods_text($vrmakerspace),
    'startmodel' => get_string('startmodel_' . session_manager::clean_start_model($vrmakerspace->startmodel), 'vrmakerspace'),
    'workmode' => get_string($isgroupwork ? 'workmode_group' : 'workmode_individual', 'vrmakerspace'),
    'hasconnection' => $isgroupwork,
    'connection' => '',
    'hassculpture' => false,
    'nogroup' => false,
    'groupselector' => '',
    'canviewall' => false,
    'cangrade' => has_capability('mod/vrmakerspace:grade', $context) && (int)$vrmakerspace->grade > 0,
    'gradeurl' => (new moodle_url('/mod/vrmakerspace/grade.php', ['id' => $cm->id]))->out(false),
    'tracked' => $tracked,
];
if ($isgroupwork) {
    $templatecontext['connection'] = session_manager::connection($vrmakerspace) === session_manager::CONNECTION_COMPANION
        ? get_string('connection_companion', 'vrmakerspace', (int)$vrmakerspace->maxusers)
        : get_string('connection_pair', 'vrmakerspace');
}

$names = [];
$canmanage = has_capability('mod/vrmakerspace:managesessions', $context);

// The user's own piece (or their group's).
if (has_capability('mod/vrmakerspace:make', $context)) {
    if ($isgroupwork) {
        $groups = session_manager::get_user_groups($cm, (int)$USER->id);
        if (count($groups) > 1) {
            $options = [];
            foreach ($groups as $group) {
                $options[$group->id] = format_string($group->name, true, ['context' => $context]);
            }
            $selected = isset($groups[$groupid]) ? $groupid : (int)array_key_first($groups);
            $select = new single_select($PAGE->url, 'group', $options, $selected, null);
            $select->set_label(get_string('yourgroup', 'vrmakerspace'));
            $templatecontext['groupselector'] = $OUTPUT->render($select);
        }
    }
    $session = session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$USER->id, $groupid);
    if ($session) {
        $snapshots = session_manager::get_snapshots((int)$session->id);
        $rows = [];
        foreach (array_reverse($snapshots) as $snapshot) {
            $rows[] = view_helper::snapshot_row($snapshot, $context, $names);
        }
        $owner = get_string('yoursculpture', 'vrmakerspace');
        if ((int)$session->groupid) {
            $owner = get_string('groupsculpture', 'vrmakerspace', view_helper::owner_name($session, $context, $names));
        }
        $mine = '';
        if ($tracked) {
            foreach (view_helper::contribution_rows((int)$session->id, $context, $names) as $row) {
                if ($row['userid'] === (int)$USER->id) {
                    $mine = get_string('yourcontribution', 'vrmakerspace', ['ops' => $row['ops'], 'share' => $row['share']]);
                }
            }
        }
        $templatecontext['hassculpture'] = true;
        $templatecontext['sculpture'] = [
            'sessionid' => (int)$session->id,
            'owner' => $owner,
            'status' => view_helper::status_text($session),
            'isclosed' => (int)$session->status === session_manager::STATUS_CLOSED,
            'studiourl' => view_helper::studio_url($context, 0, 0, (int)$session->groupid)->out(false),
            'versions' => $rows,
            'hasversions' => !empty($rows),
            'hascontribution' => $mine !== '',
            'contribution' => $mine,
        ];
    } else if ($isgroupwork) {
        $templatecontext['nogroup'] = true;
    }
}

// Every piece, for teachers.
if (has_capability('mod/vrmakerspace:viewallsubmissions', $context)) {
    $rows = [];
    foreach (view_helper::visible_sessions($vrmakerspace, $cm, $context) as $session) {
        $latest = session_manager::get_latest_snapshot((int)$session->id);
        $contributions = [];
        if ($tracked) {
            foreach (view_helper::contribution_rows((int)$session->id, $context, $names) as $row) {
                $a = ['name' => $row['name'], 'share' => $row['share']];
                $contributions[] = get_string('contributionof', 'vrmakerspace', $a);
            }
        }
        $rows[] = [
            'owner' => view_helper::owner_name($session, $context, $names),
            'versions' => $latest ? (int)$latest->version : 0,
            'lastsaved' => $latest ? userdate($latest->timecreated) : get_string('never'),
            'status' => view_helper::status_text($session),
            'url' => $latest ? session_manager::snapshot_url($latest, $context)->out(false) : '',
            'viewurl' => $latest ? view_helper::studio_url($context, (int)$session->id)->out(false) : '',
            'contributions' => implode(', ', $contributions),
            'managelinks' => $canmanage ? view_helper::manage_links($session, $context) : [],
        ];
    }
    $templatecontext['canviewall'] = true;
    $templatecontext['canmanage'] = $canmanage;
    $templatecontext['allsculptures'] = $rows;
    $templatecontext['hasallsculptures'] = !empty($rows);
}

echo $OUTPUT->header();
echo $OUTPUT->render_from_template('mod_vrmakerspace/view', $templatecontext);
echo $OUTPUT->footer();
