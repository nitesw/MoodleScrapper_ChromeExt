// Loads content.js into a jsdom "moodle.vinci.be" tab with stubbed chrome.*, fetch, JSZip and download.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const O = 'https://moodle.vinci.be';
export const FORBIDDEN = /startattempt|attempt\.php|processattempt|continue\.php|sesskey=|logout\.php/i;
const SRC = readFileSync(join(ROOT, 'content.js'), 'utf8');
const JSZIP_SRC = readFileSync(join(ROOT, 'lib/jszip.min.js'), 'utf8');
const O2M_SRC = readFileSync(join(ROOT, 'lib/office2md.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * pages: { '/path?query': { type, body, status?, redirect?, cd? } } — keyed by pathname+search.
 *   redirect: path the request "lands on" (response.url), like a followed 30x.
 */
/** picker: 'ok' (user picks a file) | 'cancel' (closes dialog) | 'error' (API throws) | 'none' (API unavailable) */
export function createEnv({ html = '<html><body></body></html>', url = `${O}/course/view.php?id=462`, pages = {}, delayMs = 0, latencyMs = 1, picker = 'ok' } = {}) {
  // Scraper console output is hidden unless MOODLE_TEST_VERBOSE=1 (negative tests log errors on purpose).
  const virtualConsole = new VirtualConsole();
  if (process.env.MOODLE_TEST_VERBOSE) virtualConsole.sendTo(console);
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  const requests = [];      // { url, method, start }
  const zipFiles = {};
  const net = { inflight: 0, maxInflight: 0, aborted: 0 };
  let listener = null;
  let downloaded = null;

  w.__MOODLE_SCRAPER_TEST__ = { delayMs };
  w.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (f) => { listener = f; } },
    },
  };

  w.fetch = async (reqUrl, opts = {}) => {
    const u = new URL(reqUrl);
    const key = u.pathname + u.search;
    requests.push({ url: u.href, key, method: opts.method, credentials: opts.credentials, start: Date.now() });
    net.inflight++;
    net.maxInflight = Math.max(net.maxInflight, net.inflight);
    try {
      // Like real fetch: an aborted signal rejects with AbortError.
      await new Promise((resolve, reject) => {
        const abortErr = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (opts.signal && opts.signal.aborted) return abortErr();
        const t = setTimeout(resolve, latencyMs);
        if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); net.aborted++; abortErr(); });
      });
      const p = pages[key];
      const finalUrl = p && p.redirect ? O + p.redirect : u.href;
      const headers = new Map([['content-type', p ? p.type : 'text/html'], ['content-disposition', (p && p.cd) || '']]);
      const body = p ? p.body : 'not found';
      return {
        ok: !!p && !(p.status >= 400),
        status: p ? p.status || 200 : 404,
        url: finalUrl,
        headers: { get: (k) => headers.get(k.toLowerCase()) || null },
        blob: async () => {
          const b = new w.Blob([body], { type: headers.get('content-type') });
          b.text = async () => body; // jsdom's Blob has no text()
          return b;
        },
      };
    } finally { net.inflight--; }
  };

  // File System Access API stub (native "Save as" dialog).
  const saves = { calls: [], written: [], mode: picker };
  if (picker !== 'none') {
    w.showSaveFilePicker = async (opts) => {
      saves.calls.push(opts);
      if (saves.mode === 'cancel') throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      if (saves.mode === 'error') throw Object.assign(new Error('Not allowed'), { name: 'SecurityError' });
      const name = `chosen/${opts.suggestedName}`;
      return {
        name: opts.suggestedName,
        createWritable: async () => ({
          write: async (data) => saves.written.push({ path: name, data }),
          close: async () => {},
        }),
      };
    };
  }

  // Same injection order as popup.js: real JSZip, then the Office converter, then content.js.
  // The OUTPUT zip is replaced by a recorder; reading Office files still uses the real JSZip.
  w.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0); // jsdom lacks it; JSZip needs it to stream
  w.eval(JSZIP_SRC);
  const RealJSZip = w.JSZip;
  w.eval(O2M_SRC);
  w.JSZip = class {
    static loadAsync(...a) { return RealJSZip.loadAsync(...a); }
    file(path, data) { zipFiles[path] = data; }
    async generateAsync(_o, cb) { if (cb) cb({ percent: 100 }); return new w.Blob(['zip']); }
  };
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };

  w.eval(SRC);

  const send = (cmd, extra = {}) => { let r; listener({ cmd, ...extra }, {}, (s) => { r = s; }); return r; };

  async function waitFinished(timeoutMs = 15000) {
    let st = send('status');
    const t0 = Date.now();
    while (!st.finished && Date.now() - t0 < timeoutMs) { await sleep(10); st = send('status'); }
    return st;
  }

  /** options: { downloadVideo, downloadAudio } — what the popup checkboxes send. */
  async function scrape(timeoutMs = 15000, options) {
    send('start', options ? { options } : {});
    const st = await waitFinished(timeoutMs);
    if (!st.finished) throw new Error('scrape did not finish in time: ' + st.message);
    const mdBlob = zipFiles['course.md'];
    return { state: st, md: mdBlob == null ? null : String(mdBlob) };
  }

  return {
    window: w,
    internals: w.__moodleScraperInternals,
    requests, zipFiles, net, send, scrape, waitFinished, saves, sleep,
    saveBox: () => w.document.getElementById('moodle-scraper-save'),
    async clickSave() {
      const host = w.document.getElementById('moodle-scraper-save');
      if (!host) throw new Error('Save button not shown');
      host.shadowRoot.querySelector('.save').click();
      await sleep(20);
    },
    get downloaded() { return downloaded; },
    close: () => w.close(), // also clears the 60 s blob-revoke timer
  };
}
