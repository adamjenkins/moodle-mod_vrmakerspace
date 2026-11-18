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
use mod_vrmakerspace\speech\engine;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Unit tests for the Ollama speech engine.
 *
 * Ollama is never contacted: a Guzzle mock handler is injected through the DI
 * container in place of \core\http_client.
 *
 * @package    mod_vrmakerspace
 * @category   test
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers     \mod_vrmakerspace\speech\engine\ollama
 * @covers     \mod_vrmakerspace\speech\engine
 */
#[CoversClass(ollama::class)]
#[CoversClass(engine::class)]
final class ollama_test extends advanced_testcase {
    /** @var MockHandler The mocked HTTP handler. */
    private MockHandler $mock;

    /**
     * Injects the mocked HTTP client.
     *
     * @return void
     */
    private function mock_http(): void {
        $this->mock = new MockHandler();
        \core\di::set(\core\http_client::class, new \core\http_client(['mock' => $this->mock]));
    }

    /**
     * Gives the engine its own server address and the default models.
     *
     * @return void
     */
    private function configure_url(): void {
        // No port: the site's cURL security allows only 80 and 443 by default, and it checks mocked requests too.
        set_config('ollamaurl', 'http://ollama.example.com', 'mod_vrmakerspace');
        unset_config('ollamattsmodel', 'mod_vrmakerspace');
        unset_config('ollamasttmodel', 'mod_vrmakerspace');
        set_config('ollamavoice', 'female', 'mod_vrmakerspace');
    }

    /**
     * Adds an Ollama provider instance to core_ai, stored the way core stores it.
     *
     * @param array $config The provider configuration
     * @param int $enabled Whether the provider is enabled
     * @return int The record id
     */
    private function add_ai_provider(array $config, int $enabled = 1): int {
        global $DB;
        return (int) $DB->insert_record('ai_providers', (object) [
            'name' => 'Ollama',
            // The class name, as \core_ai\provider::to_record() writes it.
            'provider' => 'aiprovider_ollama\\provider',
            'enabled' => $enabled,
            'config' => json_encode($config),
            'actionconfig' => '{}',
        ]);
    }

    /**
     * Builds a WAV file with the streaming placeholder sizes (0xFFFFFFFF) in its header.
     *
     * @param string $samples The sample bytes
     * @param string $extra Chunks to put between the fmt and data chunks
     * @return string
     */
    private static function streaming_wav(string $samples, string $extra = ''): string {
        return 'RIFF' . pack('V', 0xFFFFFFFF) . 'WAVE'
            . 'fmt ' . pack('V', 16) . pack('vvVVvv', 1, 1, 16000, 32000, 2, 16)
            . $extra
            . 'data' . pack('V', 0xFFFFFFFF) . $samples;
    }

    /**
     * Reads a little-endian 32-bit size from a string.
     *
     * @param string $bytes
     * @param int $offset
     * @return int
     */
    private static function size_at(string $bytes, int $offset): int {
        return unpack('V', substr($bytes, $offset, 4))[1];
    }

    /**
     * The engine's own address is used, with http:// added and a trailing /v1 removed.
     *
     * @return void
     */
    public function test_endpoint_from_setting(): void {
        $this->resetAfterTest();
        $engine = new ollama();

        set_config('ollamaurl', 'http://ollama.example.com:11434/v1/', 'mod_vrmakerspace');
        $this->assertSame(['http://ollama.example.com:11434', []], $engine->endpoint());

        set_config('ollamaurl', 'ollama.local:11434', 'mod_vrmakerspace');
        $this->assertSame(['http://ollama.local:11434', []], $engine->endpoint());

        set_config('ollamaurl', 'https://ollama.example.com/', 'mod_vrmakerspace');
        $this->assertSame(['https://ollama.example.com', []], $engine->endpoint());
    }

    /**
     * Without its own address, the first enabled core_ai Ollama provider is used, with its basic authentication.
     *
     * @return void
     */
    public function test_endpoint_from_ai_provider(): void {
        $this->resetAfterTest();
        set_config('ollamaurl', '', 'mod_vrmakerspace');
        // A disabled provider is ignored.
        $this->add_ai_provider(['endpoint' => 'http://disabled:11434'], 0);
        $this->add_ai_provider([
            'endpoint' => 'tardis:11434',
            'enablebasicauth' => 1,
            'username' => 'u',
            'password' => 'p',
        ]);
        $engine = new ollama();

        $this->assertSame(
            ['http://tardis:11434', ['Authorization' => 'Basic ' . base64_encode('u:p')]],
            $engine->endpoint()
        );
        $this->assertTrue($engine->can_speak());
        $this->assertTrue($engine->can_listen());

        // The engine's own address wins over the provider, and the provider's credentials are not sent to it.
        set_config('ollamaurl', 'http://ollama.example.com:11434', 'mod_vrmakerspace');
        $this->assertSame(['http://ollama.example.com:11434', []], $engine->endpoint());
    }

