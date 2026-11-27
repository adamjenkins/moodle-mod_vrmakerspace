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

namespace mod_vrmakerspace\speech\engine;

use advanced_testcase;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Unit tests for the ElevenLabs speech engine.
 *
 * ElevenLabs is never contacted: a Guzzle mock handler is injected through the
 * DI container in place of \core\http_client.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers     \mod_vrmakerspace\speech\engine\elevenlabs
 */
#[CoversClass(elevenlabs::class)]
final class elevenlabs_test extends advanced_testcase {
    /** @var MockHandler The mocked HTTP handler. */
    private MockHandler $mock;

    /**
     * Sets an API key with the default address, models and voice, and injects the mocked HTTP client.
     *
     * @return void
     */
    private function configure(): void {
        set_config('elevenlabsapikey', \core\encryption::encrypt('xi-secret'), 'mod_vrmakerspace');
        set_config('elevenlabsurl', '', 'mod_vrmakerspace');
        unset_config('elevenlabsttsmodel', 'mod_vrmakerspace');
        unset_config('elevenlabssttmodel', 'mod_vrmakerspace');
        set_config('elevenlabsvoice', '', 'mod_vrmakerspace');
        $this->mock = new MockHandler();
        \core\di::set(\core\http_client::class, new \core\http_client(['mock' => $this->mock]));
    }

    /**
     * Without an API key the engine can neither speak nor listen; with one, the default models make it usable.
     *
     * @return void
     */
    public function test_can_speak_and_listen(): void {
        $this->resetAfterTest();
        $engine = new elevenlabs();

        set_config('elevenlabsapikey', '', 'mod_vrmakerspace');
        $this->assertFalse($engine->can_speak());
        $this->assertFalse($engine->can_listen());

        $this->configure();
        $this->assertTrue($engine->can_speak());
        $this->assertTrue($engine->can_listen());
    }

    /**
     * Text-to-speech posts to the default voice with the output format, key header and language code.
     *
     * @return void
     */
    public function test_synthesise_request(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(200, ['Content-Type' => 'audio/mpeg'], 'MP3BYTES'));

        $result = (new elevenlabs())->synthesise('Bonjour.', 'fr-CA', 'not an ElevenLabs voice id');

        $this->assertSame(['mimetype' => 'audio/mpeg', 'audio' => 'MP3BYTES'], $result);
        $request = $this->mock->getLastRequest();
        $this->assertSame('POST', $request->getMethod());
        $this->assertSame(
            'https://api.elevenlabs.io/v1/text-to-speech/' . elevenlabs::DEFAULT_VOICE . '?output_format=mp3_44100_64',
            (string) $request->getUri()
        );
        $this->assertSame('xi-secret', $request->getHeaderLine('xi-api-key'));
        $this->assertSame('application/json', $request->getHeaderLine('Content-Type'));
        $this->assertSame([
            'text' => 'Bonjour.',
            'model_id' => 'eleven_flash_v2_5',
            'voice_settings' => ['use_speaker_boost' => false],
            'language_code' => 'fr',
        ], json_decode((string) $request->getBody(), true));
    }

    /**
     * A voice id from the activity and the site's own address are used; multilingual v2 gets no language code.
     *
     * @return void
     */
    public function test_synthesise_voice_and_address(): void {
        $this->resetAfterTest();
        $this->configure();
        set_config('elevenlabsurl', 'https://eu.elevenlabs.example/', 'mod_vrmakerspace');
        set_config('elevenlabsttsmodel', 'eleven_multilingual_v2', 'mod_vrmakerspace');
        $this->mock->append(new Response(200, ['Content-Type' => 'audio/mpeg'], 'MP3BYTES'));

        (new elevenlabs())->synthesise('Hello.', 'en-GB', '21m00Tcm4TlvDq8ikWAM');

        $request = $this->mock->getLastRequest();
        $this->assertSame(
            'https://eu.elevenlabs.example/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_64',
            (string) $request->getUri()
        );
        $body = json_decode((string) $request->getBody(), true);
        $this->assertSame('eleven_multilingual_v2', $body['model_id']);
        $this->assertArrayNotHasKey('language_code', $body);
    }

    /**
     * A failed request is reported as error_speechfailed.
     *
     * @return void
     */
    public function test_synthesise_server_error(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(401, [], '{"detail":"invalid api key"}'));

        try {
            (new elevenlabs())->synthesise('Hello.', 'en');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        // The failing service reports its HTTP status to developers.
        $this->assertDebuggingCalled();
    }

    /**
     * Speech-to-text posts multipart with the model, the primary language and the key header.
     *
     * @return void
     */
    public function test_transcribe_request(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(200, ['Content-Type' => 'application/json'], json_encode(['text' => ' Salut. '])));

        $text = (new elevenlabs())->transcribe('WEBMBYTES', 'audio/webm', 'fr-CA');

        $this->assertSame('Salut.', $text);
        $request = $this->mock->getLastRequest();
        $this->assertSame('https://api.elevenlabs.io/v1/speech-to-text', (string) $request->getUri());
        $this->assertSame('xi-secret', $request->getHeaderLine('xi-api-key'));
        $body = (string) $request->getBody();
        $this->assertStringContainsString('filename="speech.webm"', $body);
        $this->assertStringContainsString('WEBMBYTES', $body);
        $this->assertMatchesRegularExpression('/name="model_id"\r\n(?:[^\r\n]+\r\n)*\r\nscribe_v2\r\n/', $body);
        $this->assertMatchesRegularExpression('/name="language_code"\r\n(?:[^\r\n]+\r\n)*\r\nfr\r\n/', $body);
    }

    /**
     * A reply without a transcript is reported as error_speechfailed.
     *
     * @return void
     */
    public function test_transcribe_bad_reply(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(200, [], 'not json'));

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('error_speechfailed', 'mod_vrmakerspace'));
        (new elevenlabs())->transcribe('WAVBYTES', 'audio/wav', 'en');
    }

    #[\Override]
    protected function tearDown(): void {
        // Undo the \core\http_client DI override so it doesn't leak into other tests.
        \core\di::reset_container();
        parent::tearDown();
    }
}
