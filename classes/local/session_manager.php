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
 * Sessions (one piece of work each, with a clay layer and a polygon mesh layer) and their saved versions.
 *
 * A session belongs to one user (individual mode, groupid 0) or one group (group mode, userid 0).
 * Each saved version is a row in vrmakerspace_snapshots and one file in the snapshots file area of the
 * module context, item id = the snapshot id. A snapshot file is in the "VRSC" format: a 48-byte
 * little-endian header followed by one signed byte per voxel and, in version 2, the mesh, optionally
 * deflate-compressed; the header is checked before anything is stored.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class session_manager {
    /** @var int One piece per user. */
    public const MODE_INDIVIDUAL = 0;

    /** @var int One shared piece per group. */
    public const MODE_GROUP = 1;

    /** @var int Changes allowed. */
    public const STATUS_OPEN = 0;

    /** @var int Read-only. */
    public const STATUS_CLOSED = 1;

    /** @var string Students can both sculpt clay and model the mesh. */
    public const METHODS_BOTH = 'both';

    /** @var string Students can only sculpt clay. */
    public const METHODS_SCULPT = 'sculpt';

    /** @var string Students can only model the mesh. */
    public const METHODS_MODEL = 'model';

    /** @var string[] The activity's ways of making; the first is the default. */
    public const METHODS = [self::METHODS_BOTH, self::METHODS_SCULPT, self::METHODS_MODEL];

    /** @var string The starting model the teacher uploads (a file in MODEL_FILEAREA). */
    public const MODEL_UPLOAD = 'upload';

    /** @var string The starting model with no clay and no mesh. */
    public const MODEL_EMPTY = 'empty';

    /** @var string The starting model with no clay and a cube in the mesh layer. */
    public const MODEL_MESHCUBE = 'meshcube';

    /** @var string[] The starting models: three clay primitives, a polygon cube, nothing, and an uploaded model. */
    public const START_MODELS = ['lump', 'sphere', 'cube', self::MODEL_MESHCUBE, self::MODEL_EMPTY, self::MODEL_UPLOAD];

    /** @var string The file area holding the uploaded starting model (item 0). */
    public const MODEL_FILEAREA = 'startmodel';

    /** @var string[] File types an uploaded starting model may have (js/engine/meshimport.js reads them). */
    public const MODEL_FORMATS = ['stl', 'obj', 'glb'];

    /** @var int Largest uploaded starting model, in bytes (the studio fetches at most 32 MB). */
    public const MODEL_MAXBYTES = 33554432;

    /** @var string First bytes of every snapshot file (the format's magic number). */
    public const SNAPSHOT_MAGIC = 'VRSC';

    /** @var int Default largest snapshot, in bytes, when the admin setting is not set. */
    public const DEFAULT_MAX_SNAPSHOT_SIZE = 16777216;

    /** @var string The file area holding snapshot data. */
    public const FILEAREA = 'snapshots';

    /** @var string Group work with one partner, browser to browser (built in). */
    public const CONNECTION_PAIR = 'pair';

    /** @var string Group work over the companion service. */
    public const CONNECTION_COMPANION = 'companion';

    /** @var string[] The connections of group work. */
    public const CONNECTIONS = [self::CONNECTION_PAIR, self::CONNECTION_COMPANION];

    /** @var int Bytes of a snapshot's header. */
    public const SNAPSHOT_HEADER_SIZE = 48;

    /** @var int The snapshot format version the studio writes: clay and mesh. */
    public const SNAPSHOT_VERSION = 2;

    /** @var int The older snapshot format version, clay only. */
    public const SNAPSHOT_VERSION_CLAY = 1;

    /** @var int[] The snapshot format versions accepted. */
    public const SNAPSHOT_VERSIONS = [self::SNAPSHOT_VERSION_CLAY, self::SNAPSHOT_VERSION];

    /** @var int Bytes of the grid length that starts a version 2 payload. */
    public const SNAPSHOT_GRID_LENGTH_SIZE = 4;

    /** @var int Header flag: the payload is deflate-raw compressed. */
    public const SNAPSHOT_FLAG_DEFLATE = 1;

    /** @var int Smallest grid size on each axis. */
    public const SNAPSHOT_MIN_DIM = 8;

    /** @var int Largest grid size on each axis. */
    public const SNAPSHOT_MAX_DIM = 256;

    /** @var float Smallest voxel size, metres. */
    public const SNAPSHOT_MIN_VOXEL = 0.0005;

    /** @var float Largest voxel size, metres. */
    public const SNAPSHOT_MAX_VOXEL = 0.05;

    /** @var string[] What a teacher can do to a piece on the manage page. */
    public const MANAGE_ACTIONS = ['close', 'reopen', 'reset'];

    /**
     * The groups a user may work in for a group-mode activity: their groups in the activity's grouping.
     *
     * @param \cm_info|\stdClass $cm the course module
     * @param int $userid the user
     * @return \stdClass[] group records keyed by id
     */
    public static function get_user_groups($cm, int $userid): array {
        return groups_get_all_groups($cm->course, $userid, $cm->groupingid);
    }

    /**
     * The session a user works in, created on first use.
     *
     * Individual mode: the user's own session. Group mode: the session of $groupid, which must be one of
     * the user's groups in the activity's grouping; when $groupid is 0 the user's first such group.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \cm_info|\stdClass $cm the course module
     * @param int $userid the user
     * @param int $groupid group mode only: the group, 0 for the user's first
     * @return \stdClass|null the session row, or null when a group-mode user has no (such) group
     */
    public static function get_or_create_for_user(\stdClass $vrmakerspace, $cm, int $userid, int $groupid = 0): ?\stdClass {
        if ((int)$vrmakerspace->workmode === self::MODE_GROUP) {
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
            return self::get_or_create($vrmakerspace, $groupid, 0);
        }
        return self::get_or_create($vrmakerspace, 0, $userid);
    }

    /**
     * Find or create the session of one owner.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param int $groupid the group (group mode) or 0
     * @param int $userid the user (individual mode) or 0
     * @return \stdClass the session row
     */
    public static function get_or_create(\stdClass $vrmakerspace, int $groupid, int $userid): \stdClass {
        global $DB;

        $conditions = ['vrmakerspaceid' => $vrmakerspace->id, 'groupid' => $groupid, 'userid' => $userid];
        if ($session = $DB->get_record('vrmakerspace_sessions', $conditions)) {
            return $session;
        }
        $now = time();
        $session = (object)($conditions + [
            'startmodel' => self::clean_start_model((string)$vrmakerspace->startmodel),
            'status' => self::STATUS_OPEN,
            'timecreated' => $now,
            'timemodified' => $now,
        ]);
        try {
            $session->id = $DB->insert_record('vrmakerspace_sessions', $session);
        } catch (\dml_write_exception $e) {
            // Another request created it first (unique index vrmakerspaceid, groupid, userid).
            return $DB->get_record('vrmakerspace_sessions', $conditions, '*', MUST_EXIST);
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
     * A ways-of-making value, or the default when it is not one of METHODS.
     *
     * @param string $methods the value
     * @return string
     */
    public static function clean_methods(string $methods): string {
        return in_array($methods, self::METHODS, true) ? $methods : self::METHODS[0];
    }

    /**
     * An activity's ways of making: one of METHODS.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return string
     */
    public static function methods(\stdClass $vrmakerspace): string {
        return self::clean_methods((string)($vrmakerspace->methods ?? ''));
    }

    /**
     * Whether a starting model suits the ways of making: modelling alone starts from the polygon cube or
     * from nothing, since clay could not be changed; sculpting alone cannot start from the polygon cube.
     *
     * @param string $methods one of METHODS
     * @param string $model the starting model
     * @return bool
     */
    public static function start_model_allowed(string $methods, string $model): bool {
        if (!in_array($model, self::START_MODELS, true)) {
            return false;
        }
        return match ($methods) {
            self::METHODS_MODEL => $model === self::MODEL_MESHCUBE || $model === self::MODEL_EMPTY,
            self::METHODS_SCULPT => $model !== self::MODEL_MESHCUBE,
            default => true,
        };
    }

    /**
     * The starting model to use with the ways of making: the given one when it suits them, otherwise
     * the polygon cube for modelling alone and the default for anything else.
     *
     * @param string $methods one of METHODS
     * @param string $model the starting model
     * @return string
     */
    public static function start_model_for_methods(string $methods, string $model): string {
        if (self::start_model_allowed($methods, $model)) {
            return $model;
        }
        return $methods === self::METHODS_MODEL ? self::MODEL_MESHCUBE : self::START_MODELS[0];
    }

    /**
     * Whether an activity is done in groups (one shared piece per group).
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return bool
     */
    public static function is_group_work(\stdClass $vrmakerspace): bool {
        return (int)$vrmakerspace->workmode === self::MODE_GROUP;
    }

    /**
     * The connection of an activity's group work: one of CONNECTIONS, pair when unknown.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return string
     */
    public static function connection(\stdClass $vrmakerspace): string {
        $connection = (string)($vrmakerspace->connectmode ?? '');
        return in_array($connection, self::CONNECTIONS, true) ? $connection : self::CONNECTION_PAIR;
    }

    /**
     * Load a session of this activity.
     *
     * @param int $sessionid the session id (client-supplied: never trusted on its own)
     * @param \stdClass $vrmakerspace the activity it must belong to
     * @return \stdClass the session row
     * @throws \moodle_exception invalidsession when it does not exist or belongs to another activity
     */
    public static function get_session(int $sessionid, \stdClass $vrmakerspace): \stdClass {
        global $DB;
        $session = $DB->get_record('vrmakerspace_sessions', ['id' => $sessionid]);
        if (!$session || (int)$session->vrmakerspaceid !== (int)$vrmakerspace->id) {
            throw new \moodle_exception('invalidsession', 'mod_vrmakerspace');
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
     * Whether a user may see a session's piece and history.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user
     * @return bool
     */
    public static function can_view(\stdClass $session, \context_module $context, int $userid): bool {
        if (!has_capability('mod/vrmakerspace:view', $context, $userid)) {
            return false;
        }
        return self::is_owner($session, $userid) || has_capability('mod/vrmakerspace:viewallsubmissions', $context, $userid);
    }

    /**
     * Whether a user may work on (save versions of) a session.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user
     * @return bool
     */
    public static function can_make(\stdClass $session, \context_module $context, int $userid): bool {
        return (int)$session->status === self::STATUS_OPEN
            && has_capability('mod/vrmakerspace:make', $context, $userid)
            && self::is_owner($session, $userid);
    }

    /**
     * The largest snapshot accepted, in bytes.
     *
     * @return int
     */
    public static function max_snapshot_size(): int {
        $size = (int)get_config('mod_vrmakerspace', 'maxsnapshotsize');
        return $size > 0 ? $size : self::DEFAULT_MAX_SNAPSHOT_SIZE;
    }

    /**
     * Check a snapshot's header against the "VRSC" format, versions 1 and 2.
     *
     * Header (little-endian): 0 "VRSC"; 4 u16 format version (1 or 2); 6 u16 flags (bit 0 = deflate-raw
     * sections, no other bits); 8, 10, 12 u16 grid size on x, y, z (8..256 each); 14 u16 reserved;
     * 16 f32 voxel size in metres (0.0005..0.05); 20 f32 band in metres (> 0); 24 u32 the edit sequence
     * number the data reflects; 28 16 bytes epoch; 44 u32 payload length (file length - 48).
     *
     * The payload of version 1 is the grid section alone. The payload of version 2 is u32 grid length,
     * the grid section, then the mesh section (the rest, which the studio parses strictly when it reads
     * the file). An uncompressed grid section holds exactly one byte per voxel.
     *
     * @param string $data the snapshot bytes
     * @return array the header: version, flags, nx, ny, nz, voxel, band, seq, epoch, length, gridlength
     * @throws \moodle_exception snapshotinvalid
     */
    public static function validate_snapshot(string $data): array {
        $size = strlen($data);
        if ($size <= self::SNAPSHOT_HEADER_SIZE || substr($data, 0, 4) !== self::SNAPSHOT_MAGIC) {
            throw new \moodle_exception('snapshotinvalid', 'mod_vrmakerspace');
        }
        $header = unpack('vversion/vflags/vnx/vny/vnz/vreserved/gvoxel/gband/Vseq', substr($data, 4, 24));
        $header['epoch'] = substr($data, 28, 16);
        $header['length'] = unpack('V', substr($data, 44, 4))[1];

        $header['gridlength'] = $header['length'];

        $valid = in_array($header['version'], self::SNAPSHOT_VERSIONS, true)
            && ($header['flags'] & ~self::SNAPSHOT_FLAG_DEFLATE) === 0
            && $header['length'] === $size - self::SNAPSHOT_HEADER_SIZE
            && is_finite($header['voxel'])
            && $header['voxel'] >= self::SNAPSHOT_MIN_VOXEL - 1e-9
            && $header['voxel'] <= self::SNAPSHOT_MAX_VOXEL + 1e-9
            && is_finite($header['band'])
            && $header['band'] > 0;
        foreach (['nx', 'ny', 'nz'] as $axis) {
            $valid = $valid && $header[$axis] >= self::SNAPSHOT_MIN_DIM && $header[$axis] <= self::SNAPSHOT_MAX_DIM;
        }
        if ($valid && $header['version'] === self::SNAPSHOT_VERSION) {
            $room = $header['length'] - self::SNAPSHOT_GRID_LENGTH_SIZE;
            $valid = $room >= 0;
            if ($valid) {
                $header['gridlength'] = unpack(
                    'V',
                    substr($data, self::SNAPSHOT_HEADER_SIZE, self::SNAPSHOT_GRID_LENGTH_SIZE)
                )[1];
                $valid = $header['gridlength'] > 0 && $header['gridlength'] <= $room;
            }
        }
        if ($valid && !($header['flags'] & self::SNAPSHOT_FLAG_DEFLATE)) {
            $valid = $header['gridlength'] === $header['nx'] * $header['ny'] * $header['nz'];
        }
        if (!$valid) {
            throw new \moodle_exception('snapshotinvalid', 'mod_vrmakerspace');
        }
        return $header;
    }

    /**
     * Save a new version of a session's piece.
     *
     * The caller has checked can_make(). The data is checked here: not over the size limit, and a
     * valid "VRSC" header (validate_snapshot()). The version's operation count is the header's
     * sequence number: the number of confirmed edits the data reflects.
     *
     * Data identical to the latest version (both partners of a pair pressing Save, or an autosave with
     * nothing new) does not make a new version: the latest one is returned.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid who saves it
     * @param string $data the snapshot bytes
     * @return \stdClass the new vrmakerspace_snapshots row, or the latest one when the data is the same
     * @throws \moodle_exception snapshottoolarge or snapshotinvalid
     */
    public static function save_snapshot(
        \stdClass $session,
        \context_module $context,
        int $userid,
        string $data
    ): \stdClass {
        global $DB;

        $size = strlen($data);
        if ($size > self::max_snapshot_size()) {
            throw new \moodle_exception('snapshottoolarge', 'mod_vrmakerspace', '', display_size(self::max_snapshot_size()));
        }
        $header = self::validate_snapshot($data);

        $latest = self::get_latest_snapshot((int)$session->id);
        if ($latest) {
            $file = self::get_snapshot_file($latest, $context);
            if ($file && $file->get_contenthash() === \file_storage::hash_from_string($data)) {
                return $latest;
            }
        }

        $transaction = $DB->start_delegated_transaction();
        $version = (int)$DB->get_field_sql(
            'SELECT COALESCE(MAX(version), 0) FROM {vrmakerspace_snapshots} WHERE sessionid = ?',
            [$session->id]
        ) + 1;
        $now = time();
        $snapshot = (object)[
            'sessionid' => $session->id,
            'version' => $version,
            'userid' => $userid,
            'opcount' => (int)$header['seq'],
            'filesize' => $size,
            'timecreated' => $now,
        ];
        $snapshot->id = $DB->insert_record('vrmakerspace_snapshots', $snapshot);
        get_file_storage()->create_file_from_string([
            'contextid' => $context->id,
            'component' => 'mod_vrmakerspace',
            'filearea' => self::FILEAREA,
            'itemid' => $snapshot->id,
            'filepath' => '/',
            'filename' => self::snapshot_filename($snapshot),
            'userid' => $userid,
        ], $data);
        $DB->set_field('vrmakerspace_sessions', 'timemodified', $now, ['id' => $session->id]);
        $transaction->allow_commit();
        return $snapshot;
    }

    /**
     * The file name of a snapshot.
     *
     * @param \stdClass $snapshot the vrmakerspace_snapshots row
     * @return string
     */
    public static function snapshot_filename(\stdClass $snapshot): string {
        return 'piece-v' . (int)$snapshot->version . '.vrsc';
    }

    /**
     * The file of a snapshot.
     *
     * @param \stdClass $snapshot the vrmakerspace_snapshots row
     * @param \context_module $context the activity context
     * @return \stored_file|null
     */
    public static function get_snapshot_file(\stdClass $snapshot, \context_module $context): ?\stored_file {
        $file = get_file_storage()->get_file(
            $context->id,
            'mod_vrmakerspace',
            self::FILEAREA,
            $snapshot->id,
            '/',
            self::snapshot_filename($snapshot)
        );
        return $file ?: null;
    }

    /**
     * The activity's uploaded starting model, if it has one of a known type.
     *
     * @param \context_module $context the activity context
     * @return \stored_file|null
     */
    public static function start_model_file(\context_module $context): ?\stored_file {
        $files = get_file_storage()->get_area_files($context->id, 'mod_vrmakerspace', self::MODEL_FILEAREA, 0, 'id', false);
        foreach ($files as $file) {
            if (self::start_model_format($file->get_filename()) !== '') {
                return $file;
            }
        }
        return null;
    }

    /**
     * The format of an uploaded starting model, from its file name.
     *
     * @param string $filename the file name
     * @return string one of MODEL_FORMATS, or '' for any other file
     */
    public static function start_model_format(string $filename): string {
        $extension = \core_text::strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        return in_array($extension, self::MODEL_FORMATS, true) ? $extension : '';
    }

    /**
     * The URL of a snapshot's file.
     *
     * @param \stdClass $snapshot the vrmakerspace_snapshots row
     * @param \context_module $context the activity context
     * @return \moodle_url
     */
    public static function snapshot_url(\stdClass $snapshot, \context_module $context): \moodle_url {
        return \moodle_url::make_pluginfile_url(
            $context->id,
            'mod_vrmakerspace',
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
     * @return \stdClass[] vrmakerspace_snapshots rows keyed by id
     */
    public static function get_snapshots(int $sessionid): array {
        global $DB;
        return $DB->get_records('vrmakerspace_snapshots', ['sessionid' => $sessionid], 'version ASC');
    }

    /**
     * The latest version of a session.
     *
     * @param int $sessionid the session id
     * @return \stdClass|null the vrmakerspace_snapshots row, or null when nothing was saved yet
     */
    public static function get_latest_snapshot(int $sessionid): ?\stdClass {
        global $DB;
        $records = $DB->get_records('vrmakerspace_snapshots', ['sessionid' => $sessionid], 'version DESC', '*', 0, 1);
        return $records ? reset($records) : null;
    }

    /**
     * A version of a session by its number.
     *
     * @param int $sessionid the session id
     * @param int $version the version number
     * @return \stdClass|null the vrmakerspace_snapshots row, or null when there is no such version
     */
    public static function get_snapshot_by_version(int $sessionid, int $version): ?\stdClass {
        global $DB;
        return $DB->get_record('vrmakerspace_snapshots', ['sessionid' => $sessionid, 'version' => $version]) ?: null;
    }

    /**
     * Close or reopen a piece.
     *
     * @param \stdClass $session the session row; its status is updated too
     * @param int $status STATUS_OPEN or STATUS_CLOSED
     * @return void
     * @throws \moodle_exception invalidstatus
     */
    public static function set_status(\stdClass $session, int $status): void {
        global $DB;
        if ($status !== self::STATUS_OPEN && $status !== self::STATUS_CLOSED) {
            throw new \moodle_exception('invalidstatus', 'mod_vrmakerspace');
        }
        $now = time();
        $DB->update_record('vrmakerspace_sessions', (object)['id' => $session->id, 'status' => $status, 'timemodified' => $now]);
        $session->status = $status;
        $session->timemodified = $now;
    }

    /**
     * Start a piece again: delete every version (with its file), the recorded contributions and the
     * live connections. The piece itself, its owner and its status stay.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @return void
     */
    public static function reset_session(\stdClass $session, \context_module $context): void {
        global $DB;
        $fs = get_file_storage();
        foreach ($DB->get_records('vrmakerspace_snapshots', ['sessionid' => $session->id], '', 'id') as $snapshot) {
            $fs->delete_area_files($context->id, 'mod_vrmakerspace', self::FILEAREA, $snapshot->id);
        }
        $DB->delete_records('vrmakerspace_snapshots', ['sessionid' => $session->id]);
        $DB->delete_records('vrmakerspace_contrib', ['sessionid' => $session->id]);
        $DB->delete_records('vrmakerspace_signals', ['sessionid' => $session->id]);
        $DB->delete_records('vrmakerspace_peers', ['sessionid' => $session->id]);
        $DB->set_field('vrmakerspace_sessions', 'timemodified', time(), ['id' => $session->id]);
    }

    /**
     * Carry out a teacher's action on a piece (the caller has checked managesessions and sesskey).
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param string $action one of MANAGE_ACTIONS
     * @return string the lang string key (mod_vrmakerspace) of the message telling what was done
     * @throws \moodle_exception invalidaction
     */
    public static function manage(\stdClass $session, \context_module $context, string $action): string {
        switch ($action) {
            case 'close':
                self::set_status($session, self::STATUS_CLOSED);
                return 'managedone_close';
            case 'reopen':
                self::set_status($session, self::STATUS_OPEN);
                return 'managedone_reopen';
            case 'reset':
                self::reset_session($session, $context);
                return 'managedone_reset';
        }
        throw new \moodle_exception('invalidaction', 'mod_vrmakerspace');
    }

    /**
     * Delete sessions with their versions, files, live connections and contributions.
     *
     * @param \stdClass[] $sessions vrmakerspace_sessions rows
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
        $snapshots = $DB->get_records_select('vrmakerspace_snapshots', "sessionid $insql", $params, '', 'id');
        foreach ($snapshots as $snapshot) {
            $fs->delete_area_files($context->id, 'mod_vrmakerspace', self::FILEAREA, $snapshot->id);
        }
        $DB->delete_records_select('vrmakerspace_snapshots', "sessionid $insql", $params);
        $DB->delete_records_select('vrmakerspace_contrib', "sessionid $insql", $params);
        $DB->delete_records_select('vrmakerspace_signals', "sessionid $insql", $params);
        $DB->delete_records_select('vrmakerspace_peers', "sessionid $insql", $params);
        $DB->delete_records_select('vrmakerspace_sessions', "id $insql", $params);
    }

    /**
     * Delete the rows of every session of an activity (not the files: see delete_all()).
     *
     * For an activity whose course module is already gone, so that it has no context.
     *
     * @param int $vrmakerspaceid the vrmakerspace id
     * @return void
     */
    public static function delete_rows(int $vrmakerspaceid): void {
        global $DB;
        $select = 'sessionid IN (SELECT id FROM {vrmakerspace_sessions} WHERE vrmakerspaceid = ?)';
        foreach (['vrmakerspace_snapshots', 'vrmakerspace_contrib', 'vrmakerspace_signals', 'vrmakerspace_peers'] as $table) {
            $DB->delete_records_select($table, $select, [$vrmakerspaceid]);
        }
        $DB->delete_records('vrmakerspace_sessions', ['vrmakerspaceid' => $vrmakerspaceid]);
    }

    /**
     * Delete every session of an activity, with everything that belongs to them.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \context_module $context its context
     * @return void
     */
    public static function delete_all(\stdClass $vrmakerspace, \context_module $context): void {
        self::delete_rows((int)$vrmakerspace->id);
        get_file_storage()->delete_area_files($context->id, 'mod_vrmakerspace', self::FILEAREA);
    }
}
