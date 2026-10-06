// Builds small but structurally real Office packages (PPTX/DOCX/XLSX/ODP/ODT/ODS) with the
// bundled JSZip, so tests need no binary fixture files.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './harness.js';

const JSZip = createRequire(import.meta.url)(join(ROOT, 'lib/jszip.min.js'));
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const EMF = new Uint8Array([1, 0, 0, 0, 9, 9]);

const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const rel = (id, type, target, external = false) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`;
const rels = (items) => `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
const build = async (files) => {
  const z = new JSZip();
  for (const [path, data] of Object.entries(files)) z.file(path, data);
  return z.generateAsync({ type: 'uint8array' });
};

/* ------------------------------------------------------------------ PowerPoint */
const PNS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" `
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
  + 'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

const run = (t, { b, i, link, font } = {}) => `<a:r><a:rPr lang="fr-BE"${b ? ' b="1"' : ''}${i ? ' i="1"' : ''}>${font ? `<a:latin typeface="${font}"/>` : ''}${link ? `<a:hlinkClick r:id="${link}"/>` : ''}</a:rPr><a:t>${esc(t)}</a:t></a:r>`;
const BU = { none: '<a:buNone/>', char: '<a:buChar char="•"/>', auto: '<a:buAutoNum type="arabicPeriod"/>' };
const para = (p) => {
  const o = typeof p === 'string' ? { runs: [[p]] } : p;
  const pPr = o.lvl || o.bu ? `<a:pPr${o.lvl ? ` lvl="${o.lvl}"` : ''}>${o.bu ? BU[o.bu] : ''}</a:pPr>` : '';
  return `<a:p>${pPr}${o.raw || o.runs.map(([t, f]) => run(t, f)).join('')}</a:p>`;
};
const nv = (id, name, ph = '') => `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`;
export const pp = {
  title: (t) => `<p:sp>${nv(2, 'Title', '<p:ph type="title"/>')}<p:spPr/><p:txBody><a:bodyPr/>${para(t)}</p:txBody></p:sp>`,
  body: (paras) => `<p:sp>${nv(3, 'Content', '<p:ph idx="1"/>')}<p:spPr/><p:txBody><a:bodyPr/>${paras.map(para).join('')}</p:txBody></p:sp>`,
  slideNumber: () => `<p:sp>${nv(9, 'Num', '<p:ph type="sldNum"/>')}<p:spPr/><p:txBody><a:bodyPr/>${para('12')}</p:txBody></p:sp>`,
  textbox: (paras) => `<p:sp>${nv(10, 'TextBox')}<p:spPr/><p:txBody><a:bodyPr/>${paras.map(para).join('')}</p:txBody></p:sp>`,
  code: (lines, font = 'Courier New') => pp.textbox(lines.map((l) => ({ runs: [[l, { font }]] }))),
  audio: (posterRid) => `<p:pic><p:nvPicPr><p:cNvPr id="11" name="Audio 3"/><p:cNvPicPr/><p:nvPr><a:audioFile r:link="rIdA"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${posterRid}"/></p:blipFill><p:spPr/></p:pic>`,
  pic: (rid, alt) => `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Image" descr="${esc(alt)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr/></p:pic>`,
  group: (inner) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="7" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`,
  table: (rows) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${rows.map((r) => `<a:tr h="1">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/>${para(c)}</a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  // PowerPoint's native equation: Office Math in mc:Choice, a rendered picture in mc:Fallback.
  equation: (ommlInner, fallbackRid) => `<mc:AlternateContent><mc:Choice Requires="a14"><p:sp>${nv(6, 'Equation')}<p:spPr/><p:txBody><a:bodyPr/><a:p><a14:m><m:oMathPara><m:oMath>${ommlInner}</m:oMath></m:oMathPara></a14:m></a:p></p:txBody></p:sp></mc:Choice>`
    + `<mc:Fallback><p:sp>${nv(6, 'Equation')}<p:spPr><a:blipFill><a:blip r:embed="${fallbackRid}"/></a:blipFill></p:spPr></p:sp></mc:Fallback></mc:AlternateContent>`,
  ole: (progId, rid) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj progId="${progId}" r:id="rIdOle"><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr/></p:pic></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>`,
};
export const om = {
  r: (t) => `<m:r><m:t>${esc(t)}</m:t></m:r>`,
  f: (n, d) => `<m:f><m:num>${n}</m:num><m:den>${d}</m:den></m:f>`,
  sup: (e, s) => `<m:sSup><m:e>${e}</m:e><m:sup>${s}</m:sup></m:sSup>`,
  bar: (e) => `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${e}</m:e></m:bar>`,
  nary: (chr, sub, sup, e) => `<m:nary><m:naryPr><m:chr m:val="${chr}"/></m:naryPr><m:sub>${sub}</m:sub><m:sup>${sup}</m:sup><m:e>${e}</m:e></m:nary>`,
};

/**
 * slides: [{ file: 'slide7.xml', shapes: '<p:sp>…', rels: [rel(...)], hidden, notes: 'text' }]
 * media: { 'image1.png': bytes } stored in ppt/media/. Slide ORDER is the array order, not the file names.
 */
export async function makePptx(slides, media = {}) {
  const files = {};
  const presRels = [];
  const ids = [];
  slides.forEach((s, i) => {
    presRels.push(rel(`rIdS${i}`, 'slide', `slides/${s.file}`));
    ids.push(`<p:sldId id="${256 + i}" r:id="rIdS${i}"/>`);
    const srels = [...(s.rels || [])];
    if (s.notes) {
      const nf = `notesSlide_${s.file}`;
      srels.push(rel('rIdN', 'notesSlide', `../notesSlides/${nf}`));
      files[`ppt/notesSlides/${nf}`] = `${X}<p:notes ${PNS}><p:cSld><p:spTree>${pp.slideNumber()}<p:sp>${nv(2, 'Notes', '<p:ph type="body" idx="1"/>')}<p:spPr/><p:txBody><a:bodyPr/>${para(s.notes)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
    files[`ppt/slides/${s.file}`] = `${X}<p:sld ${PNS}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.shapes}</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/_rels/${s.file}.rels`] = rels(srels);
  });
  files['ppt/presentation.xml'] = `${X}<p:presentation ${PNS}><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] = rels(presRels);
  for (const [n, d] of Object.entries(media)) files[`ppt/media/${n}`] = d;
  return build(files);
}

/* ------------------------------------------------------------------ Word */
const WNS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R}" `
  + 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
