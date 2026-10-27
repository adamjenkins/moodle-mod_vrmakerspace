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
 * Serves the sculpting engine's JavaScript modules (js/engine) to the studio's Web Worker.
 *
 * URL: /mod/vrsculpt/engine.php/<plugin version>/<file>.js. The version is part of the path, so the
 * modules' relative imports ('./grid.js') carry it too: an upgrade changes every URL, and the files can
 * be cached for a long time. The files are static program code with no user data, so no login is needed.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

// phpcs:disable moodle.Files.RequireLogin.Missing
define('NO_DEBUG_DISPLAY', true);
define('NO_MOODLE_COOKIES', true);
define('ABORT_AFTER_CONFIG', true);

require_once(__DIR__ . '/../../config.php');

$relativepath = min_get_slash_argument();
if (!preg_match('~^/([0-9]{10})/([a-z]+)\.js$~', (string)$relativepath, $matches)) {
    header('HTTP/1.1 404 Not Found');
    exit;
}
$path = __DIR__ . '/js/engine/' . $matches[2] . '.js';
if (!is_readable($path)) {
    header('HTTP/1.1 404 Not Found');
    exit;
}

header('Content-Type: text/javascript; charset=utf-8');
header('Content-Length: ' . filesize($path));
header('X-Content-Type-Options: nosniff');
header('Cache-Control: public, max-age=31536000, immutable');
readfile($path);
