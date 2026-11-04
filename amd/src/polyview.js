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
 * Draws the mesh layer from the data the engine posts (polymesh.renderData), in the sculpture-local frame.
 *
 * The solid, flat-shaded mesh is always shown, viewers included. When editing, it also shows the edges, the vertices,
 * open edges in red, one's own selection in orange, and the selection of each other person present in a colour of
 * their own. A selection left behind by someone who has gone stays in the document but is not drawn.
 *
 * Buffers are kept and written in place; one that is too small is replaced by one half as large again as needed.
 *
 * three.js comes in as an argument, so this module has no Moodle or three.js imports.
 *
 * @module     mod_vrmakerspace/polyview
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Colour of the mesh layer: a cool blue-grey, so it is told apart from the clay. */
const MESH_COLOUR = 0x7f9cb5;

/** Colour of the edges and vertices while editing. */
const WIRE_COLOUR = 0x1f2933;

/** Colour of open edges (used by one face, or by more than two). */
const OPEN_COLOUR = 0xe03131;

/** Colour of one's own selection. */
const OWN_COLOUR = 0xff8c1a;

/** Width (m) of a vertex dot, and of a selected one. */
const POINT_SIZE = 0.004;
const SELECTED_POINT_SIZE = 0.008;

/** Opacity of a selected face's tint. */
const FACE_TINT = 0.35;

/** Extra room given to a buffer that has to grow, as a factor of the size needed. */
const GROWTH = 1.5;

/** Smallest capacity of a buffer, in items. */
const MIN_CAPACITY = 64;

/** Hues (degrees) other people's colours are chosen from: leaves out the reds and oranges, which mean something else. */
const FIRST_HUE = 70;
const HUE_RANGE = 260;

/**
 * A number from an author id, so everyone sees a person in the same colour.
 *
 * @param {string} author Author id.
 * @returns {number} A non-negative integer.
 */
const hashAuthor = (author) => {
    let hash = 7;
    const text = String(author);
    for (let n = 0; n < text.length; n++) {
        hash = (hash * 31 + text.charCodeAt(n)) % 4294967291;
    }
    return hash;
};

/**
 * Create the view of the mesh layer.
 *
 * @param {Object} THREE The three.js module.
 * @param {Object} parent THREE.Group of the sculpture-local frame.
 * @returns {Object} {setData(data), setShowEditing(on), setOwnAuthor(a), setPresent(authors), meshes(), dispose()}
 */
