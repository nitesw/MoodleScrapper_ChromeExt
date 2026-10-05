// Moodle Course Scraper — content script (injected on demand by popup.js).
// Runs entirely inside the moodle.vinci.be tab so it survives the popup closing.
// GET requests only. See guard() below.
(() => {
  if (window.__moodleScraper) return; // re-injection guard: keep existing state/listener
  window.__moodleScraper = true;

  /* =========================================================================
   * SELECTORS — every DOM selector lives here. Fix things here first.
   * Values are CSS selector lists. NOTE: querySelector returns the first match in
 * DOCUMENT ORDER (ancestors before descendants), not the first selector in the list.
   * ========================================================================= */
  const SELECTORS = {
    // Course page: main content container (we never look outside it, so the
    // left course index drawer and right block drawer are ignored).
    main: '#region-main, .course-content',
    // Things that look like sections but must be ignored (course index uses data-for="section" too).
    ignore: '#courseindex, .courseindex, .drawer, [data-region="blocks-column"], [data-region="drawer"]',
    // A section (top-level or a mod_subsection "delegated" section).
    section: 'li.section, [data-for="section"]',
    // Section title, inside the section.
    // Tried IN THIS ORDER (first that matches wins). Hidden "Select section", "Collapse/Expand"
    // texts, buttons and labels inside it are stripped.
    sectionTitle: ['.sectionname', 'h3, h4', '[data-for="section_title"]'],
    // Section summary/description.
    sectionSummary: '.summarytext, .section_summary, [data-for="sectionsummary"]',
    // The activity list inside a section (used to detect "content missing → fetch section.php").
    cmList: '[data-for="cmlist"], ul.section',
    // One activity (course module).
    activity: 'li.activity, [data-for="cmitem"]',
    // Activity title (hidden ".accesshide" type suffix is stripped).
    activityName: '.instancename, .activityname',
    // Main link of the activity on the course page.
    activityLink: 'a.aalink, .activityname a, .activity-instance a, a[href*="/mod/"]',
    // Description / label content shown on the course page.
    activityDesc: '.activity-altcontent, .contentafterlink, .description',
    // Completion info ("À faire", "Terminé", "Marquer comme terminé"...).
    completion: '[data-region="completionrequirements"], [data-region="completion-info"], .completion-info, .activity-completion',
    // Activity dates block ("Ouvert : ...", "Fermé : ..."), on course page and activity pages.
    dates: '[data-region="activity-dates"], .activity-dates',
    // Access restrictions text.
    restrictions: '.availabilityinfo, [data-region="availabilityinfo"]',

    // ---- Activity pages (fetched) ----
    breadcrumbItem: '#page-navbar .breadcrumb-item, ol.breadcrumb li',
    pageMain: '#region-main [role="main"], #region-main, [role="main"]',
    intro: '.activity-description, #intro',
    pageContent: '.box.generalbox.center, .box.generalbox, .no-overflow', // mod_page body (activity header removed first)
    activityHeader: '.activity-header, .activity-description, [data-region="activity-information"]',
    lessonMenu: '.block_fake .menuwrapper, .menuwrapper, .lessonmenu, [data-block="lesson_menu"], .block_lesson_menu',
    lessonExport: 'a[href*="lessonexport"], a[href*="export"][href*="lesson"]',
    lessonContent: '.box.contents, .contents',
    folderFiles: '.foldertree a[href*="pluginfile.php"], #folder_tree0 a[href*="pluginfile.php"], .fp-filename-icon a[href*="pluginfile.php"]',
    quizInfo: '.quizinfo p, .box.quizinfo p, .quizinfo',
    quizAttempts: 'table.quizattemptsummary, .quizattemptsummary table',
    quizFeedback: '#feedback, .quizgradefeedback',
    quizAttemptBox: '.quizattempt',
    assignStatus: '.submissionstatustable table, table.submissionsummarytable, .submissionsummarytable table',
    assignAttachments: '[data-region="intro-attachments"] a[href*="pluginfile.php"], .intro-attachments a[href*="pluginfile.php"]',
    urlLink: '.urlworkaround a[href], .resourceworkaround a[href]',
    forumDiscussionLink: 'a[href*="/mod/forum/discuss.php?d="]',
    forumPost: '[data-region="post"], .forumpost',
    forumPostSubject: '[data-region-content="forum-post-core-subject"], .subject, h3, h4',
    forumPostMeta: 'header .mb-3, .author, time',
    forumPostContent: '.post-content-container, [data-region-content="forum-post-core-content"], .posting, .content',
    bookChapter: '.book_chapter',
  };

  /* LABELS — French/English UI label patterns (tested against "Label : value" lines). */
  const LABELS = {
    opens: /^(ouvert|ouvre|ouverture|disponible|accessible|début|ouvert le|opened|opens|open|available|allow submissions from)/i,
    closes: /^(fermé|ferme|fermeture|closed|closes|close)/i,
    due: /^(à remettre|a remettre|échéance|date d'échéance|à rendre|date de remise|remise|due|deadline)/i,
    cutoff: /^(date limite|dernier délai|cut-off|cutoff)/i,
    attempts: /^(tentatives autorisées|nombre de tentatives autorisées|attempts allowed)/i,
    gradeToPass: /^(note pour passer|note de passage|note minimale|grade to pass)/i,
    timeLimit: /^(temps disponible|limite de temps|durée|time limit)/i,
    submissionStatus: /^(statut des travaux remis|statut de remise|submission status)/i,
    gradingStatus: /^(statut de l'évaluation|statut d'évaluation|grading status)/i,
    timeRemaining: /^(temps restant|time remaining)/i,
    todo: /(à faire|a faire|to do|marquer comme terminé|mark as done)/i,
    done: /(terminé|fait|done|completed|réussi|passed)/i,
  };

  const ORIGIN = 'https://moodle.vinci.be';
  const FORBIDDEN = /startattempt|attempt\.php|processattempt|continue\.php|sesskey=|logout\.php/i;
  const MAX_CONCURRENCY = 3;
  const TEST = window.__MOODLE_SCRAPER_TEST__; // set only by the bun test harness
  const DELAY_MS = TEST && TEST.delayMs != null ? TEST.delayMs : 300;
  const SIZE_WARN_BYTES = 200 * 1024 * 1024;
  const FORUM_MAX = 10;
  // Video/audio files (e.g. .mp4 in a folder) are listed with their link instead of downloaded,
  // unless the user ticks "Download video files" / "Download audio files" in the popup.
  const DEFAULT_OPTIONS = { downloadVideo: false, downloadAudio: false };
  let options = { ...DEFAULT_OPTIONS };
  const LOG = '[MoodleScraper]';

  /* ========================================================================= state */
  let state, zip, fileCount, fileCache, dirNames, activities, sectionsList, courseCmids, aborted, abortReason, guardLogged, totalBytes;

  function reset() {
    state = { running: false, finished: false, done: 0, total: 0, message: '', errors: [], warnings: [], sizeWarning: '' };
    zip = null; fileCount = 0; fileCache = new Map(); dirNames = new Map(); activities = []; sectionsList = [];
    courseCmids = new Set(); aborted = false; abortReason = ''; guardLogged = new Set(); totalBytes = 0;
  }
  reset();

  const snapshot = () => JSON.parse(JSON.stringify(state));
  let emitTimer = null;
  function emit(now) {
    const send = () => { emitTimer = null; chrome.runtime.sendMessage({ type: 'moodle-scraper-progress', state: snapshot() }).catch(() => {}); };
    if (now) { clearTimeout(emitTimer); send(); } else if (!emitTimer) emitTimer = setTimeout(send, 120);
  }
  function setMsg(m) { state.message = m; emit(); }
  function fail(ctx, err, url) {
    if (err instanceof GuardError) return; // already listed as a warning by guard()
    const msg = `${ctx}: ${err && err.message ? err.message : err}${url ? ` (${url})` : ''}`;
    console.error(LOG, msg, err);
    state.errors.push(msg); emit();
  }
  function warn(msg) { console.warn(LOG, msg); state.warnings.push(msg); emit(); }

  class AbortRun extends Error {}
  class GuardError extends Error {}

  /* ========================================================================= network */
  // Refuses anything that could start/submit an attempt, mutate state, or leave Moodle.
  function guard(url) {
    let u;
    try { u = new URL(url); } catch (_) { throw new GuardError(`invalid URL ${url}`); }
    if (u.origin !== ORIGIN || FORBIDDEN.test(u.href)) {
      if (!guardLogged.has(u.href)) {
        guardLogged.add(u.href);
        warn(`BLOCKED by GET guard (not requested): ${u.href}`);
      }
      throw new GuardError(`blocked by safety guard: ${u.href}`);
    }
  }
  const isForbidden = (url) => { try { const u = new URL(url); return u.origin !== ORIGIN || FORBIDDEN.test(u.href); } catch (_) { return true; } };

  // Throttle: max 3 in flight, request starts spaced by >= 300 ms.
  let active = 0, nextSlot = 0;
  const waiters = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function acquire() {
    while (active >= MAX_CONCURRENCY) {
      await new Promise((r) => waiters.push(r));
      if (aborted) throw new AbortRun(abortReason);
    }
    if (aborted) throw new AbortRun(abortReason);
    active++;
    // Spacing is measured from when requests ACTUALLY start (a late timer can't shrink the gap).
    while (Date.now() < nextSlot) await sleep(nextSlot - Date.now());
    nextSlot = Date.now() + DELAY_MS;
  }
  function release() { active--; const w = waiters.shift(); if (w) w(); }

  function abort(reason) { aborted = true; abortReason = reason; throw new AbortRun(reason); }

  // Cancel button: stop scheduling work, abort in-flight requests, wake queued ones so they exit.
  let controller = null;
  function cancelRun() {
    if (!state.running || aborted) return;
    aborted = true;
    abortReason = 'Cancelled.';
    state.cancelled = true;
    if (controller) controller.abort();
    while (waiters.length) waiters.shift()();
    setMsg('Cancelling…');
  }
  const rethrowIfCancelled = (e) => { if (aborted) throw new AbortRun(abortReason); throw e; };

  // The ONLY place that calls fetch(). Always GET.
  async function fetchRaw(url, { skipMedia = false } = {}) { // skipMedia: honour the video/audio options
    if (aborted) throw new AbortRun(abortReason);
    guard(url);
    await acquire();
    try {
      if (aborted) throw new AbortRun(abortReason);
      const res = await fetch(url, { method: 'GET', credentials: 'include', redirect: 'follow', cache: 'no-store', signal: controller && controller.signal })
        .catch(rethrowIfCancelled);
      const finalUrl = res.url || url;
      if (/\/login\/index\.php/.test(finalUrl)) abort('Session expired or not logged in — log in to Moodle again and retry.');
      guard(finalUrl); // re-check after redirects
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const disposition = res.headers.get('content-disposition') || '';
      const kind = skipMedia && skippedMediaKind(type);
      if (kind) {
        try { if (res.body) res.body.cancel(); } catch (_) { /* ignore */ } // stop the transfer
        return { url: finalUrl, type, disposition, blob: null, media: kind };
      }
      return { url: finalUrl, type, disposition, blob: await res.blob().catch(rethrowIfCancelled) };
    } finally { release(); }
  }
  const isHtmlResp = (r) => r.type.includes('text/html') && !/\/pluginfile\.php\//.test(r.url);
  const parseHtml = (text) => new DOMParser().parseFromString(text, 'text/html');

  async function getDoc(url) {
    const r = await fetchRaw(url);
    if (!r.type.includes('text/html')) throw new Error(`expected an HTML page, got ${r.type || 'unknown type'}`);
    return { doc: parseHtml(await r.blob.text()), url: r.url };
  }

  /* ========================================================================= URL helpers */
  function absUrl(x, base) {
    if (!x) return null;
    x = x.trim();
    if (/^(javascript|mailto|tel|data):/i.test(x) || x.startsWith('#')) return null;
    try { return new URL(x, base).href; } catch (_) { return null; }
  }
  function setParam(u, k, v) { const x = new URL(u); x.searchParams.set(k, v); return x.href; }
  const modView = (type, cmid) => `${ORIGIN}/mod/${type}/view.php?id=${cmid}`;
  const isPluginfile = (u) => !!u && u.startsWith(ORIGIN) && /\/pluginfile\.php\//.test(u);
  const isVideoUrl = (u) => /\.(mp4|webm|m4v|mov|avi|mkv|ogv|wmv|flv)(\?|$)/i.test(u || '');
  const isAudioUrl = (u) => /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac|wma)(\?|$)/i.test(u || '');
  // 'video' | 'audio' when this kind of media must NOT be downloaded (per the popup options), else null.
  function skippedMediaKind(urlOrType) {
    const v = isVideoUrl(urlOrType) || /^video\//.test(urlOrType);
    const a = isAudioUrl(urlOrType) || /^audio\//.test(urlOrType);
    if (v && !options.downloadVideo) return 'video';
    if (a && !options.downloadAudio) return 'audio';
    return null;
  }
  const cmidFromUrl = (u) => { try { return new URL(u).searchParams.get('id'); } catch (_) { return null; } };
  function normUrl(u) {
    try {
      const x = new URL(u);
      x.hash = '';
      if (/\/mod\/resource\/view\.php$/.test(x.pathname)) return 'resource:' + x.searchParams.get('id');
      x.searchParams.delete('forcedownload');
      x.searchParams.delete('redirect');
      return x.href;
    } catch (_) { return u; }
  }
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /* ========================================================================= file naming */
  function sanitize(s, max = 80) {
    let n = (s || '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ').trim()
      .replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
    if (n.length > max) {
      const m = n.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
      const ext = m[2] || '';
      n = m[1].slice(0, max - ext.length).trim() + ext;
    }
    return n || 'untitled';
  }
  function fixMojibake(n) {
    if (/[ÃÂ][\u0080-¿]/.test(n)) { try { return decodeURIComponent(escape(n)); } catch (_) { /* keep */ } }
    return n;
  }
  function filenameFromDisposition(cd) {
    if (!cd) return null;
    let m = cd.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
    if (m) { try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch (_) { /* fallthrough */ } }
    m = cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
    if (m) {
      let n = m[1].trim();
      try { n = decodeURIComponent(n); } catch (_) { /* keep raw */ }
      return fixMojibake(n);
    }
    return null;
  }
  function nameFromUrl(u) {
    try {
      const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(seg);
    } catch (_) { return ''; }
  }
  const EXT_BY_TYPE = {
    'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'application/zip': 'zip', 'text/plain': 'txt', 'text/html': 'html',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/msword': 'doc', 'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.ms-excel': 'xls',
  };
  function filenameFor(r) {
    let n = filenameFromDisposition(r.disposition) || nameFromUrl(r.url) || 'file';
    if (!/\.[A-Za-z0-9]{1,8}$/.test(n)) {
      const ext = EXT_BY_TYPE[r.type.split(';')[0].trim()];
      if (ext) n += '.' + ext;
    }
    return sanitize(n, 120);
  }
  // Keeps ZIP paths extractable everywhere: Windows Explorer chokes on paths > 260 chars
  // (and the user's own extraction folder adds to that), so long trees get shorter folder names.
  const MAX_DIR_LEN = 150;
  // Parents are shortened based on the parents alone, so every activity of a section lands in
  // the SAME section folder; only then is the activity (leaf) folder shortened to fit.
  function zipDir(parts) {
    const parents = parts.slice(0, -1);
    let leaf = parts[parts.length - 1];
    let head = parents;
    for (let max = 40; ['files', ...head].join('/').length > MAX_DIR_LEN - 30 && max >= 12; max -= 7) {
      head = parents.map((p) => sanitize(p, max));
    }
    const prefix = ['files', ...head].join('/');
    if (leaf == null) return prefix;
    const room = MAX_DIR_LEN - prefix.length - 1;
    if (leaf.length > room) leaf = sanitize(leaf, Math.max(12, room));
    return `${prefix}/${leaf}`;
  }
  function uniqueName(dir, name) {
    let set = dirNames.get(dir);
    if (!set) dirNames.set(dir, (set = new Set()));
    const m = name.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
    let candidate = name, i = 2;
    while (set.has(candidate.toLowerCase())) candidate = `${m[1]} (${i++})${m[2] || ''}`;
    set.add(candidate.toLowerCase());
    return candidate;
  }

  /* ========================================================================= downloads */
  // Finds the real file link on an HTML resource wrapper page.
  function findFileLink(doc, base) {
    const main = mainOf(doc);
    const notIntro = (e) => !e.closest(SELECTORS.activityHeader);
    const el = main.querySelector('.resourceworkaround a[href*="pluginfile.php"]')
      || main.querySelector('object[data*="pluginfile.php"], iframe[src*="pluginfile.php"], embed[src*="pluginfile.php"]')
      || [...main.querySelectorAll('a[href*="pluginfile.php"], img[src*="pluginfile.php"]')].find(notIntro);
    if (!el) return null;
    return absUrl(el.getAttribute('href') || el.getAttribute('data') || el.getAttribute('src'), base);
  }

  async function fetchFile(url) {
    const u = /\/mod\/resource\/view\.php/.test(url) ? setParam(url, 'redirect', '1') : url;
    const opts = { skipMedia: true };
    const r = await fetchRaw(u, opts);
    if (r.media || !isHtmlResp(r)) return r;
    const doc = parseHtml(await r.blob.text());
    const cand = findFileLink(doc, r.url);
    if (!cand) throw new Error('got an HTML page and found no pluginfile.php link in it');
    const r2 = await fetchRaw(cand, opts);
    if (!r2.media && isHtmlResp(r2)) throw new Error('expected a file, got an HTML page');
    return r2;
  }

  // Downloads url into files/<dirParts>/, deduped by URL.
  // Resolves to {name, path}, or {name, url, media: 'video'|'audio'} for a skipped media file, or null on failure.
  function addFile(dirParts, url, hint) {
    const key = normUrl(url);
    if (fileCache.has(key)) return fileCache.get(key);
    const guess = hint || nameFromUrl(url) || url;
    const skipKind = skippedMediaKind(url);
    if (skipKind) { // known by extension: don't even request it
      const p = Promise.resolve({ name: sanitize(nameFromUrl(url) || guess, 120), url: url.replace(/[?&]forcedownload=1/, ''), media: skipKind });
      fileCache.set(key, p);
      return p;
    }
    const p = (async () => {
      state.total++;
      setMsg(`Downloading ${state.done + 1}/${state.total}: ${guess}`);
      try {
        const r = await fetchFile(url);
        if (r.media) return { name: filenameFor(r), url: r.url, media: r.media };
        const dir = zipDir(dirParts);
        const name = uniqueName(dir, filenameFor(r));
        const path = `${dir}/${name}`;
        zip.file(path, r.blob, { binary: true, compression: 'STORE' });
        totalBytes += r.blob.size;
        fileCount++;
        const k2 = normUrl(r.url);
        if (!fileCache.has(k2)) fileCache.set(k2, p);
        return { name, path };
      } catch (e) {
        if (e instanceof AbortRun) throw e;
        fail(`Download "${guess}"`, e, url);
        return null;
      } finally {
        state.done++;
        emit();
      }
    })();
    fileCache.set(key, p);
    return p;
  }

  // Converts an HTML fragment to Markdown, first downloading any pluginfile.php
  // files/images (and mod/resource links) it references so links point into the ZIP.
  async function mdWithAssets(el, base, dirParts, minHeading) {
    if (!el) return { md: '', files: [] };
    const urls = new Set();
    for (const n of el.querySelectorAll('a[href], img[src], video[src], audio[src], source[src]')) {
      const u = absUrl(n.getAttribute(n.tagName === 'A' ? 'href' : 'src'), base);
      if (!u) continue;
      const player = n.closest('video, audio');
      if (player) { // an embedded player's own file: only when that media kind is wanted
        const wanted = player.tagName === 'AUDIO' ? options.downloadAudio : options.downloadVideo;
        if (wanted && n.tagName !== 'A' && isPluginfile(u)) urls.add(u);
        continue;
      }
      if ((isPluginfile(u) && !skippedMediaKind(u)) || (u.startsWith(ORIGIN) && /\/mod\/resource\/view\.php/.test(u))) urls.add(u);
    }
    const map = new Map();
    const files = [];
    await Promise.all([...urls].map(async (u) => {
      const f = await addFile(dirParts, u);
      if (f) { if (f.path) map.set(normUrl(u), f.path); files.push(f); }
    }));
    return { md: htmlToMd(el, base, { map, minHeading }), files };
  }

  /* ========================================================================= HTML → Markdown */
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'nav', 'button', 'input', 'select', 'textarea', 'svg', 'template', 'head', 'link', 'meta', 'option']);
  const SKIP_SEL = '.accesshide, .sr-only, .visually-hidden, img.icon, i.icon, [hidden]';
  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'figure', 'figcaption', 'center', 'aside', 'address', 'dl', 'dt', 'dd', 'details', 'summary', 'fieldset', 'legend', 'form', 'label']);
  const INLINE_TAGS = new Set(['span', 'font', 'strong', 'b', 'em', 'i', 'u', 'a', 'mark', 'small', 'big']);
  const VIDEO_HOST = /youtube\.com|youtu\.be|vimeo\.com|kaltura|dailymotion|panopto|ms-stream|stream\.microsoft|\.mp4|\.webm|\.m4v|\.mov/i;
  const IND = '\u0001'; // non-collapsible space (indentation / <pre>)
  const NL = '\u0002';  // non-collapsible newline (<pre>)

  function isRedColor(c) {
    c = (c || '').trim().toLowerCase();
    if (!c) return false;
    if (/^(red|darkred|crimson|firebrick|maroon|tomato|orangered)$/.test(c)) return true;
    let rgb = null, m;
    if ((m = c.match(/^#([0-9a-f]{3})\b/))) rgb = m[1].split('').map((h) => parseInt(h + h, 16));
    else if ((m = c.match(/^#([0-9a-f]{6})/))) rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    else if ((m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/))) rgb = [m[1], m[2], m[3]].map(Number);
    return !!rgb && rgb[0] >= 150 && rgb[1] <= 90 && rgb[2] <= 90;
  }
  function isRedEl(el) {
    if (el.classList && el.classList.contains('text-danger')) return true;
    const style = el.getAttribute('style') || '';
    const m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    return isRedColor(el.getAttribute('color') || (m && m[1]));
  }
  function isWarningBlock(el) {
    const text = clean(el.textContent);
    if (!text) return false;
    if (isRedEl(el)) return true;
    if (el.querySelector('p, div, ul, ol, table, h1, h2, h3, h4, h5, h6')) return false; // leaf blocks only
    if (/^erratum\b/i.test(text)) return true;
    let red = 0;
    for (const d of el.querySelectorAll('[style*="color"], font[color], .text-danger')) {
      if (!isRedEl(d)) continue;
      let p = d.parentElement, nested = false;
      while (p && p !== el) { if (isRedEl(p)) { nested = true; break; } p = p.parentElement; }
      if (!nested) red += clean(d.textContent).length;
    }
    return red >= 0.6 * text.length;
  }
  function mediaUrl(el, base) {
    for (const attr of ['data-setup-lazy', 'data-setup']) {
      const j = el.getAttribute(attr);
      if (j) { try { const o = JSON.parse(j); const s = o.sources && o.sources[0] && o.sources[0].src; if (s) return absUrl(s, base); } catch (_) { /* ignore */ } }
    }
    const src = el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('data-src');
    if (src) return absUrl(src, base);
    const s = el.querySelector('source[src]');
    if (s) return absUrl(s.getAttribute('src'), base);
    const a = el.querySelector('a[href]');
    return a ? absUrl(a.getAttribute('href'), base) : null;
  }
  const mdLink = (href) => (/\s/.test(href) ? `<${href}>` : href);

  function htmlToMd(root, base, opts = {}) {
    // The fragment's highest heading (e.g. <h3>) is mapped to minHeading; deeper ones follow.
    const hs = root.querySelectorAll ? [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1])) : [];
    const top = hs.length ? Math.min(...hs) : 1;
    const ctx = { base, map: opts.map || new Map(), minH: (opts.minHeading || 3) - (top - 1), warn: false };
    return finalizeMd(conv(root, ctx));
  }
  function finalizeMd(s) {
    return s.replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(new RegExp(IND, 'g'), ' ')
      .replace(new RegExp(NL, 'g'), '\n')
      .trim();
  }
  function convKids(el, ctx) { let s = ''; for (const c of el.childNodes) s += conv(c, ctx); return s; }
  function wrapInline(s, mark) {
    if (!s.trim()) return s;
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
    return `${lead}${mark}${s.trim()}${mark}${trail}`;
  }
  function mapUrl(u, ctx) { return ctx.map.get(normUrl(u)) || u; }

  function conv(node, ctx) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || el.matches(SKIP_SEL)) return '';

    // Embedded media → one line, never downloaded.
    if (['iframe', 'video', 'audio', 'embed', 'object', 'frame'].includes(tag)) {
      const u = mediaUrl(el, ctx.base);
      if (!u) return '';
      const isVideo = tag === 'video' || VIDEO_HOST.test(u) || el.closest('.mediaplugin');
      const shown = mapUrl(u, ctx);
      return `\n\n${isVideo ? '🎥 Video' : tag === 'audio' ? '🔊 Audio' : '🧩 Embedded'}: ${shown}\n\n`;
    }

    // Coloured warning text.
    if (!ctx.warn) {
      if (BLOCK_TAGS.has(tag) && tag !== 'label' && isWarningBlock(el)) {
        const inner = finalizeMd(convKids(el, { ...ctx, warn: true }));
        if (!inner) return '';
        return '\n\n' + inner.split('\n').map((l, i) => (i === 0 ? `> ⚠️ ${l}` : l ? `> ${l}` : '>')).join('\n') + '\n\n';
      }
      if (INLINE_TAGS.has(tag) && isRedEl(el)) {
        const inner = conv(el, { ...ctx, warn: true });
        return inner.trim() ? ` ⚠️ ${wrapInline(inner, '**').trim()} ` : inner;
      }
    }

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = clean(convKids(el, ctx)).replace(/\*\*/g, ''); // headings are already bold
        if (!text) return '';
        const level = ctx.minH + Number(tag[1]) - 1;
        return level > 6 ? `\n\n**${text}**\n\n` : `\n\n${'#'.repeat(level)} ${text}\n\n`;
      }
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': return wrapInline(convKids(el, ctx), '**');
      case 'em': case 'i': case 'cite': return wrapInline(convKids(el, ctx), '*');
      case 'del': case 's': case 'strike': return wrapInline(convKids(el, ctx), '~~');
      case 'sup': return '^' + convKids(el, ctx);
      case 'code': case 'kbd': case 'samp':
        return el.closest('pre') ? el.textContent : '`' + el.textContent.replace(/`/g, "'") + '`';
      case 'pre': {
        const t = el.textContent.replace(/\r/g, '').replace(/\n$/, '');
        return `\n\n\`\`\`${NL}${t.replace(/ /g, IND).replace(/\n/g, NL)}${NL}\`\`\`\n\n`;
      }
      case 'a': {
        const href = absUrl(el.getAttribute('href'), ctx.base);
        const text = clean(convKids(el, ctx));
        if (!href) return text ? ` ${text} ` : '';
        const target = mapUrl(href, ctx);
        return ` [${(text || nameFromUrl(target) || target).replace(/[[\]]/g, '')}](${mdLink(target)}) `;
      }
      case 'img': {
        const raw = el.getAttribute('src') || '';
        const alt = clean(el.getAttribute('alt') || el.getAttribute('title') || '').replace(/[[\]]/g, '');
        if (/^data:/i.test(raw)) return alt ? ` [image: ${alt}] ` : '';
        const src = absUrl(raw, ctx.base);
        return src ? ` ![${alt}](${mdLink(mapUrl(src, ctx))}) ` : '';
      }
      case 'ul': case 'ol': return list(el, ctx, tag === 'ol');
      case 'blockquote': {
        const inner = finalizeMd(convKids(el, ctx));
        if (!inner) return '';
        return '\n\n' + inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n\n';
      }
      case 'table': return table(el, ctx);
      case 'li': return `\n- ${convKids(el, ctx).trim()}\n`;
      default:
        if (BLOCK_TAGS.has(tag)) return `\n\n${convKids(el, ctx)}\n\n`;
        return convKids(el, ctx);
    }
  }

  function list(el, ctx, ordered) {
    let i = Number(el.getAttribute('start')) || 1;
    const out = [];
    for (const child of el.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') { // malformed nesting directly in list
        const nested = list(child, ctx, tag === 'ol').trim().split('\n').map((l) => IND.repeat(3) + l).join('\n');
        if (out.length) out[out.length - 1] += '\n' + nested; else out.push(nested);
        continue;
      }
      if (tag !== 'li') continue;
      const marker = ordered ? `${i++}.` : '-';
      const body = convKids(child, ctx).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').replace(/^\s+|\s+$/g, '');
      const indent = IND.repeat(marker.length + 1);
      const lines = body.split('\n');
      out.push(`${marker} ${lines[0]}` + lines.slice(1).map((l) => (l ? `\n${indent}${l}` : '')).join(''));
    }
    return out.length ? `\n\n${out.join('\n')}\n\n` : '';
  }

  function table(el, ctx) {
    const rows = [...el.querySelectorAll('tr')].filter((r) => r.closest('table') === el);
    const data = rows
      .map((r) => [...r.children].filter((c) => /^(TD|TH)$/.test(c.tagName))
        .map((c) => finalizeMd(convKids(c, ctx)).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|')))
      .filter((r) => r.some((c) => c));
    if (!data.length) return '';
    const cols = Math.max(...data.map((r) => r.length));
    const pad = (r) => { const x = r.slice(); while (x.length < cols) x.push(''); return x; };
    const lines = [`| ${pad(data[0]).join(' | ')} |`, `| ${Array(cols).fill('---').join(' | ')} |`];
    for (const r of data.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
    return `\n\n${lines.join('\n')}\n\n`;
  }

  /* ========================================================================= dates & meta */
  const MONTHS = {
    janvier: 0, janv: 0, jan: 0, january: 0, février: 1, fevrier: 1, févr: 1, fevr: 1, fév: 1, fev: 1, feb: 1, february: 1,
    mars: 2, mar: 2, march: 2, avril: 3, avr: 3, apr: 3, april: 3, mai: 4, may: 4, juin: 5, jun: 5, june: 5,
    juillet: 6, juil: 6, jul: 6, july: 6, août: 7, aout: 7, aug: 7, august: 7, septembre: 8, sept: 8, sep: 8, september: 8,
    octobre: 9, oct: 9, october: 9, novembre: 10, nov: 10, november: 10, décembre: 11, decembre: 11, déc: 11, dec: 11, december: 11,
  };
  function hm(h, mi, ampm) {
    let H = h != null ? Number(h) : 23;
    const M = mi != null ? Number(mi) : 59;
    if (ampm === 'pm' && H < 12) H += 12;
    if (ampm === 'am' && H === 12) H = 0;
    return [H, M];
  }
  // Best-effort FR/EN date parser. Returns Date or null.
  function parseDate(s) {
    if (!s) return null;
    const t = s.toLowerCase().replace(/ /g, ' ');
    let m = t.match(/(\d{1,2})(?:er)?\s+([a-zéèêûôîç]+)\.?\s+(\d{4})(?:[^\d]{1,6}(\d{1,2})\s*[:h]\s*(\d{2})\s*(am|pm)?)?/);
    if (m && m[2] in MONTHS) { const [H, M] = hm(m[4], m[5], m[6]); return new Date(+m[3], MONTHS[m[2]], +m[1], H, M); }
    m = t.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:[^\d]{1,6}(\d{1,2}):(\d{2})\s*(am|pm)?)?/);
    if (m && m[1] in MONTHS) { const [H, M] = hm(m[4], m[5], m[6]); return new Date(+m[3], MONTHS[m[1]], +m[2], H, M); }
    m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[^\d]{1,6}(\d{1,2})[:h](\d{2}))?/);
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; const [H, M] = hm(m[4], m[5]); return new Date(y, +m[2] - 1, +m[1], H, M); }
    return null;
  }

  // Feeds a "Label : value" line (or a [label, value] pair) into act.meta.
  function applyMeta(act, label, value) {
    label = clean(label); value = clean(value);
    if (!label || !value) return;
    for (const key of ['cutoff', 'due', 'closes', 'opens', 'attempts', 'gradeToPass', 'timeLimit', 'submissionStatus', 'gradingStatus', 'timeRemaining']) {
      if (LABELS[key].test(label)) { if (!act.meta[key]) act.meta[key] = value; return; }
    }
  }
  function applyMetaLine(act, line) {
    const m = clean(line).match(/^([^:]{2,60}?)\s*:\s*(.+)$/);
    if (m) applyMeta(act, m[1], m[2]);
  }
  function addDates(act, root) {
    const box = root && root.querySelector(SELECTORS.dates);
    if (!box) return;
    const kids = [...box.children];
    const lines = kids.length ? kids.map((k) => clean(k.textContent)) : box.textContent.split('\n').map(clean);
    for (const l of lines) if (l && !act.dates.includes(l)) { act.dates.push(l); applyMetaLine(act, l); }
  }
  function completionStatus(text) {
    if (!text) return '';
    if (/marquer comme terminé|mark as done/i.test(text)) return 'To do';
    if (LABELS.todo.test(text)) return 'To do';
    if (LABELS.done.test(text)) return 'Done';
    return '';
  }
  function deadlineStatus(meta, now) {
    const raw = meta.opens || meta.closes || meta.due || meta.cutoff;
    if (!raw) return 'no dates';
    const o = parseDate(meta.opens);
    const c = parseDate(meta.closes || meta.due);
    const cut = parseDate(meta.cutoff);
    if (c && c < now && cut && cut > now) return 'overdue (cut-off later)';
    const end = c || cut;
    if (end && end < now) return 'closed';
    if (o && o > now) return 'upcoming';
    if (end || o) return 'open';
    return '?';
  }

  /* ========================================================================= course tree */
  const mainOf = (doc) => doc.querySelector(SELECTORS.pageMain) || doc.body || doc;
  // Elements matching sel whose nearest enclosing section is `root` (prevents double-counting nested subsections).
  const own = (root, sel) => [...root.querySelectorAll(sel)].filter((e) => e.parentElement && e.parentElement.closest(SELECTORS.section) === root);
  function topSections(doc) {
    const main = doc.querySelector(SELECTORS.main) || doc.body;
    return [...main.querySelectorAll(SELECTORS.section)].filter((s) => !s.closest(SELECTORS.ignore) && !(s.parentElement && s.parentElement.closest(SELECTORS.section)));
  }

  const HIDDEN_UI = '.sr-only, .visually-hidden, .accesshide, button, input, label, [role="button"], .bulkselect, .icons-collapse-expand';
  function visibleText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(HIDDEN_UI).forEach((x) => x.remove());
    return clean(c.textContent);
  }
  function sectionTitleOf(secEl) {
    for (const sel of SELECTORS.sectionTitle) {
      for (const el of own(secEl, sel)) {
        if (el.closest(SELECTORS.activity) && !secEl.closest(SELECTORS.activity)) continue; // an activity's heading
        const t = visibleText(el);
        if (t) return t;
      }
    }
    return '';
  }

  function parseActivity(el, base) {
    const typeMatch = el.className.match(/\bmodtype_(\w+)/);
    const linkEl = el.querySelector(SELECTORS.activityLink);
    const url = linkEl ? absUrl(linkEl.getAttribute('href'), base) : null;
    const type = typeMatch ? typeMatch[1] : ((url || '').match(/\/mod\/(\w+)\//) || [])[1] || 'unknown';
    const cmid = el.getAttribute('data-id') || (el.id.match(/module-(\d+)/) || [])[1] || (url && cmidFromUrl(url)) || null;

    let title = '';
    const named = el.querySelector('[data-activityname]');
    if (named) title = clean(named.getAttribute('data-activityname'));
    if (!title) {
      const n = el.querySelector(SELECTORS.activityName);
      if (n) title = visibleText(n);
    }
    const descEl = el.querySelector(SELECTORS.activityDesc);
    if (!title) title = clean(descEl ? descEl.textContent : el.textContent).slice(0, 60) || `${type} ${cmid || ''}`.trim();

    const compEl = el.querySelector(SELECTORS.completion);
    const completionRaw = compEl ? clean(compEl.textContent).slice(0, 200) : '';
    const restrEl = el.querySelector(SELECTORS.restrictions);

    const act = {
      el, base, cmid, type, title, url,
      descEl,
      completionRaw, completion: completionStatus(completionRaw),
      restrictions: restrEl ? clean(restrEl.textContent) : '',
      dates: [], meta: {}, infoLines: [], blocks: [], files: [],
      breadcrumb: '', introMd: '', descMd: '', externalUrl: '',
    };
    addDates(act, el);
    return act;
  }

  async function fetchSectionEl(url, sectionId) {
    const { doc, url: final } = await getDoc(url);
    const byId = sectionId && doc.querySelector(`[data-for="section"][data-id="${sectionId}"]`);
    return { el: byId || topSections(doc)[0] || null, base: final };
  }

  async function parseSection(secEl, base, depth, parentPath, parentTitles, opts = {}) {
    const id = secEl.getAttribute('data-id');
    const title = sectionTitleOf(secEl) || opts.fallbackTitle || `Section ${secEl.getAttribute('data-number') || ''}`.trim();

    // Content missing (e.g. one-section-per-page layout) → fetch course/section.php?id=…
    if (!opts.fetched && id && !own(secEl, SELECTORS.cmList).length && !own(secEl, SELECTORS.activity).length) {
      try {
        const got = await fetchSectionEl(`${ORIGIN}/course/section.php?id=${id}`, id);
        if (got.el) return parseSection(got.el, got.base, depth, parentPath, parentTitles, { fetched: true, fallbackTitle: title });
      } catch (e) { if (e instanceof AbortRun) throw e; fail(`Section "${title}"`, e); }
    }

    const level = Math.min(6, 2 + depth);
    const node = {
      kind: 'section', id, title, depth, level,
      path: [...parentPath, sanitize(title)], titles: [...parentTitles, title],
      summaryEl: own(secEl, SELECTORS.sectionSummary)[0] || null, summaryMd: '', base, items: [],
    };
    sectionsList.push(node);

    for (const el of own(secEl, SELECTORS.activity)) {
      const act = parseActivity(el, base);
      if (act.cmid && courseCmids.has(act.cmid)) continue;
      if (act.cmid) courseCmids.add(act.cmid);

      if (act.type === 'subsection') {
        setMsg(`Reading subsection: ${act.title}`);
        let sub = el.querySelector(SELECTORS.section), subBase = base;
        if (!sub && act.url) {
          try { const got = await fetchSectionEl(act.url, null); sub = got.el; subBase = got.base; } catch (e) { if (e instanceof AbortRun) throw e; fail(`Subsection "${act.title}"`, e, act.url); }
        }
        if (sub) node.items.push(await parseSection(sub, subBase, depth + 1, node.path, node.titles, { fallbackTitle: act.title }));
        else node.items.push({ kind: 'note', text: `> ❌ Subsection "${act.title}" could not be read.` });
        continue;
      }

      act.section = node;
      act.level = Math.min(6, level + 1);
      act.dirParts = [...node.path, sanitize(act.title)];
      node.items.push(act);
      activities.push(act);
    }
    return node;
  }

  /* ========================================================================= activity handlers */
  function pageCommon(act, doc) {
    const crumbs = [...doc.querySelectorAll(SELECTORS.breadcrumbItem)].map((li) => clean(li.textContent)).filter(Boolean);
    if (crumbs.length) {
      act.breadcrumb = crumbs.join(' / ');
      const low = act.breadcrumb.toLowerCase();
      const t = act.section.titles[act.section.titles.length - 1] || '';
      act.breadcrumbMismatch = !!t && !low.includes(t.toLowerCase());
    }
    addDates(act, doc);
    if (!act.completionRaw) {
      const c = doc.querySelector(SELECTORS.completion);
      if (c) { act.completionRaw = clean(c.textContent).slice(0, 200); act.completion = completionStatus(act.completionRaw); }
    }
    return mainOf(doc);
  }
  async function intro(act, main, base) {
    const el = main.querySelector(SELECTORS.intro);
    if (!el) return;
    const r = await mdWithAssets(el, base, act.dirParts, act.level + 1);
    act.introMd = r.md; act.files.push(...r.files);
  }
  const fileKey = (f) => f.path || f.url;
  function pushFile(act, f) { if (f && !act.files.some((x) => fileKey(x) === fileKey(f))) act.files.push(f); }
  const fileLink = (f) => (f.media ? `${f.media === 'audio' ? '🔊' : '🎥'} ${f.name} (not downloaded): ${f.url}` : `[${f.name}](${mdLink(f.path)})`);

  const HANDLERS = {
    async resource(act) {
      pushFile(act, await addFile(act.dirParts, modView('resource', act.cmid), act.title));
    },

    async folder(act) {
      const { doc, url } = await getDoc(modView('folder', act.cmid));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      let links = [...main.querySelectorAll(SELECTORS.folderFiles)];
      if (!links.length) links = [...main.querySelectorAll('a[href*="pluginfile.php"][href*="mod_folder"]')];
      if (!links.length) links = [...act.el.querySelectorAll('a[href*="pluginfile.php"]')]; // folder shown inline on course page
      const urls = [...new Set(links.map((a) => absUrl(a.getAttribute('href'), url)).filter(Boolean))];
      if (!urls.length) act.infoLines.push('Folder is empty (or files not found — check SELECTORS.folderFiles).');
      const got = await Promise.all(urls.map((u) => {
        const m = decodeURIComponent(new URL(u).pathname).match(/\/mod_folder\/content\/\d+\/(.*)\/[^/]+$/);
        const sub = m ? m[1].split('/').filter(Boolean).map((p) => sanitize(p)) : [];
        return addFile([...act.dirParts, ...sub], u);
      }));
      got.forEach((f) => pushFile(act, f));
    },

    async label(act) {
      const r = await mdWithAssets(act.descEl, act.base, act.dirParts, act.level);
      act.descMd = r.md; r.files.forEach((f) => pushFile(act, f));
    },

    async page(act) {
      const { doc, url } = await getDoc(modView('page', act.cmid));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      main.querySelectorAll(SELECTORS.activityHeader).forEach((x) => x.remove()); // intro already captured
      const content = main.querySelector('.box.generalbox.center') || main.querySelector(SELECTORS.pageContent) || main;
      const r = await mdWithAssets(content, url, act.dirParts, act.level + 1);
      if (r.md) act.blocks.push(r.md);
      r.files.forEach((f) => pushFile(act, f));
    },

    async url(act) {
      const { doc, url } = await getDoc(setParam(modView('url', act.cmid), 'forceview', '1'));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      const a = main.querySelector(SELECTORS.urlLink);
      let ext = a && absUrl(a.getAttribute('href'), url);
      if (!ext) {
        const f = doc.querySelector('frame[src], iframe[src], object[data]');
        ext = f && absUrl(f.getAttribute('src') || f.getAttribute('data'), url);
      }
      if (!ext) {
        const any = [...main.querySelectorAll('a[href]')].map((x) => absUrl(x.getAttribute('href'), url)).find((u) => u && !u.startsWith(ORIGIN));
        ext = any || null;
      }
      act.externalUrl = ext || '(could not determine — open the Moodle link)';
    },

    async lesson(act) {
      const { doc, url } = await getDoc(modView('lesson', act.cmid));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      if (act.meta.cutoff && !act.meta.closes) act.meta.closes = act.meta.cutoff; // lesson "Date limite" = deadline

      const menu = doc.querySelector(SELECTORS.lessonMenu);
      const outline = [], pages = [];
      if (menu) {
        for (const li of menu.querySelectorAll('li')) {
          const t = clean(li.textContent);
          if (!t) continue;
          outline.push(t);
          const a = li.querySelector('a[href*="pageid="]');
          if (a) pages.push({ title: t, url: absUrl(a.getAttribute('href'), url) });
          else pages.push({ title: t, url: null, current: true });
        }
        act.blocks.push('**Lesson outline (Lesson menu):**\n\n' + outline.map((t, i) => (/^\d+[.)]/.test(t) ? `- ${t}` : `${i + 1}. ${t}`)).join('\n'));
      } else {
        act.infoLines.push('Lesson menu not found (check SELECTORS.lessonMenu).');
        pages.push({ title: act.title, url: null, current: true });
      }

      const exportLinks = [...doc.querySelectorAll(SELECTORS.lessonExport)].map((a) => absUrl(a.getAttribute('href'), url)).filter(Boolean);
      const pdf = exportLinks.find((u) => /pdf/i.test(u)) || exportLinks[0];
      let gotPdf = false;
      if (pdf && isForbidden(pdf)) {
        warn(`Lesson "${act.title}": export link refused by the GET guard (${pdf}) — falling back to Lesson menu pages.`);
      } else if (pdf) {
        const f = await addFile(act.dirParts, pdf, `${act.title}.pdf`);
        if (f) { pushFile(act, f); gotPdf = true; act.infoLines.push(`Exported PDF: ${f.name}`); }
      } else {
        act.infoLines.push('No "Export as PDF" link found — content pages converted from the Lesson menu instead.');
      }
      if (gotPdf) return;

      // Fallback: GET only the pages listed in the Lesson menu. Never "Suivante", never submit.
      const h = Math.min(6, act.level + 1);
      for (const p of pages) {
        try {
          let d = doc, base = url;
          if (!p.current) {
            ({ doc: d, url: base } = await getDoc(p.url)); // guard() inside refuses anything unsafe
          }
          const m = mainOf(d);
          const content = m.querySelector(SELECTORS.lessonContent) || m;
          const r = await mdWithAssets(content, base, act.dirParts, h + 1);
          act.blocks.push(`${'#'.repeat(h)} ${p.title}\n\n${r.md || '_(empty page)_'}`);
          r.files.forEach((f) => pushFile(act, f));
        } catch (e) {
          if (e instanceof AbortRun) throw e;
          fail(`Lesson "${act.title}" page "${p.title}"`, e, p.url);
        }
      }
    },

    async quiz(act) {
      // ONLY view.php. Never startattempt/attempt/processattempt (guard enforces this too).
      const { doc, url } = await getDoc(modView('quiz', act.cmid));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      const seen = new Set();
      for (const p of main.querySelectorAll(SELECTORS.quizInfo)) {
        if (p.querySelector('p')) continue; // container; its <p> children are handled
        const t = clean(p.textContent);
        if (t && !seen.has(t)) { seen.add(t); act.infoLines.push(t); applyMetaLine(act, t); }
      }
      const table = main.querySelector(SELECTORS.quizAttempts);
      if (table) act.blocks.push('**Your attempts:**\n\n' + htmlToMd(table, url));
      const fb = main.querySelector(SELECTORS.quizFeedback);
      if (fb && clean(fb.textContent)) act.infoLines.push('Feedback: ' + clean(fb.textContent));
      const box = main.querySelector(SELECTORS.quizAttemptBox);
      const boxText = box && clean(htmlToMd(box, url));
      if (boxText) act.infoLines.push('Attempt status: ' + boxText);
    },

    async assign(act) {
      const { doc, url } = await getDoc(modView('assign', act.cmid));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      const att = await Promise.all([...main.querySelectorAll(SELECTORS.assignAttachments)]
        .map((a) => absUrl(a.getAttribute('href'), url)).filter(Boolean).map((u) => addFile(act.dirParts, u)));
      att.forEach((f) => pushFile(act, f));
      const table = main.querySelector(SELECTORS.assignStatus);
      if (table) {
        for (const tr of table.querySelectorAll('tr')) {
          const cells = [...tr.children];
          if (cells.length >= 2) applyMeta(act, cells[0].textContent, cells[1].textContent);
        }
        act.blocks.push('**Submission status:**\n\n' + htmlToMd(table, url));
      }
    },

    async forum(act) {
      const { doc, url } = await getDoc(modView('forum', act.cmid));
      const main = pageCommon(act, doc);
      await intro(act, main, url);
      const ids = new Map();
      for (const a of main.querySelectorAll(SELECTORS.forumDiscussionLink)) {
        const u = absUrl(a.getAttribute('href'), url);
        if (!u) continue;
        const d = new URL(u).searchParams.get('d');
        if (d && !ids.has(d)) ids.set(d, { url: `${ORIGIN}/mod/forum/discuss.php?d=${d}`, title: clean(a.textContent) });
        if (ids.size >= FORUM_MAX) break;
      }
      if (!ids.size) { act.infoLines.push('No discussions found.'); return; }
      const h = Math.min(6, act.level + 1);
      const parts = [`**${ids.size} most recent discussions:**`];
      for (const disc of ids.values()) {
        try {
          const { doc: d, url: base } = await getDoc(disc.url);
          const post = d.querySelector(SELECTORS.forumPost);
          if (!post) { parts.push(`${'#'.repeat(h)} ${disc.title}\n\n_(first post not found)_ — ${disc.url}`); continue; }
          const subj = clean((post.querySelector(SELECTORS.forumPostSubject) || {}).textContent) || disc.title;
          const meta = clean((post.querySelector(SELECTORS.forumPostMeta) || {}).textContent);
          const content = post.querySelector(SELECTORS.forumPostContent) || post;
          const dir = [...act.dirParts, sanitize(subj, 60)];
          const r = await mdWithAssets(content, base, dir, h + 1);
          r.files.forEach((f) => pushFile(act, f));
          const attach = await Promise.all([...post.querySelectorAll('a[href*="pluginfile.php"]')]
            .filter((a) => !content.contains(a)).map((a) => absUrl(a.getAttribute('href'), base)).filter(Boolean)
            .map((u) => addFile(dir, u)));
          attach.forEach((f) => pushFile(act, f));
          parts.push(`${'#'.repeat(h)} ${subj}\n\n_${meta || ''}_ — ${disc.url}\n\n${r.md}`);
        } catch (e) {
          if (e instanceof AbortRun) throw e;
          fail(`Forum "${act.title}" discussion "${disc.title}"`, e, disc.url);
        }
      }
      act.blocks.push(parts.join('\n\n'));
    },

    async book(act) {
      // Whole book in one GET via the print tool; falls back to view.php.
      let doc, url, nodes;
      try {
        ({ doc, url } = await getDoc(`${ORIGIN}/mod/book/tool/print/index.php?id=${act.cmid}`));
        nodes = [...doc.querySelectorAll(SELECTORS.bookChapter)];
        if (!nodes.length) nodes = [doc.body];
      } catch (e) {
        if (e instanceof AbortRun) throw e;
        ({ doc, url } = await getDoc(modView('book', act.cmid)));
        pageCommon(act, doc);
        nodes = [mainOf(doc)];
        act.infoLines.push('Print view unavailable — only the first chapter was captured.');
      }
      for (const n of nodes) {
        const r = await mdWithAssets(n, url, act.dirParts, act.level + 1);
        if (r.md) act.blocks.push(r.md);
        r.files.forEach((f) => pushFile(act, f));
      }
    },

    async default() { /* title, type, link and course-page description only */ },
  };

  async function processActivity(act) {
    state.message = `Processing ${state.done + 1}/${state.total}: ${act.title}`;
    emit();
    try {
      if (act.type !== 'label' && act.descEl) {
        const r = await mdWithAssets(act.descEl, act.base, act.dirParts, act.level + 1);
        act.descMd = r.md; r.files.forEach((f) => pushFile(act, f));
      }
      if (act.cmid || act.type === 'label') await (HANDLERS[act.type] || HANDLERS.default)(act);
    } catch (e) {
      if (e instanceof AbortRun) throw e;
      fail(`${act.title} (${act.type})`, e, act.url);
      act.blocks.push(`> ❌ Scrape failed: ${e.message}`);
    } finally {
      state.done++;
      emit();
    }
  }

  // allSettled (not all): on cancel every worker must have stopped before run() reports "stopped".
  async function pool(items, n, fn) {
    let i = 0;
    const results = await Promise.allSettled(Array.from({ length: n }, async () => {
      while (i < items.length && !aborted) await fn(items[i++]);
    }));
    if (aborted) throw new AbortRun(abortReason);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /* ========================================================================= course.md */
  const ICON = { resource: '📄', folder: '📁', page: '📃', url: '🔗', quiz: '📝', assign: '📌', lesson: '🎓', forum: '💬', book: '📘' };
  const cell = (s) => clean(s).replace(/\|/g, '\\|') || '—';

  function renderActivity(act, out) {
    if (act.type === 'label') {
      if (act.descMd) out.push(act.descMd);
      if (act.files.length) out.push(act.files.map((f) => `- 📎 ${fileLink(f)}`).join('\n'));
      return;
    }
    out.push(`${'#'.repeat(act.level)} ${ICON[act.type] || '▫️'} ${act.title}`);
    const b = [`- Type: \`${act.type}\`${act.url ? ` · Link: ${act.url}` : ''}`];
    if (act.breadcrumb) b.push(`- Breadcrumb: ${act.breadcrumb}${act.breadcrumbMismatch ? ' ⚠️ (differs from course-page placement)' : ''}`);
    if (act.completionRaw) b.push(`- Completion: ${act.completion ? `**${act.completion}** — ` : ''}${act.completionRaw}`);
    if (act.dates.length) b.push(`- Dates: ${act.dates.join(' · ')}`);
    if (act.restrictions) b.push(`- Restrictions: ${act.restrictions}`);
    if (act.externalUrl) b.push(`- External URL: ${act.externalUrl}`);
    for (const l of act.infoLines) b.push(`- ${l}`);
    if (act.files.length) b.push('- Files:\n' + act.files.map((f) => `  - ${fileLink(f)}`).join('\n'));
    out.push(b.join('\n'));
    const text = act.introMd || act.descMd;
    if (text) out.push(text);
    out.push(...act.blocks.filter(Boolean));
  }

  function renderSection(node, out) {
    out.push(`${'#'.repeat(node.level)} ${node.title}`);
    if (node.summaryMd) out.push(node.summaryMd);
    for (const it of node.items) {
      if (it.kind === 'section') renderSection(it, out);
      else if (it.kind === 'note') out.push(it.text);
      else renderActivity(it, out);
    }
  }

  function buildMarkdown(course, tree, now) {
    const out = [`# ${course.title}`, [
      `- URL: ${course.url}`,
      `- Scraped: ${now.toISOString()} (local: ${now.toLocaleString('fr-BE')})`,
      `- Activities: ${activities.length} · Files: ${fileCount}`,
      `- Media files downloaded: video ${options.downloadVideo ? 'yes' : 'no (links listed)'} · audio ${options.downloadAudio ? 'yes' : 'no (links listed)'}`,
    ].join('\n')];

    const DEADLINE_TYPES = new Set(['quiz', 'assign', 'lesson']);
    const rows = activities.filter((a) => DEADLINE_TYPES.has(a.type) || a.meta.due || a.meta.closes || a.meta.cutoff);
    const key = (a) => { const d = parseDate(a.meta.closes || a.meta.due || a.meta.cutoff); return d ? d.getTime() : Infinity; };
    rows.sort((x, y) => key(x) - key(y));
    out.push('## Deadlines & evaluations');
    if (rows.length) {
      const t = ['| Activity | Type | Section | Opens | Due / Closes | Cut-off | Attempts | Grade to pass | Completion | Status |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
      for (const a of rows) {
        const m = a.meta;
        t.push(`| ${cell(a.title)} | ${a.type} | ${cell(a.section.titles.join(' › '))} | ${cell(m.opens)} | ${cell(m.closes || m.due)} | ${cell(m.cutoff !== (m.closes || m.due) ? m.cutoff : '')} | ${cell(m.attempts)} | ${cell(m.gradeToPass)} | ${cell(a.completion)} | ${deadlineStatus(m, now)} |`);
      }
      out.push(t.join('\n'));
      out.push('_Status is computed relative to the scrape date; "?" means the date text could not be parsed (raw text kept)._');
    } else {
      out.push('_No quizzes, assignments or lessons found._');
    }

    for (const s of tree) renderSection(s, out);

    if (state.errors.length || state.warnings.length) {
      out.push('## Scrape errors');
      out.push([...state.errors.map((e) => `- ❌ ${e}`), ...state.warnings.map((w) => `- ⚠️ ${w}`)].join('\n'));
    }
    return out.join('\n\n') + '\n';
  }

  /* ========================================================================= main */
  function courseInfo(doc) {
    const fromBody = (doc.body.className.match(/\bcourse-(\d+)\b/) || [])[1];
    const id = fromBody || (location.pathname.endsWith('/course/view.php') ? new URLSearchParams(location.search).get('id') : null);
    const h1 = doc.querySelector('.page-header-headings h1, #page-header h1, header h1, h1');
    const title = clean(h1 && h1.textContent) || clean(doc.title.split('|')[0].replace(/^(Cours|Course)\s*:\s*/i, '')) || `course-${id}`;
    return { id, title, url: `${ORIGIN}/course/view.php?id=${id}` };
  }

  async function run(opts) {
    reset();
    options = { ...DEFAULT_OPTIONS, ...(opts || {}) };
    state.options = options;
    controller = new AbortController();
    pendingZip = null;
    removeSaveButton();
    state.running = true;
    state.message = 'Reading course page…';
    emit(true);
    try {
      if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded (lib/jszip.min.js missing?)');
      zip = new JSZip();
      const now = new Date();

      // 1. Course page (live DOM if we're on view.php, otherwise fetch it).
      let doc = document, base = location.href;
      let course = courseInfo(document);
      if (!course.id) throw new Error('Could not determine the course id from this page.');
      if (!location.pathname.endsWith('/course/view.php')) {
        ({ doc, url: base } = await getDoc(course.url));
        course = { ...courseInfo(doc), id: course.id, url: course.url };
      }

      // 2. Section tree (fetches section.php / subsection pages only when content is missing).
      const tops = topSections(doc);
      if (!tops.length) throw new Error('No sections found — check SELECTORS.main / SELECTORS.section.');
      const tree = [];
      for (const s of tops) tree.push(await parseSection(s, base, 0, [], []));

      // 3. Activities: files/folders first (so labels/pages dedupe against them), then the rest.
      state.total = activities.length;
      emit(true);
      const first = activities.filter((a) => a.type === 'resource' || a.type === 'folder');
      const rest = activities.filter((a) => !first.includes(a));
      await pool(first, MAX_CONCURRENCY, processActivity);
      await pool(rest, MAX_CONCURRENCY, processActivity);
      await Promise.all(sectionsList.filter((s) => s.summaryEl).map(async (s) => {
        try {
          s.summaryMd = (await mdWithAssets(s.summaryEl, s.base, s.path, s.level + 1)).md;
        } catch (e) { if (e instanceof AbortRun) throw e; fail(`Section summary "${s.title}"`, e); }
      }));

      // 4. course.md + ZIP.
      zip.file('course.md', buildMarkdown(course, tree, now), { compression: 'DEFLATE' });
      let lastPct = -1;
      const blob = await zip.generateAsync({ type: 'blob', streamFiles: true }, (meta) => {
        const pct = Math.floor(meta.percent);
        if (pct !== lastPct) { lastPct = pct; setMsg(`Building ZIP… ${pct}%`); }
      });
      if (aborted) throw new AbortRun(abortReason); // cancelled while zipping
      if (blob.size > SIZE_WARN_BYTES) state.sizeWarning = `ZIP is ${(blob.size / 1048576).toFixed(0)} MB (> 200 MB). It was still built — saving may take a moment.`;

      // 5. Hand the ZIP to the user: they pick the folder/filename via the page's Save button.
      pendingZip = { blob, name: sanitize(course.title, 150) + '.zip' };
      state.zipName = pendingZip.name;
      state.zipSize = blob.size;
      state.readyToSave = true;
      state.message = `ZIP ready: ${pendingZip.name} (${(blob.size / 1048576).toFixed(1)} MB, ${activities.length} activities, ${state.errors.length} error(s)). ` +
        'Click “💾 Save ZIP…” on the Moodle page to choose where to save it.';
      showSaveButton();
    } catch (e) {
      console.error(LOG, e);
      if (state.cancelled) state.message = 'Cancelled — scraping stopped, nothing was saved.';
      else state.message = e instanceof AbortRun ? `Aborted: ${e.message}` : `Failed: ${e.message}`;
      if (!(e instanceof AbortRun)) state.errors.push(String(e && e.message || e));
    } finally {
      // Let aborted requests settle so a new run can't be disturbed by leftovers of this one.
      while (active > 0) await sleep(20);
      await sleep(0);
      zip = null;
      state.running = false;
      state.finished = true;
      emit(true);
    }
  }

  /* ========================================================================= saving the ZIP */
  // Chrome only opens a native "Save as" dialog on a real user click IN THE PAGE (the popup
  // closes as soon as a dialog opens), so we show a floating button on the Moodle page.
  let pendingZip = null;
  const SAVE_HOST_ID = 'moodle-scraper-save';

  function showSaveButton() {
    removeSaveButton();
    const host = document.createElement('div');
    host.id = SAVE_HOST_ID;
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box{font:13px/1.4 system-ui,sans-serif;background:#fff;color:#222;border:1px solid #ccc;border-radius:8px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:320px}
      button{font:600 14px system-ui,sans-serif;padding:8px 12px;border:0;border-radius:6px;cursor:pointer}
      .save{background:#0f6cbf;color:#fff}.close{background:transparent;color:#666;margin-left:6px}
      .name{margin:0 0 8px;word-break:break-word}</style>
      <div class="box"><p class="name"></p><button class="save">💾 Save ZIP…</button><button class="close" title="Discard">✕</button></div>`;
    root.querySelector('.name').textContent = `${pendingZip.name} (${(pendingZip.blob.size / 1048576).toFixed(1)} MB)`;
    root.querySelector('.save').addEventListener('click', () => { saveZip(); });
    root.querySelector('.close').addEventListener('click', () => {
      pendingZip = null; state.readyToSave = false; setMsg('ZIP discarded.'); removeSaveButton();
    });
    document.body.appendChild(host);
  }
  function removeSaveButton() { const h = document.getElementById(SAVE_HOST_ID); if (h) h.remove(); }

  // Saves the pending ZIP. Uses the File System Access save dialog (user picks folder + name;
  // Chrome reopens it in the last folder used). Falls back to a normal download if unavailable.
  async function saveZip() {
    if (!pendingZip) return;
    const { blob, name } = pendingZip;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          id: 'moodle-scraper', // remembers the last chosen directory
          startIn: 'downloads',
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return saved(handle.name);
      } catch (e) {
        if (e && e.name === 'AbortError') { setMsg('Save cancelled — click “💾 Save ZIP…” again when ready.'); return; }
        warn(`Save dialog failed (${e && e.message}); falling back to a normal download.`);
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    saved(`${name} (browser Downloads folder)`);
  }
  function saved(where) {
    pendingZip = null;
    state.readyToSave = false;
    state.savedAs = where;
    setMsg(`Saved: ${where}`);
    removeSaveButton();
  }

  // Test hook for `bun test` — only active when the test harness sets the flag. Inert in Chrome.
  if (TEST) {
    window.__moodleScraperInternals = {
      htmlToMd, parseDate, sanitize, zipDir, filenameFromDisposition, guard, isForbidden, deadlineStatus,
      completionStatus, normUrl, uniqueName, topSections, SELECTORS, LABELS, getState: snapshot,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'start' && !state.running) run(msg.options);
    if (msg.cmd === 'cancel') cancelRun();
    sendResponse(snapshot());
  });
})();
