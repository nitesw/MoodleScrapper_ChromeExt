// End-to-end: full scrape of a synthetic course with stubbed network, ZIP and save dialog.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createEnv, O, FORBIDDEN } from './harness.js';
import { mathCourse, coursePage, section, delegated, cm, html, file, activityPage } from './fixtures.js';
import { makePptx, makeDocx, pp, wd, rel, PNG } from './office.fixtures.js';

describe('full course scrape (Math 1–style course)', () => {
  let env, res;
  beforeAll(async () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages });
    res = await env.scrape();
  });
  afterAll(() => env.close());

  test('starts with a short note for the AI (no conversion line when nothing was converted)', () => {
    const note = res.md.split('\n## ')[0];
    expect(note).toContain('> **Note for the AI reading this:** export of the Moodle course "BINV1010-1 Algorithmique"');
    expect(note).toContain("don't guess it: quiz questions");
    expect(note).toContain('Deadline statuses below were computed on');
    expect(note).not.toContain('Office files exist twice');
    expect(note.split('\n').filter((l) => l.startsWith('>')).length).toBeLessThanOrEqual(5);
  });

  test('finishes without errors and offers the ZIP for saving', () => {
    expect(res.state.errors).toEqual([]);
    expect(res.state.readyToSave).toBe(true);
    expect(res.state.zipName).toBe('BINV1010-1 Algorithmique.zip');
    expect(env.saveBox()).not.toBeNull();
  });

  test('only GET requests with credentials, never a forbidden URL', () => {
    expect(env.requests.length).toBeGreaterThan(10);
    for (const r of env.requests) {
      expect(r.method).toBe('GET');
      expect(r.credentials).toBe('include');
      expect(r.url).not.toMatch(FORBIDDEN);
      expect(r.url.startsWith(O)).toBe(true);
    }
  });

  test('section tree: sections, nested subsection, fetched section; course index ignored', () => {
    const heads = res.md.split('\n').filter((l) => /^#{1,6} /.test(l));
    const idx = (h) => heads.indexOf(h);
    expect(idx('## Généralités')).toBeGreaterThan(-1);
    expect(idx('## Chapitre 1 : Logique Formelle')).toBeGreaterThan(idx('## Généralités'));
    expect(idx('### Théorie')).toBeGreaterThan(idx('## Chapitre 1 : Logique Formelle'));
    expect(idx('#### 📃 Manuel IntelliJ')).toBeGreaterThan(idx('### Théorie'));
    expect(idx('## Chapitre 2')).toBeGreaterThan(idx('### 📌 Projet 1'));
    expect(idx('### ▫️ Exercice H5P')).toBeGreaterThan(idx('## Chapitre 2'));
    expect(res.md).not.toContain('Index entry');
    expect(env.requests.some((r) => r.key === '/course/section.php?id=13')).toBe(true);
  });

  test('deadlines table includes quiz attempts / grade to pass and assign dates', () => {
    const table = res.md.split('## Deadlines & evaluations')[1].split('\n## ')[0];
    const quizRow = table.split('\n').find((l) => l.startsWith('| Semaine 1'));
    expect(quizRow).toContain('| 1 |');
    expect(quizRow).toContain('5,00 sur 10,00');
    expect(quizRow).toContain('Théorie');
    const assignRow = table.split('\n').find((l) => l.startsWith('| Projet 1'));
    expect(assignRow).toContain('vendredi 3 octobre 2025, 23:59');
    expect(assignRow).toContain('samedi 4 octobre 2025, 23:59'); // cut-off from submission table
    expect(table).toContain('| Semaine 2 - Parcours Excel | lesson |');
  });

  test('files mirror section > subsection > activity, using Content-Disposition names', () => {
    const paths = Object.keys(env.zipFiles);
    expect(paths).toContain('files/Généralités/APOO Slides01/APOO Slides01.pdf');
    expect(paths).toContain('files/Chapitre 1 _ Logique Formelle/Ressources fiche 2/fiche2.pdf');
    expect(paths).toContain('files/Chapitre 1 _ Logique Formelle/Ressources fiche 2/Sous dossier/data.xlsx');
    expect(paths).toContain('files/Chapitre 1 _ Logique Formelle/Théorie/Manuel IntelliJ/capture.png');
    expect(paths).toContain('files/Chapitre 1 _ Logique Formelle/Projet 1/consignes.pdf');
    expect(paths).toContain('files/Chapitre 1 _ Logique Formelle/Semaine 2 - Parcours Excel/Semaine 2.pdf');
    expect(paths).toContain('course.md');
  });

  test('every ZIP path is portable (Windows, macOS, Linux)', () => {
    for (const path of Object.keys(env.zipFiles)) {
      expect(path.length).toBeLessThanOrEqual(150 + 1 + 120);
      for (const part of path.split('/')) {
        expect(part).not.toMatch(/[<>:"\\|?*\u0000-\u001f]/);
        expect(part).not.toMatch(/[. ]$/);
        expect(part).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i);
        expect(part.length).toBeGreaterThan(0);
        expect(part.normalize('NFC')).toBe(part);
      }
    }
  });

  test('label links to a course resource reuse the already-downloaded file', () => {
    expect(env.requests.filter((r) => r.key.startsWith('/mod/resource/view.php?id=2')).length).toBe(1);
    expect(res.md).toContain('[les slides](<files/Généralités/APOO Slides01/APOO Slides01.pdf>)');
    expect(res.md).toContain('[énoncé](<files/Chapitre 1 _ Logique Formelle/1ère Séance - Les puzzles/enonce.pdf>)');
  });

  test('page: intro + body, erratum, local image, video link, breadcrumb', () => {
    const page = res.md.split('#### 📃 Manuel IntelliJ')[1].split('#### 📝')[0];
    expect(page).toContain('INTRO DU MANUEL');
    expect(page).toContain('##### Installation');
    expect(page).toContain('> ⚠️ Erratum : la version 2024 est requise');
    expect(page).toContain('![capture](<files/Chapitre 1 _ Logique Formelle/Théorie/Manuel IntelliJ/capture.png>)');
    expect(page).toContain('🎥 Video: https://www.youtube.com/embed/abc123');
    expect(page).toContain('Breadcrumb: BINV1010 / Chapitre 1 : Logique Formelle / Théorie / Manuel IntelliJ');
  });

  test('quiz: only view.php is fetched', () => {
    const quizReqs = env.requests.filter((r) => r.key.startsWith('/mod/quiz/'));
    expect(quizReqs.map((r) => r.key)).toEqual(['/mod/quiz/view.php?id=5']);
    expect(res.md).toContain('Tentatives autorisées : 1');
  });

  test('lesson: export PDF preferred, menu outline kept, no page navigation', () => {
    expect(res.md).toContain('- 1. Introduction\n- 2. Référence');
    expect(res.md).toContain('Exported PDF: Semaine 2.pdf');
    expect(env.requests.some((r) => r.key.includes('pageid='))).toBe(false);
  });

  test('url: external link recorded without fetching the external site', () => {
    expect(res.md).toContain('External URL: https://docs.oracle.com/java');
  });

  test('forum: at most the 10 most recent discussions', () => {
    const discuss = env.requests.filter((r) => r.key.startsWith('/mod/forum/discuss.php'));
    expect(discuss.length).toBe(10);
    expect(res.md).toContain('#### Annonce 0');
    expect(res.md).not.toContain('Annonce 10');
  });

  test('completion status from the course page', () => {
    expect(res.md).toContain('Completion: **To do** — À faire');
  });
});

