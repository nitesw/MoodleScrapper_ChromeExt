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