    /**
     * Without any address the engine can neither speak nor listen.
     *
     * @return void
     */
    public function test_no_endpoint(): void {
        global $DB;
        $this->resetAfterTest();
        set_config('ollamaurl', '', 'mod_vrmakerspace');
        $DB->delete_records('ai_providers');
        $engine = new ollama();

        $this->assertNull($engine->endpoint());
        $this->assertFalse($engine->can_speak());
        $this->assertFalse($engine->can_listen());

        // An address alone without a model is not enough either.
        set_config('ollamaurl', 'http://ollama.example.com:11434', 'mod_vrmakerspace');
        set_config('ollamattsmodel', '', 'mod_vrmakerspace');
        $this->assertFalse($engine->can_speak());
    }

    /**
     * Text-to-speech posts the OpenAI-style JSON request and returns the WAV with corrected sizes.
     *
     * @return void
     */
    public function test_synthesise_request(): void {
        $this->resetAfterTest();
        $this->configure_url();
        $this->mock_http();
        $wav = self::streaming_wav(str_repeat("\x01\x00", 50));
        $this->mock->append(new Response(200, ['Content-Type' => 'audio/wav'], $wav));

        $result = (new ollama())->synthesise('Good morning.', 'en-GB');

        $this->assertSame('audio/wav', $result['mimetype']);
        $this->assertSame(ollama::fix_wav($wav), $result['audio']);
        $this->assertSame(strlen($wav) - 8, self::size_at($result['audio'], 4));

        $request = $this->mock->getLastRequest();
        $this->assertSame('POST', $request->getMethod());
        $this->assertSame('http://ollama.example.com/v1/audio/speech', (string) $request->getUri());
        $this->assertSame('application/json', $request->getHeaderLine('Content-Type'));
        $this->assertFalse($request->hasHeader('Authorization'));
        $this->assertSame([
            'model' => 'lfm3-audio',
            'input' => 'Good morning.',
            'voice' => 'female-british-english',
            'response_format' => 'wav',
        ], json_decode((string) $request->getBody(), true));
    }

