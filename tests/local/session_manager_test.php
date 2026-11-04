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
 * Tests of the piece and version data layer.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\session_manager::class)]
final class session_manager_test extends \advanced_testcase {
    /**
     * A course with an activity and its context.
     *
     * @param int $workmode session_manager::MODE_*
     * @return array [\stdClass $course, \stdClass $vrmakerspace, \cm_info $cm, \context_module $context]
     */
    private function make_activity(int $workmode = session_manager::MODE_INDIVIDUAL): array {
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', [
            'course' => $course->id,
            'workmode' => $workmode,
            'startmodel' => 'sphere',
        ]);
        $cm = get_fast_modinfo($course)->get_cm($vrmakerspace->cmid);
        return [$course, $vrmakerspace, $cm, \context_module::instance($cm->id)];
    }

    /**
     * Individual work: one session per user, created once, with the activity's starting model.
     */
    public function test_individual_session_created_once(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace, $cm] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');

        $first = session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$user->id);
        $second = session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$user->id);

        $this->assertEquals($first->id, $second->id);
        $this->assertSame(0, (int)$first->groupid);
        $this->assertSame((int)$user->id, (int)$first->userid);
        $this->assertSame('sphere', $first->startmodel);
        $this->assertSame(1, $DB->count_records('vrmakerspace_sessions', ['vrmakerspaceid' => $vrmakerspace->id]));
    }

    /**
     * Group work: the group's session for members, none for a user outside every group or a foreign group.
     */
    public function test_group_session_needs_membership(): void {
        $this->resetAfterTest();
        [$course, $vrmakerspace, $cm] = $this->make_activity(session_manager::MODE_GROUP);
        $member = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $other = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $outsider = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $group = $this->getDataGenerator()->create_group(['courseid' => $course->id]);
        $othergroup = $this->getDataGenerator()->create_group(['courseid' => $course->id]);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $member->id]);
        $this->getDataGenerator()->create_group_member(['groupid' => $group->id, 'userid' => $other->id]);

        $session = session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$member->id);
        $this->assertSame((int)$group->id, (int)$session->groupid);
        $this->assertSame(0, (int)$session->userid);
        $this->assertEquals($session->id, session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$other->id)->id);

        $this->assertNull(session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$outsider->id));
        $this->assertNull(session_manager::get_or_create_for_user($vrmakerspace, $cm, (int)$member->id, (int)$othergroup->id));
    }

    /**
     * A session id of another activity is refused.
     */
    public function test_get_session_refuses_other_activity(): void {
        $this->resetAfterTest();
        [$course, $vrmakerspace] = $this->make_activity();
        [, $othervrmakerspace] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($othervrmakerspace, 0, (int)$user->id);

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('invalidsession', 'mod_vrmakerspace'));
        session_manager::get_session((int)$session->id, $vrmakerspace);
    }

    /**
     * Who may view and make: owners make while open, teachers only view, other students neither.
     */
    public function test_access_rules(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $owner = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $student = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $teacher = $this->getDataGenerator()->create_and_enrol($course, 'editingteacher');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$owner->id);

        $this->assertTrue(session_manager::can_view($session, $context, (int)$owner->id));
        $this->assertTrue(session_manager::can_make($session, $context, (int)$owner->id));
        $this->assertFalse(session_manager::can_view($session, $context, (int)$student->id));
        $this->assertFalse(session_manager::can_make($session, $context, (int)$student->id));
        $this->assertTrue(session_manager::can_view($session, $context, (int)$teacher->id));
        $this->assertFalse(session_manager::can_make($session, $context, (int)$teacher->id));

        $DB->set_field('vrmakerspace_sessions', 'status', session_manager::STATUS_CLOSED, ['id' => $session->id]);
        $session = $DB->get_record('vrmakerspace_sessions', ['id' => $session->id]);
        $this->assertTrue(session_manager::can_view($session, $context, (int)$owner->id));
        $this->assertFalse(session_manager::can_make($session, $context, (int)$owner->id));
    }

    /**
     * The data generator.
     *
     * @return \mod_vrmakerspace_generator
     */
    private function generator(): \mod_vrmakerspace_generator {
        return $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
    }

    /**
     * Saving numbers the versions and stores each as a file holding exactly the bytes sent; the
     * operation count comes from the header.
     */
    public function test_save_snapshot_versions_and_files(): void {
        $this->resetAfterTest();
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$user->id);
        $one = $this->generator()->snapshot_data('one', 3);
        $two = $this->generator()->snapshot_data('two', 7);

        $first = session_manager::save_snapshot($session, $context, (int)$user->id, $one);
        $second = session_manager::save_snapshot($session, $context, (int)$user->id, $two);

        $this->assertSame(1, (int)$first->version);
        $this->assertSame(2, (int)$second->version);
        $this->assertSame($two, session_manager::get_snapshot_file($second, $context)->get_content());
        $this->assertSame($one, session_manager::get_snapshot_file($first, $context)->get_content());
        $this->assertSame(7, (int)session_manager::get_latest_snapshot((int)$session->id)->opcount);
        $this->assertSame([1, 2], array_map(
            fn($s) => (int)$s->version,
            array_values(session_manager::get_snapshots((int)$session->id))
        ));
        $this->assertSame(1, (int)session_manager::get_snapshot_by_version((int)$session->id, 1)->version);
        $this->assertNull(session_manager::get_snapshot_by_version((int)$session->id, 3));
    }

    /**
     * Data without the magic number is refused, and nothing is stored.
     */
    public function test_save_snapshot_refuses_foreign_data(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$user->id);

        try {
            $bytes = '<html>not a piece</html>' . str_repeat(' ', 600);
            session_manager::save_snapshot($session, $context, (int)$user->id, $bytes);
            $this->fail('Foreign data was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshotinvalid', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots'));
    }

    /**
     * Header checks: a valid header passes and returns its fields; each broken field is refused.
     *
     * @param int $offset byte offset of the field to change
     * @param string $bytes the new bytes
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('broken_header_provider')]
    public function test_validate_snapshot_refuses_broken_header(int $offset, string $bytes): void {
        $this->resetAfterTest();
        $data = $this->generator()->snapshot_data('x', 9);
        $header = session_manager::validate_snapshot($data);
        $this->assertSame(9, $header['seq']);
        $this->assertSame([8, 8, 8], [$header['nx'], $header['ny'], $header['nz']]);

        $broken = substr_replace($data, $bytes, $offset, strlen($bytes));
        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('snapshotinvalid', 'mod_vrmakerspace'));
        session_manager::validate_snapshot($broken);
    }

    /**
     * Broken header fields: offset and replacement bytes.
     *
     * @return array
     */
    public static function broken_header_provider(): array {
        return [
            'magic' => [0, 'VRSX'],
            'format version 0' => [4, pack('v', 0)],
            'format version 3' => [4, pack('v', 3)],
            'unknown flag' => [6, pack('v', 2)],
            'grid too small' => [8, pack('v', 4)],
            'grid too large' => [10, pack('v', 300)],
            'grid not matching the payload' => [12, pack('v', 9)],
            'voxel too small' => [16, pack('g', 0.0001)],
            'voxel too large' => [16, pack('g', 0.5)],
            'band not positive' => [20, pack('g', 0.0)],
            'payload length wrong' => [44, pack('V', 511)],
            'grid length not one byte per voxel' => [48, pack('V', 511)],
            'grid length past the end' => [48, pack('V', 100000)],
            'grid length empty' => [48, pack('V', 0)],
        ];
    }

    /**
     * A snapshot of a 128-voxel grid with the given format version, flags and payload.
     *
     * @param int $version the format version
     * @param int $flags the header flags
     * @param string $payload the payload
     * @return string
     */
    private function snapshot_file(int $version, int $flags, string $payload): string {
        return session_manager::SNAPSHOT_MAGIC . pack('vvvvvv', $version, $flags, 128, 128, 128, 0) . pack('g', 0.004)
            . pack('g', 0.012) . pack('V', 42) . '0123456789abcdef' . pack('V', strlen($payload)) . $payload;
    }

    /**
     * Both format versions pass: version 2 with its mesh section (even an empty one, which the studio
     * refuses when it parses the file), version 1 with the grid alone.
     */
    public function test_validate_snapshot_accepts_both_versions(): void {
        $this->resetAfterTest();
        $generator = $this->generator();

        $header = session_manager::validate_snapshot($generator->snapshot_data('x', 9));
        $this->assertSame(session_manager::SNAPSHOT_VERSION, $header['version']);
        $this->assertSame(512, $header['gridlength']);
        $this->assertSame(512 + 4 + strlen('{"v":[],"f":[],"s":[]}'), $header['length']);

        $old = $generator->snapshot_data('x', 9, 8, session_manager::SNAPSHOT_VERSION_CLAY);
        $header = session_manager::validate_snapshot($old);
        $this->assertSame(session_manager::SNAPSHOT_VERSION_CLAY, $header['version']);
        $this->assertSame(512, $header['gridlength']);
        $this->assertSame(512, $header['length']);

        $sections = pack('V', 4) . 'gridmesh';
        $header = session_manager::validate_snapshot($this->snapshot_file(2, 1, $sections));
        $this->assertSame(1, $header['flags']);
        $this->assertSame(4, $header['gridlength']);
        $this->assertSame(12, $header['length']);

        $header = session_manager::validate_snapshot($this->snapshot_file(2, 1, pack('V', 4) . 'grid'));
        $this->assertSame(4, $header['gridlength']);
    }

    /**
     * A version 2 payload needs its grid length, and that length must fit in the payload.
     *
     * @param int $flags the header flags
     * @param string $payload the payload
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('broken_sections_provider')]
    public function test_validate_snapshot_refuses_broken_sections(int $flags, string $payload): void {
        $this->resetAfterTest();
        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('snapshotinvalid', 'mod_vrmakerspace'));
        session_manager::validate_snapshot($this->snapshot_file(2, $flags, $payload));
    }

    /**
     * Broken version 2 payloads: flags and payload.
     *
     * @return array
     */
    public static function broken_sections_provider(): array {
        return [
            'too short for a grid length' => [1, 'abc'],
            'only a grid length' => [1, pack('V', 0)],
            'grid past the end' => [1, pack('V', 5) . 'grid'],
            'uncompressed grid of the wrong size' => [0, pack('V', 4) . 'gridmesh'],
        ];
    }

    /**
     * Saving a version 2 file keeps it whole, with the header's sequence number as its operation count.
     */
    public function test_save_snapshot_keeps_the_mesh(): void {
        $this->resetAfterTest();
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$user->id);
        $data = $this->generator()->snapshot_data('mesh', 11);

        $snapshot = session_manager::save_snapshot($session, $context, (int)$user->id, $data);

        $this->assertSame(11, (int)$snapshot->opcount);
        $this->assertSame($data, session_manager::get_snapshot_file($snapshot, $context)->get_content());
    }

    /**
     * Ways of making: unknown values become both; each starting model is allowed as the form says, and
     * one that does not suit gives way to the polygon cube (modelling only) or the clay lump.
     */
    public function test_methods_and_start_models(): void {
        $this->assertSame('model', session_manager::clean_methods('model'));
        $this->assertSame('sculpt', session_manager::clean_methods('sculpt'));
        $this->assertSame('both', session_manager::clean_methods('both'));
        $this->assertSame('both', session_manager::clean_methods('telepathy'));
        $this->assertSame('both', session_manager::methods((object)[]));
        $this->assertSame('sculpt', session_manager::methods((object)['methods' => 'sculpt']));
        $this->assertSame('meshcube', session_manager::clean_start_model('meshcube'));

        foreach (session_manager::START_MODELS as $model) {
            $this->assertTrue(session_manager::start_model_allowed('both', $model), $model);
            $this->assertSame($model !== 'meshcube', session_manager::start_model_allowed('sculpt', $model), $model);
            $this->assertSame(
                $model === 'meshcube' || $model === 'empty',
                session_manager::start_model_allowed('model', $model),
                $model
            );
        }
        $this->assertFalse(session_manager::start_model_allowed('both', 'teapot'));

        $this->assertSame('meshcube', session_manager::start_model_for_methods('model', 'lump'));
        $this->assertSame('meshcube', session_manager::start_model_for_methods('model', 'upload'));
        $this->assertSame('empty', session_manager::start_model_for_methods('model', 'empty'));
        $this->assertSame('lump', session_manager::start_model_for_methods('sculpt', 'meshcube'));
        $this->assertSame('upload', session_manager::start_model_for_methods('sculpt', 'upload'));
        $this->assertSame('meshcube', session_manager::start_model_for_methods('both', 'meshcube'));
    }

    /**
     * A new piece takes the activity's polygon cube as its starting model.
     */
    public function test_session_starts_from_the_polygon_cube(): void {
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', [
            'course' => $course->id,
            'methods' => 'model',
            'startmodel' => 'meshcube',
        ]);
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$user->id);
        $this->assertSame('meshcube', $session->startmodel);
    }

    /**
     * A compressed payload may have any length, as long as the header says it.
     */
    public function test_validate_snapshot_accepts_compressed(): void {
        $this->resetAfterTest();
        $payload = 'compressed bytes';
        $data = session_manager::SNAPSHOT_MAGIC . pack('vvvvvv', 1, 1, 128, 128, 128, 0) . pack('g', 0.004)
            . pack('g', 0.012) . pack('V', 42) . '0123456789abcdef' . pack('V', strlen($payload)) . $payload;
        $header = session_manager::validate_snapshot($data);
        $this->assertSame(1, $header['flags']);
        $this->assertSame(42, $header['seq']);
        $this->assertSame('0123456789abcdef', $header['epoch']);
    }

    /**
     * Data over the size limit is refused, and nothing is stored.
     */
    public function test_save_snapshot_refuses_oversize(): void {
        global $DB;
        $this->resetAfterTest();
        $data = $this->generator()->snapshot_data();
        set_config('maxsnapshotsize', strlen($data) - 1, 'mod_vrmakerspace');
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$user->id);

        try {
            session_manager::save_snapshot($session, $context, (int)$user->id, $data);
            $this->fail('Oversize data was accepted');
        } catch (\moodle_exception $e) {
            $this->assertSame('snapshottoolarge', $e->errorcode);
        }
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots'));
        // Exactly at the limit is accepted.
        set_config('maxsnapshotsize', strlen($data), 'mod_vrmakerspace');
        session_manager::save_snapshot($session, $context, (int)$user->id, $data);
        $this->assertSame(1, $DB->count_records('vrmakerspace_snapshots'));
    }

    /**
     * Closing and reopening change the status; another status is refused.
     */
    public function test_set_status(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = session_manager::get_or_create($vrmakerspace, 0, (int)$user->id);

        session_manager::set_status($session, session_manager::STATUS_CLOSED);
        $status = (int)$DB->get_field('vrmakerspace_sessions', 'status', ['id' => $session->id]);
        $this->assertSame(session_manager::STATUS_CLOSED, $status);
        session_manager::set_status($session, session_manager::STATUS_OPEN);
        $status = (int)$DB->get_field('vrmakerspace_sessions', 'status', ['id' => $session->id]);
        $this->assertSame(session_manager::STATUS_OPEN, $status);

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('invalidstatus', 'mod_vrmakerspace'));
        session_manager::set_status($session, 5);
    }

    /**
     * The manage actions: close, reopen, and reset (versions, files, contributions and connections go;
     * the piece and other pieces stay); an unknown action is refused.
     */
    public function test_manage_actions(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $one = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $two = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $session = $this->generator()->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $one->id]);
        $other = $this->generator()->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $two->id]);
        $this->generator()->create_snapshot($session, (int)$one->id, 'a');
        $this->generator()->create_snapshot($session, (int)$one->id, 'b');
        $kept = $this->generator()->create_snapshot($other, (int)$two->id, 'c');
        $this->generator()->create_contribution($session, (int)$one->id, 5, 10.0, 2.0);

        $this->assertSame('managedone_close', session_manager::manage($session, $context, 'close'));
        $status = (int)$DB->get_field('vrmakerspace_sessions', 'status', ['id' => $session->id]);
        $this->assertSame(session_manager::STATUS_CLOSED, $status);
        $this->assertSame('managedone_reopen', session_manager::manage($session, $context, 'reopen'));
        $status = (int)$DB->get_field('vrmakerspace_sessions', 'status', ['id' => $session->id]);
        $this->assertSame(session_manager::STATUS_OPEN, $status);

        $this->assertSame('managedone_reset', session_manager::manage($session, $context, 'reset'));
        $this->assertTrue($DB->record_exists('vrmakerspace_sessions', ['id' => $session->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots', ['sessionid' => $session->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_contrib', ['sessionid' => $session->id]));
        $fs = get_file_storage();
        $files = $fs->get_area_files($context->id, 'mod_vrmakerspace', session_manager::FILEAREA, false, 'itemid', false);
        $this->assertSame([(int)$kept->id], array_values(array_map(fn($f) => (int)$f->get_itemid(), $files)));

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('invalidaction', 'mod_vrmakerspace'));
        session_manager::manage($session, $context, 'explode');
    }

    /**
     * Deleting sessions removes their versions and files and leaves other sessions alone.
     */
    public function test_delete_sessions(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace, , $context] = $this->make_activity();
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $one = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $two = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $s1 = $generator->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $one->id]);
        $s2 = $generator->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $two->id]);
        $generator->create_snapshot($s1, (int)$one->id);
        $kept = $generator->create_snapshot($s2, (int)$two->id);
        $generator->create_contribution($s1, (int)$one->id, 1, 1.0, 0.0);
        $generator->create_contribution($s2, (int)$two->id, 1, 1.0, 0.0);
        foreach ([$s1, $s2] as $session) {
            $key = pair_manager::new_peerkey();
            $DB->insert_record('vrmakerspace_peers', (object)['sessionid' => $session->id, 'userid' => $session->userid,
                'peerkey' => $key, 'role' => 'host', 'lastseen' => time(), 'timecreated' => time()]);
            $DB->insert_record('vrmakerspace_signals', (object)['sessionid' => $session->id, 'frompeerkey' => $key,
                'topeerkey' => pair_manager::new_peerkey(), 'fromuserid' => $session->userid, 'payload' => '{}',
                'timecreated' => time()]);
        }

        session_manager::delete_sessions([$s1], $context);

        $this->assertFalse($DB->record_exists('vrmakerspace_sessions', ['id' => $s1->id]));
        $this->assertSame(0, $DB->count_records('vrmakerspace_snapshots', ['sessionid' => $s1->id]));
        foreach (['vrmakerspace_contrib', 'vrmakerspace_peers', 'vrmakerspace_signals'] as $table) {
            $this->assertSame(0, $DB->count_records($table, ['sessionid' => $s1->id]), $table);
            $this->assertSame(1, $DB->count_records($table, ['sessionid' => $s2->id]), $table);
        }
        $files = get_file_storage()->get_area_files(
            $context->id,
            'mod_vrmakerspace',
            session_manager::FILEAREA,
            false,
            'itemid',
            false
        );
        $this->assertSame([(int)$kept->id], array_values(array_map(fn($f) => (int)$f->get_itemid(), $files)));
    }

    /**
     * The connection of group work: a known value, or pair.
     */
    public function test_connection(): void {
        $this->assertSame('pair', session_manager::connection((object)['connectmode' => 'pair']));
        $this->assertSame('companion', session_manager::connection((object)['connectmode' => 'companion']));
        $this->assertSame('pair', session_manager::connection((object)['connectmode' => 'carrier pigeon']));
        $this->assertSame('pair', session_manager::connection((object)[]));
        $this->assertTrue(session_manager::is_group_work((object)['workmode' => session_manager::MODE_GROUP]));
        $this->assertFalse(session_manager::is_group_work((object)['workmode' => session_manager::MODE_INDIVIDUAL]));
    }

    /**
     * Saving data identical to the latest version returns that version instead of adding one.
     */
    public function test_save_snapshot_skips_identical_data(): void {
        global $DB;
        $this->resetAfterTest();
        [$course, $vrmakerspace] = $this->make_activity();
        $user = $this->getDataGenerator()->create_and_enrol($course, 'student');
        $generator = $this->getDataGenerator()->get_plugin_generator('mod_vrmakerspace');
        $session = $generator->create_session(['vrmakerspaceid' => $vrmakerspace->id, 'userid' => $user->id]);

        $first = $generator->create_snapshot($session, (int)$user->id, 'same', 5);
        $again = $generator->create_snapshot($session, (int)$user->id, 'same', 5);
        $other = $generator->create_snapshot($session, (int)$user->id, 'changed', 6);

        $this->assertEquals($first->id, $again->id);
        $this->assertSame(2, (int)$other->version);
        $this->assertSame(2, $DB->count_records('vrmakerspace_snapshots', ['sessionid' => $session->id]));
    }
}
