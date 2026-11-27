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
 * The grading page: every piece a teacher may see, who is graded for it, and saving the grades.
 *
 * An individual piece grades its owner. A group piece grades each member of the group who may
 * work on it, one by one, or all of them at once with the group's "give every member this grade" field.
 * A user listed under two pieces (a member of two groups) gets one grade field, under the first.
 * Only the users the page lists can be graded: posted ids are checked against the same list.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class grading_helper {
    /**
     * Who is graded for each piece a teacher may see.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \cm_info|\stdClass $cm the course module
     * @param \context_module $context the activity context
     * @return array sessionid => ['session' => \stdClass, 'userids' => int[]] (a user under one piece only)
     */
    public static function gradable(\stdClass $vrmakerspace, $cm, \context_module $context): array {
        $seen = [];
        $result = [];
        foreach (view_helper::visible_sessions($vrmakerspace, $cm, $context) as $session) {
            if ((int)$session->groupid) {
                $users = get_enrolled_users($context, 'mod/vrmakerspace:make', (int)$session->groupid, 'u.id', 'u.id ASC');
                $userids = array_map('intval', array_keys($users));
            } else {
                $userids = [(int)$session->userid];
            }
            $userids = array_values(array_filter($userids, fn($userid) => !isset($seen[$userid])));
            foreach ($userids as $userid) {
                $seen[$userid] = true;
            }
            $result[(int)$session->id] = ['session' => $session, 'userids' => $userids];
        }
        return $result;
    }

    /**
     * Save the grades posted from the grading page.
     *
     * A field left as it was is not saved again; an emptied field clears the grade. A group's
     * "give every member this grade" value, when filled, replaces the members' own fields.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param array $gradable what gradable() returned for the page
     * @param array $grades user id => the posted field text
     * @param array $groupgrades session id => the posted group field text
     * @param int $graderid who grades (never from the client)
     * @return array{saved: int, errors: array} errors: user id => message
     */
    public static function save(
        \stdClass $vrmakerspace,
        array $gradable,
        array $grades,
        array $groupgrades,
        int $graderid
    ): array {
        global $DB;

        // The value for each listed user: the group field first, then the user's own.
        $values = [];
        foreach ($gradable as $sessionid => $item) {
            $group = self::grade_value($groupgrades[$sessionid] ?? null);
            foreach ($item['userids'] as $userid) {
                if ((int)$item['session']->groupid && $group !== null) {
                    $values[$userid] = $group;
                } else if (array_key_exists($userid, $grades)) {
                    $values[$userid] = self::grade_value($grades[$userid]);
                }
            }
        }

        $current = $DB->get_records_menu('vrmakerspace_grades', ['vrmakerspaceid' => $vrmakerspace->id], '', 'userid, grade');
        $saved = 0;
        $errors = [];
        foreach ($values as $userid => $grade) {
            if ($grade === false) {
                $errors[$userid] = get_string('gradeinvalid', 'vrmakerspace');
                continue;
            }
            $old = $current[$userid] ?? null;
            if ($old === null ? $grade === null : $grade !== null && abs((float)$old - $grade) < 0.000005) {
                continue;
            }
            try {
                grader::save_grade($vrmakerspace, (int)$userid, $grade, $graderid);
                $saved++;
            } catch (\moodle_exception $e) {
                $errors[$userid] = $e->getMessage();
            }
        }
        return ['saved' => $saved, 'errors' => $errors];
    }

    /**
     * One posted grade as a float, null (empty: no grade) or false (not a number). grade.php reads the fields with
     * PARAM_LOCALISEDFLOAT, which gives these already; text (other callers) is read the same way.
     *
     * @param mixed $value float, null, false or text
     * @return float|null|false
     */
    private static function grade_value($value) {
        if ($value === null || $value === false || is_float($value)) {
            return $value;
        }
        if (is_int($value)) {
            return (float)$value;
        }
        $text = trim((string)$value);
        if ($text === '') {
            return null;
        }
        $grade = unformat_float($text, true);
        return ($grade === null || $grade === false) ? false : (float)$grade;
    }

    /**
     * The template data of the grading page.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \context_module $context the activity context
     * @param array $gradable what gradable() returned
     * @param array $errors user id => message, from save()
     * @param array $posted user id => value posted (float, null, false or text), shown again next to an error
     * @return array
     */
    public static function template_data(
        \stdClass $vrmakerspace,
        \context_module $context,
        array $gradable,
        array $errors = [],
        array $posted = []
    ): array {
        global $DB;
        $names = [];
        $current = $DB->get_records_menu('vrmakerspace_grades', ['vrmakerspaceid' => $vrmakerspace->id], '', 'userid, grade');
        $tracked = !empty($vrmakerspace->trackcontributions) && session_manager::is_group_work($vrmakerspace);
        $canmanage = has_capability('mod/vrmakerspace:managesessions', $context);

        $sculptures = [];
        foreach ($gradable as $sessionid => $item) {
            $session = $item['session'];
            $latest = session_manager::get_latest_snapshot((int)$sessionid);
            $members = [];
            foreach ($item['userids'] as $userid) {
                $name = view_helper::user_name($userid, $context, $names);
                $value = '';
                if (isset($current[$userid]) && $current[$userid] !== null) {
                    $value = format_float((float)$current[$userid], 2);
                }
                if (isset($errors[$userid])) {
                    // What the teacher entered, shown again by its error: a number out of range as typed in their
                    // locale, a field that was not a number empty.
                    $entered = self::grade_value($posted[$userid] ?? null);
                    $value = is_float($entered) ? format_float($entered, -1) : '';
                }
                $members[] = [
                    'userid' => $userid,
                    'name' => $name,
                    'inputid' => 'mod_vrmakerspace-grade-' . $sessionid . '-' . $userid,
                    'label' => get_string('gradefor', 'vrmakerspace', $name),
                    'value' => $value,
                    'error' => $errors[$userid] ?? '',
                    'haserror' => isset($errors[$userid]),
                ];
            }
            $contributions = $tracked ? view_helper::contribution_rows((int)$sessionid, $context, $names) : [];
            $owner = view_helper::owner_name($session, $context, $names);
            $managelinks = $canmanage ? view_helper::manage_links($session, $context, 'grade') : [];
            $quickviewtitle = $latest ? get_string('quickviewtitle', 'vrmakerspace', [
                'owner' => $owner,
                'version' => (int)$latest->version,
            ]) : '';
            $sculptures[] = [
                'sessionid' => (int)$sessionid,
                'owner' => $owner,
                'isgroup' => (bool)(int)$session->groupid,
                'status' => view_helper::status_text($session),
                'version' => $latest ? (int)$latest->version : 0,
                'hasversion' => (bool)$latest,
                'lastsaved' => $latest ? userdate($latest->timecreated) : '',
                'viewurl' => $latest ? view_helper::studio_url($context, (int)$sessionid)->out(false) : '',
                'snapshoturl' => $latest ? session_manager::snapshot_url($latest, $context)->out(false) : '',
                'quickviewtitle' => $quickviewtitle,
                'members' => $members,
                'hasmembers' => !empty($members),
                'grouplabel' => get_string('gradeallmembers', 'vrmakerspace', $owner),
                'groupinputid' => 'mod_vrmakerspace-groupgrade-' . $sessionid,
                'contributions' => $contributions,
                'hascontributions' => !empty($contributions),
                'managelinks' => $managelinks,
                'hasmanagelinks' => !empty($managelinks),
            ];
        }
        return [
            'cmid' => (int)$context->instanceid,
            'sesskey' => sesskey(),
            'actionurl' => (new \moodle_url('/mod/vrmakerspace/grade.php'))->out(false),
            'maxgrade' => format_float((float)$vrmakerspace->grade, 2),
            'sculptures' => $sculptures,
            'hassculptures' => !empty($sculptures),
            'tracked' => $tracked,
        ];
    }
}
