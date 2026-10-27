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
 * Library of functions for mod_vrsculpt.
 *
 * The grade callbacks follow the flow of mod_vrroom's lib.php, which follows mod_gear's
 * (update_grades → grade_item_update).
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

use mod_vrsculpt\local\grader;
use mod_vrsculpt\local\session_manager;

/**
 * Whether the module supports a feature.
 *
 * @param string $feature FEATURE_xx constant.
 * @return mixed True or a value if supported, false if not, null if unknown.
 */
function vrsculpt_supports(string $feature) {
    return match ($feature) {
        FEATURE_MOD_INTRO => true,
        FEATURE_BACKUP_MOODLE2 => true,
        FEATURE_COMPLETION_TRACKS_VIEWS => true,
        FEATURE_GRADE_HAS_GRADE => true,
        FEATURE_SHOW_DESCRIPTION => true,
        FEATURE_MOD_PURPOSE => MOD_PURPOSE_COLLABORATION,
        FEATURE_GROUPS => true,
        FEATURE_GROUPINGS => true,
        FEATURE_GRADE_OUTCOMES => false,
        default => null,
    };
}

/**
 * The activity fields the form saves, normalised.
 *
 * @param stdClass $data form data
 * @return stdClass
 */
function vrsculpt_clean_instance_data(stdClass $data): stdClass {
    $data->startmodel = session_manager::clean_start_model((string)($data->startmodel ?? ''));
    $data->workmode = (int)($data->workmode ?? 0) === session_manager::MODE_GROUP
        ? session_manager::MODE_GROUP : session_manager::MODE_INDIVIDUAL;
    $data->maxusers = min(8, max(2, (int)($data->maxusers ?? 8)));
    $data->trackcontributions = empty($data->trackcontributions) ? 0 : 1;
    $data->grade = max(0, (int)($data->grade ?? 0));
    return $data;
}

/**
 * Add a new activity.
 *
 * @param stdClass $data Form data.
 * @param mod_vrsculpt_mod_form|null $mform The form.
 * @return int The new vrsculpt id.
 */
function vrsculpt_add_instance(stdClass $data, ?mod_vrsculpt_mod_form $mform = null): int {
    global $DB;

    $data = vrsculpt_clean_instance_data($data);
    $data->timecreated = time();
    $data->timemodified = $data->timecreated;
    $data->id = $DB->insert_record('vrsculpt', $data);
    grader::grade_item_update($data);
    return (int)$data->id;
}

/**
 * Update an activity.
 *
 * @param stdClass $data Form data.
 * @param mod_vrsculpt_mod_form|null $mform The form.
 * @return bool
 */
function vrsculpt_update_instance(stdClass $data, ?mod_vrsculpt_mod_form $mform = null): bool {
    global $DB;

    $data = vrsculpt_clean_instance_data($data);
    $data->id = $data->instance;
    $data->timemodified = time();
    $DB->update_record('vrsculpt', $data);
    $vrsculpt = $DB->get_record('vrsculpt', ['id' => $data->id], '*', MUST_EXIST);
    if (property_exists($data, 'cmidnumber')) {
        $vrsculpt->cmidnumber = $data->cmidnumber;
    }
    grader::grade_item_update($vrsculpt);
    grader::update_grades($vrsculpt, 0, false);
    return true;
}

/**
 * Delete an activity with its sessions, versions, files and grades.
 *
 * @param int $id The vrsculpt id.
 * @return bool
 */
function vrsculpt_delete_instance(int $id): bool {
    global $DB;

    $vrsculpt = $DB->get_record('vrsculpt', ['id' => $id]);
    if (!$vrsculpt) {
        return false;
    }
    $cm = get_coursemodule_from_instance('vrsculpt', $id, 0, false, IGNORE_MISSING);
    if ($cm) {
        session_manager::delete_all($vrsculpt, context_module::instance($cm->id));
    } else {
        $DB->delete_records_select(
            'vrsculpt_snapshots',
            'sessionid IN (SELECT id FROM {vrsculpt_sessions} WHERE vrsculptid = ?)',
            [$id]
        );
        $DB->delete_records('vrsculpt_sessions', ['vrsculptid' => $id]);
    }
    $DB->delete_records('vrsculpt_grades', ['vrsculptid' => $id]);
    grader::grade_item_delete($vrsculpt);
    $DB->delete_records('vrsculpt', ['id' => $id]);
    return true;
}