describe('saving the ZIP to a user-chosen location', () => {
  let env;
  afterEach(() => env && env.close());
  const setup = async (picker) => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages, picker });
    return env.scrape();
  };

  test('Save button opens the native save dialog and writes the ZIP there', async () => {
    await setup('ok');
    await env.clickSave();
    expect(env.saves.calls).toHaveLength(1);
    expect(env.saves.calls[0].suggestedName).toBe('BINV1010-1 Algorithmique.zip');
    expect(env.saves.calls[0].id).toBe('moodle-scraper'); // Chrome reopens the last folder
    expect(env.saves.written).toHaveLength(1);
    expect(env.saves.written[0].data.size).toBeGreaterThan(0);
    const st = env.send('status');
    expect(st.readyToSave).toBe(false);
    expect(st.savedAs).toBe('BINV1010-1 Algorithmique.zip');
    expect(env.saveBox()).toBeNull();
    expect(env.downloaded).toBeNull();
  });

  test('cancelling the dialog keeps the ZIP and the button for another try', async () => {
    await setup('cancel');
    await env.clickSave();
    expect(env.send('status').readyToSave).toBe(true);
    expect(env.saveBox()).not.toBeNull();
    env.saves.mode = 'ok';
    await env.clickSave();
    expect(env.saves.written).toHaveLength(1);
  });

  test('falls back to a normal download when the API is unavailable', async () => {
    await setup('none');
    await env.clickSave();
    expect(env.downloaded).toBe('BINV1010-1 Algorithmique.zip');
    expect(env.send('status').savedAs).toContain('Downloads');
  });

  test('falls back to a normal download when the dialog errors', async () => {
    await setup('error');
    await env.clickSave();
    expect(env.downloaded).toBe('BINV1010-1 Algorithmique.zip');
    expect(env.send('status').warnings.some((w) => w.includes('Save dialog failed'))).toBe(true);
  });

  test('nothing is saved before the user clicks', async () => {
    await setup('ok');
    expect(env.saves.calls).toHaveLength(0);
    expect(env.downloaded).toBeNull();
  });
});

