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
 * Unit tests for the Google Cloud speech engine.
 *
 * Google is never contacted: a Guzzle mock handler is injected through the DI
 * container in place of \core\http_client.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers     \mod_vrmakerspace\speech\engine\google
 */
#[CoversClass(google::class)]
final class google_test extends advanced_testcase {
    /** @var MockHandler The mocked HTTP handler. */
    private MockHandler $mock;

    /**
     * Sets an API key, switches both directions on and injects the mocked HTTP client.
     *
     * @return void
     */
    private function configure(): void {
        set_config('googleapikey', \core\encryption::encrypt('g-secret'), 'mod_vrmakerspace');
        set_config('googletts', 1, 'mod_vrmakerspace');
        set_config('googlestt', 1, 'mod_vrmakerspace');
        set_config('googlevoice', '', 'mod_vrmakerspace');
        $this->mock = new MockHandler();
        \core\di::set(\core\http_client::class, new \core\http_client(['mock' => $this->mock]));
    }

    /**
     * Returns the JSON body of the last request.
     *
     * @return array
     */
    private function last_body(): array {
        return json_decode((string) $this->mock->getLastRequest()->getBody(), true);
    }

    /**
     * Each direction needs the API key and its own switch.
     *
     * @return void
     */
    public function test_can_speak_and_listen(): void {
        $this->resetAfterTest();
        $engine = new google();

        set_config('googleapikey', '', 'mod_vrmakerspace');
        set_config('googletts', 1, 'mod_vrmakerspace');
        set_config('googlestt', 1, 'mod_vrmakerspace');
        $this->assertFalse($engine->can_speak());
        $this->assertFalse($engine->can_listen());

        $this->configure();
        $this->assertTrue($engine->can_speak());
        $this->assertTrue($engine->can_listen());

        set_config('googletts', 0, 'mod_vrmakerspace');
        $this->assertFalse($engine->can_speak());
        $this->assertTrue($engine->can_listen());

        set_config('googlestt', 0, 'mod_vrmakerspace');
        $this->assertFalse($engine->can_listen());
    }

    /**
     * Text-to-speech sends the key header and JSON body, and decodes the base64 audio.
     *
     * @return void
     */
    public function test_synthesise_request(): void {
        $this->resetAfterTest();
        $this->configure();
        $reply = json_encode(['audioContent' => base64_encode('MP3BYTES')]);
        $this->mock->append(new Response(200, ['Content-Type' => 'application/json'], $reply));

        $result = (new google())->synthesise('Good morning.', 'en-GB', 'af_heart');

        $this->assertSame(['mimetype' => 'audio/mpeg', 'audio' => 'MP3BYTES'], $result);
        $request = $this->mock->getLastRequest();
        $this->assertSame('POST', $request->getMethod());
        $this->assertSame(google::TTS_URL, (string) $request->getUri());
        $this->assertSame('g-secret', $request->getHeaderLine('x-goog-api-key'));
        $this->assertSame('application/json', $request->getHeaderLine('Content-Type'));
        $this->assertSame([
            'input' => ['text' => 'Good morning.'],
            'voice' => ['languageCode' => 'en-GB'],
            'audioConfig' => ['audioEncoding' => 'MP3'],
        ], $this->last_body());
    }

    /**
     * A Google voice name is sent, with its own language; the site voice is used when the activity has none.
     *
     * @return void
     */
    public function test_synthesise_voice_name(): void {
        $this->resetAfterTest();
        $this->configure();
        $audio = json_encode(['audioContent' => base64_encode('MP3BYTES')]);
        $this->mock->append(new Response(200, [], $audio), new Response(200, [], $audio));

        (new google())->synthesise('Guten Tag.', 'en-GB', 'de-DE-Neural2-B');
        $this->assertSame(['languageCode' => 'de-DE', 'name' => 'de-DE-Neural2-B'], $this->last_body()['voice']);

        set_config('googlevoice', 'en-GB-Neural2-A', 'mod_vrmakerspace');
        (new google())->synthesise('Hello.', 'en-GB');
        $this->assertSame(['languageCode' => 'en-GB', 'name' => 'en-GB-Neural2-A'], $this->last_body()['voice']);
    }

    /**
     * A reply without usable audio is reported as error_speechfailed.
     *
     * @return void
     */
    public function test_synthesise_bad_reply(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(200, [], json_encode(['audioContent' => '!!! not base64 !!!'])));

        $this->expectException(\moodle_exception::class);
        $this->expectExceptionMessage(get_string('error_speechfailed', 'mod_vrmakerspace'));
        (new google())->synthesise('Hello.', 'en');
    }

    /**
     * A WAV recording is sent as LINEAR16 without a sample rate, and the transcripts of all results are joined.
     *
     * @return void
     */
    public function test_transcribe_wav(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'results' => [
                ['alternatives' => [['transcript' => ' Bonjour. ', 'confidence' => 0.9], ['transcript' => 'Bon jour']]],
                ['alternatives' => [['transcript' => 'Comment ça va ?']]],
                ['alternatives' => []],
            ],
        ])));

        $text = (new google())->transcribe('WAVBYTES', 'audio/wav', 'fr-CA');

        $this->assertSame('Bonjour. Comment ça va ?', $text);
        $request = $this->mock->getLastRequest();
        $this->assertSame(google::STT_URL, (string) $request->getUri());
        $this->assertSame('g-secret', $request->getHeaderLine('x-goog-api-key'));
        $this->assertSame([
            'config' => [
                'encoding' => 'LINEAR16',
                'languageCode' => 'fr-CA',
                'model' => 'latest_short',
                'enableAutomaticPunctuation' => true,
            ],
            'audio' => ['content' => base64_encode('WAVBYTES')],
        ], $this->last_body());
    }

    /**
     * A WebM recording is sent as WEBM_OPUS at 48 kHz; no results means nothing was said.
     *
     * @return void
     */
    public function test_transcribe_webm(): void {
        $this->resetAfterTest();
        $this->configure();
        $this->mock->append(new Response(200, ['Content-Type' => 'application/json'], '{}'));

        $text = (new google())->transcribe('WEBMBYTES', 'audio/webm', '');

        $this->assertSame('', $text);
        $config = $this->last_body()['config'];
        $this->assertSame('WEBM_OPUS', $config['encoding']);
        $this->assertSame(48000, $config['sampleRateHertz']);
        $this->assertSame('en-US', $config['languageCode']);
    }

    /**
     * A recording type Google is not given here is refused without any request.
     *
     * @return void
     */
    public function test_transcribe_refuses_mp4(): void {
        $this->resetAfterTest();
        $this->configure();

        try {
            (new google())->transcribe('MP4BYTES', 'audio/mp4', 'en');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        $this->assertNull($this->mock->getLastRequest());
    }

    #[\Override]
    protected function tearDown(): void {
        // Undo the \core\http_client DI override so it doesn't leak into other tests.
        \core\di::reset_container();
        parent::tearDown();
    }
}
