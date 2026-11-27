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

/**
 * Cache definitions of mod_vrmakerspace.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$definitions = [
    // Recent speech-service calls per user, for \mod_vrmakerspace\speech\rate_limiter.
    'speechrate' => [
        'mode' => cache_store::MODE_APPLICATION,
        'simplekeys' => true,
        'ttl' => 120,
    ],
    // The tutor's latest answer per user and activity, so that only it can be spoken (tutor_speak).
    // An application cache keyed by user and course module, not a session cache: ask_tutor releases
    // the session lock before the AI answers, and the session cache store keeps its data in $SESSION,
    // which is no longer saved after that.
    'tutoranswer' => [
        'mode' => cache_store::MODE_APPLICATION,
        'simplekeys' => true,
        'simpledata' => true,
        'ttl' => 3600,
    ],
    // When the AI last failed to answer the tutor (tutorial::mark_ai_down()), shared by the whole site: nobody is
    // offered the Ask box for a while after it.
    'aistatus' => [
        'mode' => cache_store::MODE_APPLICATION,
        'simplekeys' => true,
        'simpledata' => true,
        'staticacceleration' => true,
    ],
];