describe('edge cases', () => {
  let env;
  afterEach(() => env && env.close());

  test('section titles ignore hidden "Select section / Collapse / Expand" UI text', async () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages });
    const res = await env.scrape();
    expect(res.md).not.toMatch(/Select section|Collapse|Expand/);
    expect(res.md).toContain('\n## Généralités\n');
    expect(res.md).toContain('\n### Théorie\n');
    expect(res.md).not.toContain('differs from course-page placement');
    expect(Object.keys(env.zipFiles).some((p) => /Select section|Collapse/.test(p))).toBe(false);
  });

  test('video files in a folder are listed with their link, never requested', async () => {
    const page = coursePage(section(10, 0, 'S', cm(7, 'folder', 'Vidéos TP')));
    env = createEnv({
      html: page,
      pages: {
        '/mod/folder/view.php?id=7': html(activityPage({
          body: `<div class="foldertree">
            <a href="${O}/pluginfile.php/1/mod_folder/content/0/Seance1.mp4?forcedownload=1">Seance1.mp4</a>
            <a href="${O}/pluginfile.php/1/mod_folder/content/0/notes.pdf?forcedownload=1">notes.pdf</a></div>`,
        })),
        '/pluginfile.php/1/mod_folder/content/0/notes.pdf?forcedownload=1': file('pdf'),
      },
    });
    const res = await env.scrape();
    expect(env.requests.some((r) => r.key.includes('.mp4'))).toBe(false);
    expect(Object.keys(env.zipFiles)).toEqual(['files/S/Vidéos TP/notes.pdf', 'course.md']);
    expect(res.md).toContain(`🎥 Seance1.mp4 (not downloaded): ${O}/pluginfile.php/1/mod_folder/content/0/Seance1.mp4`);
    expect(res.state.errors).toEqual([]);
  });

  test('a resource that turns out to be a video is not stored in the ZIP', async () => {
    const page = coursePage(section(10, 0, 'S', cm(2, 'resource', 'Capsule')));
    env = createEnv({
      html: page,
      pages: {
        '/mod/resource/view.php?id=2&redirect=1': file('VIDEO', 'video/mp4', {
          redirect: '/pluginfile.php/3/mod_resource/content/1/capsule', cd: 'inline; filename="capsule.mp4"',
        }),
      },
    });
    const res = await env.scrape();
    expect(Object.keys(env.zipFiles)).toEqual(['course.md']);
    expect(res.md).toContain('🎥 capsule.mp4 (not downloaded)');
  });

  test('all activities of a long-titled section share ONE section folder', async () => {
    const longTitle = 'Chapitre 1 : Logique Formelle et raisonnement mathématique pour informaticiens';
    const items = [cm(2, 'resource', 'A'), cm(4, 'resource', 'Un titre d’activité vraiment très long qui dépasse largement la limite')].join('');
    const page = coursePage(section(10, 1, longTitle, cm(3, 'subsection', 'Séances de travaux pratiques et exercices', delegated(20, 'Séances de travaux pratiques et exercices', items))));
    env = createEnv({
      html: page,
      pages: {
        '/mod/resource/view.php?id=2&redirect=1': file('a', 'application/pdf', { redirect: '/pluginfile.php/1/x/a.pdf' }),
        '/mod/resource/view.php?id=4&redirect=1': file('b', 'application/pdf', { redirect: '/pluginfile.php/2/x/b.pdf' }),
      },
    });
    await env.scrape();
    const dirs = Object.keys(env.zipFiles).filter((p) => p.startsWith('files/')).map((p) => p.split('/').slice(0, 3).join('/'));
    expect(new Set(dirs).size).toBe(1);
    for (const p of Object.keys(env.zipFiles)) expect(p.length).toBeLessThanOrEqual(150 + 1 + 120);
  });

  test('lesson without PDF export: GETs only Lesson-menu pages and refuses continue.php', async () => {
    const { html: page, pages } = mathCourse({
      lessonExport: false,
      extraLessonMenu: `<li><a href="${O}/mod/lesson/continue.php?id=8&pageid=102">3. Piège</a></li>`,
    });
    env = createEnv({ html: page, pages });
    const res = await env.scrape();
    expect(env.requests.some((r) => r.key === '/mod/lesson/view.php?id=8&pageid=101')).toBe(true);
    expect(env.requests.some((r) => /continue\.php/.test(r.url))).toBe(false);
    expect(res.state.warnings.some((w) => w.includes('continue.php'))).toBe(true);
    expect(res.md).toContain('#### 2. Référence\n\nContenu référence');
    expect(res.md).toContain('No "Export as PDF" link found');
  });

  test('subsection not rendered inline: its page is fetched and parsed', async () => {
    const page = coursePage(section(10, 0, 'Chapitre 1', cm(3, 'subsection', 'Séances de travaux pratiques')));
    env = createEnv({
      html: page,
      pages: {
        '/mod/subsection/view.php?id=3': html(activityPage({
          body: `<ul>${section(20, 3, 'Séances de travaux pratiques', cm(30, 'url', 'TP 1'))}</ul>`,
        })),
        '/mod/url/view.php?id=30&forceview=1': html(activityPage({ body: '<div class="urlworkaround"><a href="https://tp1.example.org">x</a></div>' })),
      },
    });
    const res = await env.scrape();
    expect(res.md).toContain('### Séances de travaux pratiques');
    expect(res.md).toContain('#### 🔗 TP 1');
  });

  test('a failing download is reported but the scrape continues', async () => {
    const page = coursePage(section(10, 0, 'S', cm(2, 'resource', 'Cassé') + cm(4, 'resource', 'OK')));
    env = createEnv({
      html: page,
      pages: {
        '/mod/resource/view.php?id=2&redirect=1': { type: 'text/html', body: 'err', status: 500 },
        '/mod/resource/view.php?id=4&redirect=1': file('ok', 'application/pdf', { redirect: '/pluginfile.php/1/mod_resource/content/1/ok.pdf' }),
      },
    });
    const res = await env.scrape();
    expect(res.state.errors).toHaveLength(1);
    expect(res.state.errors[0]).toContain('HTTP 500');
    expect(Object.keys(env.zipFiles)).toContain('files/S/OK/ok.pdf');
    expect(res.md).toContain('## Scrape errors');
    expect(res.state.readyToSave).toBe(true);
  });

  test('resource that returns an HTML wrapper page: the pluginfile link inside is fetched', async () => {
    const page = coursePage(section(10, 0, 'S', cm(2, 'resource', 'Embed')));
    env = createEnv({
      html: page,
      pages: {
        '/mod/resource/view.php?id=2&redirect=1': html(activityPage({
          header: `<div class="activity-description"><img src="${O}/pluginfile.php/9/mod_resource/intro/logo.png"></div>`,
          body: `<div class="resourceworkaround"><a href="${O}/pluginfile.php/9/mod_resource/content/1/cours.pptx">cours.pptx</a></div>`,
        })),
        '/pluginfile.php/9/mod_resource/content/1/cours.pptx': file('pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      },
    });
    await env.scrape();
    expect(Object.keys(env.zipFiles)).toContain('files/S/Embed/cours.pptx');
    expect(env.requests.some((r) => r.key.includes('logo.png'))).toBe(false);
  });

  test('same filename twice in one folder gets " (2)"', async () => {
    const page = coursePage(section(10, 0, 'S', cm(7, 'folder', 'F')));
    env = createEnv({
      html: page,
      pages: {
        '/mod/folder/view.php?id=7': html(activityPage({
          body: `<div class="foldertree"><a href="${O}/pluginfile.php/1/mod_folder/content/0/a.pdf">a</a><a href="${O}/pluginfile.php/2/mod_folder/content/0/a.pdf">a</a></div>`,
        })),
        '/pluginfile.php/1/mod_folder/content/0/a.pdf': file('1'),
        '/pluginfile.php/2/mod_folder/content/0/a.pdf': file('2'),
      },
    });
    await env.scrape();
    const paths = Object.keys(env.zipFiles);
    expect(paths).toContain('files/S/F/a.pdf');
    expect(paths).toContain('files/S/F/a (2).pdf');
  });

  test('expired session aborts the run with a clear message and no ZIP', async () => {
    const page = coursePage(section(10, 0, 'S', cm(4, 'page', 'P')));
    env = createEnv({ html: page, pages: { '/mod/page/view.php?id=4': html('<html></html>') } });
    env.window.fetch = (orig => async (u, o) => { const r = await orig(u, o); return { ...r, url: `${O}/login/index.php` }; })(env.window.fetch);
    const res = await env.scrape();
    expect(res.state.message).toMatch(/^Aborted: Session expired/);
    expect(res.state.readyToSave).toBeFalsy();
    expect(env.saveBox()).toBeNull();
  });

  test('started from course/section.php: the full course page is fetched', async () => {
    const full = mathCourse();
    env = createEnv({
      html: '<html><body class="course-462"><section id="region-main"></section></body></html>',
      url: `${O}/course/section.php?id=11`,
      pages: { ...full.pages, '/course/view.php?id=462': html(full.html) },
    });
    const res = await env.scrape();
    expect(env.requests[0].key).toBe('/course/view.php?id=462');
    expect(res.md.startsWith('# BINV1010-1 Algorithmique')).toBe(true);
  });

  test('throttle: never more than 3 requests in flight, starts spaced by the delay', async () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages, delayMs: 25, latencyMs: 40 });
    await env.scrape(30000);
    expect(env.net.maxInflight).toBeLessThanOrEqual(3);
    const starts = env.requests.map((r) => r.start).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(20);
  });

  test('a second start while running is ignored', async () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages });
    env.send('start');
    env.send('start');
    const res = await env.scrape();
    expect(env.requests.filter((r) => r.key === '/mod/quiz/view.php?id=5').length).toBe(1);
    expect(res.state.errors).toEqual([]);
  });
});

