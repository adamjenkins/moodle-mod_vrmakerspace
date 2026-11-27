# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-11-27

### Added

- First-use help (`amd/src/guide.js`): a task strip with the saved state (`guide_context()` in `studio_helper`), **Show me how** (`tipFor()`), the group's members with who is present, pictured tool buttons, scroll hints on the phone's tool sheet, and a **Brush** pop-up for size and strength.
- The studio starts with the basic tools (`mod_vrmakerspace-basic`); **More** / **Less** switch to all tools (`mod_vrmakerspace:alltools`, `mod_vrmakerspace:basictools`).
- A studio stage (`studio.js`): PMREM soft-box environment, ACES tone mapping, a turntable, and a glass stand under the piece, sized from the piece's bounds (the tutor robot is left out of the bounds and of the camera framing).
- The activity page's plain summary (`intro_*` strings) and the **Backup file** link (`versionbackup`).
- The `aistatus` application cache: when the AI last failed to answer the tutor (`tutorial::mark_ai_down()`, `ai_down()`, `ai_down_since()`, `is_outage()`, `mark_ai_up()`).
- Strings `tutorai_noprovider`, `tutorai_offline`, `tutorial_offline`, `error_tutoroffline`, `cachedef_aistatus`, and the strings of the guide and help panel.

### Changed

