@mod @mod_vrmakerspace
Feature: Create a VR Makerspace activity and see the pieces
  In order to run a making task
  As a teacher
  I need to add a VR Makerspace activity and see my students' pieces

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

  @javascript
  Scenario: A teacher adds the activity through the form
    Given I log in as "teacher1"
    And I add a vrmakerspace activity to course "Making" section "1" and I fill the form with:
      | Name           | Clay animals |
      | Starting model | Clay sphere  |
    When I am on the "Clay animals" "vrmakerspace activity" page
    Then I should see "Clay sphere"
    And I should see "Sculpting and modelling"
    And I should see "Nobody has started a piece yet."
    And I should not see "Your piece"

  @javascript
  Scenario: Modelling only starts from a polygon cube or from nothing
    Given I log in as "teacher1"
    And I add a vrmakerspace activity to course "Making" section "1" and I fill the form with:
      | Name           | Boxes          |
      | Ways of making | Modelling only |
      | Starting model | Clay lump      |
    And I should see "With modelling only, a piece starts from a polygon cube or from nothing."
    When I set the field "Starting model" to "A polygon cube"
    And I press "Save and display"
    Then I should see "Modelling only"
    And I should see "A polygon cube"

  @javascript
  Scenario: Choosing modelling only selects the polygon cube for a clay starting model
    Given I log in as "teacher1"
    And I add a vrmakerspace activity to course "Making" section "1" and I fill the form with:
      | Name           | Boxes          |
      | Ways of making | Modelling only |
    When I am on the "Boxes" "vrmakerspace activity" page
    Then I should see "Modelling only"
    And I should see "A polygon cube"

  @javascript
  Scenario: Sculpting only cannot start from a polygon cube
    Given I log in as "teacher1"
    And I add a vrmakerspace activity to course "Making" section "1" and I fill the form with:
      | Name           | Clay birds     |
      | Ways of making | Sculpting only |
      | Starting model | A polygon cube |
    And I should see "With sculpting only, a piece cannot start from a polygon cube."
    When I set the field "Starting model" to "Clay cube"
    And I press "Save and display"
    Then I should see "Sculpting only"
    And I should see "Clay cube"

  @javascript @_file_upload
  Scenario: A teacher starts the pieces from an uploaded model
    Given I log in as "teacher1"
    And I add a vrmakerspace activity to course "Making" section "1" and I fill the form with:
      | Name           | Clay owls      |
      | Starting model | Uploaded model |
    And I should see "Upload an STL, OBJ or glTF binary (.glb) file, or choose another starting model."
    When I upload "mod/vrmakerspace/tests/fixtures/tetrahedron.stl" file to "Model file" filemanager
    And I press "Save and display"
    Then I should see "Uploaded model"
    And I navigate to "Settings" in current page administration
    And I expand all fieldsets
    And I should see "tetrahedron.stl"

  Scenario: A student gets their own piece and the teacher sees it
    Given the following "activities" exist:
      | activity     | name         | course | idnumber | startmodel |
      | vrmakerspace | Clay animals | MAKE   | make1    | cube       |
    When I am on the "Clay animals" "vrmakerspace activity" page logged in as "student1"
    Then I should see "Your piece"
    And I should see "Clay cube"
    And I should see "Not saved yet."
    And I should not see "All pieces"
    And I am on the "Clay animals" "vrmakerspace activity" page logged in as "teacher1"
    And I should see "All pieces"
    And "Sam Student" "table_row" should exist
    And "Sue Student" "table_row" should not exist

  Scenario: A student in group work with no group is told so
    Given the following "activities" exist:
      | activity     | name        | course | idnumber | workmode |
      | vrmakerspace | Group whale | MAKE   | make2    | 1        |
    When I am on the "Group whale" "vrmakerspace activity" page logged in as "student1"
    Then I should see "you are not in a group for it"
    And I should not see "Your piece"
