// Unit tests for lib/office2md.js (Office → Markdown), run in a jsdom window like in Chrome.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './harness.js';
import { makePptx, makeDocx, makeXlsx, makeOdf, pp, om, wd, rel, PNG, EMF } from './office.fixtures.js';

let w, O2M;
beforeAll(() => {
  w = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() }).window;
  // jsdom lacks setImmediate and JSZip's fallback scheduler never fires there (Chrome is fine).
  w.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0);
  w.eval(readFileSync(join(ROOT, 'lib/jszip.min.js'), 'utf8'));
  w.eval(readFileSync(join(ROOT, 'lib/office2md.js'), 'utf8'));
  O2M = w.Office2Md;
});
afterAll(() => w.close());

const convert = (bytes, name, opts) => O2M.convert(new w.Uint8Array(bytes), name, opts);

describe('kindOf', () => {
  test.each([
    ['Slides01.pptx', 'slides', 'ooxml'], ['cours.ODP', 'slides', 'odf'], ['Fiche.docx', 'docs', 'ooxml'],
    ['notes.odt', 'docs', 'odf'], ['Classeur.xlsx', 'sheets', 'ooxml'], ['data.ods', 'sheets', 'odf'],
    ['vieux.ppt', 'slides', 'legacy'], ['vieux.doc', 'docs', 'legacy'], ['vieux.xls', 'sheets', 'legacy'],
  ])('%s → %s/%s', (name, kind, format) => {
    expect(O2M.kindOf(name)).toMatchObject({ kind, format });
  });
  test('non-Office files are ignored', () => {
    expect(O2M.kindOf('cours.pdf')).toBeNull();
    expect(O2M.kindOf('image.png')).toBeNull();
    expect(O2M.kindOf('README')).toBeNull();
  });
});

describe('Office Math → text', () => {
  const math = (inner) => O2M._internals.mathText(O2M._internals.parseXml(
    `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`).documentElement);
  test('fractions, powers, sums, overline', () => {
    expect(math(om.f(om.r('a'), om.r('b+c')))).toBe('a/(b+c)');
    expect(math(om.sup(om.r('x'), om.r('2')))).toBe('x^2');
    expect(math(om.nary('∑', om.r('i=1'), om.r('n'), om.r('i')))).toBe('∑_(i=1)^n i');
    expect(math(om.bar(om.r('p')) + om.r('∨q'))).toBe('p̅∨q');
  });
});

