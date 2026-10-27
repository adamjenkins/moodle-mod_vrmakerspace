# VR sculpting — sculpt 3D models together in Moodle

VR sculpting is a Moodle activity in which students sculpt a 3D model, alone or together with their
group in one shared sculpture. Every save is kept as a version, and teachers see every sculpture and
grade it in the gradebook.

It is part of the VR room suite (`mod_vrroom`): the 3D sculpting studio (WebXR on a Meta Quest
browser, or the desktop browser with mouse and keyboard) reuses VR room's built-in viewer, and live
group sculpting runs over the VR room companion service (`vrroom-sync`).

**Status: ALPHA, milestone 1 of 6.** This version is the activity skeleton: settings, sculptures
(one per student, or one per group), saved versions with their history, grading data, privacy,
backup and restore, and course reset. The 3D studio itself is not included yet, so the activity
page shows the sculptures and their versions but cannot open them in 3D.

## Requirements

- Moodle 5.2 or 5.3 (`$plugin->supported = [502, 503]`).

## Installation

1. Copy this repository to `public/mod/vrsculpt` in your Moodle code.
2. Visit *Site administration > Notifications* to install it.
3. Optionally set the largest saved sculpture in *Site administration > Plugins > Activity modules >
   VR sculpting* (16 MB by default).

## Settings of an activity

- **Starting model**: clay lump, sphere or cube.
- **Work**: individually (one sculpture per student) or in groups (one shared sculpture per group;
  the groups come from the activity's grouping, or from the course when it has none).
- **People sculpting at once** (group work): 2 to 8.
- **Track each person's contribution** (group work).
- **Grade**: points only.

## Capabilities

| Capability | Default roles | What it allows |
|---|---|---|
| `mod/vrsculpt:addinstance` | editing teacher, manager | Add the activity |
| `mod/vrsculpt:view` | guest, student, teachers, manager | Open the activity |
| `mod/vrsculpt:sculpt` | student | Have a sculpture (or share the group's) and save versions |
| `mod/vrsculpt:viewallsubmissions` | teachers, manager | See everyone's sculptures |
| `mod/vrsculpt:grade` | teachers, manager | Grade sculptures |
| `mod/vrsculpt:managesessions` | editing teacher, manager | Open, close and reset sculptures |

## Privacy

A user's own sculptures with all their versions, the versions they saved of a group's sculpture,
and their grades are personal data, exported and deleted through Moodle's privacy API. A group's
sculpture is the group's shared work: deleting one member keeps it and anonymises the versions that
member saved.

## Licence

GNU GPL v3 or later; see `LICENSE`.
