# Changes

## 0.2.0 (2026-11-27) — ALPHA

The studio is easier to understand the first time you open it.

**For students**
- The studio opens with the basic tools only. **More** shows every tool, and **Less** puts them away again. Every tool has a picture as well as a name.
- A strip above the 3D view says what the task is, that the work saves itself, and when it was last saved. **Show me how** gives the next step in one sentence.
- The help panel is a table of pictures, one row per tool.
- **Brush** holds the brush size and strength in a small pop-up, and the brush outline on the piece fades with a gentler strength.
- The piece stands on a glass stand in a softly lit studio. The camera frames the piece on entry and keeps it in view.
- In group work, the people in the group are shown, and the ones who are in the studio now are marked.
- On a phone, the tools sit in a sheet under the 3D view, with a hint when there are more below.
- The activity page says in plain words what the student does, that the work saves itself, and whether it is graded. "Download" is now **Backup file**.

**Tutorial mode**
- The tutorial's steps sit in a panel beside the 3D view on a computer and in a sheet under it on a phone, so they never cover the tools or the way back.
- The site's AI usage policy is shown first, on its own, when the tutor's AI is on.
- A step about a tool behind More opens More, and the next step that needs only the basic tools closes it.

**AI**
- Features that need an AI appear only when the site has one: without one there is no Ask box, no AI policy and no speech input, and Read aloud uses only the browser's own voice.
- If the AI service does not answer (it cannot be reached, is overloaded or fails), the student sees one calm line ("Tinker can't answer questions right now. The steps still work."), and for 10 minutes nobody on the site is offered the Ask box. The first answer after that clears it. A question the service refuses affects only the student who asked it.
- In the activity settings, teachers see one line when the site has no AI provider, or when the AI service did not answer recently.

**For administrators**
- Upgrade: a new application cache, `aistatus` ("When the AI last failed to answer the tutor"), is registered. The upgrade also removes two plugin settings that pre-release builds used for the same purpose. There are no database changes.
