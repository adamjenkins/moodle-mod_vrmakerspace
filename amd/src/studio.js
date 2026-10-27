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
 * The sculpting studio page (studio.php, templates/studio.mustache): puts together the 3D view, the
 * sculpting engine, the session (on one's own, with a partner or over the companion service), the
 * tools, mouse and keyboard input, VR, the other sculptors' presence and the toolbar.
 *
 * The WebGL check, the renderer set-up, the resize handling and the THREE.Timer frame loop follow
 * vrroomruntime_builtin/viewer.
 *
 * @module     mod_vrsculpt/studio
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import * as THREE from 'vrroomruntime_builtin/three';
import Log from 'core/log';
import Pending from 'core/pending';
import {getString, getStrings} from 'core/str';
import {createEngineClient} from 'mod_vrsculpt/engineclient';
import {createTools} from 'mod_vrsculpt/tools';
import {attach as attachDesktop} from 'mod_vrsculpt/desktopinput';
import {createToolbar} from 'mod_vrsculpt/toolbar';
import {createPresence} from 'mod_vrsculpt/presence';
import {createXrSculpt} from 'mod_vrsculpt/xrsculpt';
import {createSession} from 'mod_vrsculpt/net/session';

/** Every string of the studio and the modules it hands its strings to (contract §9). */
const STRING_KEYS = [
    'studio_loading', 'studio_nowebgl', 'studio_readonly', 'studio_failed', 'tools', 'tool_grab', 'tool_twist',
    'tool_add', 'tool_carve', 'tool_smooth', 'brushsize', 'brushstrength', 'undo', 'redo', 'savenow',
    'savedversion', 'saving', 'savefailed', 'export', 'export_stl', 'export_glb', 'export_3mf', 'exportreport',
    'exportwatertight', 'exportproblems', 'entervr', 'exitvr', 'status_solo', 'status_connecting',
    'status_connected', 'status_waiting', 'status_reconnecting', 'status_resyncing', 'status_full',
    'status_failed', 'status_companionmissing', 'status_closed', 'lockedbyother', 'peerjoined', 'peerleft',
    'shortcuts', 'vrhelp', 'fullscreen', 'back',
];

/** Height of the sculpture's centre above the floor in the desktop view (m). */
const SCULPTURE_HEIGHT = 1.0;

/** Height of the pedestal top (m): just under the lowest the grid reaches. */
const PEDESTAL_TOP = 0.74;

/** Vertical field of view of the desktop camera (degrees). */
const FOV = 50;

/** Highest device pixel ratio rendered (keeps phones and big screens fast). */
const MAX_PIXEL_RATIO = 1.5;

/** Presence poses are sent at most this often (ms): 15 a second. */
const POSE_INTERVAL = 67;

/** How long passing messages (someone joined, a region is locked) stay (ms). */
const MESSAGE_TIME = 5000;

/** File types of the exports. */
const EXPORTS = {
    stl: {type: 'model/stl', extension: 'stl'},
    glb: {type: 'model/gltf-binary', extension: 'glb'},
    '3mf': {type: 'model/3mf', extension: '3mf'},
};

/**
 * Whether the browser can render WebGL.
 *
 * @returns {boolean}
 */
const isWebGLAvailable = () => {
    try {
        if (!window.WebGLRenderingContext) {
            return false;
        }
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) {
            return false;
        }
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) {
            lose.loseContext();
        }
        return true;
    } catch (e) {
        return false;
    }
};

/**
 * Put values into a string fetched without them ({$a} or {$a->name}).
 *
 * @param {string} template The string.
 * @param {*} a A value, or an object of values.
 * @returns {string}
 */
export const fill = (template, a) => {
    let text = String(template || '');
    if (a !== null && typeof a === 'object') {
        text = text.replace(/\{\$a->([A-Za-z0-9_]+)\}/g, (match, name) => (a[name] !== undefined ? String(a[name]) : match));
    } else if (a !== undefined) {
        text = text.split('{$a}').join(String(a));
    }
    return text;
};