    /**
     * A server error is reported as error_speechfailed.
     *
     * @return void
     */
    public function test_synthesise_server_error(): void {
        $this->resetAfterTest();
        $this->configure_url();
        $this->mock_http();
        $this->mock->append(new Response(500, [], 'model not found'));

        try {
            (new ollama())->synthesise('Hello.', 'en');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        // The failing service reports its HTTP status to developers.
        $this->assertDebuggingCalled();
    }

    /**
     * The RIFF and data sizes of a streamed WAV are corrected, also when another chunk precedes the data.
     *
     * @return void
     */
    public function test_fix_wav(): void {
        $samples = str_repeat("\x10\x20", 100);

        $wav = self::streaming_wav($samples);
        $fixed = ollama::fix_wav($wav);
        $this->assertSame(strlen($wav), strlen($fixed));
        $this->assertSame(strlen($wav) - 8, self::size_at($fixed, 4));
        $this->assertSame(strlen($samples), self::size_at($fixed, 40));
        $this->assertSame($samples, substr($fixed, 44));

        $list = 'LIST' . pack('V', 4) . 'INFO';
        $wav = self::streaming_wav($samples, $list);
        $fixed = ollama::fix_wav($wav);
        $this->assertSame(strlen($wav) - 8, self::size_at($fixed, 4));
        $this->assertSame(strlen($samples), self::size_at($fixed, 40 + strlen($list)));

        // Anything that is not a WAV is returned unchanged.
        $this->assertSame('MP3BYTES', ollama::fix_wav('MP3BYTES'));
        $notwav = 'RIFF' . pack('V', 0xFFFFFFFF) . 'AVI ' . str_repeat("\0", 40);
        $this->assertSame($notwav, ollama::fix_wav($notwav));
    }

    /**
     * Cases for the voice mapping.
     *
     * @return array
     */
    public static function voice_provider(): array {
        return [
            'default voice, British English' => ['', 'en-GB', 'female-british-english'],
            'male, Canadian French'          => ['male', 'fr-CA', 'male-french'],
            'browser voice name'             => ['Google UK English Female', 'de', 'female-german'],
            'browser male voice name'        => ['Microsoft David - English (United States) Male', 'it', 'male-italian'],
            'full Ollama voice kept'         => ['male-italian', 'en-GB', 'male-italian'],
            'unknown language'               => ['male', 'xx', 'male'],
            'underscore tag'                 => ['', 'en_US', 'female-american-english'],
        ];
    }

    /**
     * The activity's voice name and the conversation language give the Ollama voice.
     *
     * @param string $voice The activity's voice name
     * @param string $language BCP 47 tag
     * @param string $expected The Ollama voice
     * @return void
     */
    #[DataProvider('voice_provider')]
    public function test_voice(string $voice, string $language, string $expected): void {
        $this->resetAfterTest();
        set_config('ollamavoice', 'female', 'mod_vrmakerspace');

        $this->assertSame($expected, (new ollama())->voice($voice, $language));
    }

    /**
     * The site's default voice decides the gender when the activity's voice name does not.
     *
     * @return void
     */
    public function test_voice_site_default(): void {
        $this->resetAfterTest();
        $engine = new ollama();

        set_config('ollamavoice', 'male', 'mod_vrmakerspace');
        $this->assertSame('male-spanish', $engine->voice('', 'es'));
        $this->assertSame('male-british-english', $engine->voice('Daniel', 'en-GB'));
        // A gender in the voice name wins over the default.
        $this->assertSame('female-spanish', $engine->voice('Mónica Female', 'es'));

        // A setting that is not a gender falls back to female.
        set_config('ollamavoice', 'robot', 'mod_vrmakerspace');
        $this->assertSame('female', $engine->voice('', 'xx'));
    }

    /**
     * Only WAV is transcribed: a WebM recording is refused without any request.
     *
     * @return void
     */
    public function test_transcribe_refuses_webm(): void {
        $this->resetAfterTest();
        $this->configure_url();
        $this->mock_http();
        $engine = new ollama();

        $this->assertSame(['audio/wav'], $engine->accepted_types());
        try {
            $engine->transcribe('WEBMBYTES', 'audio/webm', 'en-GB');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        $this->assertNull($this->mock->getLastRequest());
    }

    /**
     * A WAV recording is sent as multipart with the model and the primary language.
     *
     * @return void
     */
    public function test_transcribe_request(): void {
        $this->resetAfterTest();
        $this->configure_url();
        $this->mock_http();
        $this->mock->append(new Response(200, ['Content-Type' => 'application/json'], json_encode(['text' => ' Bonjour. '])));

        $text = (new ollama())->transcribe('WAVBYTES', 'audio/wav', 'fr-CA');

        $this->assertSame('Bonjour.', $text);
        $request = $this->mock->getLastRequest();
        $this->assertSame('POST', $request->getMethod());
        $this->assertSame('http://ollama.example.com/v1/audio/transcriptions', (string) $request->getUri());
        $this->assertStringStartsWith('multipart/form-data', $request->getHeaderLine('Content-Type'));
        $body = (string) $request->getBody();
        $this->assertStringContainsString('filename="speech.wav"', $body);
        $this->assertStringContainsString('WAVBYTES', $body);
        $this->assertMatchesRegularExpression('/name="model"\r\n(?:[^\r\n]+\r\n)*\r\nlfm3-audio\r\n/', $body);
        $this->assertMatchesRegularExpression('/name="language"\r\n(?:[^\r\n]+\r\n)*\r\nfr\r\n/', $body);
        $this->assertMatchesRegularExpression('/name="response_format"\r\n(?:[^\r\n]+\r\n)*\r\njson\r\n/', $body);
    }

    /**
     * A transcription that is not HTTP 200 is reported as error_speechfailed.
     *
     * @return void
     */
    public function test_transcribe_server_error(): void {
        $this->resetAfterTest();
        $this->configure_url();
        $this->mock_http();
        $this->mock->append(new Response(400, [], '{"error":"unsupported audio"}'));

        try {
            (new ollama())->transcribe('WAVBYTES', 'audio/wav', 'en');
            $this->fail('Expected error_speechfailed');
        } catch (\moodle_exception $e) {
            $this->assertSame('error_speechfailed', $e->errorcode);
        }
        // The failing service reports its HTTP status to developers.
        $this->assertDebuggingCalled();
    }

    #[\Override]
    protected function tearDown(): void {
        // Undo the \core\http_client DI override so it doesn't leak into other tests.
        \core\di::reset_container();
        parent::tearDown();
    }
}