describe('cancel', () => {
  let env;
  afterEach(() => env && env.close());

  test('cancel mid-scrape stops all requests, aborts in-flight ones and offers no ZIP', async () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages, delayMs: 10, latencyMs: 60 });
    env.send('start');
    while (env.requests.length < 3) await env.sleep(5);
    const st0 = env.send('cancel');
    expect(st0.cancelled).toBe(true);
    const countAtCancel = env.requests.length;

    const st = await env.waitFinished();
    expect(st.running).toBe(false);
    expect(st.message).toBe('Cancelled — scraping stopped, nothing was saved.');
    expect(st.readyToSave).toBeFalsy();
    expect(st.errors).toEqual([]);               // cancelling is not an error
    expect(env.requests.length).toBe(countAtCancel); // nothing new after cancel
    expect(env.net.aborted).toBeGreaterThan(0);      // in-flight requests were aborted
    expect(env.net.inflight).toBe(0);
    expect(env.saveBox()).toBeNull();
    expect(env.zipFiles['course.md']).toBeUndefined();

    await env.sleep(150); // no stragglers fire later
    expect(env.requests.length).toBe(countAtCancel);
  });

  test('cancel when idle does nothing', () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages });
    const st = env.send('cancel');
    expect(st.running).toBe(false);
    expect(st.cancelled).toBeFalsy();
    expect(env.requests).toHaveLength(0);
  });

  test('a new scrape after cancelling runs cleanly to the end', async () => {
    const { html: page, pages } = mathCourse();
    env = createEnv({ html: page, pages, latencyMs: 30 });
    env.send('start');
    while (env.requests.length < 2) await env.sleep(5);
    env.send('cancel');
    await env.waitFinished();

    const res = await env.scrape();
    expect(res.state.cancelled).toBeFalsy();
    expect(res.state.errors).toEqual([]);
    expect(res.state.readyToSave).toBe(true);
    expect(res.md).toContain('## Chapitre 2');
    expect(env.saveBox()).not.toBeNull();
  });
});

