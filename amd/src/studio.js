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
 * The studio page (studio.php, templates/studio.mustache): puts together the 3D view, the engine, the
 * session (on one's own, with a partner or over the companion service), the sculpting and modelling
 * tools, mouse and keyboard input, VR, the presence of the others and the toolbar; in tutorial mode also the
 * guided tour (mod_vrmakerspace/tutorial) and the tutor beside the piece (mod_vrmakerspace/tutor), with the state
 * of the studio the tour's steps are checked against.
 *
 * The method (Sculpt or Model) is per person: it chooses which tools act, the activity's `methods`
 * setting limits the choice, and both layers of the piece always show.
 *
 * The WebGL check, the renderer set-up, the resize handling and the THREE.Timer frame loop follow
 * vrroomruntime_builtin/viewer.
 *
 * @module     mod_vrmakerspace/studio
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import * as THREE from 'vrroomruntime_builtin/three';
import Log from 'core/log';
import Pending from 'core/pending';
import {getString, getStrings} from 'core/str';
import {createEngineClient} from 'mod_vrmakerspace/engineclient';
import {createTools} from 'mod_vrmakerspace/tools';
import {createModelTools} from 'mod_vrmakerspace/modeltools';
import {attach as attachDesktop} from 'mod_vrmakerspace/desktopinput';
import {attach as attachModelInput} from 'mod_vrmakerspace/modelinput';
import {createToolbar} from 'mod_vrmakerspace/toolbar';
import {createPresence} from 'mod_vrmakerspace/presence';
import {createXrStudio} from 'mod_vrmakerspace/xrstudio';
import {createSession} from 'mod_vrmakerspace/net/session';
import {createTutor} from 'mod_vrmakerspace/tutor';
import {createTutorial} from 'mod_vrmakerspace/tutorial';
import {stringKeys as tutorialStringKeys} from 'mod_vrmakerspace/tutorialsteps';
import {startBelowTopBar, watch as watchBottomBar} from 'mod_vrmakerspace/bottombar';
import {createGuide} from 'mod_vrmakerspace/guide';

/** Every string of the studio and the modules it hands its strings to (contract §9). */
const STRING_KEYS = [
    'studio_loading', 'studio_nowebgl', 'studio_readonly', 'studio_failed', 'tools', 'tool_grab', 'tool_twist',
    'tool_add', 'tool_carve', 'tool_smooth', 'tool_inflate', 'tool_pinch', 'tool_flatten', 'tool_shape', 'tool_cutshape',
    'mirror', 'brushsize', 'brushstrength', 'undo', 'redo', 'savenow',
    'savedversion', 'saving', 'savefailed', 'export', 'export_stl', 'export_glb', 'export_3mf', 'exportreport',
    'exportwatertight', 'exportproblems', 'entervr', 'exitvr', 'status_solo', 'status_connecting',
    'status_connected', 'status_waiting', 'status_reconnecting', 'status_resyncing', 'status_full',
    'status_failed', 'status_companionmissing', 'status_closed', 'lockedbyother', 'peerjoined', 'peerleft',
    'shortcuts', 'vrhelp', 'fullscreen', 'back',
    'method_sculpt', 'method_model', 'select_vertex', 'select_edge', 'select_face', 'selectall', 'selectnone',
    'selectlinked', 'selectloop', 'selectloop_hint', 'action_select', 'action_move', 'action_rotate', 'action_scale',
    'action_extrude', 'action_inset', 'action_bevel', 'action_loopcut', 'oneshot_merge', 'oneshot_delete', 'oneshot_fill',
    'oneshot_flip', 'oneshot_mirror', 'oneshot_bake', 'bakeconfirm', 'addshape', 'mshape_cube', 'mshape_plane',
    'mshape_cylinder', 'mshape_sphere', 'mshape_cone', 'mshape_torus', 'segments', 'axislock', 'axis_free', 'axis_x',
    'axis_y', 'axis_z', 'meshrefused_empty', 'meshrefused_needfaces', 'meshrefused_neededges',
    'meshrefused_nonmanifold', 'meshrefused_badselection', 'meshrefused_limit', 'meshrefused_conflict',
    'meshrefused_nosolid', 'undoreset', 'leavesavefailed',
    'modelopenedges', 'modelshortcuts', 'vrmodelhelp', 'vrmodelselecthelp', 'meshlayer',
];

/** Height of the desktop camera above the piece's centre when the studio opens (m). */
const CAMERA_RISE = 0.3;

/** Distance of the desktop camera in front of the piece when the studio opens (m). */
const CAMERA_DISTANCE = 0.5;

/** Distance of the desktop camera to the side when the studio opens (m): a three-quarter view shows three sides. */
const CAMERA_SIDE = 0.3;

/** How much room the camera leaves round the piece when it eases back (1 = touching the edges). */
const FRAME_MARGIN = 1.3;

/** The most the camera moves back at one change (times its distance), so a stray measurement cannot fling it away. */
const FRAME_MAX_STEP = 1.6;

/** The backdrop in the headset. */
const XR_BACKGROUND = new THREE.Color(0xdde3ea);

/** Where the camera starts when the studio opens, times its resting distance. */
const SETTLE_FROM = 1.5;

/** How long the camera takes to settle when the studio opens (ms). */
const SETTLE_TIME = 900;

/** How long the camera takes to ease back (ms). */
const FRAME_TIME = 500;

/** How long after a change the camera checks that the piece is still in view (ms): the engine draws it first. */
const FRAME_DELAY = 700;

/** Size of a shape from the Add shape menu (half-extent or radius, m). */
const NEW_SHAPE_SIZE = 0.06;

/** A new shape stays this close to the middle (m on each axis), so all of it is inside the mesh's reach. */
const NEW_SHAPE_REACH = 0.3;

/** Height of the piece's centre above the floor in the desktop view (m). */
const SCULPTURE_HEIGHT = 1.0;

/** Height of the pedestal top (m): just under the lowest the grid reaches. */
const PEDESTAL_TOP = 0.74;

/** Radius of the turntable on top of the stand (m). */
const TABLE_RADIUS = 0.22;

/** Thickness of the turntable (m). */
const TABLE_THICKNESS = 0.03;

/** Vertical field of view of the desktop camera (degrees). */
const FOV = 50;

/** Highest device pixel ratio rendered (keeps phones and big screens fast). */
const MAX_PIXEL_RATIO = 1.5;

/** Presence poses are sent at most this often (ms): 15 a second. */
const POSE_INTERVAL = 67;

/** How long leaving waits for the save (ms). */
const LEAVE_SAVE_WAIT = 10000;

/** How long passing messages (someone joined, a region is locked) stay (ms). */
const MESSAGE_TIME = 5000;

/** Ops that are not counted for the tutorial: stroke bookkeeping, undo and redo (counted on their own), selections. */
const UNCOUNTED_OPS = new Set(['end', 'lock', 'unlock', 'undo', 'redo', 'save', 'hz', 'msel']);

/** How many stroke ids the tutorial's op count remembers (so a stroke of many ops counts once). */
const COUNTED_STROKES = 2000;

/** A save counts as the student's (the Save now button) when the version comes within this long of the click (ms). */
const MANUAL_SAVE_WINDOW = 30000;

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
    const base = safe.replace(/\s+/g, ' ').trim().slice(0, 100) || 'piece';
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
 * The methods an activity allows.
 *
 * @param {*} setting config.methods: 'both' (or anything unknown), 'sculpt' or 'model'.
 * @returns {string[]}
 */
export const allowedMethods = (setting) => {
    if (setting === 'sculpt' || setting === 'model') {
        return [setting];
    }
    return ['sculpt', 'model'];
};

/**
 * The method a person starts with.
 *
 * @param {string[]} methods The methods allowed.
 * @param {*} startmodel config.model.
 * @returns {string} 'sculpt' or 'model'.
 */
export const initialMethod = (methods, startmodel) => {
    if (!methods.includes('sculpt') || (startmodel === 'meshcube' && methods.includes('model'))) {
        return 'model';
    }
    return 'sculpt';
};

/**
 * Show the Enter VR button once the browser says whether VR is available.
 *
 * @param {Object} xr The XR controller (createXrStudio).
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
 * Whether a click on a link takes this tab away from this page.
 *
 * @param {HTMLAnchorElement} link The link.
 * @param {MouseEvent} event The click.
 * @returns {boolean}
 */
const leavesPage = (link, event) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return false;
    }
    if ((link.target && link.target !== '_self') || link.hasAttribute('download') || link.hasAttribute('data-bs-toggle')) {
        return false;
    }
    if (link.protocol !== 'http:' && link.protocol !== 'https:') {
        return false;
    }
    return link.href.split('#')[0] !== window.location.href.split('#')[0];
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
 * A canvas texture drawn by a function, in sRGB.
 *
 * @param {number} width Pixels.
 * @param {number} height Pixels.
 * @param {Function} draw Takes the 2D context.
 * @returns {Object} THREE.CanvasTexture
 */
