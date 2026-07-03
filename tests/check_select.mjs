// Selective mode: checkbox picking + show-only-selected filtering.
//
// Env: BASE_URL (default http://localhost:5757), CHROMIUM_BIN, SHOT_DIR

import { launchBrowser, CONTEXT } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5757';
const SHOT_DIR = path.resolve(process.env.SHOT_DIR || 'tests/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

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

  // ---------- 1. entering select mode ----------
  ok('select button visible after load', await page.$('#selectBtn:not([hidden])'));
  const firstRect = (p) => p.$eval('#transcript [data-item]', (n) => {
    const r = n.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width };
  });
  const rectBefore = await firstRect(page);
  await page.click('#selectBtn');
  ok('body enters select-mode', await page.evaluate(() => document.body.classList.contains('select-mode')));
  const boxCount = await page.$$eval('#transcript .sel-check',
    (ns) => ns.filter((n) => getComputedStyle(n).display !== 'none').length);
  const itemCount = await page.$$eval('#transcript [data-item]', (ns) => ns.length);
  ok('a visible checkbox precedes every item', itemCount > 0 && boxCount === itemCount, `${boxCount}/${itemCount}`);
  ok('action bar reads "0 selected"', (await page.textContent('#selCount')).trim() === '0 selected');
  ok('"show selected" disabled while nothing is checked', await page.$eval('#selApply', (n) => n.disabled));
  ok('checkbox uses the themed (custom) style, not the native look',
    await page.$eval('#transcript .sel-check', (n) => getComputedStyle(n).appearance === 'none'));
  const rectAfter = await firstRect(page);
  ok('entering select mode does not move or resize the content',
    rectBefore.top === rectAfter.top && rectBefore.left === rectAfter.left && rectBefore.width === rectAfter.width,
    JSON.stringify({ rectBefore, rectAfter }));
  ok('action bar floats at the bottom, clear of the first item', await page.evaluate(() => {
    const bar = document.getElementById('selectBar').getBoundingClientRect();
    const first = document.querySelector('#transcript [data-item]').getBoundingClientRect();
    const overlap = !(bar.top >= first.bottom || bar.bottom <= first.top ||
                      bar.left >= first.right || bar.right <= first.left);
    return bar.top > innerHeight / 2 && !overlap;
  }));
  await page.screenshot({ path: path.join(SHOT_DIR, '10-select-mode.png') });

  // clicking anywhere on the item toggles its box (not just the box itself)
  const tgl = await page.evaluate(() => {
    const node = document.querySelector('#transcript .row.msg-assistant[data-item]');
    const box = node.querySelector('.sel-check');
    const before = box.checked;
    node.querySelector('.body').click();
    const after = box.checked;
    node.querySelector('.body').click();
    return { before, after, restored: box.checked };
  });
  ok('clicking the item body toggles its checkbox', tgl.after === !tgl.before && tgl.restored === tgl.before);
  // fold/expand interactions are suppressed while picking
  const foldCheck = await page.evaluate(() => {
    const head = document.querySelector('#transcript .thinking-head');
    if (!head) return null;
    const body = head.parentNode.querySelector('.thinking-body');
    const shownBefore = body.style.display !== 'none';
    head.click();
    return { shownBefore, shownAfter: body.style.display !== 'none' };
  });
  if (foldCheck) ok('folds are suppressed while picking (click selects instead)',
    foldCheck.shownBefore === foldCheck.shownAfter);
  await page.click('#selNone'); // reset the clicks above

  // ---------- 2. picking items ----------
  // check one user prompt, one assistant row and one tool row
  const picked = await page.evaluate(() => {
    const out = [];
    for (const s of ['.row.msg-user', '.row.msg-assistant', '.row.msg-tool']) {
      const node = document.querySelector(`#transcript ${s}[data-item]`);
      if (node) { node.querySelector('.sel-check').click(); out.push(Number(node.dataset.item)); }
    }
    return out.sort((a, b) => a - b);
  });
  ok('count follows the checks', (await page.textContent('#selCount')).trim() === `${picked.length} selected`,
    `picked items ${picked.join(',')}`);
  ok('checked items get the selected highlight',
    (await page.$$eval('#transcript .sel-selected', (ns) => ns.length)) === picked.length);
  ok('"show selected" enabled once something is checked', !(await page.$eval('#selApply', (n) => n.disabled)));

  // ---------- 3. all / none ----------
  await page.click('#selAll');
  ok('"all" checks every rendered box',
    await page.$$eval('#transcript .sel-check', (ns) => ns.length > 0 && ns.every((n) => n.checked)));
  await page.click('#selNone');
  ok('"none" clears every box',
    await page.$$eval('#transcript .sel-check', (ns) => ns.every((n) => !n.checked)));
  ok('count back to 0 and apply disabled again',
    (await page.textContent('#selCount')).trim() === '0 selected' && await page.$eval('#selApply', (n) => n.disabled));

  // re-check the original picks
  await page.evaluate((idxs) => {
    for (const i of idxs) document.querySelector(`#transcript [data-item="${i}"] .sel-check`).click();
  }, picked);

  // ---------- 4. filtered view ----------
  await page.click('#selApply');
  ok('filtered view leaves select-mode (no checkbox gutter)',
    await page.evaluate(() => !document.body.classList.contains('select-mode')));
  const shown = await page.$$eval('#transcript [data-item]', (ns) => ns.map((n) => Number(n.dataset.item)));
  ok('only the selected items are rendered, in order',
    JSON.stringify(shown) === JSON.stringify(picked), `shown ${shown.join(',')}`);
  ok('no checkboxes in the filtered view', (await page.$$('#transcript .sel-check')).length === 0);
  ok('bar reads "showing N of M items"',
    /^showing \d+ of \d+ items$/.test((await page.textContent('#selCount')).trim()),
    (await page.textContent('#selCount')).trim());
  ok('"edit selection" replaces the picking buttons',
    await page.$('#selEdit:not([hidden])') && !(await page.$('#selApply:not([hidden])')));
  ok('action bar stays at the bottom in the filtered view', await page.evaluate(() => {
    const bar = document.getElementById('selectBar').getBoundingClientRect();
    const first = document.querySelector('#transcript [data-item]').getBoundingClientRect();
    const overlap = !(bar.top >= first.bottom || bar.bottom <= first.top ||
                      bar.left >= first.right || bar.right <= first.left);
    return bar.top > innerHeight / 2 && !overlap;
  }));
  // sidebar lists exactly the visible user prompts
  const sidebarN = await page.$$eval('#sidebarList .sidebar-item', (ns) => ns.length);
  const promptN = await page.$$eval('#transcript .row.msg-user:not(.command)', (ns) => ns.length);
  ok('sidebar indexes only the visible prompts', sidebarN === promptN, `${sidebarN} entries / ${promptN} prompts`);
  await page.screenshot({ path: path.join(SHOT_DIR, '11-filtered.png') });

  // ---------- 5. edit selection (checks preserved) ----------
  await page.click('#selEdit');
  ok('edit returns to select-mode with the full list',
    await page.evaluate(() => document.body.classList.contains('select-mode')) &&
    (await page.$$eval('#transcript [data-item]', (ns) => ns.length)) === itemCount);
  const restored = await page.$$eval('#transcript .sel-check',
    (ns) => ns.filter((n) => n.checked).map((n) => Number(n.parentNode.dataset.item)).sort((a, b) => a - b));
  ok('previous checks are preserved', JSON.stringify(restored) === JSON.stringify(picked), restored.join(','));

  // ---------- 6. back to normal mode ----------
  await page.click('#selExit');
  ok('exit hides the action bar and checkbox gutter',
    await page.evaluate(() => document.getElementById('selectBar').hidden &&
      !document.body.classList.contains('select-mode')));
  ok('full transcript still rendered after exit',
    (await page.$$eval('#transcript [data-item]', (ns) => ns.length)) === itemCount);
  ok('no checkbox remains visible',
    await page.$$eval('#transcript .sel-check', (ns) => ns.every((n) => getComputedStyle(n).display === 'none')));

  // ---------- 7. the floating button also exits a filtered view ----------
  await page.click('#selectBtn'); // enter (previous checks are still set)
  await page.click('#selNone');
  await page.evaluate((i) => document.querySelector(`#transcript [data-item="${i}"] .sel-check`).click(), picked[0]);
  await page.click('#selApply'); // filter down to one item
  await page.click('#selectBtn'); // toggle off from filtered
  ok('select button exits the filtered view back to normal',
    (await page.$$eval('#transcript [data-item]', (ns) => ns.length)) === itemCount &&
    await page.evaluate(() => document.getElementById('selectBar').hidden));

  // ---------- 8. toggling on a scrolled page keeps the viewport fixed ----------
  const probeIdx = await page.$$eval('#transcript [data-item]',
    (ns) => ns[Math.floor(ns.length / 2)].dataset.item);
  const probe = (p) => p.evaluate((idx) => {
    const v = document.getElementById('view');
    const n = document.querySelector(`#transcript [data-item="${idx}"]`);
    return { st: v.scrollTop, top: n.getBoundingClientRect().top };
  }, probeIdx);
  await page.evaluate(() => {
    const v = document.getElementById('view');
    v.scrollTop = Math.floor((v.scrollHeight - v.clientHeight) / 2);
  });
  const scrolled = await page.evaluate(() => document.getElementById('view').scrollTop > 0);
  if (scrolled) {
    const pBefore = await probe(page);
    await page.click('#selectBtn'); // enter
    const pIn = await probe(page);
    await page.click('#selectBtn'); // exit
    const pOut = await probe(page);
    ok('entering select mode keeps scroll + on-screen position (long transcript)',
      pBefore.st === pIn.st && pBefore.top === pIn.top, JSON.stringify({ pBefore, pIn }));
    ok('leaving select mode keeps scroll + on-screen position',
      pBefore.st === pOut.st && pBefore.top === pOut.top, JSON.stringify({ pBefore, pOut }));
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (err) {
  console.error('\nSELECT-CHECK ERROR:', err && err.stack || err);
  try { await page.screenshot({ path: path.join(SHOT_DIR, 'select-error.png') }); } catch {}
  await browser.close();
  process.exit(2);
}
