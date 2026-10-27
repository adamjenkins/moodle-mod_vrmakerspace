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
 * Grading page: every sculpture with its latest version, the members' shares, and their grades.
 *
 * Also the gradebook's link to the activity's grading ("grade.php?id=<cmid>").
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');

use mod_vrsculpt\local\grading_helper;
use mod_vrsculpt\local\studio_helper;

$id = required_param('id', PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'vrsculpt');

require_login($course, false, $cm);
$context = context_module::instance($cm->id);

// The gradebook links here for everyone: users who cannot grade go to the activity page.
if (!has_capability('mod/vrsculpt:grade', $context)) {
    redirect(new moodle_url('/mod/vrsculpt/view.php', ['id' => $cm->id]));
}
require_capability('mod/vrsculpt:viewallsubmissions', $context);

$vrsculpt = $DB->get_record('vrsculpt', ['id' => $cm->instance], '*', MUST_EXIST);
$url = new moodle_url('/mod/vrsculpt/grade.php', ['id' => $cm->id]);
$PAGE->set_url($url);
$PAGE->set_title(format_string($vrsculpt->name, true, ['context' => $context]) . ': ' . get_string('grading', 'vrsculpt'));
$PAGE->set_heading(format_string($course->fullname, true, ['context' => context_course::instance($course->id)]));
$PAGE->navbar->add(get_string('grading', 'vrsculpt'));

$gradable = grading_helper::gradable($vrsculpt, $cm, $context);
$errors = [];
$posted = [];

if ((int)$vrsculpt->grade > 0 && optional_param('savegrades', '', PARAM_RAW) !== '') {
    require_sesskey();
    $posted = optional_param_array('grade', [], PARAM_RAW_TRIMMED);
    $groupposted = optional_param_array('groupgrade', [], PARAM_RAW_TRIMMED);
    $result = grading_helper::save($vrsculpt, $gradable, $posted, $groupposted, (int)$USER->id);
    $errors = $result['errors'];
    if (!$errors) {
        redirect($url, get_string('gradessaved', 'vrsculpt', $result['saved']), null, \core\output\notification::NOTIFY_SUCCESS);
    }
    \core\notification::error(get_string('gradesnotallsaved', 'vrsculpt', count($errors)));
}

$PAGE->requires->js_call_amd('mod_vrsculpt/quickview', 'init', [studio_helper::worker_url()->out(false)]);

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('grading', 'vrsculpt'), 3);
if ((int)$vrsculpt->grade <= 0) {
    echo $OUTPUT->notification(get_string('notgraded', 'vrsculpt'), \core\output\notification::NOTIFY_INFO);
} else {
    echo $OUTPUT->render_from_template(
        'mod_vrsculpt/grade',
        grading_helper::template_data($vrsculpt, $context, $gradable, $errors, $posted)
    );
}
echo $OUTPUT->footer();
