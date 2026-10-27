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
 * Site settings of mod_vrsculpt.
 *
 * @package    mod_vrsculpt
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
        'mod_vrsculpt/maxsnapshotsize',
        new lang_string('maxsnapshotsize', 'vrsculpt'),
        new lang_string('maxsnapshotsize_desc', 'vrsculpt'),
        \mod_vrsculpt\local\session_manager::DEFAULT_MAX_SNAPSHOT_SIZE,
        $sizes
    ));
}
