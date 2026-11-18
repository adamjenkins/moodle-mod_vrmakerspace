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
 * The tutor's ears and voice (TUTORIAL-VOICE-CONTRACT.md §4): push to talk, and speaking a tour step or an answer.
 *
 * The site sets an order of ways to listen and to speak (config.tutorial.voice.listen / speak, each a list of
 * 'server' and 'browser' as \mod_vrmakerspace\speech\registry::client_order() makes it). The first way this
 * browser can use is taken; when it fails, the next one is used, for this and later questions. The order and
 * fallback logic is taken from mod_talkwithai/conversation (same author): detect(), nextWay(), makeListener() and
 * fallbackSpeaker().
 *
 * - Listening, 'server': the microphone is recorded as WAV (speech/serverstt) and sent to
 *   mod_vrmakerspace_tutor_transcribe; 'browser': the browser's own recogniser (speech/browserstt), on the device
 *   where it can, else (with the site's leave and the student's consent) the browser maker's cloud service.
 * - Speaking, 'server': audio from mod_vrmakerspace_tutor_speak (speech/servertts), played through an analyser
 *   (the tutor's mouth) and a PannerNode (the voice comes from where the tutor is); 'browser': speechSynthesis
 *   (speech/browsertts), which cannot be placed in space.
 *
 * The audio graph lives on the voice's own AudioContext, made in the first user gesture that needs it (or taken
 * from options.audioContext). resume() is called but never waited for: with no audio output device it can stay
 * pending for ever. Browser gotchas kept from mod_talkwithai: Firefox has AudioWorklet only in secure contexts
 * (speech/wavrecorder then uses a ScriptProcessor) and no SpeechRecognition at all (the browser way is then not
 * offered); speechSynthesis can accept an utterance and never speak (a 2.5 s watchdog, then the next way);
 * Firefox's AudioListener has no positionX/forwardX parameters (setPosition/setOrientation are used there).
 * Every speech gets a run number, and a voice that started for a run that was stopped is dropped (the generation
 * counter of Amica, Semper AI and pixiv, MIT, as mod_talkwithai/conversation uses it).
 *
 * @module     mod_vrmakerspace/tutorvoice
 * @copyright  2023 Semper AI, pixiv Inc.
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import Log from 'core/log';
import Notification from 'core/notification';
import {setUserPreference} from 'core_user/repository';
import {BrowserSpeaker} from 'mod_vrmakerspace/speech/browsertts';
import {ServerSpeaker} from 'mod_vrmakerspace/speech/servertts';
import {BrowserListener} from 'mod_vrmakerspace/speech/browserstt';
import {ServerListener} from 'mod_vrmakerspace/speech/serverstt';
import {Vad} from 'mod_vrmakerspace/speech/vad';
import {split} from 'mod_vrmakerspace/speech/textsplit';

/** Trailing silence kept when the detector ended a tapped question, in ms. */
const KEEP_SILENCE = 300;

/** The user preference that records the consent to the browser's cloud speech recognition. */
const CONSENT_PREFERENCE = 'mod_vrmakerspace_speechconsent';

/**
 * An error with a code the tour turns into a message.
 *
 * @param {string} code 'nolisten', 'micdenied', 'listenfailed', 'consent', 'busy'
 * @returns {Error}
 */
const failure = (code) => {
    const error = new Error(code);
    error.code = code;
    return error;
};

/**
 * Names the company whose servers the browser's speech recognition uses.
 *
 * @returns {string}
 */
const cloudVendor = () => {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) {
        return 'Microsoft';
    }
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) {
        return 'Apple';
    }
    return 'Google';
};

/**
 * Put values into a string fetched without them ({$a}).
 *
 * @param {string} template
 * @param {string} a
 * @returns {string}
 */
const fill = (template, a) => String(template || '').split('{$a}').join(a);

/**
 * Set an AudioParam, or call the old setter where the browser has no such parameter (Firefox's listener).
 *
 * @param {Object} node PannerNode or AudioListener.
 * @param {string[]} params Parameter names, e.g. ['positionX', 'positionY', 'positionZ'].
 * @param {string} setter Old setter name, e.g. 'setPosition'.
 * @param {number[]} values Values.
 */
const setParams = (node, params, setter, values) => {
    if (node[params[0]]) {
        params.forEach((name, i) => {
            node[name].value = values[i];
        });
    } else if (typeof node[setter] === 'function') {
        node[setter](...values);
    }
};

