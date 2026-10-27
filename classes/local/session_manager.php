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
 * Sculpting sessions (one sculpture each) and their saved versions.
 *
 * A session belongs to one user (individual mode, groupid 0) or one group (group mode, userid 0).
 * Each saved version is a row in vrsculpt_snapshots and one file in the snapshots file area of the
 * module context, item id = the snapshot id.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class session_manager {
    /** @var int One sculpture per user. */
    public const MODE_INDIVIDUAL = 0;

    /** @var int One shared sculpture per group. */
    public const MODE_GROUP = 1;

    /** @var int Sculpting allowed. */
    public const STATUS_OPEN = 0;

    /** @var int Read-only. */
    public const STATUS_CLOSED = 1;

    /** @var string[] The starting primitives. */
    public const START_MODELS = ['lump', 'sphere', 'cube'];

    /** @var string First bytes of every snapshot file (the sculpture format's magic number). */
    public const SNAPSHOT_MAGIC = 'VRSC';

    /** @var int Default largest snapshot, in bytes, when the admin setting is not set. */
    public const DEFAULT_MAX_SNAPSHOT_SIZE = 16777216;

    /** @var string The file area holding snapshot data. */
    public const FILEAREA = 'snapshots';

    /**
     * The groups a user may sculpt in for a group-mode activity: their groups in the activity's grouping.
     *
     * @param \cm_info|\stdClass $cm the course module
     * @param int $userid the user
     * @return \stdClass[] group records keyed by id
     */
    public static function get_user_groups($cm, int $userid): array {
        return groups_get_all_groups($cm->course, $userid, $cm->groupingid);
    }

    /**
     * The session a user sculpts in, created on first use.
     *
     * Individual mode: the user's own session. Group mode: the session of $groupid, which must be one of
     * the user's groups in the activity's grouping; when $groupid is 0 the user's first such group.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param \cm_info|\stdClass $cm the course module
     * @param int $userid the user
     * @param int $groupid group mode only: the group, 0 for the user's first
     * @return \stdClass|null the session row, or null when a group-mode user has no (such) group
     */
    public static function get_or_create_for_user(\stdClass $vrsculpt, $cm, int $userid, int $groupid = 0): ?\stdClass {
        if ((int)$vrsculpt->workmode === self::MODE_GROUP) {
            $groups = self::get_user_groups($cm, $userid);
            if ($groupid) {
                if (!isset($groups[$groupid])) {
                    return null;
                }
            } else if ($groups) {
                $groupid = (int)array_key_first($groups);
            } else {
                return null;
            }
            return self::get_or_create($vrsculpt, $groupid, 0);
        }
        return self::get_or_create($vrsculpt, 0, $userid);
    }

    /**
     * Find or create the session of one owner.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param int $groupid the group (group mode) or 0
     * @param int $userid the user (individual mode) or 0
     * @return \stdClass the session row
     */
    public static function get_or_create(\stdClass $vrsculpt, int $groupid, int $userid): \stdClass {
        global $DB;

        $conditions = ['vrsculptid' => $vrsculpt->id, 'groupid' => $groupid, 'userid' => $userid];
        if ($session = $DB->get_record('vrsculpt_sessions', $conditions)) {
            return $session;
        }
        $now = time();
        $session = (object)($conditions + [
            'startmodel' => self::clean_start_model((string)$vrsculpt->startmodel),
            'status' => self::STATUS_OPEN,
            'timecreated' => $now,
            'timemodified' => $now,
        ]);
        try {
            $session->id = $DB->insert_record('vrsculpt_sessions', $session);
        } catch (\dml_write_exception $e) {
            // Another request created it first (unique index vrsculptid, groupid, userid).
            return $DB->get_record('vrsculpt_sessions', $conditions, '*', MUST_EXIST);
        }
        return $session;
    }

    /**
     * A starting model name, or the default when it is not one of START_MODELS.
     *
     * @param string $model the name
     * @return string
     */
    public static function clean_start_model(string $model): string {
        return in_array($model, self::START_MODELS, true) ? $model : self::START_MODELS[0];
    }

    /**
     * Load a session of this activity.
     *
     * @param int $sessionid the session id (client-supplied: never trusted on its own)
     * @param \stdClass $vrsculpt the activity it must belong to
     * @return \stdClass the session row
     * @throws \moodle_exception invalidsession when it does not exist or belongs to another activity
     */
    public static function get_session(int $sessionid, \stdClass $vrsculpt): \stdClass {
        global $DB;
        $session = $DB->get_record('vrsculpt_sessions', ['id' => $sessionid]);
        if (!$session || (int)$session->vrsculptid !== (int)$vrsculpt->id) {
            throw new \moodle_exception('invalidsession', 'mod_vrsculpt');
        }
        return $session;
    }

    /**
     * Whether a user is one of the owners of a session: the user of an individual session or a member
     * of the group of a group session.
     *
     * @param \stdClass $session the session row
     * @param int $userid the user
     * @return bool
     */
    public static function is_owner(\stdClass $session, int $userid): bool {
        if ((int)$session->groupid) {
            return groups_is_member((int)$session->groupid, $userid);
        }
        return (int)$session->userid === $userid;
    }

    /**
     * Whether a user may see a session's sculpture and history.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user
     * @return bool
     */
    public static function can_view(\stdClass $session, \context_module $context, int $userid): bool {
        if (!has_capability('mod/vrsculpt:view', $context, $userid)) {
            return false;
        }
        return self::is_owner($session, $userid) || has_capability('mod/vrsculpt:viewallsubmissions', $context, $userid);
    }

    /**
     * Whether a user may sculpt in (save versions of) a session.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user
     * @return bool
     */
    public static function can_sculpt(\stdClass $session, \context_module $context, int $userid): bool {
        return (int)$session->status === self::STATUS_OPEN
            && has_capability('mod/vrsculpt:sculpt', $context, $userid)
            && self::is_owner($session, $userid);
    }

    /**
     * The largest snapshot accepted, in bytes.
     *
     * @return int
     */
    public static function max_snapshot_size(): int {
        $size = (int)get_config('mod_vrsculpt', 'maxsnapshotsize');
        return $size > 0 ? $size : self::DEFAULT_MAX_SNAPSHOT_SIZE;
    }

    /**
     * Save a new version of a session's sculpture.
     *
     * The caller has checked can_sculpt(). The data is checked here: not empty, not over the size
     * limit, and starting with the format's magic number.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid who saves it
     * @param string $data the snapshot bytes
     * @param int $opcount sculpting operations applied since the session started
     * @return \stdClass the new vrsculpt_snapshots row
     * @throws \moodle_exception snapshottoolarge or snapshotinvalid
     */
    public static function save_snapshot(
        \stdClass $session,
        \context_module $context,
        int $userid,
        string $data,
        int $opcount
    ): \stdClass {
        global $DB;

        $size = strlen($data);
        if ($size > self::max_snapshot_size()) {
            throw new \moodle_exception('snapshottoolarge', 'mod_vrsculpt', '', display_size(self::max_snapshot_size()));
        }
        if ($size <= strlen(self::SNAPSHOT_MAGIC) || !str_starts_with($data, self::SNAPSHOT_MAGIC)) {
            throw new \moodle_exception('snapshotinvalid', 'mod_vrsculpt');
        }

        $transaction = $DB->start_delegated_transaction();
        $version = (int)$DB->get_field_sql(
            'SELECT COALESCE(MAX(version), 0) FROM {vrsculpt_snapshots} WHERE sessionid = ?',
            [$session->id]
        ) + 1;
        $now = time();
        $snapshot = (object)[
            'sessionid' => $session->id,
            'version' => $version,
            'userid' => $userid,
            'opcount' => max(0, $opcount),
            'filesize' => $size,
            'timecreated' => $now,
        ];
        $snapshot->id = $DB->insert_record('vrsculpt_snapshots', $snapshot);
        get_file_storage()->create_file_from_string([
            'contextid' => $context->id,
            'component' => 'mod_vrsculpt',
            'filearea' => self::FILEAREA,
            'itemid' => $snapshot->id,
            'filepath' => '/',
            'filename' => self::snapshot_filename($snapshot),
            'userid' => $userid,
        ], $data);
        $DB->set_field('vrsculpt_sessions', 'timemodified', $now, ['id' => $session->id]);
        $transaction->allow_commit();
        return $snapshot;
    }

    /**
     * The file name of a snapshot.
     *
     * @param \stdClass $snapshot the vrsculpt_snapshots row
     * @return string
     */
    public static function snapshot_filename(\stdClass $snapshot): string {
        return 'sculpture-v' . (int)$snapshot->version . '.vrsc';
    }

    /**
     * The file of a snapshot.
     *
     * @param \stdClass $snapshot the vrsculpt_snapshots row
     * @param \context_module $context the activity context
     * @return \stored_file|null
     */
    public static function get_snapshot_file(\stdClass $snapshot, \context_module $context): ?\stored_file {
        $file = get_file_storage()->get_file(
            $context->id,
            'mod_vrsculpt',
            self::FILEAREA,
            $snapshot->id,
            '/',
            self::snapshot_filename($snapshot)
        );
        return $file ?: null;
    }

    /**
     * The URL of a snapshot's file.
     *
     * @param \stdClass $snapshot the vrsculpt_snapshots row
     * @param \context_module $context the activity context
     * @return \moodle_url
     */
    public static function snapshot_url(\stdClass $snapshot, \context_module $context): \moodle_url {
        return \moodle_url::make_pluginfile_url(
            $context->id,
            'mod_vrsculpt',
            self::FILEAREA,
            $snapshot->id,
            '/',
            self::snapshot_filename($snapshot),
            true
        );
    }

    /**
     * All versions of a session, oldest first.
     *
     * @param int $sessionid the session id
     * @return \stdClass[] vrsculpt_snapshots rows keyed by id
     */
    public static function get_snapshots(int $sessionid): array {
        global $DB;
        return $DB->get_records('vrsculpt_snapshots', ['sessionid' => $sessionid], 'version ASC');
    }

    /**
     * The latest version of a session.
     *
     * @param int $sessionid the session id
     * @return \stdClass|null the vrsculpt_snapshots row, or null when nothing was saved yet
     */
    public static function get_latest_snapshot(int $sessionid): ?\stdClass {
        global $DB;
        $records = $DB->get_records('vrsculpt_snapshots', ['sessionid' => $sessionid], 'version DESC', '*', 0, 1);
        return $records ? reset($records) : null;
    }

    /**
     * Delete sessions with their versions and files.
     *
     * @param \stdClass[] $sessions vrsculpt_sessions rows
     * @param \context_module $context the activity context they belong to
     * @return void
     */
    public static function delete_sessions(array $sessions, \context_module $context): void {
        global $DB;
        if (!$sessions) {
            return;
        }
        $fs = get_file_storage();
        [$insql, $params] = $DB->get_in_or_equal(array_map(fn($s) => (int)$s->id, $sessions));
        $snapshots = $DB->get_records_select('vrsculpt_snapshots', "sessionid $insql", $params, '', 'id');
        foreach ($snapshots as $snapshot) {
            $fs->delete_area_files($context->id, 'mod_vrsculpt', self::FILEAREA, $snapshot->id);
        }
        $DB->delete_records_select('vrsculpt_snapshots', "sessionid $insql", $params);
        $DB->delete_records_select('vrsculpt_sessions', "id $insql", $params);
    }

    /**
     * Delete every session of an activity.
     *
     * @param \stdClass $vrsculpt the vrsculpt row
     * @param \context_module $context its context
     * @return void
     */
    public static function delete_all(\stdClass $vrsculpt, \context_module $context): void {
        global $DB;
        $DB->delete_records_select(
            'vrsculpt_snapshots',
            'sessionid IN (SELECT id FROM {vrsculpt_sessions} WHERE vrsculptid = ?)',
            [$vrsculpt->id]
        );
        $DB->delete_records('vrsculpt_sessions', ['vrsculptid' => $vrsculpt->id]);
        get_file_storage()->delete_area_files($context->id, 'mod_vrsculpt', self::FILEAREA);
    }
}
