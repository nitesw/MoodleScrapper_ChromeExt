// Vinci Schedule exporter — content script for horaire.vinci.be (CELCAT Calendar), injected on demand by popup.js.
// Runs inside the schedule tab so it survives the popup closing.
// Network: POST only, and only to the two read-only CELCAT endpoints in ENDPOINTS (see post()).
(() => {
  if (window.__vinciSchedule) return; // re-injection guard: keep existing state/listener
  window.__vinciSchedule = true;

  /* =========================================================================
   * SELECTORS — the CELCAT page elements we read. Fix things here first.
   * ========================================================================= */
  const SELECTORS = {
    resourceType: '#resourceTypeSelectList', // <select> Modules/Staff/Rooms/Groups/…
    resources: '#resourceSelectList',        // multi <select> (select2) with the chosen groups/modules
    calendar: '#calendar',                   // FullCalendar root
    activeView: '.fc-state-active',          // the pressed month/week/day/list button
    viewDates: '.fc-view [data-date]',       // cells/headers of the rendered view
    token: 'input[name="__RequestVerificationToken"]',
  };
  // CELCAT resource types (value of #resourceTypeSelectList) ↔ the `et=` URL parameter.
  const RES_TYPES = { module: 100, staff: 101, room: 102, group: 103, student: 104, team: 105, equipment: 106, course: 107 };
  const RES_TYPE_NAMES = { 100: 'Modules', 101: 'Staff', 102: 'Rooms', 103: 'Groups', 104: 'Students', 105: 'Teams', 106: 'Equipment', 107: 'Courses' };
  // The ONLY paths post() accepts. Both are read-only queries the CELCAT page itself makes.
  const ENDPOINTS = { calendar: '/Home/GetCalendarData', event: '/Home/GetSideBarEvent' };

  const MAX_CONCURRENCY = 3;
  const TEST = window.__SCHEDULE_SCRAPER_TEST__; // set only by the bun test harness
  const DELAY_MS = TEST && TEST.delayMs != null ? TEST.delayMs : 300;
  const CHUNK_DAYS = 183; // GetCalendarData is asked at most ~6 months at a time
  const TZID = 'Europe/Brussels';
  const LOG = '[VinciSchedule]';

  // Fields the user can keep. `ics` says where the field goes in an .ics event.
  const FIELDS = [
    { key: 'code', label: 'Module code', def: true },
    { key: 'subject', label: 'Course', def: true },
    { key: 'name', label: 'Event name', def: true },
    { key: 'groups', label: 'Groups', def: true },
    { key: 'rooms', label: 'Room', def: true, ics: 'LOCATION' },
    { key: 'staff', label: 'Staff', def: true },
    { key: 'category', label: 'Category', def: true, ics: 'CATEGORIES' },
    { key: 'links', label: 'Web link (Teams)', def: true, ics: 'URL' },
    { key: 'notes', label: 'Notes', def: true },
    { key: 'department', label: 'Department', def: false },
    { key: 'sites', label: 'Site', def: false },
    { key: 'extra', label: 'Other details', def: false },
    { key: 'color', label: 'Colour', def: false, ics: 'COLOR' },
  ];
  const TITLE_TEMPLATES = {
    subject: { label: 'Course name', example: 'Math 1 : théorie' },
    'code-subject': { label: 'Code + course', example: 'BINV1090-A-a Math 1 : théorie' },
    raw: { label: 'As on CELCAT', example: 'BINV1090-A-a [Math 1 : théorie]' },
  };
  const FORMATS = {
    ics: { label: '.ics (iCalendar)', ext: 'ics', mime: 'text/calendar' },
    gcsv: { label: 'Google Calendar CSV', ext: 'google.csv', mime: 'text/csv' },
    md: { label: 'Markdown (AI)', ext: 'md', mime: 'text/markdown' },
    json: { label: 'JSON', ext: 'json', mime: 'application/json' },
    csv: { label: 'CSV', ext: 'csv', mime: 'text/csv' },
  };
  const DEFAULT_PREFS = {
    title: 'subject',
    fields: Object.fromEntries(FIELDS.map((f) => [f.key, f.def])),
  };
  const PREFS_KEY = 'vinciScheduleExportPrefs';

  /* ========================================================================= state */
  let state, events, run_, aborted, abortReason;

  function reset() {
    state = { running: false, finished: false, done: 0, total: 0, message: '', errors: [], warnings: [] };
    events = []; run_ = null; aborted = false; abortReason = '';
  }
  reset();

  const snapshot = () => JSON.parse(JSON.stringify(state));
  let emitTimer = null;
  function emit(now) {
    const send = () => { emitTimer = null; chrome.runtime.sendMessage({ type: 'schedule-scraper-progress', state: snapshot() }).catch(() => {}); };
    if (now) { clearTimeout(emitTimer); send(); } else if (!emitTimer) emitTimer = setTimeout(send, 120);
  }
  function setMsg(m) { state.message = m; emit(); }
  function warn(msg) { console.warn(LOG, msg); state.warnings.push(msg); emit(); }

  class AbortRun extends Error {}

  /* ========================================================================= network */
  // Throttle: max 3 in flight, request starts spaced by >= 300 ms (same rule as the Moodle scraper).
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
    while (Date.now() < nextSlot) await sleep(nextSlot - Date.now());
    nextSlot = Date.now() + DELAY_MS;
  }
  function release() { active--; const w = waiters.shift(); if (w) w(); }
  function abort(reason) { aborted = true; abortReason = reason; throw new AbortRun(reason); }

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

  // The ONLY place that calls fetch(). POST to an allow-listed CELCAT read endpoint, nothing else.
  async function post(path, params) {
    if (!Object.values(ENDPOINTS).includes(path)) throw new Error(`refused: ${path} is not an allowed endpoint`);
    if (aborted) throw new AbortRun(abortReason);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const x of v) body.append(`${k}[]`, x);
      else if (v != null) body.append(k, v);
    }
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' };
    const tok = document.querySelector(SELECTORS.token);
    if (tok && tok.value) headers.RequestVerificationToken = tok.value;
    await acquire();
    try {
      if (aborted) throw new AbortRun(abortReason);
      const res = await fetch(location.origin + path, {
        method: 'POST', credentials: 'include', redirect: 'follow', cache: 'no-store', headers, body: body.toString(),
        signal: controller && controller.signal,
      }).catch(rethrowIfCancelled);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (/\/login/i.test(res.url || '') || res.status === 401 || res.status === 403 || (res.ok && !type.includes('json'))) {
        abort('Session expired or not allowed — log in on horaire.vinci.be (Log In, top-right) and retry.');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text().catch(rethrowIfCancelled);
      return text ? JSON.parse(text) : null;
    } finally { release(); }
  }

  async function pool(items, n, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { if (aborted) throw new AbortRun(abortReason); const x = items[i++]; await fn(x); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  /* ========================================================================= selection */
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };

  // What the user has on screen. The live page wins over the URL (select2 changes may not touch the URL).
  function readSelection() {
    const url = new URL(location.href);
    const p = url.searchParams;
    let resType = null, typeName = '', resources = [];
    const typeSel = document.querySelector(SELECTORS.resourceType);
    const resSel = document.querySelector(SELECTORS.resources);
    if (resSel) {
      resources = [...resSel.options].filter((o) => o.selected && o.value)
        .map((o) => ({ id: o.value, name: (o.textContent || '').trim() || o.value }));
    }
    if (resources.length && typeSel && typeSel.value) {
      resType = Number(typeSel.value);
      typeName = (typeSel.selectedOptions[0] && typeSel.selectedOptions[0].textContent.trim()) || '';
    }
    if (!resources.length) { // fallback: the URL (cal?et=group&fid0=1BIN5&fid1=…)
      for (let i = 0; p.has(`fid${i}`); i++) { const id = p.get(`fid${i}`); if (id) resources.push({ id, name: id }); }
      resType = RES_TYPES[(p.get('et') || '').toLowerCase()] || null;
    }
    if (resType && !typeName) typeName = RES_TYPE_NAMES[resType] || '';

    let view = p.get('vt') || '';
    const btn = document.querySelector(`${SELECTORS.calendar} ${SELECTORS.activeView}`);
    const m = btn && btn.className.match(/fc-(\w+)-button/);
    if (m) view = m[1];
    const dates = [...document.querySelectorAll(`${SELECTORS.calendar} ${SELECTORS.viewDates}`)]
      .map((el) => el.getAttribute('data-date')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort();
    const viewRange = dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
    return { resType, typeName, resources, view, date: p.get('dt') || '', viewRange };
  }

  /* ========================================================================= parsing */
  const decode = (s) => {
    if (s == null) return '';
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${s}`, 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const hrefsIn = (s) => {
    if (!s) return [];
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${s}`, 'text/html');
    const hrefs = [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    if (!hrefs.length && /^https?:\/\/\S+$/.test(String(s).trim())) hrefs.push(String(s).trim());
    return hrefs.filter((h) => /^https?:\/\//i.test(h));
  };
  const uniq = (a) => [...new Set(a.filter(Boolean))];

  // "BINV1090-A-a [Math 1 : théorie]\r\n\r\n<br />\r\n\r\n1BIN5<br />1BIN6\r\n\r\n<br />\r\n\r\nCH43 Aud A"
  // Blocks: title / [name] / groups / rooms. All-day events have a single block (their name).
  function parseDescription(desc) {
    const blocks = String(desc || '').trim().split(/\r?\n\s*<br\s*\/?>\s*\r?\n/)
      .map((b) => b.split(/<br\s*\/?>/i).map(decode).filter(Boolean));
    const out = { rawTitle: (blocks[0] && blocks[0][0]) || '', name: '', groups: [], rooms: [] };
    if (blocks.length === 1) out.name = blocks[0].slice(1).join(' ');
    else if (blocks.length === 2) out.groups = blocks[1];
    else {
      out.rooms = blocks[blocks.length - 1];
      out.groups = blocks[blocks.length - 2];
      out.name = blocks.slice(1, -2).flat().join(' — ');
    }
    return out;
  }

  // "BINV1090-A-a [Math 1 : théorie]" → { code: 'BINV1090-A-a', subject: 'Math 1 : théorie' }
  function splitTitle(raw) {
    const m = String(raw || '').match(/^(\S+)\s*\[(.+)\]\s*$/);
    return m ? { code: m[1], subject: m[2].trim() } : { code: '', subject: String(raw || '').trim() };
  }

  // GetSideBarEvent → { label: [values] }; continuation rows (label null) belong to the previous label.
  function sidebarFields(sb) {
    const out = { modules: [], name: [], groups: [], rooms: [], staff: [], notes: [], links: [], extra: {} };
    let last = null;
    for (const el of (sb && sb.elements) || []) {
      const label = el.label != null ? String(el.label).trim() : last;
      last = label;
      const content = el.content;
      if (content == null || content === '') continue;
      const lab = (label || '').toLowerCase();
      const t = el.entityType;
      if (el.containsHyperlinks || /lien|link|web|url/.test(lab)) { out.links.push(...hrefsIn(content)); continue; }
      const text = decode(content);
      if (!text) continue;
      if (/^date/.test(lab)) continue;
      if (t === 100 || /^modul/.test(lab)) out.modules.push(text);
      else if (t === 101 || /staff|enseignant|teacher|prof|personnel/.test(lab)) out.staff.push(text);
      else if (t === 102 || /room|salle|local/.test(lab)) out.rooms.push(text);
      else if (t === 103 || /group/.test(lab)) out.groups.push(text);
      else if (el.isNotes || /^note|remarque/.test(lab)) out.notes.push(text);
      else if (/^(name|nom)/.test(lab)) out.name.push(text);
      else (out.extra[label || 'Info'] = out.extra[label || 'Info'] || []).push(text);
    }
    return out;
  }

  // One CELCAT event (+ optional sidebar details) → the export model.
  function normalize(raw, sb) {
    const d = parseDescription(raw.description);
    const s = sb ? sidebarFields(sb) : null;
    const rawTitle = (s && s.modules[0]) || d.rawTitle;
    const { code, subject } = splitTitle(rawTitle);
    const allDay = !!raw.allDay;
    const start = allDay ? String(raw.start).slice(0, 10) : String(raw.start).slice(0, 19);
    let end = raw.end ? (allDay ? String(raw.end).slice(0, 10) : String(raw.end).slice(0, 19)) : null;
    if (allDay && (!end || end <= start)) end = addDays(start, 1); // all-day end is exclusive
    if (!allDay && !end) end = start;
    const pick = (fromSb, fromDesc) => (s && fromSb.length ? uniq(fromSb) : uniq(fromDesc));
    const links = uniq([...(s ? s.links : []), ...[raw.custom1, raw.custom2, raw.custom3].filter((x) => /^https?:\/\//i.test(x || ''))]);
    return {
      uid: String(raw.id),
      start, end, allDay,
      rawTitle,
      code: code || (raw.modules && raw.modules[0]) || '',
      subject,
      name: (s && s.name.length ? s.name.join(' — ') : d.name) || '',
      groups: pick(s ? s.groups : [], d.groups),
      rooms: pick(s ? s.rooms : [], d.rooms),
      staff: s ? uniq(s.staff) : [],
      category: raw.eventCategory || '',
      department: raw.department || '',
      sites: uniq(raw.sites || []),
      notes: s ? s.notes.join('\n') : '',
      links,
      extra: s ? Object.entries(s.extra).map(([k, v]) => `${k}: ${v.join(', ')}`) : [],
      color: raw.backgroundColor || '',
    };
  }

  /* ========================================================================= export */
  function titleOf(e, tpl) {
    if (tpl === 'raw') return e.rawTitle || e.subject || e.name;
    if (tpl === 'code-subject') return [e.code, e.subject].filter(Boolean).join(' ') || e.rawTitle || e.name;
    return e.subject || e.name || e.rawTitle;
  }
  const valueText = (v) => (Array.isArray(v) ? v.join(', ') : String(v || ''));
  const selected = (prefs) => FIELDS.filter((f) => prefs.fields[f.key]);
  // "Label: value" lines for the event description (fields not shown elsewhere are still listed).
  function detailLines(e, prefs, skip = []) {
    return selected(prefs).filter((f) => f.key !== 'color' && !skip.includes(f.key) && valueText(e[f.key]))
      .map((f) => (f.key === 'extra' ? e.extra.join('\n') : `${f.label}: ${valueText(e[f.key])}`));
  }

  // --- iCalendar (RFC 5545)
  const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const enc = new TextEncoder();
  // Lines longer than 75 octets are folded (CRLF + space), never splitting a UTF-8 character.
  function foldLine(line) {
    const out = [];
    let cur = '', bytes = 0, limit = 75;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  const icsLocal = (s) => s.replace(/[-:]/g, '').slice(0, 15); // 2026-10-06T10:30:00 → 20261006T103000
  const icsDate = (s) => s.replace(/-/g, '').slice(0, 8);
  const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const VTIMEZONE = [
    'BEGIN:VTIMEZONE', `TZID:${TZID}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const CSS_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  function vevent(e, prefs, now) {
    const f = prefs.fields;
    const L = ['BEGIN:VEVENT', `UID:${e.uid}@horaire.vinci.be`, `DTSTAMP:${utcStamp(now)}`];
    if (e.allDay) L.push(`DTSTART;VALUE=DATE:${icsDate(e.start)}`, `DTEND;VALUE=DATE:${icsDate(e.end)}`);
    else L.push(`DTSTART;TZID=${TZID}:${icsLocal(e.start)}`, `DTEND;TZID=${TZID}:${icsLocal(e.end)}`);
    L.push(`SUMMARY:${icsEscape(titleOf(e, prefs.title))}`);
    if (f.rooms && e.rooms.length) L.push(`LOCATION:${icsEscape(e.rooms.join(', '))}`);
    const desc = detailLines(e, prefs, ['rooms', 'category']).join('\n'); // own ICS properties
    if (desc) L.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (f.links && e.links.length) L.push(`URL:${e.links[0]}`);
    if (f.category && e.category) L.push(`CATEGORIES:${icsEscape(e.category)}`);
    if (f.color && CSS_COLOR.test(e.color)) L.push(`X-APPLE-CALENDAR-COLOR:${e.color}`);
    L.push(e.allDay ? 'TRANSP:TRANSPARENT' : 'TRANSP:OPAQUE', 'END:VEVENT');
    return L;
  }
  function toICS(evs, prefs, meta, now = new Date()) {
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vinci Scraper//horaire.vinci.be//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEscape(`Vinci – ${meta.label}`)}`, `X-WR-TIMEZONE:${TZID}`, ...VTIMEZONE];
    for (const e of evs) L.push(...vevent(e, prefs, now));
    L.push('END:VCALENDAR');
    return L.map(foldLine).join('\r\n') + '\r\n';
  }

  // --- CSV
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csvRows = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  // Google Calendar's import format: MM/DD/YYYY and 12-hour times.
  const gDate = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
  const gTime = (s) => { let h = Number(s.slice(11, 13)); const m = s.slice(14, 16); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m} ${ap}`; };
  function toGoogleCSV(evs, prefs) {
    const rows = [['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event', 'Description', 'Location', 'Private']];
    for (const e of evs) {
      const endDay = e.allDay ? addDays(e.end, -1) : e.end;
      rows.push([
        titleOf(e, prefs.title), gDate(e.start), e.allDay ? '' : gTime(e.start), gDate(endDay), e.allDay ? '' : gTime(e.end),
        e.allDay ? 'True' : 'False', detailLines(e, prefs, ['rooms']).join('\n'), prefs.fields.rooms ? e.rooms.join(', ') : '', 'True',
      ]);
    }
    return csvRows(rows);
  }
  function toCSV(evs, prefs) {
    const fs = selected(prefs);
    const rows = [['Start', 'End', 'All day', 'Title', ...fs.map((f) => f.label)]];
    for (const e of evs) rows.push([e.start, e.end, e.allDay ? 'yes' : 'no', titleOf(e, prefs.title), ...fs.map((f) => valueText(e[f.key]))]);
    return '\uFEFF' + csvRows(rows); // BOM: Excel then reads the accents as UTF-8
  }

  // --- JSON
  function toJSON(evs, prefs, meta, now = new Date()) {
    const fs = selected(prefs);
    return JSON.stringify({
      source: meta.url, selection: meta.selection, range: meta.range, scrapedAt: now.toISOString(), timezone: TZID,
      events: evs.map((e) => {
        const o = { uid: e.uid, start: e.start, end: e.end, allDay: e.allDay, title: titleOf(e, prefs.title) };
        for (const f of fs) o[f.key] = e[f.key];
        return o;
      }),
    }, null, 2) + '\n';
  }

  // --- Markdown (for AI)
  const DAYS_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const mdCell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const mdRow = (cells) => `| ${cells.join(' | ')} |`;
  function mondayOf(day) { const d = parseDay(day); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); }
  const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  function toMarkdown(evs, prefs, meta, now = new Date()) {
    const cols = selected(prefs).filter((f) => !['code', 'subject', 'color'].includes(f.key));
    const out = [
      `# Horaire — ${meta.label}`, '',
      `Source: ${meta.url}  `, `Période: ${dmy(meta.range.start)} → ${dmy(meta.range.end)}  `,
      `Exporté le: ${now.toLocaleString('fr-BE')} (${evs.length} événements, heure de Bruxelles)`, '',
      '> **Note for the AI:** this is a Haute École Léonard de Vinci timetable exported from CELCAT (horaire.vinci.be).',
      '> Text is in French as on the site. Times are local Brussels time. "Présentiel" = on campus, "Distanciel" = online',
      '> (see the web link), "Autonome" = self-study slot. The schedule can change after the export date.',
    ];
    let week = null, day = null;
    for (const e of evs) {
      const d = e.start.slice(0, 10);
      const wk = mondayOf(d);
      if (wk !== week) { week = wk; day = null; out.push('', `## Semaine du ${dmy(wk)}`); }
      if (d !== day) {
        day = d;
        out.push('', `### ${DAYS_FR[parseDay(d).getDay()]} ${dmy(d)}`, '',
          mdRow(['Heure', 'Cours', ...cols.map((c) => c.label)]), mdRow(['---', '---', ...cols.map(() => '---')]));
      }
      const time = e.allDay ? 'journée' : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`;
      out.push(mdRow([time, mdCell(titleOf(e, prefs.title)), ...cols.map((c) => mdCell(c.key === 'extra' ? e.extra.join('; ') : valueText(e[c.key])))]));
    }
    return out.join('\n') + '\n';
  }

  const README = [
    'Vinci schedule export (horaire.vinci.be)',
    '',
    'Google Calendar: Settings → Import & export → Import → pick the .ics (or .google.csv) file.',
    '  Tip: first create a dedicated calendar (e.g. "Vinci") and import into it.',
    'Apple Calendar: File → Import… → the .ics file.',
    'Outlook: File → Open & Export → Import/Export → iCalendar (.ics).',
    '',
    'Re-importing the same .ics will NOT create duplicates (each event keeps its CELCAT id).',
    'But calendar apps may not apply changed times/rooms to events already imported, and never',
    'remove cancelled classes. When the schedule changes: delete the dedicated calendar and import again.',
    '',
  ].join('\r\n');

  const safeName = (s) => String(s).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').replace(/\s+/g, '-').slice(0, 80) || 'schedule';

  // All requested formats as text files. Several formats → the caller zips them (with README.txt).
  const fileBase = (meta) => `Vinci-${safeName(meta.label)}_${meta.range.start}_${meta.range.end}`;
  function buildFiles(evs, prefs, formats, meta, now = new Date()) {
    const base = fileBase(meta);
    const make = { ics: toICS, gcsv: toGoogleCSV, md: toMarkdown, json: toJSON, csv: toCSV };
    return formats.filter((f) => FORMATS[f]).map((f) => ({
      format: f, name: `${base}.${FORMATS[f].ext}`, mime: FORMATS[f].mime, text: make[f](evs, prefs, meta, now),
    }));
  }

  /* ========================================================================= run */
  async function run(opts) {
    reset();
    removePanel();
    controller = new AbortController();
    const o = opts || {};
    const sel = readSelection();
    const resources = o.federationIds && o.federationIds.length ? o.federationIds.map((id) => ({ id, name: id })) : sel.resources;
    const resType = o.resType || sel.resType;
    const nameOf = new Map(sel.resources.map((r) => [r.id, r.name]));
    run_ = {
      range: { start: o.start, end: o.end },
      formats: (o.formats && o.formats.length ? o.formats : ['ics']).filter((f) => FORMATS[f]),
      selection: { type: RES_TYPE_NAMES[resType] || String(resType), resType, resources: resources.map((r) => nameOf.get(r.id) || r.name) },
      label: resources.map((r) => nameOf.get(r.id) || r.name).join('+'),
      url: location.href,
    };
    state.running = true;
    state.message = 'Reading the schedule…';
    emit(true);
    try {
      if (!resources.length || !resType) throw new Error('Nothing selected — pick a group/course on the schedule first.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(o.end || '') || o.start > o.end) {
        throw new Error(`Invalid date range ${o.start} → ${o.end}.`);
      }
      // 1. Bulk event list, in ≤ 6-month chunks; ids are stable, so overlaps are deduped.
      const byId = new Map();
      for (let from = o.start; from <= o.end; from = addDays(from, CHUNK_DAYS + 1)) {
        const to = [addDays(from, CHUNK_DAYS), o.end].sort()[0];
        setMsg(`Fetching events ${from} → ${to}…`);
        const list = await post(ENDPOINTS.calendar, {
          start: from, end: addDays(to, 1), resType, calView: 'month', federationIds: resources.map((r) => r.id),
        });
        if (!Array.isArray(list)) throw new Error('unexpected answer from GetCalendarData');
        for (const e of list) if (e && e.id != null && !byId.has(String(e.id))) byId.set(String(e.id), e);
      }
      const raws = [...byId.values()].filter((e) => { const d = String(e.start).slice(0, 10); return d >= o.start && d <= o.end; });
      if (!raws.length) throw new Error(`No events between ${o.start} and ${o.end} for ${run_.label}.`);

      // 2. Details (room list, staff, notes, Teams link) — one request per timed event; holidays don't need it.
      const timed = raws.filter((e) => !e.allDay);
      state.total = timed.length;
      state.done = 0;
      const details = new Map();
      await pool(timed, MAX_CONCURRENCY, async (e) => {
        try { details.set(String(e.id), await post(ENDPOINTS.event, { eventId: e.id })); }
        catch (err) {
          if (err instanceof AbortRun) throw err;
          warn(`Details unavailable for ${String(e.start).slice(0, 16)} ${decode(String(e.description).split(/<br/i)[0])}: ${err.message} (kept with basic info)`);
        }
        state.done++;
        setMsg(`Event details ${state.done}/${state.total}…`);
      });

      events = raws.map((e) => normalize(e, details.get(String(e.id))))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.uid < b.uid ? -1 : 1));
      state.eventCount = events.length;
      state.readyToSave = true;
      state.message = `${events.length} events ready (${run_.label}, ${o.start} → ${o.end}). ` +
        'On the schedule page, choose the fields to keep and click “💾 Save…”.';
      showPanel();
    } catch (e) {
      console.error(LOG, e);
      if (state.cancelled) state.message = 'Cancelled — nothing was exported.';
      else state.message = e instanceof AbortRun ? `Aborted: ${e.message}` : `Failed: ${e.message}`;
      if (!(e instanceof AbortRun)) state.errors.push(String(e && e.message || e));
    } finally {
      while (active > 0) await sleep(20);
      await sleep(0);
      state.running = false;
      state.finished = true;
      emit(true);
    }
  }

  /* ========================================================================= field picker + save */
  // Shown in the page (not the popup): Chrome only opens a "Save as" dialog on a click in the page.
  const PANEL_ID = 'vinci-schedule-export';
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      return { title: TITLE_TEMPLATES[p.title] ? p.title : DEFAULT_PREFS.title, fields: { ...DEFAULT_PREFS.fields, ...(p.fields || {}) } };
    } catch (_) { return JSON.parse(JSON.stringify(DEFAULT_PREFS)); }
  }
  function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* ignore */ } }
  const metaOf = () => ({ label: run_.label, range: run_.range, url: run_.url, selection: run_.selection });

  function showPanel() {
    removePanel();
    const prefs = loadPrefs();
    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box{font:13px/1.4 system-ui,sans-serif;background:#fff;color:#222;border:1px solid #ccc;border-radius:8px;padding:10px 12px;
        box-shadow:0 4px 16px rgba(0,0,0,.2);width:380px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;box-sizing:border-box}
      h3{font-size:14px;margin:0 0 6px}fieldset{border:1px solid #ddd;border-radius:4px;margin:0 0 8px;padding:4px 8px 6px}
      legend{font-weight:600;padding:0 4px}label{display:block;cursor:pointer}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 8px}
      small,.note{color:#666}.note{font-size:11px;margin:0 0 8px}
      pre{font:11px/1.35 ui-monospace,Menlo,monospace;background:#f6f6f6;border-radius:4px;padding:6px;margin:0 0 8px;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-all}
      button{font:600 14px system-ui,sans-serif;padding:8px 12px;border:0;border-radius:6px;cursor:pointer}
      .save{background:#3b88b8;color:#fff}.save:disabled{background:#999;cursor:default}.close{background:transparent;color:#666;margin-left:6px}
      .msg{margin:6px 0 0;color:#a33;word-break:break-word}</style>
      <div class="box">
        <h3 class="head"></h3>
        <fieldset class="title"><legend>Event title</legend></fieldset>
        <fieldset><legend>Fields to keep</legend><div class="grid fields"></div></fieldset>
        <fieldset><legend>Formats <small>(2+ → .zip)</small></legend><div class="grid formats"></div></fieldset>
        <div><b>Preview</b> <small>(.ics, first event)</small></div><pre class="preview"></pre>
        <p class="note">Import into a dedicated calendar. Re-importing won't create duplicates, but changed or cancelled classes may not update: delete that calendar and import again.</p>
        <button class="save">💾 Save…</button><button class="close" title="Discard">✕</button>
        <p class="msg"></p>
      </div>`;
    root.querySelector('.head').textContent = `📅 ${events.length} events — ${run_.label}, ${run_.range.start} → ${run_.range.end}`;
    const add = (parent, type, name, value, text, checked, hint) => {
      const l = document.createElement('label');
      const i = document.createElement('input');
      i.type = type; i.name = name; i.value = value; i.checked = !!checked;
      l.append(i, ' ' + text);
      if (hint) { const s = document.createElement('small'); s.textContent = ` ${hint}`; l.append(s); }
      parent.appendChild(l);
      return i;
    };
    for (const [k, t] of Object.entries(TITLE_TEMPLATES)) add(root.querySelector('.title'), 'radio', 'title', k, t.label, prefs.title === k, `“${t.example}”`);
    for (const f of FIELDS) add(root.querySelector('.fields'), 'checkbox', 'field', f.key, f.label, prefs.fields[f.key]);
    for (const [k, f] of Object.entries(FORMATS)) add(root.querySelector('.formats'), 'checkbox', 'format', k, f.label, run_.formats.includes(k));

    const read = () => ({
      title: (root.querySelector('input[name="title"]:checked') || {}).value || 'subject',
      fields: Object.fromEntries([...root.querySelectorAll('input[name="field"]')].map((i) => [i.value, i.checked])),
    });
    const formats = () => [...root.querySelectorAll('input[name="format"]:checked')].map((i) => i.value);
    const update = () => {
      const p = read();
      savePrefs(p);
      run_.formats = formats();
      const sample = events.find((e) => !e.allDay) || events[0];
      root.querySelector('.preview').textContent = sample ? vevent(sample, p, new Date()).map(foldLine).join('\n') : '';
      const save = root.querySelector('.save');
      save.disabled = !run_.formats.length;
      save.textContent = run_.formats.length > 1 ? '💾 Save ZIP…' : '💾 Save…';
    };
    root.addEventListener('change', update);
    update();
    root.querySelector('.save').addEventListener('click', () => { save(read()).catch((e) => panelMsg(`Save failed: ${e.message}`)); });
    root.querySelector('.close').addEventListener('click', () => {
      state.readyToSave = false; setMsg('Export discarded.'); removePanel();
    });
    document.body.appendChild(host);
  }
  function removePanel() { const h = document.getElementById(PANEL_ID); if (h) h.remove(); }
  function panelMsg(m) {
    const h = document.getElementById(PANEL_ID);
    if (h) h.shadowRoot.querySelector('.msg').textContent = m;
    setMsg(m);
  }

  // Asks for the destination FIRST (the click's user activation must still be fresh), then builds and writes.
  async function save(prefs) {
    const formats = run_.formats;
    if (!formats.length) return;
    const now = new Date();
    const files = buildFiles(events, prefs, formats, metaOf(), now);
    const zipped = files.length > 1;
    const name = zipped ? `${fileBase(metaOf())}.zip` : files[0].name;
    const mime = zipped ? 'application/zip' : files[0].mime;
    const ext = '.' + name.split('.').pop();
    const makeBlob = async () => {
      if (!zipped) return new Blob([files[0].text], { type: mime });
      if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded (lib/jszip.min.js missing?)');
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f.text);
      zip.file('README.txt', README);
      return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    };
    if (typeof window.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name, id: 'vinci-schedule', startIn: 'downloads',
          types: [{ description: zipped ? 'ZIP archive' : FORMATS[formats[0]].label, accept: { [mime]: [ext] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { panelMsg('Save cancelled — click “💾 Save…” again when ready.'); return; }
        warn(`Save dialog failed (${e && e.message}); falling back to a normal download.`);
      }
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(await makeBlob());
        await writable.close();
        return saved(handle.name);
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await makeBlob());
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    saved(`${name} (browser Downloads folder)`);
  }
  function saved(where) {
    state.readyToSave = false;
    state.savedAs = where;
    setMsg(`Saved: ${where}`);
    removePanel();
  }

  // Test hook for `bun test` — only active when the test harness sets the flag. Inert in Chrome.
  if (TEST) {
    window.__vinciScheduleInternals = {
      readSelection, parseDescription, splitTitle, sidebarFields, normalize, titleOf, foldLine, icsEscape,
      toICS, toGoogleCSV, toCSV, toJSON, toMarkdown, buildFiles, post, FIELDS, FORMATS, DEFAULT_PREFS, ENDPOINTS,
      getState: snapshot, getEvents: () => events,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'start' && !state.running) run(msg.options);
    if (msg.cmd === 'cancel') cancelRun();
    if (msg.cmd === 'selection') { sendResponse({ selection: readSelection(), state: snapshot() }); return; }
    sendResponse(snapshot());
  });
})();
