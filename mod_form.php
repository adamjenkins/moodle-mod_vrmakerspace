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

use mod_vrsculpt\local\companion_manager;
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

        // Pair work is built in and always offered; the companion service only when its plugin is
        // installed (or the activity already uses it), with a note while it is not configured.
        $connections = [session_manager::CONNECTION_PAIR => get_string('connection_pair', 'vrsculpt')];
        $current = (string)($this->current->connectmode ?? '');
        if (companion_manager::is_installed() || $current === session_manager::CONNECTION_COMPANION) {
            $connections[session_manager::CONNECTION_COMPANION] = get_string('connection_companion', 'vrsculpt', 8);
        }
        $mform->addElement('select', 'connectmode', get_string('connection', 'vrsculpt'), $connections);
        $mform->addHelpButton('connectmode', 'connection', 'vrsculpt');
        $mform->setDefault('connectmode', session_manager::CONNECTION_PAIR);
        $mform->hideIf('connectmode', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);
        if (isset($connections[session_manager::CONNECTION_COMPANION]) && !companion_manager::is_available()) {
            $mform->addElement(
                'static',
                'companionnote',
                '',
                html_writer::div(get_string('connection_notconfigured', 'vrsculpt'), 'alert alert-warning mb-0')
            );
            $mform->hideIf('companionnote', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);
            $mform->hideIf('companionnote', 'connectmode', 'eq', session_manager::CONNECTION_PAIR);
        }

        $mform->addElement('select', 'maxusers', get_string('maxusers', 'vrsculpt'), array_combine(range(2, 8), range(2, 8)));
        $mform->addHelpButton('maxusers', 'maxusers', 'vrsculpt');
        $mform->setDefault('maxusers', 8);
        $mform->hideIf('maxusers', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);
        $mform->hideIf('maxusers', 'connectmode', 'eq', session_manager::CONNECTION_PAIR);

        $mform->addElement('advcheckbox', 'trackcontributions', get_string('trackcontributions', 'vrsculpt'));
        $mform->addHelpButton('trackcontributions', 'trackcontributions', 'vrsculpt');
        $mform->hideIf('trackcontributions', 'workmode', 'eq', session_manager::MODE_INDIVIDUAL);

        $this->standard_grading_coursemodule_elements();
        $this->standard_coursemodule_elements();
        $this->add_action_buttons();
    }

    /**
     * Validate the form: grades are points only; the companion service needs its plugin.
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
        if (
            (int)($data['workmode'] ?? 0) === session_manager::MODE_GROUP
                && ($data['connectmode'] ?? '') === session_manager::CONNECTION_COMPANION
                && !companion_manager::is_installed()
        ) {
            $errors['connectmode'] = get_string('connection_notinstalled', 'vrsculpt');
        }
        return $errors;
    }
}
