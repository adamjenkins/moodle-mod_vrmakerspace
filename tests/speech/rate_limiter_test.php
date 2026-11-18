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

/**
 * Unit tests for \mod_vrmakerspace\speech\rate_limiter.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers     \mod_vrmakerspace\speech\rate_limiter
 */
#[CoversClass(rate_limiter::class)]
final class rate_limiter_test extends advanced_testcase {
    /**
     * Calls up to the limit pass, the next one is refused, and the window slides.
     */
    public function test_limit_and_window(): void {
        $this->resetAfterTest();
        $now = 1000000;
        $limit = rate_limiter::LIMITS['transcribe'];

        for ($i = 0; $i < $limit; $i++) {
            rate_limiter::check('transcribe', 5, $now);
        }
        try {
            rate_limiter::check('transcribe', 5, $now);
            $this->fail('Expected error_speechratelimit');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechratelimit', $e->errorcode);
        }

        // Once the window has passed, the user may call again.
        rate_limiter::check('transcribe', 5, $now + rate_limiter::WINDOW);
        $this->assertTrue(true);
    }

    /**
     * Budgets are kept per user and per service.
     */
    public function test_budgets_are_separate(): void {
        $this->resetAfterTest();
        $now = 1000000;
        for ($i = 0; $i < rate_limiter::LIMITS['transcribe']; $i++) {
            rate_limiter::check('transcribe', 5, $now);
        }

        // Another user, and another service for the same user, are not affected.
        rate_limiter::check('transcribe', 6, $now);
        rate_limiter::check('speak', 5, $now);
        $this->assertTrue(true);
    }

    /**
     * An unknown service is a coding error.
     */
    public function test_unknown_service(): void {
        $this->expectException(\coding_exception::class);
        rate_limiter::check('dance', 5);
    }
}
