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

namespace mod_vrmakerspace\task;

use mod_vrmakerspace\local\pair_manager;

/**
 * Tests of the cleanup scheduled task.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
#[\PHPUnit\Framework\Attributes\CoversClass(\mod_vrmakerspace\task\cleanup::class)]
final class cleanup_test extends \advanced_testcase {
    /**
     * The task is registered every 15 minutes, deletes messages and peers older than an hour, and keeps
     * the fresh ones.
     */
    public function test_execute(): void {
        global $DB;
        $this->resetAfterTest();
        $task = \core\task\manager::get_scheduled_task(cleanup::class);
        $this->assertInstanceOf(cleanup::class, $task);
        $this->assertSame('*/15', $task->get_minute());
        $this->assertNotEmpty($task->get_name());

        $now = time();
        $old = $now - pair_manager::EXPIRY - 60;
        $stale = pair_manager::new_peerkey();
        $fresh = pair_manager::new_peerkey();
        $DB->insert_record('vrmakerspace_peers', (object)['sessionid' => 1, 'userid' => 2, 'peerkey' => $stale, 'role' => 'host',
            'lastseen' => $old, 'timecreated' => $old]);
        $DB->insert_record('vrmakerspace_peers', (object)['sessionid' => 1, 'userid' => 3, 'peerkey' => $fresh, 'role' => 'guest',
            'lastseen' => $now, 'timecreated' => $now]);
        // A message to the stale peer, an old message between others, and a fresh one.
        $signal = ['sessionid' => 1, 'fromuserid' => 3, 'payload' => '{}'];
        $DB->insert_record('vrmakerspace_signals', (object)($signal + ['frompeerkey' => $fresh, 'topeerkey' => $stale,
            'timecreated' => $now]));
        $DB->insert_record('vrmakerspace_signals', (object)($signal + ['frompeerkey' => pair_manager::new_peerkey(),
            'topeerkey' => pair_manager::new_peerkey(), 'timecreated' => $old]));
        $keptid = $DB->insert_record('vrmakerspace_signals', (object)($signal + ['frompeerkey' => $fresh,
            'topeerkey' => pair_manager::new_peerkey(), 'timecreated' => $now]));

        ob_start();
        $task->execute();
        $output = ob_get_clean();

        $this->assertStringContainsString('removed 1 expired connections and 2 expired connection messages', $output);
        $this->assertSame([$fresh], array_values($DB->get_fieldset_select('vrmakerspace_peers', 'peerkey', '1 = 1')));
        $this->assertSame([(int)$keptid], array_map('intval', $DB->get_fieldset_select('vrmakerspace_signals', 'id', '1 = 1')));
    }
}
