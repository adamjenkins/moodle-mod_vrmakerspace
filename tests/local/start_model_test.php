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

defined('MOODLE_INTERNAL') || die();

global $CFG;
require_once($CFG->dirroot . '/mod/vrmakerspace/lib.php');

/**
 * Tests of the uploaded starting model: saved from the form, handed to the studio, removed again.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\local\session_manager::class)]
#[\PHPUnit\Framework\Attributes\CoversFunction('vrmakerspace_save_start_model')]
final class start_model_test extends \advanced_testcase {
    /**
     * A draft area of the current user holding one file.
     *
     * @param string $filename the file name
     * @param string $content the file content
     * @return int the draft item id
     */
    private function draft_file(string $filename, string $content): int {
        global $USER;
        $draftid = file_get_unused_draft_itemid();
        get_file_storage()->create_file_from_string([
            'contextid' => \context_user::instance($USER->id)->id,
            'component' => 'user',
            'filearea' => 'draft',
            'itemid' => $draftid,
            'filepath' => '/',
            'filename' => $filename,
        ], $content);
        return $draftid;
    }

    /**
     * The file name of the activity's starting model, or null.
     *
     * @param \context_module $context the activity context
     * @return string|null
     */
    private function model_name(\context_module $context): ?string {
        $file = session_manager::start_model_file($context);
        return $file ? $file->get_filename() : null;
    }

    /**
     * Only STL, OBJ and glTF binary files are starting models, whatever the case of the extension.
     */
    public function test_start_model_format(): void {
        $this->assertSame('stl', session_manager::start_model_format('Owl.STL'));
        $this->assertSame('obj', session_manager::start_model_format('owl.obj'));
        $this->assertSame('glb', session_manager::start_model_format('owl.glb'));
        $this->assertSame('', session_manager::start_model_format('owl.gltf'));
        $this->assertSame('', session_manager::start_model_format('owl'));
        $this->assertSame('upload', session_manager::clean_start_model('upload'));
    }

    /**
     * An activity saved with an uploaded model keeps the file and gives the studio its URL and format;
     * switching to a primitive removes the file, and sculptures that started from it get the clay lump.
     */
    public function test_upload_saved_served_and_removed(): void {
        $this->resetAfterTest();
        $this->setAdminUser();
        $gen = $this->getDataGenerator();
        $course = $gen->create_course(['summary' => '']);
        $vrmakerspace = $gen->create_module('vrmakerspace', [
            'course' => $course->id,
            'startmodel' => 'upload',
            'startmodelfile' => $this->draft_file('owl.stl', "solid owl\nendsolid owl\n"),
        ]);
        $context = \context_module::instance($vrmakerspace->cmid);
        $cm = get_fast_modinfo($course)->get_cm($vrmakerspace->cmid);
        $this->assertSame('upload', $vrmakerspace->startmodel);
        $this->assertSame('owl.stl', $this->model_name($context));

        $student = $gen->create_and_enrol($course, 'student');
        $this->setUser($student);
        $resolved = studio_helper::resolve($vrmakerspace, $cm, $context, (int)$student->id, 0, 0);
        $this->assertSame('upload', $resolved['session']->startmodel);
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('upload', $config['model']);
        $this->assertSame('stl', $config['modelformat']);
        $expected = '/pluginfile.php/' . $context->id . '/mod_vrmakerspace/startmodel/0/owl.stl';
        $this->assertStringContainsString($expected, $config['modelurl']);

        // The teacher switches to the sphere: the file goes; the student's sculpture keeps 'upload'
        // and falls back to the lump.
        $this->setAdminUser();
        vrmakerspace_save_start_model((object)['startmodel' => 'sphere', 'startmodelfile' => file_get_unused_draft_itemid(),
            'coursemodule' => $vrmakerspace->cmid]);
        $this->assertNull($this->model_name($context));
        $config = studio_helper::config($vrmakerspace, $context, $student, $resolved);
        $this->assertSame('lump', $config['model']);
        $this->assertSame('', $config['modelurl']);
        $this->assertSame('', $config['modelformat']);
    }

    /**
     * Without the file manager in the data (a generator or web service), the file is left alone.
     */
    public function test_no_file_manager_keeps_the_file(): void {
        $this->resetAfterTest();
        $this->setAdminUser();
        $course = $this->getDataGenerator()->create_course(['summary' => '']);
        $vrmakerspace = $this->getDataGenerator()->create_module('vrmakerspace', [
            'course' => $course->id,
            'startmodel' => 'upload',
            'startmodelfile' => $this->draft_file('owl.obj', "v 0 0 0\n"),
        ]);
        $context = \context_module::instance($vrmakerspace->cmid);
        vrmakerspace_save_start_model((object)['startmodel' => 'cube', 'coursemodule' => $vrmakerspace->cmid]);
        $this->assertSame('owl.obj', $this->model_name($context));
    }
}
