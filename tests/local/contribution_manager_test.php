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
 * Tests of contribution tracking: caps, the rate limit and the shares.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\contribution_manager::class)]
final class contribution_manager_test extends \advanced_testcase {
    /**
     * A group piece and two members.
     *
     * @return array [\stdClass $session, \stdClass $one, \stdClass $two]
     */
    private function make_session(): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', ['course' => $course->id, 'workmode' => session_manager::MODE_GROUP,
            'trackcontributions' => 1]);
        $group = $gen->create_group(['courseid' => $course->id]);
        $one = $gen->create_and_enrol($course, 'student');
        $two = $gen->create_and_enrol($course, 'student');
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $one->id]);
        $gen->create_group_member(['groupid' => $group->id, 'userid' => $two->id]);
        $session = $gen->get_plugin_generator('mod_vrmakerspace')->create_session(['vrmakerspaceid' => $vrmakerspace->id,
            'groupid' => $group->id]);
        return [$session, $one, $two];
    }

    /**
     * Reports add up; one within MIN_INTERVAL seconds of the last accepted is refused and not counted.
     */
    public function test_rate_limit(): void {
        global $DB;
        $this->resetAfterTest();
        [$session, $one] = $this->make_session();
        $now = 1800000000;

        $this->assertTrue(contribution_manager::report($session, (int)$one->id, 10, 100.0, 5.0, $now));
        $this->assertFalse(contribution_manager::report($session, (int)$one->id, 10, 100.0, 5.0, $now + 9));
        $this->assertTrue(contribution_manager::report($session, (int)$one->id, 4, 50.0, 1.0, $now + 10));

        $record = $DB->get_record('vrmakerspace_contrib', ['sessionid' => $session->id, 'userid' => $one->id], '*', MUST_EXIST);
        $this->assertSame(14, (int)$record->ops);
        $this->assertEquals(150.0, (float)$record->added);
        $this->assertEquals(6.0, (float)$record->removed);
        $this->assertSame($now + 10, (int)$record->lastreport);
    }

    /**
     * Each report's increments are capped; negative and non-finite values count as 0.
     */
    public function test_caps(): void {
        global $DB;
        $this->resetAfterTest();
        [$session, $one, $two] = $this->make_session();

        contribution_manager::report($session, (int)$one->id, 1000000, 1e12, 1e12, 1800000000);
        contribution_manager::report($session, (int)$two->id, -5, -3.0, NAN, 1800000000);

        $first = $DB->get_record('vrmakerspace_contrib', ['sessionid' => $session->id, 'userid' => $one->id], '*', MUST_EXIST);
        $this->assertSame(contribution_manager::MAX_OPS, (int)$first->ops);
        $this->assertEquals(contribution_manager::MAX_VOLUME, (float)$first->added);
        $this->assertEquals(contribution_manager::MAX_VOLUME, (float)$first->removed);
        $second = $DB->get_record('vrmakerspace_contrib', ['sessionid' => $session->id, 'userid' => $two->id], '*', MUST_EXIST);
        $this->assertSame(0, (int)$second->ops);
        $this->assertEquals(0.0, (float)$second->added);
        $this->assertEquals(0.0, (float)$second->removed);
    }

    /**
     * Shares follow the clay moved, or the operations while no clay moved; largest first.
     */
    public function test_summary(): void {
        $this->resetAfterTest();
        [$session, $one, $two] = $this->make_session();
        $this->assertSame([], contribution_manager::summary((int)$session->id));

        contribution_manager::report($session, (int)$one->id, 3, 0.0, 0.0, 1800000000);
        contribution_manager::report($session, (int)$two->id, 1, 0.0, 0.0, 1800000000);
        $summary = contribution_manager::summary((int)$session->id);
        $this->assertSame([(int)$one->id, (int)$two->id], array_column($summary, 'userid'));
        $this->assertEquals([75.0, 25.0], array_column($summary, 'share'));

        contribution_manager::report($session, (int)$two->id, 1, 300.0, 0.0, 1800000100);
        contribution_manager::report($session, (int)$one->id, 1, 50.0, 50.0, 1800000100);
        $summary = contribution_manager::summary((int)$session->id);
        $this->assertSame([(int)$two->id, (int)$one->id], array_column($summary, 'userid'));
        // Edits 2 of 6 and 4 of 6; clay 300 of 400 and 100 of 400.
        $this->assertEquals([54.2, 45.8], array_column($summary, 'share'));
    }

    /**
     * Someone who only models still has a share when a partner has moved clay.
     */
    public function test_summary_counts_modelling(): void {
        $this->resetAfterTest();
        [$session, $one, $two] = $this->make_session();
        contribution_manager::report($session, (int)$one->id, 3, 0.0, 0.0, 1800000000);
        contribution_manager::report($session, (int)$two->id, 1, 500.0, 0.0, 1800000000);
        $summary = contribution_manager::summary((int)$session->id);
        $this->assertSame([(int)$two->id, (int)$one->id], array_column($summary, 'userid'));
        $this->assertEquals([62.5, 37.5], array_column($summary, 'share'));
    }
}
