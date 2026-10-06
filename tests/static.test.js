// Static checks on the extension package (no DOM needed). `bun run check` runs only this file.
import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const transpiler = new Bun.Transpiler({ loader: 'js' });

describe('package', () => {
  test.each(['content.js', 'popup.js', 'schedule.js'])('%s parses', (f) => {
    expect(() => transpiler.transformSync(read(f))).not.toThrow();
  });

  test('manifest is MV3 with minimal permissions', () => {
    const m = JSON.parse(read('manifest.json'));
    expect(m.manifest_version).toBe(3);
    expect(m.permissions.sort()).toEqual(['activeTab', 'scripting']);
    expect(m.host_permissions).toEqual(['https://moodle.vinci.be/*', 'https://horaire.vinci.be/*']);
    expect(existsSync(join(ROOT, m.action.default_popup))).toBe(true);
  });

  test('JSZip and the Office converter are bundled locally and injected before content.js', () => {
    expect(read('lib/jszip.min.js')).toContain('JSZip v3.10.1');
    expect(read('popup.js')).toContain("const MOODLE_FILES = ['lib/jszip.min.js', 'lib/office2md.js', 'content.js'];");
    expect(read('popup.js')).toContain("const SCHEDULE_FILES = ['lib/jszip.min.js', 'schedule.js'];");
    expect(() => transpiler.transformSync(read('lib/office2md.js'))).not.toThrow();
  });

  test('popup has the Office → Markdown checkboxes', () => {
    for (const id of ['optMdSlides', 'optMdDocs', 'optMdSheets', 'optMdPictures']) expect(read('popup.html')).toContain(`id="${id}"`);
  });

  test('popup has a Cancel button wired to the content script', () => {
    expect(read('popup.html')).toContain('id="cancel"');
    expect(read('popup.js')).toContain("{ cmd: 'cancel' }");
    expect(read('content.js')).toContain("if (msg.cmd === 'cancel') cancelRun();");
  });

  test('popup has video/audio checkboxes and sends them with start', () => {
    const html = read('popup.html');
    expect(html).toContain('id="optVideo"');
    expect(html).toContain('id="optAudio"');
    expect(read('popup.js')).toContain("{ cmd: 'start', options: readOptions() }");
    expect(read('content.js')).toContain('run(msg.options)');
  });

  test('no remote scripts in popup.html', () => {
    expect(read('popup.html')).not.toMatch(/<script[^>]+src=["']https?:/i);
  });

  test('content.js has exactly one fetch() and it is GET-only', () => {
    const src = read('content.js');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // ignore comments
    const calls = code.match(/\bfetch\(/g) || [];
    expect(calls).toHaveLength(1);
    expect(src).toMatch(/fetch\(url, \{ method: 'GET', credentials: 'include'/);
    expect(src).not.toMatch(/method:\s*['"]POST/i);
    expect(src).not.toMatch(/\.submit\(\)/);
  });

  test('schedule.js has exactly one fetch(): a POST restricted to the two CELCAT read endpoints', () => {
    const src = read('schedule.js');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/\bfetch\(/g) || []).toHaveLength(1);
    expect(src).toContain("const ENDPOINTS = { calendar: '/Home/GetCalendarData', event: '/Home/GetSideBarEvent' };");
    expect(src).toMatch(/if \(!Object\.values\(ENDPOINTS\)\.includes\(path\)\) throw/);
    expect(src).toMatch(/fetch\(location\.origin \+ path, \{\s*method: 'POST'/);
    expect(src).not.toMatch(/\.submit\(\)/);
    expect(src).not.toMatch(/XMLHttpRequest\(/);
  });

  test('popup has the schedule range and format controls', () => {
    const html = read('popup.html');
    for (const id of ['scheduleUI', 'dateFrom', 'dateTo', 'fmtIcs', 'fmtGcsv', 'fmtMd', 'fmtJson', 'fmtCsv']) expect(html).toContain(`id="${id}"`);
  });

  test('all selectors live in the SELECTORS object at the top', () => {
    const src = read('content.js');
    expect(src.indexOf('const SELECTORS = {')).toBeLessThan(src.indexOf('function guard('));
  });
});