- The tutorial bubble is a glass side panel beside the stage on wide windows and a sheet under a 40vh stage on narrow ones; the site's AI policy is shown on its own before the first step; a step whose target is behind More opens More and the next basic step closes it; on a phone a target in the tool sheet is centred in it.
- AI-only features follow the AI (owner's rule, 2026-11-26): `canask` is true only when the tutor's AI is available; without it the voice config drops speech input and the server voices.
- `ask_tutor`: a provider exception or an outage (no answer, error code 0 or below, 429, 5xx) throws `error_tutoroffline` and marks the AI down for 600 s for the whole site; a refusal of one question (other 4xx) keeps `error_tutorfailed` and marks nothing. The first answer clears the mark.
- The help panel is a table of pictures; the toolbar is one glass bar docked into the stage.
- The engine tests moved to `tests/speech/engine/`, matching their namespace.

### Security

- `session_manager::can_view()` applies separate groups: without `moodle/site:accessallgroups`, a viewer who is not an owner sees only pieces of the groups `groups_get_activity_allowed_groups()` gives them, or of those groups' members. This covers every direct-id path: `pluginfile` snapshots (`lib.php`), `studio.php?session=`, `manage.php`, `get_session_state` and `set_session_status`. `view_helper::visible_sessions()` uses the same `visible_groups()` and `in_visible_groups()` (VRS-1).
- `session_manager::save_snapshot()`: a save within `MIN_VERSION_INTERVAL` (10 s) of the same user's newest version (not version 1) replaces that version's file (`replace_snapshot()`), and `prune_versions()` keeps at most `MAX_VERSIONS` (100) per piece, removing the oldest except version 1 and the newest (VRS-2).
- Privacy: `session_manager::author_ids()` gives `'u'.userid` and, with the companion plugin installed, `companion_manager::peer_id()`. Deleting users removes selections under both from every version (each file rewritten once), and the export lists them as `yourselections` (F1).
- `grade.php` reads `savegrades` as `PARAM_BOOL` and the grade arrays as `PARAM_LOCALISEDFLOAT`; `grading_helper::save()` takes float, null (clear) or false (invalid), and `grader::save_grade()` checks the range.

### Removed

- Upgrade step 2026112700 unsets the plugin settings `aidownat` and `aidownuntil`, which pre-release builds used before the `aistatus` cache.

## [0.1.4] - 2026-11-23

### Fixed

- `studio.js`: a frame whose update fails is still drawn (an undrawn frame shows as a black flash in a headset); the first error is logged.
- `bottombar.js` does not measure the page while in VR; `vrpalette.js` redraws the board at most every 100 ms while only the brush size or strength changes (each redraw re-uploads a 1024 px texture).

## [0.1.3] - 2026-11-18

### Changed

- The tour's order follows the starting model: `tutorial::model_first()` and `applicable_steps($methods, $modelfirst)` put the modelling steps, then `bake` and the sculpting steps first for both ways of making with the `meshcube` start (without `switchmodel`); the client keeps the server's order (`tutorialsteps.js` `stepsFor()`).
- The steps that open the other way of making (`switchmodel`, or `bake` before the sculpting steps) are offers (`offerAt()`, `offersIn()`): Not now (`tutorial_notnow`) passes over that way's steps, and changing the way of making later opens the tour at them (`tutorial_offer_model`, `tutorial_offer_sculpt`).

### Fixed

- README: the default largest saved piece is 32 MB (`DEFAULT_MAX_SNAPSHOT_SIZE`), not 16 MB.
- Controls under a bar fixed to the window (the navbar, Moodle 5.3's `course-linear-navigation` footer) could not be clicked: `amd/src/bottombar.js` measures both bars, starts the tools just below the top bar, scrolls focused controls, opened menus and the docked tour bubble between them, and sets `--mod-vrmakerspace-bottombar`, which the stage's `max-height` subtracts. Adapted from mod_talkwithai's conversation page.

## [0.1.2] - 2026-11-18

### Added

- Tutorial mode (`tutorial`), with a guided tour of the studio (`amd/src/tutorial.js`, `tutorialsteps.js`), the tutor robot and its demonstrations (`tutor.js`, `tutordemos.js`), saved progress (table `vrmakerspace_tutorial`), the completion rule `completiontutorial` and the event `tutorial_completed`.
- Asking the tutor: `mod_vrmakerspace_ask_tutor` (core_ai `generate_text`, an answer and an optional demonstration), browser-side matching without AI (`tutormatch.js`), activity switch `tutorai`.
- Speech for the tutor: `mod_vrmakerspace_tutor_speak` and `mod_vrmakerspace_tutor_transcribe`, speech engines (browser, Ollama, OpenAI-style, ElevenLabs, Google) ranked in the plugin settings, activity switches `tutorspeak` and `tutorlisten`, caches `speechrate` and `tutoranswer`. Adapted from mod_talkwithai's speech code.

## [0.1.1] - 2026-11-15

The first tagged release.

### Added

- `composer.json` (package `adamjenkins/moodle-mod_vrmakerspace`, type `moodle-mod`, requiring `moodle/moodle` `>=5.2 <5.4` and `moodle/composer-installer` `^1.0`, plus `adamjenkins/moodle-mod_vrroom` `^0.1`) for installing from Packagist.
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
- More sculpting tools and the shape tools: op kinds `inflate`, `pinch`, `flatten`, `shape` and `cutshape`,
  op keys `m` (mirror), `sh` (shape) and `tx` (letters) (`js/engine/ops.js`, `js/engine/shapes.js`,
  `js/engine/font.js`); the start model `empty`; the toolbar's shape group, shape and letters fields
  and Mirror switch; ten tools in two rows on the VR palette, with Mirror. Needs the matching
  `vrroom-sync` for companion work.
- Grading page quick view: `amd/src/quickview.js` and `templates/quickview.mustache` (a core modal
  with the engine worker's mesh and three.js OrbitControls), `studio_helper::worker_url()`, the
  grading rows' `snapshoturl` and `quickviewtitle`; Behat generator entity `mod_vrmakerspace > versions`.
- Uploaded starting models: `startmodel` value `upload`, the `startmodel` file area (one STL, OBJ or
  glTF binary file, backed up and restored), served by `vrmakerspace_pluginfile()` to users who may view
  the activity, and read and voxelised in the engine worker by `js/engine/meshimport.js`.
- Polygon modelling: a mesh layer beside the clay (`js/engine/polymesh.js`, `polyprims.js`, `polyops.js`),
  with shared per-author selections, op kinds `msel`, `mprim`, `mxf`, `mext`, `minset`, `mbevel`, `mloop`,
  `mmerge`, `mdel`, `mfill`, `mflip`, `mmirror` and `mbake` (turn the mesh into clay), op keys `md`, `sm`,
  `ids`, `e`, `n` and `sc`; the studio's method switch, Model panel, keys and VR palette page
  (`amd/src/modeltools.js`, `modelinput.js`, `polyview.js`, `polypick.js`). Needs the matching
  `vrroom-sync` for companion work.
- The `vrmakerspace.methods` field (`both`, `sculpt` or `model`), its form setting and the studio's
  `methods` configuration; the form and `vrmakerspace_clean_instance_data()` keep the starting model to
  what suits the ways of making (forms refuse, saving and restoring correct it).
- The start model `meshcube` (no clay, a polygon cube in the mesh layer).
- The capability `mod/vrmakerspace:make`.

### Changed

- Renamed the plugin from `mod_vrsculpt` to `mod_vrmakerspace`, "VR Makerspace", and its words from
  "sculpture" to "piece" except for the sculpting method itself. Tables, web services, capabilities and
  file areas follow the new component name. No site has the old component: there is no migration.
- Saved snapshots must have a valid "VRSC" header, version 1 (clay only, still read) or version 2 (the
  version the studio writes: `u32 gridLength`, the grid section, the mesh section); a version's operation
  count is the header's sequence number.
- Saved versions are stored as `piece-v<n>.vrsc`.
- `mod_vrmakerspace_get_session_state` and `mod_vrmakerspace_save_snapshot` return the activity's
  `connection`.
