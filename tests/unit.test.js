// Unit tests for content.js helpers (exposed via the test hook).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createEnv, O } from './harness.js';

let env, I, doc;
beforeAll(() => { env = createEnv(); I = env.internals; doc = env.window.document; });
afterAll(() => env.close());

const md = (htmlStr, opts) => {
  const div = doc.createElement('div');
  div.innerHTML = htmlStr;
  return I.htmlToMd(div, `${O}/mod/page/view.php?id=1`, opts);
};

describe('parseDate', () => {
  const ymdhm = (d) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  test.each([
    ['lundi 6 octobre 2025, 23:59', [2025, 10, 6, 23, 59]],
    ['Fermé : dimanche 1er mars 2026, 08:30', [2026, 3, 1, 8, 30]],
    ['15 sept. 2025, 14h05', [2025, 9, 15, 14, 5]],
    ['mercredi 20 août 2025', [2025, 8, 20, 23, 59]],            // no time → end of day
    ['Monday, 15 September 2025, 2:30 PM', [2025, 9, 15, 14, 30]],
    ['September 15, 2025, 12:00 AM', [2025, 9, 15, 0, 0]],
    ['15/09/2025 08:00', [2025, 9, 15, 8, 0]],
  ])('%s', (input, want) => expect(ymdhm(I.parseDate(input))).toEqual(want));

  test('returns null for unparseable text', () => {
    expect(I.parseDate('bientôt')).toBeNull();
    expect(I.parseDate('')).toBeNull();
    expect(I.parseDate(undefined)).toBeNull();
  });
});

describe('deadlineStatus', () => {
  const now = new Date(2025, 9, 5, 12, 0); // 5 Oct 2025
  test('closed / open / upcoming', () => {
    expect(I.deadlineStatus({ closes: '1 octobre 2025, 23:59' }, now)).toBe('closed');
    expect(I.deadlineStatus({ opens: '1 octobre 2025', closes: '10 octobre 2025' }, now)).toBe('open');
    expect(I.deadlineStatus({ opens: '20 octobre 2025' }, now)).toBe('upcoming');
  });
  test('overdue but still before cut-off', () => {
    expect(I.deadlineStatus({ due: '3 octobre 2025, 23:59', cutoff: '8 octobre 2025, 23:59' }, now)).toBe('overdue (cut-off later)');
  });
  test('no dates vs unparseable', () => {
    expect(I.deadlineStatus({}, now)).toBe('no dates');
    expect(I.deadlineStatus({ closes: 'dans deux semaines' }, now)).toBe('?');
  });
});

describe('completionStatus', () => {
  test.each([
    ['À faire', 'To do'],
    ['Marquer comme terminé', 'To do'],
    ['Fait : Afficher', 'Done'],
    ['Terminé', 'Done'],
    ['Done: View', 'Done'],
    ['', ''],
  ])('%p → %p', (t, want) => expect(I.completionStatus(t)).toBe(want));
});

describe('file naming', () => {
  test('sanitize removes illegal characters, keeps accents', () => {
    expect(I.sanitize('Chapitre 1 : Logique/Formelle?')).toBe('Chapitre 1 _ Logique_Formelle_');
    expect(I.sanitize('Séance « été » ')).toBe('Séance « été »');
    expect(I.sanitize('été')).toBe('été'); // NFD → NFC
  });
  test('sanitize handles Windows reserved names and trailing dots', () => {
    expect(I.sanitize('CON')).toBe('_CON');
    expect(I.sanitize('nul.txt')).toBe('_nul.txt');
    expect(I.sanitize('notes...')).toBe('notes');
    expect(I.sanitize('   ')).toBe('untitled');
  });
  test('sanitize truncates but keeps the extension', () => {
    const out = I.sanitize('a'.repeat(200) + '.pdf', 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('.pdf')).toBe(true);
  });
  test('Content-Disposition parsing', () => {
    expect(I.filenameFromDisposition("attachment; filename*=UTF-8''Slides%20%C3%A9t%C3%A9.pdf")).toBe('Slides été.pdf');
    expect(I.filenameFromDisposition('attachment; filename="fiche 2.pdf"')).toBe('fiche 2.pdf');
    expect(I.filenameFromDisposition('inline; filename=plain.docx')).toBe('plain.docx');
    expect(I.filenameFromDisposition('attachment; filename="rÃ©sumÃ©.pdf"')).toBe('résumé.pdf'); // latin1 mojibake
    expect(I.filenameFromDisposition('')).toBeNull();
  });
  test('uniqueName dedupes with (2), (3), case-insensitively', () => {
    expect(I.uniqueName('files/x', 'Slides.pdf')).toBe('Slides.pdf');
    expect(I.uniqueName('files/x', 'slides.PDF')).toBe('slides (2).PDF');
    expect(I.uniqueName('files/x', 'Slides.pdf')).toBe('Slides (3).pdf');
    expect(I.uniqueName('files/y', 'Slides.pdf')).toBe('Slides.pdf');
  });
  test('zipDir shortens deep trees so paths stay under Windows limits', () => {
    const long = 'Chapitre 1 : Logique Formelle et raisonnement mathématique avancé'.repeat(1);
    const parts = [long, long, long, long].map((p) => I.sanitize(p));
    const dir = I.zipDir(parts);
    expect(dir.length).toBeLessThanOrEqual(150);
    expect(dir.startsWith('files/Chapitre 1 _ Logique')).toBe(true);
    expect(I.zipDir(['Court', 'Aussi'])).toBe('files/Court/Aussi');
  });
  test('normUrl ignores forcedownload/redirect and keys resources by id', () => {
    expect(I.normUrl(`${O}/pluginfile.php/1/a.pdf?forcedownload=1`)).toBe(`${O}/pluginfile.php/1/a.pdf`);
    expect(I.normUrl(`${O}/mod/resource/view.php?id=7&redirect=1`)).toBe('resource:7');
    expect(I.normUrl(`${O}/mod/resource/view.php?id=7`)).toBe('resource:7');
  });
});

