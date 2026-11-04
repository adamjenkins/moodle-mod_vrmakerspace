@mod @mod_vrmakerspace
Feature: Grade pieces
  In order to assess my students' pieces
  As a teacher
  I need to grade each student, or every member of a group at once

  Background:
    Given the following "users" exist:
      | username | firstname | lastname | email                |
      | teacher1 | Terry     | Teacher  | teacher1@example.com |
      | student1 | Sam       | Student  | student1@example.com |
      | student2 | Sue       | Student  | student2@example.com |
    And the following "courses" exist:
      | fullname | shortname | summary |
      | Making   | MAKE      |         |
    And the following "course enrolments" exist:
      | user     | course | role           |
      | teacher1 | MAKE   | editingteacher |
      | student1 | MAKE   | student        |
      | student2 | MAKE   | student        |

  Scenario: A teacher grades a student's piece
    Given the following "activities" exist:
      | activity     | name         | course | idnumber | grade |
      | vrmakerspace | Clay animals | MAKE   | make1    | 100   |
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I log out
    When I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    And I follow "Grade pieces"
    Then I should see "Grades are out of 100.00."
    And I should see "Not saved yet."
    And I set the field "Grade for Sam Student" to "75"
    And I press "Save grades"
    And I should see "Grades saved (1 changed)."
    And the field "Grade for Sam Student" matches value "75.00"
    And I set the field "Grade for Sam Student" to "120"
    And I press "Save grades"
    And I should see "1 grades could not be saved"
    And I should see "The grade must be between 0 and 100.00."

  Scenario: A teacher gives every member of a group the same grade
    Given the following "groups" exist:
      | name   | course | idnumber |
      | Otters | MAKE   | G1       |
    And the following "group members" exist:
      | user     | group |
      | student1 | G1    |
      | student2 | G1    |
    And the following "activities" exist:
      | activity     | name        | course | idnumber | workmode | grade |
      | vrmakerspace | Group whale | MAKE   | make2    | 1        | 50    |
    And I am on the "Group whale" "vrmakerspace activity" page logged in as "student1"
    And I should see "Piece of Otters"
    And I log out
    When I am on the "Group whale" "vrmakerspace activity" page logged in as "teacher1"
    And I follow "Grade pieces"
    And I set the field "Give every member of Otters this grade" to "40"
    And I press "Save grades"
    Then I should see "Grades saved (2 changed)."
    And the field "Grade for Sam Student" matches value "40.00"
    And the field "Grade for Sue Student" matches value "40.00"

  @javascript
  Scenario: A teacher looks at a saved version in the quick view
    Given the following "activities" exist:
      | activity     | name         | course | idnumber | grade |
      | vrmakerspace | Clay animals | MAKE   | make1    | 100   |
    And the following "mod_vrmakerspace > versions" exist:
      | activity | user     |
      | make1    | student1 |
    When I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    And I follow "Grade pieces"
    And I click on "Quick view of Sam Student, version 1" "button"
    Then I should see "Sam Student, version 1" in the ".modal-title" "css_element"
    And I should see "Drag to turn the piece" in the ".modal-body" "css_element"
    And "Zoom in" "button" should exist in the ".modal-body" "css_element"
    And I click on "Zoom in" "button" in the ".modal-body" "css_element"
    And I click on "Reset view" "button" in the ".modal-body" "css_element"
    And I click on "Close" "button" in the ".modal-dialog" "css_element"
    And ".modal-body" "css_element" should not exist
