// Loads schedule.js into a jsdom "horaire.vinci.be" tab with stubbed chrome.*, fetch (POST), JSZip and save dialog.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAL_EVENTS, sidebar } from './schedule.fixtures.js';

export const ROOT = join(import.meta.dir, '..');
export const H = 'https://horaire.vinci.be';
const SRC = readFileSync(join(ROOT, 'schedule.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal CELCAT page: type select, select2-backed resource select, and a rendered week view.
export function celcatPage({ resType = '103', resources = [['1BIN5', '1BIN5']], view = 'agendaWeek', days = ['2026-10-05', '2026-10-10'] } = {}) {
  const dates = [];
  for (let d = new Date(days[0]); d <= new Date(days[1]); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  return `<html><body>
    <form><select id="resourceTypeSelectList">
      ${['100:Modules', '102:Rooms', '103:Groups', '104:Students'].map((x) => { const [v, t] = x.split(':'); return `<option value="${v}"${v === resType ? ' selected' : ''}>${t}</option>`; }).join('')}
    </select>
    <select id="resourceSelectList" multiple>${resources.map(([v, t]) => `<option value="${v}" selected>${t}</option>`).join('')}</select>
    <input name="__RequestVerificationToken" type="hidden" value="tok123"></form>
    <div id="calendar"><div class="fc-toolbar"><button class="fc-month-button">month</button><button class="fc-${view}-button fc-state-active">x</button></div>
      <div class="fc-view"><table><thead><tr>${dates.map((d) => `<th class="fc-day-header" data-date="${d}"></th>`).join('')}</tr></thead></table></div></div>
  </body></html>`;
}

/**
 * opts.calendar(params) → array | Response-like override; opts.event(params) → object.
 * opts.failEvent: Set of event ids whose detail request answers HTTP 500.
 * opts.login: true → every request lands on the login page (HTML).
 * picker: 'ok' | 'cancel' | 'error' | 'none' (see tests/harness.js).
 */
export function createScheduleEnv({
  html = celcatPage(), url = `${H}/cal?vt=agendaWeek&dt=2026-10-06&et=group&fid0=1BIN5`,
  events = CAL_EVENTS, failEvent = new Set(), login = false, delayMs = 0, latencyMs = 1, picker = 'ok', storage = {},
} = {}) {
  const virtualConsole = new VirtualConsole();
  if (process.env.MOODLE_TEST_VERBOSE) virtualConsole.sendTo(console);
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  const requests = []; // { path, method, params, headers }
  const net = { inflight: 0, maxInflight: 0, aborted: 0 };
  const zipFiles = {};
  let listener = null;
  let downloaded = null;

  w.__SCHEDULE_SCRAPER_TEST__ = { delayMs };
  w.TextEncoder = TextEncoder;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  w.chrome = { runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: (f) => { listener = f; } } } };

  w.fetch = async (reqUrl, opts = {}) => {
    const u = new URL(reqUrl);
    const params = new URLSearchParams(opts.body || '');
    requests.push({ url: u.href, path: u.pathname, method: opts.method, params, headers: opts.headers || {}, credentials: opts.credentials });
    net.inflight++;
    net.maxInflight = Math.max(net.maxInflight, net.inflight);
    try {
      await new Promise((resolve, reject) => {
        const abortErr = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (opts.signal && opts.signal.aborted) return abortErr();
        const t = setTimeout(resolve, latencyMs);
        if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); net.aborted++; abortErr(); });
      });
      const reply = (status, body, type = 'application/json; charset=utf-8', finalUrl = u.href) => ({
        ok: status < 400, status, url: finalUrl,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      if (login) return reply(200, '<html>Log In</html>', 'text/html; charset=utf-8', `${H}/Login?ReturnUrl=%2F`);
      if (u.pathname === '/Home/GetCalendarData') {
        const s = params.get('start'), e = params.get('end');
        return reply(200, events.filter((x) => x.start.slice(0, 10) >= s && x.start.slice(0, 10) <= e));
      }
      if (u.pathname === '/Home/GetSideBarEvent') {
        const id = params.get('eventId');
        if (failEvent.has(id)) return reply(500, 'oops', 'text/plain');
        const ev = events.find((x) => String(x.id) === id);
        return ev ? reply(200, sidebar(ev)) : reply(200, '');
      }
      return reply(404, 'not found', 'text/html');
    } finally { net.inflight--; }
  };

  const saves = { calls: [], written: [], mode: picker };
  if (picker !== 'none') {
    w.showSaveFilePicker = async (o) => {
      saves.calls.push(o);
      if (saves.mode === 'cancel') throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      if (saves.mode === 'error') throw Object.assign(new Error('Not allowed'), { name: 'SecurityError' });
      return { name: o.suggestedName, createWritable: async () => ({ write: async (data) => saves.written.push(data), close: async () => {} }) };
    };
  }
  w.JSZip = class {
    file(path, data) { zipFiles[path] = data; }
    async generateAsync() { return new w.Blob(['zip']); }
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
  async function exportRange(options) {
    send('start', { options: { resType: 103, federationIds: ['1BIN5'], formats: ['ics'], ...options } });
    return waitFinished();
  }
  const panel = () => w.document.getElementById('vinci-schedule-export');
  const $p = (sel) => panel().shadowRoot.querySelector(sel);

  return {
    window: w, internals: w.__vinciScheduleInternals, requests, net, zipFiles, saves, send, waitFinished, exportRange, sleep,
    panel, $p,
    async click(sel) { $p(sel).click(); await sleep(20); },
    toggle(sel) { const i = $p(sel); i.checked = !i.checked; i.dispatchEvent(new w.Event('change', { bubbles: true })); },
    get downloaded() { return downloaded; },
    close: () => w.close(),
  };
}
