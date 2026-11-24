#!/usr/bin/env node
/**
 * iPad-sized regression for the new light /recorder/ page.
 * Not part of the published app.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { equiv, checkTranscript } from '../recorder/word-check.js';

const require = createRequire('/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.js');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = '1gTlRsu_nVCdeErA6uykcsGc3IikESxa2';
const TOKEN_KEY = 'kjb1.google.token.v1';
const PICK_KEY = 'vbv.drive.inboxFolder.v1';
const REPORT = path.join(ROOT, 'scripts', 'regression-last.json');
const VERSE_N = 20;
const SHOT_DIR = '/workspace/builder-notes/new-recorder/screenshots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

function parseMeta(postData) {
  const out = { name: null, parents: null, mimeType: null };
  if (!postData || typeof postData !== 'string') return out;
  const name = postData.match(/"name"\s*:\s*"([^"]+)"/);
  const mime = postData.match(/"mimeType"\s*:\s*"([^"]+)"/);
  const parents = postData.match(/"parents"\s*:\s*\[([^\]]*)\]/);
  if (name) out.name = name[1];
  if (mime) out.mimeType = mime[1];
  if (parents) out.parents = [...parents[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return out;
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel.startsWith('/recorder/')) rel = rel.slice('/recorder'.length);
  // map /recorder to folder, and also allow root of this server to be /recorder
  let file = path.join(ROOT, 'recorder', rel.replace(/^\//, ''));
  if (!file.startsWith(path.join(ROOT, 'recorder'))) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found ' + rel); return; }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const flagTests = {
  moabitess: equiv('moabitess', 'moabites') === true,
  twoToo: equiv('two', 'too') === true,
  notSimilar: equiv('ruth', 'boaz') === false,
};
const subFlags = checkTranscript('And the Moabitess said', [{ word: 'And' }, { word: 'the' }, { word: 'Moabites' }, { word: 'said' }]).flags;
const extraFlags = checkTranscript('Then she said', [{ word: 'Then' }, { word: 'hello' }, { word: 'she' }, { word: 'said' }]).flags;
const missFlags = checkTranscript('Then she said unto him', [{ word: 'Then' }, { word: 'she' }, { word: 'said' }]).flags;
flagTests.noSubForVariant = !subFlags.some((f) => f.type === 'swap' || f.type === 'sub');
flagTests.flagsExtra = extraFlags.some((f) => f.type === 'extra');
flagTests.flagsMissing = missFlags.some((f) => f.type === 'missing');

const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: '/opt/google/chrome/chrome',
  viewport: { width: 1024, height: 1366 },
  deviceScaleFactor: 1,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  permissions: ['microphone'],
});
ctx.setDefaultTimeout(120000);
await ctx.grantPermissions(['microphone'], { origin });
await ctx.addInitScript(({ TOKEN_KEY, PICK_KEY, INBOX }) => {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: 'fake-test-token-not-real', expiresAt: Date.now() + 60 * 60 * 1000 }));
    localStorage.setItem(PICK_KEY, INBOX);
  } catch (e) {}
}, { TOKEN_KEY, PICK_KEY, INBOX });

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));

const uploads = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  let host = '';
  try { host = new URL(req.url()).hostname; } catch {}
  if (/googleapis\.com|accounts\.google\.com|gstatic\.com|google\.com|huggingface|jsdelivr/i.test(host)) {
    const isUpload = /upload\/drive/i.test(req.url()) || (/\/drive\/v3\/files/i.test(req.url()) && /POST|PATCH|PUT/i.test(req.method()));
    if (isUpload) {
      let post = null; try { post = req.postData(); } catch {}
      const meta = parseMeta(post);
      uploads.push({ method: req.method(), url: req.url(), meta, at: Date.now() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'mock-' + uploads.length, name: meta.name || 'mock.wav', parents: meta.parents || [INBOX], mimeType: 'audio/wav', size: '4000' }) });
    }
    if (/\/drive\/v3\/files/i.test(req.url()) && req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* blocked */' });
  }
  return route.continue();
});

await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.VBV && window.VBVDrive && window.KJVRec && window.VBVStages && window.DotsMap && window.KJVAudio, { timeout: 30000 });
await page.waitForFunction(() => window.TTBible, { timeout: 10000 });
await page.evaluate(() => window.TTBible.load());
await page.waitForSelector('#vbvBooks .vbvg-book', { timeout: 20000 });

await page.screenshot({ path: path.join(SHOT_DIR, 'tracker-books-1024x1366.png'), fullPage: true });

// Open Ruth
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#vbvBooks .vbvg-book')].find((b) => /Ruth/i.test(b.textContent || ''));
  if (btn) btn.click();
});
await page.waitForSelector('#vbvMap .vbvg-recbtn', { timeout: 15000 });
await page.screenshot({ path: path.join(SHOT_DIR, 'tracker-ruth-1024x1366.png'), fullPage: true });