const drawnTexture = (width, height, draw) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d'), width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
};

/**
 * A soft round shadow: dark in the middle, fading to nothing at the edge.
 *
 * @param {number} strength Opacity in the middle (0-1).
 * @returns {Object} THREE.CanvasTexture
 */
const softShadow = (strength) => drawnTexture(128, 128, (ctx, w) => {
    const gradient = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, `rgba(20, 24, 30, ${strength})`);
    gradient.addColorStop(0.55, `rgba(20, 24, 30, ${strength * 0.45})`);
    gradient.addColorStop(1, 'rgba(20, 24, 30, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, w);
});

/**
 * The studio's reflections: a small scene of soft boxes in a grey room, blurred into an environment map once. It gives
 * the piece gentle highlights and edges without any lights to compute per frame.
 *
 * @param {Object} renderer THREE.WebGLRenderer.
 * @returns {Object} {texture, dispose()}
 */
const studioEnvironment = (renderer) => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const wall = new THREE.MeshBasicMaterial({color: 0x6f7884, side: THREE.BackSide});
    const walls = new THREE.Mesh(geometry, wall);
    walls.scale.set(12, 6, 12);
    walls.position.y = 2;
    room.add(walls);
    const light = new THREE.MeshBasicMaterial({color: 0xffffff});
    light.color.multiplyScalar(6);
    const boxes = [[[-3, 3, 2], [3, 0.1, 2]], [[3, 2.5, 1], [0.1, 2, 3]], [[0, 4.9, 0], [4, 0.1, 4]], [[0, 2, -5.9], [6, 2, 0.1]]];
    boxes.forEach(([position, scale]) => {
        const box = new THREE.Mesh(geometry, light);
        box.position.set(position[0], position[1], position[2]);
        box.scale.set(scale[0], scale[1], scale[2]);
        room.add(box);
    });
    const target = pmrem.fromScene(room, 0.04);
    geometry.dispose();
    wall.dispose();
    light.dispose();
    pmrem.dispose();
    return {texture: target.texture, dispose: () => target.dispose()};
};

/**
 * Build the 3D view: renderer, camera, studio lights and reflections, the backdrop, the floor, the turntable with the
 * piece's soft shadow, and the piece's group.
 *
 * @param {HTMLCanvasElement} canvas The canvas.
 * @returns {Object} {renderer, scene, camera, sculptureRoot, material, backdrop, dispose()}
 */