describe('media download options (popup checkboxes)', () => {
  let env;
  afterEach(() => env && env.close());

  // A folder with a video and an audio file, a page with an embedded <video> and <audio>,
  // and a resource whose server reports video/mp4.
  const mediaCourse = () => {
    const page = coursePage(section(10, 0, 'S', cm(7, 'folder', 'Médias') + cm(4, 'page', 'Cours') + cm(2, 'resource', 'Capsule')));
    const pages = {
      '/mod/folder/view.php?id=7': html(activityPage({
        body: `<div class="foldertree">
          <a href="${O}/pluginfile.php/1/mod_folder/content/0/seance.mp4?forcedownload=1">seance.mp4</a>
          <a href="${O}/pluginfile.php/1/mod_folder/content/0/podcast.mp3?forcedownload=1">podcast.mp3</a>
          <a href="${O}/pluginfile.php/1/mod_folder/content/0/notes.pdf?forcedownload=1">notes.pdf</a></div>`,
      })),
      '/pluginfile.php/1/mod_folder/content/0/seance.mp4?forcedownload=1': file('V', 'video/mp4'),
      '/pluginfile.php/1/mod_folder/content/0/podcast.mp3?forcedownload=1': file('A', 'audio/mpeg'),
      '/pluginfile.php/1/mod_folder/content/0/notes.pdf?forcedownload=1': file('P'),
      '/mod/page/view.php?id=4': html(activityPage({
        body: `<div class="box generalbox center">
          <video controls><source src="${O}/pluginfile.php/2/mod_page/content/1/demo.mp4"><a href="${O}/pluginfile.php/2/mod_page/content/1/demo.mp4">demo</a></video>
          <audio controls src="${O}/pluginfile.php/2/mod_page/content/1/intro.mp3"></audio></div>`,
      })),
      '/pluginfile.php/2/mod_page/content/1/demo.mp4': file('V2', 'video/mp4'),
      '/pluginfile.php/2/mod_page/content/1/intro.mp3': file('A2', 'audio/mpeg'),
      '/mod/resource/view.php?id=2&redirect=1': file('V3', 'video/mp4', {
        redirect: '/pluginfile.php/3/mod_resource/content/1/capsule', cd: 'inline; filename="capsule.mp4"',
      }),
    };
    return { page, pages };
  };
  const run = async (options) => {
    const { page, pages } = mediaCourse();
    env = createEnv({ html: page, pages });
    const res = await env.scrape(15000, options);
    const zipped = Object.keys(env.zipFiles).map((p) => p.split('/').pop());
    const fetched = (ext) => env.requests.some((r) => r.key.includes(ext));
    return { res, zipped, fetched };
  };

  test('default (nothing ticked): no video or audio in the ZIP, links listed instead', async () => {
    const { res, zipped, fetched } = await run();
    expect(zipped.sort()).toEqual(['course.md', 'notes.pdf']);
    expect(fetched('.mp4') || fetched('.mp3')).toBe(false); // known by extension → never requested
    expect(res.md).toContain('🎥 seance.mp4 (not downloaded)');
    expect(res.md).toContain('🔊 podcast.mp3 (not downloaded)');
    expect(res.md).toContain('🎥 capsule.mp4 (not downloaded)');
    expect(res.md).toContain('🎥 Video: https://moodle.vinci.be/pluginfile.php/2/mod_page/content/1/demo.mp4');
    expect(res.md).toContain('Media files downloaded: video no (links listed) · audio no (links listed)');
    expect(res.state.errors).toEqual([]);
  });

  test('video only', async () => {
    const { res, zipped, fetched } = await run({ downloadVideo: true, downloadAudio: false });
    expect(zipped.sort()).toEqual(['capsule.mp4', 'course.md', 'demo.mp4', 'notes.pdf', 'seance.mp4']);
    expect(fetched('.mp3')).toBe(false);
    expect(res.md).toContain('🔊 podcast.mp3 (not downloaded)');
    expect(res.md).toContain('🎥 Video: files/S/Cours/demo.mp4'); // embedded player now points into the ZIP
  });

  test('audio only', async () => {
    const { res, zipped, fetched } = await run({ downloadVideo: false, downloadAudio: true });
    expect(zipped.sort()).toEqual(['course.md', 'intro.mp3', 'notes.pdf', 'podcast.mp3']);
    expect(fetched('seance.mp4') || fetched('demo.mp4')).toBe(false);
    expect(res.md).toContain('🎥 capsule.mp4 (not downloaded)');
    expect(res.md).toContain('🔊 Audio: files/S/Cours/intro.mp3');
  });

  test('both', async () => {
    const { res, zipped } = await run({ downloadVideo: true, downloadAudio: true });
    expect(zipped.sort()).toEqual(['capsule.mp4', 'course.md', 'demo.mp4', 'intro.mp3', 'notes.pdf', 'podcast.mp3', 'seance.mp4']);
    expect(res.md).not.toContain('(not downloaded)');
    expect(res.md).toContain('Media files downloaded: video yes · audio yes');
  });

  test('the options of one run do not leak into the next', async () => {
    const { page, pages } = mediaCourse();
    env = createEnv({ html: page, pages });
    await env.scrape(15000, { downloadVideo: true, downloadAudio: true });
    const res = await env.scrape(15000); // popup with nothing ticked
    expect(res.state.options).toMatchObject({ downloadVideo: false, downloadAudio: false });
    expect(res.md).toContain('🎥 seance.mp4 (not downloaded)');
  });
});

