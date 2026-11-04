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

namespace mod_vrmakerspace;

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/mod_form.php');

/**
 * Tests of the activity form's rule for the starting model and the ways of making. The whole form is
 * exercised by tests/behat/activity.feature.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace_mod_form::class)]
final class mod_form_test extends \advanced_testcase {
    /**
     * Each combination of ways of making and starting model: the lang string key of its error, if any.
     *
     * @param string $methods the ways of making
     * @param string $model the starting model
     * @param string $error the expected key, '' for none
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('start_model_provider')]
    public function test_start_model_error(string $methods, string $model, string $error): void {
        $this->assertSame($error, \mod_vrmakerspace_mod_form::start_model_error($methods, $model));
        if ($error !== '') {
            $this->assertTrue(get_string_manager()->string_exists($error, 'mod_vrmakerspace'));
        }
    }

    /**
     * Ways of making, starting model and the expected error.
     *
     * @return array
     */
    public static function start_model_provider(): array {
        return [
            'both, clay' => ['both', 'lump', ''],
            'both, polygon cube' => ['both', 'meshcube', ''],
            'both, upload' => ['both', 'upload', ''],
            'sculpt, clay' => ['sculpt', 'cube', ''],
            'sculpt, nothing' => ['sculpt', 'empty', ''],
            'sculpt, upload' => ['sculpt', 'upload', ''],
            'sculpt, polygon cube' => ['sculpt', 'meshcube', 'startmodel_needsclay'],
            'model, polygon cube' => ['model', 'meshcube', ''],
            'model, nothing' => ['model', 'empty', ''],
            'model, clay lump' => ['model', 'lump', 'startmodel_needsmesh'],
            'model, clay cube' => ['model', 'cube', 'startmodel_needsmesh'],
            'model, upload' => ['model', 'upload', 'startmodel_needsmesh'],
            'unknown ways are both' => ['telepathy', 'meshcube', ''],
        ];
    }
}
