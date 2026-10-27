# Changes

## 0.1.0 (unreleased) — ALPHA

The first version: sculpt a 3D model of clay alone or together, in VR or in the browser.

- New VR sculpting activity: starting model (clay lump, sphere, cube, or an uploaded STL, OBJ or glTF
  binary model), individual or group work,
  how groups sculpt together, people per group sculpture, contribution tracking, points grade.
- The sculpting studio: grab, twist, add, carve, smooth, inflate, pinch and flatten with brush size
  and strength; modelling tools that place spheres, cubes, cylinders, cones, rings and letters, or cut
  them away; mirroring across the middle (X symmetry); a starting model of nothing; per-person
  undo and redo, in a WebXR headset (controllers or hand tracking, with a wrist palette) or on the
  desktop with mouse and keyboard. Export to STL, 3MF and glTF binary, with a watertightness report.
- Sculpting together with one partner, built in: two members of a group, browser to browser, with no
  server besides Moodle. Or with up to 8 people over VR room's companion service when it is set up
  (otherwise such an activity falls back to one partner). Presence (head, hands, name), and the part
  being grabbed or twisted is locked for the others.
- Saved versions (automatic, on demand, on leaving) with a version history; every sculpture and
  version can be viewed in 3D. Saved files are checked before they are stored.
- Grading page: each sculpture with its latest version and the members' shares, a grade per student
  and "give every member this grade" for groups; grades go to the gradebook. "Quick view" opens the
  latest version in a popup to turn, zoom and move with the mouse, touch or keyboard.
- Teachers close, reopen and reset sculptures.
- Contribution tracking: each member's operations and clay added and removed, bounded on the server.
- Privacy provider (including what is sent to the partner's browser and to the companion service),
  backup and restore (with contributions), course reset, and a scheduled task that removes expired
  pair-work connections.
