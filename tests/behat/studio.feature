@mod @mod_vrmakerspace
Feature: Open the sculpting studio
  In order to sculpt
  As a student
  I need to open the studio from the activity page

  Background:
    Given the following "users" exist:
      | username | firstname | lastname | email                |
      | student1 | Sam       | Student  | student1@example.com |
    And the following "courses" exist:
      | fullname  | shortname | summary |
      | Sculpting | SCULPT    |         |
    And the following "course enrolments" exist:
      | user     | course | role    |
      | student1 | SCULPT | student |

  Scenario: The studio page renders for a student's own sculpture
    Given the following "activities" exist:
      | activity | name         | course | idnumber |
      | vrmakerspace | Clay animals | SCULPT | sculpt1  |
    When I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    And I follow "Open the sculpting studio"
    Then I should see "Your sculpture"
    And I should see "Clay animals"
    And I should see "Back to the activity"
    And I should not see "View only"
    And "Inflate" "button" should exist
    And "Pinch" "button" should exist
    And "Flatten" "button" should exist
    And "Add shape" "button" should exist
    And "Cut shape" "button" should exist
    And "Mirror" "button" should exist

  Scenario: The studio page renders for a group's sculpture
    Given the following "groups" exist:
      | name   | course | idnumber |
      | Otters | SCULPT | G1       |
    And the following "group members" exist:
      | user     | group |
      | student1 | G1    |
    And the following "activities" exist:
      | activity | name        | course | idnumber | workmode |
      | vrmakerspace | Group whale | SCULPT | sculpt2  | 1        |
    When I am on the "Group whale" "vrmakerspace activity" page logged in as "student1"
    And I follow "Open the sculpting studio"
    Then I should see "Sculpture of Otters"
