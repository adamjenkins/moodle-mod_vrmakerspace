# Changes

## 0.1.0 (unreleased) — ALPHA

The first version: make a 3D piece alone or together, in VR or in the browser, by sculpting clay,
modelling a polygon mesh, or both.

- New VR Makerspace activity (this plugin was first built as "VR sculpting"): ways of making (sculpting
  and modelling, sculpting only, modelling only), starting model (clay lump, clay sphere, clay cube, a
  polygon cube, nothing, or an uploaded STL, OBJ or glTF binary model), individual or group work, how
  groups work together, people per group piece, contribution tracking, points grade.
- The studio has two ways of making, shown together in the same space, and each person chooses their
  own: two students can use different ways at once on one piece.
- Sculpting: grab, twist, add, carve, smooth, inflate, pinch and flatten with brush size and strength;
  shape tools that place spheres, cubes, cylinders, cones, rings and letters, or cut them away; mirroring
  across the middle (X symmetry).
- Modelling, with Blender-like tools on a polygon mesh: basic shapes (cube, plane, cylinder, sphere, cone,
  torus); select vertices, edges or faces, with select all, none, connected and edge loop; move, rotate,
  scale, extrude, inset, bevel, loop cut, merge, delete, fill, flip and mirror; Turn into clay bakes the
  whole mesh into the clay layer. While someone has a part selected, the others cannot select or edit it.
- Per-person undo and redo that cover both ways of making; when someone joins or rejoins, undo starts again from
  there for everyone, so all copies of the piece stay identical. In a WebXR headset (controllers or hand
  tracking, with a wrist palette) or on the desktop with mouse and keyboard. Export to STL, 3MF and glTF
  binary, clay and mesh together, with a watertightness report.
- Working together with one partner, built in: two members of a group, browser to browser, with no
  server besides Moodle. Or with up to 8 people over VR room's companion service when it is set up
  (otherwise such an activity falls back to one partner). Presence (head, hands, name), and the part
  being grabbed or twisted is locked for the others. The modelling tools need the matching version of the
  companion service: an older one drops them.
- Saved versions (automatic, on demand, on leaving) with a version history; every piece and version can
  be viewed in 3D. Saved files are checked before they are stored.
- Grading page: each piece with its latest version and the members' shares, a grade per student and
  "give every member this grade" for groups; grades go to the gradebook. "Quick view" opens the latest
  version in a popup to turn, zoom and move with the mouse, touch or keyboard.
- Teachers close, reopen and reset pieces.
- Contribution tracking: each member's operations and clay added and removed, bounded on the server.
- Privacy provider (including what is sent to the partner's browser and to the companion service),
  backup and restore (with contributions), course reset, and a scheduled task that removes expired
  pair-work connections.
