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
 * Grading page: every piece with its latest version, the members' shares, and their grades.
 *
 * Also the gradebook's link to the activity's grading ("grade.php?id=<cmid>").
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');

use mod_vrmakerspace\local\grading_helper;
use mod_vrmakerspace\local\studio_helper;

$id = required_param('id', PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'vrmakerspace');

require_login($course, false, $cm);
$context = context_module::instance($cm->id);

// The gradebook links here for everyone: users who cannot grade go to the activity page.
if (!has_capability('mod/vrmakerspace:grade', $context)) {
    redirect(new moodle_url('/mod/vrmakerspace/view.php', ['id' => $cm->id]));
}
require_capability('mod/vrmakerspace:viewallsubmissions', $context);

$vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);
$url = new moodle_url('/mod/vrmakerspace/grade.php', ['id' => $cm->id]);
$PAGE->set_url($url);
$PAGE->set_title(format_string($vrmakerspace->name, true, ['context' => $context]) . ': ' . get_string('grading', 'vrmakerspace'));
$PAGE->set_heading(format_string($course->fullname, true, ['context' => context_course::instance($course->id)]));
$PAGE->navbar->add(get_string('grading', 'vrmakerspace'));

$gradable = grading_helper::gradable($vrmakerspace, $cm, $context);
$errors = [];
$posted = [];

if ((int)$vrmakerspace->grade > 0 && optional_param('savegrades', '', PARAM_RAW) !== '') {
    require_sesskey();
    $posted = optional_param_array('grade', [], PARAM_RAW_TRIMMED);
    $groupposted = optional_param_array('groupgrade', [], PARAM_RAW_TRIMMED);
    $result = grading_helper::save($vrmakerspace, $gradable, $posted, $groupposted, (int)$USER->id);
    $errors = $result['errors'];
    if (!$errors) {
        redirect(
            $url,
            get_string('gradessaved', 'vrmakerspace', $result['saved']),
            null,
            \core\output\notification::NOTIFY_SUCCESS
        );
    }
    \core\notification::error(get_string('gradesnotallsaved', 'vrmakerspace', count($errors)));
}

$PAGE->requires->js_call_amd('mod_vrmakerspace/quickview', 'init', [studio_helper::worker_url()->out(false)]);

echo $OUTPUT->header();
echo $OUTPUT->heading(get_string('grading', 'vrmakerspace'), 3);
if ((int)$vrmakerspace->grade <= 0) {
    echo $OUTPUT->notification(get_string('notgraded', 'vrmakerspace'), \core\output\notification::NOTIFY_INFO);
} else {
    echo $OUTPUT->render_from_template(
        'mod_vrmakerspace/grade',
        grading_helper::template_data($vrmakerspace, $context, $gradable, $errors, $posted)
    );
}
echo $OUTPUT->footer();
