# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Activity skeleton (milestone 1): settings form, `vrmakerspace`, `vrmakerspace_sessions`,
  `vrmakerspace_snapshots` and `vrmakerspace_grades` tables, the `snapshots` file area, capabilities,
  web services `mod_vrmakerspace_save_snapshot` and `mod_vrmakerspace_get_session_state`, grade callbacks,
  privacy provider, backup and restore, course reset, the `maxsnapshotsize` site setting.
- The sculpting studio (`studio.php`, `amd/src/studio.js` and its modules): signed distance field
  engine and surface-nets mesher in a module Web Worker (`js/engine/`), the five tools, per-author
  undo and redo, desktop and WebXR input, presence, STL, 3MF and glTF binary export.
- Group work connections: the `vrmakerspace.connection` field (`pair` or `companion`); pair work with the
  `vrmakerspace_peers` and `vrmakerspace_signals` tables and the web services `mod_vrmakerspace_pair_join`,
  `mod_vrmakerspace_pair_signal`, `mod_vrmakerspace_pair_poll` and `mod_vrmakerspace_pair_leave`; companion work
  with `mod_vrmakerspace_companion_join` (soft dependency on `vrroomruntime_companion`).
- Contribution tracking: the `vrmakerspace_contrib` table and `mod_vrmakerspace_report_contribution`.
- Grading page (`grade.php`), management page (`manage.php`: close, reopen, reset) and
  `mod_vrmakerspace_set_session_status`; studio and 3D-view links on the activity page.
- Scheduled task `\mod_vrmakerspace\task\cleanup` (expired pair-work connections).
- Dependency on `vrroomruntime_builtin` 2026101100.
- Sculpting and modelling tools: op kinds `inflate`, `pinch`, `flatten`, `shape` and `cutshape`, op keys
  `m` (mirror), `sh` (shape) and `tx` (letters) (`js/engine/ops.js`, `js/engine/shapes.js`,
  `js/engine/font.js`); the start model `empty`; the toolbar's modelling group, shape and letters fields
  and Mirror switch; ten tools in two rows on the VR palette, with Mirror. Needs the matching
  `vrroom-sync` for companion work.
- Grading page quick view: `amd/src/quickview.js` and `templates/quickview.mustache` (a core modal
  with the engine worker's mesh and three.js OrbitControls), `studio_helper::worker_url()`, the
  grading rows' `snapshoturl` and `quickviewtitle`; Behat generator entity `mod_vrmakerspace > versions`.
- Uploaded starting models: `startmodel` value `upload`, the `startmodel` file area (one STL, OBJ or
  glTF binary file, backed up and restored), served by `vrmakerspace_pluginfile()` to users who may view
  the activity, and read and voxelised in the engine worker by `js/engine/meshimport.js`.

### Changed

- Saved snapshots must have a valid "VRSC" version 1 header; a version's operation count is the
  header's sequence number.
- `mod_vrmakerspace_get_session_state` and `mod_vrmakerspace_save_snapshot` return the activity's
  `connection`.
