// Robustness pass: drive the viewer against several DIFFERENT real transcripts
// (varied tools, larger files) via the upload path, asserting no page errors
// and a non-trivial render for each. Catches parser edge cases on real data.

import { launchBrowser, CONTEXT } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5757';
const FILES = (process.env.FILES || '').split(',').filter(Boolean);
if (!FILES.length) {
  console.error('Set FILES=comma,separated,paths'); process.exit(2);
}

const browser = await launchBrowser();
const page = await browser.newPage(CONTEXT);

let allPass = true;
for (const f of FILES) {
  if (!fs.existsSync(f)) { console.log(`✗ ${path.basename(f)} — missing`); allPass = false; continue; }
  const errors = [];
  const onErr = (e) => errors.push(e.message);
  page.on('pageerror', onErr);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // ensure landing is available for upload
  await page.waitForTimeout(300);
  if (await page.$('#reloadBtn:not([hidden])')) await page.click('#reloadBtn');
  await page.waitForSelector('#fileInput', { state: 'attached' });
  await page.setInputFiles('#fileInput', f);
  let rendered = false;
  try { await page.waitForSelector('.session-box', { timeout: 20000 }); rendered = true; } catch {}

  // drain "Load more" to exercise the whole transcript
  let clicks = 0;
  while (await page.$('#loadMoreBar:not([hidden])') && clicks < 200) {
    await page.click('#loadMoreBtn'); clicks++;
    await page.waitForTimeout(15);
  }

  const stats = await page.evaluate(() => ({
    rows: document.querySelectorAll('.row').length,
    tools: document.querySelectorAll('.msg-tool').length,
    md: document.querySelectorAll('.md').length,
  }));
  page.off('pageerror', onErr);

  const sizeMB = (fs.statSync(f).size / 1e6).toFixed(1);
  const pass = rendered && errors.length === 0 && stats.rows > 0;
  allPass = allPass && pass;
  console.log(`${pass ? '✓' : '✗'} ${path.basename(f)} (${sizeMB}MB) — rows=${stats.rows} tools=${stats.tools} md=${stats.md} batches=${clicks + 1} pageerrors=${errors.length}`);
  if (errors.length) errors.slice(0, 3).forEach((e) => console.log('     · ' + e));
}

await browser.close();
process.exit(allPass ? 0 : 1);
