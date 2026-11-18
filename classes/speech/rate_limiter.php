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

namespace mod_vrmakerspace\speech;

/**
 * Per-user limit on calls to the speech server.
 *
 * The speak and transcribe services call the admin-configured speech server
 * directly, outside core_ai and its optional rate limit, so each user gets a
 * sliding one-minute budget per service. The limits sit well above what a real
 * tutor needs (one transcription per question, a few spoken chunks
 * per reply) and only stop scripted floods. The counts live in an application
 * cache keyed on the user id, so they hold across sessions and browsers.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class rate_limiter {
    /** Length of the sliding window, in seconds. */
    const WINDOW = 60;

    /** Most calls per user and window, by service. */
    const LIMITS = [
        'speak'      => 60,
        'transcribe' => 30,
    ];

    /**
     * Records one call, or refuses it when the user has used up the window's budget.
     *
     * @param string $service A key of self::LIMITS
     * @param int $userid
     * @param int|null $now The current time, for tests
     * @throws \moodle_exception error_speechratelimit when the limit is reached
     */
    public static function check(string $service, int $userid, ?int $now = null): void {
        if (!isset(self::LIMITS[$service])) {
            throw new \coding_exception('Unknown speech service ' . $service);
        }
        $now = $now ?? time();
        $cache = \cache::make('mod_vrmakerspace', 'speechrate');
        $key = $service . '_' . $userid;

        $stamps = $cache->get($key);
        $stamps = is_array($stamps) ? $stamps : [];
        $stamps = array_values(array_filter($stamps, fn($t) => (int) $t > $now - self::WINDOW));

        if (count($stamps) >= self::LIMITS[$service]) {
            throw new \moodle_exception('error_speechratelimit', 'mod_vrmakerspace');
        }
        $stamps[] = $now;
        $cache->set($key, $stamps);
    }
}