const buildView = (canvas) => {
    const renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.xr.enabled = true;
    const scene = new THREE.Scene();
    // A soft gradient backdrop, light above and a little darker towards the floor: a photo studio's sweep.
    const backdrop = drawnTexture(4, 256, (ctx, w, h) => {
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, '#f3f5f8');
        gradient.addColorStop(0.55, '#dde3ea');
        gradient.addColorStop(1, '#b7c0cb');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
    });
    scene.background = backdrop;
    const environment = studioEnvironment(renderer);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.55;
    const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.01, 50);
    // Above the piece and to one side: three sides show, so a box reads as a box, and the stand stays below it.
    camera.position.set(CAMERA_SIDE, SCULPTURE_HEIGHT + CAMERA_RISE, CAMERA_DISTANCE);
    camera.lookAt(0, SCULPTURE_HEIGHT, 0);
    scene.add(camera);

    // Studio lights: a soft sky, a key light from the front left, a cool rim from behind that lines the edges.
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x6a707a, 0.45);
    scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xfff6ea, 1.6);
    key.position.set(-1.2, 2.6, 1.8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdbe7ff, 1.3);
    rim.position.set(1.4, 1.8, -2.2);
    scene.add(rim);
    const filllight = new THREE.DirectionalLight(0xdfe6ff, 0.35);
    filllight.position.set(1.5, 1.0, 1.0);
    scene.add(filllight);

    // The floor: a faint grid that fades out with distance, for a sense of depth.
    const floortexture = drawnTexture(512, 512, (ctx, w) => {
        ctx.fillStyle = '#c3cbd5';
        ctx.fillRect(0, 0, w, w);
        ctx.strokeStyle = 'rgba(70, 80, 95, 0.22)';
        ctx.lineWidth = 1;
        for (let at = 0; at <= w; at += w / 16) {
            ctx.beginPath();
            ctx.moveTo(at, 0);
            ctx.lineTo(at, w);
            ctx.moveTo(0, at);
            ctx.lineTo(w, at);
            ctx.stroke();
        }
        const fade = ctx.createRadialGradient(w / 2, w / 2, w * 0.1, w / 2, w / 2, w / 2);
        fade.addColorStop(0, 'rgba(195, 203, 213, 0)');
        fade.addColorStop(1, 'rgba(195, 203, 213, 1)');
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, w, w);
    });
    const floormaterial = new THREE.MeshStandardMaterial({map: floortexture, roughness: 1, metalness: 0});
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), floormaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.name = 'vrmakerspace-floor';
    scene.add(floor);

    // The turntable: a slim dark column with a light round top, its edge catching the light, and soft shadows.
    const columnmaterial = new THREE.MeshStandardMaterial({color: 0x4a525c, roughness: 0.4, metalness: 0.6});
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, PEDESTAL_TOP - TABLE_THICKNESS, 32), columnmaterial);
    column.position.set(0, (PEDESTAL_TOP - TABLE_THICKNESS) / 2, 0);
    column.name = 'vrmakerspace-pedestal';
    scene.add(column);
    const tablematerial = new THREE.MeshStandardMaterial({color: 0xeef1f4, roughness: 0.35, metalness: 0});
    const table = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS * 0.96, TABLE_THICKNESS, 64), tablematerial);
    table.position.set(0, PEDESTAL_TOP - TABLE_THICKNESS / 2, 0);
    table.name = 'vrmakerspace-turntable';
    scene.add(table);
    const shadowtexture = softShadow(0.3);
    const shadowmaterial = new THREE.MeshBasicMaterial({map: shadowtexture, transparent: true, depthWrite: false,
        toneMapped: false});
    const shadowgeometry = new THREE.PlaneGeometry(1, 1);
    const pieceshadow = new THREE.Mesh(shadowgeometry, shadowmaterial);
    pieceshadow.rotation.x = -Math.PI / 2;
    pieceshadow.scale.setScalar(TABLE_RADIUS * 1.6);
    pieceshadow.position.set(0, PEDESTAL_TOP + 0.001, 0);
    pieceshadow.renderOrder = 1;
    scene.add(pieceshadow);
    const floorshadow = new THREE.Mesh(shadowgeometry, shadowmaterial);
    floorshadow.rotation.x = -Math.PI / 2;
    floorshadow.scale.setScalar(TABLE_RADIUS * 3);
    floorshadow.position.set(0, 0.001, 0);
    scene.add(floorshadow);

    const sculptureRoot = new THREE.Group();
    sculptureRoot.name = 'vrmakerspace-sculpture';
    sculptureRoot.position.set(0, SCULPTURE_HEIGHT, 0);
    scene.add(sculptureRoot);
    // Clay with a little sheen, so the studio's soft boxes show in it.
    const material = new THREE.MeshStandardMaterial({color: 0xb07049, roughness: 0.55, metalness: 0, envMapIntensity: 0.6});

    return {
        renderer, scene, camera, sculptureRoot, material, backdrop,

        /** Free the GPU resources of the view. */
        dispose: () => {
            [floor, column, table].forEach((mesh) => mesh.geometry.dispose());
            [floormaterial, columnmaterial, tablematerial, shadowmaterial, material].forEach((each) => each.dispose());
            [floortexture, shadowtexture, backdrop].forEach((texture) => texture.dispose());
            shadowgeometry.dispose();
            environment.dispose();
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
 * What kind of transform an mxf op is: move (d), rotate (x and g) or scale (sc).
 *
 * @param {Object} op The op.
 * @param {string} fallback The modelling action in use, for an op that says nothing.
 * @returns {string} 'move', 'rotate' or 'scale'.
 */
const transformKind = (op, fallback) => {
    if (op.sc !== undefined) {
        return 'scale';
    }
    if (op.g !== undefined) {
        return 'rotate';
    }
    if (op.d !== undefined) {
        return 'move';
    }
    return fallback || 'move';
};

/**
 * The tutorial's count of the student's own ops: by op kind (a stroke counts once, by its first op), by transform
 * kind (mxf_move, mxf_rotate, mxf_scale) and the mirrored strokes, plus saves, exports, undos and redos.
 *
 * @returns {Object} {ops, saves, exports, undos, redos, count(op, action)}
 */
export const createOpCounter = () => {
    const seen = new Set();
    const counter = {
        ops: {},
        saves: 0,
        exports: 0,
        undos: 0,
        redos: 0,

        /**
         * Count an op that was taken.
         *
         * @param {Object} op The op.
         * @param {string} action The modelling action in use.
         */
        count: (op, action) => {
            if (!op || typeof op.k !== 'string' || UNCOUNTED_OPS.has(op.k)) {
                return;
            }
            const kinds = [op.k];
            if (op.k === 'mxf') {
                kinds.push('mxf_' + transformKind(op, action));
            }
            if (op.m) {
                kinds.push('mirrored');
            }
            const stroke = op.s !== undefined && op.s !== null ? String(op.s) : '';
            kinds.forEach((kind) => {
                if (stroke) {
                    const id = kind + ':' + stroke;
                    if (seen.has(id)) {
                        return;
                    }
                    seen.add(id);
                    if (seen.size > COUNTED_STROKES) {
                        seen.delete(seen.values().next().value);
                    }
                }
                counter.ops[kind] = (counter.ops[kind] || 0) + 1;
            });
        },
    };
    return counter;
};

/**
 * Where the desktop camera is about the centre of the view, for the tutorial's view steps.
 *
 * @param {Object} camera THREE.Camera.
 * @param {Object|null} desktop The desktop input (its OrbitControls).
 * @param {Object} sculptureRoot THREE.Group.
 * @param {Object} work {offset: Vector3, target: Vector3}
 * @returns {Object|null} {azimuth, polar, distance, target: [x, y, z] (sculpture-local)}
 */
const cameraState = (camera, desktop, sculptureRoot, work) => {
    if (!desktop || !desktop.controls) {
        return null;
    }
    const target = desktop.controls.target;
    work.offset.copy(camera.position).sub(target);
    const distance = work.offset.length();
    const local = sculptureRoot.worldToLocal(work.target.copy(target));
    return {
        azimuth: Math.atan2(work.offset.x, work.offset.z),
        polar: distance > 0 ? Math.acos(Math.max(-1, Math.min(1, work.offset.y / distance))) : 0,
        distance: distance,
        target: [local.x, local.y, local.z],
    };
};

/**
 * The sculpting tools' part of the studio state.
 *
 * @param {Object|null} tools The tools.
 * @returns {Object}
 */
const sculptState = (tools) => {
    if (!tools) {
        return {tool: '', shape: '', mirror: false, size: 0, strength: 0, canUndo: false, canRedo: false};
    }
    return {tool: tools.tool, shape: tools.shape, mirror: !!tools.mirror, size: tools.size, strength: tools.strength,
        canUndo: tools.canUndo(), canRedo: tools.canRedo()};
};

/**
 * The modelling tools' part of the studio state.
 *
 * @param {Object|null} modeltools The modelling tools.
 * @returns {Object}
 */
const modelState = (modeltools) => {
    if (!modeltools) {
        return {selectMode: '', modelAction: '', axis: 'free', selectionCount: 0};
    }
    const selection = modeltools.selection();
    return {selectMode: modeltools.selectMode, modelAction: modeltools.action, axis: modeltools.axis || 'free',
        selectionCount: selection && Array.isArray(selection.items) ? selection.items.length : 0};
};

/**
 * Whether the studio runs the tutorial, and whether the tutor can listen and speak.
 *
 * @param {Object} config Page config from studio.php.
 * @param {boolean} readonly Whether the piece can only be looked at.
 * @param {Object} extra Optional strings; extra.tutorial is set when the tour's strings loaded.
 * @returns {{tutorialon: boolean, canlisten: boolean, canspeak: boolean}}
 */
const tutorialFlags = (config, readonly, extra) => {
    const tutorialon = !readonly && !!(config.tutorial && config.tutorial.enabled) && !!extra.tutorial;
    const voice = tutorialon ? config.tutorial.voice : null;
    const ways = (list) => Array.isArray(list) && list.length > 0;
    return {tutorialon, canlisten: !!voice && ways(voice.listen), canspeak: !!voice && ways(voice.speak)};
};

/**
 * Keep the whole piece in the desktop view: after a change that takes it out of the frame, the camera eases back
 * (never in) until it fits again.
 *
 * @param {Object} THREE three.js.
 * @param {Object} camera THREE.PerspectiveCamera.
 * @param {Object} sculptureRoot THREE.Group holding the piece (and the others' presence, which is left out).
 * @returns {Object} {check(controls), update(controls)}
 */
export const createFramer = (THREE, camera, sculptureRoot) => {
    const box = new THREE.Box3();
    const sphere = new THREE.Sphere();
    const offset = new THREE.Vector3();
    let ease = null;
    /**
     * The box round the piece, in world space: its solid surfaces only (no wireframes, markers or see-through
     * helpers, and nothing of the others' presence), vertex by vertex.
     *
     * @returns {boolean} Whether there is anything to frame.
     */
    const measure = () => {
        box.makeEmpty();
        sculptureRoot.children.forEach((child) => {
            if (child.name === 'vrmakerspace-presence') {
                return;
            }
            child.traverseVisible((object) => {
                const material = object.material;
                if (object.isMesh && material && !material.wireframe && !material.transparent) {
                    box.expandByObject(object, true);
                }
            });
        });
        return !box.isEmpty();
    };
    return {
        /**
         * Start easing back if the piece no longer fits.
         *
         * @param {Object|null} controls The view's OrbitControls.
         */
        check: (controls) => {
            if (!controls || !measure()) {
                return;
            }
            box.getBoundingSphere(sphere);
            const half = THREE.MathUtils.degToRad(camera.fov / 2);
            const fit = Math.tan(half) * Math.min(1, camera.aspect || 1);
            const needed = sphere.radius * FRAME_MARGIN / fit + sphere.center.distanceTo(controls.target);
            const distance = camera.position.distanceTo(controls.target);
            if (distance < needed) {
                ease = {from: distance, to: Math.min(needed, controls.maxDistance, distance * FRAME_MAX_STEP),
                    start: performance.now()};
            }
        },

        /**
         * On arrival: start a little further out and settle in, so the studio opens with a gentle move. Not when the
         * person asked the system for less motion.
         *
         * @param {Object|null} controls The view's OrbitControls.
         */
        settle: (controls) => {
            const reduce = typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!controls || reduce) {
                return;
            }
            const distance = camera.position.distanceTo(controls.target);
            offset.copy(camera.position).sub(controls.target).setLength(distance * SETTLE_FROM);
            camera.position.copy(controls.target).add(offset);
            ease = {from: distance * SETTLE_FROM, to: distance, start: performance.now(), time: SETTLE_TIME};
        },

        /**
         * Per frame: move the camera along its line to the target while easing.
         *
         * @param {Object|null} controls The view's OrbitControls.
         */
        update: (controls) => {
            if (!ease || !controls) {
                return;
            }
            const t = Math.min(1, (performance.now() - ease.start) / (ease.time || FRAME_TIME));
            const distance = ease.from + (ease.to - ease.from) * t * (2 - t);
            offset.copy(camera.position).sub(controls.target).setLength(distance);
            camera.position.copy(controls.target).add(offset);
            if (t >= 1) {
                ease = null;
            }
        },
    };
};

/**
 * Where the page starts when the studio opens: the page's own heading (whose piece) just above the studio, so nothing
 * is cut under the site's top bar; else the task strip or the toolbar.
 *
 * @param {HTMLElement} root The studio root.
 * @returns {HTMLElement|null}
 */
const startElement = (root) => {
    const heading = root.previousElementSibling;
    // On a phone the room goes to the 3D view: start at the task line.
    const phone = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 575.98px)').matches;
    if (heading && /^H[1-6]$/.test(heading.tagName) && !phone) {
        return heading;
    }
    return root.querySelector('[data-region="goal"]') || root.querySelector('[data-region="toolbar"]');
};

