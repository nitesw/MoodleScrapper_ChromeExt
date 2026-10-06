// Schedule export (horaire.vinci.be / CELCAT): parsing, exporters, the run, the field panel and saving.
import { describe, test, expect, afterEach } from 'bun:test';
import { createScheduleEnv, celcatPage, H } from './schedule.harness.js';
import { CAL_EVENTS, FO_ID, FO_SIDEBAR, TEAMS } from './schedule.fixtures.js';

const ALL_FIELDS = (on = true) => Object.fromEntries(['code', 'subject', 'name', 'groups', 'rooms', 'staff', 'category', 'links', 'notes', 'department', 'sites', 'extra', 'color'].map((k) => [k, on]));
const PREFS = (over = {}) => ({ title: 'subject', fields: { ...ALL_FIELDS(false), rooms: true, groups: true, links: true, ...over } });
const META = { label: '1BIN5', range: { start: '2026-10-05', end: '2026-10-11' }, url: `${H}/cal?fid0=1BIN5`, selection: { type: 'Groups', resources: ['1BIN5'] } };
const NOW = new Date('2026-10-06T08:00:00Z');
const FO_RAW = CAL_EVENTS.find((e) => e.id === FO_ID);

// Minimal RFC 5545 reader: unfold lines, split VEVENTs into { PROP: value } (params kept in the key).
function parseICS(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
  const evs = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { evs.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i)] = l.slice(i + 1); }
  }
  return evs;
}
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1');

let env;
afterEach(() => { if (env) env.close(); env = null; });

describe('parsing', () => {
  test('description blocks: title / groups / rooms, entities decoded', () => {
    env = createScheduleEnv();
    const d = env.internals.parseDescription(CAL_EVENTS[0].description);
    expect(d).toEqual({ rawTitle: 'BINV1090-A-a [Math 1 : théorie]', name: '', groups: ['1BIN5', '1BIN6', '1BIN7'], rooms: ['CH43 Aud A'] });
  });

  test('4-block description carries an event name; all-day has only a name', () => {
    env = createScheduleEnv();
    const g = env.internals.parseDescription(CAL_EVENTS.find((e) => e.description.includes('Gestion d')).description);
    expect(g.name).toBe("Gestion d'entreprise");
    expect(g.rooms).toEqual(['CH43 Aud A']);
    expect(env.internals.parseDescription('Toussaint\r\n')).toEqual({ rawTitle: 'Toussaint', name: '', groups: [], rooms: [] });
  });

  test('module title splits into code + course', () => {
    env = createScheduleEnv();
    expect(env.internals.splitTitle('BINV1073-A [FO]')).toEqual({ code: 'BINV1073-A', subject: 'FO' });
    expect(env.internals.splitTitle('BIN - Consultation des copies')).toEqual({ code: '', subject: 'BIN - Consultation des copies' });
  });

  test('sidebar: continuation rows join the previous label, Teams href extracted, empty notes ignored', () => {
    env = createScheduleEnv();
    const s = env.internals.sidebarFields(FO_SIDEBAR);
    expect(s.groups).toEqual(['1BIN3', '1BIN4', '1BIN5', '1BIN7']);
    expect(s.rooms).toEqual(['Dist Synchrone']);
    expect(s.links).toEqual([TEAMS]);
    expect(s.notes).toEqual([]);
    expect(s.modules).toEqual(['BINV1073-A [FO]']);
  });

  test('normalize merges bulk data with sidebar details', () => {
    env = createScheduleEnv();
    const e = env.internals.normalize(FO_RAW, FO_SIDEBAR);
    expect(e).toMatchObject({
      uid: FO_ID, start: '2026-10-05T09:30:00', end: '2026-10-05T11:30:00', allDay: false, code: 'BINV1073-A', subject: 'FO',
      groups: ['1BIN3', '1BIN4', '1BIN5', '1BIN7'], rooms: ['Dist Synchrone'], category: 'BIN Distanciel', links: [TEAMS],
    });
  });

  test('without details the bulk description is used (Teams link from custom1 still kept)', () => {
    env = createScheduleEnv();
    const e = env.internals.normalize(FO_RAW, null);
    expect(e.rooms).toEqual(['Dist Synchrone']);
    expect(e.links).toEqual([TEAMS]);
  });

  test('all-day holiday: date-only start, exclusive next-day end', () => {
    env = createScheduleEnv();
    const e = env.internals.normalize(CAL_EVENTS.find((x) => x.allDay), null);
    expect(e).toMatchObject({ allDay: true, start: '2026-11-01', end: '2026-11-02', subject: 'Toussaint' });
  });
});