describe('PowerPoint (.pptx)', () => {
  let res;
  beforeAll(async () => {
    const bytes = await makePptx([
      { // stored as slide9.xml but listed FIRST in presentation.xml → must be "Slide 1"
        file: 'slide9.xml',
        shapes: pp.title('La logique des propositions') + pp.body([
          { runs: [['Une '], ['proposition', { b: true }], [' est vraie ou fausse']] },
          { lvl: 1, runs: [['exemple : '], ['il pleut', { i: true }]] },
          { runs: [['Voir le '], ['cours', { link: 'rIdL' }]] },
        ]) + pp.slideNumber(),
        rels: [rel('rIdL', 'hyperlink', 'https://moodle.vinci.be/course/view.php?id=465', true)],
        notes: 'Insister sur le tiers exclu',
      },
      {
        file: 'slide1.xml',
        shapes: pp.title('Table de vérité') + pp.table([['p', 'q', 'p ∧ q'], ['V', 'F', 'F']]) + pp.pic('rIdI', 'schéma')
          + pp.group(pp.body(['Texte dans un groupe'])),
        rels: [rel('rIdI', 'image', '../media/image1.png')],
      },
      {
        file: 'slide2.xml',
        shapes: pp.title('Équations') + pp.equation(om.f(om.r('a'), om.r('b+c')), 'rIdE') + pp.ole('Equation.3', 'rIdW'),
        rels: [rel('rIdE', 'image', '../media/image2.png'), rel('rIdW', 'image', '../media/image3.emf')],
        hidden: true,
      },
    ], { 'image1.png': PNG, 'image2.png': PNG, 'image3.emf': EMF });
    res = await convert(bytes, 'Slides01.pptx', { mediaDir: 'Slides01.pptx_media' });
  });

  test('header says it is a Markdown version and the original is kept', () => {
    expect(res.md).toStartWith('# Slides01.pptx\n\n_Markdown version of the slides **Slides01.pptx** (3 slides)');
    expect(res.md).toContain('original file is kept next to this one');
    expect(res.count).toBe(3);
  });

  test('slides follow presentation order, with titles', () => {
    const heads = res.md.split('\n').filter((l) => l.startsWith('## '));
    expect(heads).toEqual([
      '## Slide 1 — La logique des propositions',
      '## Slide 2 — Table de vérité',
      '## Slide 3 — Équations _(hidden slide)_',
    ]);
  });

  test('bullets with levels, bold/italic, links; slide numbers skipped', () => {
    expect(res.md).toContain('- Une **proposition** est vraie ou fausse\n  - exemple : *il pleut*');
    expect(res.md).toContain('- Voir le [cours](https://moodle.vinci.be/course/view.php?id=465)');
    expect(res.md).not.toMatch(/^- 12$/m);
  });

  test('speaker notes', () => {
    expect(res.md).toContain('> 🗒️ Notes: Insister sur le tiers exclu');
  });

  test('tables, grouped shapes and pictures', () => {
    expect(res.md).toContain('| p | q | p ∧ q |\n| --- | --- | --- |\n| V | F | F |');
    expect(res.md).toContain('- Texte dans un groupe');
    expect(res.md).toContain('![schéma](Slides01.pptx_media/image1.png)');
  });

  test('equations: Office Math as text + the fallback picture', () => {
    expect(res.md).toContain('`a/(b+c)`');
    expect(res.md).toContain('![equation](Slides01.pptx_media/image2.png)');
  });

  test('old equation objects: flagged, EMF preview kept with a warning', () => {
    expect(res.md).toContain('🧮 Equation object (Equation.3)');
    expect(res.md).toContain('Slides01.pptx_media/image3.emf) ⚠️ EMF/WMF picture (may not display)');
    expect(res.warnings.some((w) => w.includes('EMF/WMF'))).toBe(true);
  });

  test('pictures are returned once each, as bytes', () => {
    expect(res.images.map((i) => i.name).sort()).toEqual(['image1.png', 'image2.png', 'image3.emf']);
    expect(Array.from(res.images.find((i) => i.name === 'image1.png').data)).toEqual(Array.from(PNG));
  });

  test('pictures can be turned off', async () => {
    const bytes = await makePptx([{ file: 'slide1.xml', shapes: pp.pic('rIdI', 'x'), rels: [rel('rIdI', 'image', '../media/image1.png')] }], { 'image1.png': PNG });
    const r = await convert(bytes, 'a.pptx', { pictures: false });
    expect(r.images).toEqual([]);
    expect(r.md).not.toContain('![');
  });

  test('can be stopped between slides (Cancel)', async () => {
    const bytes = await makePptx([{ file: 'slide1.xml', shapes: pp.title('A') }, { file: 'slide2.xml', shapes: pp.title('B') }]);
    await expect(convert(bytes, 'a.pptx', { shouldStop: () => true })).rejects.toThrow('cancelled');
  });
});

describe('PowerPoint: things found in real course decks', () => {
  let md;
  beforeAll(async () => {
    const bytes = await makePptx([{
      file: 'slide1.xml',
      shapes: pp.title('Le for : syntaxe Java')
        + pp.code(['for (int i = 0; i < 3; i++) {', '    tortue.avancer(100);', '}'])
        + pp.textbox(['Un texte libre', 'sur deux lignes'])
        + pp.textbox([{ bu: 'char', runs: [['puce explicite']] }, { bu: 'auto', runs: [['étape']] }, { bu: 'auto', runs: [['étape suivante']] }])
        + pp.body([{ bu: 'none', runs: [['sans puce']] }, 'avec puce'])
        + pp.audio('rIdP') + pp.audio('rIdP'),
      rels: [rel('rIdP', 'image', '../media/speaker.png')],
    }], { 'speaker.png': PNG });
    md = (await convert(bytes, 'For.pptx')).md;
  });
  test('monospace text boxes become a code block (indentation kept)', () => {
    expect(md).toContain('```\nfor (int i = 0; i < 3; i++) {\n    tortue.avancer(100);\n}\n```');
  });
  test('plain text boxes are not turned into bullets', () => {
    expect(md).toContain('\nUn texte libre\nsur deux lignes\n');
  });
  test('explicit bullets / numbering are respected', () => {
    expect(md).toContain('- puce explicite\n1. étape\n2. étape suivante');
    expect(md).toContain('\nsans puce\n- avec puce');
  });
  test('embedded narration is one line, not a speaker-icon picture', () => {
    expect(md.match(/🔊 Embedded audio narration/g)).toHaveLength(1);
    expect(md).not.toContain('speaker.png');
  });
});

