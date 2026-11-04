# VR Makerspace — make 3D pieces together in Moodle

VR Makerspace is a Moodle activity in which students make a 3D piece, alone or together with their group
in one shared piece, in a VR headset (WebXR, for example the Meta Quest browser) or in an ordinary desktop
browser with mouse and keyboard. They can use two ways of making on the same piece, even at the same
time as each other: **sculpting** clay with brushes, and **modelling** a polygon mesh with Blender-like
tools. Every save is kept as a version; teachers look at every piece and every version in 3D, see how
much each member of a group contributed, and grade the pieces in the gradebook. Pieces export to STL,
glTF and 3MF for 3D printing.

It is part of the VR room suite (`mod_vrroom`): the studio reuses VR room's built-in run mode
(`vrroomruntime_builtin`) for three.js, the WebXR helpers and the presence codec, and can use VR room's
companion service (`vrroomruntime_companion` and its `vrroom-sync` server) for larger groups.

**Status: ALPHA (0.1.0, not released yet).**

## Requirements

- Moodle 5.2 or 5.3 (`$plugin->supported = [502, 503]`).
- `mod_vrroom` with its built-in run mode `vrroomruntime_builtin` (version 2026101100 or later), a
  declared dependency.
- A browser with WebGL 2 and module Web Workers (current Firefox, Chrome, Edge, Safari, the Meta Quest
  browser). VR needs WebXR: the Quest browser, or a desktop browser with a WebXR headset.
- Optional, for groups of more than two working at once: `vrroomruntime_companion` installed and set
  up, with its companion server running (see "Working together" below). The modelling tools need a
  `vrroom-sync` that knows them: an older one drops those edits.

Nothing else: individual work and pair work need no server besides Moodle.

## Installation

1. Install `mod_vrroom` first (it brings `vrroomruntime_builtin`).
2. Copy this repository to `public/mod/vrmakerspace` in your Moodle code.
3. Visit *Site administration > Notifications* to install it.
4. Optionally set the largest saved piece in *Site administration > Plugins > Activity modules >
   VR Makerspace* (16 MB by default).

## Settings of an activity

- **Ways of making**: *Sculpting and modelling* (each person switches whenever they like), *Sculpting
  only* or *Modelling only*.
- **Starting model**: clay lump, clay sphere, clay cube, a polygon cube, nothing, or an uploaded model.
  Every new piece starts from it. Modelling only allows the polygon cube and nothing, since clay could not
  be changed; sculpting only allows everything but the polygon cube.
- **Model file** (uploaded model): an STL, OBJ or glTF binary (.glb) file of up to 32 MB and 500 000
  triangles. It is centred, scaled so its longest side is 22 cm, and turned into clay of about 4 mm
  detail in each browser (colours and textures are dropped; closed models work best).
- **Work**: individually (one piece per student) or in groups (one shared piece per group; the groups
  come from the activity's grouping, or from the course when it has none).
- **Working together** (group work): *With one partner (built in)* or *With up to 8 people (companion
  service)*. The second choice is offered only when the companion plugin is installed, with a note while
  it is not set up.
- **People working at once** (companion service): 2 to 8. Working with one partner is always two.
- **Track each person's contribution** (group work, on by default). A share is the mean of a member's part of all
  the edits and of all the clay added and removed; turning a mesh into clay and undoing are not counted as new work.
- **Grade**: points only.

## Working together

### With one partner (built in, no extra server)

Two members of a group work on their group's piece at the same time. Their browsers find each other
through Moodle (the web services `mod_vrmakerspace_pair_join`, `_pair_poll`, `_pair_signal` and
`_pair_leave`, polled about once a second) and then connect directly with WebRTC; the edits and the
positions of heads and hands go browser to browser. One browser, the host, puts every edit in order,
so both copies stay identical; if the host leaves, the other browser takes over. A member who joins
later receives the current piece from the host. A third member who opens the studio is told that the
piece is full.

Browsers on different networks may need STUN or TURN servers to connect. The studio uses the STUN and
TURN settings of VR room's built-in viewer (`vrroomruntime_builtin`, under VR room's settings in
*Site administration > Plugins > Activity modules*), with TURN credentials made for each connection;
without them, pair work may only connect browsers on the same network.

### With up to 8 people (companion service)