/**
 * A file name from the activity name.
 *
 * @param {string} title Activity name.
 * @param {string} extension File extension.
 * @returns {string}
 */
const fileName = (title, extension) => {
    // Control characters and the characters no file system accepts become underscores.
    const safe = Array.from(String(title || '')).map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '_' : c))
        .join('');
    const base = safe.replace(/\s+/g, ' ').trim().slice(0, 100) || 'sculpture';
    return `${base}.${extension}`;
};

/**
 * Hand the browser a file to save.
 *
 * @param {Uint8Array} bytes File content.
 * @param {string} type MIME type.
 * @param {string} name File name.
 */
const download = (bytes, type, name) => {
    const blob = new Blob([bytes], {type: type});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.classList.add('d-none');
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
};

/**
 * The export validation report as one line.
 *
 * @param {Object} strings Strings by key.
 * @param {Object} report {triangles, boundaryedges, nonmanifoldedges, flippededges, watertight, sizemm}
 * @returns {string}
 */
const reportText = (strings, report) => {
    const sizes = Array.isArray(report.sizemm) ? report.sizemm : [];
    const size = sizes.map((v) => (Number(v) || 0).toFixed(1)).join(' × ');
    const open = (Number(report.boundaryedges) || 0) + (Number(report.nonmanifoldedges) || 0)
        + (Number(report.flippededges) || 0);
    const status = report.watertight ? strings.exportwatertight : fill(strings.exportproblems, open);
    return fill(strings.exportreport, {triangles: Number(report.triangles) || 0, size: size, status: status});
};

/**
 * Show the Enter VR button once the browser says whether VR is available.
 *
 * @param {Object} xr The XR controller (createXrSculpt).
 * @param {Object} toolbar The toolbar.
 * @param {Function} isStopped Returns true once the studio has stopped.
 */
const watchVr = (xr, toolbar, isStopped) => {
    Promise.resolve(xr.available).then((available) => {
        toolbar.setVr(!!available && !isStopped(), false);
        return available;
    }).catch((error) => Log.debug(error));
};

/**
 * Show why the studio could not start.
 *
 * @param {HTMLElement} root Studio root.
 * @param {Object} strings Strings by key (may be empty when they could not be loaded).
 * @param {*} error The error.
 */
const showFailure = (root, strings, error) => {
    Log.debug(error);
    const message = error && error.message ? error.message : String(error);
    const failed = root.querySelector('[data-region="failed"]');
    const loading = root.querySelector('[data-region="loading"]');
    if (loading) {
        loading.classList.add('d-none');
    }
    if (failed) {
        failed.textContent = strings.studio_failed ? fill(strings.studio_failed, message) : message;
        failed.classList.remove('d-none');
    }
};

/**
 * Build the 3D view: renderer, camera, lights, floor, pedestal and the sculpture group.
 *
 * @param {HTMLCanvasElement} canvas The canvas.
 * @returns {Object} {renderer, scene, camera, sculptureRoot, material, dispose()}
 */
const buildView = (canvas) => {
    const renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.xr.enabled = true;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc9ccd1);
    const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.01, 50);
    camera.position.set(0, SCULPTURE_HEIGHT + 0.12, 0.62);
    camera.lookAt(0, SCULPTURE_HEIGHT, 0);
    scene.add(camera);

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x5a5f66, 1.4);
    scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(1.2, 2.6, 1.6);
    scene.add(sun);
    const filllight = new THREE.DirectionalLight(0xdfe6ff, 0.5);
    filllight.position.set(-1.5, 1.2, -1);
    scene.add(filllight);

    const floormaterial = new THREE.MeshStandardMaterial({color: 0x9aa0a6, roughness: 1, metalness: 0});
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), floormaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.name = 'vrsculpt-floor';
    scene.add(floor);
    const pedestalmaterial = new THREE.MeshStandardMaterial({color: 0xe8e6e1, roughness: 0.7, metalness: 0});
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, PEDESTAL_TOP, 48), pedestalmaterial);
    pedestal.position.set(0, PEDESTAL_TOP / 2, 0);
    pedestal.name = 'vrsculpt-pedestal';
    scene.add(pedestal);

    const sculptureRoot = new THREE.Group();
    sculptureRoot.name = 'vrsculpt-sculpture';
    sculptureRoot.position.set(0, SCULPTURE_HEIGHT, 0);
    scene.add(sculptureRoot);
    const material = new THREE.MeshStandardMaterial({color: 0xc08a64, roughness: 0.82, metalness: 0});

    return {
        renderer, scene, camera, sculptureRoot, material,

        /** Free the GPU resources of the view. */
        dispose: () => {
            floor.geometry.dispose();
            floormaterial.dispose();
            pedestal.geometry.dispose();
            pedestalmaterial.dispose();
            material.dispose();
            renderer.dispose();
        },
    };
};

