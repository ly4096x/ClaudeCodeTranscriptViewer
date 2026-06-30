// Playwright verification — drives a REAL, non-headless Chromium against the
// running viewer, asserts the Claude Code-style layout, exercises the upload
// path and interactions, and captures screenshots for visual inspection.
//
// Env:
//   BASE_URL     (default http://localhost:5757)
//   CHROMIUM_BIN (optional path to a system chromium; used as executablePath)
//   SAMPLE       (default ./sample/sample-session.jsonl) for the upload test
//   SHOT_DIR     (default ./tests/screenshots)

import { launchBrowser, CONTEXT } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5757';
const SAMPLE = path.resolve(process.env.SAMPLE || 'sample/sample-session.jsonl');
const SHOT_DIR = path.resolve(process.env.SHOT_DIR || 'tests/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  return !!cond;
};

const browser = await launchBrowser(); // real, non-headless, maximized window
const ctx = await browser.newContext(CONTEXT);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });

try {
  // ---------- 1. auto-load from server ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 15000 });
  ok('server auto-loaded transcript (welcome/session box present)', await page.$('.session-box'));

  const landingHidden = await page.$eval('#landing', (n) => n.hidden);
  ok('landing/upload screen hidden after auto-load', landingHidden);

  // ---------- 2. core Claude Code message types render ----------
  const counts = await page.evaluate(() => ({
    assistant: document.querySelectorAll('.msg-assistant').length,
    tool: document.querySelectorAll('.msg-tool').length,
    user: document.querySelectorAll('.msg-user').length,
    thinking: document.querySelectorAll('.msg-thinking').length,
    bullets: document.querySelectorAll('.bullet').length,
    connectors: document.querySelectorAll('.connector .elbow').length,
  }));
  ok('assistant prose rows render', counts.assistant > 0, `count=${counts.assistant}`);
  ok('tool-call rows render', counts.tool > 0, `count=${counts.tool}`);
  ok('user rows render', counts.user > 0, `count=${counts.user}`);
  ok('thinking rows render', counts.thinking > 0, `count=${counts.thinking}`);
  ok('⏺ bullets present', counts.bullets > 0, `count=${counts.bullets}`);
  ok('⎿ result connectors present', counts.connectors > 0, `count=${counts.connectors}`);

  // ---------- 3. NO statusline and NO chat input box ----------
  // (the search field is a find box, not a chat prompt — it is excluded)
  const noChatInput = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea');
    const textInputs = [...document.querySelectorAll('input')].filter((i) => {
      if (i.id === 'searchInput' || i.closest('#searchBar')) return false; // find box, allowed
      const t = (i.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url', ''].includes(t);
    });
    return textareas.length === 0 && textInputs.length === 0;
  });
  ok('no chat input/textarea present (only the find box, no chat prompt)', noChatInput);
  // a "statusline" would be a fixed bottom bar; assert none exists
  const noStatusline = await page.evaluate(() => {
    return ![...document.querySelectorAll('body *')].some((e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return s.position === 'fixed' && r.bottom >= window.innerHeight - 2 && r.top > window.innerHeight - 60 && r.width > window.innerWidth * 0.6;
    });
  });
  ok('no bottom statusline bar present', noStatusline);

  // ---------- 4. palette / theme sanity ----------
  const theme = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const root = getComputedStyle(document.documentElement);
    return {
      bg: cs.backgroundColor,
      font: cs.fontFamily,
      claude: root.getPropertyValue('--claude').trim(),
      spark: (() => { const s = document.querySelector('.session-title .spark'); return s ? getComputedStyle(s).color : ''; })(),
    };
  });
  ok('dark background applied', /rgb\(2[0-9], 2[0-9], 2[0-9]\)|rgb\(26, 25, 23\)/.test(theme.bg), theme.bg);
  ok('monospace font stack applied', /mono|menlo|consolas|cascadia|fira/i.test(theme.font), theme.font.slice(0, 40));
  ok('Claude brand orange defined (#d97757)', theme.claude.toLowerCase() === '#d97757', theme.claude);
  ok('welcome spark uses brand orange', /217, 119, 87/.test(theme.spark) || theme.spark.toLowerCase().includes('d97757'), theme.spark);

  // ---------- 5. screenshot: initial viewport ----------
  await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') });

  // full transcript element shot (entire rendered content)
  const tx = await page.$('.transcript');
  await tx.screenshot({ path: path.join(SHOT_DIR, '02-transcript-full.png') }).catch((e) => console.log('  (full shot skipped:', e.message, ')'));

  // ---------- 6. interaction: expand a thinking block ----------
  const thinkHead = await page.$('.thinking-head');
  if (thinkHead) {
    await thinkHead.scrollIntoViewIfNeeded();
    const before = await page.$eval('.thinking-body', (n) => getComputedStyle(n).display);
    await thinkHead.click();
    await page.waitForTimeout(150);
    const after = await page.$eval('.thinking-body', (n) => getComputedStyle(n).display);
    ok('thinking block expands on click', before === 'none' && after !== 'none', `${before} -> ${after}`);
    await page.screenshot({ path: path.join(SHOT_DIR, '03-thinking-expanded.png') });
  } else {
    ok('thinking block expands on click', false, 'no thinking head found');
  }

  // ---------- 7. interaction: a tool diff is rendered ----------
  const hasDiff = await page.$('.diff-line.add, .diff-line.del');
  ok('Edit/Write diff lines render (green/red)', hasDiff);
  if (hasDiff) {
    await hasDiff.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOT_DIR, '04-diff.png') });
  }

  // ---------- 7b. incremental "Load more" pagination ----------
  await page.goto(`${BASE}/?batch=40`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 15000 });
  const barShown = await page.$('#loadMoreBar:not([hidden])');
  ok('"Load more" bar appears when items exceed a batch', barShown);
  const rowsBefore = await page.$$eval('.row', (n) => n.length);
  if (barShown) await page.click('#loadMoreBtn');
  const rowsAfter = await page.$$eval('.row', (n) => n.length);
  ok('clicking "Load more" appends more rows', rowsAfter > rowsBefore, `${rowsBefore} -> ${rowsAfter}`);
  // drain the rest and confirm the bar disappears
  let guard = 0;
  while (await page.$('#loadMoreBar:not([hidden])') && guard++ < 500) await page.click('#loadMoreBtn');
  ok('"Load more" bar hides once all items are rendered', !(await page.$('#loadMoreBar:not([hidden])')));

  // ---------- 8. upload path: open landing, upload the sample file ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 15000 });
  await page.click('#reloadBtn');
  await page.waitForSelector('#landing:not([hidden])', { timeout: 5000 });
  ok('reload button reveals landing/upload screen', !(await page.$eval('#landing', (n) => n.hidden)));
  await page.screenshot({ path: path.join(SHOT_DIR, '05-landing.png') });
  await page.setInputFiles('#fileInput', SAMPLE);
  await page.waitForSelector('.session-box', { timeout: 15000 });
  ok('uploaded file renders transcript', await page.$('.session-box'));

  // ---------- summary ----------
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  fs.writeFileSync(path.join(SHOT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (err) {
  console.error('\nVERIFY ERROR:', err && err.stack || err);
  try { await page.screenshot({ path: path.join(SHOT_DIR, 'error.png') }); } catch {}
  await browser.close();
  process.exit(2);
}
