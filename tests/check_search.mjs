// Verify the in-conversation search: Ctrl/Cmd-F handler, search button,
// match highlighting, prev/next navigation, render-on-navigate into later
// batches, and close/clear behavior.
import { launchBrowser, CONTEXT } from './launch.mjs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5858';
const SHOT = path.resolve('tests/screenshots');
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT);

try {
  // small batch so most matches live in not-yet-rendered batches
  await page.goto(`${BASE}/?batch=40`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.session-box', { timeout: 20000 });

  ok('search button visible when a transcript is loaded', !(await page.$eval('#searchBtn', (n) => n.hidden)));

  // Ctrl+F opens the find bar and focuses the input (handler intercepts browser find)
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(100);
  ok('Ctrl/Cmd+F opens the find bar', !(await page.$eval('#searchBar', (n) => n.hidden)));
  ok('find input is focused after Ctrl/Cmd+F', await page.evaluate(() => document.activeElement && document.activeElement.id === 'searchInput'));

  const rowsBefore = await page.$$eval('.row', (n) => n.length);

  // type a query that occurs many times throughout the transcript
  await page.fill('#searchInput', 'TaskPlanner');
  await page.waitForTimeout(250);
  const count1 = await page.$eval('#searchCount', (n) => n.textContent);
  ok('query shows a match count', /^\d+\/\d+$/.test(count1) && !/^0\//.test(count1), count1);
  ok('an active highlight is shown', await page.$('mark.search-hit.active'));
  ok('current match is bright yellow', await page.evaluate(() => {
    const a = document.querySelector('mark.search-hit.active');
    return !!a && getComputedStyle(a).backgroundColor === 'rgb(255, 212, 0)';
  }));

  // Enter advances to the next match
  await page.click('#searchInput');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const count2 = await page.$eval('#searchCount', (n) => n.textContent);
  ok('Enter advances to the next match', count2 !== count1, `${count1} -> ${count2}`);

  // Shift+Enter from the first match wraps to the LAST match (deep in the file),
  // which must render the batches in between (render-on-navigate).
  await page.fill('#searchInput', 'cargo');
  await page.waitForTimeout(250);
  await page.click('#searchInput');
  await page.keyboard.press('Shift+Enter'); // wrap to last match
  await page.waitForTimeout(300);
  const rowsAfter = await page.$$eval('.row', (n) => n.length);
  ok('navigating to a deep match renders later batches', rowsAfter > rowsBefore, `${rowsBefore} -> ${rowsAfter}`);

  // active match is scrolled into the viewport
  const inView = await page.evaluate(() => {
    const a = document.querySelector('mark.search-hit.active');
    if (!a) return false;
    const r = a.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  ok('active match is scrolled into view', inView);
  await page.screenshot({ path: path.join(SHOT, '14-search.png') });

  // ---- per-kind scope toggle buttons ----
  const scopes = await page.evaluate(() => [...document.querySelectorAll('#searchScopes .search-toggle')]
    .map((b) => ({ id: b.dataset.scope, on: b.classList.contains('on'), label: b.textContent })));
  ok('one toggle button per scope is rendered', scopes.length === 7, `count=${scopes.length}`);
  ok('default-on scopes are prompt/answer/tool', ['prompt', 'answer', 'tool'].every((id) => scopes.find((s) => s.id === id)?.on));
  ok('meta scopes off by default (thinking/summary/skill/system)', ['thinking', 'summary', 'skill', 'system'].every((id) => !scopes.find((s) => s.id === id)?.on));
  // distinct states: activated (on) = brand fill; off = transparent (hover/active styling verified visually)
  ok('activated (on) button is brand-filled', (await page.$eval('[data-scope="tool"]', (n) => getComputedStyle(n).backgroundColor)) === 'rgb(217, 119, 87)');
  ok('inactive (off) button is not filled', (await page.$eval('[data-scope="skill"]', (n) => getComputedStyle(n).backgroundColor)) === 'rgba(0, 0, 0, 0)');

  // "considering" appears only inside thinking blocks in this sample.
  await page.fill('#searchInput', 'considering');
  await page.waitForTimeout(250);
  const offCount = await page.$eval('#searchCount', (n) => n.textContent);
  ok('thinking content is excluded from search by default', /^0\/0$/.test(offCount), offCount);

  // enable the "thinking" scope -> those collapsed matches are found AND auto-revealed
  await page.click('[data-scope="thinking"]');
  await page.waitForTimeout(250);
  ok('thinking scope button shows activated state', await page.$eval('[data-scope="thinking"]', (n) => n.classList.contains('on')));
  const onTotal = Number((await page.$eval('#searchCount', (n) => n.textContent)).split('/')[1] || 0);
  ok('enabling thinking scope includes its content', onTotal > 0, `total=${onTotal}`);
  let allVisible = true;
  for (let k = 0; k < onTotal; k++) {
    const vis = await page.evaluate(() => {
      const a = document.querySelector('mark.search-hit.active');
      return !!(a && a.offsetParent !== null); // offsetParent null => inside display:none
    });
    if (!vis) { allVisible = false; break; }
    await page.click('#searchInput');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
  }
  ok('matches in collapsed thinking/folded blocks auto-expand & show (bug fix)', allVisible, `checked ${onTotal}`);
  await page.click('[data-scope="thinking"]'); // turn thinking back off
  await page.waitForTimeout(150);

  // ---- auto-unfold of a CLAMPED tool result must resync its expand toggle ----
  // ("toolbox" appears deep inside long, clamped Bash outputs.)
  await page.fill('#searchInput', 'toolbox');
  await page.waitForTimeout(250);
  const tbTotal = Number((await page.$eval('#searchCount', (n) => n.textContent)).split('/')[1] || 0);
  let foundClamped = false, toggleSynced = true;
  for (let k = 0; k < Math.min(tbTotal, 80); k++) {
    const r = await page.evaluate(() => {
      const a = document.querySelector('mark.search-hit.active');
      const pre = a && a.closest('.result-pre');
      const tog = pre && pre.parentNode.querySelector('.expand-toggle');
      if (!tog) return null;                 // this match's result was never clamped
      return { clamped: pre.classList.contains('clamped'), label: tog.textContent };
    });
    if (r) {
      foundClamped = true;
      // after auto-unfold the result must be un-clamped AND its toggle says "show less"
      if (r.clamped || /click to expand|show more/.test(r.label)) toggleSynced = false;
    }
    await page.click('#searchInput');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(35);
  }
  ok('search reaches matches inside clamped tool results', foundClamped, `total=${tbTotal}`);
  ok('auto-unfolded result toggle resyncs (no stale "click to expand")', toggleSynced);

  // ---- REGEX search ----
  await page.click('#searchRegex');
  await page.waitForTimeout(60);
  ok('regex toggle turns on', await page.$eval('#searchRegex', (n) => n.classList.contains('on')));
  await page.fill('#searchInput', 'cargo|toml');
  await page.waitForTimeout(250);
  const reCount = await page.$eval('#searchCount', (n) => n.textContent);
  ok('regex alternation matches', /^[1-9]\d*\/[1-9]\d*$/.test(reCount), reCount);
  ok('regex match is highlighted & visible', await page.evaluate(() => {
    const a = document.querySelector('mark.search-hit.active');
    return !!(a && a.offsetParent !== null);
  }));
  // invalid regex is reported, not thrown
  await page.fill('#searchInput', '[');
  await page.waitForTimeout(200);
  ok('invalid regex is flagged (not crashing)', await page.$eval('#searchCount', (n) => /bad/i.test(n.textContent) && n.classList.contains('none')));
  await page.click('#searchRegex'); // turn regex back off
  await page.waitForTimeout(60);

  // ---- CASE SENSITIVITY ----
  await page.fill('#searchInput', 'task'); // appears as both "task" and "Task"
  await page.waitForTimeout(250);
  const ci = Number((await page.$eval('#searchCount', (n) => n.textContent)).split('/')[1] || 0);
  await page.click('#searchCase');
  await page.waitForTimeout(250);
  ok('case toggle turns on', await page.$eval('#searchCase', (n) => n.classList.contains('on')));
  const cs = Number((await page.$eval('#searchCount', (n) => n.textContent)).split('/')[1] || 0);
  ok('case-sensitive search returns fewer matches', cs > 0 && cs < ci, `${ci} -> ${cs}`);
  await page.click('#searchCase'); // back off
  await page.waitForTimeout(120);

  // a no-result query marks the count and clears highlights
  await page.fill('#searchInput', 'zzzznotpresentqut');
  await page.waitForTimeout(250);
  const noneCls = await page.$eval('#searchCount', (n) => n.classList.contains('none'));
  const noMarks = (await page.$$('mark.search-hit')).length === 0;
  ok('no-result query shows 0/0 and clears highlights', noneCls && noMarks);

  // Escape closes the bar and clears all highlights
  await page.click('#searchInput');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const closed = await page.$eval('#searchBar', (n) => n.hidden);
  const cleared = (await page.$$('mark.search-hit')).length === 0;
  ok('Escape closes the find bar and clears highlights', closed && cleared);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error('ERROR:', e && e.stack || e);
  try { await page.screenshot({ path: path.join(SHOT, 'search-error.png') }); } catch {}
  await browser.close();
  process.exit(2);
}
