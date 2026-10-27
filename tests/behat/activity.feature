@mod @mod_vrsculpt
Feature: Create a VR sculpting activity and see the sculptures
  In order to run a sculpting task
  As a teacher
  I need to add a VR sculpting activity and see my students' sculptures

  Background:
    Given the following "users" exist:
      | username | firstname | lastname | email                |
      | teacher1 | Terry     | Teacher  | teacher1@example.com |
      | student1 | Sam       | Student  | student1@example.com |
      | student2 | Sue       | Student  | student2@example.com |
    And the following "courses" exist:
      | fullname  | shortname | summary |
      | Sculpting | SCULPT    |         |
    And the following "course enrolments" exist:
      | user     | course | role           |
      | teacher1 | SCULPT | editingteacher |
      | student1 | SCULPT | student        |
      | student2 | SCULPT | student        |

  @javascript
  Scenario: A teacher adds the activity through the form
    Given I log in as "teacher1"
    And I add a vrsculpt activity to course "Sculpting" section "1" and I fill the form with:
      | Name           | Clay animals |
      | Starting model | Sphere       |
    When I am on the "Clay animals" "vrsculpt activity" page
    Then I should see "Sphere"
    And I should see "Nobody has started a sculpture yet."
    And I should not see "Your sculpture"

  Scenario: A student gets their own sculpture and the teacher sees it
    Given the following "activities" exist:
      | activity | name         | course | idnumber | startmodel |
      | vrsculpt | Clay animals | SCULPT | sculpt1  | cube       |
    When I am on the "Clay animals" "vrsculpt activity" page logged in as "student1"
    Then I should see "Your sculpture"
    And I should see "Cube"
    And I should see "Not saved yet."
    And I should not see "All sculptures"
    And I am on the "Clay animals" "vrsculpt activity" page logged in as "teacher1"
    And I should see "All sculptures"
    And "Sam Student" "table_row" should exist
    And "Sue Student" "table_row" should not exist

  Scenario: A student in group work with no group is told so
    Given the following "activities" exist:
      | activity | name        | course | idnumber | workmode |
      | vrsculpt | Group whale | SCULPT | sculpt2  | 1        |
    When I am on the "Group whale" "vrsculpt activity" page logged in as "student1"
    Then I should see "you are not in a group for it"
    And I should not see "Your sculpture"