/**
 * Create the tutor's voice.
 *
 * @param {Object} options
 * @param {number} options.cmid
 * @param {Object} options.config config.tutorial.voice: {listen: string[], speak: string[], language, voicename,
 *     browserstt, cloudconsent}
 * @param {Object} [options.strings] tutorvoice_speechconsent, tutorvoice_speechconsent_title, tutorvoice_speechconsent_accept
 * @param {AudioContext|Function} [options.audioContext] A context to use, or a function giving one (or null)
 * @param {Function} [options.inVr] Says whether VR runs (no dialogue can be shown there)
 * @returns {Object}
 */
export const createTutorVoice = (options) => {
    const cmid = Number(options.cmid) || 0;
    const config = options.config || {};
    const strings = options.strings || {};
    const lang = String(config.language || document.documentElement.lang || 'en');
    const inVr = typeof options.inVr === 'function' ? options.inVr : () => false;
    let ctx = null;
    let owncontext = false;
    let panner = null;
    let stream = null;
    let vad = null;
    let listener = null;
    let speaker = null;
    let session = null;
    let settingup = null;
    let wantstop = false;
    let wantauto = false;
    let speakrun = 0;
    let consented = !!config.cloudconsent;
    let disposed = false;

    /**
     * Works out what the browser and site can do (mod_talkwithai's detect()).
     *
     * @returns {Object} {secure, media, listen, speak, listens, speaks}
     */
    const detect = () => {
        const secure = !!window.isSecureContext;
        const media = secure && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
        const canlisten = {
            server: media && ServerListener.supported(),
            browser: secure && BrowserListener.supported(),
        };
        const canspeak = {
            server: !!window.AudioContext,
            browser: BrowserSpeaker.supported(),
        };
        // The site's order of preference, without what this browser cannot do; the rest are fallbacks.
        const listens = (Array.isArray(config.listen) ? config.listen : []).filter(way => canlisten[way]);
        const speaks = (Array.isArray(config.speak) ? config.speak : []).filter(way => canspeak[way]);
        return {secure, media, listen: listens[0] || null, speak: speaks[0] || null, listens, speaks};
    };

    const c = detect();

    /**
     * Moves on to the next way of listening or speaking in the site's order (mod_talkwithai's nextWay()).
     *
     * @param {string} kind listen or speak
     * @returns {string|null} The new way, or null when there is none left
     */
    const nextWay = (kind) => {
        const ways = c[kind + 's'];
        const next = ways[ways.indexOf(c[kind]) + 1] || null;
        c[kind] = next;
        return next;
    };

    /**
     * The audio context, made now if there is none (call it in a user gesture). resume() is never waited for.
     *
     * @returns {AudioContext|null}
     */
    const context = () => {
        if (!ctx) {
            let given = options.audioContext;
            try {
                given = typeof given === 'function' ? given() : given;
            } catch (e) {
                given = null;
            }
            if (given) {
                ctx = given;
            } else if (window.AudioContext) {
                ctx = new window.AudioContext();
                owncontext = true;
            }
        }
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => null);
        }
        return ctx;
    };

    /**
     * The panner the server voice goes through, made with the context.
     *
     * @returns {PannerNode|null}
     */
    const output = () => {
        if (!panner && context()) {
            panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 1;
            panner.maxDistance = 50;
            panner.rolloffFactor = 0.6;
            panner.connect(ctx.destination);
        }
        return panner;
    };

    // Listening.

    /**
     * Asks once for consent before the browser sends the student's voice to its maker's servers.
     *
     * @returns {Promise<boolean>}
     */
    const consent = async() => {
        if (consented) {
            return true;
        }
        if (inVr()) {
            // No dialogue can be seen in VR: the student agrees on the desktop first.
            throw failure('consent');
        }
        try {
            await Notification.saveCancelPromise(
                strings.tutorvoice_speechconsent_title || '',
                fill(strings.tutorvoice_speechconsent, cloudVendor()),
                strings.tutorvoice_speechconsent_accept || ''
            );
        } catch (e) {
            return false;
        }
        consented = true;
        setUserPreference(CONSENT_PREFERENCE, 1).catch(() => null);
        return true;
    };

    /**
     * Opens the microphone (and the level detector on it) for the server way.
     *
     * @returns {Promise<void>}
     */
    const openMic = async() => {
        if (stream) {
            return;
        }
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
            });
        } catch (e) {
            c.listen = null;
            throw failure('micdenied');
        }
        if (ctx) {
            vad = new Vad(ctx, stream, {
                onend: () => {
                    if (session && session.auto) {
                        stopListening();
                    }
                },
                onlevel: (level) => {
                    if (session && session.onlevel) {
                        session.onlevel(level);
                    }
                },
            });
        }
    };

    /**
     * What the browser recogniser does on an error.
     *
     * @param {string} code
     */
    const browserError = (code) => {
        if (code === 'not-allowed') {
            c.listen = null;
            endSession(null, failure('micdenied'));
        } else if (code === 'service-not-allowed' || code === 'network' || code === 'stopped') {
            listenFailed();
            endSession(null, failure('listenfailed'));
        }
    };

    /**
     * Tries to make a listener for one way.
     *
     * @param {string} way 'server' or 'browser'
     * @returns {Promise<Object|null>}
     */
    const listenerFor = async(way) => {
        if (way === 'server') {
            await openMic();
            const made = new ServerListener({audioctx: ctx, stream: stream, cmid: cmid, lang: lang});
            await made.init();
            return made;
        }
        const local = (await BrowserListener.local(lang)) === 'available';
        // Cloud recognition only where the site allows it, and the student agrees.
        if (local || (config.browserstt && await consent())) {
            return new BrowserListener({
                lang: lang,
                local: local,
                ontext: (text, final) => {
                    if (session && session.oninterim) {
                        session.oninterim(text, final);
                    }
                    if (final && session && session.auto) {
                        stopListening();
                    }
                },
                onerror: browserError,
            });
        }
        return null;
    };

    /**
     * Creates the listener for the first way of listening that can work, in the site's order
     * (mod_talkwithai's makeListener()).
     *
     * @returns {Promise<boolean>} false when no way is left
     */
    const makeListener = async() => {
        while (c.listen) {
            try {
                listener = await listenerFor(c.listen);
                if (listener) {
                    return true;
                }
            } catch (e) {
                if (e && (e.code === 'micdenied' || e.code === 'consent')) {
                    throw e;
                }
                Log.debug(e);
            }
            nextWay('listen');
        }
        return false;
    };

    /**
     * The current way of listening failed: the next question uses the next way, if there is one.
     */
    const listenFailed = () => {
        if (listener) {
            listener.destroy();
        }
        listener = null;
        nextWay('listen');
    };

    /**
     * Ends the current question: with the text heard, or with an error.
     *
     * @param {string|null} text
     * @param {Error} [error]
     */
    const endSession = (text, error) => {
        const s = session;
        session = null;
        if (vad) {
            vad.setEcho(false);
        }
        if (!s) {
            return;
        }
        if (error) {
            s.reject(error);
        } else {
            s.resolve(String(text || ''));
        }
    };

    /**
     * Gets the listener ready (the microphone, the way), once.
     *
     * @returns {Promise<void>}
     */
    const ready = () => {
        if (listener) {
            return Promise.resolve();
        }
        if (!settingup) {
            context();
            settingup = makeListener().then((made) => {
                settingup = null;
                if (!made) {
                    throw failure('nolisten');
                }
                return null;
            }, (error) => {
                settingup = null;
                throw error;
            });
        }
        return settingup;
    };

    /**
     * Starts the recording or recognition of a question.
     *
     * @param {Object} s The session.
     */
    const begin = (s) => {
        session = s;
        if (listener instanceof ServerListener) {
            if (vad) {
                vad.reset();
            }
            listener.begin(() => {
                stopListening();
            });
        } else {
            listener.start();
        }
    };

    /**
     * Listens to a question: until stopListening(), or (auto) until the student stops speaking.
     *
     * @param {Object} [opts] {auto: end by itself after a pause, onlevel(level 0..1), oninterim(text, final)}
     * @returns {Promise<string>} The text heard ('' for nothing); rejects with an Error whose code says why
     */
    const listen = (opts = {}) => {
        if (disposed || !c.listen) {
            return Promise.reject(failure('nolisten'));
        }
        if (session || settingup) {
            return Promise.reject(failure('busy'));
        }
        stop();
        wantstop = false;
        wantauto = !!opts.auto;
        return ready().then(() => new Promise((resolve, reject) => {
            if (disposed || !listener) {
                reject(failure('nolisten'));
                return;
            }
            begin({resolve, reject, auto: wantauto, onlevel: opts.onlevel, oninterim: opts.oninterim});
            if (wantstop) {
                // The button was let go while the microphone was being opened.
                stopListening();
            }
        }));
    };

    /**
     * Ends the question and sends it (the button was let go).
     */
    const stopListening = () => {
        if (!session) {
            wantstop = !!settingup;
            return;
        }
        const s = session;
        // The session stays until its text is in, so a new press waits for it.
        let finishing;
        if (listener instanceof ServerListener) {
            const trim = s.auto && vad ? Math.max(0, vad.redemption - KEEP_SILENCE) : 0;
            finishing = listener.finish(trim).catch((error) => {
                Log.debug(error);
                listenFailed();
                throw failure('listenfailed');
            });
        } else {
            finishing = listener.finish();
        }
        finishing.then((text) => {
            if (session === s) {
                endSession(text);
            }
            return text;
        }).catch((error) => {
            if (session === s) {
                endSession(null, error);
            }
        });
    };

    /**
     * Drops the question being listened to, without sending it.
     */
    const cancelListening = () => {
        wantstop = !!settingup;
        if (!session) {
            return;
        }
        if (listener instanceof ServerListener) {
            listener.discard();
        } else if (listener) {
            listener.stop();
        }
        endSession('');
    };

    /**
     * Closes the microphone (the tour closed); the next question opens it again.
     */
    const release = () => {
        cancelListening();
        if (listener) {
            listener.destroy();
            listener = null;
        }
        if (vad) {
            vad.destroy();
            vad = null;
        }
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            stream = null;
        }
    };

    // Speaking.

    /**
     * Creates the voice for the first way of speaking that can work, from the current one on in the site's order.
     *
     * @returns {Promise<void>}
     */
    const setupSpeaker = async() => {
        speaker = null;
        while (c.speak) {
            try {
                if (c.speak === 'server' && output()) {
                    speaker = new ServerSpeaker({audioctx: ctx, cmid: cmid, output: panner});
                } else if (c.speak === 'browser') {
                    speaker = new BrowserSpeaker({lang: lang, voice: config.voicename || ''});
                }
                if (speaker) {
                    await speaker.init();
                    return;
                }
            } catch (e) {
                Log.debug(e);
                speaker = null;
            }
            nextWay('speak');
        }
    };

    /**
     * Replaces the voice with the next way of speaking in the site's order (mod_talkwithai's fallbackSpeaker()).
     *
     * @returns {Promise<boolean>} false when there is none left
     */
    const fallbackSpeaker = async() => {
        if (!nextWay('speak')) {
            return false;
        }
        if (speaker) {
            speaker.destroy();
        }
        speaker = null;
        await setupSpeaker();
        return !!speaker;
    };

    /**
     * Speaks with the current voice.
     *
     * @param {Object} source {step, text, first}
     * @param {Function} onchunk Called with each chunk's index as it starts
     * @param {Object|null|boolean} first The first chunk's audio, false when the server could not make it
     * @returns {Promise<boolean>}
     */
    const speakWith = (source, onchunk, first) => {
        if (speaker instanceof ServerSpeaker) {
            if (first === false) {
                return Promise.reject(new Error('nospeech'));
            }
            return speaker.speak(source.step || '', {onchunk: onchunk}, first || null);
        }
        return speaker.speak(split(source.text || ''), {onchunk: onchunk});
    };

    /**
     * Speaks a tour step or the latest answer of the AI.
     *
     * @param {Object} source {step: a step key ('' for the latest answer), text: the same as plain text (the
     *     browser voice speaks it), first: the answer's first audio chunk {audio, mimetype, chunks} when it came
     *     with the answer, false when the server was asked for it and had none}
     * @param {Object} [handlers] {onstart(): the voice started}
     * @returns {Promise<boolean>} true when all was spoken, false when stopped or not possible; never rejects
     */
    const speak = async(source, handlers = {}) => {
        stop();
        if (disposed || !c.speak) {
            return false;
        }
        const run = ++speakrun;
        let told = false;
        /**
         * Called as each chunk starts: the first one tells the caller the voice has begun.
         *
         * @param {number} index The chunk's index.
         */
        const onchunk = (index) => {
            if (index === 0 && !told && run === speakrun) {
                told = true;
                if (vad) {
                    vad.setEcho(true);
                }
                if (handlers.onstart) {
                    handlers.onstart();
                }
            }
        };
        try {
            if (!speaker) {
                await setupSpeaker();
            }
            if (!speaker || run !== speakrun) {
                return false;
            }
            return await speakWith(source, onchunk, source.first);
        } catch (e) {
            Log.debug(e);
            // Switch to the next way of speaking in the site's order, for this and later texts.
            if (run === speakrun && await fallbackSpeaker() && run === speakrun) {
                return speakWith(source, onchunk, null).catch(() => false);
            }
            return false;
        } finally {
            if (vad && run === speakrun) {
                vad.setEcho(false);
            }
        }
    };

    /**
     * Stops speaking.
     */
    const stop = () => {
        speakrun++;
        if (speaker) {
            speaker.cancel();
        }
    };

    /**
     * Puts the voice where the tutor is (world coordinates).
     *
     * @param {Object} position {x, y, z}
     */
    const setPosition = (position) => {
        if (panner && position) {
            setParams(panner, ['positionX', 'positionY', 'positionZ'], 'setPosition',
                [Number(position.x) || 0, Number(position.y) || 0, Number(position.z) || 0]);
        }
    };

    /**
     * Puts the listener where the camera is, facing where it faces.
     *
     * @param {Object} camera A three.js camera (its matrixWorld is read).
     */
    const setListener = (camera) => {
        if (!ctx || !panner || !camera || !camera.matrixWorld) {
            return;
        }
        const e = camera.matrixWorld.elements;
        const forward = [-e[8], -e[9], -e[10]];
        const up = [e[4], e[5], e[6]];
        const l = ctx.listener;
        if (l.positionX) {
            setParams(l, ['positionX', 'positionY', 'positionZ'], 'setPosition', [e[12], e[13], e[14]]);
            setParams(l, ['forwardX', 'forwardY', 'forwardZ'], 'setOrientation', forward);
            setParams(l, ['upX', 'upY', 'upZ'], 'setOrientation', up);
        } else if (typeof l.setPosition === 'function') {
            l.setPosition(e[12], e[13], e[14]);
            l.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
        }
    };

    /**
     * Stops everything and lets go of the microphone and the audio context.
     */
    const dispose = () => {
        if (disposed) {
            return;
        }
        stop();
        release();
        disposed = true;
        if (speaker) {
            speaker.destroy();
            speaker = null;
        }
        if (panner) {
            try {
                panner.disconnect();
            } catch (e) {
                // Already disconnected.
            }
            panner = null;
        }
        if (ctx && owncontext && typeof ctx.close === 'function') {
            ctx.close().catch(() => null);
        }
        ctx = null;
    };

    return {
        listen: listen,
        stopListening: stopListening,

        /**
         * Lets the question being listened to end by itself when the student pauses (Talk was only tapped).
         *
         * @param {boolean} on
         */
        setAuto: (on) => {
            wantauto = !!on;
            if (session) {
                session.auto = wantauto;
            }
        },
        cancelListening: cancelListening,
        release: release,
        speak: speak,
        stop: stop,
        setPosition: setPosition,
        setListener: setListener,
        dispose: dispose,

        /** @returns {boolean} Whether there is a way to listen left. */
        canListen: () => !!c.listen,

        /** @returns {boolean} Whether there is a way to speak left. */
        canSpeak: () => !!c.speak,

        /** @returns {boolean} Whether answers should come with their first audio chunk (the server speaks first). */
        speaksOnServer: () => c.speak === 'server',

        /** @returns {boolean} Whether a question is being listened to (or the microphone being opened for it). */
        get listening() {
            return !!session || !!settingup;
        },

        /** @returns {boolean} Whether something is being spoken. */
        get speaking() {
            return !!speaker && speaker.isSpeaking();
        },

        /**
         * How loud the voice is now, 0..1, for the tutor's mouth.
         *
         * @returns {number}
         */
        level: () => (speaker ? speaker.loudness() : 0),

        /** @returns {AnalyserNode|null} The analyser on the server voice. */
        get analyser() {
            return speaker instanceof ServerSpeaker ? speaker.analyser : null;
        },

        /** @returns {PannerNode|null} The panner the server voice goes through. */
        get panner() {
            return panner;
        },
    };
};
