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
 * Library of functions for mod_vrmakerspace.
 *
 * The grade callbacks follow the flow of mod_vrroom's lib.php, which follows mod_gear's
 * (update_grades → grade_item_update).
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

use mod_vrmakerspace\local\grader;
use mod_vrmakerspace\local\session_manager;

/**
 * Whether the module supports a feature.
 *
 * @param string $feature FEATURE_xx constant.
 * @return mixed True or a value if supported, false if not, null if unknown.
 */
function vrmakerspace_supports(string $feature) {
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
function vrmakerspace_clean_instance_data(stdClass $data): stdClass {
    $data->methods = session_manager::clean_methods((string)($data->methods ?? ''));
    $data->startmodel = session_manager::start_model_for_methods(
        $data->methods,
        session_manager::clean_start_model((string)($data->startmodel ?? ''))
    );
    $data->workmode = (int)($data->workmode ?? 0) === session_manager::MODE_GROUP
        ? session_manager::MODE_GROUP : session_manager::MODE_INDIVIDUAL;
    // Group work only: pair (built in, two people at once) or companion (up to maxusers). Individual
    // work keeps the default, so switching to group work later starts with pair work.
    $data->connectmode = session_manager::connection($data);
    if ($data->workmode !== session_manager::MODE_GROUP) {
        $data->connectmode = session_manager::CONNECTION_PAIR;
    }
    $data->maxusers = min(8, max(2, (int)($data->maxusers ?? 8)));
    if ($data->connectmode === session_manager::CONNECTION_PAIR) {
        $data->maxusers = 2;
    }
    $data->trackcontributions = empty($data->trackcontributions) ? 0 : 1;
    $data->grade = max(0, (int)($data->grade ?? 0));
    return $data;
}

/**
 * Save the uploaded starting model from the form's file manager, or remove it when the activity
 * starts from a primitive. Without the file manager in the data (generators, web services), nothing
 * changes.
 *
 * @param stdClass $data cleaned form data (with coursemodule)
 * @return void
 */
function vrmakerspace_save_start_model(stdClass $data): void {
    if (!isset($data->startmodelfile) || empty($data->coursemodule)) {
        return;
    }
    $context = context_module::instance($data->coursemodule);
    if ($data->startmodel === session_manager::MODEL_UPLOAD) {
        file_save_draft_area_files(
            $data->startmodelfile,
            $context->id,
            'mod_vrmakerspace',
            session_manager::MODEL_FILEAREA,
            0,
            vrmakerspace_start_model_file_options()
        );
    } else {
        get_file_storage()->delete_area_files($context->id, 'mod_vrmakerspace', session_manager::MODEL_FILEAREA);
    }
}

/**
 * The options of the starting model's file manager.
 *
 * @return array
 */
function vrmakerspace_start_model_file_options(): array {
    return [
        'subdirs' => 0,
        'maxfiles' => 1,
        'maxbytes' => session_manager::MODEL_MAXBYTES,
        // Moodle's file types know .glb but not .stl or .obj, so the picker would refuse those: it takes
        // any file, and the form accepts only MODEL_FORMATS (session_manager::start_model_format()).
        'accepted_types' => '*',
    ];
}

/**
 * Add a new activity.
 *
 * @param stdClass $data Form data.
 * @param mod_vrmakerspace_mod_form|null $mform The form.
 * @return int The new vrmakerspace id.
 */
function vrmakerspace_add_instance(stdClass $data, ?mod_vrmakerspace_mod_form $mform = null): int {
    global $DB;

    $data = vrmakerspace_clean_instance_data($data);
    $data->timecreated = time();
    $data->timemodified = $data->timecreated;
    $data->id = $DB->insert_record('vrmakerspace', $data);
    vrmakerspace_save_start_model($data);
    grader::grade_item_update($data);
    return (int)$data->id;
}

/**
 * Update an activity.
 *
 * @param stdClass $data Form data.
 * @param mod_vrmakerspace_mod_form|null $mform The form.
 * @return bool
 */
function vrmakerspace_update_instance(stdClass $data, ?mod_vrmakerspace_mod_form $mform = null): bool {
    global $DB;

    $data = vrmakerspace_clean_instance_data($data);
    $data->id = $data->instance;
    $data->timemodified = time();
    $DB->update_record('vrmakerspace', $data);
    vrmakerspace_save_start_model($data);
    $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $data->id], '*', MUST_EXIST);
    if (property_exists($data, 'cmidnumber')) {
        $vrmakerspace->cmidnumber = $data->cmidnumber;
    }
    grader::grade_item_update($vrmakerspace);
    grader::update_grades($vrmakerspace, 0, false);
    return true;
}