describe('selection', () => {
  test('read from the live page (select2 selects + rendered view)', () => {
    env = createScheduleEnv({ html: celcatPage({ resources: [['1BIN5', '1BIN5'], ['1BIN6', '1BIN6']] }), url: `${H}/cal?vt=month&dt=2026-01-01&et=module&fid0=X` });
    expect(env.internals.readSelection()).toEqual({
      resType: 103, typeName: 'Groups', resources: [{ id: '1BIN5', name: '1BIN5' }, { id: '1BIN6', name: '1BIN6' }],
      view: 'agendaWeek', date: '2026-01-01', viewRange: { start: '2026-10-05', end: '2026-10-10' },
    });
  });

  test('falls back to the URL when the page has no selection', () => {
    env = createScheduleEnv({ html: '<html><body></body></html>', url: `${H}/cal?vt=agendaDay&dt=2026-10-06&et=module&fid0=BINV1073-A&fid1=BINV1074-A` });
    const s = env.internals.readSelection();
    expect(s.resType).toBe(100);
    expect(s.typeName).toBe('Modules');
    expect(s.resources.map((r) => r.id)).toEqual(['BINV1073-A', 'BINV1074-A']);
    expect(s.view).toBe('agendaDay');
    expect(s.viewRange).toBe(null);
  });

  test('the selection command answers with selection + state', () => {
    env = createScheduleEnv();
    const r = env.send('selection');
    expect(r.selection.resources[0].id).toBe('1BIN5');
    expect(r.state.running).toBe(false);
  });
});

