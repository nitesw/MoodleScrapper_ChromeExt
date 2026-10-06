// Popup UI. The scrape itself runs in the tab (content.js on Moodle, schedule.js on horaire.vinci.be),
// so the popup can close at any time.
const COURSE_RE = /^https:\/\/moodle\.vinci\.be\/course\/(view|section)\.php\?/;
const SCHEDULE_RE = /^https:\/\/horaire\.vinci\.be\/cal(\?|$)/;
const MOODLE_FILES = ['lib/jszip.min.js', 'lib/office2md.js', 'content.js'];
const SCHEDULE_FILES = ['lib/jszip.min.js', 'schedule.js'];

const $ = (id) => document.getElementById(id);
let tabId = null;
let mode = null; // 'moodle' | 'schedule'
let selection = null; // schedule mode: what the CELCAT page has selected
let running = false;

// Options are remembered in the extension's own localStorage (no extra permission).
function loadStored(key, defaults) {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch (_) { return { ...defaults }; }
}
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ } }

/* ---------------------------------------------------------------- Moodle options */
const OPTS_KEY = 'moodleScraperOptions';
// option name → checkbox id
const OPTION_BOXES = {
  downloadVideo: 'optVideo', downloadAudio: 'optAudio',
  mdSlides: 'optMdSlides', mdDocs: 'optMdDocs', mdSheets: 'optMdSheets', mdPictures: 'optMdPictures',
};
const DEFAULTS = { downloadVideo: false, downloadAudio: false, mdSlides: true, mdDocs: true, mdSheets: true, mdPictures: true };
function readOptions() {
  const o = {};
  for (const [k, id] of Object.entries(OPTION_BOXES)) o[k] = $(id).checked;
  return o;
}
const initial = loadStored(OPTS_KEY, DEFAULTS);
for (const [k, id] of Object.entries(OPTION_BOXES)) {
  $(id).checked = !!initial[k];
  $(id).addEventListener('change', () => store(OPTS_KEY, readOptions()));
}

/* ---------------------------------------------------------------- schedule options */
const SCHED_KEY = 'scheduleScraperOptions';
// format id → checkbox id
const FORMAT_BOXES = { ics: 'fmtIcs', gcsv: 'fmtGcsv', md: 'fmtMd', json: 'fmtJson', csv: 'fmtCsv' };
const SCHED_DEFAULTS = { range: 'year', from: '', to: '', formats: ['ics'] };
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Inclusive { start, end } (YYYY-MM-DD) for a range choice. Weeks start on Monday;
// the academic year runs from 1 September to 31 August (from August on, the coming year).
function computeRange(kind, today = new Date(), sel = null, custom = {}) {
  const y = today.getFullYear(), m = today.getMonth();
  if (kind === 'week') {
    const mon = new Date(y, m, today.getDate() - ((today.getDay() + 6) % 7));
    return { start: isoDay(mon), end: isoDay(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6)) };
  }
  if (kind === 'month') return { start: isoDay(new Date(y, m, 1)), end: isoDay(new Date(y, m + 1, 0)) };
  if (kind === 'year') { const sy = m >= 7 ? y : y - 1; return { start: `${sy}-09-01`, end: `${sy + 1}-08-31` }; }
  if (kind === 'view') return sel && sel.viewRange ? { ...sel.viewRange } : null;
  if (kind === 'custom') return custom.from && custom.to && custom.from <= custom.to ? { start: custom.from, end: custom.to } : null;
  return null;
}
const fmtRange = (r) => (r ? (r.start === r.end ? r.start : `${r.start} → ${r.end}`) : '');

const sched = loadStored(SCHED_KEY, SCHED_DEFAULTS);
const rangeKind = () => (document.querySelector('input[name="range"]:checked') || {}).value || 'year';
function readSchedule() {
  return {
    range: rangeKind(), from: $('dateFrom').value, to: $('dateTo').value,
    formats: Object.entries(FORMAT_BOXES).filter(([, id]) => $(id).checked).map(([f]) => f),
  };
}
function currentRange() { const s = readSchedule(); return computeRange(s.range, new Date(), selection, s); }
// Enables the button only when a resource is selected, the range is valid and a format is ticked.
function refreshSchedule() {
  const s = readSchedule();
  store(SCHED_KEY, s);
  const r = currentRange();
  $('viewRange').textContent = selection && selection.viewRange ? `(${fmtRange(selection.viewRange)})` : '';
  $('yearRange').textContent = `(${fmtRange(computeRange('year'))})`;
  if (s.range !== 'custom' && r) { $('dateFrom').value = r.start; $('dateTo').value = r.end; }
  let problem = '';
  if (!selection || !selection.resources.length || !selection.resType) problem = 'Pick a group/course (Resource(s) box) on the schedule first.';
  else if (!r) problem = s.range === 'custom' ? 'Choose a valid “from” and “until” date.' : 'The current view could not be read — pick another range.';
  else if (!s.formats.length) problem = 'Tick at least one export format.';
  $('hint').textContent = problem;
  $('hint').classList.toggle('hidden', !problem);
  if (!running) $('go').disabled = !!problem;
}
(document.querySelector(`input[name="range"][value="${sched.range}"]`) || document.querySelector('input[name="range"][value="year"]')).checked = true;
$('dateFrom').value = sched.from;
$('dateTo').value = sched.to;
for (const [f, id] of Object.entries(FORMAT_BOXES)) $(id).checked = (sched.formats || []).includes(f);
$('scheduleUI').addEventListener('change', (e) => {
  if (e.target.type === 'date') document.querySelector('input[name="range"][value="custom"]').checked = true;
  refreshSchedule();
});

