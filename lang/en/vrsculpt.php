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
$string['cannotsculpt'] = 'You cannot sculpt in this sculpture: it is closed, or it is not yours or your group\'s.';
$string['errornoscales'] = 'VR sculpting grades are points only; choose the "Point" grade type.';
$string['gradeoutofrange'] = 'The grade must be between 0 and {$a}.';
$string['groupsculpture'] = 'Sculpture of {$a}';
$string['invalidsession'] = 'This sculpture does not exist in this activity.';
$string['lastsaved'] = 'Last saved';
$string['maxsnapshotsize'] = 'Largest saved sculpture';
$string['maxsnapshotsize_desc'] = 'The largest sculpture file a user can save. Larger saves are refused.';
$string['maxusers'] = 'People sculpting at once';
$string['maxusers_help'] = 'The most people who can sculpt one group\'s sculpture at the same time.';
$string['modulename'] = 'VR sculpting';
$string['modulename_help'] = 'In a VR sculpting activity, students sculpt a 3D model in a VR headset or in the browser, on their own or together with their group in one shared sculpture. Each save is kept as a version, and teachers can look at every sculpture and grade it.';
$string['modulenameplural'] = 'VR sculpting activities';
$string['nogroup'] = 'This activity is done in groups, and you are not in a group for it. Ask your teacher to add you to one.';
$string['nosculptures'] = 'Nobody has started a sculpture yet.';
$string['noversions'] = 'Not saved yet.';
$string['owner'] = 'Sculptor';
$string['pluginadministration'] = 'VR sculpting administration';
$string['pluginname'] = 'VR sculpting';
$string['privacy:metadata:core_files'] = 'Each saved version of a sculpture is stored as a file.';
$string['privacy:metadata:grades'] = 'The grade each user was given.';
$string['privacy:metadata:grades:grade'] = 'The grade.';
$string['privacy:metadata:grades:grader'] = 'The user who gave the grade.';
$string['privacy:metadata:grades:timemodified'] = 'When the grade was last changed.';
$string['privacy:metadata:grades:userid'] = 'The user who was graded.';
$string['privacy:metadata:sessions'] = 'Sculptures: one per user, or one per group shared by its members.';
$string['privacy:metadata:sessions:groupid'] = 'The group whose sculpture it is, for group work.';
$string['privacy:metadata:sessions:timecreated'] = 'When the sculpture was started.';
$string['privacy:metadata:sessions:timemodified'] = 'When the sculpture was last saved.';
$string['privacy:metadata:sessions:userid'] = 'The user whose sculpture it is, for individual work.';
$string['privacy:metadata:snapshots'] = 'The saved versions of each sculpture.';
$string['privacy:metadata:snapshots:opcount'] = 'How many sculpting operations had been made when the version was saved.';
$string['privacy:metadata:snapshots:timecreated'] = 'When the version was saved.';
$string['privacy:metadata:snapshots:userid'] = 'The user who saved the version.';
$string['privacy:metadata:snapshots:version'] = 'The version number.';
$string['privacy:path:sculpture'] = 'Sculpture {$a}';
$string['resetsessions'] = 'Delete all sculptures, their versions and grades';
$string['savedby'] = 'Saved by';
$string['sculptingsettings'] = 'Sculpting';
$string['snapshotinvalid'] = 'The sculpture could not be saved: its data is not a VR sculpting file.';
$string['snapshottoolarge'] = 'The sculpture could not be saved: it is larger than {$a}.';
$string['startmodel'] = 'Starting model';
$string['startmodel_cube'] = 'Cube';
$string['startmodel_help'] = 'The shape every new sculpture starts from.';
$string['startmodel_lump'] = 'Clay lump';
$string['startmodel_sphere'] = 'Sphere';
$string['status'] = 'Status';
$string['statusclosed'] = 'Closed';
$string['statusopen'] = 'Open';
$string['studionotavailable'] = 'The 3D sculpting studio is not part of this development version yet.';
$string['timesaved'] = 'Saved';
$string['trackcontributions'] = 'Track each person\'s contribution';
$string['trackcontributions_help'] = 'Record how much of a group\'s sculpture each member made, so that teachers can take it into account when grading.';
$string['version'] = 'Version';
$string['versionhistory'] = 'Versions';
$string['versions'] = 'Versions';
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
$string['yourgroup'] = 'Your group';
$string['yoursculpture'] = 'Your sculpture';