describe('Excel shared formulas', () => {
  test('shiftFormula moves relative refs, keeps absolute ones and strings', () => {
    const s = O2M._internals.shiftFormula;
    expect(s('AND(B6:C6)', 2, 0)).toBe('AND(B8:C8)');
    expect(s('$A$1+B2*$C3+D$4', 1, 1)).toBe('$A$1+C3*$C4+E$4');
    expect(s('IF(A1="B2";LOG10(A1);0)', 1, 0)).toBe('IF(A2="B2";LOG10(A2);0)');
  });
  test('followers show the rebuilt formula', async () => {
    const bytes = await makeXlsx([{ name: 'S', rows: [
      ['p', 'q', 'p ET q'],
      [0, 0, { v: 0, f: 'AND(A2:B2)', shared: { si: 0, ref: 'C2:C4' } }],
      [0, 1, { v: 0, si: 0 }],
      [1, 1, { v: 1, si: 0 }],
    ] }]);
    const md = (await convert(bytes, 'Fiche2.xlsx')).md;
    expect(md).toContain('| 3 | 0 | 1 | 0 (=AND(A3:B3)) |');
    expect(md).toContain('| 4 | 1 | 1 | 1 (=AND(A4:B4)) |');
  });
});

describe('Word (.docx)', () => {
  let res;
  beforeAll(async () => {
    const body = [
      wd.p(wd.r('Chapitre 1 : Logique'), { style: 'Titre1' }),
      wd.p(wd.r('Section perso'), { style: 'MonTitre' }), // custom style based on "heading 2"
      wd.p(wd.r('Un ') + wd.r('mot', { b: true }) + wd.r(' important') + wd.r(' et ') + wd.r('penché', { i: true }) + wd.footnoteRef(1)),
      wd.p(wd.r('premier point'), { numId: 1 }),
      wd.p(wd.r('sous-point'), { numId: 1, ilvl: 1 }),
      wd.p(wd.r('étape un'), { numId: 2 }),
      wd.p(wd.r('étape deux'), { numId: 2 }),
      wd.p(wd.r('Lien : ') + wd.link('rIdH', 'Moodle')),
      wd.p(wd.r('Formule : ') + wd.math(om.sup(om.r('x'), om.r('2')))),
      wd.p(wd.image('rIdP', 'figure 1')),
      wd.table([['A', 'B'], ['1', '2']]),
    ].join('');
    const bytes = await makeDocx(body, {
      rels: [rel('rIdH', 'hyperlink', 'https://moodle.vinci.be', true), rel('rIdP', 'image', 'media/fig.png')],
      media: { 'fig.png': PNG },
      footnotes: { 1: 'Voir le syllabus.' },
    });
    res = await convert(bytes, 'Fiche 1.docx', { mediaDir: 'Fiche 1.docx_media' });
  });

  test('headings from style names (French templates, inherited styles)', () => {
    expect(res.md).toContain('\n## Chapitre 1 : Logique\n');
    expect(res.md).toContain('\n### Section perso\n');
  });
  test('bold / italic runs merged cleanly', () => {
    expect(res.md).toContain('Un **mot** important et *penché*[^1]');
  });
  test('bulleted and numbered lists with nesting', () => {
    expect(res.md).toContain('- premier point\n   - sous-point');
    expect(res.md).toContain('1. étape un\n2. étape deux');
  });
  test('links, equations, pictures, tables, footnotes', () => {
    expect(res.md).toContain('Lien : [Moodle](https://moodle.vinci.be)');
    expect(res.md).toContain('Formule : `x^2`');
    expect(res.md).toContain('![figure 1](<Fiche 1.docx_media/fig.png>)');
    expect(res.md).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(res.md).toContain('[^1]: Voir le syllabus.');
  });
});