/* ---------------------------------------------------------------- shared progress UI */
const LABELS = {
  moodle: { idle: 'Scrape this course', busy: 'Scraping…', save: '👉 Switch to the Moodle tab and click <b>💾 Save ZIP…</b> (bottom-right) to choose the folder.' },
  schedule: { idle: 'Export schedule', busy: 'Exporting…', save: '👉 Switch to the schedule tab: choose the fields to keep, then click <b>💾 Save…</b> (bottom-right).' },
};
function render(s) {
  if (!s) return;
  running = !!s.running;
  const L = LABELS[mode || 'moodle'];
  $('go').disabled = running;
  $('go').textContent = running ? L.busy : L.idle;
  $('status').textContent = s.message || '';
  const bar = $('bar');
  if (s.running || s.total) {
    bar.classList.remove('hidden');
    bar.max = Math.max(s.total || 1, 1);
    bar.value = s.done || 0;
  }
  $('save').classList.toggle('hidden', !s.readyToSave);
  for (const id of Object.values(OPTION_BOXES)) $(id).disabled = running; // options apply per run
  for (const el of $('scheduleUI').querySelectorAll('input')) el.disabled = running;
  const cancel = $('cancel');
  cancel.classList.toggle('hidden', !s.running);
  cancel.disabled = !!s.cancelled;
  cancel.textContent = s.cancelled ? 'Cancelling…' : 'Cancel';
  const warn = $('warn');
  if (s.sizeWarning) { warn.textContent = s.sizeWarning; warn.classList.remove('hidden'); }
  else warn.classList.add('hidden');
  const ul = $('errors');
  ul.innerHTML = '';
  for (const e of s.errors || []) {
    const li = document.createElement('li'); li.textContent = '✖ ' + e; ul.appendChild(li);
  }
  for (const w of s.warnings || []) {
    const li = document.createElement('li'); li.className = 'w'; li.textContent = '⚠ ' + w; ul.appendChild(li);
  }
  if (mode === 'schedule' && !running) refreshSchedule();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && (msg.type === 'moodle-scraper-progress' || msg.type === 'schedule-scraper-progress') && sender.tab && sender.tab.id === tabId) render(msg.state);
});

function showSelection() {
  const r = selection && selection.resources;
  $('selInfo').textContent = r && r.length
    ? `📅 ${r.map((x) => x.name).join(', ')}${selection.typeName ? ` (${selection.typeName})` : ''}`
    : '📅 No group/course selected on the schedule.';
}

async function initSchedule() {
  mode = 'schedule';
  $('title').textContent = 'Vinci Schedule Export';
  $('moodleUI').classList.add('hidden');
  $('scheduleUI').classList.remove('hidden');
  $('save').innerHTML = LABELS.schedule.save;
  $('go').textContent = LABELS.schedule.idle;
  let st = null;
  try {
    // Injecting is idempotent (schedule.js guards against double injection) and only adds a listener.
    await chrome.scripting.executeScript({ target: { tabId }, files: SCHEDULE_FILES });
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'selection' });
    selection = r && r.selection;
    st = r && r.state;
  } catch (e) {
    $('status').textContent = 'Could not read the schedule page: ' + e.message;
  }
  showSelection();
  refreshSchedule();
  render(st);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  if (tab && SCHEDULE_RE.test(url)) { tabId = tab.id; return initSchedule(); }
  if (!tab || !COURSE_RE.test(url)) {
    $('hint').textContent = 'Open a course page on moodle.vinci.be (course/view.php or course/section.php), or your schedule on horaire.vinci.be, first.';
    $('hint').classList.remove('hidden');
    return;
  }
  mode = 'moodle';
  tabId = tab.id;
  $('save').innerHTML = LABELS.moodle.save;
  $('go').disabled = false;
  // Restore state if a scrape is already running / finished in this tab.
  try {
    const s = await chrome.tabs.sendMessage(tabId, { cmd: 'status' });
    render(s);
  } catch (_) { /* content script not injected yet: idle */ }
}

async function startSchedule() {
  const r = currentRange();
  const s = readSchedule();
  if (!r || !selection) return;
  return chrome.tabs.sendMessage(tabId, {
    cmd: 'start',
    options: { start: r.start, end: r.end, resType: selection.resType, federationIds: selection.resources.map((x) => x.id), formats: s.formats },
  });
}

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  try {
    let s;
    if (mode === 'schedule') {
      await chrome.scripting.executeScript({ target: { tabId }, files: SCHEDULE_FILES });
      s = await startSchedule();
    } else {
      await chrome.scripting.executeScript({ target: { tabId }, files: MOODLE_FILES });
      s = await chrome.tabs.sendMessage(tabId, { cmd: 'start', options: readOptions() });
    }
    render(s);
  } catch (e) {
    $('status').textContent = 'Failed to start: ' + e.message;
    $('go').disabled = false;
  }
});

$('cancel').addEventListener('click', async () => {
  $('cancel').disabled = true;
  try { render(await chrome.tabs.sendMessage(tabId, { cmd: 'cancel' })); }
  catch (e) { $('status').textContent = 'Could not cancel: ' + e.message; }
});

init();