describe('exporters', () => {
  const evs = () => [env.internals.normalize(FO_RAW, FO_SIDEBAR), env.internals.normalize(CAL_EVENTS.find((x) => x.allDay), null)];

  test('ICS: Brussels TZID, stable UID, LOCATION/URL, all-day dates, CRLF', () => {
    env = createScheduleEnv();
    const ics = env.internals.toICS(evs(), PREFS(), META, NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Brussels');
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
    const [fo, hol] = parseICS(ics);
    expect(fo.UID).toBe(`${FO_ID}@horaire.vinci.be`);
    expect(fo['DTSTART;TZID=Europe/Brussels']).toBe('20261005T093000');
    expect(fo['DTEND;TZID=Europe/Brussels']).toBe('20261005T113000');
    expect(fo.SUMMARY).toBe('FO');
    expect(fo.LOCATION).toBe('Dist Synchrone');
    expect(fo.URL).toBe(TEAMS);
    expect(unescape(fo.DESCRIPTION)).toBe(`Groups: 1BIN3, 1BIN4, 1BIN5, 1BIN7\nWeb link (Teams): ${TEAMS}`);
    expect(fo.DTSTAMP).toBe('20261006T080000Z');
    expect(hol['DTSTART;VALUE=DATE']).toBe('20261101');
    expect(hol['DTEND;VALUE=DATE']).toBe('20261102');
  });

  test('ICS escapes , ; \\ and newlines; folds lines at 75 octets without splitting UTF-8', () => {
    env = createScheduleEnv();
    expect(env.internals.icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const long = 'DESCRIPTION:' + 'é'.repeat(100);
    const folded = env.internals.foldLine(long);
    const enc = new TextEncoder();
    for (const part of folded.split('\r\n')) expect(enc.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  test('fields can be dropped and title templates switch the SUMMARY', () => {
    env = createScheduleEnv();
    const e = evs()[0];
    const one = (prefs) => parseICS(env.internals.toICS([e], prefs, META, NOW))[0];
    const bare = one({ title: 'raw', fields: ALL_FIELDS(false) });
    expect(bare.SUMMARY).toBe('BINV1073-A [FO]');
    expect(bare.LOCATION).toBeUndefined();
    expect(bare.URL).toBeUndefined();
    expect(bare.DESCRIPTION).toBeUndefined();
    expect(one({ ...PREFS(), title: 'code-subject' }).SUMMARY).toBe('BINV1073-A FO');
    expect(one({ title: 'subject', fields: { ...ALL_FIELDS(false), category: true } }).CATEGORIES).toBe('BIN Distanciel');
  });

  test('Google CSV: Google header, MM/DD/YYYY + 12h times, all-day flag', () => {
    env = createScheduleEnv();
    const lines = env.internals.toGoogleCSV(evs(), PREFS()).split('\r\n');
    expect(lines[0]).toBe('Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description,Location,Private');
    expect(lines[1].startsWith('FO,10/05/2026,9:30 AM,10/05/2026,11:30 AM,False,"Groups: 1BIN3, 1BIN4, 1BIN5, 1BIN7\n')).toBe(true);
    expect(lines[1].endsWith(',Dist Synchrone,True')).toBe(true);
    expect(env.internals.toGoogleCSV(evs(), PREFS())).toContain('Toussaint,11/01/2026,,11/01/2026,,True,');
  });

  test('CSV has a BOM and one column per selected field; JSON keeps only selected fields', () => {
    env = createScheduleEnv();
    const csv = env.internals.toCSV(evs(), PREFS());
    expect(csv.startsWith('﻿Start,End,All day,Title,Groups,Room,Web link (Teams)\r\n')).toBe(true);
    const json = JSON.parse(env.internals.toJSON(evs(), PREFS({ links: false }), META, NOW));
    expect(json.events[0]).toEqual({ uid: FO_ID, start: '2026-10-05T09:30:00', end: '2026-10-05T11:30:00', allDay: false, title: 'FO', groups: ['1BIN3', '1BIN4', '1BIN5', '1BIN7'], rooms: ['Dist Synchrone'] });
    expect(json.timezone).toBe('Europe/Brussels');
  });

  test('Markdown groups by week and day, with an AI note', () => {
    env = createScheduleEnv();
    const md = env.internals.toMarkdown(evs(), PREFS(), META, NOW);
    expect(md).toContain('> **Note for the AI:**');
    expect(md).toContain('## Semaine du 05/10/2026');
    expect(md).toContain('### Lundi 05/10/2026');
    expect(md).toContain('| Heure | Cours | Groups | Room | Web link (Teams) |');
    expect(md).toContain('| 09:30–11:30 | FO | 1BIN3, 1BIN4, 1BIN5, 1BIN7 | Dist Synchrone |');
    expect(md).toContain('### Dimanche 01/11/2026');
    expect(md).toContain('| journée | Toussaint |');
  });

  test('buildFiles names files after the selection and range', () => {
    env = createScheduleEnv();
    const files = env.internals.buildFiles(evs(), PREFS(), ['ics', 'gcsv', 'md'], META, NOW);
    expect(files.map((f) => f.name)).toEqual(['Vinci-1BIN5_2026-10-05_2026-10-11.ics', 'Vinci-1BIN5_2026-10-05_2026-10-11.google.csv', 'Vinci-1BIN5_2026-10-05_2026-10-11.md']);
  });
});

describe('run', () => {
  test('one week: bulk + one detail request per event, only allow-listed POSTs', async () => {
    env = createScheduleEnv();
    const st = await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    expect(st.errors).toEqual([]);
    expect(st.eventCount).toBe(15);
    expect(st.readyToSave).toBe(true);
    const paths = env.requests.map((r) => r.path);
    expect(paths.filter((p) => p === '/Home/GetCalendarData')).toHaveLength(1);
    expect(paths.filter((p) => p === '/Home/GetSideBarEvent')).toHaveLength(15);
    for (const r of env.requests) {
      expect(r.method).toBe('POST');
      expect(r.url.startsWith(`${H}/Home/`)).toBe(true);
      expect(r.headers.RequestVerificationToken).toBe('tok123');
    }
    const cal = env.requests[0].params;
    expect(cal.get('resType')).toBe('103');
    expect(cal.getAll('federationIds[]')).toEqual(['1BIN5']);
    const evs = env.internals.getEvents();
    expect(evs[0].uid).toBe(FO_ID); // sorted by start
    expect(evs.find((e) => e.code === 'BINV1090-A-a').staff).toEqual(['DUPONT Marie']);
    expect(env.panel()).toBeTruthy();
  });

  test('long ranges are chunked; overlapping results are deduped; all-day events skip the detail call', async () => {
    env = createScheduleEnv();
    const st = await env.exportRange({ start: '2026-09-01', end: '2027-08-31' });
    expect(env.requests.filter((r) => r.path === '/Home/GetCalendarData').length).toBe(2);
    expect(st.eventCount).toBe(CAL_EVENTS.length);
    expect(env.requests.filter((r) => r.path === '/Home/GetSideBarEvent').length).toBe(CAL_EVENTS.filter((e) => !e.allDay).length);
  });

  test('throttle keeps at most 3 requests in flight', async () => {
    env = createScheduleEnv({ latencyMs: 15 });
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    expect(env.net.maxInflight).toBeLessThanOrEqual(3);
    expect(env.net.maxInflight).toBeGreaterThan(1);
  });

  test('a failed detail request is a warning; the event is kept with bulk data', async () => {
    env = createScheduleEnv({ failEvent: new Set([FO_ID]) });
    const st = await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    expect(st.errors).toEqual([]);
    expect(st.warnings.length).toBe(1);
    expect(st.warnings[0]).toContain('BINV1073-A [FO]');
    expect(st.eventCount).toBe(15);
    expect(env.internals.getEvents().find((e) => e.uid === FO_ID).rooms).toEqual(['Dist Synchrone']);
  });

  test('login page instead of JSON stops the run with a log-in message', async () => {
    env = createScheduleEnv({ login: true });
    const st = await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    expect(st.message).toMatch(/^Aborted: Session expired/);
    expect(st.readyToSave).toBeFalsy();
    expect(env.requests).toHaveLength(1);
  });

  test('empty range and invalid input are reported', async () => {
    env = createScheduleEnv();
    let st = await env.exportRange({ start: '2027-02-01', end: '2027-02-02' });
    expect(st.message).toContain('No events between 2027-02-01 and 2027-02-02');
    st = await env.exportRange({ start: '2026-10-11', end: '2026-10-05' });
    expect(st.message).toContain('Invalid date range');
  });

  test('cancel aborts in-flight requests and exports nothing', async () => {
    env = createScheduleEnv({ latencyMs: 40, delayMs: 5 });
    env.send('start', { options: { start: '2026-10-05', end: '2026-10-11', resType: 103, federationIds: ['1BIN5'], formats: ['ics'] } });
    await env.sleep(120);
    env.send('cancel');
    const st = await env.waitFinished();
    expect(st.cancelled).toBe(true);
    expect(st.message).toBe('Cancelled — nothing was exported.');
    expect(env.panel()).toBeNull();
    const n = env.requests.length;
    await env.sleep(100);
    expect(env.requests.length).toBe(n);
    expect(n).toBeLessThan(16);
  });

  test('post() refuses any other path', async () => {
    env = createScheduleEnv();
    await expect(env.internals.post('/Login', {})).rejects.toThrow(/not an allowed endpoint/);
    expect(env.requests).toHaveLength(0);
  });
});

describe('field panel and saving', () => {
  test('single format: save dialog with the .ics name, then panel closes', async () => {
    env = createScheduleEnv();
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11', formats: ['ics'] });
    expect(env.$p('.save').textContent).toBe('💾 Save…');
    expect(env.$p('.preview').textContent).toContain('SUMMARY:FO');
    await env.click('.save');
    expect(env.saves.calls[0].suggestedName).toBe('Vinci-1BIN5_2026-10-05_2026-10-11.ics');
    expect(env.saves.calls[0].types[0].accept).toEqual({ 'text/calendar': ['.ics'] });
    expect(env.saves.written).toHaveLength(1);
    expect(env.panel()).toBeNull();
    expect(env.send('status').message).toBe('Saved: Vinci-1BIN5_2026-10-05_2026-10-11.ics');
  });

  test('several formats → one zip with each file + README', async () => {
    env = createScheduleEnv();
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11', formats: ['ics', 'gcsv', 'md', 'json', 'csv'] });
    expect(env.$p('.save').textContent).toBe('💾 Save ZIP…');
    await env.click('.save');
    expect(env.saves.calls[0].suggestedName).toBe('Vinci-1BIN5_2026-10-05_2026-10-11.zip');
    expect(Object.keys(env.zipFiles).sort()).toEqual([
      'README.txt', 'Vinci-1BIN5_2026-10-05_2026-10-11.csv', 'Vinci-1BIN5_2026-10-05_2026-10-11.google.csv',
      'Vinci-1BIN5_2026-10-05_2026-10-11.ics', 'Vinci-1BIN5_2026-10-05_2026-10-11.json', 'Vinci-1BIN5_2026-10-05_2026-10-11.md',
    ]);
    expect(env.zipFiles['README.txt']).toContain('will NOT create duplicates');
  });

  test('unticking a field and picking a title updates the preview, the saved file and is remembered', async () => {
    env = createScheduleEnv();
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11', formats: ['ics', 'json'] });
    env.toggle('input[name="field"][value="rooms"]');
    env.toggle('input[name="title"][value="raw"]');
    expect(env.$p('.preview').textContent).toContain('SUMMARY:BINV1073-A [FO]');
    expect(env.$p('.preview').textContent).not.toContain('LOCATION:');
    await env.click('.save');
    expect(env.zipFiles['Vinci-1BIN5_2026-10-05_2026-10-11.ics']).not.toContain('LOCATION:');
    const prefs = JSON.parse(env.window.localStorage.getItem('vinciScheduleExportPrefs'));
    expect(prefs.title).toBe('raw');
    expect(prefs.fields.rooms).toBe(false);
  });

  test('remembered prefs are applied on the next export', async () => {
    env = createScheduleEnv({ storage: { vinciScheduleExportPrefs: JSON.stringify({ title: 'code-subject', fields: { links: false } }) } });
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    expect(env.$p('input[name="title"][value="code-subject"]').checked).toBe(true);
    expect(env.$p('input[name="field"][value="links"]').checked).toBe(false);
    expect(env.$p('input[name="field"][value="rooms"]').checked).toBe(true);
    expect(env.$p('.preview').textContent).toContain('SUMMARY:BINV1073-A FO');
  });

  test('unticking every format disables Save', async () => {
    env = createScheduleEnv();
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11', formats: ['ics'] });
    env.toggle('input[name="format"][value="ics"]');
    expect(env.$p('.save').disabled).toBe(true);
  });

  test('cancelled dialog keeps the panel; no picker → normal download', async () => {
    env = createScheduleEnv({ picker: 'cancel' });
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    await env.click('.save');
    expect(env.panel()).toBeTruthy();
    expect(env.send('status').message).toContain('Save cancelled');
    env.close();
    env = createScheduleEnv({ picker: 'none' });
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    await env.click('.save');
    expect(env.downloaded).toBe('Vinci-1BIN5_2026-10-05_2026-10-11.ics');
  });

  test('✕ discards the export', async () => {
    env = createScheduleEnv();
    await env.exportRange({ start: '2026-10-05', end: '2026-10-11' });
    await env.click('.close');
    expect(env.panel()).toBeNull();
    expect(env.send('status').readyToSave).toBe(false);
  });
});
