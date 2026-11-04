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
 * Settings form of a VR Makerspace activity.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once($CFG->dirroot . '/course/moodleform_mod.php');
require_once($CFG->dirroot . '/mod/vrmakerspace/lib.php');

use mod_vrmakerspace\local\companion_manager;
use mod_vrmakerspace\local\session_manager;

/**
 * Settings form of a VR Makerspace activity.
 */
class mod_vrmakerspace_mod_form extends moodleform_mod {
    /**
     * Define the form.
     *
     * @return void
     */
    public function definition() {
        $mform = $this->_form;

        $mform->addElement('header', 'general', get_string('general', 'form'));
        $mform->addElement('text', 'name', get_string('name'), ['size' => '64']);
        $mform->setType('name', PARAM_TEXT);
        $mform->addRule('name', null, 'required', null, 'client');
        $mform->addRule('name', get_string('maximumchars', '', 255), 'maxlength', 255, 'client');
        $this->standard_intro_elements();

        $mform->addElement('header', 'makinghdr', get_string('sculptingsettings', 'vrmakerspace'));
        $mform->setExpanded('makinghdr');

        $methods = [];
        foreach (session_manager::METHODS as $method) {
            $methods[$method] = get_string('methods_' . $method, 'vrmakerspace');
        }
        $mform->addElement('select', 'methods', get_string('methods', 'vrmakerspace'), $methods);
        $mform->addHelpButton('methods', 'methods', 'vrmakerspace');
        $mform->setDefault('methods', session_manager::METHODS_BOTH);

        $models = [];
        foreach (session_manager::START_MODELS as $model) {
            $models[$model] = get_string('startmodel_' . $model, 'vrmakerspace');
        }
        $mform->addElement('select', 'startmodel', get_string('startmodel', 'vrmakerspace'), $models);
        $mform->addHelpButton('startmodel', 'startmodel', 'vrmakerspace');
        $mform->setDefault('startmodel', 'lump');
        $this->start_model_follows_methods();

        $mform->addElement(
            'filemanager',
            'startmodelfile',
            get_string('startmodelfile', 'vrmakerspace'),
            null,
            $this->start_model_file_options()
        );
        $mform->addHelpButton('startmodelfile', 'startmodelfile', 'vrmakerspace');
        $mform->hideIf('startmodelfile', 'startmodel', 'neq', session_manager::MODEL_UPLOAD);

        $mform->addElement('select', 'workmode', get_string('workmode', 'vrmakerspace'), [
            session_manager::MODE_INDIVIDUAL => get_string('workmode_individual', 'vrmakerspace'),
            session_manager::MODE_GROUP => get_string('workmode_group', 'vrmakerspace'),
        ]);
        $mform->addHelpButton('workmode', 'workmode', 'vrmakerspace');
        $mform->setDefault('workmode', session_manager::MODE_INDIVIDUAL);

        // Pair work is built in and always offered; the companion service only when its plugin is
        // installed (or the activity already uses it), with a note while it is not configured.
        $connections = [session_manager::CONNECTION_PAIR => get_string('connection_pair', 'vrmakerspace')];
        $current = (string)($this->current->connectmode ?? '');
        if (companion_manager::is_installed() || $current === session_manager::CONNECTION_COMPANION) {
            $connections[session_manager::CONNECTION_COMPANION] = get_string('connection_companion', 'vrmakerspace', 8);
        }
        $mform->addElement('select', 'connectmode', get_string('connection', 'vrmakerspace'), $connections);
        $mform->addHelpButton('connectmode', 'connection', 'vrmakerspace');
        $mform->setDefault('connectmode', session_manager::CONNECTION_PAIR);
        $mform->hideIf('connectmode', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);
        if (isset($connections[session_manager::CONNECTION_COMPANION]) && !companion_manager::is_available()) {
            $mform->addElement(
                'static',
                'companionnote',
                '',
                html_writer::div(get_string('connection_notconfigured', 'vrmakerspace'), 'alert alert-warning mb-0')
            );
            $mform->hideIf('companionnote', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);
            $mform->hideIf('companionnote', 'connectmode', 'eq', session_manager::CONNECTION_PAIR);
        }

        $mform->addElement('select', 'maxusers', get_string('maxusers', 'vrmakerspace'), array_combine(range(2, 8), range(2, 8)));
        $mform->addHelpButton('maxusers', 'maxusers', 'vrmakerspace');
        $mform->setDefault('maxusers', 8);
        $mform->hideIf('maxusers', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);
        $mform->hideIf('maxusers', 'connectmode', 'eq', session_manager::CONNECTION_PAIR);

        $mform->addElement('advcheckbox', 'trackcontributions', get_string('trackcontributions', 'vrmakerspace'));
        $mform->addHelpButton('trackcontributions', 'trackcontributions', 'vrmakerspace');
        $mform->setDefault('trackcontributions', 1);
        $mform->hideIf('trackcontributions', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);

        $this->standard_grading_coursemodule_elements();
        $this->standard_coursemodule_elements();
        $this->add_action_buttons();
    }

