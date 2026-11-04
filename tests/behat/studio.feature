@mod @mod_vrmakerspace
Feature: Open the makerspace studio
  In order to make a piece
  As a student
  I need to open the studio from the activity page, with the ways of making the activity allows

  Background:
    Given the following "users" exist:
      | username | firstname | lastname | email                |
      | student1 | Sam       | Student  | student1@example.com |
    And the following "courses" exist:
      | fullname | shortname | summary |
      | Making   | MAKE      |         |
    And the following "course enrolments" exist:
      | user     | course | role    |
      | student1 | MAKE   | student |

  Scenario: The studio page renders for a student's own piece, with the Sculpt and Model controls
    Given the following "activities" exist:
      | activity     | name         | course | idnumber |
      | vrmakerspace | Clay animals | MAKE   | make1    |
    When I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I should see "Sculpting and modelling"
    And I follow "Open the makerspace"
    Then I should see "Your piece"
    And I should see "Clay animals"
    And I should see "Back to the activity"
    And I should not see "View only"
    And "Inflate" "button" should exist
    And "Pinch" "button" should exist
    And "Flatten" "button" should exist
    And "Add shape" "button" should exist
    And "Cut shape" "button" should exist
    And "Mirror" "button" should exist
    And "Extrude" "button" should exist
    And "Loop cut" "button" should exist
    And "Turn into clay" "button" should exist

  Scenario: A sculpting-only activity hides the Model controls
    Given the following "activities" exist:
      | activity     | name       | course | idnumber | methods |
      | vrmakerspace | Clay birds | MAKE   | make3    | sculpt  |
    When I am on the "Clay birds" "vrmakerspace activity" page logged in as "student1"
    And I should see "Sculpting only"
    And I follow "Open the makerspace"
    Then "Inflate" "button" should exist
    And "Extrude" "button" should not exist
    And "Loop cut" "button" should not exist
    And "Turn into clay" "button" should not exist

  Scenario: A modelling-only activity hides the Sculpt controls
    Given the following "activities" exist:
      | activity     | name  | course | idnumber | methods |
      | vrmakerspace | Boxes | MAKE   | make4    | model   |
    When I am on the "Boxes" "vrmakerspace activity" page logged in as "student1"
    And I should see "Modelling only"
    And I should see "A polygon cube"
    And I follow "Open the makerspace"
    Then "Extrude" "button" should exist
    And "Inflate" "button" should not exist
    And "Pinch" "button" should not exist

  Scenario: The studio page renders for a group's piece
    Given the following "groups" exist:
      | name   | course | idnumber |
      | Otters | MAKE   | G1       |
    And the following "group members" exist:
      | user     | group |
      | student1 | G1    |
    And the following "activities" exist:
      | activity     | name        | course | idnumber | workmode |
      | vrmakerspace | Group whale | MAKE   | make2    | 1        |
    When I am on the "Group whale" "vrmakerspace activity" page logged in as "student1"
    And I follow "Open the makerspace"
    Then I should see "Piece of Otters"