/**
 * Write the camera's pose in the sculpture's frame into an array.
 *
 * @param {Object} camera THREE.Camera.
 * @param {Object} sculptureRoot THREE.Group.
 * @param {Object} work {inverse: Matrix4, matrix: Matrix4, position: Vector3, quaternion: Quaternion, scale: Vector3}
 * @param {number[]} out [x, y, z, qx, qy, qz, qw]
 * @returns {number[]} out
 */
const cameraPose = (camera, sculptureRoot, work, out) => {
    work.inverse.copy(sculptureRoot.matrixWorld).invert();
    work.matrix.multiplyMatrices(work.inverse, camera.matrixWorld);
    work.matrix.decompose(work.position, work.quaternion, work.scale);
    out[0] = work.position.x;
    out[1] = work.position.y;
    out[2] = work.position.z;
    out[3] = work.quaternion.x;
    out[4] = work.quaternion.y;
    out[5] = work.quaternion.z;
    out[6] = work.quaternion.w;
    return out;
};

/**
 * Run the studio once the strings are loaded.
 *
 * @param {HTMLElement} root Studio root.
 * @param {Object} config Page config from studio.php.
 * @param {Object} strings Strings by key.
 * @param {Object} extra Strings that are not required (by key; missing ones are absent).
 * @returns {Promise<Object|null>} {stop()} or null without WebGL.
 */