    /**
     * When the teacher picks ways of making the chosen starting model does not suit, select one that
     * does (modelling only: the polygon cube). Without JavaScript, validation() says what to change.
     *
     * @return void
     */
    protected function start_model_follows_methods(): void {
        global $PAGE;
        $allowed = [];
        $fallback = [];
        foreach (session_manager::METHODS as $methods) {
            $allowed[$methods] = array_values(array_filter(
                session_manager::START_MODELS,
                fn($model) => session_manager::start_model_allowed($methods, $model)
            ));
            $fallback[$methods] = session_manager::start_model_for_methods($methods, '');
        }
        $PAGE->requires->js_amd_inline('(function(allowed, fallback) {
            var methods = document.getElementById("id_methods");
            var start = document.getElementById("id_startmodel");
            if (!methods || !start) {
                return;
            }
            methods.addEventListener("change", function() {
                if (allowed[methods.value].indexOf(start.value) === -1) {
                    start.value = fallback[methods.value];
                    start.dispatchEvent(new Event("change", {bubbles: true}));
                }
            });
        })(' . json_encode($allowed) . ', ' . json_encode($fallback) . ');');
    }

    /**
     * What is wrong with a starting model for the ways of making.
     *
     * @param string $methods the ways of making, as submitted
     * @param string $model the starting model, as submitted
     * @return string the lang string key of the error, or '' when the model suits them
     */
    public static function start_model_error(string $methods, string $model): string {
        $methods = session_manager::clean_methods($methods);
        if (session_manager::start_model_allowed($methods, $model)) {
            return '';
        }
        return $methods === session_manager::METHODS_MODEL ? 'startmodel_needsmesh' : 'startmodel_needsclay';
    }

    /**
     * The starting model's file manager options, limited to the course's upload limit.
     *
     * @return array
     */
    protected function start_model_file_options(): array {
        global $CFG;
        $options = vrmakerspace_start_model_file_options();
        $coursebytes = get_user_max_upload_file_size($this->context, $CFG->maxbytes, $this->get_course()->maxbytes);
        if ($coursebytes > 0) {
            $options['maxbytes'] = min($options['maxbytes'], $coursebytes);
        }
        return $options;
    }

    /**
     * Load the uploaded starting model into the file manager's draft area.
     *
     * @param array $defaultvalues the form's default values, by reference
     * @return void
     */
    public function data_preprocessing(&$defaultvalues) {
        $draftitemid = file_get_submitted_draft_itemid('startmodelfile');
        file_prepare_draft_area(
            $draftitemid,
            $this->context ? $this->context->id : null,
            'mod_vrmakerspace',
            session_manager::MODEL_FILEAREA,
            0,
            vrmakerspace_start_model_file_options()
        );
        $defaultvalues['startmodelfile'] = $draftitemid;
    }

    /**
     * Validate the form: grades are points only; the companion service needs its plugin; the starting
     * model must suit the ways of making; an uploaded starting model needs its file.
     *
     * @param array $data submitted data
     * @param array $files submitted files
     * @return array errors by element name
     */
    public function validation($data, $files) {
        $errors = parent::validation($data, $files);
        if (isset($data['grade']) && (int)$data['grade'] < 0) {
            $errors['grade'] = get_string('errornoscales', 'vrmakerspace');
        }
        if (
            (int)($data['workmode'] ?? 0) === session_manager::MODE_GROUP
                && ($data['connectmode'] ?? '') === session_manager::CONNECTION_COMPANION
                && !companion_manager::is_installed()
        ) {
            $errors['connectmode'] = get_string('connection_notinstalled', 'vrmakerspace');
        }
        $modelerror = self::start_model_error((string)($data['methods'] ?? ''), (string)($data['startmodel'] ?? ''));
        if ($modelerror !== '') {
            $errors['startmodel'] = get_string($modelerror, 'vrmakerspace');
        } else if (($data['startmodel'] ?? '') === session_manager::MODEL_UPLOAD) {
            $files = file_get_drafarea_files((int)($data['startmodelfile'] ?? 0))->list;
            $models = array_filter($files, fn($file) => session_manager::start_model_format($file->filename) !== '');
            if (!$models) {
                $errors['startmodelfile'] = get_string('startmodelfile_required', 'vrmakerspace');
            }
        }
        return $errors;
    }
}
