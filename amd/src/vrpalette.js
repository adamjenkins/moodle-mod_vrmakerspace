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
 * The wrist palette of the VR studio: a canvas board shown above the left controller or hand.
 *
 * The Sculpt page has the ten tools (two rows), the brush size and strength bars, undo, redo, mirror
 * and Exit VR, and a short help text. When modelling is allowed the board also has a Model page: the
 * select modes and commands, the eight actions, axis lock, segments, the basic shapes, the one-shot
 * tools, undo, redo and Exit VR. With both methods allowed a Sculpt | Model switch heads both pages.
 *
 * Everything is drawn with canvas calls (fillText: plain text, never HTML) into one texture, which
 * is redrawn only when what it shows changes. Hit tests are done in the board's own plane with
 * reused vectors, so pointing at the palette allocates nothing per frame.
 *
 * The canvas wrist board follows the wrist panel of vrroomruntime_builtin/xr (itself after
 * mod_gear's viewer).
 *
 * @module     mod_vrmakerspace/vrpalette
 * @copyright  2026 Boban Blagojevic
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** The tools in palette order (the same order as the desktop keys 1–9 and 0), five to a row. */
export const TOOLS = Object.freeze(['grab', 'twist', 'add', 'carve', 'smooth', 'inflate', 'pinch', 'flatten', 'shape',
    'cutshape']);

/** The Model page's actions in palette order (modeltools' action names; A and B step through them). */
export const ACTIONS = Object.freeze(['select', 'move', 'rotate', 'scale', 'extrude', 'inset', 'bevel', 'loopcut']);

/** The Model page's select modes, in the order of the desktop keys 1, 2 and 3. */
const SELECT_MODES = Object.freeze(['v', 'e', 'f']);

/** The string of each select mode. */
const SELECT_MODE_KEYS = Object.freeze({v: 'select_vertex', e: 'select_edge', f: 'select_face'});

/** The Model page's select commands. */
const SELECT_COMMANDS = Object.freeze(['all', 'none', 'linked', 'loop']);

/** The string of each select command. */
const SELECT_COMMAND_KEYS = Object.freeze({all: 'selectall', none: 'selectnone', linked: 'selectlinked', loop: 'selectloop'});

/** The axis lock choices ('free' stands for no lock). */
const AXES = Object.freeze(['free', 'x', 'y', 'z']);

/** The basic shapes, modeltools' shape names. */
const MESH_SHAPES = Object.freeze(['cube', 'plane', 'cylinder', 'sphere', 'cone', 'torus']);

/** The one-shot tools, modeltools' names. */
const ONESHOTS = Object.freeze(['merge', 'delete', 'fill', 'flip', 'mirror', 'bake']);

/**
 * Every string the Model page and the VR messages use, beyond the Sculpt page's: the studio fetches these
 * and hands them over in options.strings.
 */
export const MODEL_STRING_KEYS = Object.freeze([
    'method_sculpt', 'method_model', 'select_vertex', 'select_edge', 'select_face', 'selectall', 'selectnone',
    'selectlinked', 'selectloop', 'action_select', 'action_move', 'action_rotate', 'action_scale', 'action_extrude',
    'action_inset', 'action_bevel', 'action_loopcut', 'oneshot_merge', 'oneshot_delete', 'oneshot_fill', 'oneshot_flip',
    'oneshot_mirror', 'oneshot_bake', 'bakeconfirm', 'addshape', 'mshape_cube', 'mshape_plane', 'mshape_cylinder',
    'mshape_sphere', 'mshape_cone', 'mshape_torus', 'segments', 'axislock', 'axis_free', 'axis_x', 'axis_y', 'axis_z',
    'meshrefused_empty', 'meshrefused_needfaces', 'meshrefused_neededges', 'meshrefused_nonmanifold',
    'meshrefused_nosolid',
    'meshrefused_badselection', 'meshrefused_limit', 'meshrefused_conflict', 'lockedbyother', 'vrmodelhelp',
    'vrmodelselecthelp',
]);

/** Tool buttons per row. */
const TOOLS_PER_ROW = 5;

/** Smallest and largest brush radius (m), as the op format allows. */
export const SIZE_MIN = 0.004;
export const SIZE_MAX = 0.08;

/** Canvas width (px) and board width in the room (m). */
const CANVAS_WIDTH = 1024;
const BOARD_WIDTH = 0.2;

/** Canvas height of the full palette and of the view-only palette (px). */
const CANVAS_HEIGHT = 820;
const CANVAS_HEIGHT_READONLY = 176;

/** Canvas height of the Model page without the method switch (px). */
const CANVAS_HEIGHT_MODEL = 916;

/** Height the method switch adds to the top of a page (px). */
const SWITCH_HEIGHT = 108;

/** Outer margin and gap between controls (px). */
const PAD = 16;

/** Colours of the board. */
const COLOURS = Object.freeze({
    board: 'rgba(22, 26, 32, 0.9)',
    button: '#343a40',
    hover: '#495057',
    selected: '#0f6cbf',
    disabled: '#24282d',
    text: '#ffffff',
    muted: '#8a939b',
    bar: '#212529',
    fill: '#3d9a50',
    exit: '#ca3120',
    exithover: '#e04a38',
    help: '#ced4da',
});

/**
 * A raycast that never hits (the board is hit-tested in its own plane).
 *
 * @returns {undefined}
 */
const noRaycast = () => undefined;

/**
 * A rectangle of the canvas that reacts to the pointer.
 *
 * @param {string} region 'tool', 'size', 'strength', 'undo', 'redo', 'mirror', 'exit', or on the Model page and
 *     the switch 'method', 'selmode', 'selcmd', 'action', 'axis', 'segdown', 'segup', 'shape', 'oneshot'.
 * @param {string|null} tool The name of what the control chooses (a tool, action, shape and so on).
 * @param {number} x Left (px).
 * @param {number} y Top (px).
 * @param {number} w Width (px).
 * @param {number} h Height (px).
 * @returns {Object} {region, tool, key, x, y, w, h}
 */
const area = (region, tool, x, y, w, h) => ({region, tool, key: tool ? region + ':' + tool : region, x, y, w, h});

/**
 * Lay out a row of equally wide controls.
 *
 * @param {Object[]} areas Where to add them.
 * @param {string} region Region of the controls.
 * @param {string[]} names What each control chooses.
 * @param {number} x Left of the row (px).
 * @param {number} y Top of the row (px).
 * @param {number} width Width of the row (px).
 * @param {number} h Height of the row (px).
 */
const addRow = (areas, region, names, x, y, width, h) => {
    const gap = 10;
    const w = (width - gap * (names.length - 1)) / names.length;
    names.forEach((name, i) => areas.push(area(region, name, x + i * (w + gap), y, w, h)));
};

/**
 * The layout of the Sculpt page of the board (or of the whole board when there is only that page).
 *
 * @param {boolean} readonly Whether only Exit VR is shown.
 * @param {boolean} [methodswitch] Whether the Sculpt | Model switch heads the page.
 * @param {number} [height] Canvas height (px), for a board shared with the taller Model page.
 * @returns {Object} {height, areas: Object[], labels: {size: Object, strength: Object}, help: Object|null, model: false}
 */
const layout = (readonly, methodswitch, height) => {
    if (readonly) {
        return {
            height: CANVAS_HEIGHT_READONLY,
            areas: [area('exit', null, PAD, PAD, CANVAS_WIDTH - 2 * PAD, CANVAS_HEIGHT_READONLY - 2 * PAD)],
            labels: null,
            help: null,
            model: false,
        };
    }
    const areas = [];
    const top = methodswitch ? SWITCH_HEIGHT : 0;
    const canvasheight = height || CANVAS_HEIGHT;
    if (methodswitch) {
        addRow(areas, 'method', ['sculpt', 'model'], PAD, PAD, CANVAS_WIDTH - 2 * PAD, SWITCH_HEIGHT - PAD);
    }
    const toolwidth = (CANVAS_WIDTH - PAD * (TOOLS_PER_ROW + 1)) / TOOLS_PER_ROW;
    TOOLS.forEach((tool, i) => {
        const column = i % TOOLS_PER_ROW;
        const row = Math.floor(i / TOOLS_PER_ROW);
        areas.push(area('tool', tool, PAD + column * (toolwidth + PAD), top + PAD + row * (120 + PAD), toolwidth, 120));
    });
    const labelwidth = 230;
    const barx = PAD + labelwidth + PAD;
    const barwidth = CANVAS_WIDTH - barx - PAD;
    areas.push(area('size', null, barx, top + 302, barwidth, 90));
    areas.push(area('strength', null, barx, top + 408, barwidth, 90));
    const buttonwidth = (CANVAS_WIDTH - 5 * PAD) / 4;
    areas.push(area('undo', null, PAD, top + 516, buttonwidth, 100));
    areas.push(area('redo', null, 2 * PAD + buttonwidth, top + 516, buttonwidth, 100));
    areas.push(area('mirror', null, 3 * PAD + 2 * buttonwidth, top + 516, buttonwidth, 100));
    areas.push(area('exit', null, 4 * PAD + 3 * buttonwidth, top + 516, buttonwidth, 100));
    return {
        height: canvasheight,
        areas: areas,
        labels: {
            size: {x: PAD, y: top + 302, w: labelwidth, h: 90},
            strength: {x: PAD, y: top + 408, w: labelwidth, h: 90},
        },
        help: {x: PAD, y: top + 636, w: CANVAS_WIDTH - 2 * PAD, h: canvasheight - top - 636 - PAD},
        model: false,
    };
};

/**
 * The layout of the Model page of the board.
 *
 * @param {boolean} methodswitch Whether the Sculpt | Model switch heads the page.
 * @returns {Object} {height, areas: Object[], labels: {axis, segments, value, shapes}, help: Object, model: true}
 */
const modelLayout = (methodswitch) => {
    const areas = [];
    const top = methodswitch ? SWITCH_HEIGHT : 0;
    const height = CANVAS_HEIGHT_MODEL + top;
    const full = CANVAS_WIDTH - 2 * PAD;
    if (methodswitch) {
        addRow(areas, 'method', ['sculpt', 'model'], PAD, PAD, full, SWITCH_HEIGHT - PAD);
    }
    let y = top + PAD;
    addRow(areas, 'selmode', SELECT_MODES, PAD, y, full, 84);
    y += 96;
    addRow(areas, 'selcmd', SELECT_COMMANDS, PAD, y, full, 68);
    y += 80;
    addRow(areas, 'action', ACTIONS.slice(0, 4), PAD, y, full, 84);
    y += 96;
    addRow(areas, 'action', ACTIONS.slice(4), PAD, y, full, 84);
    y += 96;
    const labels = {
        axis: {x: PAD, y: y, w: 110, h: 68},
        segments: {x: 506, y: y, w: 190, h: 68},
        value: {x: 788, y: y, w: 104, h: 68},
        shapes: {x: PAD, y: y + 80, w: 150, h: 68},
    };
    addRow(areas, 'axis', AXES, 126, y, 368, 68);
    areas.push(area('segdown', null, 696, y, 92, 68));
    areas.push(area('segup', null, 892, y, CANVAS_WIDTH - PAD - 892, 68));
    y += 80;
    addRow(areas, 'shape', MESH_SHAPES, PAD + 160, y, full - 160, 68);
    y += 80;
    addRow(areas, 'oneshot', ONESHOTS, PAD, y, full, 68);
    y += 80;
    addRow(areas, 'undo', [null], PAD, y, (full - 20) / 3, 76);
    addRow(areas, 'redo', [null], PAD + (full - 20) / 3 + 10, y, (full - 20) / 3, 76);
    addRow(areas, 'exit', [null], PAD + 2 * ((full - 20) / 3 + 10), y, (full - 20) / 3, 76);
    y += 88;
    return {
        height: height,
        areas: areas,
        labels: labels,
        help: {x: PAD, y: y, w: full, h: height - y - PAD},
        model: true,
    };
};

/**
 * The string key of a choice button of the board.
 *
 * @param {Object} a Area of the button.
 * @returns {string} String key.
 */
const choiceKey = (a) => {
    switch (a.region) {
        case 'tool':
            return 'tool_' + a.tool;
        case 'method':
            return 'method_' + a.tool;
        case 'selmode':
            return SELECT_MODE_KEYS[a.tool];
        case 'selcmd':
            return SELECT_COMMAND_KEYS[a.tool];
        case 'action':
            return 'action_' + a.tool;
        case 'axis':
            return 'axis_' + a.tool;
        case 'shape':
            return 'mshape_' + a.tool;
        default:
            return 'oneshot_' + a.tool;
    }
};

/**
 * Whether a choice button shows what is chosen now.
 *
 * @param {Object} a Area of the button.
 * @param {Object} state The board state.
 * @returns {boolean}
 */
const choiceSelected = (a, state) => {
    switch (a.region) {
        case 'tool':
            return state.tool === a.tool;
        case 'method':
            return state.method === a.tool;
        case 'selmode':
            return state.selectmode === a.tool;
        case 'selcmd':
            return a.tool === 'loop' && state.looparmed;
        case 'action':
            return state.action === a.tool;
        case 'axis':
            return state.axis === a.tool;
        case 'oneshot':
            return a.tool === 'bake' && state.bakearmed;
        default:
            return false;
    }
};

/**
 * Whether an area is a button that chooses something (rather than a bar or a fixed button).
 *
 * @param {string} region Region of the area.
 * @returns {boolean}
 */
const isChoice = (region) => ['tool', 'method', 'selmode', 'selcmd', 'action', 'axis', 'shape', 'oneshot'].includes(region);

/**
 * Whether a button of the board can be used now.
 *
 * @param {string} region 'undo', 'redo', 'mirror' or 'exit'.
 * @param {Object} state The board state.
 * @returns {boolean}
 */
const buttonEnabled = (region, state) => {
    if (region === 'undo') {
        return state.canundo;
    }
    return region === 'redo' ? state.canredo : true;
};

/**
 * The colour of a button of the board.
 *
 * @param {string} region 'undo', 'redo', 'mirror' or 'exit'.
 * @param {Object} state The board state.
 * @param {boolean} enabled Whether it can be used.
 * @param {boolean} hovered Whether the pointer is on it.
 * @returns {string} CSS colour.
 */
const buttonFill = (region, state, enabled, hovered) => {
    if (region === 'exit') {
        return hovered ? COLOURS.exithover : COLOURS.exit;
    }
    if (region === 'mirror' && state.mirror) {
        return COLOURS.selected;
    }
    if (!enabled) {
        return COLOURS.disabled;
    }
    return hovered ? COLOURS.hover : COLOURS.button;
};

/**
 * A rounded rectangle path.
 *
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius.
 */
const roundRect = (ctx, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
};

/**
 * A text as one line of plain text (control characters removed, white space collapsed).
 *
 * @param {*} value Text.
 * @returns {string}
 */
const plain = (value) => String(value === null || value === undefined ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Draw a text centred in a box, shrinking the font until it fits.
 *
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {string} text Plain text.
 * @param {Object} box {x, y, w, h}
 * @param {number} size Largest font size (px).
 * @param {string} colour Fill style.
 * @param {string} align 'center' or 'left'.
 */
const fitText = (ctx, text, box, size, colour, align) => {
    let px = size;
    ctx.font = `600 ${px}px sans-serif`;
    const space = box.w - 24;
    while (px > 16 && ctx.measureText(text).width > space) {
        px -= 2;
        ctx.font = `600 ${px}px sans-serif`;
    }
    ctx.fillStyle = colour;
    ctx.textBaseline = 'middle';
    ctx.textAlign = align;
    const x = align === 'left' ? box.x + 12 : box.x + box.w / 2;
    ctx.fillText(text, x, box.y + box.h / 2 + 1, space);
};

/**
 * Draw a paragraph wrapped into a box (lines that do not fit are left out).
 *
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {string} text Plain text.
 * @param {Object} box {x, y, w, h}
 * @param {number} size Font size (px).
 * @param {string} colour Fill style.
 */
const wrapText = (ctx, text, box, size, colour) => {
    ctx.font = `400 ${size}px sans-serif`;
    ctx.fillStyle = colour;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lineheight = Math.round(size * 1.3);
    const maxlines = Math.max(1, Math.floor(box.h / lineheight));
    const words = text.split(' ').filter((w) => w !== '');
    const lines = [];
    let line = '';
    words.forEach((word) => {
        const candidate = line ? line + ' ' + word : word;
        if (line && ctx.measureText(candidate).width > box.w) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    });
    if (line) {
        lines.push(line);
    }
    lines.slice(0, maxlines).forEach((l, i) => ctx.fillText(l, box.x, box.y + i * lineheight, box.w));
};

/**
 * Create the wrist palette.
 *
 * Options: strings (an object of the mod_vrmakerspace strings by key: tool_grab … tool_cutshape,
 * brushsize, brushstrength, undo, redo, mirror, exitvr, vrhelp, and MODEL_STRING_KEYS when modelling
 * is allowed), readonly (only Exit VR is shown), methods ('both', 'model' or, by default, 'sculpt':
 * which pages exist), method ('sculpt' or 'model': the page shown first).
 *
 * The board lies in the x/y plane of its object (facing +z), centred on the object's origin. The
 * caller places the object (it sets object.matrix itself; matrixAutoUpdate is off) and keeps
 * object.matrixWorld current before calling hitRay() or hitPoint().
 *
 * A hit is one reused object {region, tool, key, value, distance}: region 'tool' (tool = the tool
 * name), 'size' or 'strength' (value = 0..1 along the bar), 'undo', 'redo', 'mirror' or 'exit', or
 * on the method switch and the Model page 'method' (tool = 'sculpt' or 'model'), 'selmode' ('v', 'e', 'f'),
 * 'selcmd' ('all', 'none', 'linked', 'loop'), 'action', 'axis' ('free', 'x', 'y', 'z'), 'segdown', 'segup',
 * 'shape' or 'oneshot' (tool = the name); distance is along the ray (hitRay) or from the board's plane
 * (hitPoint), in metres.
 *
 * @param {Object} THREE three.js namespace.
 * @param {Object} options Options.
 * @returns {Object} Palette {object, width, height, setState(tool, size, strength, canundo, canredo),
 *     setMethod(name), setModelState(state), setHover(key|null), hitRay(origin, direction, far),
 *     hitPoint(point, depth), dispose()}
 */
export const createPalette = (THREE, options = {}) => {
    const strings = options.strings || {};
    const readonly = !!options.readonly;
    /**
     * A string of the palette as plain text.
     *
     * @param {string} key String key.
     * @returns {string}
     */
    const text = (key) => plain(strings[key]);
    /**
     * A string of the Model page, or its key while it is missing, so a button is never blank.
     *
     * @param {string} key String key.
     * @returns {string}
     */
    const modelText = (key) => text(key) || key;
    const methods = !readonly && (options.methods === 'both' || options.methods === 'model') ? options.methods : 'sculpt';
    const pages = {
        sculpt: methods === 'model' ? null :
            layout(readonly, methods === 'both', methods === 'both' ? CANVAS_HEIGHT_MODEL + SWITCH_HEIGHT : CANVAS_HEIGHT),
        model: methods === 'sculpt' ? null : modelLayout(methods === 'both'),
    };
    let plan = pages.model && (!pages.sculpt || options.method === 'model') ? pages.model : pages.sculpt;
    const boardheight = BOARD_WIDTH * plan.height / CANVAS_WIDTH;

    const group = new THREE.Group();
    group.name = 'vrmakerspace-palette';
    group.matrixAutoUpdate = false;
    group.visible = false;

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = plan.height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(BOARD_WIDTH, boardheight);
    const material = new THREE.MeshBasicMaterial({map: texture, transparent: true, depthTest: false});
    const board = new THREE.Mesh(geometry, material);
    board.name = 'vrmakerspace-palette-board';
    board.renderOrder = 30;
    board.raycast = noRaycast;
    group.add(board);

    const inverse = new THREE.Matrix4();
    const localorigin = new THREE.Vector3();
    const localdirection = new THREE.Vector3();
    const localpoint = new THREE.Vector3();
    const hit = {region: '', tool: null, key: '', value: 0, distance: 0};

    const state = {tool: '', size: -1, strength: -1, canundo: false, canredo: false, mirror: false, hover: null,
        method: plan.model ? 'model' : 'sculpt', selectmode: '', action: '', axis: 'free', segments: 1,
        looparmed: false, bakearmed: false};
    let drawn = false;
    let disposed = false;

    /**
     * Draw what only the Model page has: its labels, the segment count and its help.
     *
     * @param {CanvasRenderingContext2D} ctx Context.
     */
    const drawModelTexts = (ctx) => {
        fitText(ctx, modelText('axislock'), plan.labels.axis, 32, COLOURS.text, 'left');
        fitText(ctx, modelText('segments'), plan.labels.segments, 32, COLOURS.text, 'left');
        fitText(ctx, String(state.segments), plan.labels.value, 40, COLOURS.text, 'center');
        fitText(ctx, modelText('addshape'), plan.labels.shapes, 32, COLOURS.text, 'left');
        wrapText(ctx, text('vrmodelhelp') + ' ' + text('vrmodelselecthelp'), plan.help, 26, COLOURS.help);
    };

    /**
     * Redraw the board from the state.
     *
     * @returns {undefined}
     */
    const draw = () => {
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }
        ctx.clearRect(0, 0, CANVAS_WIDTH, plan.height);
        ctx.fillStyle = COLOURS.board;
        roundRect(ctx, 0, 0, CANVAS_WIDTH, plan.height, 28);
        ctx.fill();
        plan.areas.forEach((a) => {
            const hovered = state.hover === a.key;
            if (isChoice(a.region)) {
                let fill = hovered ? COLOURS.hover : COLOURS.button;
                if (choiceSelected(a, state)) {
                    fill = a.region === 'oneshot' ? COLOURS.exit : COLOURS.selected;
                }
                ctx.fillStyle = fill;
                roundRect(ctx, a.x, a.y, a.w, a.h, 18);
                ctx.fill();
                if (a.region === 'tool') {
                    fitText(ctx, text('tool_' + a.tool), a, 40, COLOURS.text, 'center');
                } else {
                    fitText(ctx, modelText(choiceKey(a)), a, 34, COLOURS.text, 'center');
                }
            } else if (a.region === 'segdown' || a.region === 'segup') {
                ctx.fillStyle = hovered ? COLOURS.hover : COLOURS.button;
                roundRect(ctx, a.x, a.y, a.w, a.h, 18);
                ctx.fill();
                fitText(ctx, a.region === 'segdown' ? '\u2212' : '+', a, 44, COLOURS.text, 'center');
            } else if (a.region === 'size' || a.region === 'strength') {
                const value = a.region === 'size' ?
                    (state.size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN) : state.strength;
                const share = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
                ctx.fillStyle = hovered ? COLOURS.hover : COLOURS.bar;
                roundRect(ctx, a.x, a.y, a.w, a.h, 18);
                ctx.fill();
                if (share > 0) {
                    ctx.fillStyle = COLOURS.fill;
                    roundRect(ctx, a.x, a.y, Math.max(36, a.w * share), a.h, 18);
                    ctx.fill();
                }
                // The handle.
                ctx.fillStyle = COLOURS.text;
                ctx.beginPath();
                ctx.arc(a.x + Math.max(18, Math.min(a.w - 18, a.w * share)), a.y + a.h / 2, 14, 0, Math.PI * 2);
                ctx.fill();
            } else {
                const enabled = buttonEnabled(a.region, state);
                ctx.fillStyle = buttonFill(a.region, state, enabled, hovered);
                roundRect(ctx, a.x, a.y, a.w, a.h, 18);
                ctx.fill();
                fitText(ctx, text(a.region === 'exit' ? 'exitvr' : a.region), a, 42,
                    enabled ? COLOURS.text : COLOURS.muted, 'center');
            }
        });
        if (plan.model) {
            drawModelTexts(ctx);
        } else {
            if (plan.labels) {
                fitText(ctx, text('brushsize'), plan.labels.size, 38, COLOURS.text, 'left');
                fitText(ctx, text('brushstrength'), plan.labels.strength, 38, COLOURS.text, 'left');
            }
            if (plan.help) {
                wrapText(ctx, text('vrhelp'), plan.help, 30, COLOURS.help);
            }
        }
        texture.needsUpdate = true;
        drawn = true;
    };

    /**
     * Fill the hit from a point of the board's plane.
     *
     * @param {number} x Plane x (m).
     * @param {number} y Plane y (m).
     * @param {number} distance Distance to report (m).
     * @returns {Object|null} The hit, or null outside every control.
     */
    const pick = (x, y, distance) => {
        const px = (x / BOARD_WIDTH + 0.5) * CANVAS_WIDTH;
        const py = (0.5 - y / boardheight) * plan.height;
        if (px < 0 || px > CANVAS_WIDTH || py < 0 || py > plan.height) {
            return null;
        }
        for (let i = 0; i < plan.areas.length; i++) {
            const a = plan.areas[i];
            if (px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h) {
                hit.region = a.region;
                hit.tool = a.tool;
                hit.key = a.key;
                hit.value = Math.min(1, Math.max(0, (px - a.x) / a.w));
                hit.distance = distance;
                return hit;
            }
        }
        return null;
    };

    /**
     * Refresh the inverse of the board's world matrix.
     *
     * @returns {boolean} Whether the board can be hit now.
     */
    const prepare = () => {
        if (disposed || !group.visible || !drawn) {
            return false;
        }
        inverse.copy(group.matrixWorld).invert();
        return true;
    };

    return {
        object: group,

        /** Board width in the room (m). */
        width: BOARD_WIDTH,

        /** Board height in the room (m). */
        height: boardheight,

        /**
         * Show the current tool, size, strength and the undo and redo state (redrawn on a change).
         *
         * @param {string} tool Tool name.
         * @param {number} size Brush radius (m).
         * @param {number} strength 0..1.
         * @param {boolean} canundo Whether Undo is possible.
         * @param {boolean} canredo Whether Redo is possible.
         * @param {boolean} [mirror] Whether mirroring is on.
         */
        setState(tool, size, strength, canundo, canredo, mirror) {
            if (disposed) {
                return;
            }
            // Quantised so a slowly changing value redraws in visible steps only.
            const qsize = Math.round(Number(size) * 2000) / 2000;
            const qstrength = Math.round(Number(strength) * 200) / 200;
            const name = String(tool || '');
            if (drawn && name === state.tool && qsize === state.size && qstrength === state.strength &&
                    !!canundo === state.canundo && !!canredo === state.canredo && !!mirror === state.mirror) {
                return;
            }
            state.mirror = !!mirror;
            state.tool = name;
            state.size = qsize;
            state.strength = qstrength;
            state.canundo = !!canundo;
            state.canredo = !!canredo;
            draw();
        },

        /**
         * Show the page of a method (ignored for a method the board has no page for).
         *
         * @param {string} name 'sculpt' or 'model'.
         */
        setMethod(name) {
            const page = name === 'model' ? pages.model : pages.sculpt;
            if (disposed || !page || page === plan) {
                return;
            }
            plan = page;
            state.method = name;
            state.hover = null;
            draw();
        },

        /**
         * Show the Model page's state (redrawn on a change).
         *
         * @param {Object} model One reused object {selectmode: 'v'|'e'|'f', action, axis: 'free'|'x'|'y'|'z', segments,
         *     looparmed: boolean, bakearmed: boolean}.
         */
        setModelState(model) {
            if (disposed || !pages.model) {
                return;
            }
            if (drawn && model.selectmode === state.selectmode && model.action === state.action &&
                    model.axis === state.axis && model.segments === state.segments &&
                    model.looparmed === state.looparmed && model.bakearmed === state.bakearmed) {
                return;
            }
            state.selectmode = model.selectmode;
            state.action = model.action;
            state.axis = model.axis;
            state.segments = model.segments;
            state.looparmed = model.looparmed;
            state.bakearmed = model.bakearmed;
            draw();
        },

        /**
         * Highlight the control under the pointer.
         *
         * @param {string|null} key A hit's key, or null for none.
         */
        setHover(key) {
            const value = key || null;
            if (disposed || value === state.hover) {
                return;
            }
            state.hover = value;
            draw();
        },

        /**
         * The control a ray points at.
         *
         * @param {Object} origin THREE.Vector3, world.
         * @param {Object} direction THREE.Vector3, world, unit length.
         * @param {number} far Furthest distance (m).
         * @returns {Object|null} The hit (reused object) or null.
         */
        hitRay(origin, direction, far) {
            if (!prepare()) {
                return null;
            }
            localorigin.copy(origin).applyMatrix4(inverse);
            localdirection.copy(direction).transformDirection(inverse);
            if (Math.abs(localdirection.z) < 1e-6) {
                return null;
            }
            const t = -localorigin.z / localdirection.z;
            if (!(t >= 0) || t > far) {
                return null;
            }
            return pick(localorigin.x + localdirection.x * t, localorigin.y + localdirection.y * t, t);
        },

        /**
         * The control a fingertip touches.
         *
         * @param {Object} point THREE.Vector3, world.
         * @param {number} depth Largest distance from the board's plane (m).
         * @returns {Object|null} The hit (reused object) or null.
         */
        hitPoint(point, depth) {
            if (!prepare()) {
                return null;
            }
            localpoint.copy(point).applyMatrix4(inverse);
            if (Math.abs(localpoint.z) > depth) {
                return null;
            }
            return pick(localpoint.x, localpoint.y, Math.abs(localpoint.z));
        },

        /** Remove the palette and release its resources. */
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            if (group.parent) {
                group.parent.remove(group);
            }
            geometry.dispose();
            texture.dispose();
            material.dispose();
        },
    };
};