const css = await page.evaluate(() => {
  const row = document.createElement('div');
  row.className = 'chk-row';
  row.innerHTML = '<div class="chk-head"><strong>Ruth 1.1</strong><span class="chk-note">Missing “and”</span></div><div class="chk-acts"></div>';
  ['Listen', 'Ignore', 'Re-record'].forEach((lab) => {
    const b = document.createElement('button');
    b.className = 'chk-btn';
    b.textContent = lab;
    row.querySelector('.chk-acts').appendChild(b);
  });
  row.style.position = 'absolute';
  row.style.left = '-9999px';
  document.body.appendChild(row);
  const cs = getComputedStyle(row);
  const bcs = getComputedStyle(row.querySelector('.chk-btn'));
  const acts = getComputedStyle(row.querySelector('.chk-acts'));
  const out = {
    flexDir: acts.flexDirection,
    btnMinH: parseFloat(bcs.minHeight) || parseFloat(bcs.height) || 0,
    btnFont: parseFloat(bcs.fontSize) || 0,
    reservedH: parseFloat(cs.minHeight) || 0,
    rowWidth: row.getBoundingClientRect().width,
  };
  row.remove();
  return out;
});

function toneWav(seconds, silent) {
  // built in the page with KJVAudio
}

const nav = await page.evaluate(() => {
  const unit = VBV.idsFor('RUT', 1);
  VBV.openVerseRecorder(unit, unit.ids[0]);
  const prev = document.getElementById('prevVerse');
  const next = document.getElementById('nextVerse');
  const rec = document.getElementById('recBtn');
  const recCs = getComputedStyle(rec);
  const prevCs = getComputedStyle(prev);
  const inBar = !!(prev && next && rec && prev.parentElement && prev.parentElement.classList.contains('rec-bar') && next.parentElement === prev.parentElement && rec.parentElement === prev.parentElement);
  const sameStyle = prevCs.fontSize === recCs.fontSize && prevCs.minHeight === recCs.minHeight;
  const atStart = { verse: KJVRec.currentVerse(), prevDisabled: prev.disabled, nextDisabled: next.disabled, prevLabel: prev.textContent, nextLabel: next.textContent };
  next.click();
  const afterNext = KJVRec.currentVerse();
  prev.click();
  const afterPrev = KJVRec.currentVerse();
  VBV.openVerseRecorder(unit, unit.ids[unit.ids.length - 1]);
  next.click();
  const across = { verse: KJVRec.currentVerse() };
  VBV.openVerseRecorder(VBV.idsFor('GEN', 1), 'GEN.1.1');
  const atGen = { verse: KJVRec.currentVerse(), prevDisabled: document.getElementById('prevVerse').disabled, nextDisabled: document.getElementById('nextVerse').disabled };
  const lastId = DotsMap.verseId(DotsMap.TOTAL - 1);
  const lastUnit = VBV.idsFor(lastId.split('.')[0], +lastId.split('.')[1]);
  VBV.openVerseRecorder(lastUnit, lastId);
  const atEnd = { verse: KJVRec.currentVerse(), prevDisabled: document.getElementById('prevVerse').disabled, nextDisabled: document.getElementById('nextVerse').disabled };
  // restore Ruth 1.1 for the rest of the suite
  VBV.openVerseRecorder(unit, unit.ids[0]);
  return { inBar, sameStyle, atStart, afterNext, afterPrev, across, atGen, atEnd, lastId, btnMinH: parseFloat(prevCs.minHeight) };
});

const verseRun = await page.evaluate(async ({ VERSE_N, INBOX }) => {
  const A = window.KJVAudio;
  const sr = 48000;
  function makeWav(silent) {
    const n = Math.floor(sr * 2);
    const samples = new Float32Array(n);
    if (!silent) {
      for (let i = Math.floor(sr * 0.2); i < n - Math.floor(sr * 0.2); i++) {
        samples[i] = 0.08 * Math.sin(2 * Math.PI * 180 * (i / sr));
      }
    }
    const norm = A.normalize(samples, sr);
    return { wav: A.encodeWav(norm.samples, sr), lufs: norm.lufsAfter };
  }

  const unit = VBV.idsFor('RUT', 1);
  VBV.openVerseRecorder(unit, unit.ids[0]);
  const ids = unit.ids.slice(0, VERSE_N);
  const wavCounts = [];
  const names = [];
  const results = [];
  let firstClickMs = null;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (window.KJVRec.currentVerse() !== id) {
      VBV.openVerseRecorder(unit, id);
    }
    const made = makeWav(false);
    const t0 = performance.now();
    if (i === 0) {
      const btn = document.getElementById('tab-checks');
      let handled = null;
      const onClick = () => { handled = performance.now(); };
      document.addEventListener('click', onClick, true);
      btn.click();
      await new Promise((r) => setTimeout(r, 30));
      document.removeEventListener('click', onClick, true);
      firstClickMs = handled != null ? (handled - t0) : 9999;
      VBV.openVerseRecorder(unit, id);
    }
    const r = await KJVRec.injectTake({ verseId: id, wav: made.wav, durationS: 2, skipCheck: true, silent: false });
    names.push(KJVRec.verseFileName(id));
    wavCounts.push(KJVRec.ramTakes());
    results.push({ id, ram: r.ram, next: r.next, saveErr: !!(r.saved && r.saved.error), lufs: made.lufs });
  }

  const ticks = ids.map((id) => VBVStages.get(id) && VBVStages.get(id).st);
  const saveBtn = [...document.querySelectorAll('button')].filter((b) => /save to drive/i.test(b.textContent || '') && b.offsetParent !== null).map((b) => b.textContent.trim());

  // Flagged silence stay in IDB, not RAM
  const silence = makeWav(true);
  VBV.openVerseRecorder(unit, unit.ids[0]);
  const flagged = await KJVRec.injectTake({ verseId: unit.ids[0], wav: silence.wav, durationS: 2, skipCheck: true, silent: true });
  const alerts = await KJVRec.alerts();
  KJVRec.showView('checks');

  return {
    names,
    wavCounts,
    ticks,
    saveBtn,
    firstClickMs,
    results,
    flaggedRam: flagged.ram,
    alertCount: (alerts || []).length,
    passageTab: !!document.querySelector('[data-vbv-mode-btn="passage"]'),
    sendToVideoBot: [...document.querySelectorAll('button')].some((b) => /send to videobot/i.test(b.textContent || '')),
    progressTab: [...document.querySelectorAll('[role="tab"]')].some((b) => /progress/i.test(b.textContent || '')),
    recLabel: (document.getElementById('recBtn') || {}).textContent || '',
  };
}, { VERSE_N, INBOX });