describe('GET guard', () => {
  test.each([
    `${O}/mod/quiz/startattempt.php?cmid=5`,
    `${O}/mod/quiz/attempt.php?attempt=1`,
    `${O}/mod/quiz/processattempt.php`,
    `${O}/mod/lesson/continue.php?id=8`,
    `${O}/mod/folder/download_folder.php?id=7&sesskey=abc`,
    `${O}/login/logout.php?sesskey=abc`,
    'https://evil.example.com/mod/page/view.php?id=1',
  ])('refuses %s', (u) => {
    expect(I.isForbidden(u)).toBe(true);
    expect(() => I.guard(u)).toThrow(/blocked by safety guard/);
  });
  test.each([
    `${O}/mod/quiz/view.php?id=5`,
    `${O}/mod/lesson/view.php?id=8&pageid=101`,
    `${O}/pluginfile.php/99/mod_folder/content/0/a.pdf?forcedownload=1`,
    `${O}/local/lessonexport/export.php?id=8&type=pdf`,
  ])('allows %s', (u) => {
    expect(I.isForbidden(u)).toBe(false);
    expect(() => I.guard(u)).not.toThrow();
  });
  test('refusals are logged as warnings', () => {
    expect(I.getState().warnings.some((w) => w.includes('startattempt.php'))).toBe(true);
  });
});

describe('htmlToMd', () => {
  test('headings are shifted so the top heading lands on minHeading', () => {
    expect(md('<h2>A</h2><h3>B</h3>', { minHeading: 4 })).toBe('#### A\n\n##### B');
    expect(md('<h1>Deep</h1><h4>Too deep</h4>', { minHeading: 5 })).toBe('##### Deep\n\n**Too deep**');
  });
  test('bold, italic, links resolved to absolute URLs', () => {
    expect(md('<p>Un <b>gras</b> et <em>italique</em> <a href="/mod/url/view.php?id=9">lien</a></p>'))
      .toBe(`Un **gras** et *italique* [lien](${O}/mod/url/view.php?id=9)`);
  });
  test('nested lists', () => {
    expect(md('<ol><li>Un</li><li>Deux<ul><li>a</li><li>b</li></ul></li></ol>'))
      .toBe('1. Un\n2. Deux\n   - a\n   - b');
  });
  test('tables escape pipes', () => {
    expect(md('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>x | y</td></tr></table>'))
      .toBe('| A | B |\n| --- | --- |\n| 1 | x \\| y |');
  });
  test('blockquote and pre', () => {
    expect(md('<blockquote><p>cité</p></blockquote>')).toBe('> cité');
    expect(md('<pre>int x = 1;\n  y++;</pre>')).toBe('```\nint x = 1;\n  y++;\n```');
  });
  test('red "Erratum" paragraphs become ⚠️ blockquotes', () => {
    expect(md('<p style="color: rgb(224, 62, 45)">Erratum : page 12</p>')).toBe('> ⚠️ Erratum : page 12');
    expect(md('<p>Erratum : non coloré</p>')).toBe('> ⚠️ Erratum : non coloré');
    expect(md('<p><span style="color:#ff0000">Attention, tout en rouge</span></p>')).toBe('> ⚠️ Attention, tout en rouge');
  });
  test('inline red text keeps its link', () => {
    expect(md('<p>Voir <span style="color:red"><a href="https://x.org/">ceci</a></span> svp</p>'))
      .toBe('Voir ⚠️ **[ceci](https://x.org/)** svp');
  });
  test('embedded videos are listed, not downloaded', () => {
    expect(md('<iframe src="https://www.youtube.com/embed/abc"></iframe>')).toBe('🎥 Video: https://www.youtube.com/embed/abc');
    expect(md(`<video data-setup-lazy='{"sources":[{"type":"video/youtube","src":"https://www.youtube.com/watch?v=xyz"}]}'></video>`))
      .toBe('🎥 Video: https://www.youtube.com/watch?v=xyz');
    expect(md('<iframe src="https://h5p.org/h5p/embed/1"></iframe>')).toBe('🧩 Embedded: https://h5p.org/h5p/embed/1');
  });
  test('scripts, styles, buttons and screen-reader text are stripped', () => {
    expect(md('<script>x()</script><style>p{}</style><button>Faire le test</button><span class="accesshide">Fichier</span><p>visible</p>'))
      .toBe('visible');
  });
  test('URLs mapped to local ZIP paths are used for links and images', () => {
    const map = new Map([[I.normUrl(`${O}/pluginfile.php/1/a b.png`), 'files/S/a b.png']]); // keys are normalized URLs
    expect(md(`<img src="${O}/pluginfile.php/1/a b.png" alt="cap">`, { map })).toBe('![cap](<files/S/a b.png>)');
  });
});
