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
 * Site settings of mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

if ($ADMIN->fulltree) {
    $sizes = [];
    foreach ([1, 4, 8, 16, 32, 64] as $megabytes) {
        $sizes[$megabytes * 1048576] = display_size($megabytes * 1048576);
    }
    $settings->add(new admin_setting_configselect(
        'mod_vrmakerspace/maxsnapshotsize',
        new lang_string('maxsnapshotsize', 'vrmakerspace'),
        new lang_string('maxsnapshotsize_desc', 'vrmakerspace'),
        \mod_vrmakerspace\local\session_manager::DEFAULT_MAX_SNAPSHOT_SIZE,
        $sizes
    ));

    // The tutor's voice in tutorial mode: which service speaks and which listens, in order of preference.
    // Copied from mod_talkwithai's settings (same author). The tutor's answers come from the site's AI
    // provider (Site administration > AI); speaking and listening are separate and each can be off.
    $settings->add(new admin_setting_heading(
        'mod_vrmakerspace/speechorder_heading',
        new lang_string('speechorder_heading', 'vrmakerspace'),
        new lang_string('speechorder_heading_desc', 'vrmakerspace')
    ));

    $choices = \mod_vrmakerspace\speech\registry::choices();
    foreach ([\mod_vrmakerspace\speech\registry::SPEAK, \mod_vrmakerspace\speech\registry::LISTEN] as $direction) {
        for ($i = 1; $i <= \mod_vrmakerspace\speech\registry::SLOTS; $i++) {
            $settings->add(new admin_setting_configselect(
                'mod_vrmakerspace/' . $direction . 'order' . $i,
                new lang_string($direction . 'order' . $i, 'vrmakerspace'),
                $i === 1 ? new lang_string($direction . 'order_desc', 'vrmakerspace') : '',
                \mod_vrmakerspace\speech\registry::DEFAULT_ORDER[$i - 1],
                $choices
            ));
        }
    }

    // Speech in the browser.
    $settings->add(new admin_setting_heading(
        'mod_vrmakerspace/browserspeech_heading',
        new lang_string('browserspeech_heading', 'vrmakerspace'),
        new lang_string('browserspeech_heading_desc', 'vrmakerspace')
    ));
    $settings->add(new admin_setting_configcheckbox(
        'mod_vrmakerspace/browserstt',
        new lang_string('browserstt', 'vrmakerspace'),
        new lang_string('browserstt_desc', 'vrmakerspace'),
        1
    ));

    // The server-side speech engines, each with its own settings.
    foreach (\mod_vrmakerspace\speech\registry::ENGINES as $class) {
        $class::add_settings($settings);
    }
}
