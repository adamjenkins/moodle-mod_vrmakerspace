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

namespace mod_vrsculpt\local;

/**
 * The grading page: every sculpture a teacher may see, who is graded for it, and saving the grades.
 *
 * An individual sculpture grades its owner. A group sculpture grades each member of the group who may
 * sculpt, one by one, or all of them at once with the group's "give every member this grade" field.
 * A user listed under two sculptures (a member of two groups) gets one grade field, under the first.
 * Only the users the page lists can be graded: posted ids are checked against the same list.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class grading_helper {
    /**
     * Who is graded for each sculpture a teacher may see.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param \cm_info|\stdClass $cm the course module
     * @param \context_module $context the activity context
     * @return array sessionid => ['session' => \stdClass, 'userids' => int[]] (a user under one sculpture only)
     */
    public static function gradable(\stdClass $vrsculpt, $cm, \context_module $context): array {
        $seen = [];
        $result = [];
        foreach (view_helper::visible_sessions($vrsculpt, $cm, $context) as $session) {
            if ((int)$session->groupid) {
                $users = get_enrolled_users($context, 'mod/vrsculpt:sculpt', (int)$session->groupid, 'u.id', 'u.id ASC');
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
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param array $gradable what gradable() returned for the page
     * @param array $grades user id => the posted field text
     * @param array $groupgrades session id => the posted group field text
     * @param int $graderid who grades (never from the client)
     * @return array{saved: int, errors: array} errors: user id => message
     */
    public static function save(
        \stdClass $vrsculpt,
        array $gradable,
        array $grades,
        array $groupgrades,
        int $graderid
    ): array {
        global $DB;

        // The value for each listed user: the group field first, then the user's own.
        $values = [];
        foreach ($gradable as $sessionid => $item) {
            $group = trim((string)($groupgrades[$sessionid] ?? ''));
            foreach ($item['userids'] as $userid) {
                if ((int)$item['session']->groupid && $group !== '') {
                    $values[$userid] = $group;
                } else if (array_key_exists($userid, $grades)) {
                    $values[$userid] = trim((string)$grades[$userid]);
                }
            }
        }

        $current = $DB->get_records_menu('vrsculpt_grades', ['vrsculptid' => $vrsculpt->id], '', 'userid, grade');
        $saved = 0;
        $errors = [];
        foreach ($values as $userid => $text) {
            if ($text === '') {
                $grade = null;
            } else {
                $grade = unformat_float($text, true);
                if ($grade === false || $grade === null) {
                    $errors[$userid] = get_string('gradeinvalid', 'vrsculpt');
                    continue;
                }
            }
            $old = $current[$userid] ?? null;
            if ($old === null ? $grade === null : $grade !== null && abs((float)$old - $grade) < 0.000005) {
                continue;
            }
            try {
                grader::save_grade($vrsculpt, (int)$userid, $grade, $graderid);
                $saved++;
            } catch (\moodle_exception $e) {
                $errors[$userid] = $e->getMessage();
            }
        }
        return ['saved' => $saved, 'errors' => $errors];
    }

    /**
     * The template data of the grading page.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param \context_module $context the activity context
     * @param array $gradable what gradable() returned
     * @param array $errors user id => message, from save()
     * @param array $posted user id => text posted, shown again next to an error
     * @return array
     */
    public static function template_data(
        \stdClass $vrsculpt,
        \context_module $context,
        array $gradable,
        array $errors = [],
        array $posted = []
    ): array {
        global $DB;
        $names = [];
        $current = $DB->get_records_menu('vrsculpt_grades', ['vrsculptid' => $vrsculpt->id], '', 'userid, grade');
        $tracked = !empty($vrsculpt->trackcontributions) && session_manager::is_group_work($vrsculpt);
        $canmanage = has_capability('mod/vrsculpt:managesessions', $context);

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
                    $value = (string)($posted[$userid] ?? $value);
                }
                $members[] = [
                    'userid' => $userid,
                    'name' => $name,
                    'inputid' => 'mod_vrsculpt-grade-' . $sessionid . '-' . $userid,
                    'label' => get_string('gradefor', 'vrsculpt', $name),
                    'value' => $value,
                    'error' => $errors[$userid] ?? '',
                    'haserror' => isset($errors[$userid]),
                ];
            }
            $contributions = $tracked ? view_helper::contribution_rows((int)$sessionid, $context, $names) : [];
            $owner = view_helper::owner_name($session, $context, $names);
            $managelinks = $canmanage ? view_helper::manage_links($session, $context, 'grade') : [];
            $sculptures[] = [
                'sessionid' => (int)$sessionid,
                'owner' => $owner,
                'isgroup' => (bool)(int)$session->groupid,
                'status' => view_helper::status_text($session),
                'version' => $latest ? (int)$latest->version : 0,
                'hasversion' => (bool)$latest,
                'lastsaved' => $latest ? userdate($latest->timecreated) : '',
                'viewurl' => $latest ? view_helper::studio_url($context, (int)$sessionid)->out(false) : '',
                'members' => $members,
                'hasmembers' => !empty($members),
                'grouplabel' => get_string('gradeallmembers', 'vrsculpt', $owner),
                'groupinputid' => 'mod_vrsculpt-groupgrade-' . $sessionid,
                'contributions' => $contributions,
                'hascontributions' => !empty($contributions),
                'managelinks' => $managelinks,
                'hasmanagelinks' => !empty($managelinks),
            ];
        }
        return [
            'cmid' => (int)$context->instanceid,
            'sesskey' => sesskey(),
            'actionurl' => (new \moodle_url('/mod/vrsculpt/grade.php'))->out(false),
            'maxgrade' => format_float((float)$vrsculpt->grade, 2),
            'sculptures' => $sculptures,
            'hassculptures' => !empty($sculptures),
            'tracked' => $tracked,
        ];
    }
}
