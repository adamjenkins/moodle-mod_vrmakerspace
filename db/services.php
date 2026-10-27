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
    'mod_vrsculpt_pair_join' => [
        'classname' => \mod_vrsculpt\external\pair_join::class,
        'description' => 'Join a group sculpture to sculpt it with one partner, browser to browser.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
    'mod_vrsculpt_pair_signal' => [
        'classname' => \mod_vrsculpt\external\pair_signal::class,
        'description' => 'Send a connection message to the partner\'s browser.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
    'mod_vrsculpt_pair_poll' => [
        'classname' => \mod_vrsculpt\external\pair_poll::class,
        'description' => 'Stay connected to a group sculpture and fetch the partner\'s connection messages.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
    'mod_vrsculpt_pair_leave' => [
        'classname' => \mod_vrsculpt\external\pair_leave::class,
        'description' => 'Leave a group sculpture of pair work.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
    'mod_vrsculpt_companion_join' => [
        'classname' => \mod_vrsculpt\external\companion_join::class,
        'description' => 'A short-lived token to sculpt a group sculpture over the companion service.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
    'mod_vrsculpt_report_contribution' => [
        'classname' => \mod_vrsculpt\external\report_contribution::class,
        'description' => 'Add to the caller\'s recorded share of a group sculpture.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:sculpt',
    ],
    'mod_vrsculpt_set_session_status' => [
        'classname' => \mod_vrsculpt\external\set_session_status::class,
        'description' => 'Close or reopen a sculpture.',
        'type' => 'write',
        'ajax' => true,
        'capabilities' => 'mod/vrsculpt:managesessions',
    ],
];