/**
 * Delete an activity with its sessions, versions, files, live connections, contributions and grades.
 *
 * @param int $id The vrmakerspace id.
 * @return bool
 */
function vrmakerspace_delete_instance(int $id): bool {
    global $DB;

    $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $id]);
    if (!$vrmakerspace) {
        return false;
    }
    $cm = get_coursemodule_from_instance('vrmakerspace', $id, 0, false, IGNORE_MISSING);
    if ($cm) {
        session_manager::delete_all($vrmakerspace, context_module::instance($cm->id));
    } else {
        session_manager::delete_rows($id);
    }
    $DB->delete_records('vrmakerspace_grades', ['vrmakerspaceid' => $id]);
    grader::grade_item_delete($vrmakerspace);
    $DB->delete_records('vrmakerspace', ['id' => $id]);
    return true;
}

/**
 * Information about the activity for course listings, cached in modinfo.
 *
 * @param stdClass $coursemodule The course_modules row (with showdescription).
 * @return cached_cm_info|false
 */
function vrmakerspace_get_coursemodule_info(stdClass $coursemodule) {
    global $DB;

    $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $coursemodule->instance], 'id, name, intro, introformat');
    if (!$vrmakerspace) {
        return false;
    }
    $result = new cached_cm_info();
    $result->name = $vrmakerspace->name;
    if ($coursemodule->showdescription) {
        // Filters run at display time, so the cached copy is not filtered.
        $result->content = format_module_intro('vrmakerspace', $vrmakerspace, $coursemodule->id, false);
    }
    return $result;
}

/**
 * Mark the activity viewed: completion and the course_module_viewed event.
 *
 * @param stdClass $vrmakerspace the vrmakerspace row
 * @param stdClass $course the course
 * @param cm_info|stdClass $cm the course module
 * @param context_module $context its context
 * @return void
 */
function vrmakerspace_view(stdClass $vrmakerspace, stdClass $course, $cm, context_module $context): void {
    global $CFG;
    require_once($CFG->libdir . '/completionlib.php');

    $event = \mod_vrmakerspace\event\course_module_viewed::create([
        'objectid' => $vrmakerspace->id,
        'context' => $context,
    ]);
    $event->add_record_snapshot('course', $course);
    $event->add_record_snapshot('vrmakerspace', $vrmakerspace);
    $event->trigger();

    $completion = new completion_info($course);
    $completion->set_module_viewed($cm);
}

/**
 * Grades of the activity, for the gradebook.
 *
 * @param stdClass $vrmakerspace the vrmakerspace row
 * @param int $userid one user, or 0 for all
 * @return array
 */
function vrmakerspace_get_user_grades(stdClass $vrmakerspace, int $userid = 0): array {
    return grader::get_user_grades($vrmakerspace, $userid);
}

/**
 * Create or update the grade item.
 *
 * @param stdClass $vrmakerspace the vrmakerspace row
 * @param mixed $grades grades, 'reset', or null
 * @return int
 */
function vrmakerspace_grade_item_update(stdClass $vrmakerspace, $grades = null): int {
    return grader::grade_item_update($vrmakerspace, $grades);
}

/**
 * Delete the grade item.
 *
 * @param stdClass $vrmakerspace the vrmakerspace row
 * @return int
 */
function vrmakerspace_grade_item_delete(stdClass $vrmakerspace): int {
    return grader::grade_item_delete($vrmakerspace);
}

/**
 * Push grades to the gradebook.
 *
 * @param stdClass $vrmakerspace the vrmakerspace row
 * @param int $userid one user, or 0 for all
 * @param bool $nullifnone send a null grade when the user has none
 * @return void
 */
function vrmakerspace_update_grades(stdClass $vrmakerspace, int $userid = 0, bool $nullifnone = true): void {
    grader::update_grades($vrmakerspace, $userid, $nullifnone);
}

/**
 * Whether a scale is used by an activity (grades are points only).
 *
 * @param int $vrmakerspaceid the vrmakerspace id
 * @param int $scaleid the scale id
 * @return bool
 */
function vrmakerspace_scale_used(int $vrmakerspaceid, int $scaleid): bool {
    return false;
}

/**
 * Whether a scale is used by any activity (grades are points only).
 *
 * @param int $scaleid the scale id
 * @return bool
 */
