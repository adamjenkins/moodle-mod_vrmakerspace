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
 * Splits a reply into sentence-sized chunks for speech.
 *
 * Speaking a reply chunk by chunk lets the tutor start talking as soon as the
 * first sentence is synthesised, while the rest is fetched. Very short
 * sentences are merged with the next one so the voice does not stutter.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class chunker {
    /** Chunks shorter than this are merged with the next sentence. */
    const MIN_CHUNK = 40;

    /** Hard cap on the number of chunks a reply is split into. */
    const MAX_CHUNKS = 12;

    /**
     * Splits text into chunks; joining them with single spaces gives the text back.
     *
     * @param string $text The reply text
     * @return string[] At least one chunk
     */
    public static function split(string $text): array {
        $text = trim(preg_replace('/\s+/u', ' ', $text));
        if ($text === '') {
            return [''];
        }
        $sentences = preg_split('/(?<=[.!?。！？…])\s+/u', $text, -1, PREG_SPLIT_NO_EMPTY);

        $chunks = [];
        $current = '';
        foreach ($sentences as $sentence) {
            $current = $current === '' ? $sentence : $current . ' ' . $sentence;
            if (\core_text::strlen($current) >= self::MIN_CHUNK) {
                $chunks[] = $current;
                $current = '';
            }
        }
        if ($current !== '') {
            if ($chunks && \core_text::strlen($current) < self::MIN_CHUNK / 2) {
                $chunks[count($chunks) - 1] .= ' ' . $current;
            } else {
                $chunks[] = $current;
            }
        }
        if (count($chunks) > self::MAX_CHUNKS) {
            $tail = implode(' ', array_slice($chunks, self::MAX_CHUNKS - 1));
            $chunks = array_slice($chunks, 0, self::MAX_CHUNKS - 1);
            $chunks[] = $tail;
        }
        return $chunks;
    }
}