/**
 * Information about the activity for course listings, cached in modinfo.
 *
 * @param stdClass $coursemodule The course_modules row (with showdescription).
 * @return cached_cm_info|false
 */
function vrsculpt_get_coursemodule_info(stdClass $coursemodule) {
    global $DB;

    $vrsculpt = $DB->get_record('vrsculpt', ['id' => $coursemodule->instance], 'id, name, intro, introformat');
    if (!$vrsculpt) {
        return false;
    }
    $result = new cached_cm_info();
    $result->name = $vrsculpt->name;
    if ($coursemodule->showdescription) {
        // Filters run at display time, so the cached copy is not filtered.
        $result->content = format_module_intro('vrsculpt', $vrsculpt, $coursemodule->id, false);
    }
    return $result;
}

/**
 * Mark the activity viewed: completion and the course_module_viewed event.
 *
 * @param stdClass $vrsculpt the vrsculpt row
 * @param stdClass $course the course
 * @param cm_info|stdClass $cm the course module
 * @param context_module $context its context
 * @return void
 */
function vrsculpt_view(stdClass $vrsculpt, stdClass $course, $cm, context_module $context): void {
    global $CFG;
    require_once($CFG->libdir . '/completionlib.php');

    $event = \mod_vrsculpt\event\course_module_viewed::create([
        'objectid' => $vrsculpt->id,
        'context' => $context,
    ]);
    $event->add_record_snapshot('course', $course);
    $event->add_record_snapshot('vrsculpt', $vrsculpt);
    $event->trigger();

    $completion = new completion_info($course);
    $completion->set_module_viewed($cm);
}

/**
 * Grades of the activity, for the gradebook.
 *
 * @param stdClass $vrsculpt the vrsculpt row
 * @param int $userid one user, or 0 for all
 * @return array
 */
function vrsculpt_get_user_grades(stdClass $vrsculpt, int $userid = 0): array {
    return grader::get_user_grades($vrsculpt, $userid);
}

/**
 * Create or update the grade item.
 *
 * @param stdClass $vrsculpt the vrsculpt row
 * @param mixed $grades grades, 'reset', or null
 * @return int
 */
function vrsculpt_grade_item_update(stdClass $vrsculpt, $grades = null): int {
    return grader::grade_item_update($vrsculpt, $grades);
}

/**
 * Delete the grade item.
 *
 * @param stdClass $vrsculpt the vrsculpt row
 * @return int
 */
function vrsculpt_grade_item_delete(stdClass $vrsculpt): int {
    return grader::grade_item_delete($vrsculpt);
}

/**
 * Push grades to the gradebook.
 *
 * @param stdClass $vrsculpt the vrsculpt row
 * @param int $userid one user, or 0 for all
 * @param bool $nullifnone send a null grade when the user has none
 * @return void
 */
function vrsculpt_update_grades(stdClass $vrsculpt, int $userid = 0, bool $nullifnone = true): void {
    grader::update_grades($vrsculpt, $userid, $nullifnone);
}

/**
 * Whether a scale is used by an activity (grades are points only).
 *
 * @param int $vrsculptid the vrsculpt id
 * @param int $scaleid the scale id
 * @return bool
 */
function vrsculpt_scale_used(int $vrsculptid, int $scaleid): bool {
    return false;
}

/**
 * Whether a scale is used by any activity (grades are points only).
 *
 * @param int $scaleid the scale id
 * @return bool
 */
