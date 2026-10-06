// Office → Markdown converter (runs in the browser, no server, no install).
// Office files are ZIP packages of XML, so JSZip + DOMParser are enough to read their content.
// Exposes window.Office2Md = { kindOf(name, type), convert(data, name, opts) }.
// Layout is NOT reproduced — the goal is faithful text, structure, tables and pictures for an AI.
(() => {
  if (window.Office2Md) return;

  /* ----------------------------------------------------------------- file kinds */
  const KINDS = {
    pptx: ['slides', 'ooxml'], pptm: ['slides', 'ooxml'], ppsx: ['slides', 'ooxml'], potx: ['slides', 'ooxml'],
    odp: ['slides', 'odf'],
    docx: ['docs', 'ooxml'], docm: ['docs', 'ooxml'], dotx: ['docs', 'ooxml'],
    odt: ['docs', 'odf'],
    xlsx: ['sheets', 'ooxml'], xlsm: ['sheets', 'ooxml'], xltx: ['sheets', 'ooxml'],
    ods: ['sheets', 'odf'],
    ppt: ['slides', 'legacy'], pps: ['slides', 'legacy'], doc: ['docs', 'legacy'], xls: ['sheets', 'legacy'],
  };
  const MODERN = { slides: 'pptx', docs: 'docx', sheets: 'xlsx' };
  const LABEL = { slides: 'slides', docs: 'document', sheets: 'spreadsheet' };

  /** → { kind: 'slides'|'docs'|'sheets', format: 'ooxml'|'odf'|'legacy', ext, modern } or null */
  function kindOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    const k = m && KINDS[m[1].toLowerCase()];
    return k ? { kind: k[0], format: k[1], ext: m[1].toLowerCase(), modern: MODERN[k[0]] } : null;
  }

  /* ----------------------------------------------------------------- XML helpers (match by localName) */
  function parseXml(text) {
    const d = new DOMParser().parseFromString(text, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error('invalid XML inside the file');
    return d;
  }
  const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
  const kid = (el, name) => kids(el, name)[0] || null;
  const desc = (el, name) => (el ? [...el.getElementsByTagName('*')].filter((c) => c.localName === name) : []);
  const first = (el, name) => desc(el, name)[0] || null;
  // Attribute by local name; prefixed (e.g. r:id) preferred over plain (id) when both exist.
  function attr(el, local) {
    if (!el || !el.attributes) return null;
    let plain = null;
    for (const a of el.attributes) {
      if (a.localName !== local) continue;
      if (a.prefix) return a.value;
      plain = a.value;
    }
    return plain;
  }
  const val = (el) => attr(el, 'val');
  const isOn = (v) => v === '1' || v === 'true' || v === 'on';
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const mdLink = (href) => (/\s/.test(href) ? `<${href}>` : href);
  const tick = async (opts) => {
    if (opts.shouldStop && opts.shouldStop()) throw new Error('cancelled');
    await new Promise((r) => setTimeout(r, 0)); // keep the tab responsive
  };

  function table(rows) {
    const data = rows.map((r) => r.map((c) => clean(c).replace(/\|/g, '\\|'))).filter((r) => r.some((c) => c));
    if (!data.length) return '';
    const cols = Math.max(...data.map((r) => r.length));
    const pad = (r) => { const x = r.slice(); while (x.length < cols) x.push(''); return x; };
    const out = [`| ${pad(data[0]).join(' | ')} |`, `| ${Array(cols).fill('---').join(' | ')} |`];
    for (const r of data.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
    return out.join('\n');
  }

  // Inline segments → Markdown (adjacent runs with the same formatting are merged first).
  function renderSegs(segs) {
    const merged = [];
    for (const s of segs) {
      const prev = merged[merged.length - 1];
      if (prev && !s.raw && !prev.raw && prev.b === s.b && prev.i === s.i && prev.link === s.link) prev.t += s.t;
      else merged.push({ ...s });
    }
    return merged.map((s) => {
      if (s.raw) return s.t;
      let t = s.t;
      if (!t.trim()) return t;
      const lead = t.match(/^\s*/)[0], trail = t.match(/\s*$/)[0];
      t = t.trim();
      if (s.b) t = `**${t}**`;
      if (s.i) t = `*${t}*`;
      if (s.link) t = `[${t}](${mdLink(s.link)})`;
      return lead + t + trail;
    }).join('').replace(/[ \t]+/g, ' ');
  }

  /* ----------------------------------------------------------------- OMML (Office Math) → linear text */
  function omml(el) {
    const ln = el.localName;
    if (/Pr$/.test(ln)) return ''; // property elements
    const part = (name) => { const k = kid(el, name); return k ? omml(k) : ''; };
    const wrap = (s) => (s.length > 1 ? `(${s})` : s);
    const chr = (pr, name, dflt) => { const c = kid(kid(el, pr), name); const v = c && val(c); return v == null ? dflt : v; };
    switch (ln) {
      case 't': return el.textContent;
      case 'f': return `${wrap(part('num'))}/${wrap(part('den'))}`;
      case 'sSup': return `${part('e')}^${wrap(part('sup'))}`;
      case 'sSub': return `${part('e')}_${wrap(part('sub'))}`;
      case 'sSubSup': return `${part('e')}_${wrap(part('sub'))}^${wrap(part('sup'))}`;
      case 'sPre': return `_${wrap(part('sub'))}^${wrap(part('sup'))}${part('e')}`;
      case 'rad': { const d = part('deg'); return `${d ? `${wrap(d)}` : ''}√${wrap(part('e'))}`; }
      case 'nary': {
        const sub = part('sub'), sup = part('sup');
        return `${chr('naryPr', 'chr', '∫')}${sub ? `_${wrap(sub)}` : ''}${sup ? `^${wrap(sup)}` : ''} ${part('e')}`;
      }
      case 'd': {
        const sep = chr('dPr', 'sepChr', ',');
        return chr('dPr', 'begChr', '(') + kids(el, 'e').map(omml).join(sep) + chr('dPr', 'endChr', ')');
      }
      case 'func': return `${part('fName')} ${part('e')}`;
      case 'bar': return `${wrap(part('e'))}̅`; // overline (e.g. NOT in Boolean algebra)
      case 'acc': return `${wrap(part('e'))}${chr('accPr', 'chr', '̂')}`;
      case 'limLow': return `${part('e')}_${wrap(part('lim'))}`;
      case 'limUpp': return `${part('e')}^${wrap(part('lim'))}`;
      case 'm': // m:m is a matrix ONLY in the math namespace (PowerPoint's a14:m wrapper is also named "m")
        if (!/\/math$/.test(el.namespaceURI || '')) return [...el.children].map(omml).join('');
        return `[${kids(el, 'mr').map((r) => kids(r, 'e').map(omml).join(', ')).join('; ')}]`;
      case 'eqArr': return kids(el, 'e').map(omml).join('; ');
      default: return [...el.children].map(omml).join('');
    }
  }
  const mathText = (el) => clean(omml(el));

  /* ----------------------------------------------------------------- package + pictures */
  function resolvePath(fromPart, target) {
    let t = target;
    try { t = decodeURIComponent(t); } catch (_) { /* keep */ }
    if (t.startsWith('/')) return t.slice(1);
    const base = fromPart.split('/').slice(0, -1);
    for (const seg of t.split('/')) {
      if (seg === '..') base.pop();
      else if (seg && seg !== '.') base.push(seg);
    }
    return base.join('/');
  }

  class Pkg {
    constructor(zip) { this.zip = zip; this.relCache = new Map(); }
    has(path) { return !!this.zip.file(path); }
    async text(path) { const f = this.zip.file(path); return f ? f.async('string') : null; }
    async xml(path) { const t = await this.text(path); return t == null ? null : parseXml(t); }
    async rels(part) {
      if (this.relCache.has(part)) return this.relCache.get(part);
      const i = part.lastIndexOf('/');
      const relsPath = `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
      const map = new Map();
      const doc = await this.xml(relsPath);
      for (const r of desc(doc, 'Relationship')) {
        const external = r.getAttribute('TargetMode') === 'External';
        const target = r.getAttribute('Target') || '';
        map.set(r.getAttribute('Id'), { type: r.getAttribute('Type') || '', external, target: external ? target : resolvePath(part, target) });
      }
      this.relCache.set(part, map);
      return map;
    }
  }

  class Media {
    constructor(pkg, opts) { this.pkg = pkg; this.opts = opts; this.byPath = new Map(); this.names = new Set(); this.images = []; }
    // Returns a Markdown image (or '' when pictures are off / missing).
    async ref(path, alt = '') {
      if (!this.opts.pictures || !path) return '';
      let name = this.byPath.get(path);
      if (!name) {
        const f = this.pkg.zip.file(path);
        if (!f) return '';
        const base = (path.split('/').pop() || 'image').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
        const m = base.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
        name = base;
        for (let i = 2; this.names.has(name.toLowerCase()); i++) name = `${m[1]} (${i})${m[2] || ''}`;
        this.names.add(name.toLowerCase());
        this.images.push({ name, data: await f.async('uint8array') });
        this.byPath.set(path, name);
      }
      const legacy = /\.(emf|wmf)$/i.test(name) ? ' ⚠️ EMF/WMF picture (may not display)' : '';
      return `![${clean(alt).replace(/[[\]]/g, '')}](${mdLink(`${this.opts.mediaDir || 'media'}/${name}`)})${legacy}`;
    }
  }

  /* ----------------------------------------------------------------- PowerPoint (.pptx) */
  const MONO = /consol|courier|mono|menlo|monaco|code|cascadia|lucida console|terminal/i;
  // One DrawingML paragraph (a:p) → { text (markdown), plain (raw, spacing kept), lvl, bu: 'none'|'char'|'auto'|null, mono }
  function dmlPara(p, rels) {
    const pPr = kid(p, 'pPr');
    const lvl = Number(attr(pPr, 'lvl') || 0);
    const bu = kid(pPr, 'buNone') ? 'none' : kid(pPr, 'buAutoNum') ? 'auto' : kid(pPr, 'buChar') ? 'char' : null;
    const segs = [];
    let plain = '', monoRuns = 0, textRuns = 0;
    for (const c of p.children) {
      switch (c.localName) {
        case 'r': case 'fld': {
          const rPr = kid(c, 'rPr');
          const hl = kid(rPr, 'hlinkClick');
          const rel = hl && rels.get(attr(hl, 'id'));
          const t = (kid(c, 't') || {}).textContent || '';
          plain += t;
          if (t.trim()) { textRuns++; if (MONO.test(attr(kid(rPr, 'latin'), 'typeface') || '')) monoRuns++; }
          segs.push({ t, b: isOn(attr(rPr, 'b')), i: isOn(attr(rPr, 'i')), link: rel && rel.external ? rel.target : null });
          break;
        }
        case 'br': segs.push({ t: ' ' }); plain += '\n'; break;
        case 'm': { // a14:m wrapper around Office Math
          const eq = desc(c, 'oMath').map(mathText).filter(Boolean).join('; ');
          if (eq) segs.push({ t: ` \`${eq}\` `, raw: true });
          break;
        }
        case 'AlternateContent': {
          const math = first(kid(c, 'Choice'), 'oMath');
          if (math) segs.push({ t: ` \`${mathText(math)}\` `, raw: true });
          else segs.push({ t: desc(kid(c, 'Fallback'), 't').map((t) => t.textContent).join('') });
          break;
        }
        default: break;
      }
    }
    return { text: clean(renderSegs(segs)), plain: plain.replace(/\s+$/, ''), lvl, bu, mono: textRuns > 0 && monoRuns === textRuns };
  }
  const allParas = (txBody, rels) => kids(txBody, 'p').map((p) => dmlPara(p, rels));
  const txBodyParas = (txBody, rels) => allParas(txBody, rels).filter((p) => p.text);

  // Text of a shape → Markdown lines. Code (all monospace) → fenced block; bullets only where the
  // slide really has them (body placeholder, or explicit bullet/number); text boxes stay plain.
  function shapeLines(paras, bodyPlaceholder) {
    const filled = paras.filter((p) => p.text);
    if (!filled.length) return [];
    if (filled.every((p) => p.mono)) {
      const code = paras.map((p) => p.plain);
      while (code.length && !code[0].trim()) code.shift();
      while (code.length && !code[code.length - 1].trim()) code.pop();
      return ['```\n' + code.join('\n') + '\n```'];
    }
    const counters = [];
    return filled.map((p) => {
      const bulleted = p.bu === 'char' || p.bu === 'auto' || (bodyPlaceholder && p.bu !== 'none');
      if (!bulleted) return p.text;
      counters.length = p.lvl + 1;
      if (p.bu !== 'auto') { counters[p.lvl] = 0; return `${'  '.repeat(p.lvl)}- ${p.text}`; } // a bullet breaks numbering
      counters[p.lvl] = (counters[p.lvl] || 0) + 1;
      return `${'  '.repeat(p.lvl)}${counters[p.lvl]}. ${p.text}`;
    });
  }
  const SKIP_PH = /^(sldNum|dt|ftr|hdr)$/;

  async function pptxShapes(container, ctx, lines) {
    for (const el of container.children) {
      switch (el.localName) {
        case 'sp': {
          const ph = first(kid(el, 'nvSpPr'), 'ph');
          const phType = ph ? ph.getAttribute('type') || 'body' : '';
          if (SKIP_PH.test(phType)) break;
          const all = allParas(kid(el, 'txBody'), ctx.rels);
          const paras = all.filter((p) => p.text);
          if (/^(title|ctrTitle)$/.test(phType) && !ctx.title) {
            ctx.title = paras.map((p) => p.text).join(' — ');
          } else {
            lines.push(...shapeLines(all, /^(body|obj)$/.test(phType)));
          }
          const blip = first(kid(el, 'spPr'), 'blip'); // picture used as shape fill
          if (blip) { const r = ctx.rels.get(attr(blip, 'embed')); const img = r && await ctx.media.ref(r.target); if (img) lines.push(img); }
          if (first(el, 'oMath')) { // equation-only text box whose text lives in a14:m
            const eq = desc(el, 'oMath').map(mathText).filter(Boolean);
            if (eq.length && !paras.length) lines.push(`🧮 Equation: \`${eq.join('; ')}\``);
          }
          break;
        }
        case 'grpSp': await pptxShapes(el, ctx, lines); break;
        case 'pic': {
          // Embedded narration/video: the picture is only a speaker/play icon.
          const nvPr = first(kid(el, 'nvPicPr'), 'nvPr');
          const isAudio = !!first(nvPr, 'audioFile') || !!first(nvPr, 'wavAudioFile');
          const isVideo = !!first(nvPr, 'videoFile') || !!first(nvPr, 'quickTimeFile');
          if (isAudio || isVideo || first(nvPr, 'media')) {
            const line = isVideo ? '🎥 Embedded video (play it in the original file)' : '🔊 Embedded audio narration (play it in the original file)';
            if (!lines.includes(line)) lines.push(line);
            break;
          }
          const blip = first(el, 'blip');
          const r = blip && ctx.rels.get(attr(blip, 'embed'));
          const alt = attr(first(el, 'cNvPr'), 'descr') || attr(first(el, 'cNvPr'), 'name') || '';
          const img = r && await ctx.media.ref(r.target, alt);
          if (img) lines.push(img);
          break;
        }
        case 'graphicFrame': await pptxFrame(el, ctx, lines); break;
        case 'AlternateContent': {
          const choice = kid(el, 'Choice'), fallback = kid(el, 'Fallback');
          const maths = desc(choice, 'oMath');
          if (maths.length) {
            // PowerPoint equation: text from the Office Math, picture from the fallback rendering.
            const sub = [];
            await pptxShapes(choice, { ...ctx, media: { ref: async () => '' } }, sub);
            const textLines = sub.filter((l) => !l.startsWith('🧮'));
            if (textLines.length) lines.push(...textLines);
            else lines.push(`🧮 Equation: \`${maths.map(mathText).join('; ')}\``);
            const blips = desc(fallback, 'blip');
            for (const b of blips) { const r = ctx.rels.get(attr(b, 'embed')); const img = r && await ctx.media.ref(r.target, 'equation'); if (img) lines.push(img); }
          } else {
            const sub = [];
            await pptxShapes(choice || el, ctx, sub);
            if (!sub.length && fallback) await pptxShapes(fallback, ctx, sub);
            lines.push(...sub);
          }
          break;
        }
        default: break;
      }
    }
  }

  async function pptxFrame(el, ctx, lines) {
    const tbl = first(el, 'tbl');
    if (tbl) {
      const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => txBodyParas(kid(tc, 'txBody'), ctx.rels).map((p) => p.text).join(' ')));
      const t = table(rows);
      if (t) lines.push(t);
      return;
    }
    const chart = first(el, 'chart');
    if (chart) {
      const r = ctx.rels.get(attr(chart, 'id'));
      const doc = r && await ctx.pkg.xml(r.target);
      const title = doc ? clean(desc(first(doc, 'title'), 't').map((t) => t.textContent).join(' ')) : '';
      lines.push(`📊 Chart${title ? `: ${title}` : ''}`);
      return;
    }
    const dgm = first(el, 'relIds');
    if (dgm) {
      const r = ctx.rels.get(attr(dgm, 'dm'));
      const doc = r && await ctx.pkg.xml(r.target);
      const texts = doc ? desc(doc, 'pt').map((pt) => clean(desc(pt, 't').map((t) => t.textContent).join(''))).filter(Boolean) : [];
      lines.push('🔷 Diagram (SmartArt):');
      for (const t of texts) lines.push(`  - ${t}`);
      return;
    }
    const ole = first(el, 'oleObj');
    if (ole) {
      const prog = ole.getAttribute('progId') || 'object';
      lines.push(/equation|dsmt|mathtype/i.test(prog) ? `🧮 Equation object (${prog})` : `📎 Embedded object (${prog})`);
      const blip = first(el, 'blip');
      const r = blip && ctx.rels.get(attr(blip, 'embed'));
      const img = r && await ctx.media.ref(r.target, prog);
      if (img) lines.push(img);
    }
  }

  async function pptx(pkg, name, media, opts) {
    const pres = await pkg.xml('ppt/presentation.xml');
    if (!pres) throw new Error('not a PowerPoint package (ppt/presentation.xml missing)');
    const prels = await pkg.rels('ppt/presentation.xml');
    const slides = desc(pres, 'sldId').map((s) => prels.get(attr(s, 'id'))).filter(Boolean).map((r) => r.target);
    const out = [];
    let n = 0;
    for (const path of slides) {
      n++;
      await tick(opts);
      const doc = await pkg.xml(path);
      if (!doc) continue;
      const rels = await pkg.rels(path);
      const ctx = { pkg, rels, media, title: '' };
      const lines = [];
      await pptxShapes(first(doc, 'spTree'), ctx, lines);
      const hidden = doc.documentElement.getAttribute('show') === '0';
      out.push(`## Slide ${n}${ctx.title ? ` — ${ctx.title}` : ''}${hidden ? ' _(hidden slide)_' : ''}`);
      if (lines.length) out.push(lines.join('\n'));
      const notesRel = [...rels.values()].find((r) => /\/notesSlide$/.test(r.type));
      const notes = notesRel && await pkg.xml(notesRel.target);
      if (notes) {
        const text = desc(notes, 'sp')
          .filter((sp) => { const ph = first(sp, 'ph'); return ph && (ph.getAttribute('type') || 'body') === 'body'; })
          .flatMap((sp) => txBodyParas(kid(sp, 'txBody'), rels).map((p) => p.text));
        if (text.length) out.push(`> 🗒️ Notes: ${text.join(' ')}`);
      }
    }
    return { count: n, unit: 'slides', body: out.join('\n\n') };
  }

  /* ----------------------------------------------------------------- Word (.docx) */
  async function docx(pkg, name, media, opts) {
    const doc = await pkg.xml('word/document.xml');
    if (!doc) throw new Error('not a Word package (word/document.xml missing)');
    const rels = await pkg.rels('word/document.xml');

    // Styles: heading level resolved by style NAME (works for French "Titre 1" templates too).
    const styles = new Map();
    for (const s of desc(await pkg.xml('word/styles.xml'), 'style')) {
      styles.set(attr(s, 'styleId'), {
        name: val(kid(s, 'name')) || '',
        basedOn: val(kid(s, 'basedOn')),
        outline: val(first(kid(s, 'pPr'), 'outlineLvl')),
      });
    }
    function headingLevel(styleId) {
      for (let id = styleId, i = 0; id && i < 6; i++) {
        const st = styles.get(id) || { name: id };
        const m = /^(?:heading|titre|überschrift)\s*(\d)$/i.exec(st.name) || /^(?:heading|titre)(\d)$/i.exec(id);
        if (m) return Number(m[1]);
        if (/^(title|titre)$/i.test(st.name)) return 1;
        if (st.outline != null && /^\d$/.test(st.outline)) return Number(st.outline) + 1;
        id = st && st.basedOn;
      }
      return 0;
    }

    // Numbering: ordered vs bullet per numId/ilvl.
    const numDoc = await pkg.xml('word/numbering.xml');
    const abstract = new Map(desc(numDoc, 'abstractNum').map((a) => [attr(a, 'abstractNumId'), a]));
    const nums = new Map(desc(numDoc, 'num').map((n) => [attr(n, 'numId'), val(kid(n, 'abstractNumId'))]));
    function isOrdered(numId, ilvl) {
      const a = abstract.get(nums.get(numId));
      const lvl = a && kids(a, 'lvl').find((l) => attr(l, 'ilvl') === String(ilvl));
      const fmt = lvl && val(kid(lvl, 'numFmt'));
      return !!fmt && fmt !== 'bullet' && fmt !== 'none';
    }
    const counters = new Map();

    async function runs(container, segs) {
      for (const c of container.children) {
        switch (c.localName) {
          case 'r': {
            const rPr = kid(c, 'rPr');
            const on = (n) => { const e = kid(rPr, n); return !!e && !/^(0|false|off)$/.test(val(e) || ''); };
            const b = on('b'), i = on('i');
            for (const x of c.children) {
              if (x.localName === 't') segs.push({ t: x.textContent, b, i });
              else if (x.localName === 'tab') segs.push({ t: ' ', b, i });
              else if (x.localName === 'br' || x.localName === 'cr') segs.push({ t: ' ' });
              else if (x.localName === 'footnoteReference') segs.push({ t: `[^${attr(x, 'id')}]`, raw: true });
              else if (x.localName === 'drawing' || x.localName === 'pict' || x.localName === 'object') {
                const blip = first(x, 'blip');
                const rid = blip ? attr(blip, 'embed') : attr(first(x, 'imagedata'), 'id');
                const rel = rid && rels.get(rid);
                const prog = attr(first(x, 'OLEObject'), 'ProgID');
                if (prog) segs.push({ t: /equation|dsmt/i.test(prog) ? ` 🧮 Equation object (${prog}) ` : ` 📎 Embedded object (${prog}) `, raw: true });
                const img = rel && await media.ref(rel.target, attr(first(x, 'docPr'), 'descr') || '');
                if (img) segs.push({ t: ` ${img} `, raw: true });
              }
            }
            break;
          }
          case 'hyperlink': {
            const rel = rels.get(attr(c, 'id'));
            const inner = [];
            await runs(c, inner);
            const link = rel && rel.external ? rel.target : null;
            for (const s of inner) segs.push(link && !s.raw ? { ...s, link } : s);
            break;
          }
          case 'oMath': segs.push({ t: ` \`${mathText(c)}\` `, raw: true }); break;
          case 'oMathPara': segs.push({ t: ` \`${kids(c, 'oMath').map(mathText).join('; ')}\` `, raw: true }); break;
          case 'ins': case 'smartTag': case 'fldSimple': case 'customXml': case 'sdtContent': await runs(c, segs); break;
          case 'sdt': await runs(kid(c, 'sdtContent') || c, segs); break;
          default: break;
        }
      }
    }
    async function paraText(p) { const segs = []; await runs(p, segs); return clean(renderSegs(segs)); }

    const blocks = []; // { text, list }
    async function walk(container) {
      for (const el of container.children) {
        if (el.localName === 'p') {
          const pPr = kid(el, 'pPr');
          const text = await paraText(el);
          if (!text) continue;
          const level = headingLevel(val(kid(pPr, 'pStyle'))) || (val(kid(pPr, 'outlineLvl')) != null ? Number(val(kid(pPr, 'outlineLvl'))) + 1 : 0);
          const numPr = kid(pPr, 'numPr');
          const numId = numPr && val(kid(numPr, 'numId'));
          if (level && level < 9) {
            blocks.push({ text: `${'#'.repeat(Math.min(6, level + 1))} ${text.replace(/\*\*/g, '')}` });
          } else if (numId && numId !== '0') {
            const ilvl = Number(val(kid(numPr, 'ilvl')) || 0);
            let marker = '-';
            if (isOrdered(numId, ilvl)) {
              const key = `${numId}:${ilvl}`;
              const n = (counters.get(key) || 0) + 1;
              counters.set(key, n);
              for (const k of counters.keys()) { const [id, l] = k.split(':'); if (id === numId && Number(l) > ilvl) counters.delete(k); }
              marker = `${n}.`;
            }
            blocks.push({ text: `${'   '.repeat(ilvl)}${marker} ${text}`, list: true });
          } else {
            blocks.push({ text });
          }
        } else if (el.localName === 'tbl') {
          const rows = [];
          for (const tr of kids(el, 'tr')) {
            const cells = [];
            for (const tc of kids(tr, 'tc')) cells.push((await Promise.all(kids(tc, 'p').map(paraText))).filter(Boolean).join(' '));
            rows.push(cells);
          }
          const t = table(rows);
          if (t) blocks.push({ text: t });
          await tick(opts);
        } else if (el.localName === 'sdt') {
          await walk(kid(el, 'sdtContent') || el);
        }
      }
    }
    await walk(first(doc, 'body'));

    const out = blocks.map((b, i) => (i === 0 ? '' : b.list && blocks[i - 1].list ? '\n' : '\n\n') + b.text).join('');
    const notes = [];
    for (const fn of desc(await pkg.xml('word/footnotes.xml'), 'footnote')) {
      const id = attr(fn, 'id');
      if (Number(id) <= 0 || attr(fn, 'type')) continue; // separators
      const t = (await Promise.all(kids(fn, 'p').map(paraText))).filter(Boolean).join(' ');
      if (t) notes.push(`[^${id}]: ${t}`);
    }
    return { count: blocks.length, unit: 'blocks', body: out + (notes.length ? `\n\n${notes.join('\n')}` : '') };
  }

  /* ----------------------------------------------------------------- Excel (.xlsx) */
  const MAX_ROWS = 300, MAX_COLS = 30;
  const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

  function gridTable(grid, maxRow, maxCol) {
    const rows = Math.min(maxRow, MAX_ROWS), cols = Math.min(maxCol, MAX_COLS);
    const out = [[''].concat(Array.from({ length: cols }, (_, c) => colName(c)))];
    for (let r = 1; r <= rows; r++) {
      const row = grid.get(r);
      out.push([String(r)].concat(Array.from({ length: cols }, (_, c) => (row && row.get(c)) || '')));
    }
    let md = table(out);
    if (maxRow > MAX_ROWS || maxCol > MAX_COLS) md += `\n\n_Truncated: showing ${rows} of ${maxRow} rows and ${cols} of ${maxCol} columns — see the original file._`;
    return md;
  }

  // Excel "shared formula" followers store no text: rebuild it from the master by shifting relative refs.
  function shiftFormula(f, dr, dc) {
    return f.replace(/("[^"]*")|(?<![A-Za-z_\d.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g, (m, str, cAbs, col, rAbs, row) => {
      if (str) return str;
      const c = cAbs ? col : colName(colIndex(col) + dc);
      const r = rAbs ? row : String(Number(row) + dr);
      return `${cAbs}${c}${rAbs}${r}`;
    });
  }

  async function xlsx(pkg, name, media, opts) {
    const wb = await pkg.xml('xl/workbook.xml');
    if (!wb) throw new Error('not an Excel package (xl/workbook.xml missing)');
    const wrels = await pkg.rels('xl/workbook.xml');
    const shared = desc(await pkg.xml('xl/sharedStrings.xml'), 'si').map((si) => desc(si, 't').map((t) => t.textContent).join(''));
    const out = [];
    let n = 0;
    for (const sh of desc(wb, 'sheet')) {
      n++;
      await tick(opts);
      const rel = wrels.get(attr(sh, 'id'));
      const doc = rel && await pkg.xml(rel.target);
      const title = `## Sheet: ${sh.getAttribute('name') || n}${/hidden/i.test(sh.getAttribute('state') || '') ? ' _(hidden)_' : ''}`;
      if (!doc) { out.push(title); continue; }
      const grid = new Map();
      const sharedF = new Map(); // si → { f, row, col } of the master cell
      let maxRow = 0, maxCol = 0, rowNo = 0;
      for (const row of desc(doc, 'row')) {
        rowNo = Number(row.getAttribute('r')) || rowNo + 1;
        let colNo = -1;
        for (const c of kids(row, 'c')) {
          const ref = /^([A-Z]+)(\d+)$/.exec(c.getAttribute('r') || '');
          colNo = ref ? colIndex(ref[1]) : colNo + 1;
          const t = c.getAttribute('t');
          const v = (kid(c, 'v') || {}).textContent;
          const fEl = kid(c, 'f');
          let f = fEl ? fEl.textContent : '';
          if (fEl && fEl.getAttribute('t') === 'shared') {
            const si = fEl.getAttribute('si');
            if (f) sharedF.set(si, { f, row: rowNo, col: colNo });
            else if (sharedF.has(si)) { const m = sharedF.get(si); f = shiftFormula(m.f, rowNo - m.row, colNo - m.col); }
          }
          let value = v == null ? '' : v;
          if (t === 's') value = shared[Number(v)] || '';
          else if (t === 'inlineStr') value = desc(kid(c, 'is'), 't').map((x) => x.textContent).join('');
          else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          const text = clean(value) + (f ? ` (=${clean(f)})` : '');
          if (!text) continue;
          if (!grid.has(rowNo)) grid.set(rowNo, new Map());
          grid.get(rowNo).set(colNo, text);
          maxRow = Math.max(maxRow, rowNo);
          maxCol = Math.max(maxCol, colNo + 1);
        }
      }
      out.push(maxRow ? `${title}\n\n${gridTable(grid, maxRow, maxCol)}` : `${title}\n\n_(empty)_`);
    }
    return { count: n, unit: 'sheets', body: out.join('\n\n') };
  }

  /* ----------------------------------------------------------------- OpenDocument (.odp/.odt/.ods) */
  async function odfInline(el, media, segs) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { segs.push({ t: n.nodeValue }); continue; }
      if (n.nodeType !== 1) continue;
      switch (n.localName) {
        case 's': segs.push({ t: ' '.repeat(Number(attr(n, 'c') || 1)) }); break;
        case 'tab': case 'line-break': segs.push({ t: ' ' }); break;
        case 'a': { const inner = []; await odfInline(n, media, inner); const href = attr(n, 'href'); for (const s of inner) segs.push(href && !s.raw ? { ...s, link: href } : s); break; }
        case 'frame': { const img = await odfImage(n, media); if (img) segs.push({ t: ` ${img} `, raw: true }); break; }
        case 'note': case 'annotation': case 'bookmark': case 'bookmark-start': case 'bookmark-end': break;
        default: await odfInline(n, media, segs);
      }
    }
  }
  async function odfText(el, media) { const segs = []; await odfInline(el, media, segs); return clean(renderSegs(segs)); }
  async function odfImage(frame, media) {
    const im = first(frame, 'image');
    const href = im && attr(im, 'href');
    return href && !/^[a-z]+:/i.test(href) ? media.ref(href.replace(/^\.\//, ''), attr(first(frame, 'title'), 'title') || '') : '';
  }
  async function odfTable(tbl, media) {
    const rows = [];
    for (const tr of desc(tbl, 'table-row').slice(0, MAX_ROWS)) {
      const cells = [];
      for (const tc of kids(tr, 'table-cell')) {
        const rep = Math.min(Number(attr(tc, 'number-columns-repeated') || 1), MAX_COLS);
        const formula = attr(tc, 'formula');
        const text = (await Promise.all(kids(tc, 'p').map((p) => odfText(p, media)))).join(' ') + (formula ? ` (${formula.replace(/^of:/, '')})` : '');
        for (let i = 0; i < rep && cells.length < MAX_COLS; i++) cells.push(text);
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      const rep = Math.min(Number(attr(tr, 'number-rows-repeated') || 1), 50);
      for (let i = 0; i < rep && cells.length; i++) rows.push(cells);
    }
    return table(rows);
  }
  async function odfBlocks(container, media, lines, depth = 0) {
    for (const el of container.children) {
      switch (el.localName) {
        case 'h': { const t = await odfText(el, media); if (t) lines.push(`${'#'.repeat(Math.min(6, Number(attr(el, 'outline-level') || 1) + 1))} ${t}`); break; }
        case 'p': { const t = await odfText(el, media); if (t) lines.push(depth ? `${'  '.repeat(depth - 1)}- ${t}` : t); break; }
        case 'list': for (const item of kids(el, 'list-item')) await odfBlocks(item, media, lines, depth + 1); break;
        case 'table': { const t = await odfTable(el, media); if (t) lines.push(t); break; }
        case 'frame': {
          const box = kid(el, 'text-box');
          if (box) await odfBlocks(box, media, lines, depth);
          else { const img = await odfImage(el, media); if (img) lines.push(img); }
          if (kid(el, 'table')) lines.push(await odfTable(kid(el, 'table'), media));
          break;
        }
        case 'g': case 'section': case 'custom-shape': case 'text-box': await odfBlocks(el, media, lines, depth); break;
        default: break;
      }
    }
  }

  async function odf(pkg, name, media, opts, kind) {
    const content = await pkg.xml('content.xml');
    if (!content) throw new Error('not an OpenDocument package (content.xml missing)');
    const body = first(content, 'body');
    const out = [];
    if (kind === 'slides') {
      let n = 0;
      for (const page of desc(body, 'page')) {
        n++;
        await tick(opts);
        let title = '';
        const lines = [];
        for (const frame of kids(page, 'frame')) {
          if (/title/.test(attr(frame, 'class') || '') && !title) { title = clean((await Promise.all(desc(frame, 'p').map((p) => odfText(p, media)))).join(' ')); continue; }
          await odfBlocks({ children: [frame] }, media, lines);
        }
        for (const other of page.children) if (other.localName !== 'frame' && other.localName !== 'notes') await odfBlocks({ children: [other] }, media, lines);
        out.push(`## Slide ${n}${title ? ` — ${title}` : ''}`);
        if (lines.length) out.push(lines.join('\n'));
        const notes = kid(page, 'notes');
        const nt = notes ? clean((await Promise.all(desc(notes, 'p').map((p) => odfText(p, media)))).join(' ')) : '';
        if (nt) out.push(`> 🗒️ Notes: ${nt}`);
      }
      return { count: n, unit: 'slides', body: out.join('\n\n') };
    }
    if (kind === 'sheets') {
      let n = 0;
      for (const tbl of desc(body, 'table')) {
        n++;
        await tick(opts);
        out.push(`## Sheet: ${attr(tbl, 'name') || n}\n\n${(await odfTable(tbl, media)) || '_(empty)_'}`);
      }
      return { count: n, unit: 'sheets', body: out.join('\n\n') };
    }
    const lines = [];
    await odfBlocks(first(body, 'text') || body, media, lines);
    return { count: lines.length, unit: 'blocks', body: lines.join('\n\n') };
  }

  /* ----------------------------------------------------------------- entry point */
  /**
   * data: Blob | ArrayBuffer | Uint8Array of the Office file.
   * opts: { pictures = true, mediaDir = '<name>_media', shouldStop?: () => boolean }
   * → { md, images: [{ name, data: Uint8Array }], warnings: string[], kind, count }
   */
  async function convert(data, name, opts = {}) {
    const k = kindOf(name);
    if (!k) throw new Error('not an Office file');
    if (k.format === 'legacy') throw new Error(`old binary .${k.ext} format can't be read in the browser (re-save it as .${k.modern} to convert)`);
    const o = { pictures: true, mediaDir: `${name}_media`, ...opts };
    let zip;
    try { zip = await JSZip.loadAsync(data); } catch (_) { throw new Error('the file is damaged or not a real Office file'); }
    const pkg = new Pkg(zip);
    const media = new Media(pkg, o);
    const res = k.format === 'odf' ? await odf(pkg, name, media, o, k.kind)
      : k.kind === 'slides' ? await pptx(pkg, name, media, o)
        : k.kind === 'docs' ? await docx(pkg, name, media, o)
          : await xlsx(pkg, name, media, o);
    const warnings = [];
    if (media.images.some((i) => /\.(emf|wmf)$/i.test(i.name))) warnings.push('contains EMF/WMF pictures (often old equations) that may not display — check the original');
    const md = `# ${name}\n\n_Markdown version of the ${LABEL[k.kind]} **${name}** (${res.count} ${res.unit}), extracted by Moodle Scraper. `
      + `The original file is kept next to this one; layout is not reproduced — for pictures, equations or diagrams see `
      + `${o.pictures ? `\`${o.mediaDir}/\` or ` : ''}the original._\n\n${res.body.trim()}\n`;
    return { md, images: media.images, warnings, kind: k.kind, count: res.count };
  }

  window.Office2Md = { kindOf, convert, _internals: { omml, mathText, parseXml, resolvePath, shiftFormula } };
})();
