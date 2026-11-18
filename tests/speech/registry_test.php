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
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Unit tests for the speech engine registry and the site's order of preference.
 *
 * No speech service is contacted: a Guzzle mock handler is injected through the
 * DI container in place of \core\http_client.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers     \mod_vrmakerspace\speech\registry
 */
#[CoversClass(registry::class)]
final class registry_test extends advanced_testcase {
    /** @var MockHandler The mocked HTTP handler. */
    private MockHandler $mock;

    /**
     * Resets the cached engines and injects the mocked HTTP client.
     *
     * @return void
     */
    private function mock_http(): void {
        registry::set_engine(null, null);
        $this->mock = new MockHandler();
        \core\di::set(\core\http_client::class, new \core\http_client(['mock' => $this->mock]));
    }

    /**
     * Sets the three choices of a direction.
     *
     * @param string $direction registry::SPEAK or registry::LISTEN
     * @param string $first
     * @param string $second
     * @param string $third
     * @return void
     */
    private function set_order(string $direction, string $first, string $second = '', string $third = ''): void {
        foreach ([1 => $first, 2 => $second, 3 => $third] as $slot => $value) {
            set_config($direction . 'order' . $slot, $value, 'mod_vrmakerspace');
        }
    }

    /**
     * Sets up the OpenAI-style engine for both directions.
     *
     * @return void
     */
    private function configure_openai(): void {
        set_config('openaiurl', 'https://speech.example.com/v1', 'mod_vrmakerspace');
        set_config('openaittsmodel', 'kokoro', 'mod_vrmakerspace');
        set_config('openaisttmodel', 'whisper-1', 'mod_vrmakerspace');
        set_config('openaiformat', 'mp3', 'mod_vrmakerspace');
    }

    /**
     * Sets up ElevenLabs with an API key and the default models.
     *
     * @return void
     */
    private function configure_elevenlabs(): void {
        set_config('elevenlabsapikey', \core\encryption::encrypt('xi-secret'), 'mod_vrmakerspace');
        set_config('elevenlabsurl', '', 'mod_vrmakerspace');
        unset_config('elevenlabsttsmodel', 'mod_vrmakerspace');
        unset_config('elevenlabssttmodel', 'mod_vrmakerspace');
    }

    /**
     * Without saved settings, Ollama comes first and the browser second.
     *
     * @return void
     */
    public function test_default_order(): void {
        $this->resetAfterTest();
        foreach ([registry::SPEAK, registry::LISTEN] as $direction) {
            for ($i = 1; $i <= registry::SLOTS; $i++) {
                unset_config($direction . 'order' . $i, 'mod_vrmakerspace');
            }
            $this->assertSame(['ollama', registry::BROWSER], registry::order($direction));
        }
    }

    /**
     * Repeats, blanks and unknown names are dropped from the order.
     *
     * @return void
     */
    public function test_order_drops_repeats_blanks_and_unknown(): void {
        $this->resetAfterTest();

        $this->set_order(registry::SPEAK, 'openai', 'openai', 'nonsense');
        $this->assertSame(['openai'], registry::order(registry::SPEAK));

        $this->set_order(registry::LISTEN, '', 'browser', 'browser');
        $this->assertSame([registry::BROWSER], registry::order(registry::LISTEN));

        $this->set_order(registry::SPEAK, '', '', '');
        $this->assertSame([], registry::order(registry::SPEAK));
    }

    /**
     * The browser is told the order with engines collapsed to "server" and unusable engines left out.
     *
     * @return void
     */
    public function test_client_order(): void {
        $this->resetAfterTest();
        $this->mock_http();
        $this->configure_openai();
        set_config('elevenlabsapikey', '', 'mod_vrmakerspace');

        $this->set_order(registry::SPEAK, 'openai', 'browser', 'elevenlabs');
        $this->assertSame(['server', 'browser'], registry::client_order(registry::SPEAK));
        $this->assertSame(['openai'], array_keys(registry::engines(registry::SPEAK)));
        $this->assertTrue(registry::available(registry::SPEAK));

        $this->set_order(registry::SPEAK, 'browser', 'openai');
        $this->assertSame(['browser', 'server'], registry::client_order(registry::SPEAK));

        // An engine that is not set up is skipped entirely.
        $this->set_order(registry::SPEAK, 'elevenlabs', 'browser');
        $this->assertSame(['browser'], registry::client_order(registry::SPEAK));
        $this->assertFalse(registry::available(registry::SPEAK));

        // Two usable engines become one server step, tried in the site's order.
        $this->configure_elevenlabs();
        $this->set_order(registry::SPEAK, 'elevenlabs', 'openai', 'browser');
        $this->assertSame(['server', 'browser'], registry::client_order(registry::SPEAK));
        $this->assertSame(['elevenlabs', 'openai'], array_keys(registry::engines(registry::SPEAK)));

        // Listening has its own order.
        $this->set_order(registry::LISTEN, 'browser');
        $this->assertSame(['browser'], registry::client_order(registry::LISTEN));
        $this->assertNull($this->mock->getLastRequest());
    }