Up to the chosen number of members work together over VR room's companion service (`vrroom-sync`).
Moodle gives each studio a short-lived token (`mod_vrmakerspace_companion_join`); the service puts the
edits of everyone in one order and replays them to latecomers, from the last saved version. Set it up
as described in `vrroomruntime_companion` (its server runs in a container, for example with Podman).
When the service is not set up, an activity that chose it falls back to working with one partner and
says so in the studio.

## The studio

Open it with **Open the makerspace** on the activity page; teachers open any piece, and anyone any saved
version, with **View in 3D** (read only).

Every piece has two layers, shown together in the same space: the **clay** you sculpt and the **mesh**
you model, in a cool blue-grey so the two are told apart. The method switch (**Sculpt** or **Model**)
chooses which tools you use. It is per person, so two students can use different ways at once; with one
way of making in the activity, the switch is hidden.

Your piece is saved every minute, with Save now, and when you follow a link away from the studio. Closing the tab
or reloading with unsaved work makes the browser ask first.

Undo and redo work per person: each person undoes their own strokes and edits, in time order across both
ways of making. When someone joins or rejoins a piece,
undo starts again from there for everyone (a message says so): a saved state holds no undo records, and this keeps
every person's copy identical.

### Sculpt

Tools: **Grab** (pull the clay with a smooth falloff), **Twist** (around an axis), **Add**, **Carve**,
**Smooth**, **Inflate** (swell the surface outwards), **Pinch** (pull the clay together, for sharp creases
and edges) and **Flatten** (press the surface flat, in the plane where the stroke began), with a brush
size and strength.

Shape tools: **Add shape** and **Cut shape** place one shape with a click, on the surface (its top along
the surface) or, beside the piece, facing you: a sphere, cube, cylinder, cone, ring, or **letters** (up to
16 capitals, digits and `. - ! ? '`, written as clay tubes). The size sets the shape's size (letters are
twice the size high); the strength sets how softly it blends in. With the starting model *Nothing*,
students build the whole piece from shapes.

