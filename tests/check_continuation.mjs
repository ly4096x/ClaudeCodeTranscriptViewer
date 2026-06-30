// Verify the "This session is being continued…" summary renders folded by default.
import { launchBrowser, CONTEXT } from './launch.mjs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5959';
const SHOT = path.resolve('tests/screenshots');
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT);
try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 15000 });

  const cont = await page.$('.msg-continuation');
  ok('continuation summary rendered as its own block', cont);
  const head = await page.$eval('.msg-continuation .fold-head', (n) => n.textContent.trim()).catch(() => '');
  ok('header summarizes the continuation', /Session continued/.test(head), head.slice(0, 60));
  const disp = await page.$eval('.msg-continuation .fold-body', (n) => getComputedStyle(n).display).catch(() => 'missing');
  ok('continuation summary is folded by default', disp === 'none', `display=${disp}`);

  // the raw summary text must NOT appear as a normal user prompt
  const leaked = await page.evaluate(() =>
    [...document.querySelectorAll('.msg-user .utext')].some((n) => n.textContent.includes('This session is being continued')));
  ok('summary does not leak into a user prompt', !leaked);

  await page.screenshot({ path: path.join(SHOT, '11-continuation-folded.png') });
  await page.click('.msg-continuation .fold-head');
  await page.waitForTimeout(120);
  const after = await page.$eval('.msg-continuation .fold-body', (n) => getComputedStyle(n).display);
  ok('clicking expands the summary', after !== 'none', `display=${after}`);
  await page.screenshot({ path: path.join(SHOT, '12-continuation-expanded.png') });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error('ERROR:', e && e.stack || e);
  await browser.close();
  process.exit(2);
}
