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
 * Group work over VR room's companion service (vrroom-sync), when it is installed.
 *
 * A soft dependency: the plugin vrroomruntime_companion is optional, so every use of its classes is
 * behind is_installed(). Makerspace peers and rooms get pseudonyms of their own ("vrmakerspace|..."), so they
 * never collide with VR room's.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class companion_manager {
    /** @var string The companion plugin's settings class. */
    private const CONFIG = '\\vrroomruntime_companion\\local\\config';

    /** @var string The companion plugin's token class. */
    private const TOKENS = '\\vrroomruntime_companion\\local\\token_service';

    /**
     * Whether the companion plugin is installed.
     *
     * @return bool
     */
    public static function is_installed(): bool {
        return class_exists(self::CONFIG) && class_exists(self::TOKENS);
    }

    /**
     * Whether the companion service can be used: installed, with its address and secret set.
     *
     * @return bool
     */
    public static function is_available(): bool {
        if (!self::is_installed()) {
            return false;
        }
        $config = self::CONFIG;
        return (bool)$config::is_configured();
    }

    /**
     * The peer id of a user in a piece.
     *
     * @param int $userid the user
     * @param int $sessionid the session
     * @return string 32 lowercase hex characters
     */
    public static function peer_id(int $userid, int $sessionid): string {
        $config = self::CONFIG;
        return $config::pseudonym("vrmakerspace|peer|{$userid}|{$sessionid}");
    }

    /**
     * The room id of a piece.
     *
     * @param int $sessionid the session
     * @return string 'r' and 32 lowercase hex characters
     */
    public static function room_id(int $sessionid): string {
        $config = self::CONFIG;
        return 'r' . $config::pseudonym("vrmakerspace|room|{$sessionid}");
    }

    /**
     * What the studio needs to join a piece's room on the companion service.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \stdClass $session the session row
     * @param \stdClass $user the user joining (never from the client)
     * @return array{url: string, token: string, expires: int, room: string, peerid: string, name: string, max: int}
     * @throws \moodle_exception companionnotconfigured
     */
    public static function join(\stdClass $vrmakerspace, \stdClass $session, \stdClass $user): array {
        if (!self::is_available()) {
            throw new \moodle_exception('companionnotconfigured', 'mod_vrmakerspace');
        }
        $config = self::CONFIG;
        $tokens = self::TOKENS;
        $peerid = self::peer_id((int)$user->id, (int)$session->id);
        $room = self::room_id((int)$session->id);
        $name = (string)$tokens::display_name($user);
        $max = min(max(2, (int)$vrmakerspace->maxusers), (int)$config::max_users());
        $token = $tokens::sync_token($peerid, $room, $name, 'attempt', $max);
        return [
            'url' => (string)$config::sync_url(),
            'token' => (string)$token['token'],
            'expires' => (int)$token['expires'],
            'room' => $room,
            'peerid' => $peerid,
            'name' => $name,
            'max' => $max,
        ];
    }
}
