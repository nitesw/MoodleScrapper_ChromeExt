// Popup UI. The scrape itself runs in content.js (the popup can close at any time).
const COURSE_RE = /^https:\/\/moodle\.vinci\.be\/course\/(view|section)\.php\?/;

const $ = (id) => document.getElementById(id);
let tabId = null;

// Media download options, remembered in the extension's own localStorage (no extra permission).
const OPTS_KEY = 'moodleScraperOptions';
// option name → checkbox id
const OPTION_BOXES = {
  downloadVideo: 'optVideo', downloadAudio: 'optAudio',
  mdSlides: 'optMdSlides', mdDocs: 'optMdDocs', mdSheets: 'optMdSheets', mdPictures: 'optMdPictures',
};
const DEFAULTS = { downloadVideo: false, downloadAudio: false, mdSlides: true, mdDocs: true, mdSheets: true, mdPictures: true };
function loadOptions() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; }
  catch (_) { return { ...DEFAULTS }; }
}
function readOptions() {
  const o = {};
  for (const [k, id] of Object.entries(OPTION_BOXES)) o[k] = $(id).checked;
  return o;
}
function saveOptions() { try { localStorage.setItem(OPTS_KEY, JSON.stringify(readOptions())); } catch (_) { /* ignore */ } }
const initial = loadOptions();
for (const [k, id] of Object.entries(OPTION_BOXES)) {
  $(id).checked = !!initial[k];
  $(id).addEventListener('change', saveOptions);
}

function render(s) {
  if (!s) return;
  $('go').disabled = !!s.running;
  $('go').textContent = s.running ? 'Scraping…' : 'Scrape this course';
  $('status').textContent = s.message || '';
  const bar = $('bar');
  if (s.running || s.total) {
    bar.classList.remove('hidden');
    bar.max = Math.max(s.total || 1, 1);
    bar.value = s.done || 0;
  }
  $('save').classList.toggle('hidden', !s.readyToSave);
  for (const id of Object.values(OPTION_BOXES)) $(id).disabled = !!s.running; // options apply per run
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
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'moodle-scraper-progress' && sender.tab && sender.tab.id === tabId) render(msg.state);
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !COURSE_RE.test(tab.url || '')) {
    $('hint').textContent = 'Open a course page on moodle.vinci.be (course/view.php or course/section.php) first.';
    $('hint').classList.remove('hidden');
    return;
  }
  tabId = tab.id;
  $('go').disabled = false;
  // Restore state if a scrape is already running / finished in this tab.
  try {
    const s = await chrome.tabs.sendMessage(tabId, { cmd: 'status' });
    render(s);
  } catch (_) { /* content script not injected yet: idle */ }
}

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/jszip.min.js', 'lib/office2md.js', 'content.js'] });
    const s = await chrome.tabs.sendMessage(tabId, { cmd: 'start', options: readOptions() });
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
