# VR sculpting — sculpt 3D models together in Moodle

VR sculpting is a Moodle activity in which students sculpt a 3D model of clay, alone or together with
their group in one shared sculpture, in a VR headset (WebXR, for example the Meta Quest browser) or in
an ordinary desktop browser with mouse and keyboard. Every save is kept as a version; teachers look at
every sculpture and every version in 3D, see how much each member of a group contributed, and grade
the sculptures in the gradebook. Sculptures export to STL, glTF and 3MF for 3D printing.

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
- Optional, for groups of more than two sculpting at once: `vrroomruntime_companion` installed and set
  up, with its companion server running (see "Sculpting together" below).

Nothing else: individual work and pair work need no server besides Moodle.

## Installation

1. Install `mod_vrroom` first (it brings `vrroomruntime_builtin`).
2. Copy this repository to `public/mod/vrsculpt` in your Moodle code.
3. Visit *Site administration > Notifications* to install it.
4. Optionally set the largest saved sculpture in *Site administration > Plugins > Activity modules >
   VR sculpting* (16 MB by default).

## Settings of an activity

- **Starting model**: clay lump, sphere, cube or an uploaded model. Every new sculpture starts from it.
- **Model file** (uploaded model): an STL, OBJ or glTF binary (.glb) file of up to 32 MB and 500 000
  triangles. It is centred, scaled so its longest side is 22 cm, and turned into clay of about 4 mm
  detail in each browser (colours and textures are dropped; closed models work best).
- **Work**: individually (one sculpture per student) or in groups (one shared sculpture per group;
  the groups come from the activity's grouping, or from the course when it has none).
- **Sculpting together** (group work): *With one partner (built in)* or *With up to 8 people
  (companion service)*. The second choice is offered only when the companion plugin is installed,
  with a note while it is not set up.
- **People sculpting at once** (companion service): 2 to 8. Working with one partner is always two.
- **Track each person's contribution** (group work).
- **Grade**: points only.

## Sculpting together

### With one partner (built in, no extra server)

Two members of a group sculpt their group's sculpture at the same time. Their browsers find each
other through Moodle (the web services `mod_vrsculpt_pair_join`, `_pair_poll`, `_pair_signal` and
`_pair_leave`, polled about once a second) and then connect directly with WebRTC; the edits and the
positions of heads and hands go browser to browser. One browser, the host, puts every edit in order,
so both sculptures stay identical; if the host leaves, the other browser takes over. A member who
joins later receives the current sculpture from the host. A third member who opens the studio is told
that the sculpture is full.

Browsers on different networks may need STUN or TURN servers to connect. The studio uses the STUN and
TURN settings of VR room's built-in viewer (`vrroomruntime_builtin`, under VR room's settings in
*Site administration > Plugins > Activity modules*), with TURN credentials made for each connection;
without them, pair work may only connect browsers on the same network.

### With up to 8 people (companion service)

Up to the chosen number of members sculpt together over VR room's companion service (`vrroom-sync`).
Moodle gives each studio a short-lived token (`mod_vrsculpt_companion_join`); the service puts the
edits of everyone in one order and replays them to latecomers, from the last saved version. Set it up
as described in `vrroomruntime_companion` (its server runs in a container, for example with Podman).
When the service is not set up, an activity that chose it falls back to working with one partner and
says so in the studio.

## The studio

Open it with **Open the sculpting studio** on the activity page; teachers open any sculpture, and
anyone any saved version, with **View in 3D** (read only).

Tools: **Grab** (pull the clay with a smooth falloff), **Twist** (around an axis), **Add**, **Carve**,
**Smooth**, with a brush size and strength. Undo and redo work per person: each person undoes their
own strokes. While someone grabs or twists, that part of the sculpture is locked for the others.

Desktop: 1–5 choose a tool, `[` and `]` change the size, comma and full stop change the strength,
Ctrl+Z undoes, Ctrl+Shift+Z redoes. Drag with the left button to sculpt, the right button to turn, the
wheel to zoom.

VR: the right trigger sculpts, the right stick changes size and strength, A and B change the tool, the
left grip moves the sculpture, X undoes and Y redoes; a palette on the left wrist shows the tool. With
hand tracking, pinch to sculpt. The others are shown with a head, hands and their name.

Saving: the studio saves a new version every minute while the sculpture changes, when you choose
**Save now**, and when you leave. In group work one studio saves for everyone. A closed sculpture
opens read only.

Export: **STL** and **3MF** for 3D printing (millimetres, Z up), **glTF binary (.glb)** for 3D software
(metres, Y up). The studio reports the size and whether the model is watertight and manifold.

Each sculpture is a signed distance field of 128 × 128 × 128 voxels of 4 mm (a 51.2 cm cube), meshed
with surface nets in a Web Worker; collaborators exchange editing operations, never meshes. Saved
versions are files in the "VRSC" format (a 48-byte header, then one byte per voxel, deflate-compressed),
checked by Moodle before they are stored.

## Teachers

- The activity page lists every sculpture (in separate groups, only the teacher's groups' unless they
  may access all groups) with its versions, status and, when tracked, the members' shares.
- **Grade sculptures** opens the grading page: each sculpture with its latest version, the shares, and
  a grade field per student; a group's sculpture also has "Give every member of the group this grade".
  Grades go to the gradebook.
- Users with *Open, close and reset sculptures* (`mod/vrsculpt:managesessions`) close a sculpture (it
  can be viewed and graded, not changed), reopen it, or reset it (every version and the recorded
  contributions are deleted), each after a confirmation.
- Contributions, when tracked: each studio reports its own user's operations and clay added and
  removed. The reports are bounded on the server (per report and at most one per 10 seconds), so the
  shares are a guide for grading, not a proof.

## Capabilities

| Capability | Default roles | What it allows |
|---|---|---|
| `mod/vrsculpt:addinstance` | editing teacher, manager | Add the activity |
| `mod/vrsculpt:view` | guest, student, teachers, manager | Open the activity |
| `mod/vrsculpt:sculpt` | student | Have a sculpture (or share the group's), sculpt it and save versions |
| `mod/vrsculpt:viewallsubmissions` | teachers, manager | See everyone's sculptures |
| `mod/vrsculpt:grade` | teachers, manager | Grade sculptures |
| `mod/vrsculpt:managesessions` | editing teacher, manager | Open, close and reset sculptures |

## Scheduled task

*Remove expired live sculpting connections* (`\mod_vrsculpt\task\cleanup`, every 15 minutes) deletes
the connections and connection messages of pair work nobody used for an hour.

## Privacy

Stored in Moodle and handled by the privacy API (export and deletion): a user's own sculptures with all
their versions, the versions they saved of a group's sculpture, their grades, their share of a
sculpture, and, while they sculpt with a partner, their connection and the connection messages they
sent (deleted when delivered or within an hour). A group's sculpture is the group's shared work:
deleting one member keeps it and anonymises the versions that member saved.

Sent outside Moodle while sculpting together:

- With one partner: the partner's browser receives the user's name, the network addresses of their
  device (exchanged by WebRTC to connect, possibly through the site's STUN or TURN servers), their
  edits and the positions of their head and hands.
- Over the companion service: the service receives the user's name, a pseudonym made by this site, the
  edits and the positions (see `vrroomruntime_companion` for what the service keeps).

## Licence

GNU GPL v3 or later; see `LICENSE`.