describe('Excel (.xlsx)', () => {
  test('values with formulas, cell references, hidden sheets', async () => {
    const bytes = await makeXlsx([
      { name: 'Table de vérité', rows: [['p', 'q', 'p ET q'], [1, 0, { v: 0, f: 'ET(A2;B2)' }], [1, 1, { v: true, f: 'ET(A3;B3)' }]] },
      { name: 'Brouillon', hidden: true, rows: [['x']] },
    ]);
    const res = await convert(bytes, 'Classeur.xlsx');
    expect(res.md).toContain('## Sheet: Table de vérité');
    expect(res.md).toContain('|  | A | B | C |');
    expect(res.md).toContain('| 2 | 1 | 0 | 0 (=ET(A2;B2)) |');
    expect(res.md).toContain('| 3 | 1 | 1 | TRUE (=ET(A3;B3)) |');
    expect(res.md).toContain('## Sheet: Brouillon _(hidden)_');
  });
  test('big sheets are truncated with a note', async () => {
    const rows = Array.from({ length: 320 }, (_, i) => [i + 1]);
    const res = await convert(await makeXlsx([{ name: 'S', rows }]), 'big.xlsx');
    expect(res.md).toContain('| 300 | 300 |');
    expect(res.md).not.toContain('| 301 | 301 |');
    expect(res.md).toContain('_Truncated: showing 300 of 320 rows');
  });
});

describe('OpenDocument', () => {
  test('.odp slides with title, bullets, picture and notes', async () => {
    const bytes = await makeOdf(`<office:presentation><draw:page draw:name="p1">
      <draw:frame presentation:class="title"><draw:text-box><text:p>Introduction</text:p></draw:text-box></draw:frame>
      <draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item><text:p>Point A</text:p>
        <text:list><text:list-item><text:p>Détail</text:p></text:list-item></text:list></text:list-item></text:list></draw:text-box></draw:frame>
      <draw:frame><draw:image xlink:href="Pictures/img.png"/></draw:frame>
      <presentation:notes><draw:frame><draw:text-box><text:p>Note orale</text:p></draw:text-box></draw:frame></presentation:notes>
    </draw:page></office:presentation>`, { 'img.png': PNG });
    const res = await convert(bytes, 'cours.odp');
    expect(res.md).toContain('## Slide 1 — Introduction');
    expect(res.md).toContain('- Point A\n  - Détail');
    expect(res.md).toContain('![](cours.odp_media/img.png)');
    expect(res.md).toContain('> 🗒️ Notes: Note orale');
  });
  test('.odt headings, paragraphs with links, lists, tables', async () => {
    const bytes = await makeOdf(`<office:text>
      <text:h text:outline-level="1">Titre</text:h>
      <text:p>Voir <text:a xlink:href="https://vinci.be">le site</text:a>.</text:p>
      <text:list><text:list-item><text:p>un</text:p></text:list-item></text:list>
      <table:table table:name="T"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>
    </office:text>`);
    const res = await convert(bytes, 'notes.odt');
    expect(res.md).toContain('## Titre');
    expect(res.md).toContain('Voir [le site](https://vinci.be).');
    expect(res.md).toContain('- un');
    expect(res.md).toContain('| a | b |');
  });
});

describe('failures never produce a half file', () => {
  test('legacy binary formats are refused with a helpful message', async () => {
    await expect(convert(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'vieux.ppt')).rejects.toThrow(/re-save it as \.pptx/);
  });
  test('a damaged file', async () => {
    await expect(convert(new Uint8Array([1, 2, 3]), 'broken.pptx')).rejects.toThrow(/damaged/);
  });
  test('a ZIP that is not really a presentation', async () => {
    const bytes = await makeDocx(wd.p(wd.r('x')));
    await expect(convert(bytes, 'renamed.pptx')).rejects.toThrow(/not a PowerPoint package/);
  });
});