    /**
     * When the first engine fails, the next one speaks in the same request.
     *
     * @return void
     */
    public function test_synthesise_falls_back(): void {
        $this->resetAfterTest();
        $this->mock_http();
        $this->configure_openai();
        $this->configure_elevenlabs();
        $this->set_order(registry::SPEAK, 'openai', 'elevenlabs');
        $this->mock->append(
            new Response(500, [], 'Internal error'),
            new Response(200, ['Content-Type' => 'audio/mpeg'], 'MP3BYTES')
        );

        $result = registry::synthesise('Hello there.', 'en-GB');
        // The failing engine reports its HTTP status to developers.
        $this->assertDebuggingCalled();

        $this->assertSame('elevenlabs', $result['engine']);
        $this->assertSame('audio/mpeg', $result['mimetype']);
        $this->assertSame('MP3BYTES', $result['audio']);
        $this->assertSame(0, $this->mock->count());
        $this->assertSame('api.elevenlabs.io', $this->mock->getLastRequest()->getUri()->getHost());
    }

    /**
     * When every engine fails, the last error is reported.
     *
     * @return void
     */
    public function test_synthesise_all_fail(): void {
        $this->resetAfterTest();
        $this->mock_http();
        $this->configure_openai();
        $this->configure_elevenlabs();
        $this->set_order(registry::SPEAK, 'openai', 'elevenlabs', 'browser');
        $this->mock->append(new Response(500, [], 'Internal error'), new Response(503, [], 'Unavailable'));

        try {
            registry::synthesise('Hello there.', 'en-GB');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        $this->assertDebuggingCalledCount(2);
        $this->assertSame(0, $this->mock->count());
    }

    /**
     * Transcription skips engines that do not accept the recording type.
     *
     * @return void
     */
    public function test_transcribe_skips_engines_that_refuse_the_type(): void {
        $this->resetAfterTest();
        $this->mock_http();
        $this->configure_openai();
        // Ollama is set up and first, but only takes WAV.
        set_config('ollamaurl', 'http://ollama.example.com', 'mod_vrmakerspace');
        set_config('ollamasttmodel', 'lfm3-audio', 'mod_vrmakerspace');
        $this->set_order(registry::LISTEN, 'ollama', 'openai');
        $this->mock->append(new Response(200, ['Content-Type' => 'application/json'], json_encode(['text' => 'Hello'])));

        $result = registry::transcribe('WEBMBYTES', 'audio/webm', 'en-GB');

        $this->assertSame(['text' => 'Hello', 'engine' => 'openai'], $result);
        $this->assertSame(0, $this->mock->count());
        $this->assertSame(
            'https://speech.example.com/v1/audio/transcriptions',
            (string) $this->mock->getLastRequest()->getUri()
        );
    }

    /**
     * A type no usable engine accepts fails without any request.
     *
     * @return void
     */
    public function test_transcribe_no_engine_accepts_the_type(): void {
        $this->resetAfterTest();
        $this->mock_http();
        set_config('ollamaurl', 'http://ollama.example.com', 'mod_vrmakerspace');
        set_config('ollamasttmodel', 'lfm3-audio', 'mod_vrmakerspace');
        $this->set_order(registry::LISTEN, 'ollama', 'browser');

        try {
            registry::transcribe('OGGBYTES', 'audio/ogg', 'en');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        $this->assertNull($this->mock->getLastRequest());
    }

    /**
     * Without a usable engine in the order, the registry reports that speech is not configured.
     *
     * @return void
     */
    public function test_no_engine(): void {
        $this->resetAfterTest();
        $this->mock_http();
        // Set up, but not in the order.
        $this->configure_openai();
        $this->set_order(registry::SPEAK, 'browser');
        $this->set_order(registry::LISTEN, 'browser');

        $this->assertFalse(registry::available(registry::SPEAK));
        $this->assertFalse(registry::available(registry::LISTEN));
        $calls = [
            'speak' => fn() => registry::synthesise('Hello.', 'en'),
            'listen' => fn() => registry::transcribe('WAVBYTES', 'audio/wav', 'en'),
        ];
        foreach ($calls as $label => $call) {
            try {
                $call();
                $this->fail("Expected error_speechnotconfigured when trying to $label");
            } catch (\moodle_exception $e) {
                $this->assertSame('error_speechnotconfigured', $e->errorcode);
            }
        }
        $this->assertNull($this->mock->getLastRequest());
    }

    /**
     * An injected engine replaces the built-in one until the registry is reset.
     *
     * @return void
     */
    public function test_set_engine(): void {
        $this->resetAfterTest();
        $fake = new class extends engine\openai {
            /**
             * Always able to speak.
             *
             * @return bool
             */
            public function can_speak(): bool {
                return true;
            }

            /**
             * Returns fixed audio.
             *
             * @param string $text
             * @param string $language
             * @param string $voice
             * @return array
             */
            public function synthesise(string $text, string $language, string $voice = ''): array {
                return ['mimetype' => 'audio/wav', 'audio' => 'FAKE:' . $text];
            }
        };
        registry::set_engine('openai', $fake);
        $this->set_order(registry::SPEAK, 'openai');

        $this->assertSame(
            ['mimetype' => 'audio/wav', 'audio' => 'FAKE:Hi.', 'engine' => 'openai'],
            registry::synthesise('Hi.', 'en')
        );

        registry::set_engine(null, null);
        $this->assertNotSame($fake, registry::engine('openai'));
    }

    /**
     * An unknown engine name is a coding error.
     *
     * @return void
     */
    public function test_unknown_engine(): void {
        $this->expectException(\coding_exception::class);
        registry::engine('nonsense');
    }

    #[\Override]
    protected function tearDown(): void {
        // Undo the \core\http_client DI override and the cached engines so they don't leak into other tests.
        \core\di::reset_container();
        registry::set_engine(null, null);
        parent::tearDown();
    }
}
