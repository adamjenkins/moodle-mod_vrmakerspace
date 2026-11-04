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
 * Tests of the studio page helper: which piece opens, in which mode, with which configuration.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\studio_helper::class)]
final class studio_helper_test extends \advanced_testcase {
    /**
     * An activity with a student and a teacher.
     *
     * @param array $settings activity settings
     * @return array [\stdClass $vrmakerspace, \cm_info $cm, \context_module $context, \stdClass $student, \stdClass $teacher,
     *     \stdClass $course]
     */
    private function make_activity(array $settings = []): array {
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', ['course' => $course->id] + $settings);
        $cm = get_fast_modinfo($course)->get_cm($vrmakerspace->cmid);
        $student = $gen->create_and_enrol($course, 'student');
        $teacher = $gen->create_and_enrol($course, 'editingteacher');
        return [$vrmakerspace, $cm, \context_module::instance($cm->id), $student, $teacher, $course];
    }

    /**
     * Individual work: the student's own piece is created and opens in solo mode with the full config.
     */
    public function test_solo_config(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $cm, $context, $student] = $this->make_activity(['startmodel' => 'cube']);
        $this->setUser($student);

        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, 0, 0);
        $this->assertFalse($resolved['readonly']);
        $this->assertSame((int)$student->id, (int)$resolved['session']->userid);
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);

        $this->assertSame('solo', $config['mode']);
        $this->assertSame((int)$cm->id, $config['cmid']);
        $this->assertSame((int)$resolved['session']->id, $config['sessionid']);
        $this->assertSame('cube', $config['model']);
        $this->assertSame('both', $config['methods']);
        $this->assertSame('', $config['snapshoturl']);
        $this->assertSame(0, $config['version']);
        $this->assertSame(1, $config['maxusers']);
        $this->assertFalse($config['trackcontributions']);
        $this->assertSame(60000, $config['autosavems']);
        $this->assertSame(30000, $config['contributionms']);
        $this->assertSame(['id' => (int)$student->id, 'name' => fullname($student)], $config['user']);
        $expected = '/mod/vrmakerspace/engine.php/' . get_config('mod_vrmakerspace', 'version') . '/worker.js';
        $this->assertStringContainsString($expected, $config['workerurl']);
        $this->assertStringContainsString('/mod/vrmakerspace/view.php?id=' . $cm->id, $config['backurl']);
        $this->assertSame(get_string('yoursculpture', 'vrmakerspace'), studio_helper::title(
            $resolved['session'],
            $context,
            (int)$student->id,
            null
        ));
    }

    /**
     * The studio is told the ways of making. A piece created before the teacher changed them gives way
     * to a starting model that suits them, and an uploaded model that has gone does the same.
     */
    public function test_methods_in_config(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $cm, $context, $student] = $this->make_activity(['methods' => 'model', 'startmodel' => 'meshcube']);
        $this->setUser($student);
        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, 0, 0);
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('model', $config['methods']);
        $this->assertSame('meshcube', $config['model']);

        $vrmakerspace->methods = 'sculpt';
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('sculpt', $config['methods']);
        $this->assertSame('lump', $config['model']);

        $vrmakerspace->methods = 'model';
        $DB->set_field('vrmakerspace_sessions', 'startmodel', 'upload', ['id' => $resolved['session']->id]);
        $resolved['session']->startmodel = 'upload';
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('meshcube', $config['model']);
        $vrmakerspace->methods = 'both';
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('lump', $config['model']);
    }

    /**
     * Which controls the template shows for each of the ways of making.
     */
    public function test_methods_context(): void {
        $this->assertSame(
            ['methods' => 'both', 'cansculpt' => true, 'canmodel' => true, 'showmethodswitch' => true, 'modelfirst' => false],
            studio_helper::methods_context('both', 'lump')
        );
        $this->assertTrue(studio_helper::methods_context('both', 'meshcube')['modelfirst']);
        $this->assertSame(
            ['methods' => 'sculpt', 'cansculpt' => true, 'canmodel' => false, 'showmethodswitch' => false, 'modelfirst' => false],
            studio_helper::methods_context('sculpt', 'meshcube')
        );
        $this->assertSame(
            ['methods' => 'model', 'cansculpt' => false, 'canmodel' => true, 'showmethodswitch' => false, 'modelfirst' => true],
            studio_helper::methods_context('model', 'empty')
        );
    }

    /**
     * Group work: pair (two people) or companion (the activity's maximum) mode, contributions tracked.
     */
    public function test_group_modes(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $cm, $context, $student, , $course] = $this->make_activity(['workmode' => session_manager::MODE_GROUP,
            'trackcontributions' => 1]);
        $group = $this->getDataGenerator()->create_group(['courseid' => $course->id]);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $student->id]);
        $this->setUser($student);

        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, 0, 0);
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('pair', $config['mode']);
        $this->assertSame(2, $config['maxusers']);
        $this->assertTrue($config['trackcontributions']);
        $this->assertSame((int)$group->id, (int)$resolved['session']->groupid);

        $DB->update_record('vrmakerspace', (object)['id' => $vrmakerspace->id, 'connectmode' => 'companion', 'maxusers' => 6]);
        $vrmakerspace = $DB->get_record('vrmakerspace', ['id' => $vrmakerspace->id]);
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('companion', $config['mode']);
        $this->assertSame(6, $config['maxusers']);
    }

    /**
     * Read-only: an older version (with its own file URL), a closed piece, and a teacher.
     */
    public function test_read_only(): void {
        global $DB;
        $this->resetAfterTest();
        [$vrmakerspace, $cm, $context, $student, $teacher] = $this->make_activity();
        $maker = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $session = $maker->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $student->id]);
        $first = $maker->create_snapshot($session, (int)$student->id, 'one');
        $maker->create_snapshot($session, (int)$student->id, 'two');
        $this->setUser($student);

        // The latest version is the piece itself: editable.
        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, (int)$session->id, 2);
        $this->assertFalse($resolved['readonly']);

        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, (int)$session->id, 1);
        $this->assertTrue($resolved['readonly']);
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('view', $config['mode']);
        $this->assertSame(1, $config['version']);
        $this->assertStringContainsString('/mod_vrmakerspace/snapshots/' . $first->id . '/', $config['snapshoturl']);
        $this->assertFalse($config['trackcontributions']);
        $this->assertSame(
            get_string('studiotitleversion', 'vrmakerspace', [
                'owner' => get_string('yoursculpture', 'vrmakerspace'),
                'version' => 1,
            ]),
            studio_helper::title($session, $context, (int)$student->id, $resolved['snapshot'])
        );

        session_manager::set_status($session, session_manager::STATUS_CLOSED);
        $this->assertTrue(studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, 0, 0)['readonly']);

        $this->setUser($teacher);
        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$teacher->id, (int)$session->id, 0);
        $this->assertTrue($resolved['readonly']);
        $this->assertSame(2, (int)$resolved['snapshot']->version);
        $this->assertSame(get_string('sculptureof', 'vrmakerspace', fullname($student)), studio_helper::title(
            $session,
            $context,
            (int)$teacher->id,
            null
        ));
        $this->assertSame(1, $DB->count_records('vrmakerspace_sessions'));
    }

    /**
     * Refused: another student's piece, a session of another activity, a missing version, a
     * group-work student without a group.
     */
    public function test_refusals(): void {
        $this->resetAfterTest();
        [$vrmakerspace, $cm, $context, $student, , $course] = $this->make_activity();
        $other = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $maker = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $session = $maker->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $student->id]);

        $this->setUser($other);
        try {
            studio_helper::resolve($vrmakerspace, $cm, $context, (int)$other->id, (int)$session->id, 0);
            $this->fail('Another student opened the piece');
        } catch (\required_capability_exception $e) {
            $this->assertSame('nopermissions', $e->errorcode);
        }

        [$othervrmakerspace, $othercm, $othercontext] = $this->make_activity();
        $this->setUser($student);
        try {
            studio_helper::resolve($othervrmakerspace, $othercm, $othercontext, (int)$student->id, (int)$session->id, 0);
            $this->fail('A session of another activity opened');
        } catch (\moodle_exception $e) {
            $this->assertSame('invalidsession', $e->errorcode);
        }
        try {
            studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, (int)$session->id, 4);
            $this->fail('A missing version opened');
        } catch (\moodle_exception $e) {
            $this->assertSame('invalidversion', $e->errorcode);
        }

        [$groupwork, $groupcm, $groupcontext, $loner] = $this->make_activity(['workmode' => session_manager::MODE_GROUP]);
        $this->setUser($loner);
        try {
            studio_helper::resolve($groupwork, $groupcm, $groupcontext, (int)$loner->id, 0, 0);
            $this->fail('A student without a group got a piece');
        } catch (\moodle_exception $e) {
            $this->assertSame('nogroup', $e->errorcode);
        }
    }
}
