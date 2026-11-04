@mod @mod_vrmakerspace
Feature: Close and reopen a sculpture
  In order to stop changes once the work is due
  As a teacher
  I need to close a student's sculpture and reopen it

  Background:
    Given the following "users" exist:
      | username | firstname | lastname | email                |
      | teacher1 | Terry     | Teacher  | teacher1@example.com |
      | student1 | Sam       | Student  | student1@example.com |
    And the following "courses" exist:
      | fullname  | shortname | summary |
      | Sculpting | SCULPT    |         |
    And the following "course enrolments" exist:
      | user     | course | role           |
      | teacher1 | SCULPT | editingteacher |
      | student1 | SCULPT | student        |
    And the following "activities" exist:
      | activity | name         | course | idnumber |
      | vrmakerspace | Clay animals | SCULPT | sculpt1  |
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I log out

  Scenario: A teacher closes a sculpture, the student sees it closed, and the teacher reopens it
    Given I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    When I click on "Close" "link" in the "Sam Student" "table_row"
    Then I should see "Close the sculpture of Sam Student?"
    And I press "Close sculpture"
    And I should see "The sculpture is closed."
    And I should see "Closed" in the "Sam Student" "table_row"
    And I log out
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I should see "This sculpture is closed: you can look at it, but not change it."
    And I follow "Open the sculpting studio"
    And I should see "View only"
    And I log out
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    And I click on "Reopen" "link" in the "Sam Student" "table_row"
    And I press "Reopen sculpture"
    And I should see "The sculpture is open again."
    And I should see "Open" in the "Sam Student" "table_row"
    And I should not see "Closed" in the "Sam Student" "table_row"

  Scenario: Cancelling the confirmation changes nothing
    Given I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    When I click on "Reset" "link" in the "Sam Student" "table_row"
    Then I should see "Reset the sculpture of Sam Student?"
    And I press "Cancel"
    And I should see "All sculptures"
    And I should see "Open" in the "Sam Student" "table_row"
