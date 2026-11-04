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
 * Each member's share of a piece, when the activity tracks contributions.
 *
 * Every studio reports its own user's increments now and then (operations made, clay added and
 * removed in cubic millimetres). A report is a claim by the browser, so it is bounded here: each
 * increment is capped per report, and at most one report per user and piece is accepted every
 * MIN_INTERVAL seconds. The shares are a guide for the teacher, not a proof.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class contribution_manager {
    /** @var int Most operations one report adds. */
    public const MAX_OPS = 5000;

    /** @var float Most cubic millimetres one report adds to added or to removed. */
    public const MAX_VOLUME = 1e7;

    /** @var int Seconds between two accepted reports of one user for one piece. */
    public const MIN_INTERVAL = 10;

    /** @var float Largest total a counter keeps (the column is NUMBER(12, 2)). */
    private const MAX_TOTAL = 9999999999.99;

    /**
     * Add a user's increments to their record of a piece.
     *
     * The caller has checked that the user may work on the session and that the activity tracks
     * contributions. Negative values count as 0; values over the caps count as the cap.
     *
     * @param \stdClass $session the session row
     * @param int $userid the user (never from the client)
     * @param int $ops operations made since the last report
     * @param float $added clay added since the last report, mm³
     * @param float $removed clay removed since the last report, mm³
     * @param int|null $now current time
     * @return bool whether the report was accepted (false: too soon after the last one)
     */
    public static function report(
        \stdClass $session,
        int $userid,
        int $ops,
        float $added,
        float $removed,
        ?int $now = null
    ): bool {
        global $DB;
        $now = $now ?? time();
        $ops = min(self::MAX_OPS, max(0, $ops));
        $added = self::clamp_volume($added);
        $removed = self::clamp_volume($removed);

        $conditions = ['sessionid' => (int)$session->id, 'userid' => $userid];
        $record = $DB->get_record('vrmakerspace_contrib', $conditions);
        if (!$record) {
            try {
                $DB->insert_record('vrmakerspace_contrib', (object)($conditions + [
                    'ops' => $ops,
                    'added' => round($added, 2),
                    'removed' => round($removed, 2),
                    'timemodified' => $now,
                    'lastreport' => $now,
                ]));
                return true;
            } catch (\dml_write_exception $e) {
                // A simultaneous first report won the unique index (sessionid, userid): this one is too soon.
                return false;
            }
        }
        if ((int)$record->lastreport > $now - self::MIN_INTERVAL) {
            return false;
        }
        // Only add when the row still carries the report time read above, so two reports at once count once.
        $DB->execute(
            'UPDATE {vrmakerspace_contrib}
                SET ops = ops + :ops, added = :added, removed = :removed, timemodified = :now1, lastreport = :now2
              WHERE id = :id AND lastreport = :lastreport',
            [
                'ops' => $ops,
                'added' => round(min(self::MAX_TOTAL, (float)$record->added + $added), 2),
                'removed' => round(min(self::MAX_TOTAL, (float)$record->removed + $removed), 2),
                'now1' => $now,
                'now2' => $now,
                'id' => $record->id,
                'lastreport' => $record->lastreport,
            ]
        );
        return (int)$DB->get_field('vrmakerspace_contrib', 'lastreport', ['id' => $record->id]) === $now;
    }

    /**
     * The members' shares of a piece, largest first.
     *
     * A share is the user's part of all the clay added and removed; while no clay has moved, of all
     * the operations.
     *
     * @param int $sessionid the session id
     * @return array list of ['userid' => int, 'ops' => int, 'added' => float, 'removed' => float,
     *     'share' => float (0..100)]
     */
    public static function summary(int $sessionid): array {
        global $DB;
        $rows = $DB->get_records('vrmakerspace_contrib', ['sessionid' => $sessionid], 'id ASC');
        $totalvolume = 0.0;
        $totalops = 0;
        foreach ($rows as $row) {
            $totalvolume += (float)$row->added + (float)$row->removed;
            $totalops += (int)$row->ops;
        }
        $summary = [];
        foreach ($rows as $row) {
            $volume = (float)$row->added + (float)$row->removed;
            if ($totalvolume > 0) {
                $share = 100 * $volume / $totalvolume;
            } else {
                $share = $totalops > 0 ? 100 * (int)$row->ops / $totalops : 0.0;
            }
            $summary[] = [
                'userid' => (int)$row->userid,
                'ops' => (int)$row->ops,
                'added' => (float)$row->added,
                'removed' => (float)$row->removed,
                'share' => round($share, 1),
            ];
        }
        usort($summary, fn($a, $b) => $b['share'] <=> $a['share'] ?: $a['userid'] <=> $b['userid']);
        return $summary;
    }

    /**
     * A volume increment within 0..MAX_VOLUME (not a number counts as 0).
     *
     * @param float $value the value reported
     * @return float
     */
    private static function clamp_volume(float $value): float {
        if (!is_finite($value) || $value < 0) {
            return 0.0;
        }
        return min(self::MAX_VOLUME, $value);
    }
}
