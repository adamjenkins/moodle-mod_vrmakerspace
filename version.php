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
 * Version details for mod_vrsculpt.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$plugin->component = 'mod_vrsculpt';
$plugin->version = 2026102703;
$plugin->release = '0.1.0';
$plugin->maturity = MATURITY_ALPHA;
// Moodle 5.2.0 (the v5.2.0 tag's public/version.php: 2026042000.00), as mod_vrroom.
$plugin->requires = 2026042000;
$plugin->supported = [502, 503];
// The 3D studio loads three.js, the WebXR helpers and the presence codec from VR room's built-in run
// mode (vrroomruntime_builtin, bundled with mod_vrroom). The companion service (vrroomruntime_companion)
// is optional: group sculptures use it only when it is installed and configured.
$plugin->dependencies = ['vrroomruntime_builtin' => 2026101100];
