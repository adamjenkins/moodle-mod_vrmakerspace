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

namespace mod_vrmakerspace\local;

/**
 * Grades of an activity: stored per user in vrmakerspace_grades and pushed to the gradebook.
 *
 * The gradebook flow (update_grades → grade_item_update → grade_update) follows mod_vrroom's grader,
 * which follows mod_gear's lib.php.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class grader {
    /**
     * Grade one user.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param int $userid the user graded
     * @param float|null $grade the grade, 0 to the activity's maximum, or null to clear it
     * @param int $graderid who gives it
     * @return void
     * @throws \moodle_exception gradeoutofrange
     */
    public static function save_grade(\stdClass $vrmakerspace, int $userid, ?float $grade, int $graderid): void {
        global $DB;

        if ($grade !== null && ($grade < 0 || $grade > (float)$vrmakerspace->grade)) {
            throw new \moodle_exception('gradeoutofrange', 'mod_vrmakerspace', '', format_float((float)$vrmakerspace->grade, 2));
        }
        $now = time();
        $existing = $DB->get_record('vrmakerspace_grades', ['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $userid]);
        if ($existing) {
            $existing->grade = $grade;
            $existing->grader = $graderid;
            $existing->timemodified = $now;
            $DB->update_record('vrmakerspace_grades', $existing);
        } else {
            $DB->insert_record('vrmakerspace_grades', (object)[
                'vrmakerspaceid' => $vrmakerspace->id,
                'userid' => $userid,
                'grade' => $grade,
                'grader' => $graderid,
                'timecreated' => $now,
                'timemodified' => $now,
            ]);
        }
        self::update_grades($vrmakerspace, $userid);
    }

    /**
     * Grades in the form grade_update() takes.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param int $userid one user, or 0 for all
     * @return array userid => object with userid, rawgrade, usermodified, dategraded, datesubmitted
     */
    public static function get_user_grades(\stdClass $vrmakerspace, int $userid = 0): array {
        global $DB;

        $conditions = ['vrmakerspaceid' => $vrmakerspace->id];
        if ($userid) {
            $conditions['userid'] = $userid;
        }
        $grades = [];
        foreach ($DB->get_records('vrmakerspace_grades', $conditions) as $record) {
            $grades[(int)$record->userid] = (object)[
                'userid' => (int)$record->userid,
                'rawgrade' => $record->grade === null ? null : (float)$record->grade,
                'usermodified' => (int)$record->grader,
                'dategraded' => (int)$record->timemodified,
                'datesubmitted' => (int)$record->timemodified,
            ];
        }
        return $grades;
    }

    /**
     * Create or update the grade item, optionally with grades.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row (with cmidnumber when coming from the form)
     * @param mixed $grades grade objects, 'reset' to reset the item, or null
     * @return int GRADE_UPDATE_OK or an error code
     */
    public static function grade_item_update(\stdClass $vrmakerspace, $grades = null): int {
        global $CFG;
        require_once($CFG->libdir . '/gradelib.php');

        $params = ['itemname' => $vrmakerspace->name];
        if (property_exists($vrmakerspace, 'cmidnumber')) {
            $params['idnumber'] = (string)$vrmakerspace->cmidnumber;
        }
        if ((int)$vrmakerspace->grade > 0) {
            $params['gradetype'] = GRADE_TYPE_VALUE;
            $params['grademax'] = (float)$vrmakerspace->grade;
            $params['grademin'] = 0;
        } else {
            $params['gradetype'] = GRADE_TYPE_NONE;
        }
        if ($grades === 'reset') {
            $params['reset'] = true;
            $grades = null;
        }
        return (int)grade_update(
            'mod/vrmakerspace',
            $vrmakerspace->course,
            'mod',
            'vrmakerspace',
            $vrmakerspace->id,
            0,
            $grades,
            $params
        );
    }

    /**
     * Delete the grade item.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return int GRADE_UPDATE_OK or an error code
     */
    public static function grade_item_delete(\stdClass $vrmakerspace): int {
        global $CFG;
        require_once($CFG->libdir . '/gradelib.php');
        return (int)grade_update(
            'mod/vrmakerspace',
            $vrmakerspace->course,
            'mod',
            'vrmakerspace',
            $vrmakerspace->id,
            0,
            null,
            ['deleted' => 1]
        );
    }

    /**
     * Push grades to the gradebook.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param int $userid one user, or 0 for all
     * @param bool $nullifnone send a null grade for $userid when the user has none
     * @return void
     */
    public static function update_grades(\stdClass $vrmakerspace, int $userid = 0, bool $nullifnone = true): void {
        if ((int)$vrmakerspace->grade === 0) {
            self::grade_item_update($vrmakerspace);
        } else if ($grades = self::get_user_grades($vrmakerspace, $userid)) {
            self::grade_item_update($vrmakerspace, $grades);
        } else if ($userid && $nullifnone) {
            self::grade_item_update($vrmakerspace, (object)['userid' => $userid, 'rawgrade' => null]);
        } else {
            self::grade_item_update($vrmakerspace);
        }
    }
}