describe('Office files → Markdown (originals kept)', () => {
  let env;
  afterEach(() => env && env.close());

  const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const officeCourse = async () => {
    const pptx = await makePptx([
      { file: 'slide1.xml', shapes: pp.title('Algèbre de Boole') + pp.body(['a + 0 = a']) + pp.pic('rIdI', 'loi'), rels: [rel('rIdI', 'image', '../media/image1.png')] },
      { file: 'slide2.xml', shapes: pp.title('Exercices') },
    ], { 'image1.png': PNG });
    const docx = await makeDocx(wd.p(wd.r('Consignes'), { style: 'Titre1' }) + wd.p(wd.r('Faire les exercices 1 à 5')));
    const page = coursePage(section(10, 0, 'Théorie', cm(2, 'resource', 'Slides Boole') + cm(7, 'folder', 'Fiches')));
    const pages = {
      '/mod/resource/view.php?id=2&redirect=1': { type: PPTX_TYPE, body: pptx, redirect: '/pluginfile.php/1/mod_resource/content/1/Boole.pptx', cd: 'attachment; filename="Boole.pptx"' },
      '/mod/folder/view.php?id=7': html(activityPage({
        body: `<div class="foldertree">
          <a href="${O}/pluginfile.php/2/mod_folder/content/0/Fiche%201.docx?forcedownload=1">Fiche 1.docx</a>
          <a href="${O}/pluginfile.php/2/mod_folder/content/0/vieux.ppt?forcedownload=1">vieux.ppt</a>
          <a href="${O}/pluginfile.php/2/mod_folder/content/0/casse.pptx?forcedownload=1">casse.pptx</a></div>`,
      })),
      '/pluginfile.php/2/mod_folder/content/0/Fiche%201.docx?forcedownload=1': { type: DOCX_TYPE, body: docx },
      '/pluginfile.php/2/mod_folder/content/0/vieux.ppt?forcedownload=1': file('LEGACY', 'application/vnd.ms-powerpoint'),
      '/pluginfile.php/2/mod_folder/content/0/casse.pptx?forcedownload=1': { type: PPTX_TYPE, body: 'not a zip' },
    };
    return { page, pages };
  };
  const run = async (options) => {
    const { page, pages } = await officeCourse();
    env = createEnv({ html: page, pages });
    const res = await env.scrape(15000, options);
    return { res, paths: Object.keys(env.zipFiles) };
  };

  test('original + .md + pictures side by side; course.md links both', async () => {
    const { res, paths } = await run();
    expect(res.md.split('\n## ')[0]).toContain('> - Office files exist twice: read the `.pptx.md`');
    expect(paths).toContain('files/Théorie/Slides Boole/Boole.pptx');
    expect(paths).toContain('files/Théorie/Slides Boole/Boole.pptx.md');
    expect(paths).toContain('files/Théorie/Slides Boole/Boole.pptx_media/image1.png');
    expect(paths).toContain('files/Théorie/Fiches/Fiche 1.docx');
    expect(paths).toContain('files/Théorie/Fiches/Fiche 1.docx.md');

    const md = String(env.zipFiles['files/Théorie/Slides Boole/Boole.pptx.md']);
    expect(md).toContain('## Slide 1 — Algèbre de Boole');
    expect(md).toContain('- a + 0 = a');
    expect(md).toContain('![loi](Boole.pptx_media/image1.png)'); // relative to the .md file
    expect(String(env.zipFiles['files/Théorie/Fiches/Fiche 1.docx.md'])).toContain('## Consignes');

    expect(res.md).toContain('[Boole.pptx](<files/Théorie/Slides Boole/Boole.pptx>) · 📝 [as Markdown](<files/Théorie/Slides Boole/Boole.pptx.md>)');
    expect(res.md).toContain('Office files → Markdown (originals kept): slides yes · documents yes · spreadsheets yes · pictures yes — 2 file(s) converted');
  });

  test('old .ppt and broken files: original kept, warning, no .md, no error', async () => {
    const { res, paths } = await run();
    expect(paths).toContain('files/Théorie/Fiches/vieux.ppt');
    expect(paths).toContain('files/Théorie/Fiches/casse.pptx');
    expect(paths).not.toContain('files/Théorie/Fiches/vieux.ppt.md');
    expect(paths).not.toContain('files/Théorie/Fiches/casse.pptx.md');
    expect(res.state.errors).toEqual([]);
    expect(res.state.warnings.some((w) => w.includes('"vieux.ppt"') && w.includes('re-save it as .pptx'))).toBe(true);
    expect(res.state.warnings.some((w) => w.includes('"casse.pptx" could not be converted') && w.includes('original kept'))).toBe(true);
  });

  test('turning a kind off keeps only the original', async () => {
    const { res, paths } = await run({ mdSlides: false });
    expect(paths).toContain('files/Théorie/Slides Boole/Boole.pptx');
    expect(paths.some((p) => p.includes('Boole.pptx.md') || p.includes('Boole.pptx_media'))).toBe(false);
    expect(paths).toContain('files/Théorie/Fiches/Fiche 1.docx.md'); // documents still on
    expect(res.state.warnings.some((w) => w.includes('vieux.ppt'))).toBe(false); // slides off → not even tried
    expect(res.md).toContain('slides no · documents yes');
  });

  test('pictures can be turned off', async () => {
    const { paths } = await run({ mdPictures: false });
    expect(paths).toContain('files/Théorie/Slides Boole/Boole.pptx.md');
    expect(paths.some((p) => p.includes('_media/'))).toBe(false);
  });

  test('converted files keep portable paths', async () => {
    const { paths } = await run();
    for (const path of paths) for (const part of path.split('/')) {
      expect(part).not.toMatch(/[<>:"\\|?*]/);
      expect(part).not.toMatch(/[. ]$/);
    }
  });
});
