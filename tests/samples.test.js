// Checks SELECTORS against real pages you saved from moodle.vinci.be.
// Save the course page with: copy(document.querySelector('#region-main').outerHTML)
// and paste it into sample-course.html at the project root. Skipped when absent.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnv, ROOT } from './harness.js';

const SAMPLE = join(ROOT, 'sample-course.html');
const has = existsSync(SAMPLE);

test.skipIf(!has)('sample-course.html: sections and activities are detected', () => {
  let markup = readFileSync(SAMPLE, 'utf8');
  if (!/<body/i.test(markup)) markup = `<html><body class="course-0">${markup}</body></html>`;
  const env = createEnv({ html: markup });
  try {
    const { topSections, SELECTORS } = env.internals;
    const doc = env.window.document;
    const secs = topSections(doc);
    const cms = [...doc.querySelectorAll(SELECTORS.activity)];
    const types = [...new Set(cms.map((c) => (c.className.match(/modtype_(\w+)/) || [])[1] || '?'))];
    const subs = [...doc.querySelectorAll('.modtype_subsection')];
    console.log({
      topSections: secs.length,
      titles: secs.map((s) => (s.querySelector(SELECTORS.sectionTitle) || {}).textContent?.trim()),
      activities: cms.length,
      types,
      subsectionsWithNestedSection: subs.filter((s) => s.querySelector(SELECTORS.section)).length + '/' + subs.length,
    });
    expect(secs.length).toBeGreaterThan(0);
    expect(cms.length).toBeGreaterThan(0);
    expect(types).not.toContain('?');
  } finally { env.close(); }
});
