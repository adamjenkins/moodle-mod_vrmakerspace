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
 * Close, reopen or reset a sculpture: a confirmation page, then the change on a POST with the sesskey.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');

use mod_vrmakerspace\local\session_manager;
use mod_vrmakerspace\local\view_helper;

$id = required_param('id', PARAM_INT);
$sessionid = required_param('session', PARAM_INT);
$action = required_param('action', PARAM_ALPHA);
$returnto = optional_param('returnto', 'view', PARAM_ALPHA);
$confirm = optional_param('confirm', 0, PARAM_BOOL);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'vrmakerspace');

require_login($course, false, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/vrmakerspace:managesessions', $context);

$vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);
$session = session_manager::get_session($sessionid, $vrmakerspace);
if (!session_manager::can_view($session, $context, (int)$USER->id)) {
    throw new required_capability_exception($context, 'mod/vrmakerspace:viewallsubmissions', 'nopermissions', '');
}
if (!in_array($action, session_manager::MANAGE_ACTIONS, true)) {
    throw new moodle_exception('invalidaction', 'mod_vrmakerspace');
}
$returnto = $returnto === 'grade' ? 'grade' : 'view';
$returnurl = new moodle_url('/mod/vrmakerspace/' . $returnto . '.php', ['id' => $cm->id]);

$params = ['id' => $cm->id, 'session' => $session->id, 'action' => $action, 'returnto' => $returnto];
$PAGE->set_url('/mod/vrmakerspace/manage.php', $params);
$PAGE->set_title(format_string($vrmakerspace->name, true, ['context' => $context]));
$PAGE->set_heading(format_string($course->fullname, true, ['context' => context_course::instance($course->id)]));

// The change itself: only from the confirmation form's POST.
if ($confirm && $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_sesskey();
    $done = session_manager::manage($session, $context, $action);
    redirect($returnurl, get_string($done, 'vrmakerspace'), null, \core\output\notification::NOTIFY_SUCCESS);
}

$names = [];
$owner = view_helper::owner_name($session, $context, $names);
$PAGE->navbar->add(get_string('manage_' . $action, 'vrmakerspace'));
$continue = new single_button(
    new moodle_url('/mod/vrmakerspace/manage.php', $params + ['confirm' => 1]),
    get_string('manageconfirmbutton_' . $action, 'vrmakerspace'),
    'post',
    $action === 'reset' ? single_button::BUTTON_DANGER : single_button::BUTTON_PRIMARY
);

echo $OUTPUT->header();
echo $OUTPUT->confirm(s(get_string('manageconfirm_' . $action, 'vrmakerspace', $owner)), $continue, $returnurl);
echo $OUTPUT->footer();
