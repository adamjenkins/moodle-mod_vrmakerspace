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

namespace mod_vrmakerspace\completion;

use core_completion\activity_custom_completion;
use mod_vrmakerspace\local\tutorial;

/**
 * Custom completion: finish the tutorial (every step of the activity done or skipped, at least once).
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class custom_completion extends activity_custom_completion {
    /**
     * Completion state of the rule for the user.
     *
     * @param string $rule the rule
     * @return int COMPLETION_COMPLETE or COMPLETION_INCOMPLETE
     */
    public function get_state(string $rule): int {
        $this->validate_rule($rule);
        $progress = tutorial::get_progress((int)$this->cm->instance, (int)$this->userid);
        return $progress && (int)$progress->timecompleted > 0 ? COMPLETION_COMPLETE : COMPLETION_INCOMPLETE;
    }

    /**
     * The rules this activity defines.
     *
     * @return string[]
     */
    public static function get_defined_custom_rules(): array {
        return ['completiontutorial'];
    }

    /**
     * Rule descriptions.
     *
     * @return array
     */
    public function get_custom_rule_descriptions(): array {
        return ['completiontutorial' => get_string('completiondetail:tutorial', 'mod_vrmakerspace')];
    }

    /**
     * Rule display order.
     *
     * @return string[]
     */
    public function get_sort_order(): array {
        return ['completionview', 'completionusegrade', 'completionpassgrade', 'completiontutorial'];
    }
}
