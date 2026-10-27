<?php
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
 * English strings for mod_vrsculpt.
 *
 * @package    mod_vrsculpt
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$string['allsculptures'] = 'All sculptures';
$string['anonymised'] = 'Anonymised user';
$string['back'] = 'Back to the activity';
$string['brushsize'] = 'Size';
$string['brushstrength'] = 'Strength';
$string['cannotsculpt'] = 'You cannot sculpt in this sculpture: it is closed, or it is not yours or your group\'s.';
$string['companionnotconfigured'] = 'The companion service is not set up on this site.';
$string['connection'] = 'Sculpting together';
$string['connection_companion'] = 'With up to {$a} people (companion service)';
$string['connection_help'] = 'How the members of a group sculpt their sculpture together. With one partner, two members sculpt at the same time, their browsers connected directly: this is built in and needs no extra server. With the companion service, up to the chosen number of members sculpt at the same time through VR room\'s companion service, which the site administrator runs and sets up.';
$string['connection_notconfigured'] = 'The companion service is not set up on this site yet. Until it is, the members sculpt with one partner at a time.';
$string['connection_notinstalled'] = 'The companion service (the VR room companion plugin) is not installed on this site.';
$string['connection_pair'] = 'With one partner (built in)';
$string['contributionadded'] = 'Clay added (cm³)';
$string['contributionof'] = '{$a->name}: {$a->share}';
$string['contributionops'] = 'Operations';
$string['contributionremoved'] = 'Clay removed (cm³)';
$string['contributions'] = 'Contributions';
$string['contributionshare'] = 'Share';
$string['contributionsnottracked'] = 'This activity does not track contributions.';
$string['entervr'] = 'Enter VR';
$string['errornoscales'] = 'VR sculpting grades are points only; choose the "Point" grade type.';
$string['exitvr'] = 'Exit VR';
$string['export'] = 'Export';
$string['export_3mf'] = '3MF (3D printing)';
$string['export_glb'] = 'glTF binary (.glb)';
$string['export_stl'] = 'STL (3D printing)';
$string['exportfailed'] = 'The export failed: {$a}';
$string['exportproblems'] = '{$a} edges are open or shared by more than two faces';
$string['exportreport'] = '{$a->triangles} triangles, {$a->size} mm: {$a->status}';
$string['exportwatertight'] = 'watertight and manifold, ready to print';
$string['fullscreen'] = 'Full screen';
$string['gradeallmembers'] = 'Give every member of {$a} this grade';
$string['gradefor'] = 'Grade for {$a}';
$string['gradeintro'] = 'Grades are out of {$a}. Leave a field empty to remove a grade.';
$string['gradeinvalid'] = 'This is not a number.';
$string['gradeoutofrange'] = 'The grade must be between 0 and {$a}.';
$string['gradesculptures'] = 'Grade sculptures';
$string['gradesnotallsaved'] = '{$a} grades could not be saved: see the fields marked below.';
$string['gradessaved'] = 'Grades saved ({$a} changed).';
$string['grading'] = 'Grading';
$string['groupsculpture'] = 'Sculpture of {$a}';
$string['invalidaction'] = 'This action does not exist.';
$string['invalidsession'] = 'This sculpture does not exist in this activity.';
$string['invalidstatus'] = 'A sculpture is either open or closed.';
$string['invalidversion'] = 'This version of the sculpture does not exist.';
$string['lastsaved'] = 'Last saved';
$string['latestversion'] = 'Latest version: {$a}';
$string['lockedbyother'] = '{$a} is working here';
$string['manage_close'] = 'Close';
$string['manage_reopen'] = 'Reopen';
$string['manage_reset'] = 'Reset';
$string['manageconfirm_close'] = 'Close the sculpture of {$a}? Nobody can change it until it is reopened; it can still be viewed and graded.';
$string['manageconfirm_reopen'] = 'Reopen the sculpture of {$a}, so that it can be changed again?';
$string['manageconfirm_reset'] = 'Reset the sculpture of {$a}? Every saved version and the recorded contributions are deleted, and it starts again from the starting model. This cannot be undone. Ask everyone to leave the studio first: an open studio would save its sculpture again.';
$string['manageconfirmbutton_close'] = 'Close sculpture';
$string['manageconfirmbutton_reopen'] = 'Reopen sculpture';
$string['manageconfirmbutton_reset'] = 'Reset sculpture';
$string['managedone_close'] = 'The sculpture is closed.';
$string['managedone_reopen'] = 'The sculpture is open again.';
$string['managedone_reset'] = 'The sculpture was reset: all its versions are deleted.';
$string['maxsnapshotsize'] = 'Largest saved sculpture';
$string['maxsnapshotsize_desc'] = 'The largest sculpture file a user can save. Larger saves are refused.';
$string['maxusers'] = 'People sculpting at once';
$string['maxusers_help'] = 'With the companion service, the most people who can sculpt one group\'s sculpture at the same time. Working with one partner is always two people.';
$string['modulename'] = 'VR sculpting';
$string['modulename_help'] = 'In a VR sculpting activity, students sculpt a 3D model in a VR headset or in the browser, on their own or together with their group in one shared sculpture. Each save is kept as a version, and teachers can look at every sculpture and grade it.';
$string['modulenameplural'] = 'VR sculpting activities';
$string['nobodytograde'] = 'Nobody who sculpts this sculpture can be graded here.';
$string['nogroup'] = 'This activity is done in groups, and you are not in a group for it. Ask your teacher to add you to one.';
$string['nosculptures'] = 'Nobody has started a sculpture yet.';
$string['notcompanionwork'] = 'This activity\'s groups do not sculpt over the companion service.';
$string['notgraded'] = 'This activity is not graded. Choose a maximum grade in its settings to grade sculptures.';
$string['notpairwork'] = 'This activity\'s groups do not sculpt with one partner.';
$string['noversions'] = 'Not saved yet.';
$string['openstudio'] = 'Open the sculpting studio';
$string['owner'] = 'Sculptor';
$string['pairbusy'] = 'Too many people are connecting at once. Try again in a moment.';
$string['peergone'] = 'Your connection to this sculpture has ended. Join it again.';
$string['peerjoined'] = '{$a} joined';
$string['peerleft'] = '{$a} left';
$string['peernotfound'] = 'Your partner is no longer connected.';
$string['pluginadministration'] = 'VR sculpting administration';
$string['pluginname'] = 'VR sculpting';
$string['privacy:metadata:contrib'] = 'How much of a sculpture each person made, when the activity tracks contributions.';
$string['privacy:metadata:contrib:added'] = 'How much clay the user added.';
$string['privacy:metadata:contrib:ops'] = 'How many sculpting operations the user made.';
$string['privacy:metadata:contrib:removed'] = 'How much clay the user removed.';
$string['privacy:metadata:contrib:timemodified'] = 'When the share was last updated.';
$string['privacy:metadata:contrib:userid'] = 'The user whose share it is.';
$string['privacy:metadata:core_files'] = 'Each saved version of a sculpture is stored as a file.';
$string['privacy:metadata:grades'] = 'The grade each user was given.';
$string['privacy:metadata:grades:grade'] = 'The grade.';
$string['privacy:metadata:grades:grader'] = 'The user who gave the grade.';
$string['privacy:metadata:grades:timemodified'] = 'When the grade was last changed.';
$string['privacy:metadata:grades:userid'] = 'The user who was graded.';
$string['privacy:metadata:pairpartner'] = 'When two members of a group sculpt with one partner, their browsers connect to each other directly. The partner\'s browser receives:';
$string['privacy:metadata:pairpartner:address'] = 'The network addresses of the user\'s device, which the browsers exchange to connect.';
$string['privacy:metadata:pairpartner:edits'] = 'The user\'s sculpting edits and the position of their head and hands.';
$string['privacy:metadata:pairpartner:fullname'] = 'The user\'s full name.';
$string['privacy:metadata:peers'] = 'The people connected to a group sculpture with one partner, kept while their studio is open and deleted within an hour.';
$string['privacy:metadata:peers:lastseen'] = 'When the user\'s studio was last connected.';
$string['privacy:metadata:peers:role'] = 'Whether the user\'s studio ordered the edits (host) or followed (guest).';
$string['privacy:metadata:peers:timecreated'] = 'When the user joined.';
$string['privacy:metadata:peers:userid'] = 'The user connected.';
$string['privacy:metadata:sessions'] = 'Sculptures: one per user, or one per group shared by its members.';
$string['privacy:metadata:sessions:groupid'] = 'The group whose sculpture it is, for group work.';
$string['privacy:metadata:sessions:timecreated'] = 'When the sculpture was started.';
$string['privacy:metadata:sessions:timemodified'] = 'When the sculpture was last saved.';
$string['privacy:metadata:sessions:userid'] = 'The user whose sculpture it is, for individual work.';
$string['privacy:metadata:signals'] = 'The connection messages between the two browsers of pair work, deleted once delivered, or within an hour.';
$string['privacy:metadata:signals:fromuserid'] = 'The user who sent the message.';
$string['privacy:metadata:signals:payload'] = 'The message: connection offers and network addresses of the sender\'s device.';
$string['privacy:metadata:signals:timecreated'] = 'When the message was sent.';
$string['privacy:metadata:snapshots'] = 'The saved versions of each sculpture.';
$string['privacy:metadata:snapshots:opcount'] = 'How many sculpting operations had been made when the version was saved.';
$string['privacy:metadata:snapshots:timecreated'] = 'When the version was saved.';
$string['privacy:metadata:snapshots:userid'] = 'The user who saved the version.';
$string['privacy:metadata:snapshots:version'] = 'The version number.';
$string['privacy:metadata:vrroomsync'] = 'When a group sculpts over VR room\'s companion service, the service receives:';
$string['privacy:metadata:vrroomsync:edits'] = 'The user\'s sculpting edits and the position of their head and hands.';
$string['privacy:metadata:vrroomsync:fullname'] = 'The user\'s full name, shown to the others in the sculpture.';
$string['privacy:metadata:vrroomsync:peerid'] = 'A pseudonym of the user in the sculpture, made by this site.';
$string['privacy:path:sculpture'] = 'Sculpture {$a}';
$string['redo'] = 'Redo';
$string['resetsessions'] = 'Delete all sculptures, their versions, contributions and grades';
$string['savedby'] = 'Saved by';
$string['savedversion'] = 'Saved version {$a}';
$string['savefailed'] = 'Saving failed: {$a}';
$string['savegrades'] = 'Save grades';
$string['savenow'] = 'Save now';
$string['saving'] = 'Saving…';
$string['sculptingsettings'] = 'Sculpting';
$string['sculptureclosed'] = 'This sculpture is closed: you can look at it, but not change it.';
$string['sculptureof'] = 'Sculpture of {$a}';
$string['sessionfull'] = 'The most people allowed are already sculpting this sculpture.';
$string['shortcuts'] = 'Keyboard: 1–5 choose a tool, [ and ] change the size, comma and full stop change the strength, Ctrl+Z undoes, Ctrl+Shift+Z redoes. Drag with the left button to sculpt, the right button to turn, the wheel to zoom.';
$string['signalinvalid'] = 'This connection message cannot be sent.';
$string['signalqueuefull'] = 'Your partner has too many connection messages waiting. Try again in a moment.';
$string['signaltoolarge'] = 'This connection message is too large.';
$string['snapshotinvalid'] = 'The sculpture could not be saved: its data is not a VR sculpting file.';
$string['snapshottoolarge'] = 'The sculpture could not be saved: it is larger than {$a}.';
$string['startmodel'] = 'Starting model';
$string['startmodel_cube'] = 'Cube';
$string['startmodel_help'] = 'The shape every new sculpture starts from: a clay lump, a sphere, a cube, or a model you upload.';
$string['startmodel_lump'] = 'Clay lump';
$string['startmodel_sphere'] = 'Sphere';
$string['startmodel_upload'] = 'Uploaded model';
$string['startmodelfile'] = 'Model file';
$string['startmodelfile_help'] = 'A 3D model to start every new sculpture from: STL, OBJ or glTF binary (.glb). The model is centred and scaled so its longest side is 22 cm, whatever its units, and turned into clay of about 4 mm detail; colours and textures are dropped. Closed (watertight) models work best. Replacing the file changes the start of sculptures that have no saved version yet.';
$string['startmodelfile_required'] = 'Upload an STL, OBJ or glTF binary (.glb) file, or choose another starting model.';
$string['status'] = 'Status';
$string['status_closed'] = 'This sculpture is closed: changes are not saved.';
$string['status_companionmissing'] = 'The companion service is not set up, so you sculpt with one partner.';
$string['status_companionold'] = 'The companion service is too old for sculpting together.';
$string['status_connected'] = 'Sculpting with {$a}';
$string['status_connecting'] = 'Connecting…';
$string['status_failed'] = 'Live sculpting is not available: {$a}';
$string['status_full'] = 'The most people allowed are already sculpting this sculpture.';
$string['status_lost'] = 'The connection to the others was lost. Reload the page to sculpt together again.';
$string['status_reconnecting'] = 'Reconnecting…';
$string['status_replaced'] = 'You opened this sculpture in another window, so live sculpting stopped here.';
$string['status_resyncing'] = 'Catching up with the others…';
$string['status_solo'] = 'Working on your own';
$string['status_waiting'] = 'Waiting for someone from your group';
$string['statusclosed'] = 'Closed';
$string['statusopen'] = 'Open';
$string['studio_failed'] = 'The studio could not start: {$a}';
$string['studio_loading'] = 'Loading the sculpture…';
$string['studio_nowebgl'] = 'This browser cannot show 3D (WebGL is off or missing).';
$string['studio_readonly'] = 'View only';
$string['studiotitleversion'] = '{$a->owner}, version {$a->version}';
$string['taskcleanup'] = 'Remove expired live sculpting connections';
$string['timesaved'] = 'Saved';
$string['tool_add'] = 'Add';
$string['tool_carve'] = 'Carve';
$string['tool_grab'] = 'Grab';
$string['tool_smooth'] = 'Smooth';
$string['tool_twist'] = 'Twist';
$string['tools'] = 'Tools';
$string['trackcontributions'] = 'Track each person\'s contribution';
$string['trackcontributions_help'] = 'Record how much of a group\'s sculpture each member made, so that teachers can take it into account when grading.';
$string['undo'] = 'Undo';
$string['version'] = 'Version';
$string['versionhistory'] = 'Versions';
$string['versions'] = 'Versions';
$string['viewin3d'] = 'View in 3D';
$string['vrhelp'] = 'In VR: the right trigger sculpts, the right stick changes size and strength, A and B change the tool, the left grip moves the sculpture, X undoes and Y redoes. With hands: pinch to sculpt.';
$string['vrsculpt:addinstance'] = 'Add a new VR sculpting activity';
$string['vrsculpt:grade'] = 'Grade sculptures';
$string['vrsculpt:managesessions'] = 'Open, close and reset sculptures';
$string['vrsculpt:sculpt'] = 'Sculpt';
$string['vrsculpt:view'] = 'View a VR sculpting activity';
$string['vrsculpt:viewallsubmissions'] = 'View everyone\'s sculptures';
$string['workmode'] = 'Work';
$string['workmode_group'] = 'In groups: one shared sculpture per group';
$string['workmode_help'] = 'Individually, each student sculpts their own model. In groups, the members of each group sculpt one shared model together; the groups come from the activity\'s grouping, or from the course when it has none.';
$string['workmode_individual'] = 'Individually: one sculpture per student';
$string['yourcontribution'] = 'Your contribution: {$a->ops} operations, {$a->share} of the changes.';
$string['yourgroup'] = 'Your group';
$string['yoursculpture'] = 'Your sculpture';
