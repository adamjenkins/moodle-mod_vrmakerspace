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
 * Which piece the studio page opens, and how: the configuration of the studio's JavaScript.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class studio_helper {
    /** @var int Milliseconds between automatic saves. */
    public const AUTOSAVE_MS = 60000;

    /** @var int Milliseconds between contribution reports. */
    public const CONTRIBUTION_MS = 30000;

    /** @var string Individual work. */
    public const MODE_SOLO = 'solo';

    /** @var string Group work with one partner, browser to browser. */
    public const MODE_PAIR = 'pair';

    /** @var string Group work over the companion service. */
    public const MODE_COMPANION = 'companion';

    /** @var string Looking only. */
    public const MODE_VIEW = 'view';

    /**
     * The piece a request asks for, checked against what the user may do.
     *
     * Without $sessionid, the user's own piece (or their group's), created on first use as on the
     * activity page; with it, any piece of this activity the user may see. With $version, that
     * saved version. The studio is read-only for users who may not change the piece, for a closed
     * piece, and for any version but the latest.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \cm_info|\stdClass $cm the course module
     * @param \context_module $context the activity context
     * @param int $userid the user (never from the client)
     * @param int $sessionid a piece, or 0 for the user's own
     * @param int $version a saved version, or 0 for the latest
     * @param int $groupid group work, own piece: which of the user's groups (0 for the first)
     * @return array{session: \stdClass, snapshot: ?\stdClass, latest: ?\stdClass, readonly: bool}
     * @throws \moodle_exception invalidsession, nogroup, invalidversion
     * @throws \required_capability_exception when the user may not see the piece
     */
    public static function resolve(
        \stdClass $vrmakerspace,
        $cm,
        \context_module $context,
        int $userid,
        int $sessionid,
        int $version,
        int $groupid = 0
    ): array {
        if ($sessionid) {
            $session = session_manager::get_session($sessionid, $vrmakerspace);
            if (!session_manager::can_view($session, $context, $userid)) {
                throw new \required_capability_exception($context, 'mod/vrmakerspace:viewallsubmissions', 'nopermissions', '');
            }
        } else {
            require_capability('mod/vrmakerspace:make', $context, $userid);
            $session = session_manager::get_or_create_for_user($vrmakerspace, $cm, $userid, $groupid);
            if (!$session) {
                throw new \moodle_exception('nogroup', 'mod_vrmakerspace');
            }
        }

        $latest = session_manager::get_latest_snapshot((int)$session->id);
        $snapshot = $latest;
        if ($version) {
            $snapshot = session_manager::get_snapshot_by_version((int)$session->id, $version);
            if (!$snapshot) {
                throw new \moodle_exception('invalidversion', 'mod_vrmakerspace');
            }
        }
        $old = $snapshot && $latest && (int)$snapshot->version < (int)$latest->version;
        $readonly = $old || !session_manager::can_make($session, $context, $userid);
        return ['session' => $session, 'snapshot' => $snapshot, 'latest' => $latest, 'readonly' => $readonly];
    }

    /**
     * The studio mode of a piece.
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param bool $readonly whether the studio only shows the piece
     * @return string one of the MODE_* constants
     */
    public static function mode(\stdClass $vrmakerspace, bool $readonly): string {
        if ($readonly) {
            return self::MODE_VIEW;
        }
        if (!session_manager::is_group_work($vrmakerspace)) {
            return self::MODE_SOLO;
        }
        return session_manager::connection($vrmakerspace) === session_manager::CONNECTION_COMPANION
            ? self::MODE_COMPANION : self::MODE_PAIR;
    }

    /**
     * The configuration passed to mod_vrmakerspace/studio init().
     *
     * @param \stdClass $vrmakerspace the vrmakerspace row
     * @param \context_module $context the activity context
     * @param \stdClass $user the user
     * @param array $resolved what resolve() returned
     * @return array
     */
    public static function config(\stdClass $vrmakerspace, \context_module $context, \stdClass $user, array $resolved): array {
        $session = $resolved['session'];
        $snapshot = $resolved['snapshot'];
        $readonly = (bool)$resolved['readonly'];
        $mode = self::mode($vrmakerspace, $readonly);

        $maxusers = 1;
        if (session_manager::is_group_work($vrmakerspace)) {
            $maxusers = session_manager::connection($vrmakerspace) === session_manager::CONNECTION_COMPANION
                ? min(8, max(2, (int)$vrmakerspace->maxusers)) : pair_manager::MAX_PEERS;
        }
        // A piece keeps the starting model it was created with, but the teacher may have changed the ways
        // of making since: a model that no longer suits them gives way, as an unknown model does. So does
        // an uploaded starting model that has gone (the activity now starts from a primitive).
        $methods = session_manager::methods($vrmakerspace);
        $model = session_manager::start_model_for_methods(
            $methods,
            session_manager::clean_start_model((string)$session->startmodel)
        );
        $modelfile = $model === session_manager::MODEL_UPLOAD ? session_manager::start_model_file($context) : null;
        if ($model === session_manager::MODEL_UPLOAD && !$modelfile) {
            $model = session_manager::start_model_for_methods($methods, session_manager::START_MODELS[0]);
        }
        $modelurl = $modelfile ? \moodle_url::make_pluginfile_url(
            $context->id,
            'mod_vrmakerspace',
            session_manager::MODEL_FILEAREA,
            0,
            '/',
            $modelfile->get_filename(),
            true
        )->out(false) : '';

        $workerurl = self::worker_url();

        return [
            'cmid' => (int)$context->instanceid,
            'sessionid' => (int)$session->id,
            'mode' => $mode,
            'readonly' => $readonly,
            'user' => ['id' => (int)$user->id, 'name' => pair_manager::display_name(fullname($user))],
            'methods' => $methods,
            'model' => $model,
            'modelurl' => $modelurl,
            'modelformat' => $modelfile ? session_manager::start_model_format($modelfile->get_filename()) : '',
            // Looking only: the version shown, fetched directly. Working: the session fetches its state.
            'snapshoturl' => $readonly && $snapshot ? session_manager::snapshot_url($snapshot, $context)->out(false) : '',
            'version' => $snapshot ? (int)$snapshot->version : 0,
            'workerurl' => $workerurl->out(false),
            'trackcontributions' => !$readonly && session_manager::is_group_work($vrmakerspace)
                && !empty($vrmakerspace->trackcontributions),
            'maxusers' => $maxusers,
            'autosavems' => self::AUTOSAVE_MS,
            'contributionms' => self::CONTRIBUTION_MS,
            'backurl' => (new \moodle_url('/mod/vrmakerspace/view.php', ['id' => $context->instanceid]))->out(false),
        ];
    }

    /**
     * Which controls the studio template shows for the ways of making.
     *
     * @param string $methods one of session_manager::METHODS
     * @param string $model the starting model the studio opens with
     * @return array{methods: string, cansculpt: bool, canmodel: bool, showmethodswitch: bool, modelfirst: bool}
     */
    public static function methods_context(string $methods, string $model): array {
        $methods = session_manager::clean_methods($methods);
        $canmodel = $methods !== session_manager::METHODS_SCULPT;
        return [
            'methods' => $methods,
            'cansculpt' => $methods !== session_manager::METHODS_MODEL,
            'canmodel' => $canmodel,
            'showmethodswitch' => $methods === session_manager::METHODS_BOTH,
            'modelfirst' => $methods === session_manager::METHODS_MODEL
                || ($canmodel && $model === session_manager::MODEL_MESHCUBE),
        ];
    }

    /**
     * The URL of the engine's worker, for the studio and the grading page's quick view.
     *
     * Served by engine.php under a versioned path, so the worker's relative imports are versioned too.
     *
     * @return \moodle_url
     */
    public static function worker_url(): \moodle_url {
        return new \moodle_url('/mod/vrmakerspace/engine.php/' . (int)get_config('mod_vrmakerspace', 'version') . '/worker.js');
    }

    /**
     * The studio page's heading: whose piece, and which version when an older one is shown.
     *
     * @param \stdClass $session the session row
     * @param \context_module $context the activity context
     * @param int $userid the user looking
     * @param \stdClass|null $snapshot the version shown, when one was asked for
     * @return string plain text
     */
    public static function title(\stdClass $session, \context_module $context, int $userid, ?\stdClass $snapshot): string {
        $names = [];
        if ((int)$session->groupid) {
            $owner = get_string('groupsculpture', 'vrmakerspace', view_helper::owner_name($session, $context, $names));
        } else if ((int)$session->userid === $userid) {
            $owner = get_string('yoursculpture', 'vrmakerspace');
        } else {
            $owner = get_string('sculptureof', 'vrmakerspace', view_helper::owner_name($session, $context, $names));
        }
        if (!$snapshot) {
            return $owner;
        }
        return get_string('studiotitleversion', 'vrmakerspace', ['owner' => $owner, 'version' => (int)$snapshot->version]);
    }
}
