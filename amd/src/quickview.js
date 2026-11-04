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
 * The grading page's quick view: a popup with one saved version of a sculpture that the teacher turns
 * (drag), zooms (wheel, pinch or buttons) and moves (right-drag, Shift+drag or the arrow keys).
 *
 * The version is meshed by the sculpting engine's worker, as in the studio; the renderer and lights
 * follow the studio's view (mod_vrmakerspace/studio), the camera is three.js's OrbitControls.
 *
 * @module     mod_vrmakerspace/quickview
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import * as THREE from 'vrroomruntime_builtin/three';
import Log from 'core/log';
import Modal from 'core/modal';
import ModalEvents from 'core/modal_events';
import Pending from 'core/pending';
import Templates from 'core/templates';
import {getString} from 'core/str';
import {createEngineClient} from 'mod_vrmakerspace/engineclient';

/** Vertical field of view (degrees). */
const FOV = 40;

/** Highest device pixel ratio rendered. */
const MAX_PIXEL_RATIO = 1.5;

/** Largest version file fetched (bytes), as the studio. */
const MAX_SNAPSHOT = 33554432;

/** Zoom step of the buttons. */
const ZOOM_STEP = 0.8;

/**
 * Text as HTML.
 *
 * @param {string} text Plain text.
 * @returns {string}
 */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Fetch a saved version.
 *
 * @param {string} url Its pluginfile URL.
 * @returns {Promise<ArrayBuffer>}
 */
const fetchVersion = async(url) => {
    const response = await fetch(url, {credentials: 'same-origin'});
    if (!response.ok) {
        throw new Error('HTTP ' + response.status);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > MAX_SNAPSHOT) {
        throw new Error('Bad file size');
    }
    return buffer;
};

/**
 * Show a version in the popup's body and keep it running until stop() is called.
 *
 * @param {HTMLElement} body The popup body (templates/quickview.mustache).
 * @param {string} workerurl The engine worker's URL.
 * @param {string} url The version's file.
 * @returns {Function} stop(): frees the view.
 */
const show = (body, workerurl, url) => {
    const stage = body.querySelector('[data-region="stage"]');
    const canvas = body.querySelector('[data-region="canvas"]');
    const loading = body.querySelector('[data-region="loading"]');
    const message = body.querySelector('[data-region="message"]');
    const fail = (key, error) => {
        Log.debug(error);
        loading.classList.add('d-none');
        const text = error && error.message ? error.message : String(error || '');
        getString(key, 'mod_vrmakerspace', text).then((s) => {
            message.textContent = s;
            message.classList.remove('d-none');
            return s;
        }).catch(Log.debug);
    };

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true});
    } catch (e) {
        fail('studio_nowebgl', e);
        stage.classList.add('d-none');
        return () => null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc9ccd1);
    const camera = new THREE.PerspectiveCamera(FOV, 4 / 3, 0.005, 20);
    camera.position.set(0, 0.15, 0.6);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5f66, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(1.2, 2.6, 1.6);
    // The sun follows the camera, so the side the teacher looks at is always lit.
    camera.add(sun);
    const filllight = new THREE.DirectionalLight(0xdfe6ff, 0.5);
    filllight.position.set(-1.5, 1.2, -1);
    scene.add(filllight);
    scene.add(camera);
    const material = new THREE.MeshStandardMaterial({color: 0xc08a64, roughness: 0.82, metalness: 0});
    const sculpture = new THREE.Group();
    scene.add(sculpture);

    const controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.listenToKeyEvents(canvas);
    controls.minDistance = 0.02;
    controls.maxDistance = 5;
    let touched = false;
    controls.addEventListener('start', () => {
        touched = true;
    });

    const box = new THREE.Box3();
    const centre = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    // Look at the whole sculpture from the front, a little above.
    const frame = () => {
        // Precise: the chunk meshes' own bounds are whole chunks, much bigger than the clay in them.
        box.setFromObject(sculpture, true);
        if (box.isEmpty()) {
            return;
        }
        box.getCenter(centre);
        box.getBoundingSphere(sphere);
        const distance = Math.max(0.05, sphere.radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2)) * 1.05);
        controls.target.copy(centre);
        camera.position.set(centre.x, centre.y + distance * 0.35, centre.z + distance * 0.94);
        controls.update();
    };

    const engine = createEngineClient(workerurl, THREE, sculpture, material);
    engine.on('chunks', () => {
        loading.classList.add('d-none');
        // Chunks come in batches: keep framing until the teacher moves the view.
        if (!touched) {
            frame();
        }
    });
    engine.on('error', (detail) => fail('quickview_failed', new Error(detail && detail.message)));

    const resize = () => {
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        if (width && height) {
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
    });

    const zoom = (factor) => {
        touched = true;
        const offset = camera.position.clone().sub(controls.target);
        const length = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
        camera.position.copy(controls.target).add(offset.setLength(length));
        controls.update();
    };
    const onClick = (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) {
            return;
        }
        if (button.dataset.action === 'zoomin') {
            zoom(ZOOM_STEP);
        } else if (button.dataset.action === 'zoomout') {
            zoom(1 / ZOOM_STEP);
        } else if (button.dataset.action === 'reset') {
            touched = false;
            frame();
        }
    };
    body.addEventListener('click', onClick);

    const pending = new Pending('mod_vrmakerspace/quickview:load');
    fetchVersion(url)
        .then((buffer) => engine.init({snapshot: buffer}))
        .catch((error) => fail('quickview_failed', error))
        .finally(() => pending.resolve());

    return () => {
        body.removeEventListener('click', onClick);
        renderer.setAnimationLoop(null);
        observer.disconnect();
        controls.dispose();
        engine.dispose();
        material.dispose();
        renderer.dispose();
    };
};

/**
 * Open the quick view of a version.
 *
 * @param {string} workerurl The engine worker's URL.
 * @param {string} url The version's file.
 * @param {string} title Plain-text name of the version.
 * @returns {Promise<void>}
 */
const open = async(workerurl, url, title) => {
    const modal = await Modal.create({
        title: escapeHtml(title),
        body: Templates.render('mod_vrmakerspace/quickview', {uniqid: Math.random().toString(36).slice(2), title: title}),
        large: true,
        removeOnClose: true,
    });
    modal.getRoot()[0].querySelector('.modal-dialog').classList.add('modal-xl');
    let stop = null;
    let closed = false;
    modal.getRoot().on(ModalEvents.hidden, () => {
        closed = true;
        if (stop) {
            stop();
            stop = null;
        }
    });
    modal.show();
    await modal.getBodyPromise();
    if (!closed) {
        stop = show(modal.getBody()[0], workerurl, url);
    }
};

/**
 * Open the quick view from every Quick view button of the page.
 *
 * @param {string} workerurl The engine worker's URL (studio_helper::worker_url()).
 */
export const init = (workerurl) => {
    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action="mod_vrmakerspace-quickview"]');
        if (!button || !button.dataset.url) {
            return;
        }
        event.preventDefault();
        open(workerurl, button.dataset.url, button.dataset.title || '').catch(Log.debug);
    });
};
