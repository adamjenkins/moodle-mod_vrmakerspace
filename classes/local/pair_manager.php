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
 * Pair work: two members of a group sculpt their group's sculpture together, browser to browser.
 *
 * Needs no server of its own: the two browsers find each other through Moodle. Each one is a row of
 * vrmakerspace_peers with a random peer key made here, kept while its studio polls (pair_poll); after
 * ACTIVE seconds without a poll it no longer counts. At most MAX_PEERS rows of a session are active.
 * One of them is the host, which orders every edit; when no active host remains, the earliest active
 * peer becomes the host. The connection messages (WebRTC offers, answers and candidates) are rows of
 * vrmakerspace_signals, only ever stored between two active peers of the same session, and deleted when
 * the recipient confirms them or after EXPIRY seconds (scheduled task). Every rule is enforced here;
 * nothing the browser sends is trusted.
 *
 * The presence pattern (a row refreshed by polling, the others active in the last seconds, random peer
 * ids, a lock per room) follows vrroomruntime_builtin's room_manager, which adapts it from mod_gear's
 * sync_session service.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class pair_manager {
    /** @var int People sculpting one sculpture at once in pair work. */
    public const MAX_PEERS = 2;

    /** @var int A peer that polled within this many seconds is active. */
    public const ACTIVE = 20;

    /** @var int How often the studio polls, milliseconds. */
    public const POLL_MS = 1000;

    /** @var int Largest connection message, bytes. */
    public const MAX_PAYLOAD = 65536;

    /** @var int Most undelivered connection messages waiting for one peer. */
    public const MAX_PENDING = 200;

    /** @var int Most connection messages returned by one poll. */
    public const MAX_DELIVER = 50;

    /** @var int Connection messages and peers older than this many seconds are deleted by the scheduled task. */
    public const EXPIRY = 3600;

    /** @var int Seconds to wait for a session's lock. */
    public const LOCK_TIMEOUT = 5;

    /** @var string The peer that orders the edits. */
    public const ROLE_HOST = 'host';

    /** @var string The other peer. */
    public const ROLE_GUEST = 'guest';

    /** @var int Longest display name, characters. */
    public const NAME_MAX = 100;

    /** @var string Lock type of the session locks. */
    private const LOCK_TYPE = 'mod_vrmakerspace_pair';

    /** @var int Peer keys per IN (...) list. */
    private const CHUNK = 500;

    /**
     * A new random peer key.
     *
     * @return string 32 lowercase hex characters
     */
    public static function new_peerkey(): string {
        return bin2hex(random_bytes(16));
    }

    /**
     * Whether a value has the shape of a peer key.
     *
     * @param string $value the value
     * @return bool
     */
    public static function is_peerkey(string $value): bool {
        return (bool)preg_match('/^[0-9a-f]{32}$/', $value);
    }

    /**
     * Whether an activity's group sculptures can be sculpted in pair work.
     *
     * Group work with the pair connection; also group work with the companion connection while the
     * companion service is not available, so the studio can fall back to working with one partner.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @return bool
     */
    public static function allowed(\stdClass $vrmakerspace): bool {
        if (!session_manager::is_group_work($vrmakerspace)) {
            return false;
        }
        return session_manager::connection($vrmakerspace) === session_manager::CONNECTION_PAIR
            || !companion_manager::is_available();
    }

    /**
     * Join a session: replace the user's earlier connection, check there is room, choose the role.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user (never from the client)
     * @param int|null $now current time
     * @return array{peer: \stdClass, peers: array}
     * @throws \moodle_exception sessionfull, pairbusy
     */
    public static function join(\stdClass $session, \context_module $context, int $userid, ?int $now = null): array {
        global $DB;
        $now = $now ?? time();
        $sessionid = (int)$session->id;

        $lock = self::lock($sessionid);
        try {
            $existing = $DB->get_record('vrmakerspace_peers', ['sessionid' => $sessionid, 'userid' => $userid]);
            if ($existing) {
                self::delete_peers([$existing]);
            }
            self::purge_stale($sessionid, $now);
            $active = self::active_rows($sessionid, $now);
            if (count($active) >= self::MAX_PEERS) {
                throw new \moodle_exception('sessionfull', 'mod_vrmakerspace');
            }
            $hashost = false;
            foreach ($active as $row) {
                $hashost = $hashost || $row->role === self::ROLE_HOST;
            }
            $peer = (object)[
                'sessionid' => $sessionid,
                'userid' => $userid,
                'peerkey' => self::new_peerkey(),
                'role' => $hashost ? self::ROLE_GUEST : self::ROLE_HOST,
                'lastseen' => $now,
                'timecreated' => $now,
            ];
            $peer->id = $DB->insert_record('vrmakerspace_peers', $peer);
        } finally {
            $lock->release();
        }
        return ['peer' => $peer, 'peers' => self::roster($peer, $context, $now)];
    }

    /**
     * Stay connected: refresh the caller's row, drop the messages it confirmed, take over as host when
     * no active host remains, and return the waiting messages.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user (never from the client)
     * @param string $peerkey the caller's peer key
     * @param int $afterid the id of the last message the caller received (0 for none)
     * @param int|null $now current time
     * @return array{peer: \stdClass, peers: array, signals: array}
     * @throws \moodle_exception peergone, pairbusy
     */
    public static function poll(
        \stdClass $session,
        \context_module $context,
        int $userid,
        string $peerkey,
        int $afterid,
        ?int $now = null
    ): array {
        global $DB;
        $now = $now ?? time();
        $sessionid = (int)$session->id;
        $peer = self::own_peer($sessionid, $userid, $peerkey);

        $DB->set_field('vrmakerspace_peers', 'lastseen', $now, ['id' => $peer->id]);
        $peer->lastseen = $now;
        if ($afterid > 0) {
            $DB->delete_records_select(
                'vrmakerspace_signals',
                'sessionid = :sessionid AND topeerkey = :peerkey AND id <= :afterid',
                ['sessionid' => $sessionid, 'peerkey' => $peer->peerkey, 'afterid' => $afterid]
            );
        }

        if (!self::has_active_host($sessionid, $now)) {
            $lock = self::lock($sessionid);
            try {
                if (!self::has_active_host($sessionid, $now)) {
                    // A host that stopped polling is gone for good: its browser rejoins as a new peer.
                    self::purge_stale($sessionid, $now);
                    $active = self::active_rows($sessionid, $now);
                    if ($active) {
                        $DB->set_field('vrmakerspace_peers', 'role', self::ROLE_HOST, ['id' => reset($active)->id]);
                    }
                }
            } finally {
                $lock->release();
            }
            $peer = self::own_peer($sessionid, $userid, $peerkey);
        }

        $signals = [];
        $rows = $DB->get_records_select(
            'vrmakerspace_signals',
            'sessionid = :sessionid AND topeerkey = :peerkey AND id > :afterid',
            ['sessionid' => $sessionid, 'peerkey' => $peer->peerkey, 'afterid' => max(0, $afterid)],
            'id ASC',
            'id, frompeerkey, payload',
            0,
            self::MAX_DELIVER
        );
        foreach ($rows as $row) {
            $signals[] = ['id' => (int)$row->id, 'frompeerkey' => (string)$row->frompeerkey, 'payload' => (string)$row->payload];
        }
        return ['peer' => $peer, 'peers' => self::roster($peer, $context, $now), 'signals' => $signals];
    }

    /**
     * Send a connection message to the other peer of the session.
     *
     * @param \stdClass $session the session row
     * @param int $userid the user (never from the client)
     * @param string $peerkey the sender's peer key
     * @param string $topeerkey the recipient's peer key
     * @param string $payload the message (opaque to the server: only the other browser reads it)
     * @param int|null $now current time
     * @return void
     * @throws \moodle_exception peergone, peernotfound, signaltoolarge, signalinvalid, signalqueuefull
     */
    public static function signal(
        \stdClass $session,
        int $userid,
        string $peerkey,
        string $topeerkey,
        string $payload,
        ?int $now = null
    ): void {
        global $DB;
        $now = $now ?? time();
        $sessionid = (int)$session->id;

        if (strlen($payload) > self::MAX_PAYLOAD) {
            throw new \moodle_exception('signaltoolarge', 'mod_vrmakerspace');
        }
        if ($payload === '' || !mb_check_encoding($payload, 'UTF-8')) {
            throw new \moodle_exception('signalinvalid', 'mod_vrmakerspace');
        }
        $peer = self::own_peer($sessionid, $userid, $peerkey);
        if ((int)$peer->lastseen < $now - self::ACTIVE) {
            throw new \moodle_exception('peergone', 'mod_vrmakerspace');
        }
        $to = null;
        if (self::is_peerkey($topeerkey) && $topeerkey !== $peer->peerkey) {
            $to = $DB->get_record('vrmakerspace_peers', ['sessionid' => $sessionid, 'peerkey' => $topeerkey]);
        }
        if (!$to || (int)$to->lastseen < $now - self::ACTIVE) {
            throw new \moodle_exception('peernotfound', 'mod_vrmakerspace');
        }
        $pending = $DB->count_records('vrmakerspace_signals', ['sessionid' => $sessionid, 'topeerkey' => $to->peerkey]);
        if ($pending >= self::MAX_PENDING) {
            throw new \moodle_exception('signalqueuefull', 'mod_vrmakerspace');
        }
        $DB->insert_record('vrmakerspace_signals', (object)[
            'sessionid' => $sessionid,
            'frompeerkey' => $peer->peerkey,
            'topeerkey' => $to->peerkey,
            'fromuserid' => $userid,
            'payload' => $payload,
            'timecreated' => $now,
        ]);
        $DB->set_field('vrmakerspace_peers', 'lastseen', $now, ['id' => $peer->id]);
    }

    /**
     * Leave a session: delete the caller's row and its messages. Leaving twice is not an error.
     *
     * @param \stdClass $session the session row
     * @param int $userid the user (never from the client)
     * @param string $peerkey the caller's peer key
     * @return void
     */
    public static function leave(\stdClass $session, int $userid, string $peerkey): void {
        global $DB;
        $peer = $DB->get_record('vrmakerspace_peers', ['sessionid' => $session->id, 'userid' => $userid]);
        if ($peer && hash_equals((string)$peer->peerkey, $peerkey)) {
            self::delete_peers([$peer]);
        }
    }

    /**
     * The other active peers of a session, as the studio sees them.
     *
     * @param \stdClass $peer the caller's row
     * @param \context_module $context the activity context
     * @param int $now current time
     * @return array list of ['userid' => int, 'name' => string, 'peerkey' => string, 'role' => string]
     */
    public static function roster(\stdClass $peer, \context_module $context, int $now): array {
        global $DB;
        $userfields = \core_user\fields::for_name()->get_sql('u', true, '', '', true);
        $sql = "SELECT p.id, p.userid, p.peerkey, p.role {$userfields->selects}
                  FROM {vrmakerspace_peers} p
                  JOIN {user} u ON u.id = p.userid {$userfields->joins}
                 WHERE p.sessionid = :sessionid
                   AND p.id <> :self
                   AND p.lastseen >= :fresh
              ORDER BY p.timecreated ASC, p.id ASC";
        $rows = $DB->get_records_sql($sql, array_merge($userfields->params, [
            'sessionid' => (int)$peer->sessionid,
            'self' => (int)($peer->id ?? 0),
            'fresh' => $now - self::ACTIVE,
        ]));
        $viewfullnames = has_capability('moodle/site:viewfullnames', $context, (int)$peer->userid);
        $roster = [];
        foreach ($rows as $row) {
            $roster[] = [
                'userid' => (int)$row->userid,
                'name' => self::display_name(fullname($row, $viewfullnames)),
                'peerkey' => (string)$row->peerkey,
                'role' => (string)$row->role,
            ];
        }
        return $roster;
    }

    /**
     * A name as others see it: without control characters, trimmed, at most NAME_MAX characters.
     *
     * @param string $name the full name
     * @return string plain text, never empty
     */
    public static function display_name(string $name): string {
        $name = (string)preg_replace('/[\x{0000}-\x{001F}\x{007F}-\x{009F}]/u', '', fix_utf8($name));
        $name = trim(\core_text::substr(trim($name), 0, self::NAME_MAX));
        return $name !== '' ? $name : get_string('user');
    }

    /**
     * The STUN and TURN servers a peer may use, from VR room's live settings (none when it is missing).
     *
     * @param string $peerkey the peer the TURN credentials are made for
     * @return array list of ['urls' => string[], 'username' => string, 'credential' => string]
     */
    public static function ice_servers(string $peerkey): array {
        $class = '\\vrroomruntime_builtin\\local\\live\\config';
        if (!class_exists($class)) {
            return [];
        }
        $servers = [];
        foreach ($class::ice_servers($peerkey)['servers'] ?? [] as $server) {
            $servers[] = [
                'urls' => array_values(array_map('strval', (array)($server['urls'] ?? []))),
                'username' => (string)($server['username'] ?? ''),
                'credential' => (string)($server['credential'] ?? ''),
            ];
        }
        return $servers;
    }

    /**
     * Delete connection messages and peers nobody polled for EXPIRY seconds (scheduled task).
     *
     * @param int|null $now current time
     * @return array{peers: int, signals: int} how many rows were deleted
     */
    public static function purge_expired(?int $now = null): array {
        global $DB;
        $now = $now ?? time();
        $cutoff = $now - self::EXPIRY;

        $peers = $DB->get_records_select('vrmakerspace_peers', 'lastseen < ?', [$cutoff], 'id ASC', 'id, sessionid, peerkey');
        $signals = self::delete_peers($peers);
        $old = $DB->count_records_select('vrmakerspace_signals', 'timecreated < ?', [$cutoff]);
        $DB->delete_records_select('vrmakerspace_signals', 'timecreated < ?', [$cutoff]);
        return ['peers' => count($peers), 'signals' => $signals + $old];
    }

    /**
     * Delete a user's connections and the messages they sent or were sent (privacy).
     *
     * @param int $userid the user
     * @param int[]|null $sessionids only in these sessions, or null for everywhere
     * @return void
     */
    public static function purge_user(int $userid, ?array $sessionids = null): void {
        global $DB;
        if ($sessionids === []) {
            return;
        }
        $select = 'userid = :userid';
        $params = ['userid' => $userid];
        $signalselect = 'fromuserid = :userid';
        if ($sessionids !== null) {
            [$insql, $inparams] = $DB->get_in_or_equal($sessionids, SQL_PARAMS_NAMED, 'sess');
            $select .= " AND sessionid $insql";
            $signalselect .= " AND sessionid $insql";
            $params += $inparams;
        }
        self::delete_peers($DB->get_records_select('vrmakerspace_peers', $select, $params, '', 'id, sessionid, peerkey'));
        $DB->delete_records_select('vrmakerspace_signals', $signalselect, $params);
    }

    /**
     * The caller's own row: it must exist and carry the peer key the caller holds.
     *
     * @param int $sessionid the session id
     * @param int $userid the user
     * @param string $peerkey the peer key the client sent
     * @return \stdClass the vrmakerspace_peers row
     * @throws \moodle_exception peergone when the row is gone or its key was replaced by a newer join
     */
    private static function own_peer(int $sessionid, int $userid, string $peerkey): \stdClass {
        global $DB;
        $peer = $DB->get_record('vrmakerspace_peers', ['sessionid' => $sessionid, 'userid' => $userid]);
        if (!$peer || !self::is_peerkey($peerkey) || !hash_equals((string)$peer->peerkey, $peerkey)) {
            throw new \moodle_exception('peergone', 'mod_vrmakerspace');
        }
        return $peer;
    }

    /**
     * The active rows of a session, earliest first.
     *
     * @param int $sessionid the session id
     * @param int $now current time
     * @return \stdClass[] vrmakerspace_peers rows keyed by id
     */
    private static function active_rows(int $sessionid, int $now): array {
        global $DB;
        return $DB->get_records_select(
            'vrmakerspace_peers',
            'sessionid = ? AND lastseen >= ?',
            [$sessionid, $now - self::ACTIVE],
            'timecreated ASC, id ASC'
        );
    }

    /**
     * Whether a session has an active host.
     *
     * @param int $sessionid the session id
     * @param int $now current time
     * @return bool
     */
    private static function has_active_host(int $sessionid, int $now): bool {
        global $DB;
        return $DB->record_exists_select(
            'vrmakerspace_peers',
            'sessionid = ? AND role = ? AND lastseen >= ?',
            [$sessionid, self::ROLE_HOST, $now - self::ACTIVE]
        );
    }

    /**
     * Delete the rows of a session that are no longer active, with their messages.
     *
     * @param int $sessionid the session id
     * @param int $now current time
     * @return void
     */
    private static function purge_stale(int $sessionid, int $now): void {
        global $DB;
        self::delete_peers($DB->get_records_select(
            'vrmakerspace_peers',
            'sessionid = ? AND lastseen < ?',
            [$sessionid, $now - self::ACTIVE],
            '',
            'id, sessionid, peerkey'
        ));
    }

    /**
     * Delete peers with the messages sent to or by them.
     *
     * @param \stdClass[] $peers vrmakerspace_peers rows (id, sessionid, peerkey)
     * @return int how many messages were deleted
     */
    private static function delete_peers(array $peers): int {
        global $DB;
        if (!$peers) {
            return 0;
        }
        $deleted = 0;
        foreach (array_chunk(array_values($peers), self::CHUNK) as $chunk) {
            $keys = array_values(array_unique(array_map(fn($p) => (string)$p->peerkey, $chunk)));
            [$tosql, $toparams] = $DB->get_in_or_equal($keys, SQL_PARAMS_NAMED, 'to');
            [$fromsql, $fromparams] = $DB->get_in_or_equal($keys, SQL_PARAMS_NAMED, 'from');
            $select = "topeerkey $tosql OR frompeerkey $fromsql";
            $deleted += $DB->count_records_select('vrmakerspace_signals', $select, $toparams + $fromparams);
            $DB->delete_records_select('vrmakerspace_signals', $select, $toparams + $fromparams);
            [$idsql, $idparams] = $DB->get_in_or_equal(array_map(fn($p) => (int)$p->id, $chunk));
            $DB->delete_records_select('vrmakerspace_peers', "id $idsql", $idparams);
        }
        return $deleted;
    }

    /**
     * The lock of one session's peers.
     *
     * @param int $sessionid the session id
     * @return \core\lock\lock
     * @throws \moodle_exception pairbusy when the lock cannot be had in time
     */
    private static function lock(int $sessionid): \core\lock\lock {
        $factory = \core\lock\lock_config::get_lock_factory(self::LOCK_TYPE);
        $lock = $factory->get_lock('session_' . $sessionid, self::LOCK_TIMEOUT);
        if (!$lock) {
            throw new \moodle_exception('pairbusy', 'mod_vrmakerspace');
        }
        return $lock;
    }
}
