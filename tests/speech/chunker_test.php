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

declare(strict_types=1);

namespace mod_vrmakerspace\speech;

use advanced_testcase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Unit tests for \mod_vrmakerspace\speech\chunker.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers     \mod_vrmakerspace\speech\chunker
 */
#[CoversClass(chunker::class)]
final class chunker_test extends advanced_testcase {
    /** @var string A sentence of at least chunker::MIN_CHUNK characters. */
    private const LONG1 = 'The Analytical Engine was designed by Charles Babbage.';

    /** @var string Another long sentence. */
    private const LONG2 = 'Ada Lovelace wrote the first published program for it.';

    /**
     * Empty or blank text gives a single empty chunk.
     */
    public function test_empty_text(): void {
        $this->assertSame([''], chunker::split(''));
        $this->assertSame([''], chunker::split("  \n\t "));
    }

    /**
     * Short sentences are merged into one chunk.
     */
    public function test_short_sentences_merged(): void {
        $this->assertSame(['Hi. How are you? I am fine.'], chunker::split('Hi. How are you? I am fine.'));
    }

    /**
     * Sentences of at least MIN_CHUNK characters each become their own chunk.
     */
    public function test_long_sentences_split(): void {
        $this->assertGreaterThanOrEqual(chunker::MIN_CHUNK, \core_text::strlen(self::LONG1));
        $this->assertGreaterThanOrEqual(chunker::MIN_CHUNK, \core_text::strlen(self::LONG2));

        $this->assertSame([self::LONG1, self::LONG2], chunker::split(self::LONG1 . ' ' . self::LONG2));
    }

    /**
     * A short sentence is carried into the next one rather than spoken alone.
     */
    public function test_short_sentence_joins_next(): void {
        $this->assertSame(['Yes. ' . self::LONG1, self::LONG2], chunker::split('Yes. ' . self::LONG1 . ' ' . self::LONG2));
    }

    /**
     * A very short tail (under half of MIN_CHUNK) is appended to the previous chunk.
     */
    public function test_very_short_tail_appended(): void {
        $this->assertSame([self::LONG1 . ' Indeed!'], chunker::split(self::LONG1 . ' Indeed!'));
    }

    /**
     * A tail of at least half of MIN_CHUNK characters stays a chunk of its own.
     */
    public function test_medium_tail_kept(): void {
        $tail = 'That is quite a long tail.';
        $this->assertGreaterThanOrEqual(chunker::MIN_CHUNK / 2, \core_text::strlen($tail));
        $this->assertLessThan(chunker::MIN_CHUNK, \core_text::strlen($tail));

        $this->assertSame([self::LONG1, $tail], chunker::split(self::LONG1 . ' ' . $tail));
    }

    /**
     * A reply never splits into more than MAX_CHUNKS chunks; the rest goes in the last one.
     */
    public function test_max_chunks(): void {
        $sentences = [];
        for ($i = 1; $i <= 20; $i++) {
            $sentences[] = "This is sentence number $i of a rather long reply.";
        }
        $text = implode(' ', $sentences);

        $chunks = chunker::split($text);

        $this->assertCount(chunker::MAX_CHUNKS, $chunks);
        $this->assertSame($sentences[0], $chunks[0]);
        $this->assertSame(
            implode(' ', array_slice($sentences, chunker::MAX_CHUNKS - 1)),
            $chunks[chunker::MAX_CHUNKS - 1]
        );
        $this->assertSame($text, implode(' ', $chunks));
    }

    /**
     * Joining the chunks with single spaces gives back the whitespace-normalised text.
     *
     * @param string $text The reply
     */
    #[DataProvider('join_provider')]
    public function test_join_equals_normalised_text(string $text): void {
        $normalised = trim(preg_replace('/\s+/u', ' ', $text));
        $this->assertSame($normalised, implode(' ', chunker::split($text)));
    }

    /**
     * Replies for the join test.
     *
     * @return array
     */
    public static function join_provider(): array {
        return [
            'one word'            => ['Hello'],
            'messy whitespace'    => ["Hello   there.\n\nGeneral   Kenobi!  "],
            'no final stop'       => [self::LONG1 . ' and then it just keeps going without a stop'],
            'ellipsis and marks'  => ['Well… I am not sure! Are you? ' . self::LONG2 . ' ' . self::LONG1],
            'many sentences'      => [str_repeat(self::LONG1 . ' ', 15)],
        ];
    }
}
