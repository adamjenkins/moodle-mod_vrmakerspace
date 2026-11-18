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
 * Tests of the tutor's demonstrations (mod_vrmakerspace/tutordemos): the path and face helpers, a clay demo
 * against stand-in tools, and the mesh demos against the real mesh tools and document.
 *
 * Run from the repository root: node --test tests/js/tutordemos.test.mjs
 *
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_NAMES, demo, ease, frontFace, meshTop, pathLengths, pointAlong, rotateAbout, shapeSpot, sideEdge,
    sweepDirections, topEdge, viewBasis} from '../../amd/src/tutordemos.js';
import {createModelTools} from '../../amd/src/modeltools.js';
import {PolyDoc, renderData} from '../../js/engine/polymesh.js';
import {addPrimitive} from '../../js/engine/polyprims.js';
import {applyMeshOp, cleanMeshOp} from '../../js/engine/polyops.js';

/** The strings the demos say. */
const STRINGS = {tutor_watch: 'watch', tutor_demofailed: 'failed', tutor_demonomesh: 'nomesh'};

/** Where the studio camera starts, sculpture-local. */
const VIEWER = [0, 0.12, 0.62];

/**
 * Asserts that two numbers are close.
 *
 * @param {number} actual The value.
 * @param {number} expected What it should be.
 * @param {number} [eps] How close.
 */