function vrmakerspace_scale_used_anywhere(int $scaleid): bool {
    return false;
}

/**
 * The course reset form's elements for this module.
 *
 * @param MoodleQuickForm $mform the reset form
 * @return void
 */
function vrmakerspace_reset_course_form_definition(&$mform): void {
    $mform->addElement('header', 'vrmakerspaceheader', get_string('modulenameplural', 'vrmakerspace'));
    $mform->addElement('advcheckbox', 'reset_vrmakerspace_sessions', get_string('resetsessions', 'vrmakerspace'));
}

/**
 * Course reset form defaults.
 *
 * @param stdClass $course the course
 * @return array
 */
function vrmakerspace_reset_course_form_defaults(stdClass $course): array {
    return ['reset_vrmakerspace_sessions' => 1];
}

/**
 * Reset the gradebook grades of every activity in a course.
 *
 * @param int $courseid the course id
 * @param string $type unused
 * @return void
 */
function vrmakerspace_reset_gradebook(int $courseid, string $type = ''): void {
    global $DB;
    foreach ($DB->get_records('vrmakerspace', ['course' => $courseid]) as $vrmakerspace) {
        grader::grade_item_update($vrmakerspace, 'reset');
    }
}

/**
 * Course reset: delete pieces with their versions, live connections and contributions, and the
 * grades, when asked.
 *
 * @param stdClass $data the reset form data
 * @return array status items
 */
function vrmakerspace_reset_userdata(stdClass $data): array {
    global $DB;

    $status = [];
    $component = get_string('modulenameplural', 'vrmakerspace');
    if (!empty($data->reset_vrmakerspace_sessions)) {
        foreach ($DB->get_records('vrmakerspace', ['course' => $data->courseid]) as $vrmakerspace) {
            $cm = get_coursemodule_from_instance('vrmakerspace', $vrmakerspace->id, $data->courseid, false, IGNORE_MISSING);
            if ($cm) {
                session_manager::delete_all($vrmakerspace, context_module::instance($cm->id));
            }
            $DB->delete_records('vrmakerspace_grades', ['vrmakerspaceid' => $vrmakerspace->id]);
        }
        if (empty($data->reset_gradebook_grades)) {
            vrmakerspace_reset_gradebook((int)$data->courseid);
        }
        $status[] = ['component' => $component, 'item' => get_string('resetsessions', 'vrmakerspace'), 'error' => false];
    }
    return $status;
}

/**
 * Serve the snapshot files and the uploaded starting model.
 *
 * Snapshots only to users who may see the session, the starting model to users who may view the
 * activity; always as a download, never inline.
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
function vrmakerspace_pluginfile($course, $cm, $context, $filearea, $args, $forcedownload, array $options = []) {
    global $DB, $USER;

    if ($context->contextlevel != CONTEXT_MODULE || count($args) !== 2) {
        return false;
    }
    if ($filearea === session_manager::MODEL_FILEAREA) {
        // The starting model: activity material, for everyone who may see the activity.
        require_login($course, false, $cm);
        require_capability('mod/vrmakerspace:view', $context);
        $filename = clean_param($args[1], PARAM_FILE);
        $file = get_file_storage()->get_file($context->id, 'mod_vrmakerspace', $filearea, 0, '/', $filename);
        if ((int)$args[0] !== 0 || !$file || $file->is_directory()) {
            return false;
        }
        send_stored_file($file, 0, 0, true, $options);
    }
    if ($filearea !== session_manager::FILEAREA) {
        return false;
    }
    require_login($course, false, $cm);

    $snapshotid = (int)array_shift($args);
    $filename = clean_param(array_shift($args), PARAM_FILE);
    $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $cm->instance], '*', MUST_EXIST);
    $snapshot = $DB->get_record('vrmakerspace_snapshots', ['id' => $snapshotid]);
    if (!$snapshot) {
        return false;
    }
    try {
        $session = session_manager::get_session((int)$snapshot->sessionid, $vrmakerspace);
    } catch (moodle_exception $e) {
        return false;
    }
    if (!session_manager::can_view($session, $context, (int)$USER->id)) {
        return false;
    }
    $file = get_file_storage()->get_file($context->id, 'mod_vrmakerspace', $filearea, $snapshotid, '/', $filename);
    if (!$file || $file->is_directory()) {
        return false;
    }
    send_stored_file($file, 0, 0, true, $options);
}
