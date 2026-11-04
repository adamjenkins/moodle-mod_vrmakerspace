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
 * Lists the VR sculpting activities in a course.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

require_once(__DIR__ . '/../../config.php');

$id = required_param('id', PARAM_INT);
$course = $DB->get_record('course', ['id' => $id], '*', MUST_EXIST);

require_course_login($course);
$coursecontext = context_course::instance($course->id);

$event = \mod_vrmakerspace\event\course_module_instance_list_viewed::create(['context' => $coursecontext]);
$event->add_record_snapshot('course', $course);
$event->trigger();

$strplural = get_string('modulenameplural', 'vrmakerspace');
$PAGE->set_url('/mod/vrmakerspace/index.php', ['id' => $course->id]);
$PAGE->set_title(format_string($course->shortname, true, ['context' => $coursecontext]) . ': ' . $strplural);
$PAGE->set_heading(format_string($course->fullname, true, ['context' => $coursecontext]));
$PAGE->navbar->add($strplural);
$PAGE->set_pagelayout('incourse');

echo $OUTPUT->header();
echo $OUTPUT->heading($strplural);

$instances = get_all_instances_in_course('vrmakerspace', $course);
if (!$instances) {
    notice(get_string('thereareno', 'moodle', $strplural), new moodle_url('/course/view.php', ['id' => $course->id]));
    exit;
}

$table = new html_table();
$table->attributes['class'] = 'generaltable mod_index';
$table->head = [get_string('name')];
$table->align = ['left'];
foreach ($instances as $instance) {
    $name = format_string($instance->name, true, ['context' => context_module::instance($instance->coursemodule)]);
    $attributes = $instance->visible ? [] : ['class' => 'dimmed'];
    $link = html_writer::link(new moodle_url('/mod/vrmakerspace/view.php', ['id' => $instance->coursemodule]), $name, $attributes);
    $table->data[] = [$link];
}
echo html_writer::table($table);
echo $OUTPUT->footer();