const near = (actual, expected, eps = 1e-6) => {
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} should be within ${eps} of ${expected}`);
};

/**
 * The dot product.
 *
 * @param {number[]} a Vector.
 * @param {number[]} b Vector.
 * @returns {number}
 */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A document holding one cube of half-extent 0.08 at the origin.
 *
 * @returns {PolyDoc}
 */
const cubeDoc = () => {
    const doc = new PolyDoc();
    addPrimitive(doc, 'cube', 'start', 1, [0, 0, 0], 0.08);
    return doc;
};

/**
 * The parts of a demo context the tutor gives, with frames that come at once.
 *
 * @param {Object} extra The studio's part.
 * @param {Function} [onFrame] Called at every frame.
 * @returns {Object} The context, with `said` (messages), `hands` (hand positions) and `spots` (working spots reported,
 *     each {point, acted: what `acted()` gave then}).
 */
const context = (extra, onFrame = () => undefined) => {
    const ctx = {
        said: [],
        hands: [],
        spots: [],
        acted: () => 0,
        onSpot: (point) => {
            ctx.spots.push({point, acted: ctx.acted()});
            return Promise.resolve(true);
        },
        strings: STRINGS,
        message: (text) => ctx.said.push(text),
        view: () => VIEWER.slice(),
        hand: (position) => {
            if (position) {
                ctx.hands.push(position);
            }
        },
        handPosition: () => [0, 0, 0],
        frame: () => {
            onFrame();
            return Promise.resolve(0.05);
        },
        cancelled: () => false,
        log: (error) => {
            throw error;
        },
    };
    return Object.assign(ctx, extra);
};

/**
 * Stand-in clay tools that record what they are told.
 *
 * @returns {Object}
 */
const fakeTools = () => {
    const tools = {
        tool: 'grab',
        mirror: false,
        size: 0.02,
        active: false,
        calls: [],
        setTool: (name) => {
            tools.tool = name;
        },
        setMirror: (on) => {
            tools.mirror = on;
        },
        begin: (p, opts) => {
            tools.calls.push(['begin', p, opts, tools.tool, tools.mirror]);
            tools.active = !['shape', 'cutshape'].includes(tools.tool);
            return true;
        },
        move: (p, opts) => tools.calls.push(['move', p, opts]),
        end: () => {
            if (tools.active) {
                tools.calls.push(['end']);
            }
            tools.active = false;
        },
    };
    return tools;
};

/**
 * The mesh tools against a real document; drawing data arrives a frame after an op.
 *
 * @param {PolyDoc} doc The document.
 * @returns {Object} {doc, model, engine, sent, kinds(), frame()}
 */
const meshRig = (doc) => {
    const listeners = new Map();
    const queue = [];
    const rig = {doc, time: 1000, sent: [], messages: []};
    let index = 0;
    let stroke = 100;
    let data = renderData(doc);
    const session = {
        author: () => 'u1',
        peers: () => [],
        submit: (op) => {
            rig.sent.push(op);
            index++;
            if (op.k === 'end' || op.k === 'undo') {
                return true;
            }
            const clean = cleanMeshOp(Object.assign({}, op, {a: 'u1', i: index}));
            assert.ok(clean, 'a valid op: ' + JSON.stringify(op));
            const result = applyMeshOp(doc, clean);
            queue.push(result.ok ? ['polymesh', renderData(doc)] : ['meshrefused', {op: clean, reason: result.reason}]);
            return true;
        },
    };
    rig.engine = {
        polydata: () => data,
        preview: () => undefined,
        on: (type, fn) => {
            listeners.set(type, (listeners.get(type) || []).concat([fn]));
            return () => undefined;
        },
    };
    rig.model = createModelTools({
        session,
        tools: {allocStroke: () => ++stroke, recordStroke: () => undefined, forgetStroke: () => undefined},
        engine: rig.engine,
        onMessage: (key) => rig.messages.push(key),
        now: () => rig.time,
    });
    rig.frame = () => {
        rig.time += 50;
        queue.splice(0).forEach(([type, detail]) => {
            if (type === 'polymesh') {
                data = detail;
            }
            (listeners.get(type) || []).forEach((fn) => fn(detail));
        });
    };
    rig.kinds = () => rig.sent.map((op) => op.k);
    return rig;
};

/**
 * A demo context for the mesh demos, in the Model method.
 *
 * @param {Object} rig From meshRig().
 * @returns {Object} The context; `method` is what the studio is in.
 */
const modelContext = (rig) => {
    let method = 'model';
    return context({
        tools: null,
        modeltools: rig.model,
        engine: rig.engine,
        method: () => method,
        setMethod: (name) => {
            method = name;
        },
    }, rig.frame);
};

test('ease starts and ends still and is symmetric', () => {
    near(ease(0), 0);
    near(ease(1), 1);
    near(ease(0.5), 0.5);
    near(ease(0.25) + ease(0.75), 1);
    near(ease(-1), 0);
    near(ease(2), 1);
    assert.ok(ease(0.1) < 0.1);
});

test('viewBasis gives unit vectors at right angles, right being +x from the front', () => {
    const b = viewBasis(VIEWER);
    [b.d, b.right, b.up].forEach((v) => near(Math.hypot(...v), 1));
    near(dot(b.d, b.right), 0);
    near(dot(b.d, b.up), 0);
    near(dot(b.right, b.up), 0);
    near(b.right[0], 1);
    assert.ok(b.up[1] > 0.9);
    const top = viewBasis([0, 1, 0]);
    near(top.right[0], 1);
    assert.deepEqual(viewBasis(null).d, viewBasis(VIEWER).d);
});

test('sweepDirections runs from one turn to the other in unit steps', () => {
    const b = viewBasis([0, 0, 1]);
    const dirs = sweepDirections(b, [-0.5, 0.5, 0, 0], 5);
    assert.equal(dirs.length, 5);
    dirs.forEach((v) => near(Math.hypot(...v), 1));
    near(dirs[2][0], 0);
    near(dirs[2][2], 1);
    near(dirs[0][0], -Math.sin(0.5));
    near(dirs[4][0], Math.sin(0.5));
});

test('pointAlong walks a path by its length', () => {
    const points = [[0, 0, 0], [1, 0, 0], [1, 3, 0]];
    const lengths = pathLengths(points);
    assert.deepEqual(lengths, [0, 1, 4]);
    assert.deepEqual(pointAlong(points, lengths, 0), [0, 0, 0]);
    assert.deepEqual(pointAlong(points, lengths, 1), [1, 3, 0]);
    const quarter = pointAlong(points, lengths, 0.25);
    near(quarter[0], 1);
    near(quarter[1], 0);
    const half = pointAlong(points, lengths, 0.5);
    near(half[1], 1);
    // A path of no length goes by count.
    const still = [[1, 1, 1], [1, 1, 1]];
    assert.deepEqual(pointAlong(still, pathLengths(still), 0.5), [1, 1, 1]);
});

test('rotateAbout turns anticlockwise about the axis', () => {
    const v = rotateAbout([1, 0, 0], [0, 0, 1], Math.PI / 2);
    near(v[0], 0);
    near(v[1], 1);
    near(v[2], 0);
});

test('frontFace finds the face towards the viewer, with its top and upright edges', () => {
    const data = renderData(cubeDoc());
    const face = frontFace(data, viewBasis(VIEWER).d);
    assert.ok(face);
    near(face.normal[2], 1, 1e-4);
    near(face.centroid[2], 0.08, 1e-4);
    assert.equal(face.corners.length, 4);
    const top = topEdge(face, [0, 1, 0]);
    near(top.mid[1], 0.08, 1e-4);
    const side = sideEdge(face, [0, 1, 0]);
    near(Math.abs(side.pb[1] - side.pa[1]), 0.16, 1e-4);
    assert.equal(frontFace(renderData(new PolyDoc()), [0, 0, 1]), null);
    assert.equal(frontFace(null, [0, 0, 1]), null);
    near(meshTop(data), 0.08, 1e-4);
    assert.equal(meshTop(null), null);
});

test('shapeSpot puts a new shape above the piece, within reach', () => {
    assert.deepEqual(shapeSpot(null), [0, 0, 0]);
    near(shapeSpot(0.09)[1], 0.165);
    near(shapeSpot(1)[1], 0.3);
});

test('every demo of the tour has a name', () => {
    ['add', 'carve', 'smooth', 'inflate', 'pinch', 'flatten', 'grab', 'twist', 'mirror', 'shape', 'cutshape', 'addshape',
        'select', 'move', 'rotate', 'scale', 'extrude', 'inset', 'bevel', 'loopcut'].forEach((name) => {
        assert.ok(DEMO_NAMES.includes(name), name);
    });
});

test('a brush demo makes one stroke over the piece and puts the tool back', async() => {
    const tools = fakeTools();
    let method = 'model';
    const ctx = context({tools, method: () => method, setMethod: (name) => {
        method = name;
    }});
    assert.equal(await demo('add', ctx), true);
    const begins = tools.calls.filter((c) => c[0] === 'begin');
    assert.equal(begins.length, 1);
    assert.equal(begins[0][3], 'add');
    assert.ok(tools.calls.filter((c) => c[0] === 'move').length >= 10);
    assert.equal(tools.calls.filter((c) => c[0] === 'end').length, 1);
    // Without three.js the path lies at the lump's radius, on the viewer's side.
    tools.calls.filter((c) => c[0] === 'move').forEach((c) => {
        near(Math.hypot(...c[1]), 0.1, 1e-3);
        assert.ok(c[1][2] > 0);
    });
    assert.equal(tools.tool, 'grab');
    assert.equal(method, 'model');
    assert.deepEqual(ctx.said, ['watch']);
    assert.ok(ctx.hands.length > 10);
});

test('the mirror demo strokes with mirror on and turns it off again', async() => {
    const tools = fakeTools();
    const ctx = context({tools, method: () => 'sculpt', setMethod: () => undefined});
    assert.equal(await demo('mirror', ctx), true);
    const begin = tools.calls.find((c) => c[0] === 'begin');
    assert.equal(begin[4], true);
    assert.ok(begin[1][0] > 0);
    assert.equal(tools.mirror, false);
});

test('twist turns about the view axis, and a shape is placed with one click', async() => {
    const tools = fakeTools();
    const ctx = context({tools, method: () => 'sculpt', setMethod: () => undefined});
    assert.equal(await demo('twist', ctx), true);
    const moves = tools.calls.filter((c) => c[0] === 'move');
    near(moves[moves.length - 1][2].angle, 1);
    tools.calls.length = 0;
    assert.equal(await demo('shape', ctx), true);
    assert.equal(tools.calls.filter((c) => c[0] === 'begin').length, 1);
    assert.equal(tools.calls.filter((c) => c[0] === 'move').length, 0);
});

test('a demo that cannot run says so and resolves false', async() => {
    const tools = fakeTools();
    // An activity with only Model: the switch to Sculpt does nothing.
    const ctx = context({tools, method: () => 'model', setMethod: () => undefined});
    assert.equal(await demo('carve', ctx), false);
    assert.equal(tools.calls.length, 0);
    assert.deepEqual(ctx.said, ['watch', 'failed']);
    const other = context({tools});
    assert.equal(await demo('nosuchdemo', other), false);
    assert.deepEqual(other.said, ['failed']);
    const nomodel = context({tools, modeltools: null, method: () => 'model', setMethod: () => undefined});
    assert.equal(await demo('extrude', nomodel), false);
    assert.deepEqual(nomodel.said, ['watch', 'failed']);
});

test('the extrude demo selects the front face, extrudes it and puts the action back', async() => {
    const rig = meshRig(cubeDoc());
    rig.model.setSelectMode('v');
    const before = rig.doc.faces.size;
    assert.equal(await demo('extrude', modelContext(rig)), true);
    assert.ok(rig.kinds().includes('msel'));
    assert.ok(rig.kinds().includes('mext'));
    rig.frame();
    assert.ok(rig.doc.faces.size > before);
    assert.equal(rig.model.action, 'select');
    assert.equal(rig.model.axis, null);
    assert.equal(rig.model.active, false);
    assert.equal(rig.model.selectMode, 'v');
});

test('the move, rotate and scale demos each send transforms', async() => {
    for (const name of ['move', 'rotate', 'scale']) {
        const rig = meshRig(cubeDoc());
        assert.equal(await demo(name, modelContext(rig)), true, name);
        assert.ok(rig.sent.some((op) => op.k === 'mxf'), name);
        assert.equal(rig.model.action, 'select', name);
    }
});

test('inset, bevel and loop cut each send their op', async() => {
    const expected = {inset: 'minset', bevel: 'mbevel', loopcut: 'mloop'};
    for (const name of Object.keys(expected)) {
        const rig = meshRig(cubeDoc());
        assert.equal(await demo(name, modelContext(rig)), true, name);
        assert.ok(rig.kinds().includes(expected[name]), name + ': ' + rig.kinds().join(' '));
        assert.deepEqual(rig.messages, [], name);
    }
});

test('with no mesh, a mesh demo adds a cube first; add shape adds one', async() => {
    const rig = meshRig(new PolyDoc());
    assert.equal(await demo('select', modelContext(rig)), true);
    assert.equal(rig.kinds()[0], 'mprim');
    assert.ok(rig.kinds().includes('msel'));
    const empty = meshRig(new PolyDoc());
    const ctx = modelContext(empty);
    assert.equal(await demo('addshape', ctx), true);
    assert.deepEqual(empty.kinds().filter((k) => k !== 'end'), ['mprim']);
    empty.frame();
    assert.ok(empty.doc.faces.size > 0);
});

test('a demo called off stops, ends its stroke and puts the tool back', async() => {
    const tools = fakeTools();
    let frames = 0;
    const ctx = context({tools, method: () => 'sculpt', setMethod: () => undefined}, () => {
        frames++;
    });
    ctx.cancelled = () => frames > 15;
    assert.equal(await demo('smooth', ctx), false);
    assert.equal(tools.active, false);
    assert.equal(tools.tool, 'grab');
    assert.deepEqual(ctx.said, ['watch']);
});

/**
 * Asserts that a working spot is a sculpture-local point near the piece.
 *
 * @param {*} point The spot.
 * @param {string} name The demo.
 */
const nearPiece = (point, name) => {
    assert.ok(Array.isArray(point) && point.length === 3 && point.every(Number.isFinite), name);
    assert.ok(Math.hypot(...point) < 0.5, name);
};

test('every clay demo reports its working spot before its first action', async() => {
    for (const name of ['add', 'carve', 'smooth', 'inflate', 'pinch', 'flatten', 'grab', 'twist', 'mirror', 'shape',
        'cutshape']) {
        const tools = fakeTools();
        const ctx = context({tools, method: () => 'sculpt', setMethod: () => undefined});
        ctx.acted = () => tools.calls.length;
        assert.equal(await demo(name, ctx), true, name);
        assert.ok(ctx.spots.length >= 1, name);
        assert.equal(ctx.spots[0].acted, 0, name);
        nearPiece(ctx.spots[0].point, name);
    }
});

test('every mesh demo reports its working spot before it sends anything', async() => {
    for (const name of ['addshape', 'select', 'move', 'rotate', 'scale', 'extrude', 'inset', 'bevel', 'loopcut']) {
        const rig = meshRig(name === 'addshape' ? new PolyDoc() : cubeDoc());
        const ctx = modelContext(rig);
        ctx.acted = () => rig.sent.length;
        assert.equal(await demo(name, ctx), true, name);
        assert.ok(ctx.spots.length >= 1, name);
        assert.equal(ctx.spots[0].acted, 0, name);
        nearPiece(ctx.spots[0].point, name);
    }
});

test('a brush demo waits for the flight to its spot', async() => {
    const tools = fakeTools();
    const ctx = context({tools, method: () => 'sculpt', setMethod: () => undefined});
    let land = null;
    ctx.onSpot = () => new Promise((resolve) => {
        land = resolve;
    });
    const running = demo('add', ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(land, 'the spot was reported');
    assert.equal(tools.calls.length, 0);
    land(true);
    assert.equal(await running, true);
    assert.equal(tools.calls.filter((c) => c[0] === 'begin').length, 1);
});

test('a demo called off during the flight does nothing and puts the tool back', async() => {
    const tools = fakeTools();
    let off = false;
    const ctx = context({tools, method: () => 'sculpt', setMethod: () => undefined});
    ctx.cancelled = () => off;
    ctx.onSpot = () => {
        off = true;
        return Promise.resolve(false);
    };
    assert.equal(await demo('carve', ctx), false);
    assert.equal(tools.calls.filter((c) => c[0] === 'begin').length, 0);
    assert.equal(tools.tool, 'grab');
    const rig = meshRig(cubeDoc());
    const mctx = modelContext(rig);
    mctx.cancelled = () => mctx.spots.length > 0;
    assert.equal(await demo('extrude', mctx), false);
    assert.deepEqual(rig.sent, []);
    assert.equal(rig.model.action, 'select');
});