/**
 * Tell the guide about the person's own changes (its tip goes after a few, and the saved state shows them). A stroke
 * is many ops and one change.
 *
 * @param {Object} session The session (its submit() is wrapped).
 * @param {Function} onChange Called once per change.
 */
const countChanges = (session, onChange) => {
    const strokes = new Set();
    const submitOwn = session.submit.bind(session);
    session.submit = (op) => {
        const taken = submitOwn(op);
        if (taken === false || !op || typeof op.k !== 'string' || UNCOUNTED_OPS.has(op.k)) {
            return taken;
        }
        if (op.s !== undefined && op.s !== null) {
            const id = String(op.s);
            if (strokes.has(id)) {
                return taken;
            }
            strokes.add(id);
            if (strokes.size > COUNTED_STROKES) {
                strokes.delete(strokes.values().next().value);
            }
        }
        onChange();
        return taken;
    };
};

/**
 * Run the studio once the strings are loaded.
 *
 * @param {HTMLElement} root Studio root.
 * @param {Object} config Page config from studio.php.
 * @param {Object} strings Strings by key.
 * @param {Object} extra Strings that are not required (by key; missing ones are absent); extra.tutorial holds the
 *     tutorial's and the tutor's strings in tutorial mode.
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
    const viewer = new THREE.Vector3();
    const names = new Map();
    const methods = allowedMethods(config.methods);
    // Someone who can only look has no method: the piece shows solid, without the Model panel's marks.
    let method = readonly ? 'sculpt' : initialMethod(methods, config.model);
    let tools = null;
    /** @type {Object|null} the modelling tools, when this person can edit and the activity has the Model method */
    let modeltools = null;
    let modelinput = null;
    let desktop = null;
    let xr = null;
    let stopped = false;
    let started = false;
    let fullwindow = false;
    // Tutorial mode: the guided tour and the tutor, for someone who works on the piece, and talking with the tutor
    // (TUTORIAL-VOICE-CONTRACT.md §2, §7): which ways the site and activity have set up.
    const {tutorialon, canlisten, canspeak} = tutorialFlags(config, readonly, extra);
    /** @type {Object|null} the tutor (mod_vrmakerspace/tutor) */
    let tutor = null;
    /** @type {Object|null} the guided tour (mod_vrmakerspace/tutorial) */
    let tutorial = null;
    /** @type {AudioContext|null} the tutor's voice's audio, made on the first gesture (browsers want one) */
    let audiocontext = null;

    /**
     * The audio context of the tutor's voice: made the first time (best on a gesture) and woken when asleep. Never
     * awaited: resume() can hang until a gesture comes.
     *
     * @returns {AudioContext|null} Null without voice or Web Audio.
     */
    const getAudioContext = () => {
        if (stopped || !(canlisten || canspeak)) {
            return null;
        }
        if (!audiocontext) {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) {
                return null;
            }
            try {
                audiocontext = new Context();
            } catch (e) {
                Log.debug(e);
                return null;
            }
        }
        if (audiocontext.state === 'suspended') {
            audiocontext.resume().catch((error) => Log.debug(error));
        }
        return audiocontext;
    };

    /** The first gesture in the studio makes the voice's audio context (and the next ones wake it). */
    const onFirstGesture = () => {
        if (getAudioContext()) {
            root.removeEventListener('pointerdown', onFirstGesture, true);
            root.removeEventListener('keydown', onFirstGesture, true);
        }
    };
    if (canlisten || canspeak) {
        root.addEventListener('pointerdown', onFirstGesture, true);
        root.addEventListener('keydown', onFirstGesture, true);
    }

    /**
     * Push to talk from VR (a thumbstick pressed in or let go): to the tour, which listens and sends.
     *
     * @param {boolean} pressed Whether it is held.
     */
    const talkToTutor = (pressed) => {
        if (!tutorial || typeof tutorial.talk !== 'function') {
            return;
        }
        try {
            getAudioContext();
            tutorial.talk(!!pressed);
        } catch (e) {
            Log.debug(e);
        }
    };
    const counter = createOpCounter();
    let vravailable = false;
    let manualsaveat = 0;

    // Toolbar first (tools come once the session runs), so status changes show from the start.
    const toolbar = createToolbar(root, {
        strings: strings,
        tools: null,
        handlers: {
            save: () => saveNow(),
            exportModel: (format) => exportModel(format),
            vr: () => toggleVr(),
            fullscreen: () => toggleFullscreen(),
            method: (name) => setMethod(name),
            addShape: (shape) => addShape(shape),
            selectLoop: () => selectLoop(),
            askBake: () => askBake(),
            confirmBake: () => closeBake(true),
            cancelBake: () => closeBake(false),
            tutorial: () => toggleTutorial(),
        },
    });
    toolbar.setSaveAllowed(!readonly);
    toolbar.setMethods(readonly ? [] : methods);
    toolbar.setMethod(method);

    // First-use help: the next-step tip, the legend, the saved state, fewer or more tools and who is here.
    const guide = createGuide(root, {
        readonly: readonly,
        state: () => ({
            selected: modeltools && method === 'model' ? modeltools.selection().items.length : 0,
        }),
        onToolsChange: () => toolbar.refresh(),
    });
    guide.setMethod(method);
    /** A change of tool, action or selection: the toolbar and the tip follow it. */
    const refreshTools = () => {
        toolbar.refresh();
        guide.refresh();
    };

    const session = createSession(Object.assign({}, config, {
        mode: readonly ? 'view' : config.mode,
        readonly: readonly,
        engine: engine,
        strings: strings,
    }));

    /**
     * Whether the tutor is showing something: what it does is not the student's.
     *
     * @returns {boolean}
     */
    const tutorBusy = () => !!(tutor && tutor.busy);

    const framer = createFramer(THREE, camera, sculptureRoot);
    let frametimer = null;
    /** After a change: once the engine has drawn it, keep the whole piece in view. */
    const frameSoon = () => {
        window.clearTimeout(frametimer);
        frametimer = window.setTimeout(() => framer.check(desktop ? desktop.controls : null), FRAME_DELAY);
    };
    if (!readonly) {
        countChanges(session, () => {
            guide.changed();
            frameSoon();
        });
    }

    if (tutorialon) {
        // Count the student's own ops by kind, where the tools hand them to the session.
        const submitOp = session.submit.bind(session);
        session.submit = (op) => {
            const taken = submitOp(op);
            if (taken !== false && !tutorBusy()) {
                counter.count(op, modeltools ? modeltools.action : '');
            }
            return taken;
        };
    }

    /**
     * Save now (the toolbar's button).
     *
     * @returns {Promise}
     */
    const saveNow = () => {
        manualsaveat = performance.now();
        toolbar.setSaving(true);
        toolbar.message(strings.saving);
        return Promise.resolve(session.saveNow()).then((result) => {
            toolbar.setSaving(false);
            if (result && result.version) {
                toolbar.message(fill(strings.savedversion, result.version), MESSAGE_TIME * 2);
                guide.saved();
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
     * Export the piece, hand the file to the browser and show the validation report.
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
            if (!tutorBusy()) {
                counter.exports++;
            }
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
     * Put the current method into effect: which tools listen, and whether the mesh shows its edit marks.
     */
    const applyMethod = () => {
        const inVr = !!(xr && xr.active);
        const modelling = method === 'model' && !readonly;
        if (desktop) {
            desktop.setToolsEnabled(!modelling);
        }
        if (modelinput) {
            modelinput.setEnabled(modelling && !inVr);
        }
        if (engine.poly && !inVr) {
            engine.poly.setShowEditing(modelling);
        }
        toolbar.setMethod(method);
        guide.setMethod(method);
    };

    /**
     * Change method (the switch or the Tab key).
     *
     * @param {string} name 'sculpt' or 'model'.
     */
    const setMethod = (name) => {
        if (!methods.includes(name) || name === method) {
            return;
        }
        method = name;
        toolbar.showBakeConfirm(false);
        applyMethod();
        if (xr && xr.method !== name) {
            xr.setMethod(name);
        }
    };

    /**
     * Show a passing message about the tools: on the toolbar, and in VR where the toolbar cannot be seen.
     *
     * @param {string} text The message.
     */
    const toolMessage = (text) => {
        toolbar.message(text, MESSAGE_TIME);
        if (xr && xr.active) {
            xr.showMessage(text);
        }
    };

    /**
     * Show a passing message by its string key.
     *
     * @param {string} key String key.
     * @param {*} [a] Value for the string.
     */
    const messageByKey = (key, a) => {
        if (strings[key]) {
            toolMessage(fill(strings[key], a));
            return;
        }
        Promise.resolve(getString(key, 'mod_vrmakerspace', a)).then((text) => {
            toolMessage(text);
            return text;
        }).catch((error) => Log.debug(error));
    };

    /**
     * Add a shape from the Add shape menu, in the middle of the view; it comes selected, ready to move.
     *
     * @param {string} shape Shape name.
     */
    const addShape = (shape) => {
        if (!modeltools || !desktop) {
            return;
        }
        const at = sculptureRoot.worldToLocal(desktop.controls.target.clone());
        /**
         * A coordinate brought within the reach of a new shape.
         *
         * @param {number} v Coordinate (m).
         * @returns {number}
         */
        const inReach = (v) => Math.max(-NEW_SHAPE_REACH, Math.min(NEW_SHAPE_REACH, v));
        modeltools.addShape(shape, [inReach(at.x), inReach(at.y), inReach(at.z)], NEW_SHAPE_SIZE);
    };

    /**
     * The toolbar's Select edge loop: from the edge selected last, otherwise the next click chooses the edge.
     */
    const selectLoop = () => {
        if (!modeltools) {
            return;
        }
        const selection = modeltools.selection();
        const items = selection && selection.md === 'e' && Array.isArray(selection.items) ? selection.items : [];
        if (items.length >= 2) {
            modeltools.selectLoop({kind: 'e', a: items[items.length - 2], b: items[items.length - 1]});
        } else if (modelinput) {
            modelinput.armLoop();
            toolbar.message(strings.selectloop_hint, MESSAGE_TIME);
        }
    };

    /** Ask before turning the mesh into clay; with no mesh, say so instead. */
    const askBake = () => {
        const data = engine.polydata();
        if (!data || !data.faceIds || !data.faceIds.length) {
            messageByKey('meshrefused_empty');
            return;
        }
        toolbar.showBakeConfirm(true);
    };

    /**
     * Answer the question of Turn into clay.
     *
     * @param {boolean} confirmed Whether it goes ahead.
     */
    const closeBake = (confirmed) => {
        toolbar.showBakeConfirm(false);
        canvas.focus({preventScroll: true});
        if (confirmed && modeltools) {
            modeltools.runOneShot('bake');
        }
    };

    const camerawork = {offset: new THREE.Vector3(), target: new THREE.Vector3()};

    /**
     * The studio state the tutorial's steps are checked against (TUTORIAL-CONTRACT.md §4): a fresh plain object.
     *
     * @returns {Object}
     */
    const studioState = () => Object.assign({method: method}, sculptState(tools), modelState(modeltools), {
        undos: counter.undos,
        redos: counter.redos,
        inVr: !!(xr && xr.active),
        vrAvailable: vravailable,
        saves: counter.saves,
        exports: counter.exports,
        camera: cameraState(camera, desktop, sculptureRoot, camerawork),
        ops: Object.assign({}, counter.ops),
    });

    /**
     * Count the student's undos and redos, where every input (toolbar, keys, VR) calls them.
     */
    const countUndoRedo = () => {
        const undo = tools.undo;
        const redo = tools.redo;
        tools.undo = (...args) => {
            const could = tools.canUndo();
            const result = undo(...args);
            if (could && !tutorBusy()) {
                counter.undos++;
            }
            return result;
        };
        tools.redo = (...args) => {
            const could = tools.canRedo();
            const result = redo(...args);
            if (could && !tutorBusy()) {
                counter.redos++;
            }
            return result;
        };
    };

    /**
     * The Tutorial button: open the tour where it was left, or close it.
     *
     * @returns {Promise|null}
     */
    const toggleTutorial = () => {
        if (!tutorial) {
            return null;
        }
        if (tutorial.isOpen) {
            tutorial.close();
            return null;
        }
        return tutorial.open(true);
    };

    /** The tour was closed: the focus goes back to the Tutorial button when it was in the bubble. */
    const onTutorialClosed = () => {
        const active = document.activeElement;
        if (active && active !== document.body && root.contains(active) && !active.closest('[data-region="tutorial"]')) {
            return;
        }
        const button = root.querySelector('[data-action="tutorial"]');
        (button || canvas).focus({preventScroll: true});
    };

    /**
     * Start the tutor and the guided tour (tutorial mode, once the tools are there); the tour opens by itself until
     * it has been gone through.
     */
    const startTutorial = () => {
        const demoContext = {
            tools: tools,
            modeltools: modeltools,
            engine: engine,
            session: session,
            toolbar: toolbar,
            camera: camera,
            sculptureRoot: sculptureRoot,
            setMethod: (name) => setMethod(name),
            /** @returns {string} The method in use now (a function: the tutor copies this object). */
            method: () => method,
            message: (text) => toolMessage(text),
        };
        try {
            tutor = createTutor({THREE: THREE, scene: scene, camera: camera, sculptureRoot: sculptureRoot,
                strings: extra.tutorial});
        } catch (e) {
            // The tour works without the tutor: it only cannot point or show.
            Log.debug(e);
            tutor = null;
        }
        tutorial = createTutorial({
            root: root,
            canvas: canvas,
            camera: camera,
            config: config.tutorial,
            cmid: config.cmid,
            strings: extra.tutorial,
            state: studioState,
            tutor: tutor,
            xr: xr,
            toolbar: toolbar,
            context: demoContext,
            audioContext: getAudioContext,
            onClose: onTutorialClosed,
        });
        if (tutor && typeof tutor.setVisible === 'function') {
            tutor.setVisible(false);
        }
        if (!tutorial.finished()) {
            tutorial.open(false);
        }
    };

    let tutorfailed = false;

    /**
     * The tutor's and the tour's frame update; a failure is logged once and never stops the frame loop.
     *
     * @param {number} dt Seconds since the last frame.
     * @param {Object} viewerLocal Where the viewer is, sculpture-local (THREE.Vector3, may be changed).
     */
    const updateTutorial = (dt, viewerLocal) => {
        try {
            if (tutor) {
                tutor.update(dt, viewerLocal, {inVr: !!(xr && xr.active)});
            }
            if (tutorial) {
                tutorial.update(dt);
            }
        } catch (e) {
            if (!tutorfailed) {
                tutorfailed = true;
                Log.debug(e);
            }
        }
    };

    /** Tell the mesh view who is here: selections of people who left stop being drawn at once. */
    const refreshPresent = () => {
        if (engine.poly) {
            engine.poly.setOwnAuthor(session.author());
            engine.poly.setPresent(session.peers().map((peer) => String(peer.peerid)));
        }
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
            root.classList.remove('mod_vrmakerspace-fullscreen');
            toolbar.setFullscreen(false);
            return Promise.resolve(null);
        }
        if (document.fullscreenElement === root) {
            return Promise.resolve(document.exitFullscreen()).catch((error) => Log.debug(error));
        }
        if (typeof root.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
            return Promise.resolve(root.requestFullscreen()).catch(() => {
                fullwindow = true;
                root.classList.add('mod_vrmakerspace-fullscreen');
                toolbar.setFullscreen(true);
            });
        }
        fullwindow = true;
        root.classList.add('mod_vrmakerspace-fullscreen');
        toolbar.setFullscreen(true);
        return Promise.resolve(null);
    };

    /** Show the full screen state after the browser changed it. */
    const onFullscreenChange = () => {
        toolbar.setFullscreen(isFull());
    };

    /**
     * Escape closes the question of Turn into clay, else leaves the full-window fallback (the browser handles
     * its own full screen). Tab on the 3D view switches method when there are two; Shift+Tab still leaves it.
     *
     * @param {KeyboardEvent} event The event.
     */
    const onKeyDown = (event) => {
        if (event.defaultPrevented) {
            return;
        }
        if (event.key === 'Escape' && toolbar.bakeConfirmShown()) {
            closeBake(false);
        } else if (event.key === 'Escape' && fullwindow) {
            toggleFullscreen();
        } else if (event.key === 'Tab' && event.target === canvas && !event.shiftKey && !event.ctrlKey && !event.metaKey
                && !event.altKey && !readonly && tools && methods.length > 1 && !(xr && xr.active)) {
            event.preventDefault();
            const next = method === 'model' ? 'sculpt' : 'model';
            setMethod(next);
            toolbar.message(strings['method_' + next], MESSAGE_TIME);
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
        // Waiting in a group piece: name who is awaited, and say the person can start.
        let text = detail && detail.text ? detail.text : '';
        if (state === 'waiting' && config.waitingtext) {
            text = config.waitingtext;
        }
        toolbar.setStatus(text);
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
        guide.peers([...names.values()]);
        refreshPresent();
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
        guide.peers([...names.values()]);
        if (name) {
            toolbar.message(fill(strings.peerleft, name), MESSAGE_TIME);
        }
        refreshPresent();
    });
    listen('saved', (detail) => {
        if (detail && detail.version) {
            toolbar.message(fill(strings.savedversion, detail.version), MESSAGE_TIME * 2);
            guide.saved();
            // For the tutorial, the student's own save (Save now), not the autosave.
            if (manualsaveat && performance.now() - manualsaveat < MANUAL_SAVE_WINDOW) {
                manualsaveat = 0;
                counter.saves++;
            }
        }
    });
    listen('savefailed', (detail) => {
        toolbar.message(fill(strings.savefailed, detail && detail.message ? detail.message : ''));
    });
    listen('historyreset', () => {
        if (tools && tools.clearHistory()) {
            messageByKey('undoreset');
        }
    });
    unsubscribers.push(engine.on('rejected', (detail) => Log.debug(detail)));
    unsubscribers.push(engine.on('polymesh', (detail) => {
        const data = detail && detail.openEdges ? detail : engine.polydata();
        toolbar.setOpenEdges(data && data.openEdges ? Math.floor(data.openEdges.length / 2) : 0);
    }));
    unsubscribers.push(engine.on('meshrefused', (detail) => {
        if (detail && detail.reason) {
            messageByKey('meshrefused_' + detail.reason);
        }
    }));
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
    const tutorviewer = new THREE.Vector3();
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
            const pointing = method === 'model' && modelinput ? modelinput : desktop;
            desktoppose.r = pointing ? pointing.cursorPose() : null;
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

    let framefailed = false;
    /**
     * Everything a frame does before it is drawn.
     *
     * @param {number} dt Seconds since the last frame.
     * @param {XRFrame} [frame] The XR frame, in an immersive session.
     */
    const updateFrame = (dt, frame) => {
        if (xr && xr.active) {
            xr.update(dt, frame);
        } else if (desktop) {
            desktop.update(dt);
            framer.update(desktop.controls);
            if (modelinput) {
                modelinput.update(dt);
            }
        }
        (xr && xr.active ? renderer.xr.getCamera() : camera).getWorldPosition(viewer);
        const viewerlocal = sculptureRoot.worldToLocal(viewer);
        if (tutorialon) {
            updateTutorial(dt, tutorviewer.copy(viewerlocal));
        }
        presence.tick(performance.now(), viewerlocal);
        sendPose();
    };
    renderer.setAnimationLoop((time, frame) => {
        timer.update(time);
        const dt = timer.getDelta();
        try {
            updateFrame(dt, frame);
        } catch (e) {
            // A frame whose update fails is still drawn: an undrawn frame shows as a black flash in a headset.
            if (!framefailed) {
                framefailed = true;
                Log.debug(e);
            }
        }
        renderer.render(scene, camera);
    });

    /**
     * Stop the studio: final save and leave (the session), then free everything.
     *
     * @returns {Promise}
     */
    /**
     * Close the tutor's audio, if it was ever made.
     */
    const closeAudio = () => {
        if (audiocontext) {
            audiocontext.close().catch((error) => Log.debug(error));
            audiocontext = null;
        }
    };

    /**
     * Note whether this device can enter VR, once WebXR has said so (the tour's VR step needs it).
     */
    const watchVrAvailable = () => {
        Promise.resolve(xr.available).then((available) => {
            vravailable = !!available;
            return available;
        }).catch(() => null);
    };

    const stop = () => {
        if (stopped) {
            return Promise.resolve(null);
        }
        stopped = true;
        root.removeEventListener('pointerdown', onFirstGesture, true);
        root.removeEventListener('keydown', onFirstGesture, true);
        document.removeEventListener('click', onLinkClick, true);
        window.removeEventListener('beforeunload', onBeforeUnload);
        // The tour saves where the student got to before the page goes.
        const tourending = tutorial ? Promise.resolve(tutorial.dispose()).catch((error) => Log.debug(error)) : null;
        const ending = Promise.resolve().then(() => session.stop()).catch((error) => Log.debug(error));
        return Promise.all([ending, tourending]).then(() => {
            if (tutor) {
                try {
                    tutor.dispose();
                } catch (e) {
                    Log.debug(e);
                }
                tutor = null;
            }
            if (xr) {
                xr.dispose();
            }
            closeAudio();
            renderer.setAnimationLoop(null);
            timer.dispose();
            observer.disconnect();
            if (modelinput) {
                modelinput.detach();
            }
            if (modeltools) {
                modeltools.dispose();
            }
            if (desktop) {
                desktop.detach();
            }
            toolbar.dispose();
            guide.dispose();
            unsubscribers.forEach((off) => off());
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            root.removeEventListener('keydown', onKeyDown);
            presence.dispose();
            engine.dispose();
            view.dispose();
            delete root.dataset.vrmakerspaceReady;
            return null;
        });
    };

    /**
     * Leaving the page: the leader's final save.
     */
    const onPageHide = () => {
        stop();
    };

    // Whether the page may go now: the piece is safe, or a save could not be made and the person was told.
    let mayleave = false;
    let waitingtoleave = false;
    let savedforleaving = false;

    /**
     * Following a link on this page: first save, because a save does not outlast the page.
     *
     * @param {MouseEvent} event The click.
     */
    const onLinkClick = (event) => {
        const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!link || mayleave || readonly || !leavesPage(link, event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (waitingtoleave) {
            return;
        }
        waitingtoleave = true;
        toolbar.message(strings.saving);
        const timeout = new Promise((resolve, reject) => {
            window.setTimeout(() => reject(new Error('timeout')), LEAVE_SAVE_WAIT);
        });
        Promise.race([session.finishBeforeLeaving(), timeout]).then(() => {
            mayleave = true;
            savedforleaving = true;
            window.location.href = link.href;
            return null;
        }).catch((error) => {
            Log.debug(error);
            // Leave the choice to the person: the next click goes, and the browser asks first.
            waitingtoleave = false;
            mayleave = true;
            toolbar.message(strings.leavesavefailed);
        });
    };

    /**
     * Closing the tab or reloading: nothing can be saved in time any more, so have the browser ask.
     *
     * @param {BeforeUnloadEvent} event The event.
     */
    const onBeforeUnload = (event) => {
        if (session.hasUnsaved() && !(mayleave && savedforleaving)) {
            event.preventDefault();
            event.returnValue = '';
        }
    };
    document.addEventListener('click', onLinkClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);

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

    // Below the page heading, the tools and the 3D view may not fit the window: start with them in view, just below
    // the site's top bar (measured: its height differs between themes and versions).
    // The task strip comes first, so the task and the way back stay in sight too.
    const toolrow = startElement(root);
    if (toolrow && window.scrollY === 0) {
        startBelowTopBar(root, toolrow);
    }

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
                onChange: () => refreshTools(),
                onRefused: (name) => toolbar.message(fill(strings.lockedbyother, name || '…'), MESSAGE_TIME),
            });
            toolbar.setTools(tools);
            if (tutorialon) {
                countUndoRedo();
            }
            if (methods.includes('model')) {
                modeltools = createModelTools({
                    session: session,
                    tools: tools,
                    engine: engine,
                    onChange: () => refreshTools(),
                    onRefused: (name) => toolMessage(fill(strings.lockedbyother, name || '…')),
                    onMessage: (key, a) => messageByKey(key, a),
                    log: (error) => Log.debug(error),
                });
                toolbar.setModel(modeltools);
                // With the basic tools there is no Pick button: a click picks anyway, so Move is the tool to start
                // with, and dragging what was picked moves it.
                if (root.classList.contains('mod_vrmakerspace-basic') && modeltools.action === 'select') {
                    modeltools.setAction('move');
                }
            }
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
        framer.settle(desktop.controls);
        if (modeltools) {
            modelinput = attachModelInput({
                THREE: THREE,
                canvas: canvas,
                camera: camera,
                sculptureRoot: sculptureRoot,
                engine: engine,
                model: modeltools,
                keyroot: root,
            });
        }
        xr = createXrStudio({
            THREE: THREE,
            renderer: renderer,
            scene: scene,
            camera: camera,
            sculptureRoot: sculptureRoot,
            tools: tools,
            model: modeltools,
            engine: engine,
            methods: methods.length > 1 ? 'both' : methods[0],
            method: method,
            onMethod: (name) => setMethod(name),
            readonly: readonly,
            strings: strings,
            // Push to talk to the tutor, only in tutorial mode with listening set up.
            onTalk: canlisten ? talkToTutor : null,
            onStart: () => {
                // The page is not measured while the headset shows the studio (mod_vrmakerspace/bottombar).
                root.dataset.vrmakerspaceXr = '1';
                // In the headset the backdrop would be pasted on each eye: a plain colour instead.
                scene.background = XR_BACKGROUND;
                desktop.setEnabled(false);
                if (modelinput) {
                    modelinput.setEnabled(false);
                }
                toolbar.showBakeConfirm(false);
                toolbar.setVr(true, true);
            },
            onEnd: () => {
                delete root.dataset.vrmakerspaceXr;
                scene.background = view.backdrop;
                desktop.setEnabled(true);
                applyMethod();
                toolbar.setVr(true, false);
                resize();
            },
        });
        applyMethod();
        refreshPresent();
        watchVr(xr, toolbar, () => stopped);
        watchVrAvailable();
        if (tutorialon && tools) {
            try {
                startTutorial();
            } catch (e) {
                // The studio works without the tour.
                Log.debug(e);
            }
        }
        root.dataset.vrmakerspaceReady = readonly ? 'view' : String(config.mode || 'solo');
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
 * @param {Object} config {cmid, sessionid, mode, readonly, user: {id, name}, model, methods, modelurl, modelformat, snapshoturl,
 *     version, workerurl, trackcontributions, maxusers, autosavems, contributionms, backurl, tutorial (tutorial mode only:
 *     {enabled, steps, done, skipped, laststep, ai, aipolicy})}
 * @returns {Promise<Object|null>} {stop()} once running, or null.
 */
export const init = (config) => {
    const root = document.querySelector('[data-region="mod_vrmakerspace-studioroot"]');
    if (!root || root.dataset.vrmakerspaceStarted === '1') {
        return Promise.resolve(null);
    }
    root.dataset.vrmakerspaceStarted = '1';
    // Moodle 5.3's activity navigation footer is fixed to the bottom of the window: keep the controls clear of it.
    watchBottomBar(root);
    const pending = new Pending('mod_vrmakerspace/studio:init');
    const strings = {};
    const extra = {};
    // A string that is not part of the contract list must never stop the studio.
    const optional = Promise.resolve(getString('exportfailed', 'mod_vrmakerspace')).then((value) => {
        // A missing string comes back as [[exportfailed]]: then the bare error is shown.
        if (value && String(value).indexOf('[[') !== 0) {
            extra.exportfailed = value;
        }
        return value;
    }).catch(() => null);
    // The tutorial's strings, in tutorial mode: without them the studio still runs, without the tour.
    const tutorialon = !!(config && config.tutorial && config.tutorial.enabled && !config.readonly);
    const tutorialkeys = tutorialon ? tutorialStringKeys() : [];
    const tutorialstrings = !tutorialon ? Promise.resolve(null)
        : Promise.resolve(getStrings(tutorialkeys.map((key) => ({key: key, component: 'mod_vrmakerspace'})))).then((values) => {
            const texts = {};
            tutorialkeys.forEach((key, index) => {
                texts[key] = values[index];
            });
            extra.tutorial = texts;
            return texts;
        }).catch((error) => {
            Log.debug(error);
            return null;
        });
    return getStrings(STRING_KEYS.map((key) => ({key: key, component: 'mod_vrmakerspace'}))).then((values) => {
        STRING_KEYS.forEach((key, index) => {
            strings[key] = values[index];
        });
        return Promise.all([optional, tutorialstrings]);
    }).then(() => run(root, config || {}, strings, extra)).then((studio) => {
        pending.resolve();
        return studio;
    }).catch((error) => {
        showFailure(root, strings, error);
        pending.resolve();
        return null;
    });
};
