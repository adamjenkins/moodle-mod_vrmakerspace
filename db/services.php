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
 * Web service functions of mod_vrsculpt.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$functions = [
    'mod_vrsculpt_get_session_state' => [
        'classname' => \mod_vrsculpt\external\get_session_state::class,
        'description' => 'The state of a sculpting session: its starting model and latest saved version.',
        'type' => 'read',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:view',
    ],
    'mod_vrsculpt_save_snapshot' => [
        'classname' => \mod_vrsculpt\external\save_snapshot::class,
        'description' => 'Save the current sculpture of a session as a new version.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
];
