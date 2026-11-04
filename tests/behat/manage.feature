@mod @mod_vrmakerspace
Feature: Close and reopen a piece
  In order to stop changes once the work is due
  As a teacher
  I need to close a student's piece and reopen it

  Background:
    Given the following "users" exist:
      | username | firstname | lastname | email                |
      | teacher1 | Terry     | Teacher  | teacher1@example.com |
      | student1 | Sam       | Student  | student1@example.com |
    And the following "courses" exist:
      | fullname | shortname | summary |
      | Making   | MAKE      |         |
    And the following "course enrolments" exist:
      | user     | course | role           |
      | teacher1 | MAKE   | editingteacher |
      | student1 | MAKE   | student        |
    And the following "activities" exist:
      | activity     | name         | course | idnumber |
      | vrmakerspace | Clay animals | MAKE   | make1    |
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I log out

  Scenario: A teacher closes a piece, the student sees it closed, and the teacher reopens it
    Given I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    When I click on "Close" "link" in the "Sam Student" "table_row"
    Then I should see "Close the piece of Sam Student?"
    And I press "Close piece"
    And I should see "The piece is closed."
    And I should see "Closed" in the "Sam Student" "table_row"
    And I log out
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I should see "This piece is closed: you can look at it, but not change it."
    And I follow "Open the makerspace"
    And I should see "View only"
    And I log out
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    And I click on "Reopen" "link" in the "Sam Student" "table_row"
    And I press "Reopen piece"
    And I should see "The piece is open again."
    And I should see "Open" in the "Sam Student" "table_row"
    And I should not see "Closed" in the "Sam Student" "table_row"

  Scenario: Cancelling the confirmation changes nothing
    Given I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    When I click on "Reset" "link" in the "Sam Student" "table_row"
    Then I should see "Reset the piece of Sam Student?"
    And I press "Cancel"
    And I should see "All pieces"
    And I should see "Open" in the "Sam Student" "table_row"