await page.screenshot({ path: path.join(SHOT_DIR, 'recorder-verse-1024x1366.png'), fullPage: true });
await page.evaluate(() => KJVRec.showView('checks'));
await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
await page.screenshot({ path: path.join(SHOT_DIR, 'checks-1024x1366.png'), fullPage: true });

const uploadNames = uploads.map((u) => u.meta && u.meta.name).filter(Boolean);
const uploadParents = uploads.flatMap((u) => (u.meta && u.meta.parents) || []);
const stitchWrites = uploads.filter((u) => /stitch/i.test((u.meta && u.meta.name) || '') || /stitch/i.test(u.url));

const htmlBytes = fs.statSync(path.join(ROOT, 'recorder', 'index.html')).size;
const checks = {
  flagPolicy: flagTests.moabitess && flagTests.twoToo && flagTests.noSubForVariant && flagTests.flagsExtra && flagTests.flagsMissing && flagTests.notSimilar,
  smallButtons: css.btnMinH <= 32 && css.btnFont <= 16 && css.flexDir === 'row',
  reservedRow: css.reservedH >= 40,
  noSaveButton: (verseRun.saveBtn || []).length === 0,
  ramFlat: (verseRun.wavCounts || []).every((n) => n <= 1) && verseRun.flaggedRam === 0,
  ticksAfterSave: (verseRun.ticks || []).every((st) => st >= 1),
  filenames: (verseRun.names || []).every((n) => /^Ruth \d+\.\d+\.wav$/.test(n)),
  uploadsToInbox: uploads.length >= VERSE_N && uploadParents.every((p) => !p || p === INBOX),
  noStitch: stitchWrites.length === 0,
  noPassageOrProgress: !verseRun.passageTab && !verseRun.sendToVideoBot && !verseRun.progressTab,
  clickMs: verseRun.firstClickMs != null && verseRun.firstClickMs < 200,
  flaggedKept: verseRun.alertCount >= 1,
  noPageErrors: pageErrors.length === 0,
  htmlLight: htmlBytes < 100000,
  verseNav: !!(nav.inBar && nav.sameStyle
    && nav.atStart.verse === 'RUT.1.1' && nav.atStart.prevLabel === '◀ Previous verse' && nav.atStart.nextLabel === 'Next verse ▶'
    && nav.atStart.nextDisabled === false
    && nav.afterNext === 'RUT.1.2' && nav.afterPrev === 'RUT.1.1'
    && nav.across.verse === 'RUT.2.1'
    && nav.atGen.verse === 'GEN.1.1' && nav.atGen.prevDisabled === true && nav.atGen.nextDisabled === false
    && nav.atEnd.verse === nav.lastId && nav.atEnd.prevDisabled === false && nav.atEnd.nextDisabled === true),
};

const ok = Object.values(checks).every(Boolean);
const report = {
  page: 'recorder',
  ok,
  checks,
  flagTests,
  css,
  verseRun,
  uploads: { count: uploads.length, names: uploadNames.slice(0, 25), stitchWrites: stitchWrites.length },
  htmlBytes,
  pageErrors,
  shots: fs.readdirSync(SHOT_DIR).map((n) => path.join(SHOT_DIR, n)),
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok, checks, htmlBytes, uploads: uploads.length, clickMs: verseRun.firstClickMs, errors: pageErrors, css, nav }, null, 2));

await ctx.close();
server.close();
if (!ok) process.exit(1);
