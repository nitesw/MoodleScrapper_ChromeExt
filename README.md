# Moodle Course Scraper (moodle.vinci.be)

This Chrome extension (Manifest V3) exports the Moodle course open in the current tab as one ZIP: `course.md` plus every downloadable file. The output is meant to be fed to Claude to build a study plan. The text is kept as it appears on Moodle, in French, without translation.

Everything is plain JS with no build step and no framework. JSZip 3.10.1 is bundled in `lib/`.

## Install (load unpacked)
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin the extension so its icon stays in the toolbar.

After editing any file, click the ↻ reload icon on the extension card **and reload the Moodle tab**. The tab reload matters because the content script keeps its state until the page reloads.

## Use
1. Log in to https://moodle.vinci.be and open a course: `course/view.php?id=…` or `course/section.php?id=…`. On a section page, the whole course is still scraped.
2. Click the extension icon. Under **Media files**, tick **Download video files** and/or **Download audio files** if you want them in the ZIP. Both are off by default; unticked media are only listed with their link in `course.md`. Your choice is remembered.
   Under **Office files → Markdown for AI**, choose which kinds get a Markdown version (all on by default). The original file is always kept.
3. Click **Scrape this course**.
4. The progress counter covers activities and files, and grows as new files are found. You can close the popup; the scrape keeps running in the tab. Reopen the popup to see progress again.
   - To stop, click **Cancel**. In-flight requests are aborted, nothing else is fetched, and no ZIP is produced. You can start again right away.
5. When it finishes, a **💾 Save ZIP…** box appears in the bottom-right corner of the Moodle page. Click it and the system's "Save as" dialog opens, where you pick the folder and the filename (default `<Course title>.zip`). Chrome remembers the folder for next time.
   - If you cancel, the ZIP is kept and you can click the button again. ✕ discards it.
   - The dialog has to be opened from the page, not from the popup: Chrome only allows a save dialog after a click in the page, and the popup closes as soon as a dialog opens.
   - If the save dialog API is unavailable or fails, the ZIP goes to the browser's normal Downloads folder instead.
6. Errors and guard refusals are listed in the popup and at the end of `course.md`.

## Output
```
<Course title>.zip
├── course.md
└── files/<Section>/<Subsection>/<Activity>/<file>
```
`course.md` contains:
- The course title, URL and scrape date.
- A **Deadlines & evaluations** table covering every quiz, assignment and lesson, plus anything else with a due date. Columns: opens, due/closes, cut-off, attempts allowed, grade to pass, completion, and status (open / closed / upcoming / overdue / ?) relative to the scrape date. Rows are sorted by deadline.
- The section tree in order. Sections are `##`, nested subsections are `###` and deeper, and each activity is one level below its section. Each activity lists its type, link, breadcrumb, completion ("To do" / "Done" plus the raw text), dates, restrictions, description, content, and files as relative links into `files/`.
- A **Scrape errors** list.

## Office files → Markdown (for AI)
Every downloaded `.pptx`, `.docx`, `.xlsx` (and `.odp`, `.odt`, `.ods`) is **kept as is**, and a Markdown version is added next to it:
```
files/…/Slides01.pptx            original, unchanged
files/…/Slides01.pptx.md         text version
files/…/Slides01.pptx_media/     its pictures (images, equation renderings)
```
`course.md` links both: `[Slides01.pptx](…) · 📝 [as Markdown](…)`. The conversion runs inside the browser (`lib/office2md.js`, using the bundled JSZip). Nothing is installed and nothing leaves your computer.

| Format | What the `.md` contains |
| --- | --- |
| Slides | `## Slide N — title` in presentation order, real bullets and numbering, code (monospace text) as code blocks, tables, pictures, equations as text plus their picture, chart titles, SmartArt text, speaker notes (🗒️), hidden slides marked. Embedded narration/video becomes a one-line note. |
| Documents | headings (including French "Titre 1" styles), bold/italic, bulleted and numbered lists, links, tables, pictures, equations as text, footnotes |
| Spreadsheets | one table per sheet with row numbers and column letters, **formulas shown next to values** (shared formulas rebuilt), hidden sheets marked, capped at 300 rows × 30 columns |

Popup checkboxes: Slides / Documents / Spreadsheets / Include pictures. Old binary `.ppt/.doc/.xls` can't be read in the browser; they're kept with a warning ("re-save as .pptx").

`course.md` starts with a short **note for the AI** reading the export. It says the content is in French, to read the `.md` versions first and check originals for diagrams or equations, what is *not* in the export (quiz questions, skipped media, external sites, failed items), and that deadline statuses date from the scrape.

