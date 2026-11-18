# Changes

## Unreleased

- The tutorial starts with the way of making that is on screen: an activity that starts with the polygon cube teaches modelling first, one that starts with clay teaches sculpting first. At the end of that part it offers the other way (Turn into clay, or the switch to Model) with Not now to pass it by, and when the student makes that change later on their own, it opens at the steps for it.
- The studio's controls stay clear of the bars fixed to the window: the site's top bar and Moodle 5.3's activity navigation footer. Before, at some window sizes the first row of tools sat under the top bar and the bottom of the 3D view under the footer, so a click landed on the bar instead (for example on the course index button).

## 0.1.2 (2026-11-18) — ALPHA

- Tutorial mode: the studio becomes a guided tour of itself (up to 40 steps that follow the activity's ways of making), with Tinker, a tutor robot that points at each control and demonstrates every tool on the student's practice piece. Progress is saved; new completion condition "Students must finish the tutorial". Tutorial mode is individual work.
- Students can ask the tutor how to do something, typed or spoken. With the site's AI (Moodle's AI subsystem) the tutor answers and, where it fits, demonstrates the tool on the piece; without AI it matches the question to the tour's tools and demonstrates them. Each part can be switched on or off per activity.
- The tutor can speak its answers and the steps, and listen to spoken questions, also in VR (hold either thumbstick). The site administrator ranks the speech services for speaking and for listening: the browser, Ollama, an OpenAI-style audio server, ElevenLabs or Google Cloud.
