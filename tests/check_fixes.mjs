// Focused verification of the four UI changes:
//   1. skill content folded by default
//   2. <task-notification> rendered as a compact, foldable line (not raw XML)
//   3. small bullet circles
//   4. gray background for user-sent messages
// Runs against a server auto-loading a transcript that contains skill content
// AND task notifications (the bundled sample = agent-toolbox c7270829).

import { launchBrowser, CONTEXT } from './launch.mjs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5858';
const SHOT = path.resolve('tests/screenshots');

const results = [];
const ok = (name, cond, detail = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT);

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 20000 });

  // ---- 1. skill content folded by default ----
  const skill = await page.$('.msg-skill');
  ok('skill content rendered as its own (folded) block', skill);
  if (skill) {
    const head = await page.$eval('.msg-skill .fold-head', (n) => n.textContent.trim());
    ok('skill fold header summarizes content', /Skill content/.test(head), head.slice(0, 50));
    const bodyDisp = await page.$eval('.msg-skill .fold-body', (n) => getComputedStyle(n).display);
    ok('skill content is hidden by default', bodyDisp === 'none', `display=${bodyDisp}`);
    await page.click('.msg-skill .fold-head');
    await page.waitForTimeout(120);
    const after = await page.$eval('.msg-skill .fold-body', (n) => getComputedStyle(n).display);
    ok('clicking expands skill content', after !== 'none', `display=${after}`);
    await page.click('.msg-skill .fold-head'); // collapse again
  }

  // ---- 2. task-notification compact + foldable, no raw XML leaking ----
  const notif = await page.$('.msg-notification');
  ok('task-notification rendered as a notification block', notif);
  if (notif) {
    const head = await page.$eval('.msg-notification .fold-head', (n) => n.textContent.trim());
    ok('notification shows parsed status/summary', /Background task/.test(head), head.slice(0, 70));
    const bodyDisp = await page.$eval('.msg-notification .fold-body', (n) => getComputedStyle(n).display);
    ok('notification raw details hidden by default', bodyDisp === 'none');
  }
  // no user-prompt should contain the raw <task-notification> tag
  const leaked = await page.evaluate(() =>
    [...document.querySelectorAll('.msg-user .utext')].some((n) => n.textContent.includes('<task-notification>')));
  ok('no raw <task-notification> leaks into a user prompt', !leaked);

  // ---- 3. small bullet circles ----
  const scale = await page.$eval('.msg-tool .bullet', (n) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(n).transform);
    return m.a; // horizontal scale factor
  });
  ok('tool bullet glyph is scaled down (small circle)', scale > 0 && scale <= 0.7, `scaleX=${scale.toFixed(2)}`);

  // ---- 4. gray background on user messages ----
  const ubg = await page.$eval('.msg-user .body', (n) => getComputedStyle(n).backgroundColor);
  ok('user message has a gray background', ubg === 'rgb(42, 39, 36)', ubg);

  // ---- 5. Bash shows the FULL (multi-line) command, not just first line ----
  const bash = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.tool-head')]
      .filter((h) => h.querySelector('.tool-name')?.textContent === 'Bash');
    const multiline = heads.find((h) => (h.querySelector('.tool-args')?.textContent || '').includes('\n'));
    const truncated = heads.some((h) => /\s…$/.test(h.querySelector('.tool-args')?.textContent || ''));
    return { count: heads.length, hasMultiline: !!multiline, truncated };
  });
  ok('Bash command shown in full across multiple lines', bash.hasMultiline, `bashHeads=${bash.count}`);
  ok('no Bash command truncated with a "…" marker', !bash.truncated);

  // ---- 6. inline-code placeholder integrity after NUL->PUA change ----
  await page.click('.msg-skill .fold-head'); // expand skill markdown (has inline `code`)
  await page.waitForTimeout(120);
  const codeCount = await page.$$eval('.md code', (n) => n.length);
  ok('inline `code` renders in markdown', codeCount > 0, `count=${codeCount}`);
  const leak = await page.evaluate(() => document.body.innerText.includes(String.fromCharCode(0xE000)));
  ok('no placeholder sentinel (U+E000) leaks into rendered text', !leak);
  await page.click('.msg-skill .fold-head'); // collapse again

  await page.screenshot({ path: path.join(SHOT, '07-fixes.png') });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error('CHECK ERROR:', e && e.stack || e);
  try { await page.screenshot({ path: path.join(SHOT, 'fixes-error.png') }); } catch {}
  await browser.close();
  process.exit(2);
}