## What each activity type captures
| Type | What is fetched (always GET) | What ends up in the ZIP |
| --- | --- | --- |
| resource | `mod/resource/view.php?id=X&redirect=1`. If it returns HTML, the first pluginfile link on the page | The file |
| folder | `mod/folder/view.php` | Every file, with the folder's subfolders kept |
| label (text and media) | nothing (read from the course page) | Markdown, with inline pluginfile files and `mod/resource` links downloaded and deduped |
| page | `mod/page/view.php` | Full content as Markdown (headings, lists, tables, links). Red or "Erratum" text becomes `> ⚠️`. Videos become `🎥 Video: url` and aren't downloaded. Images and files are downloaded and linked |
| url | `mod/url/view.php?id=X&forceview=1` (the Moodle page only; the external site is never fetched) | The external URL |
| lesson | `mod/lesson/view.php` | Lesson-menu outline, plus the **Export PDF** if that link exists. Without it, only the pages listed in the Lesson menu are fetched (GET) and converted |
| quiz | **only** `mod/quiz/view.php` | Intro, dates, attempts allowed, grade to pass, time limit, your attempts table, feedback |
| assign | `mod/assign/view.php` | Description, attached instruction files, dates, submission status table |
| forum | `mod/forum/view.php` + `discuss.php?d=` for the 10 newest discussions | Title, author/date, and first post text of each |
| book | `mod/book/tool/print/index.php` (whole book), else `view.php` | All chapters as Markdown |
| subsection (4.5) | Read from the course page. If its content is missing, `course/section.php` is fetched | Recursed into as a nested section |
| anything else | nothing | Title, type, link, description |

## Safety
- **GET only.** There is a single `fetch()` in the code, and it always uses `method: 'GET'`. No form is ever submitted.
- **URL guard.** `guard()` refuses any URL matching `startattempt | attempt.php | processattempt | continue.php | sesskey= | logout.php`, and anything outside moodle.vinci.be. It runs before each request and again on the post-redirect URL. Refusals are logged with `console.warn` and listed in `course.md`.
- **Quizzes.** Only `view.php` is opened. The "Faire le test" / "Attempt quiz" button is never touched.
- **Lessons.** The scraper never clicks "Suivante" and never answers a question.
- **Folders.** The "Download folder" button (a sesskey form) is never used.
- **Throttling.** At most 3 requests run at once, with at least 300 ms between request starts.
- **Session expiry.** If Moodle redirects to the login page, the run stops with a "Session expired" message.

## Known limitations
- **Completion side effect.** Opening an activity page (page, quiz view, forum…) is a normal "view" for Moodle. Activities whose completion condition is just "view" will turn **Done** afterwards. `course.md` records completion as it was **before** the scrape, because it's read from the course page first.
- **Lesson PDF export.** The export plugin's URL is a guess (`a[href*="lessonexport"]`). If that link carries `sesskey=`, the guard refuses it. The lesson then falls back to its menu pages, and the refusal is listed as a warning.
- **Not captured:** SCORM, H5P, LTI, interactive content, and quiz questions (never opened, by design).
- **Office → Markdown limits:**
  - Layout isn't reproduced.
  - Shapes come out in their stacking order, which is usually reading order.
  - MathType/Equation 3.0 objects only have an EMF/WMF preview, which may not display; those are flagged ⚠️.
  - Charts give their title only. SmartArt gives its text only.
  - Files over 80 MB are not converted.
- **Video and audio files** are controlled by the two popup checkboxes. This covers `.mp4`, `.mp3`, … files and any server response of type `video/*` / `audio/*`, whether in folders, resources, or embedded players in pages.
  - Unticked: a file is listed as `🎥 name (not downloaded): url` (or 🔊 for audio) instead of being put in the ZIP. Files known by extension are never requested; for the others the transfer is cancelled as soon as the type is known.
  - Ticked: the file goes into the ZIP, and embedded players link to the local copy.
  - Video can make the ZIP very large.
- **Dates** are parsed best-effort (French and English). When parsing fails, the status shows `?`; the raw date text is always kept.
- **Memory.** The ZIP is built in memory. Above about 200 MB the popup shows a warning, but the ZIP is still saved. Very large courses (1 GB or more) may exhaust tab memory.
- **Selectors** target Moodle 4.5 Boost markup. If the mooVin' theme differs, edit `SELECTORS` / `LABELS` at the top of `content.js`.
- **Downloads permission.** The `downloads` permission isn't requested. The ZIP is saved with the File System Access save dialog, falling back to an `<a download>` click. Neither needs an extra permission.
- **Portable paths.** ZIP paths work on Windows, macOS and Linux:
  - characters Windows forbids (`<>:"/\|?*`), trailing dots and spaces, and reserved names (CON, NUL, …) are removed or escaped;
  - accents are kept, normalized to NFC;
  - duplicate names are detected case-insensitively;
  - folder names are shortened when a tree gets deep, so paths stay under Windows' 260-character limit.

## Test checklist
Content-script logs appear in the **Moodle tab's** DevTools console, prefixed `[MoodleScraper]`. Popup errors such as "Failed to start" appear only after you right-click the popup and choose **Inspect**.