const run = (root, config, strings, extra) => {
    const stage = root.querySelector('[data-region="stage"]');
    const canvas = root.querySelector('[data-region="canvas"]');
    const loading = root.querySelector('[data-region="loading"]');
    const readonly = !!config.readonly || config.mode === 'view' || root.dataset.readonly === '1';
    const title = config.title || root.dataset.title || '';

    if (!isWebGLAvailable() || !canvas) {
        const nowebgl = root.querySelector('[data-region="nowebgl"]');
        if (nowebgl) {
            nowebgl.classList.remove('d-none');
        }
        [stage, root.querySelector('[data-region="toolbar"]')].forEach((element) => {
            if (element) {
                element.classList.add('d-none');
            }
        });
        return Promise.resolve(null);
    }

    const view = buildView(canvas);
    const {renderer, scene, camera, sculptureRoot, material} = view;
    const engine = createEngineClient(config.workerurl, THREE, sculptureRoot, material);
    const presence = createPresence(THREE, sculptureRoot);
    const names = new Map();
    let tools = null;
    let desktop = null;
    let xr = null;
    let stopped = false;
    let started = false;
    let fullwindow = false;

    // Toolbar first (tools come once the session runs), so status changes show from the start.
    const toolbar = createToolbar(root, {
        strings: strings,
        tools: null,
        handlers: {
            save: () => saveNow(),
            exportModel: (format) => exportModel(format),
            vr: () => toggleVr(),
            fullscreen: () => toggleFullscreen(),
        },
    });
    toolbar.setSaveAllowed(!readonly);

    const session = createSession(Object.assign({}, config, {
        mode: readonly ? 'view' : config.mode,
        readonly: readonly,
        engine: engine,
        strings: strings,
    }));

    /**
     * Save now (the toolbar's button).
     *
     * @returns {Promise}
     */
    const saveNow = () => {
        toolbar.setSaving(true);
        toolbar.message(strings.saving);
        return Promise.resolve(session.saveNow()).then((result) => {
            toolbar.setSaving(false);
            if (result && result.version) {
                toolbar.message(fill(strings.savedversion, result.version), MESSAGE_TIME * 2);
            } else {
                toolbar.message('');
            }
            return result;
        }).catch((error) => {
            toolbar.setSaving(false);
            toolbar.message(fill(strings.savefailed, error && error.message ? error.message : String(error)));
            Log.debug(error);
        });
    };

    /**
     * Export the sculpture, hand the file to the browser and show the validation report.
     *
     * @param {string} format stl, glb or 3mf.
     * @returns {Promise}
     */
    const exportModel = (format) => {
        const kind = EXPORTS[format];
        if (!kind || !started) {
            return Promise.resolve(null);
        }
        return engine.exportModel(format).then(({bytes, report}) => {
            download(bytes, kind.type, fileName(title, kind.extension));
            toolbar.message(reportText(strings, report || {}));
            return report;
        }).catch((error) => {
            Log.debug(error);
            const message = error && error.message ? error.message : String(error);
            toolbar.message(extra.exportfailed ? fill(extra.exportfailed, message) : message);
        });
    };

    /**
     * Enter or leave VR.
     *
     * @returns {Promise}
     */
    const toggleVr = () => {
        if (!xr) {
            return Promise.resolve(null);
        }
        return Promise.resolve(xr.active ? xr.exit() : xr.enter()).catch((error) => {
            Log.debug(error);
            toolbar.message(error && error.message ? error.message : String(error), MESSAGE_TIME);
        });
    };

    /**
     * Whether the studio fills the screen (either way).
     *
     * @returns {boolean}
     */
    const isFull = () => document.fullscreenElement === root || fullwindow;

    /**
     * Fill the screen with the studio, or stop doing so.
     *
     * Uses the Fullscreen API; where it is missing or refused, the studio fills the window instead.
     *
     * @returns {Promise}
     */
    const toggleFullscreen = () => {
        if (fullwindow) {
            fullwindow = false;
            root.classList.remove('mod_vrsculpt-fullscreen');
            toolbar.setFullscreen(false);
            return Promise.resolve(null);
        }
        if (document.fullscreenElement === root) {
            return Promise.resolve(document.exitFullscreen()).catch((error) => Log.debug(error));
        }
        if (typeof root.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
            return Promise.resolve(root.requestFullscreen()).catch(() => {
                fullwindow = true;
                root.classList.add('mod_vrsculpt-fullscreen');
                toolbar.setFullscreen(true);
            });
        }
        fullwindow = true;
        root.classList.add('mod_vrsculpt-fullscreen');
        toolbar.setFullscreen(true);
        return Promise.resolve(null);
    };

    /** Show the full screen state after the browser changed it. */
    const onFullscreenChange = () => {
        toolbar.setFullscreen(isFull());
    };

    /**
     * Escape leaves the full-window fallback (the browser handles its own full screen).
     *
     * @param {KeyboardEvent} event The event.
     */
    const onKeyDown = (event) => {
        if (event.key === 'Escape' && fullwindow) {
            toggleFullscreen();
        }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    root.addEventListener('keydown', onKeyDown);

    // Session events.
    const unsubscribers = [];
    /**
     * Listen to a session event, remembering how to stop.
     *
     * @param {string} type Event type.
     * @param {Function} fn Listener.
     */
    const listen = (type, fn) => {
        const off = session.on(type, fn);
        if (typeof off === 'function') {
            unsubscribers.push(off);
        }
    };
    listen('status', (detail) => {
        const state = detail && detail.state ? detail.state : '';
        toolbar.setStatus(detail && detail.text ? detail.text : '');
        if (state === 'closed' || state === 'view') {
            toolbar.setSaveAllowed(false);
        }
    });
    listen('peers', (list) => {
        const now = new Map();
        (Array.isArray(list) ? list : []).forEach((peer) => {
            if (peer && peer.peerid !== undefined) {
                now.set(String(peer.peerid), String(peer.name || ''));
            }
        });
        now.forEach((name, peerid) => {
            if (!names.has(peerid) && name) {
                toolbar.message(fill(strings.peerjoined, name), MESSAGE_TIME);
            }
        });
        names.clear();
        now.forEach((name, peerid) => names.set(peerid, name));
    });
    listen('pose', (detail) => {
        if (detail && detail.pose) {
            const peerid = String(detail.peerid);
            if (detail.name && !names.has(peerid)) {
                names.set(peerid, String(detail.name));
            }
            presence.update(peerid, detail.name || names.get(peerid) || '', detail.pose, performance.now());
        }
    });
    listen('peerleft', (detail) => {
        const peerid = String(detail && detail.peerid !== undefined ? detail.peerid : '');
        presence.remove(peerid);
        const name = names.get(peerid);
        names.delete(peerid);
        if (name) {
            toolbar.message(fill(strings.peerleft, name), MESSAGE_TIME);
        }
    });
    listen('saved', (detail) => {
        if (detail && detail.version) {
            toolbar.message(fill(strings.savedversion, detail.version), MESSAGE_TIME * 2);
        }
    });
    listen('savefailed', (detail) => {
        toolbar.message(fill(strings.savefailed, detail && detail.message ? detail.message : ''));
    });
    unsubscribers.push(engine.on('rejected', (detail) => Log.debug(detail)));
    unsubscribers.push(engine.on('error', (detail) => {
        showFailure(root, strings, new Error(detail && detail.message ? detail.message : 'error'));
    }));

    /**
     * Fit the renderer and the camera to the canvas (not while an immersive session sizes the canvas).
     */
    const resize = () => {
        if (renderer.xr.isPresenting) {
            return;
        }
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    // Frame loop. THREE.Timer (not the deprecated THREE.Clock) skips the time a hidden tab was away.
    const timer = new THREE.Timer();
    timer.connect(document);
    const posework = {
        inverse: new THREE.Matrix4(),
        matrix: new THREE.Matrix4(),
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(),
    };
    const headpose = [0, 0, 0, 0, 0, 0, 1];
    const desktoppose = {m: '3d', h: headpose, l: null, r: null};
    const vrpose = {m: 'vr', h: null, l: null, r: null};
    let lastpose = 0;

    /** Send the own pose (at most 15 a second). */
    const sendPose = () => {
        const now = performance.now();
        if (!started || now - lastpose < POSE_INTERVAL) {
            return;
        }
        lastpose = now;
        let pose = null;
        if (xr && xr.active) {
            const p = xr.getPose();
            if (p) {
                vrpose.h = p.h;
                vrpose.l = p.l;
                vrpose.r = p.r;
                pose = vrpose;
            }
        } else {
            cameraPose(camera, sculptureRoot, posework, headpose);
            desktoppose.r = desktop ? desktop.cursorPose() : null;
            pose = desktoppose;
        }
        if (pose) {
            try {
                session.sendPose(pose);
            } catch (e) {
                Log.debug(e);
            }
        }
    };

    renderer.setAnimationLoop((time, frame) => {
        timer.update(time);
        const dt = timer.getDelta();
        if (xr && xr.active) {
            xr.update(dt, frame);
        } else if (desktop) {
            desktop.update(dt);
        }
        presence.tick(performance.now());
        sendPose();
        renderer.render(scene, camera);
    });

    /**
     * Stop the studio: final save and leave (the session), then free everything.
     *
     * @returns {Promise}
     */
    const stop = () => {
        if (stopped) {
            return Promise.resolve(null);
        }
        stopped = true;
        const ending = Promise.resolve().then(() => session.stop()).catch((error) => Log.debug(error));
        return ending.then(() => {
            if (xr) {
                xr.dispose();
            }
            renderer.setAnimationLoop(null);
            timer.dispose();
            observer.disconnect();
            if (desktop) {
                desktop.detach();
            }
            toolbar.dispose();
            unsubscribers.forEach((off) => off());
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            root.removeEventListener('keydown', onKeyDown);
            presence.dispose();
            engine.dispose();
            view.dispose();
            delete root.dataset.vrsculptReady;
            return null;
        });
    };

    /**
     * Leaving the page: the leader's final save.
     */
    const onPageHide = () => {
        stop();
    };

    /**
     * A page restored from the back/forward cache starts afresh.
     *
     * @param {PageTransitionEvent} event The event.
     */
    const onPageShow = (event) => {
        if (event.persisted && stopped) {
            window.location.reload();
        }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    return Promise.resolve(session.start()).then(() => {
        if (stopped) {
            return null;
        }
        started = true;
        if (loading) {
            loading.classList.add('d-none');
        }
        if (!readonly) {
            tools = createTools({
                session: session,
                lockOwner: (p, r) => session.lockOwner(p, r),
                onChange: () => toolbar.refresh(),
                onRefused: (name) => toolbar.message(fill(strings.lockedbyother, name || '…'), MESSAGE_TIME),
            });
            toolbar.setTools(tools);
        }
        desktop = attachDesktop({
            THREE: THREE,
            canvas: canvas,
            camera: camera,
            sculptureRoot: sculptureRoot,
            engine: engine,
            tools: tools,
            keyroot: root,
            target: [0, SCULPTURE_HEIGHT, 0],
        });
        xr = createXrSculpt({
            THREE: THREE,
            renderer: renderer,
            scene: scene,
            camera: camera,
            sculptureRoot: sculptureRoot,
            tools: tools,
            readonly: readonly,
            strings: strings,
            onStart: () => {
                desktop.setEnabled(false);
                toolbar.setVr(true, true);
            },
            onEnd: () => {
                desktop.setEnabled(true);
                toolbar.setVr(true, false);
                resize();
            },
        });
        watchVr(xr, toolbar, () => stopped);
        root.dataset.vrsculptReady = readonly ? 'view' : String(config.mode || 'solo');
        canvas.focus({preventScroll: true});
        return {stop: stop};
    }).catch((error) => {
        showFailure(root, strings, error);
        stop();
        return null;
    });
};

/**
 * Start the studio (js_call_amd from studio.php).
 *
 * @param {Object} config {cmid, sessionid, mode, readonly, user: {id, name}, model, modelurl, modelformat, snapshoturl,
 *     version, workerurl, trackcontributions, maxusers, autosavems, contributionms, backurl}
 * @returns {Promise<Object|null>} {stop()} once running, or null.
 */
export const init = (config) => {
    const root = document.querySelector('[data-region="mod_vrsculpt-studioroot"]');
    if (!root || root.dataset.vrsculptStarted === '1') {
        return Promise.resolve(null);
    }
    root.dataset.vrsculptStarted = '1';
    const pending = new Pending('mod_vrsculpt/studio:init');
    const strings = {};
    const extra = {};
    // A string that is not part of the contract list must never stop the studio.
    const optional = Promise.resolve(getString('exportfailed', 'mod_vrsculpt')).then((value) => {
        // A missing string comes back as [[exportfailed]]: then the bare error is shown.
        if (value && String(value).indexOf('[[') !== 0) {
            extra.exportfailed = value;
        }
        return value;
    }).catch(() => null);
    return getStrings(STRING_KEYS.map((key) => ({key: key, component: 'mod_vrsculpt'}))).then((values) => {
        STRING_KEYS.forEach((key, index) => {
            strings[key] = values[index];
        });
        return optional;
    }).then(() => run(root, config || {}, strings, extra)).then((studio) => {
        pending.resolve();
        return studio;
    }).catch((error) => {
        showFailure(root, strings, error);
        pending.resolve();
        return null;
    });
};
