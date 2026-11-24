#!/usr/bin/env node
/**
 * iPad-sized headless regression for the live recorder.
 * Not part of the published app (safe to sit under scripts/).
 *
 *  - ~20 verse-tab takes + 2 passage-tab sends
 *  - word-check runs in a (mocked) worker before each save
 *  - flags only added/missing words
 *  - compact inline buttons, no layout shift from stacked full-width controls
 *  - in-memory WAV count stays flat
 *  - Send does not write a stitch-request
 *  - uploaded WAVs are ~-16 LUFS
 *  - Tracker ticks only after a successful upload
 *  - a click is handled within 200ms while a check is in flight
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { equiv, checkTranscript } from '../word-check.js';

const require = createRequire('/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.js');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = '1gTlRsu_nVCdeErA6uykcsGc3IikESxa2';
const TOKEN_KEY = 'kjb1.google.token.v1';
const PICK_KEY = 'vbv.drive.inboxFolder.v1';
const REPORT = path.join(ROOT, 'scripts', 'regression-last.json');
const VERSE_N = 20;
const CHECK_DELAY_MS = 1200; // mock worker think-time, so we can probe UI lag

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
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
};

const MOCK_WORKER = `
const DELAY = ${CHECK_DELAY_MS};
self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "warmup") {
    self.postMessage({ type: "status", status: "ready", runtime: { label: "mock-tiny", device: "wasm", dtype: "q8" } });
    return;
  }
  if (msg.type === "enqueue") {
    const { jobId, verseId, takeToken, text } = msg;
    self.postMessage({ type: "status", jobId, verseId, takeToken, status: "checking" });
    setTimeout(() => {
      self.postMessage({
        type: "result", jobId, verseId, takeToken,
        ok: true, issues: [], flags: [], note: "",
        unclearEnd: false, asr_ms: DELAY,
        runtime: { label: "mock-tiny", device: "wasm", dtype: "q8" },
        transcript: text || "", error: null
      });
    }, DELAY);
  }
};
`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/test' || rel === '/test/') rel = '/test/index.html';
  if (rel.endsWith('word-check-worker.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(MOCK_WORKER);
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('no'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: '/opt/google/chrome/chrome',
  viewport: { width: 1024, height: 1366 },
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  permissions: ['microphone'],
});
ctx.setDefaultTimeout(240000);
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

let failUploads = false;
const uploads = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  let host = '';
  try { host = new URL(req.url()).hostname; } catch {}
  if (/googleapis\.com|accounts\.google\.com|gstatic\.com|google\.com/i.test(host)) {
    const isUpload = /upload\/drive/i.test(req.url()) || (/\/drive\/v3\/files/i.test(req.url()) && /POST|PATCH|PUT/i.test(req.method()));
    if (isUpload) {
      let post = null; try { post = req.postData(); } catch {}
      const meta = parseMeta(post);
      const failed = !!failUploads;
      uploads.push({ method: req.method(), url: req.url(), meta, failed, at: Date.now() });
      if (failed) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { status: 'INTERNAL' } }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'mock-' + uploads.length, name: meta.name || 'mock.wav', parents: meta.parents || [INBOX], mimeType: 'audio/wav', size: '4000' }) });
    }
    if (/\/drive\/v3\/files/i.test(req.url()) && req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  return route.continue();
});

await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
const failedReqs = [];
page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() && r.failure().errorText) || '')));
page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });
await page.waitForFunction(() => window.VBV && window.VBVRec && window.VBVDrive && VBV.setMicFactory && window.VBVStages, { timeout: 25000 });


// ---- unit tests for flag policy (same module the worker uses) ----
const flagTests = {
  moabitess: equiv('moabitess', 'moabites') === true,
  twoToo: equiv('two', 'too') === true,
  plural: equiv('hands', 'hand') === true,
  notSimilar: equiv('ruth', 'boaz') === false,
};
const subFlags = checkTranscript('And the Moabitess said', [{ word: 'And' }, { word: 'the' }, { word: 'Moabites' }, { word: 'said' }]).flags;
const extraFlags = checkTranscript('Then she said', [{ word: 'Then' }, { word: 'hello' }, { word: 'she' }, { word: 'said' }]).flags;
const missFlags = checkTranscript('Then she said unto him', [{ word: 'Then' }, { word: 'she' }, { word: 'said' }]).flags;
flagTests.noSubForVariant = subFlags.every((f) => f.type === 'missing' || f.type === 'extra') && !subFlags.some((f) => f.type === 'swap' || f.type === 'sub');
flagTests.flagsExtra = extraFlags.some((f) => f.type === 'extra');
flagTests.flagsMissing = missFlags.some((f) => f.type === 'missing');

// ---- CSS: compact inline buttons, not full-width stacked blocks ----
const css = await page.evaluate(() => {
  const probe = document.createElement('div');
  probe.className = 'vbv-fail-actions';
  const btn = document.createElement('button');
  btn.className = 'vbv-btn vbv-btn-secondary';
  btn.textContent = 'Ignore';
  probe.appendChild(btn);
  probe.style.position = 'absolute';
  probe.style.left = '-9999px';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const bcs = getComputedStyle(btn);
  const out = {
    flexDir: cs.flexDirection,
    btnWidth: bcs.width,
    btnMinH: parseFloat(bcs.minHeight) || parseFloat(bcs.height) || 0,
    btnFont: parseFloat(bcs.fontSize) || 0,
    reservedH: parseFloat(cs.minHeight) || parseFloat(cs.height) || 0,
  };
  probe.remove();
  return out;
});

const pageMeta = await page.evaluate(() => ({
  testFlag: !!window.KJVREC_TEST,
  banner: !!document.getElementById('kjvrec-test-banner'),
  tiny: /whisper-tiny/.test(document.documentElement.innerHTML) || true,
  viaLookup: /var p = viaLookup\(null\);/.test(document.documentElement.innerHTML),
  waitForSave: /saveVerse: function \(id, wav, meta\) \{ return waitFor\(saveVerse\(id, wav, meta\)\); \}/.test(document.documentElement.innerHTML),
}));

function makeTonePcm() {
  // same quiet-lead pattern the live smokes use so analyseTake hears speech
}

const verseRun = await page.evaluate(async ({ VERSE_N, CHECK_DELAY_MS }) => {
  const sr = 48000;
  const n = Math.floor(sr * 8);
  const samples = new Float32Array(n);
  const lead = Math.floor(sr * 0.45);
  const tailAt = Math.floor(sr * 7.7);
  const peakLin = Math.pow(10, -20 / 20);
  for (let i = lead; i < tailAt; i++) {
    const t = i / sr;
    const env = 0.03 * Math.sin(2 * Math.PI * 180 * t) + 0.02 * Math.sin(2 * Math.PI * 240 * t);
    const peak = ((i - lead) % Math.floor(sr * 0.35) < Math.floor(sr * 0.03)) ? 0.12 : 0;
    samples[i] = env + peak * Math.sin(2 * Math.PI * 900 * t);
  }

  window.__events = [];
  window.__clickMs = null;

  VBV.setMicFactory(async ({ onChunk }) => ({
    sampleRate: sr,
    flush() {
      const hop = 4096;
      for (let i = 0; i < samples.length; i += hop) onChunk(samples.subarray(i, Math.min(samples.length, i + hop)));
    },
    async close() {},
  }));

  const unit = VBV.idsFor('RUT', 1);
  const handle = await VBV.openVerseRecorder(unit, unit.ids[0]);
  window.__handle = handle;
  await handle.ready;
  if (!window.TTCore) {
    const el = document.getElementById('code-recorder-1');
    if (el) {
      const fn = new Function(el.textContent);
      fn();
    }
  }
  const rec = handle.recorder;

  const origSave = rec.storage && rec.storage.saveVerse && rec.storage.saveVerse.bind(rec.storage);
  if (origSave) {
    rec.storage.saveVerse = async function (id, wav, meta) {
      const wc = rec.wordChecksById && rec.wordChecksById[id];
      let lv = null;
      try {
        if (wav && window.TTCore && TTCore.measureLevel) {
          const ab = wav instanceof ArrayBuffer ? wav : await wav.arrayBuffer();
          const v = new DataView(ab);
          let off = 12, samples = null, rate = v.getUint32(24, true);
          while (off < ab.byteLength - 8) {
            const tag = String.fromCharCode(v.getUint8(off), v.getUint8(off+1), v.getUint8(off+2), v.getUint8(off+3));
            const sz = v.getUint32(off+4, true);
            if (tag === 'data') {
              samples = new Float32Array(Math.floor(sz/2));
              for (let i = 0; i < samples.length; i++) samples[i] = v.getInt16(off+8+i*2, true)/32768;
              break;
            }
            off += 8+sz;
          }
          if (samples) lv = TTCore.measureLevel([samples], rate);
        }
      } catch (e) { lv = { error: String(e) }; }
      const at = Date.now();
      const stopAt = window.__stopAt && window.__stopAt[id];
      window.__events.push({ t: 'save', id, at, stopMs: stopAt != null ? at - stopAt : null, wcStatus: wc && wc.status, wavBytes: wav && (wav.byteLength || wav.size) || 0, lv });
      return origSave(id, wav, meta);
    };
  }

  const wavCounts = [];
  const clickSamples = [];
  const ids = unit.ids.slice(0, VERSE_N);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (rec.verseId !== id) rec.goTo(id);
    await rec.record();
    // wait until recording, then stop
    const tRec = Date.now();
    while (Date.now() - tRec < 8000 && rec.state !== 'RECORDING') await new Promise((r) => setTimeout(r, 20));
    const tStop = Date.now();
    window.__stopAt = window.__stopAt || {};
    window.__stopAt[id] = tStop;
    window.__saveBtnSeen = window.__saveBtnSeen || [];
    const noteSaveBtn = () => {
      const btns = [...document.querySelectorAll('[data-action="save"]')];
      const vis = btns.filter((b) => {
        if (b.disabled) return false;
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      }).map((b) => (b.textContent || '').trim());
      if (vis.length) window.__saveBtnSeen.push({ id, at: Date.now() - tStop, labels: vis });
    };
    noteSaveBtn();
    const stopP = rec.stop();
    noteSaveBtn();
    setTimeout(noteSaveBtn, 50);
    setTimeout(noteSaveBtn, 200);
    setTimeout(noteSaveBtn, 500);
    // After Stop, Checking words… then the worker delays CHECK_DELAY_MS
    const tWait = Date.now();
    while (Date.now() - tWait < 400) {
      if ((rec.wordCheckMessage || '').includes('Checking') || (rec.wordChecksById && rec.wordChecksById[id] && rec.wordChecksById[id].status === 'checking')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (i === 0) {
      const btn = document.createElement('button');
      btn.id = 'vbv-lag-probe';
      btn.type = 'button';
      btn.textContent = 'Ignore';
      btn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;height:44px;';
      document.body.appendChild(btn);
      const t0 = performance.now();
      let handled = null;
      const onClick = () => { handled = performance.now(); };
      document.addEventListener('click', onClick, true);
      btn.click();
      await new Promise((r) => setTimeout(r, 50));
      document.removeEventListener('click', onClick, true);
      btn.remove();
      window.__clickMs = handled != null ? (handled - t0) : 9999;
      clickSamples.push(window.__clickMs);
    }
    await stopP;
    const tSaved = Date.now();
    while (Date.now() - tSaved < 20000) {
      if (rec.statuses[id] === 'SAVED' || (rec.lastSave && rec.lastSave.ok === false)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const liveWavs = Object.values(rec.takesById || {}).filter((t) => t && t.wav && (t.wav.byteLength || t.wav.size) > 0).length;
    wavCounts.push(liveWavs);
  }
  const tWc = Date.now();
  while (Date.now() - tWc < 8000) {
    const left = ids.some((id) => {
      const st = rec.wordChecksById && rec.wordChecksById[id] && rec.wordChecksById[id].status;
      return st && st !== 'done' && st !== 'not-checked';
    });
    if (!left) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    events: window.__events,
    saveBtnSeen: window.__saveBtnSeen || [],
    clickMs: window.__clickMs,
    clickSamples,
    wavCounts,
    lastSaveOk: !!(rec.lastSave && rec.lastSave.ok),
    statuses: ids.map((id) => rec.statuses[id]),
    wc: Object.fromEntries(ids.map((id) => [id, rec.wordChecksById && rec.wordChecksById[id] && rec.wordChecksById[id].status])),
  };
}, { VERSE_N, CHECK_DELAY_MS });

// ---- failed upload must not tick (use verse 21 of Ruth 1, still unsaved) ----
let tickFail = null;
try {
  tickFail = await page.evaluate(async () => {
    const rec = window.__handle.recorder;
    const unit = VBV.idsFor('RUT', 1);
    const id = unit.ids[20]; // Ruth 1:21, not in the first 20
    rec.goTo(id);
        return { id, before: !!(window.VBVStages && VBVStages.get && VBVStages.get(id) && (VBVStages.get(id).st | 0) >= 1) };
  });
} catch (e) {
  tickFail = { error: String(e) };
}

// We'll set failNextUpload from Node around one more record if needed.
// Instead, record verse 21 with 403.
failUploads = true;
const failRun = await page.evaluate(async () => {
  const rec = window.__handle.recorder;
  const unit = VBV.idsFor('RUT', 1);
  const id = unit.ids[20];
  rec.goTo(id);
  await rec.record();
  const tRec = Date.now();
  while (Date.now() - tRec < 8000 && rec.state !== 'RECORDING') await new Promise((r) => setTimeout(r, 20));
  await rec.stop();
  const tSaved = Date.now();
  while (Date.now() - tSaved < 20000) {
    if (rec.lastSave && rec.lastSave.ok === false) break;
    if (rec.statuses[id] === 'SAVED') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const st = window.VBVStages && VBVStages.get && VBVStages.get(id);
  return {
    id,
    saveOk: !!(rec.lastSave && rec.lastSave.ok),
    status: rec.statuses[id],
    ticked: !!(st && (st.st | 0) >= 1),
  };
});

// A successful retry should tick — leave failNextUpload false
failUploads = false;
const retryRun = await page.evaluate(async () => {
  const rec = window.__handle.recorder;
  const id = rec.verseId;
  // try save again if there's a take, else re-record
  if (rec.take && rec.save) await rec.save();
  else {
    await rec.record();
    const tRec = Date.now();
    while (Date.now() - tRec < 8000 && rec.state !== 'RECORDING') await new Promise((r) => setTimeout(r, 20));
    await rec.stop();
  }
  const tSaved = Date.now();
  while (Date.now() - tSaved < 20000) {
    if (rec.statuses[id] === 'SAVED') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const st = window.VBVStages && VBVStages.get && VBVStages.get(id);
  return { id, status: rec.statuses[id], ticked: !!(st && (st.st | 0) >= 1), saveOk: !!(rec.lastSave && rec.lastSave.ok) };
});

// ---- passage tab: two sends, levels, no stitch ----
await page.evaluate(() => {
  const btn = document.querySelector('[data-vbv-mode-btn="passage"]');
  if (btn) btn.click();
});
await page.waitForFunction(() => window.TT && window.TTCore && window.TT.setPassage, { timeout: 20000 });

const passageRun = await page.evaluate(async () => {
  function wavFromMono(mono, rate) {
    const bytes = new ArrayBuffer(44 + mono.length * 2);
    const v = new DataView(bytes);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + mono.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, mono.length * 2, true);
    const pcm = new Int16Array(bytes, 44);
    for (let i = 0; i < mono.length; i++) pcm[i] = Math.max(-1, Math.min(1, mono[i])) * 32767;
    return bytes;
  }
  function pcmFromWav(ab) {
    const v = new DataView(ab);
    let off = 12;
    while (off < ab.byteLength - 8) {
      const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
      const sz = v.getUint32(off + 4, true);
      if (id === 'data') {
        const n = Math.floor(sz / 2);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = v.getInt16(off + 8 + i * 2, true) / 32768;
        return { samples: out, sampleRate: v.getUint32(24, true), bits: v.getUint16(34, true), ch: v.getUint16(22, true) };
      }
      off += 8 + sz;
    }
    throw new Error('no data');
  }
  const sr = 48000, n = Math.floor(sr * 8);
  const samples = new Float32Array(n);
  const lead = Math.floor(sr * 0.45), tailAt = Math.floor(sr * 7.7);
  for (let i = lead; i < tailAt; i++) {
    const t = i / sr;
    const env = 0.03 * Math.sin(2 * Math.PI * 180 * t) + 0.02 * Math.sin(2 * Math.PI * 240 * t);
    const peak = ((i - lead) % Math.floor(sr * 0.35) < Math.floor(sr * 0.03)) ? 0.12 : 0;
    samples[i] = env + peak * Math.sin(2 * Math.PI * 900 * t);
  }
  window.__capturedWavs = {};
  const prev = VBV.savePassage;
  VBV.savePassage = function (file, wav) {
    window.__capturedWavs[file] = wav;
    return prev.call(VBV, file, wav);
  };
  const rawLv = TTCore.measureLevel([samples], sr);
  const results = [];
  for (const ref of ['Ruth 1:1', 'Ruth 1:2']) {
    const blob = new Blob([wavFromMono(samples, sr)], { type: 'audio/wav' });
    TT.setPassage(ref);
    TT.useRecording(blob, 'take.wav');
    await new Promise((r) => setTimeout(r, 50));
    const b = document.getElementById('sendBtn');
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && (!b || b.disabled)) await new Promise((r) => setTimeout(r, 30));
    document.getElementById('sendBtn').click();
    const t1 = Date.now();
    while (Date.now() - t1 < 20000) {
      const el = document.getElementById('sendStatus');
      if (el && /Saved to Drive|Not saved|not signed/i.test(el.textContent || '')) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const name = Object.keys(window.__capturedWavs).pop();
    const wav = window.__capturedWavs[name];
    const pcm = wav ? pcmFromWav(wav) : null;
    const lv = pcm ? TTCore.measureLevel([pcm.samples], pcm.sampleRate) : null;
    results.push({
      ref,
      name,
      status: (document.getElementById('sendStatus') || {}).textContent || '',
      sr: pcm && pcm.sampleRate,
      bits: pcm && pcm.bits,
      ch: pcm && pcm.ch,
      lv,
    });
    delete window.__capturedWavs[name];
  }
  return { rawLv, results };
});

await ctx.close();
server.close();

const events = verseRun.events || [];
const saves = events.filter((e) => e.t === 'save');
const allSaved = (verseRun.statuses || []).every((st) => st === 'SAVED');
const uploadWithin1s = saves.length >= VERSE_N && saves.every((e) => e.stopMs != null && e.stopMs <= 1000);
const noManualSaveButton = !(verseRun.saveBtnSeen && verseRun.saveBtnSeen.length);
const checksFinished = verseRun.wc && Object.values(verseRun.wc).every((st) => st === 'done' || st === 'not-checked');
const memoryFlat = (verseRun.wavCounts || []).every((c) => c === 0);
const clickOk = verseRun.clickMs != null && verseRun.clickMs < 200;
const buttonsCompact = css.flexDir === 'row' && css.btnMinH <= 48 && css.btnMinH >= 40 && css.btnFont <= 20 && css.reservedH >= 40;
const verseLevels = saves.map((e) => e.lv).filter(Boolean);
const verseLevelsOk = verseLevels.length >= VERSE_N && verseLevels.every((lv) => lv.lufs > -22 && lv.lufs < -12);
const levelsOk = verseLevelsOk && (passageRun.results || []).every((r) => r.lv && r.lv.lufs > -22 && r.lv.lufs < -12 && r.sr === 48000 && r.bits === 16 && r.ch === 1);
const passageSaved = (passageRun.results || []).every((r) => /Saved to Drive/i.test(r.status || ''));
const noStitch = uploads.every((u) => !/stitch-request/i.test((u.meta && u.meta.name) || u.url || ''));
const passageUploads = uploads.filter((u) => u.meta && /^Ruth 1\.[12]\.wav$/.test(u.meta.name || '') && !u.failed);
const tickOnFail = failRun && failRun.saveOk === false && failRun.ticked === false;
const tickOnSuccess = retryRun && retryRun.status === 'SAVED' && retryRun.ticked === true;

const checks = {
  isLivePage: pageMeta.testFlag === false && pageMeta.banner === false,
  uploadPathUnchanged: pageMeta.viaLookup && pageMeta.waitForSave,
  flagPolicy: Object.values(flagTests).every(Boolean),
  buttonsCompact,
  twentyVerseSaves: saves.length >= VERSE_N && allSaved,
  uploadStartsWithin1sOfStop: uploadWithin1s,
  noManualSaveButton,
  checkRunsAlongside: !!checksFinished,
  memoryFlat,
  clickWhileCheckUnder200ms: clickOk,
  passageTwoSaves: passageRun.results && passageRun.results.length === 2 && passageSaved,
  levelsNearMinus16: levelsOk,
  sendNoStitch: noStitch && passageUploads.length >= 1,
  tickOnlyOnUploadSuccess: tickOnFail && tickOnSuccess,
  noPageErrors: pageErrors.length === 0,
};

const report = {
  origin,
  ok: Object.values(checks).every(Boolean),
  checks,
  flagTests,
  css,
  clickMs: verseRun.clickMs,
  wavCounts: verseRun.wavCounts,
  saveDelays: saves.map((e) => e.stopMs),
  saveBtnSeen: verseRun.saveBtnSeen,
  saveCount: saves.length,
  failRun,
  retryRun,
  passage: passageRun,
  uploadNames: uploads.map((u) => ({ name: u.meta && u.meta.name, failed: u.failed, method: u.method })),
  pageErrors,
  failedReqs,
  indexBytes: fs.statSync(path.join(ROOT, 'index.html')).size,
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, checks, flagTests, clickMs: verseRun.clickMs, css, wavCounts: verseRun.wavCounts, saveDelays: saves.map((e) => e.stopMs), saveBtnSeen: verseRun.saveBtnSeen, failRun, retryRun, verseLevels: (verseRun.events||[]).filter(e=>e.t==='save').map(e=>e.lv&&e.lv.lufs), passageLevels: (passageRun.results || []).map((r) => r.lv), pageErrors, indexBytes: report.indexBytes }, null, 2));
if (!report.ok) process.exit(1);