**0. Selector check (before the first run).** Run this on the course page in the console:
```js
(() => { const m = document.querySelector('#region-main');
  const secs = [...m.querySelectorAll('li.section, [data-for="section"]')].filter(s => !s.parentElement.closest('li.section, [data-for="section"]'));
  const cms = m.querySelectorAll('li.activity, [data-for="cmitem"]');
  const types = [...new Set([...cms].map(c => (c.className.match(/modtype_(\w+)/) || [])[1]))];
  const subs = [...m.querySelectorAll('.modtype_subsection')].map(s => !!s.querySelector('[data-for="section"]'));
  return { topSections: secs.length, cmitems: cms.length, types, subsectionHasNestedSection: subs }; })()
```
`topSections` should be greater than 0, and every `subsectionHasNestedSection` entry should be `true` (a `false` entry is OK: the scraper then fetches the subsection's page).

**1. APOO (flat sections).**
- Run the scrape and open the ZIP.
- Check that the section order matches the page, the PDFs open, each folder has its subdirectory, and URL activities show their external link.
- In DevTools → Network on the Moodle tab, filter with the regex `/startattempt|processattempt|attempt\.php|continue\.php/`. There must be no row whose **Initiator** is `content.js`.
- Moodle's own JS constantly POSTs to `lib/ajax/service.php?sesskey=…`. That's normal; only content.js-initiated rows count.

**2. Math 1 (nested subsections, lessons, quizzes).**
- **Before the run:** note the attempt count shown on the one-attempt quiz page.
- "Chapitre 1 : Logique Formelle" should contain `###` headings for Théorie, Séances de travaux pratiques and Activités Interactives.
- Each lesson should have the exported PDF, or else a guard warning plus the Lesson-menu pages.
- Each quiz should appear in the Deadlines table with its attempts and grade to pass.
- **After the run:** the attempt count on the quiz page must be unchanged.

**3. If something breaks**, copy the items below into this folder or the chat:
- Console lines starting with `[MoodleScraper]`, plus the popup's error list.
- `copy(document.querySelector('#region-main').outerHTML)` on the course page, pasted into `sample-course.html`. Do the same for a quiz view, a lesson view, a folder view and a page activity (`sample-quiz.html`, …).
- The `outerHTML` of one `li.activity.modtype_subsection`, and of any activity that was parsed wrong.
- The lesson export link: `[...document.querySelectorAll('a')].filter(a => /export/i.test(a.textContent + a.href)).map(a => a.href)`.

## Development (Bun)
The tests run in [Bun](https://bun.sh) on macOS, Linux and Windows. The extension itself needs no build step.
```sh
bun install          # jsdom (dev only)
bun test             # whole suite: unit + end-to-end + static checks
bun run check        # quick static checks only (syntax, manifest, GET-only)
MOODLE_TEST_VERBOSE=1 bun test   # show the scraper's console output
```
- **`tests/unit.test.js`** covers:
  - date parsing (FR and EN) and deadline status;
  - file naming and dedupe;
  - the GET guard;
  - the HTML→Markdown converter.
- **`tests/scrape.test.js`** runs `content.js` in jsdom against synthetic Moodle 4.5 pages, with stubbed network, ZIP and Save dialog. It covers:
  - the section tree and subsections, files, the deadlines table and each activity type;
  - only GETs, and no attempt or continue URLs;
  - throttling, session expiry and failure handling;
  - saving to a chosen folder (save, cancel, fallback);
  - cancelling a scrape mid-run;
  - the video/audio options (neither, video only, audio only, both);
  - portable paths.
- **`tests/popup.test.js`** drives the real popup: remembered checkboxes, the options sent with start, Cancel, restored progress.
- **`tests/office2md.test.js`** tests the Office converter on generated PPTX/DOCX/XLSX/ODP/ODT files (`tests/office.fixtures.js`): slide order, bullets vs plain text, code blocks, equations, notes, narration, French Word styles, lists, Excel formulas including shared ones, ODF, and damaged or legacy files.
- **`tests/static.test.js`** checks the manifest, the bundled JSZip, and that there's a single GET-only `fetch`.
- **`tests/samples.test.js`** runs `SELECTORS` against your real pages. Save `copy(document.querySelector('#region-main').outerHTML)` from a course page as `sample-course.html` in the project root and the test runs; otherwise it is skipped.

## Files
- `manifest.json`: MV3 manifest (`activeTab`, `scripting`, host `https://moodle.vinci.be/*`).
- `popup.html`, `popup.js`: the button, progress display and error list. They inject `lib/jszip.min.js` and `content.js` into the tab.
- `content.js`: all the scraping and the Save ZIP button. `SELECTORS` and `LABELS` are at the top.
- `package.json`, `tests/`: Bun test suite (dev only, not part of the extension).
- `lib/jszip.min.js`: JSZip 3.10.1 (MIT), bundled locally.
- `lib/office2md.js`: in-browser Office → Markdown converter.
