// Verify the left sidebar: lists only the user's own prompts (excludes
// auto-fed messages), click jumps to a prompt, and scrolling highlights the
// current/last prompt and scrolls the sidebar entry into view.
import { launchBrowser, CONTEXT } from './launch.mjs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5858';
const SHOT = path.resolve('tests/screenshots');
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT);

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 20000 });

  ok('sidebar is visible when a transcript is loaded', !(await page.$eval('#sidebar', (n) => n.hidden)));
  ok('transcript is shifted right for the sidebar', await page.$eval('.view', (n) => getComputedStyle(n).marginLeft === '256px'));

  const items = await page.$$('.sidebar-item');
  ok('sidebar lists user prompts', items.length >= 2, `count=${items.length}`);
  ok('first prompt is highlighted on load', await page.evaluate(() =>
    document.querySelector('.sidebar-item')?.classList.contains('active')));

  // exclusion: no auto-fed content appears in the sidebar
  const clean = await page.evaluate(() => {
    const bad = ['Base directory for this skill', '<task-notification>', 'This session is being continued', 'Launching skill'];
    return [...document.querySelectorAll('.sidebar-item')].every((b) => !bad.some((x) => b.textContent.includes(x)));
  });
  ok('sidebar excludes auto-fed prompts (skill/notification/continuation)', clean);

  // each sidebar item points at a user-prompt row
  const allUser = await page.evaluate(() => [...document.querySelectorAll('.sidebar-item')].every((b) => {
    const node = document.querySelector(`[data-item="${b.dataset.target}"]`);
    return node && node.classList.contains('msg-user');
  }));
  ok('every sidebar entry targets a user-prompt row', allUser);

  // click the LAST prompt → it scrolls into view and becomes active
  const lastIdx = items.length - 1;
  const target = await items[lastIdx].getAttribute('data-target');
  await items[lastIdx].click();
  await page.waitForTimeout(200);
  const inView = await page.evaluate((t) => {
    const node = document.querySelector(`[data-item="${t}"]`);
    if (!node) return false;
    const r = node.getBoundingClientRect();
    return r.top >= -5 && r.top < window.innerHeight * 0.6;
  }, target);
  ok('clicking a prompt jumps to it', inView);
  ok('clicked prompt is marked active in the sidebar', await page.evaluate((i) =>
    document.querySelectorAll('.sidebar-item')[i].classList.contains('active'), lastIdx));

  // scroll to the very top → the FIRST prompt becomes active (scroll-sync)
  await page.$eval('.view', (v) => { v.scrollTop = 0; });
  await page.waitForTimeout(200);
  ok('scrolling to top activates the first prompt', await page.evaluate(() =>
    document.querySelectorAll('.sidebar-item')[0].classList.contains('active')));

  // no "Prompts" header and no leading numbers
  ok('sidebar has no title header', (await page.$$('.sidebar-title')).length === 0);
  ok('sidebar items have no leading number', (await page.$$('.sidebar-item .idx')).length === 0);

  // foldable via the external "flag" toggle on top
  ok('fold toggle is visible (a flag outside the sidebar)', !(await page.$eval('#sidebarToggle', (n) => n.hidden)));
  const tgRect = await page.$eval('#sidebarToggle', (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top }; });
  ok('fold flag sits at the top, at the sidebar edge', tgRect.top < 60 && tgRect.left >= 240, JSON.stringify(tgRect));
  await page.click('#sidebarToggle');
  await page.waitForTimeout(250);
  ok('clicking the flag collapses the sidebar', await page.evaluate(() =>
    document.body.classList.contains('sidebar-collapsed') &&
    getComputedStyle(document.querySelector('.view')).marginLeft === '0px' &&
    document.querySelector('#sidebarToggle').textContent.trim() === '▶'));
  await page.click('#sidebarToggle');
  await page.waitForTimeout(250);
  ok('clicking again expands the sidebar', await page.evaluate(() =>
    !document.body.classList.contains('sidebar-collapsed') &&
    document.querySelector('#sidebarToggle').textContent.trim() === '◀'));

  // resizable via the drag handle
  const startW = await page.evaluate(() => parseInt(getComputedStyle(document.querySelector('.sidebar')).width));
  const rb = await page.$eval('#sidebarResizer', (n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
  await page.mouse.move(rb.x, rb.y);
  await page.mouse.down();
  await page.mouse.move(rb.x + 90, rb.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const endW = await page.evaluate(() => parseInt(getComputedStyle(document.querySelector('.sidebar')).width));
  ok('sidebar is resizable by dragging the handle', endW >= startW + 60, `${startW} -> ${endW}`);

  await page.screenshot({ path: path.join(SHOT, '15-sidebar.png') });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error('ERROR:', e && e.stack || e);
  try { await page.screenshot({ path: path.join(SHOT, 'sidebar-error.png') }); } catch {}
  await browser.close();
  process.exit(2);
}
