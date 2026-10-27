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
 * Settings form of a VR sculpting activity.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once($CFG->dirroot . '/course/moodleform_mod.php');

use mod_vrsculpt\local\session_manager;

/**
 * Settings form of a VR sculpting activity.
 */
class mod_vrsculpt_mod_form extends moodleform_mod {
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

        $mform->addElement('header', 'sculptinghdr', get_string('sculptingsettings', 'vrsculpt'));

        $models = [];
        foreach (session_manager::START_MODELS as $model) {
            $models[$model] = get_string('startmodel_' . $model, 'vrsculpt');
        }
        $mform->addElement('select', 'startmodel', get_string('startmodel', 'vrsculpt'), $models);
        $mform->addHelpButton('startmodel', 'startmodel', 'vrsculpt');
        $mform->setDefault('startmodel', 'lump');

        $mform->addElement('select', 'workmode', get_string('workmode', 'vrsculpt'), [
            session_manager::MODE_INDIVIDUAL => get_string('workmode_individual', 'vrsculpt'),
            session_manager::MODE_GROUP => get_string('workmode_group', 'vrsculpt'),
        ]);
        $mform->addHelpButton('workmode', 'workmode', 'vrsculpt');
        $mform->setDefault('workmode', session_manager::MODE_INDIVIDUAL);

        $mform->addElement('select', 'maxusers', get_string('maxusers', 'vrsculpt'), array_combine(range(2, 8), range(2, 8)));
        $mform->addHelpButton('maxusers', 'maxusers', 'vrsculpt');
        $mform->setDefault('maxusers', 8);
        $mform->hideIf('maxusers', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);

        $mform->addElement('advcheckbox', 'trackcontributions', get_string('trackcontributions', 'vrsculpt'));
        $mform->addHelpButton('trackcontributions', 'trackcontributions', 'vrsculpt');
        $mform->hideIf('trackcontributions', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);

        $this->standard_grading_coursemodule_elements();
        $this->standard_coursemodule_elements();
        $this->add_action_buttons();
    }

    /**
     * Validate the form: grades are points only.
     *
     * @param array $data submitted data
     * @param array $files submitted files
     * @return array errors by element name
     */
    public function validation($data, $files) {
        $errors = parent::validation($data, $files);
        if (isset($data['grade']) && (int)$data['grade'] < 0) {
            $errors['grade'] = get_string('errornoscales', 'vrsculpt');
        }
        return $errors;
    }
}
