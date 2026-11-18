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
 * The speech engines and the site's order of preference.
 *
 * For speaking and for listening separately, the administrator ranks up to
 * three choices: the browser's own Web Speech API or one of the server-side
 * engines. Choices that are not set up are skipped. The browser is told the
 * order collapsed to "server" and "browser" steps, because the server tries
 * its engines in order itself: if the first fails, the next one is tried in
 * the same request.
 *
 * @package    mod_vrmakerspace
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class registry {
    /** The browser's own speech (Web Speech API) as a choice in the order. */
    const BROWSER = 'browser';

    /** Server-side engines by name. */
    const ENGINES = [
        'ollama'     => engine\ollama::class,
        'openai'     => engine\openai::class,
        'elevenlabs' => engine\elevenlabs::class,
        'google'     => engine\google::class,
    ];

    /** Directions with their settings prefix. */
    const SPEAK = 'speak';
    /** Listening. */
    const LISTEN = 'listen';

    /** How many ranked choices the administrator can set per direction. */
    const SLOTS = 3;

    /** The default order: Ollama first, then the browser. */
    const DEFAULT_ORDER = ['ollama', self::BROWSER, ''];

    /** @var engine[] Engine instances by name, for tests. */
    private static array $instances = [];

    /**
     * Returns an engine by name.
     *
     * @param string $name A key of ENGINES
     * @return engine
     */
    public static function engine(string $name): engine {
        if (!isset(self::ENGINES[$name])) {
            throw new \coding_exception('Unknown speech engine ' . $name);
        }
        if (!isset(self::$instances[$name])) {
            $class = self::ENGINES[$name];
            self::$instances[$name] = new $class();
        }
        return self::$instances[$name];
    }

    /**
     * Replaces an engine instance (for tests), or with null resets all of them.
     *
     * @param string|null $name
     * @param engine|null $engine
     */
    public static function set_engine(?string $name, ?engine $engine): void {
        if ($name === null) {
            self::$instances = [];
        } else if ($engine === null) {
            unset(self::$instances[$name]);
        } else {
            self::$instances[$name] = $engine;
        }
    }

    /**
     * The options of an order setting: none, the browser and every engine.
     *
     * @return array
     */
    public static function choices(): array {
        $choices = ['' => get_string('speechchoice_none', 'mod_vrmakerspace'),
            self::BROWSER => get_string('speechchoice_browser', 'mod_vrmakerspace')];
        foreach (self::ENGINES as $name => $class) {
            $choices[$name] = $class::display_name();
        }
        return $choices;
    }

    /**
     * The administrator's order for a direction, without blanks, repeats or unknown names.
     *
     * @param string $direction self::SPEAK or self::LISTEN
     * @return string[] Engine names and self::BROWSER
     */
    public static function order(string $direction): array {
        $order = [];
        for ($i = 1; $i <= self::SLOTS; $i++) {
            $value = get_config('mod_vrmakerspace', $direction . 'order' . $i);
            if ($value === false) {
                $value = self::DEFAULT_ORDER[$i - 1];
            }
            $value = (string) $value;
            if (($value === self::BROWSER || isset(self::ENGINES[$value])) && !in_array($value, $order, true)) {
                $order[] = $value;
            }
        }
        return $order;
    }

    /**
     * The server-side engines that are set up for a direction, in the site's order.
     *
     * @param string $direction self::SPEAK or self::LISTEN
     * @return engine[] By name
     */
    public static function engines(string $direction): array {
        $engines = [];
        foreach (self::order($direction) as $name) {
            if ($name === self::BROWSER) {
                continue;
            }
            $engine = self::engine($name);
            if ($direction === self::SPEAK ? $engine->can_speak() : $engine->can_listen()) {
                $engines[$name] = $engine;
            }
        }
        return $engines;
    }

    /**
     * The order the browser should try, e.g. ['server', 'browser'].
     *
     * Engines that are not set up are left out, and neighbouring engines become one
     * "server" step, because the server tries them in order itself.
     *
     * @param string $direction self::SPEAK or self::LISTEN
     * @return string[] 'server' and 'browser'
     */
    public static function client_order(string $direction): array {
        $usable = self::engines($direction);
        $steps = [];
        foreach (self::order($direction) as $name) {
            $step = $name === self::BROWSER ? self::BROWSER : (isset($usable[$name]) ? 'server' : null);
            if ($step !== null && !in_array($step, $steps, true)) {
                $steps[] = $step;
            }
        }
        return $steps;
    }

    /**
     * Whether any server-side engine can do this direction.
     *
     * @param string $direction self::SPEAK or self::LISTEN
     * @return bool
     */
    public static function available(string $direction): bool {
        return !empty(self::engines($direction));
    }

    /**
     * Speaks text with the first engine that works.
     *
     * @param string $text
     * @param string $language BCP 47 tag
     * @param string $voice The activity's voice name
     * @return array {mimetype: string, audio: string (binary), engine: string}
     * @throws \moodle_exception error_speechnotconfigured or error_speechfailed
     */
    public static function synthesise(string $text, string $language, string $voice = ''): array {
        $engines = self::engines(self::SPEAK);
        if (!$engines) {
            throw new \moodle_exception('error_speechnotconfigured', 'mod_vrmakerspace');
        }
        $error = null;
        foreach ($engines as $name => $engine) {
            try {
                return $engine->synthesise($text, $language, $voice) + ['engine' => $name];
            } catch (\moodle_exception $e) {
                $error = $e;
            }
        }
        throw $error;
    }

    /**
     * Transcribes a recording with the first engine that accepts it and works.
     *
     * @param string $audio The audio bytes
     * @param string $mimetype A key of engine::UPLOAD_TYPES
     * @param string $language BCP 47 tag
     * @return array {text: string, engine: string}
     * @throws \moodle_exception error_speechnotconfigured or error_speechfailed
     */
    public static function transcribe(string $audio, string $mimetype, string $language = ''): array {
        $engines = self::engines(self::LISTEN);
        if (!$engines) {
            throw new \moodle_exception('error_speechnotconfigured', 'mod_vrmakerspace');
        }
        $error = new \moodle_exception('error_speechfailed', 'mod_vrmakerspace');
        foreach ($engines as $name => $engine) {
            if (!in_array($mimetype, $engine->accepted_types(), true)) {
                continue;
            }
            try {
                return ['text' => $engine->transcribe($audio, $mimetype, $language), 'engine' => $name];
            } catch (\moodle_exception $e) {
                $error = $e;
            }
        }
        throw $error;
    }
}