function vrsculpt_scale_used_anywhere(int $scaleid): bool {
    return false;
}

/**
 * The course reset form's elements for this module.
 *
 * @param MoodleQuickForm $mform the reset form
 * @return void
 */
function vrsculpt_reset_course_form_definition(&$mform): void {
    $mform->addElement('header', 'vrsculptheader', get_string('modulenameplural', 'vrsculpt'));
    $mform->addElement('advcheckbox', 'reset_vrsculpt_sessions', get_string('resetsessions', 'vrsculpt'));
}

/**
 * Course reset form defaults.
 *
 * @param stdClass $course the course
 * @return array
 */
function vrsculpt_reset_course_form_defaults(stdClass $course): array {
    return ['reset_vrsculpt_sessions' => 1];
}

/**
 * Reset the gradebook grades of every activity in a course.
 *
 * @param int $courseid the course id
 * @param string $type unused
 * @return void
 */
function vrsculpt_reset_gradebook(int $courseid, string $type = ''): void {
    global $DB;
    foreach ($DB->get_records('vrsculpt', ['course' => $courseid]) as $vrsculpt) {
        grader::grade_item_update($vrsculpt, 'reset');
    }
}

/**
 * Course reset: delete sculptures, versions and grades when asked.
 *
 * @param stdClass $data the reset form data
 * @return array status items
 */
function vrsculpt_reset_userdata(stdClass $data): array {
    global $DB;

    $status = [];
    $component = get_string('modulenameplural', 'vrsculpt');
    if (!empty($data->reset_vrsculpt_sessions)) {
        foreach ($DB->get_records('vrsculpt', ['course' => $data->courseid]) as $vrsculpt) {
            $cm = get_coursemodule_from_instance('vrsculpt', $vrsculpt->id, $data->courseid, false, IGNORE_MISSING);
            if ($cm) {
                session_manager::delete_all($vrsculpt, context_module::instance($cm->id));
            }
            $DB->delete_records('vrsculpt_grades', ['vrsculptid' => $vrsculpt->id]);
        }
        if (empty($data->reset_gradebook_grades)) {
            vrsculpt_reset_gradebook((int)$data->courseid);
        }
        $status[] = ['component' => $component, 'item' => get_string('resetsessions', 'vrsculpt'), 'error' => false];
    }
    return $status;
}

/**
 * Serve the snapshot files.
 *
 * Only to users who may see the session; always as a download, never inline.
 *
 * @param stdClass $course the course
 * @param stdClass $cm the course module
 * @param context $context the context
 * @param string $filearea the file area
 * @param array $args item id, then the file name
 * @param bool $forcedownload ignored: always downloaded
 * @param array $options extra options for send_stored_file()
 * @return bool false when not found
 */
function vrsculpt_pluginfile($course, $cm, $context, $filearea, $args, $forcedownload, array $options = []) {
    global $DB, $USER;

    if ($context->contextlevel != CONTEXT_MODULE || $filearea !== session_manager::FILEAREA || count($args) !== 2) {
        return false;
    }
    require_login($course, false, $cm);

    $snapshotid = (int)array_shift($args);
    $filename = clean_param(array_shift($args), PARAM_FILE);
    $vrsculpt = $DB->get_record('vrsculpt', ['id' => $cm->instance], '*', MUST_EXIST);
    $snapshot = $DB->get_record('vrsculpt_snapshots', ['id' => $snapshotid]);
    if (!$snapshot) {
        return false;
    }
    try {
        $session = session_manager::get_session((int)$snapshot->sessionid, $vrsculpt);
    } catch (moodle_exception $e) {
        return false;
    }
    if (!session_manager::can_view($session, $context, (int)$USER->id)) {
        return false;
    }
    $file = get_file_storage()->get_file($context->id, 'mod_vrsculpt', $filearea, $snapshotid, '/', $filename);
    if (!$file || $file->is_directory()) {
        return false;
    }
    send_stored_file($file, 0, 0, true, $options);
}
