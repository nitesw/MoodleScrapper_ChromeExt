// Drives the real popup.html + popup.js with stubbed chrome.tabs / chrome.scripting.
import { describe, test, expect, afterEach } from 'bun:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, O } from './harness.js';

const HTML = readFileSync(join(ROOT, 'popup.html'), 'utf8').replace(/<script src="popup.js"><\/script>/, '');
const JS = readFileSync(join(ROOT, 'popup.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 10));

// jsdom has no localStorage for chrome-extension:// (opaque origin), so give the popup a simple
// one; `store` survives between popup openings like the real extension storage does.
function memoryStorage(store) {
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
}

function openPopup({ tabUrl = `${O}/course/view.php?id=465`, store = {}, status = null } = {}) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://abc/popup.html', runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  Object.defineProperty(w, 'localStorage', { value: memoryStorage(store), configurable: true });
  const sent = [];
  const injected = [];
  let onMessage = null;
  let reply = status; // what the content script answers
  w.chrome = {
    tabs: {
      query: async () => [{ id: 7, url: tabUrl }],
      sendMessage: async (tabId, msg) => {
        sent.push(msg);
        if (!reply) throw new Error('Could not establish connection');
        return typeof reply === 'function' ? reply(msg) : reply;
      },
    },
    scripting: { executeScript: async (o) => { injected.push(o); reply = reply || { running: true, message: 'Reading course page…' }; } },
    runtime: { onMessage: { addListener: (f) => { onMessage = f; } } },
  };
  w.eval(JS);
  const $ = (id) => w.document.getElementById(id);
  return {
    w, $, sent, injected, store,
    setReply: (r) => { reply = r; },
    push: (state) => onMessage({ type: 'moodle-scraper-progress', state }, { tab: { id: 7 } }),
    close: () => w.close(),
  };
}

describe('popup', () => {
  let p;
  afterEach(() => p && p.close());

  test('defaults: media unticked, Office → Markdown ticked', async () => {
    p = openPopup();
    await tick();
    expect(p.$('optVideo').checked).toBe(false);
    expect(p.$('optAudio').checked).toBe(false);
    for (const id of ['optMdSlides', 'optMdDocs', 'optMdSheets', 'optMdPictures']) expect(p.$(id).checked).toBe(true);
  });

  test('unticking Slides is remembered and sent with start', async () => {
    p = openPopup();
    await tick();
    p.$('optMdSlides').click();
    p.$('go').click();
    await tick();
    expect(p.sent.at(-1).options.mdSlides).toBe(false);
    expect(JSON.parse(p.store.moodleScraperOptions).mdSlides).toBe(false);
  });

  test('checkbox choices are remembered across popup openings', async () => {
    p = openPopup();
    await tick();
    p.$('optVideo').click();
    const store = p.store;
    expect(JSON.parse(store.moodleScraperOptions)).toEqual({
      downloadVideo: true, downloadAudio: false, mdSlides: true, mdDocs: true, mdSheets: true, mdPictures: true,
    });
    p.close();
    p = openPopup({ store });
    await tick();
    expect(p.$('optVideo').checked).toBe(true);
    expect(p.$('optAudio').checked).toBe(false);
  });

  test('Scrape injects JSZip + content.js and sends the chosen options', async () => {
    p = openPopup({ store: { moodleScraperOptions: JSON.stringify({ downloadVideo: false, downloadAudio: true }) } });
    await tick();
    p.$('go').click();
    await tick();
    expect(p.injected[0].files).toEqual(['lib/jszip.min.js', 'lib/office2md.js', 'content.js']);
    expect(p.sent.at(-1)).toEqual({
      cmd: 'start',
      options: { downloadVideo: false, downloadAudio: true, mdSlides: true, mdDocs: true, mdSheets: true, mdPictures: true },
    });
  });

  test('Cancel is shown only while running, and sends cancel', async () => {
    p = openPopup();
    await tick();
    expect(p.$('cancel').classList.contains('hidden')).toBe(true);
    p.push({ running: true, done: 3, total: 20, message: 'Downloading 4/20: Slides01.pdf', errors: [], warnings: [] });
    expect(p.$('cancel').classList.contains('hidden')).toBe(false);
    expect(p.$('optVideo').disabled).toBe(true); // options locked during a run
    p.setReply({ running: true, cancelled: true, message: 'Cancelling…', errors: [], warnings: [] });
    p.$('cancel').click();
    await tick();
    expect(p.sent.at(-1)).toEqual({ cmd: 'cancel' });
    expect(p.$('cancel').textContent).toBe('Cancelling…');
    p.push({ running: false, finished: true, cancelled: true, message: 'Cancelled — scraping stopped, nothing was saved.', errors: [], warnings: [] });
    expect(p.$('cancel').classList.contains('hidden')).toBe(true);
    expect(p.$('go').disabled).toBe(false);
    expect(p.$('status').textContent).toContain('Cancelled');
  });

  test('reopening the popup during a run restores progress', async () => {
    p = openPopup({ status: { running: true, done: 5, total: 10, message: 'Downloading 6/10: x.pdf', errors: [], warnings: [] } });
    await tick();
    expect(p.$('status').textContent).toBe('Downloading 6/10: x.pdf');
    expect(p.$('bar').value).toBe(5);
    expect(p.$('go').disabled).toBe(true);
  });

  test('outside a moodle.vinci.be course page the button stays disabled', async () => {
    p = openPopup({ tabUrl: 'https://example.com/' });
    await tick();
    expect(p.$('go').disabled).toBe(true);
    expect(p.$('hint').classList.contains('hidden')).toBe(false);
  });
});

describe('popup — schedule mode (horaire.vinci.be)', () => {
  let p;
  afterEach(() => p && p.close());
  const SCHED_URL = 'https://horaire.vinci.be/cal?vt=agendaWeek&dt=2026-10-06&et=group&fid0=1BIN5';
  const SEL = { resType: 103, typeName: 'Groups', resources: [{ id: '1BIN5', name: '1BIN5' }], view: 'agendaWeek', date: '2026-10-06', viewRange: { start: '2026-10-05', end: '2026-10-10' } };
  const IDLE = { running: false, done: 0, total: 0, message: '', errors: [], warnings: [] };
  const replyWith = (selection) => (msg) => (msg.cmd === 'selection' ? { selection, state: IDLE } : { ...IDLE, running: true, message: 'Reading the schedule…' });

  test('shows the schedule UI, injects schedule.js and shows the page selection', async () => {
    p = openPopup({ tabUrl: SCHED_URL, status: replyWith(SEL) });
    await tick();
    expect(p.$('scheduleUI').classList.contains('hidden')).toBe(false);
    expect(p.$('moodleUI').classList.contains('hidden')).toBe(true);
    expect(p.injected[0].files).toEqual(['lib/jszip.min.js', 'schedule.js']);
    expect(p.sent[0]).toEqual({ cmd: 'selection' });
    expect(p.$('selInfo').textContent).toBe('📅 1BIN5 (Groups)');
    expect(p.$('viewRange').textContent).toBe('(2026-10-05 → 2026-10-10)');
    expect(p.$('go').textContent).toBe('Export schedule');
    expect(p.$('go').disabled).toBe(false);
    expect(p.$('fmtIcs').checked).toBe(true); // default format
  });

  test('start sends the range, selection and formats; choices are remembered', async () => {
    p = openPopup({ tabUrl: SCHED_URL, status: replyWith(SEL) });
    await tick();
    p.$('dateFrom').value = '2026-10-01';
    p.$('dateTo').value = '2026-12-20';
    p.$('dateTo').dispatchEvent(new p.w.Event('change', { bubbles: true })); // editing a date selects "Custom"
    p.$('fmtMd').click();
    p.$('go').click();
    await tick();
    expect(p.sent.at(-1)).toEqual({
      cmd: 'start',
      options: { start: '2026-10-01', end: '2026-12-20', resType: 103, federationIds: ['1BIN5'], formats: ['ics', 'md'] },
    });
    expect(JSON.parse(p.store.scheduleScraperOptions)).toEqual({ range: 'custom', from: '2026-10-01', to: '2026-12-20', formats: ['ics', 'md'] });
  });

  test('"Current view" uses the dates rendered on the page', async () => {
    p = openPopup({ tabUrl: SCHED_URL, status: replyWith(SEL), store: { scheduleScraperOptions: JSON.stringify({ range: 'view', formats: ['json'] }) } });
    await tick();
    p.$('go').click();
    await tick();
    expect(p.sent.at(-1).options).toMatchObject({ start: '2026-10-05', end: '2026-10-10', formats: ['json'] });
  });

  test('nothing selected on the page, or no format ticked → button disabled with a hint', async () => {
    p = openPopup({ tabUrl: SCHED_URL, status: replyWith({ ...SEL, resources: [], resType: null }) });
    await tick();
    expect(p.$('go').disabled).toBe(true);
    expect(p.$('hint').textContent).toContain('Pick a group/course');
    p.close();
    p = openPopup({ tabUrl: SCHED_URL, status: replyWith(SEL) });
    await tick();
    p.$('fmtIcs').click();
    expect(p.$('go').disabled).toBe(true);
    expect(p.$('hint').textContent).toContain('at least one export format');
  });

  test('computeRange: week (Monday-first), month, academic year, invalid custom', async () => {
    p = openPopup({ tabUrl: SCHED_URL, status: replyWith(SEL) });
    await tick();
    const d = new p.w.Date(2026, 9, 11); // Sunday 11 Oct 2026
    expect(p.w.computeRange('week', d)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(p.w.computeRange('month', d)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(p.w.computeRange('year', d)).toEqual({ start: '2026-09-01', end: '2027-08-31' });
    expect(p.w.computeRange('year', new p.w.Date(2027, 2, 1))).toEqual({ start: '2026-09-01', end: '2027-08-31' });
    expect(p.w.computeRange('custom', d, null, { from: '2026-12-01', to: '2026-11-01' })).toBe(null);
  });
});