export const createPolyView = (THREE, parent) => {
    const group = new THREE.Group();
    group.name = 'vrmakerspace-polymesh';
    parent.add(group);

    const editing = new THREE.Group();
    editing.name = 'vrmakerspace-polymesh-editing';
    editing.visible = false;
    group.add(editing);

    /** @type {Object|null} the data on show */
    let data = null;
    let showEditing = false;
    let ownAuthor = '';
    /** @type {Set<string>} the other people present */
    let present = new Set();
    /** @type {Map<string, Object>} author → THREE.Color */
    const colours = new Map();
    const ownColour = new THREE.Color(OWN_COLOUR);

    /**
     * Make a growable attribute.
     *
     * @param {number} itemSize Numbers per item.
     * @param {number} items Capacity in items.
     * @returns {Object} THREE.BufferAttribute
     */
    const makeAttribute = (itemSize, items) => {
        const attribute = new THREE.BufferAttribute(new Float32Array(items * itemSize), itemSize);
        attribute.setUsage(THREE.DynamicDrawUsage);
        return attribute;
    };

    /**
     * Make a geometry with an empty attribute of each name, or sharing one given.
     *
     * @param {Object} attributes Name → item size, or an attribute to share.
     * @returns {Object} THREE.BufferGeometry
     */
    const makeGeometry = (attributes) => {
        const geometry = new THREE.BufferGeometry();
        Object.keys(attributes).forEach((name) => {
            const value = attributes[name];
            geometry.setAttribute(name, typeof value === 'number' ? makeAttribute(value, MIN_CAPACITY) : value);
        });
        geometry.setDrawRange(0, 0);
        return geometry;
    };

    /**
     * Give some geometries an attribute with room for a number of items, replacing it when it is too small.
     *
     * @param {Object[]} geometries The geometries sharing the attribute.
     * @param {string} name Attribute name.
     * @param {number} items Items needed.
     * @returns {Object} The attribute to write to.
     */
    const fit = (geometries, name, items) => {
        const attribute = geometries[0].getAttribute(name);
        if (attribute.count >= items) {
            return attribute;
        }
        const replacement = makeAttribute(attribute.itemSize, Math.ceil(items * GROWTH));
        geometries.forEach((geometry) => {
            geometry.dispose();
            geometry.setAttribute(name, replacement);
        });
        return replacement;
    };

    /**
     * Mark the first numbers of an attribute as changed.
     *
     * @param {Object} attribute The attribute.
     * @param {number} numbers How many numbers were written.
     */
    const touch = (attribute, numbers) => {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, numbers);
        attribute.needsUpdate = true;
    };

    // The solid mesh.
    const solidGeometry = makeGeometry({position: 3, normal: 3});
    solidGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    const solidMaterial = new THREE.MeshStandardMaterial({
        color: MESH_COLOUR,
        roughness: 0.7,
        metalness: 0,
        side: THREE.DoubleSide,
        // Pushed back a little, so the edges and the selection drawn on it are not lost in it.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
    });
    const solid = new THREE.Mesh(solidGeometry, solidMaterial);
    solid.name = 'vrmakerspace-polymesh-solid';
    solid.userData.vrmakerspacePoly = true;
    solid.visible = false;
    group.add(solid);
    const solidList = [solid];
    const noMeshes = [];

    // The wire: edges, open edges and vertices share one position buffer, in the order of the data's vertices.
    const wirePosition = makeAttribute(3, MIN_CAPACITY);
    const edgeGeometry = makeGeometry({position: wirePosition});
    const openGeometry = makeGeometry({position: wirePosition});
    const pointGeometry = makeGeometry({position: wirePosition});
    const wireGeometries = [edgeGeometry, openGeometry, pointGeometry];

    /**
     * Set a wire geometry's index to a list of vertex pairs, replacing the index when it is too small. Disposing of a
     * geometry frees the buffers of its attributes, the shared position among them, so the whole wire starts afresh.
     *
     * @param {Object} geometry The geometry.
     * @param {Uint32Array} indices The indices.
     */
    const writeIndex = (geometry, indices) => {
        let index = geometry.index;
        if (!index || index.count < indices.length) {
            if (index) {
                wireGeometries.forEach((wire) => wire.dispose());
            }
            index = new THREE.BufferAttribute(new Uint32Array(Math.max(MIN_CAPACITY, Math.ceil(indices.length * GROWTH))), 1);
            index.setUsage(THREE.DynamicDrawUsage);
            geometry.setIndex(index);
        }
        index.array.set(indices);
        touch(index, indices.length);
        geometry.setDrawRange(0, indices.length);
    };

    const edgeMaterial = new THREE.LineBasicMaterial({color: WIRE_COLOUR});
    const openMaterial = new THREE.LineBasicMaterial({color: OPEN_COLOUR});
    const pointMaterial = new THREE.PointsMaterial({color: WIRE_COLOUR, size: POINT_SIZE, sizeAttenuation: true});
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    const openLines = new THREE.LineSegments(openGeometry, openMaterial);
    const points = new THREE.Points(pointGeometry, pointMaterial);

    // The selections: coloured per person, written afresh whenever the data or the people change.
    const selFaceGeometry = makeGeometry({position: 3, color: 3});
    const selLineGeometry = makeGeometry({position: 3, color: 3});
    const selPointGeometry = makeGeometry({position: 3, color: 3});
    const selFaceMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: FACE_TINT,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    });
    const selLineMaterial = new THREE.LineBasicMaterial({vertexColors: true});
    const selPointMaterial = new THREE.PointsMaterial({vertexColors: true, size: SELECTED_POINT_SIZE, sizeAttenuation: true});
    const selFaces = new THREE.Mesh(selFaceGeometry, selFaceMaterial);
    const selLines = new THREE.LineSegments(selLineGeometry, selLineMaterial);
    const selPoints = new THREE.Points(selPointGeometry, selPointMaterial);

    // What is drawn on the mesh goes on top of it in this order, and its size changes too often to keep bounds for.
    [edgeLines, openLines, points, selFaces, selLines, selPoints].forEach((object, n) => {
        object.frustumCulled = false;
        object.renderOrder = n + 1;
        editing.add(object);
    });

    /**
     * The colour of a person's selection.
     *
     * @param {string} author Author id.
     * @returns {Object} THREE.Color
     */
    const colourOf = (author) => {
        if (author === ownAuthor) {
            return ownColour;
        }
        let colour = colours.get(author);
        if (!colour) {
            const hue = FIRST_HUE + hashAuthor(author) % HUE_RANGE;
            colour = new THREE.Color().setHSL(hue / 360, 0.8, 0.55);
            colours.set(author, colour);
        }
        return colour;
    };

    /**
     * Write line or point items that take their positions from the data's vertices.
     *
     * @param {Object} geometry The geometry.
     * @param {number[]} corners Vertex indices.
     * @param {Object[]} tints One colour per vertex index.
     */
    const writeCorners = (geometry, corners, tints) => {
        const position = fit([geometry], 'position', corners.length);
        const color = fit([geometry], 'color', corners.length);
        const from = data.vertPos;
        corners.forEach((corner, n) => {
            position.array[n * 3] = from[corner * 3];
            position.array[n * 3 + 1] = from[corner * 3 + 1];
            position.array[n * 3 + 2] = from[corner * 3 + 2];
            color.array[n * 3] = tints[n].r;
            color.array[n * 3 + 1] = tints[n].g;
            color.array[n * 3 + 2] = tints[n].b;
        });
        touch(position, corners.length * 3);
        touch(color, corners.length * 3);
        geometry.setDrawRange(0, corners.length);
    };

    /**
     * Write the tint of the selected faces.
     *
     * @param {Map<number, Object>} tinted Face index → colour.
     */
    const writeFaceTint = (tinted) => {
        let triangles = 0;
        if (tinted.size) {
            data.triFace.forEach((face) => {
                triangles += tinted.has(face) ? 1 : 0;
            });
        }
        const position = fit([selFaceGeometry], 'position', triangles * 3);
        const color = fit([selFaceGeometry], 'color', triangles * 3);
        if (tinted.size) {
            let at = 0;
            data.triFace.forEach((face, tri) => {
                const tint = tinted.get(face);
                if (!tint) {
                    return;
                }
                for (let n = 0; n < 9; n += 3) {
                    position.array[at + n] = data.triPos[tri * 9 + n];
                    position.array[at + n + 1] = data.triPos[tri * 9 + n + 1];
                    position.array[at + n + 2] = data.triPos[tri * 9 + n + 2];
                    color.array[at + n] = tint.r;
                    color.array[at + n + 1] = tint.g;
                    color.array[at + n + 2] = tint.b;
                }
                at += 9;
            });
        }
        touch(position, triangles * 9);
        touch(color, triangles * 9);
        selFaceGeometry.setDrawRange(0, triangles * 3);
    };

    /**
     * The selections to draw: the people present, one's own last, so it stays on top where they overlap.
     *
     * @returns {Object[]} {a, md, items}
     */
    const drawnSelections = () => {
        const sels = data && Array.isArray(data.sels) ? data.sels : [];
        const others = sels.filter((sel) => sel.a !== ownAuthor && present.has(sel.a) && sel.items.length > 0);
        return others.concat(sels.filter((sel) => sel.a === ownAuthor && sel.items.length > 0));
    };

    /** Write the selection buffers from the data, the people present and the own author. */
    const writeSelections = () => {
        const dots = [];
        const dotTints = [];
        const lines = [];
        const lineTints = [];
        const tinted = new Map();
        const list = drawnSelections();
        const vertIndex = new Map();
        const faceIndex = new Map();
        if (list.some((sel) => sel.md !== 'f')) {
            data.vertIds.forEach((id, n) => vertIndex.set(id, n));
        }
        if (list.some((sel) => sel.md === 'f')) {
            data.faceIds.forEach((id, n) => faceIndex.set(id, n));
        }
        list.forEach((sel) => {
            const tint = colourOf(sel.a);
            if (sel.md === 'v') {
                sel.items.forEach((id) => {
                    if (vertIndex.has(id)) {
                        dots.push(vertIndex.get(id));
                        dotTints.push(tint);
                    }
                });
            } else if (sel.md === 'e') {
                for (let n = 0; n + 1 < sel.items.length; n += 2) {
                    if (vertIndex.has(sel.items[n]) && vertIndex.has(sel.items[n + 1])) {
                        lines.push(vertIndex.get(sel.items[n]), vertIndex.get(sel.items[n + 1]));
                        lineTints.push(tint, tint);
                    }
                }
            } else {
                sel.items.forEach((id) => {
                    const face = faceIndex.get(id);
                    if (face === undefined) {
                        return;
                    }
                    tinted.set(face, tint);
                    const first = data.faceStart[face];
                    const end = data.faceStart[face + 1];
                    for (let c = first; c < end; c++) {
                        lines.push(data.faceVerts[c], data.faceVerts[c + 1 === end ? first : c + 1]);
                        lineTints.push(tint, tint);
                    }
                });
            }
        });
        writeCorners(selPointGeometry, dots, dotTints);
        writeCorners(selLineGeometry, lines, lineTints);
        writeFaceTint(tinted);
    };

    /** Write the wire from the data. */
    const writeWire = () => {
        const count = data.vertPos.length / 3;
        const position = fit(wireGeometries, 'position', count);
        position.array.set(data.vertPos);
        touch(position, data.vertPos.length);
        pointGeometry.setDrawRange(0, count);
        writeIndex(edgeGeometry, data.edges);
        writeIndex(openGeometry, data.openEdges);
    };

    /** Write the solid mesh from the data, and its bounds, which raycasting and culling use. */
    const writeSolid = () => {
        const corners = data.triPos.length / 3;
        const position = fit([solidGeometry], 'position', corners);
        const normal = fit([solidGeometry], 'normal', corners);
        position.array.set(data.triPos);
        normal.array.set(data.triNormal);
        touch(position, data.triPos.length);
        touch(normal, data.triNormal.length);
        solidGeometry.setDrawRange(0, corners);
        const from = data.vertPos;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let n = 0; n < from.length; n += 3) {
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], from[n + axis]);
                max[axis] = Math.max(max[axis], from[n + axis]);
            }
        }
        const sphere = solidGeometry.boundingSphere;
        if (from.length === 0) {
            sphere.center.set(0, 0, 0);
            sphere.radius = 0;
        } else {
            sphere.center.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
            sphere.radius = Math.sqrt((max[0] - min[0]) * (max[0] - min[0]) + (max[1] - min[1]) * (max[1] - min[1]) +
                (max[2] - min[2]) * (max[2] - min[2])) / 2 + 0.001;
        }
        solid.visible = corners > 0;
    };

    /** Draw nothing of the wire and the selections. */
    const clearEditing = () => {
        [edgeGeometry, openGeometry, pointGeometry, selFaceGeometry, selLineGeometry, selPointGeometry].forEach((geometry) => {
            geometry.setDrawRange(0, 0);
        });
    };

    /** Write everything only an editor sees, when someone is looking. */
    const writeEditing = () => {
        if (!showEditing) {
            return;
        }
        if (data) {
            writeWire();
            writeSelections();
        } else {
            clearEditing();
        }
    };

    return {
        /**
         * Show new drawing data.
         *
         * @param {Object|null} next polymesh.renderData, or null to show nothing. It is only read.
         */
        setData: (next) => {
            data = next || null;
            if (data) {
                writeSolid();
            } else {
                solid.visible = false;
                solidGeometry.setDrawRange(0, 0);
            }
            writeEditing();
        },

        /**
         * Show or hide what only an editor sees.
         *
         * @param {boolean} on Whether to show the wire and the selections.
         */
        setShowEditing: (on) => {
            showEditing = !!on;
            editing.visible = showEditing;
            writeEditing();
        },

        /**
         * Say whose selection is one's own.
         *
         * @param {string} author Author id.
         */
        setOwnAuthor: (author) => {
            ownAuthor = String(author);
            if (showEditing && data) {
                writeSelections();
            }
        },

        /**
         * Say who else is here: only their selections are drawn.
         *
         * @param {string[]} authors Author ids.
         */
        setPresent: (authors) => {
            present = new Set((Array.isArray(authors) ? authors : []).map(String));
            if (showEditing && data) {
                writeSelections();
            }
        },

        /**
         * The solid mesh when there is one, for raycasting; the array is never changed in place.
         *
         * @returns {Object[]} THREE.Mesh list.
         */
        meshes: () => (solid.visible ? solidList : noMeshes),

        /** Remove everything from the scene and free its GPU buffers. */
        dispose: () => {
            parent.remove(group);
            [solidGeometry, edgeGeometry, openGeometry, pointGeometry, selFaceGeometry, selLineGeometry, selPointGeometry]
                .forEach((geometry) => geometry.dispose());
            [solidMaterial, edgeMaterial, openMaterial, pointMaterial, selFaceMaterial, selLineMaterial, selPointMaterial]
                .forEach((material) => material.dispose());
            data = null;
        },
    };
};