**Mirror** (as Blender's X symmetry) repeats every stroke and shape on the other side of the piece's
middle (the plane x = 0, left and right as the studio first shows it).

While someone grabs or twists, that part of the piece is locked for the others (a mirrored stroke's other
side is not locked).

Desktop: 1–9 and 0 choose a tool, M turns mirroring on or off, `[` and `]` change the size, comma and
full stop change the strength, Ctrl+Z undoes, Ctrl+Shift+Z redoes. Drag with the left button to sculpt
(a shape tool places its shape with a click), the right button to turn, the wheel to zoom.

VR: the right trigger sculpts, the right stick changes size and strength, A and B change the tool, the
left grip moves the piece, X undoes and Y redoes; a palette on the left wrist shows the tools and the
mirror switch. Shapes are placed at the controller tip, their top (and letters' front) towards you. With
hand tracking, pinch to sculpt. The others are shown with a head, hands and their name.

### Model

A mesh is made of vertices and many-sided faces. Tools:

- **Add shape**: cube, plane, cylinder, sphere, cone or torus, with a number of segments.
- **Select** vertices, edges or faces; select all, none, everything connected, or an edge loop.
- **Move**, **Rotate** and **Scale** the selection, free or locked to an axis.
- **Extrude** (pull new faces out of the selection), **Inset** (a smaller copy inside a face), **Bevel**
  (round off an edge, with segments) and **Loop cut** (a new ring of edges through a band of quads).
- **Merge** vertices, **Delete**, **Fill** (a new face in a closed outline), **Flip** (turn a face inside
  out) and **Mirror** (copy the selection, or the whole mesh, across the middle).
- **Turn into clay** needs a closed shape (an open sheet encloses nothing, so it is refused and stays as it is).
  It bakes the whole mesh into the clay layer and empties the mesh. It can be undone, but
  there is no way from clay to mesh.

There are no booleans and no modifier stacks. Open edges, which keep a piece from printing, show in red.

A person's selection is shared, and shown to the others in that person's colour. While it holds, the
others present cannot select or edit the same vertices; when someone leaves, their selection stops
counting at once.

Desktop: 1, 2 and 3 choose vertices, edges or faces; click selects, Shift+click adds, Alt+click selects an
edge loop; A selects all, Alt+A none, L everything connected; G, R and S move, rotate and scale (X, Y or Z
locks the axis; click or Enter confirms, Esc or a right click cancels); E extrudes, I insets, Ctrl+B
bevels, Ctrl+R cuts a loop, M merges, X or Delete deletes, F fills; Tab switches between Sculpt and Model
when both are allowed; Ctrl+Z still undoes. The right button turns and the wheel zooms, as in Sculpt.

VR: the palette has a method switch and a Model page. A small sphere at the controller's tip marks your
reach. With Select, the right trigger picks what is within 2.5 cm, or what the controller points at beyond
arm's reach, and held it paints a selection; with a tool, it uses the tool, and the controller's own turn
rotates. The right stick adjusts bevel or inset width or segments, and the left grip moves the whole piece.
With hand tracking, pinch for the trigger. A shape from the palette appears at your hand.

### Saving and export

The studio saves a new version every minute while the piece changes, when you choose **Save now**, and
when you leave. In group work one studio saves for everyone. A closed piece opens read only.

Export: **STL** and **3MF** for 3D printing (millimetres, Z up), **glTF binary (.glb)** for 3D software
(metres, Y up), clay and mesh together. The studio reports the size and whether the model is watertight
and manifold.

The clay is a signed distance field of 128 × 128 × 128 voxels of 4 mm (a 51.2 cm cube), meshed with surface
nets in a Web Worker. The mesh holds up to 20 000 vertices and 20 000 faces of up to 64 sides each.
Collaborators exchange editing operations, never meshes. Saved versions are files in the "VRSC" format (a
48-byte header, then one byte per voxel and the mesh, deflate-compressed), checked by Moodle before they are
stored.

## Teachers

- The activity page lists every piece (in separate groups, only the teacher's groups' unless they may
  access all groups) with its versions, status and, when tracked, the members' shares.
- **Grade pieces** opens the grading page: each piece with its latest version, the shares, and a grade
  field per student; a group's piece also has "Give every member of the group this grade". Grades go to
  the gradebook. **Quick view** opens the latest version in a popup: drag to turn it, scroll or pinch (or
  the Zoom buttons) to zoom, right-drag, Shift+drag or the arrow keys to move it.
- Users with *Open, close and reset pieces* (`mod/vrmakerspace:managesessions`) close a piece (it can be
  viewed and graded, not changed), reopen it, or reset it (every version and the recorded contributions
  are deleted), each after a confirmation.
- Contributions, when tracked: each studio reports its own user's operations (sculpting and modelling) and
  clay added and removed. The reports are bounded on the server (per report and at most one per 10
  seconds), so the shares are a guide for grading, not a proof.

## Capabilities

| Capability | Default roles | What it allows |
|---|---|---|
| `mod/vrmakerspace:addinstance` | editing teacher, manager | Add the activity |
| `mod/vrmakerspace:view` | guest, student, teachers, manager | Open the activity |
| `mod/vrmakerspace:make` | student | Have a piece (or share the group's), change it and save versions |
| `mod/vrmakerspace:viewallsubmissions` | teachers, manager | See everyone's pieces |
| `mod/vrmakerspace:grade` | teachers, manager | Grade pieces |
| `mod/vrmakerspace:managesessions` | editing teacher, manager | Open, close and reset pieces |

## Scheduled task

*Remove expired live connections* (`\mod_vrmakerspace\task\cleanup`, every 15 minutes) deletes the
connections and connection messages of pair work nobody used for an hour.

## Privacy

Stored in Moodle and handled by the privacy API (export and deletion): a user's own pieces with all their
versions, the versions they saved of a group's piece, their grades, their share of a piece, and, while they
work with a partner, their connection and the connection messages they sent (deleted when delivered or
within an hour). A group's piece is the group's shared work: deleting one member keeps it and anonymises
the versions that member saved. A saved version also holds the mesh selections of whoever was working on
it, under their author id in that session.

Sent outside Moodle while working together:

- With one partner: the partner's browser receives the user's name, the network addresses of their
  device (exchanged by WebRTC to connect, possibly through the site's STUN or TURN servers), their
  edits and selections, and the positions of their head and hands.
- Over the companion service: the service receives the user's name, a pseudonym made by this site, the
  edits and selections, and the positions (see `vrroomruntime_companion` for what the service keeps).

## Licence

GNU GPL v3 or later; see `LICENSE`.

The modelling operators follow Blender's bmesh operators (`js/engine/polyops.js` names its sources);
Blender is also GPL.
