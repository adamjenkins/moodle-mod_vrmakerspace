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
 * Data generator for mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

use mod_vrmakerspace\local\session_manager;

/**
 * Data generator for mod_vrmakerspace: activities, pieces and saved versions.
 */
class mod_vrmakerspace_generator extends testing_module_generator {
    /**
     * Create an activity.
     *
     * @param array|stdClass|null $record fields of the vrmakerspace row
     * @param array|null $options general options for course module creation
     * @return stdClass the activity record with cmid
     */
    public function create_instance($record = null, ?array $options = null) {
        $record = (array)($record ?? []) + [
            'methods' => session_manager::METHODS_BOTH,
            'startmodel' => 'lump',
            'workmode' => session_manager::MODE_INDIVIDUAL,
            'connectmode' => session_manager::CONNECTION_PAIR,
            'maxusers' => 8,
            'trackcontributions' => 0,
            'grade' => 100,
        ];
        return parent::create_instance($record, $options);
    }

    /**
     * Create (or find) a piece.
     *
     * @param array $record vrmakerspaceid, and groupid or userid
     * @return stdClass the session row
     */
    public function create_session(array $record): stdClass {
        global $DB;
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $record['vrmakerspaceid']], '*', MUST_EXIST);
        return session_manager::get_or_create($vrmakerspace, (int)($record['groupid'] ?? 0), (int)($record['userid'] ?? 0));
    }

    /**
     * The bytes of a valid "VRSC" snapshot: an uncompressed grid of $dim voxels per axis whose voxel bytes
     * repeat $tag (so different tags give different files) and, in version 2, an empty mesh, so that the
     * studio can read the file as well.
     *
     * @param string $tag the bytes the grid repeats
     * @param int $seq the edit sequence number in the header (stored as the version's opcount)
     * @param int $dim the grid size on each axis (8..256)
     * @param int $version the format version: session_manager::SNAPSHOT_VERSIONS
     * @return string
     */
    public function snapshot_data(
        string $tag = 'test',
        int $seq = 1,
        int $dim = 8,
        int $version = session_manager::SNAPSHOT_VERSION
    ): string {
        $tag = $tag === '' ? "\x7f" : $tag;
        $count = $dim * $dim * $dim;
        $payload = substr(str_repeat($tag, intdiv($count, strlen($tag)) + 1), 0, $count);
        if ($version === session_manager::SNAPSHOT_VERSION) {
            $payload = pack('V', $count) . $payload . '{"v":[],"f":[],"s":[]}';
        }
        return session_manager::SNAPSHOT_MAGIC
            . pack('vvvvvv', $version, 0, $dim, $dim, $dim, 0)
            . pack('g', 0.004)
            . pack('g', 0.012)
            . pack('V', $seq)
            . str_repeat("\0", 16)
            . pack('V', strlen($payload))
            . $payload;
    }

    /**
     * Save a version of a piece.
     *
     * @param stdClass $session the session row
     * @param int $userid who saves it
     * @param string $tag the bytes the payload repeats (see snapshot_data())
     * @param int $opcount the edit sequence number in the header
     * @return stdClass the snapshot row
     */
    public function create_snapshot(stdClass $session, int $userid, string $tag = 'test', int $opcount = 1): stdClass {
        global $DB;
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $session->vrmakerspaceid], '*', MUST_EXIST);
        $cm = get_coursemodule_from_instance('vrmakerspace', $vrmakerspace->id, $vrmakerspace->course, false, MUST_EXIST);
        return session_manager::save_snapshot(
            $session,
            context_module::instance($cm->id),
            $userid,
            $this->snapshot_data($tag, $opcount)
        );
    }

    /**
     * Save a version of a user's own piece (created when needed), for Behat's "versions" entity.
     *
     * @param array $record vrmakerspaceid and userid
     * @return stdClass the snapshot row
     */
    public function create_version(array $record): stdClass {
        $session = $this->create_session(['vrmakerspaceid' => $record['vrmakerspaceid'], 'userid' => $record['userid']]);
        return $this->create_snapshot($session, (int)$record['userid']);
    }

    /**
     * Record a member's share of a piece directly.
     *
     * @param stdClass $session the session row
     * @param int $userid the member
     * @param int $ops operations
     * @param float $added clay added, mm³
     * @param float $removed clay removed, mm³
     * @return stdClass the vrmakerspace_contrib row
     */
    public function create_contribution(stdClass $session, int $userid, int $ops, float $added, float $removed): stdClass {
        global $DB;
        $record = (object)[
            'sessionid' => $session->id,
            'userid' => $userid,
            'ops' => $ops,
            'added' => $added,
            'removed' => $removed,
            'timemodified' => time(),
            'lastreport' => time(),
        ];
        $record->id = $DB->insert_record('vrmakerspace_contrib', $record);
        return $record;
    }
}
