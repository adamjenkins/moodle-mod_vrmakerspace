@mod @mod_vrsculpt
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
      | vrsculpt | Clay animals | SCULPT | sculpt1  |
    When I am on the "Clay animals" "vrsculpt activity" page logged in as "student1"
    And I follow "Open the sculpting studio"
    Then I should see "Your sculpture"
    And I should see "Clay animals"
    And I should see "Back to the activity"
    And I should not see "View only"

  Scenario: The studio page renders for a group's sculpture
    Given the following "groups" exist:
      | name   | course | idnumber |
      | Otters | SCULPT | G1       |
    And the following "group members" exist:
      | user     | group |
      | student1 | G1    |
    And the following "activities" exist:
      | activity | name        | course | idnumber | workmode |
      | vrsculpt | Group whale | SCULPT | sculpt2  | 1        |
    When I am on the "Group whale" "vrsculpt activity" page logged in as "student1"
    And I follow "Open the sculpting studio"
    Then I should see "Sculpture of Otters"