export const wd = {
  r: (t, { b, i } = {}) => `<w:r>${b || i ? `<w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`,
  p: (inner, { style, numId, ilvl = 0 } = {}) => `<w:p>${style || numId ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numId ? `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>` : ''}</w:pPr>` : ''}${inner}</w:p>`,
  link: (rid, text) => `<w:hyperlink r:id="${rid}">${wd.r(text)}</w:hyperlink>`,
  image: (rid, alt) => `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture" descr="${esc(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
  math: (inner) => `<m:oMath>${inner}</m:oMath>`,
  footnoteRef: (id) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`,
  table: (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${wd.p(wd.r(c))}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
};
/** body: inner XML of <w:body>. Styles use French names ("titre 1") with ids like "Titre1". numId 1 = bullets, 2 = decimal. */
export async function makeDocx(body, { rels: extraRels = [], media = {}, footnotes = {} } = {}) {
  const files = {
    'word/document.xml': `${X}<w:document ${WNS}><w:body>${body}</w:body></w:document>`,
    'word/_rels/document.xml.rels': rels(extraRels),
    'word/styles.xml': `${X}<w:styles ${WNS}>`
      + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="MonTitre"><w:name w:val="Mon titre perso"/><w:basedOn w:val="Titre2"/></w:style>'
      + '</w:styles>',
    'word/numbering.xml': `${X}<w:numbering ${WNS}>`
      + '<w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
      + '<w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>'
      + '</w:numbering>',
  };
  if (Object.keys(footnotes).length) {
    files['word/footnotes.xml'] = `${X}<w:footnotes ${WNS}><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>`
      + Object.entries(footnotes).map(([id, t]) => `<w:footnote w:id="${id}">${wd.p(wd.r(t))}</w:footnote>`).join('') + '</w:footnotes>';
  }
  for (const [n, d] of Object.entries(media)) files[`word/media/${n}`] = d;
  return build(files);
}

/* ------------------------------------------------------------------ Excel */
const SNS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"`;
/** sheets: [{ name, hidden, rows: [[cell, …], …] }] where cell = 'text' | number | { v, f } | null */
export async function makeXlsx(sheets) {
  const strings = [];
  const si = (t) => { let i = strings.indexOf(t); if (i < 0) { strings.push(t); i = strings.length - 1; } return i; };
  const files = {};
  const wrels = [];
  const list = [];
  sheets.forEach((sh, n) => {
    const rowsXml = sh.rows.map((row, ri) => `<row r="${ri + 1}">${row.map((c, ci) => {
      if (c == null) return '';
      const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
      if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
      if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${si(c)}</v></c>`;
      if (c.si != null && !c.f) return `<c r="${ref}"><f t="shared" si="${c.si}"/><v>${c.v}</v></c>`;
      if (c.shared) return `<c r="${ref}"><f t="shared" ref="${c.shared.ref}" si="${c.shared.si}">${esc(c.f)}</f><v>${c.v}</v></c>`;
      if (typeof c.v === 'boolean') return `<c r="${ref}" t="b"><f>${esc(c.f)}</f><v>${c.v ? 1 : 0}</v></c>`;
      return `<c r="${ref}"><f>${esc(c.f)}</f><v>${c.v}</v></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${n + 1}.xml`] = `${X}<worksheet ${SNS}><sheetData>${rowsXml}</sheetData></worksheet>`;
    wrels.push(rel(`rId${n + 1}`, 'worksheet', `worksheets/sheet${n + 1}.xml`));
    list.push(`<sheet name="${esc(sh.name)}" sheetId="${n + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${n + 1}"/>`);
  });
  files['xl/workbook.xml'] = `${X}<workbook ${SNS}><sheets>${list.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = rels(wrels);
  files['xl/sharedStrings.xml'] = `${X}<sst ${SNS}>${strings.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`;
  return build(files);
}

/* ------------------------------------------------------------------ OpenDocument */
const ONS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
  + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
export async function makeOdf(bodyInner, media = {}) {
  const files = { 'content.xml': `${X}<office:document-content ${ONS}><office:body>${bodyInner}</office:body></office:document-content>` };
  for (const [n, d] of Object.entries(media)) files[`Pictures/${n}`] = d;
  return build(files);
}
