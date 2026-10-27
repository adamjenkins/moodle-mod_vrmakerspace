# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Activity skeleton (milestone 1): settings form, `vrsculpt`, `vrsculpt_sessions`,
  `vrsculpt_snapshots` and `vrsculpt_grades` tables, the `snapshots` file area, capabilities,
  web services `mod_vrsculpt_save_snapshot` and `mod_vrsculpt_get_session_state`, grade callbacks,
  privacy provider, backup and restore, course reset, the `maxsnapshotsize` site setting.
- The sculpting studio (`studio.php`, `amd/src/studio.js` and its modules): signed distance field
  engine and surface-nets mesher in a module Web Worker (`js/engine/`), the five tools, per-author
  undo and redo, desktop and WebXR input, presence, STL, 3MF and glTF binary export.
- Group work connections: the `vrsculpt.connection` field (`pair` or `companion`); pair work with the
  `vrsculpt_peers` and `vrsculpt_signals` tables and the web services `mod_vrsculpt_pair_join`,
  `mod_vrsculpt_pair_signal`, `mod_vrsculpt_pair_poll` and `mod_vrsculpt_pair_leave`; companion work
  with `mod_vrsculpt_companion_join` (soft dependency on `vrroomruntime_companion`).
- Contribution tracking: the `vrsculpt_contrib` table and `mod_vrsculpt_report_contribution`.
- Grading page (`grade.php`), management page (`manage.php`: close, reopen, reset) and
  `mod_vrsculpt_set_session_status`; studio and 3D-view links on the activity page.
- Scheduled task `\mod_vrsculpt\task\cleanup` (expired pair-work connections).
- Dependency on `vrroomruntime_builtin` 2026101100.
- Uploaded starting models: `startmodel` value `upload`, the `startmodel` file area (one STL, OBJ or
  glTF binary file, backed up and restored), served by `vrsculpt_pluginfile()` to users who may view
  the activity, and read and voxelised in the engine worker by `js/engine/meshimport.js`.

### Changed

- Saved snapshots must have a valid "VRSC" version 1 header; a version's operation count is the
  header's sequence number.
- `mod_vrsculpt_get_session_state` and `mod_vrsculpt_save_snapshot` return the activity's
  `connection`.
