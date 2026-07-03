// Floating-control layout: load button outside the prompt sidebar (top-left),
// find/select top-right, GitHub corner at the bottom-right.
//
// Env: BASE_URL (default http://localhost:5757), CHROMIUM_BIN

import { launchBrowser, CONTEXT } from './launch.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:5757';
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  return !!cond;
};

const browser = await launchBrowser();
const ctx = await browser.newContext(CONTEXT);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 15000 });

  // ---------- load button sits outside (right of) the open sidebar ----------
  const pos = await page.evaluate(() => {
    const load = document.getElementById('reloadBtn').getBoundingClientRect();
    const side = document.getElementById('sidebar').getBoundingClientRect();
    const find = document.getElementById('searchBtn').getBoundingClientRect();
    const sel = document.getElementById('selectBtn').getBoundingClientRect();
    return { load, side, find, sel, w: innerWidth, h: innerHeight };
  });
  ok('load button is left-anchored (top-left region)', pos.load.left < pos.w / 3, `left=${Math.round(pos.load.left)}`);
  ok('load button does not overlap the open sidebar', pos.load.left >= pos.side.right, `${Math.round(pos.load.left)} >= ${Math.round(pos.side.right)}`);
  ok('find button stays top-right', pos.find.right > pos.w - 100 && pos.find.top < 60);
  ok('select button sits left of find', pos.sel.right <= pos.find.left && pos.sel.top < 60);

  // collapsing the sidebar pulls the load button toward the left edge
  await page.click('#sidebarToggle');
  await page.waitForTimeout(300); // let the .18s transitions settle
  const collapsedLeft = await page.$eval('#reloadBtn', (n) => n.getBoundingClientRect().left);
  ok('collapsing the sidebar moves the load button left', collapsedLeft < pos.load.left, `${Math.round(pos.load.left)} -> ${Math.round(collapsedLeft)}`);
  await page.click('#sidebarToggle'); // restore

  // ---------- GitHub corner: bottom-right, linking to the repo ----------
  const corner = await page.evaluate(() => {
    const a = document.querySelector('.github-corner');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { href: a.href, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight,
             visible: getComputedStyle(a).display !== 'none' };
  });
  ok('GitHub corner present and visible', corner && corner.visible);
  ok('corner links back to the repository',
    corner && corner.href === 'https://github.com/ly4096x/ClaudeCodeTranscriptViewer', corner && corner.href);
  ok('corner hugs the bottom-right corner',
    corner && Math.abs(corner.right - corner.w) < 2 && Math.abs(corner.bottom - corner.h) < 2,
    corner && `right=${Math.round(corner.right)}/${corner.w} bottom=${Math.round(corner.bottom)}/${corner.h}`);
  // the transparent half of the corner box must not swallow clicks
  ok('corner box does not block clicks outside the triangle', await page.evaluate(() => {
    const a = document.querySelector('.github-corner');
    const r = a.getBoundingClientRect();
    const probe = document.elementFromPoint(r.left + 4, r.top + 4); // top-left of the box = empty half
    return !a.contains(probe);
  }));

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (err) {
  console.error('\nLAYOUT-CHECK ERROR:', err && err.stack || err);
  await browser.close();
  process.exit(2);
}
