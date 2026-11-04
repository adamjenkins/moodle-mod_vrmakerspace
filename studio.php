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
 * The 3D studio: sculpt or model the user's own (or their group's) piece, or look at any piece or saved
 * version the user may see.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');

use mod_vrmakerspace\local\studio_helper;

$id = required_param('id', PARAM_INT);
$sessionid = optional_param('session', 0, PARAM_INT);
$version = optional_param('version', 0, PARAM_INT);
$groupid = optional_param('group', 0, PARAM_INT);
[$course, $cm] = get_course_and_cm_from_cmid($id, 'vrmakerspace');

require_login($course, true, $cm);
$context = context_module::instance($cm->id);
require_capability('mod/vrmakerspace:view', $context);

$vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);

$urlparams = ['id' => $cm->id];
if ($sessionid) {
    $urlparams['session'] = $sessionid;
}
if ($version) {
    $urlparams['version'] = $version;
}
if ($groupid) {
    $urlparams['group'] = $groupid;
}
$PAGE->set_url('/mod/vrmakerspace/studio.php', $urlparams);
$PAGE->set_title(format_string($vrmakerspace->name, true, ['context' => $context]));
$PAGE->set_heading(format_string($course->fullname, true, ['context' => context_course::instance($course->id)]));
$PAGE->add_body_class('mod_vrmakerspace-studiopage');

$resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$USER->id, $sessionid, $version, $groupid);
$title = studio_helper::title($resolved['session'], $context, (int)$USER->id, $version ? $resolved['snapshot'] : null);
$config = studio_helper::config($vrmakerspace, $context, $USER, $resolved);

$PAGE->requires->js_call_amd('mod_vrmakerspace/studio', 'init', [$config]);

echo $OUTPUT->header();
// Whose piece this is (and which version): plain text, escaped here because heading() does not.
echo $OUTPUT->heading(s($title), 3);
echo $OUTPUT->render_from_template('mod_vrmakerspace/studio', [
    'readonly' => $config['readonly'],
    // The activity name (the canvas label and the export file name), escaped once by the template.
    'title' => format_string($vrmakerspace->name, true, ['context' => $context, 'escape' => false]),
    'backurl' => $config['backurl'],
] + studio_helper::methods_context($config['methods'], $config['model']));
echo $OUTPUT->footer();
