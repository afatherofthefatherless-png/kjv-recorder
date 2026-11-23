// Word check for the verse recorder. Local copy; nothing is published from here.
// Diff, normalisation and filters are a faithful port of VideoBot's
// /workspace/chapter-pipeline/align/align_unit.py (source lines cited below),
// plus recorder-only near-miss, prompt, early-cutoff retry, and trailing-closer rules.
// Recognition is in-browser Whisper (transformers.js, quantised q8).
// The check only flags. It never blocks recording, Save, or hardFail.

const ARCHAIC = { // align_unit.py:24-42
  thee: new Set(["you", "thee"]), thou: new Set(["you", "thou"]), ye: new Set(["you", "ye"]),
  thy: new Set(["your", "thy"]), thine: new Set(["your", "yours", "thine"]),
  hath: new Set(["has", "hath"]), hast: new Set(["have", "has", "hast"]),
  doth: new Set(["does", "doth"]), dost: new Set(["do", "does", "dost"]),
  saith: new Set(["says", "said", "saith"]), saidst: new Set(["said", "saidst"]),
  didst: new Set(["did", "didst"]), art: new Set(["are", "art"]),
  wilt: new Set(["will", "wilt"]), shalt: new Set(["shall", "shalt"]),
  shouldest: new Set(["should", "shouldest", "shouldst"]), shouldst: new Set(["should", "shouldest", "shouldst"]),
  wouldest: new Set(["would", "wouldest", "wouldst"]), wouldst: new Set(["would", "wouldest", "wouldst"]),
  couldest: new Set(["could", "couldest", "couldst"]), couldst: new Set(["could", "couldest", "couldst"]),
  wast: new Set(["were", "was", "wast"]), wert: new Set(["were", "wert"]),
  spake: new Set(["spoke", "spake"]), shew: new Set(["show", "shew"]),
  shewed: new Set(["showed", "shewed"]), shewn: new Set(["shown", "shewn"]),
  unto: new Set(["to", "unto"]), nigh: new Set(["near", "nigh"]),
  yea: new Set(["yes", "yea"]), verily: new Set(["truly", "verily"]),
  whilst: new Set(["while", "whilst"]), amongst: new Set(["among", "amongst"]),
  mine: new Set(["my", "mine"]),
};

const FUNC = new Set([ // align_unit.py:44-51
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "at", "as", "by",
  "is", "be", "it", "if", "so", "he", "him", "his", "her", "they", "them", "their",
  "this", "that", "with", "from", "not", "but", "i", "we", "us", "our", "you", "your",
  "was", "were", "are", "am", "do", "did", "had", "has", "have", "shall", "will",
  "into", "upon", "up", "out", "all", "no", "nor", "than", "then", "there", "when",
  "which", "who", "whom", "whose", "what", "my", "me",
]);

const WORD_RE = /[A-Za-z0-9]/; // align_unit.py:53

const HALLUC = new Set([ // align_unit.py:194-199, plus common closers
  "thank", "thanks", "watching", "bye", "goodbye", "sorry", "really", "agree",
  "subscribe", "please", "like", "comment", "sample", "simple", "teaching",
  "owner", "owls", "amen", "okay", "ok", "alright", "right", "yeah", "yep",
  "uh", "um", "you", "for", "watching", "bye", "peace",
]);

// Trailing closer phrases dropped only when they sit after the heard verse, in silence.
const CLOSER_PHRASES = [
  ["thank", "you", "very", "much"],
  ["thanks", "for", "watching"],
  ["thank", "you"],
  ["thanks"],
  ["goodbye"],
  ["bye"],
  ["peace"],
  ["amen"],
  ["sorry"],
  ["agree"],
  ["okay"],
  ["ok"],
  ["alright"],
];

const CLOSED = { // align_unit.py:221
  forever: new Set(["for", "ever"]),
  anything: new Set(["any", "thing"]),
  everyone: new Set(["every", "one"]),
  cannot: new Set(["can", "not"]),
};

// Standard special IDs shared by openai/Xenova whisper-*.en tokenisers.
export const WHISPER_EN = {
  startofprev: 50360,
  startoftranscript: 50257,
  notimestamps: 50362,
  endoftext: 50256,
};

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
const MODEL_ID = "Xenova/whisper-base.en";
const CACHE_KEY = "vbv.wordCheck.modelReady.v1";
const EARLY_GAP_S = 1.25;
const TAIL_OVERLAP_S = 0.5;

export function tokensOf(text) { // align_unit.py:57-59
  return String(text || "").trim().split(/\s+/).filter((w) => w && WORD_RE.test(w));
}

export function norm(tok) { // align_unit.py:62-66
  let s = String(tok || "").toLowerCase();
  s = s.replace(/\u2019/g, "'").replace(/\u2018/g, "'");
  s = s.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "");
  return s;
}

export function editDistance(a, b) { // align_unit.py:69-80
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[prev.length - 1];
}

function rstripS(s) { // Python str.rstrip("s")
  let i = s.length;
  while (i > 0 && s[i - 1] === "s") i--;
  return s.slice(0, i);
}

// Near-miss pairs on top of VideoBot's ARCHAIC set.
const NEAR = {
  thee: new Set(["thee", "the", "you"]),
  the: new Set(["the", "thee"]),
  thou: new Set(["thou", "though", "you"]),
  though: new Set(["though", "thou"]),
  ye: new Set(["ye", "yeah", "you"]),
  yea: new Set(["yea", "yeah", "yes"]),
  yeah: new Set(["yeah", "ye", "yea"]),
  cry: new Set(["cry", "crime"]),
  crime: new Set(["crime", "cry"]),
  doest: new Set(["doest", "dost", "does", "do"]),
  dost: new Set(["dost", "doest", "does", "do"]),
};

function stemInfl(s) {
  const endings = ["iced", "eth", "est", "ied", "ed", "st"];
  for (const end of endings) {
    if (s.length - end.length >= 4 && s.endsWith(end)) return s.slice(0, -end.length);
  }
  return s;
}

function isCapped(tok) {
  const s = String(tok || "").replace(/^[^A-Za-z]+/, "");
  return /^[A-Z]/.test(s);
}

export function equiv(a, b) { // align_unit.py:83-96, plus near-miss
  if (!a || !b) return false;
  if (a === b) return true;
  if (rstripS(a) === b || rstripS(b) === a) return true;
  const sa = ARCHAIC[a] || new Set([a]);
  const sb = ARCHAIC[b] || new Set([b]);
  let inter = false;
  for (const x of sa) { if (sb.has(x)) { inter = true; break; } }
  if (inter || sb.has(a) || sa.has(b)) return true;
  if (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1) return true;
  // Short ASR slips (rowed/rode, heard/herd). Keep well/will and son/sun strict.
  if (editDistance(a, b) <= 1 && Math.min(a.length, b.length) >= 4 && commonPrefixLen(a, b) >= 2) return true;
  const na = NEAR[a], nb = NEAR[b];
  if ((na && na.has(b)) || (nb && nb.has(a))) return true;
  const sta = stemInfl(a), stb = stemInfl(b);
  if (sta !== a || stb !== b) {
    if (sta && stb && (sta === stb || (Math.min(sta.length, stb.length) >= 4 && editDistance(sta, stb) <= 1))) return true;
  }
  // Longer-word near-miss (observe/deserve, Amittai/Amatai). Short distinct
  // words (man/men, son/sun) stay strict.
  if (Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= 2) return true;
  return false;
}

export function equivTokens(kjTok, asrTok) {
  const a = norm(kjTok), b = norm(asrTok);
  if (equiv(a, b)) return true;
  if ((isCapped(kjTok) || isCapped(asrTok)) && Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 2) return true;
  return false;
}

function asrWord(item) {
  return typeof item === "string" ? item : (item && item.word) || "";
}

function asrProb(item) {
  if (!item || typeof item === "string") return null;
  const p = item.prob;
  return (p == null || Number.isNaN(Number(p))) ? null : Number(p);
}

export function alignTokens(asr, kjv) { // align_unit.py:99-147
  const n = kjv.length, m = asr.length;
  const INF = 1e9;
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(INF));
  const bt = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + (FUNC.has(norm(kjv[i - 1])) ? 0.35 : 0.8);
    bt[i][0] = "missing";
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1] + (FUNC.has(norm(asrWord(asr[j - 1]))) ? 0.35 : 0.8);
    bt[0][j] = "extra";
  }
  for (let i = 1; i <= n; i++) {
    const ki = norm(kjv[i - 1]);
    for (let j = 1; j <= m; j++) {
      const aj = norm(asrWord(asr[j - 1]));
      let s, kind;
      if (ki === aj) { s = 0.0; kind = "match"; }
      else if (equivTokens(kjv[i - 1], asrWord(asr[j - 1]))) { s = 0.15; kind = "match"; }
      else { s = (!FUNC.has(ki) || !FUNC.has(aj)) ? 1.0 : 0.5; kind = "sub"; }
      const cands = [
        [dp[i - 1][j - 1] + s, kind],
        [dp[i - 1][j] + (FUNC.has(ki) ? 0.35 : 0.8), "missing"],
        [dp[i][j - 1] + (FUNC.has(aj) ? 0.35 : 0.8), "extra"],
      ];
      let best = cands[0][0], how = cands[0][1];
      for (let c = 1; c < 3; c++) {
        if (cands[c][0] < best) { best = cands[c][0]; how = cands[c][1]; }
      }
      dp[i][j] = best;
      bt[i][j] = how;
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const how = bt[i][j];
    if (how === "match" || how === "sub") { ops.push([how, i - 1, j - 1]); i -= 1; j -= 1; }
    else if (how === "missing") { ops.push(["missing", i - 1, null]); i -= 1; }
    else { ops.push(["extra", null, j - 1]); j -= 1; }
  }
  ops.reverse();
  return ops;
}

function plain(s) { return norm(s || ""); }

function isCompoundPair(a, b, joined) {
  return !!(a && b && joined && (plain(a) + plain(b) === plain(joined) || plain(joined) === plain(a) + plain(b)));
}

export function cleanFlags(flags) { // align_unit.py:207-246
  let out = flags.slice();
  const drop = new Set();
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    if (a.type === "missing" && b.type === "sub" && isCompoundPair(a.kjv, b.kjv, b.asr)) drop.add(i), drop.add(i + 1);
    if (a.type === "sub" && b.type === "missing" && isCompoundPair(a.kjv, b.kjv, a.asr)) drop.add(i), drop.add(i + 1);
    // split compounds: sackcloth → "sack" + "cloth", sixscore → "six" + "score"
    if (a.type === "extra" && b.type === "sub" && isCompoundPair(a.asr, b.asr, b.kjv)) drop.add(i), drop.add(i + 1);
    if (a.type === "sub" && b.type === "extra" && isCompoundPair(a.asr, b.asr, a.kjv)) drop.add(i), drop.add(i + 1);
  }
  out = out.filter((_, i) => !drop.has(i));
  const drop2 = new Set();
  const plainsKjv = [];
  out.forEach((f, i) => { if (f.type === "missing" || f.type === "sub") plainsKjv.push([plain(f.kjv), i]); });
  out.forEach((f, i) => {
    const kn = plain(f.kjv), an = plain(f.asr);
    if (f.type === "sub") {
      for (const [closedW, parts] of Object.entries(CLOSED)) {
        if (an === closedW && parts.has(kn)) {
          drop2.add(i);
          for (const [kn2, j] of plainsKjv) {
            if (parts.has(kn2) && j !== i) drop2.add(j);
          }
        }
      }
    }
    if (f.type === "missing" && Object.prototype.hasOwnProperty.call(CLOSED, kn)) drop2.add(i);
    if (f.type === "sub" && Object.prototype.hasOwnProperty.call(CLOSED, kn) && CLOSED[kn].has(an)) drop2.add(i);
  });
  return out.filter((_, i) => !drop2.has(i));
}

function isCloserPhrase(words) {
  const plains = words.map(plain);
  if (!plains.length) return false;
  return CLOSER_PHRASES.some((ph) => {
    if (plains.length < ph.length) return false;
    for (let i = 0; i <= plains.length - ph.length; i++) {
      let ok = true;
      for (let k = 0; k < ph.length; k++) if (plains[i + k] !== ph[k]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  });
}

// Drop made-up trailing closers that sit after the last heard KJV word, over silence.
// Do not drop a real extra that falls inside the speech window.
export function dropTrailingHallucinations(flags, asr, opts = {}) {
  let out = flags.slice();
  const speechEnd = opts.speechEnd;
  const slack = opts.slack != null ? opts.slack : 0.35;
  // last matched/sub KJV word time, if we can see it on the aligned ASR side
  let lastMatchEnd = opts.lastMatchEnd;
  if (lastMatchEnd == null && asr && asr.length) {
    for (const w of asr) {
      if (w && w.end != null && !Number.isNaN(Number(w.end))) lastMatchEnd = Math.max(lastMatchEnd == null ? -Infinity : lastMatchEnd, Number(w.end));
    }
  }
  // Existing VideoBot trailing pop for HALLUC / low-prob / FUNC
  while (out.length && out[out.length - 1].type === "extra") {
    const last = out[out.length - 1];
    const w = plain(last.asr);
    const p = last.word_prob;
    const t = extraStart(last, asr);
    const inSilence = speechEnd != null && t != null && t >= speechEnd - slack;
    const afterVerse = lastMatchEnd == null || t == null || t >= lastMatchEnd - 0.1;
    if (HALLUC.has(w) || (p != null && p < 0.7) || FUNC.has(w)) {
      if (t == null || inSilence || (afterVerse && HALLUC.has(w))) out.pop();
      else break;
    } else break;
  }
  let runAt = out.length;
  while (runAt > 0 && out[runAt - 1].type === "extra") runAt--;
  if (runAt < out.length) {
    const run = out.slice(runAt);
    const starts = run.map((f) => extraStart(f, asr));
    const afterVerse = starts.every((t) => t == null || lastMatchEnd == null || t >= lastMatchEnd - 0.1);
    const inSilence = speechEnd == null || starts.every((t) => t == null || t >= speechEnd - slack);
    const phrase = isCloserPhrase(run.map((f) => f.asr)) || run.some((f) => HALLUC.has(plain(f.asr)));
    // Only drop the whole run if it is a closer (or contains one) and is beyond the verse;
    // prefer silence, but a known closer phrase just after the last word still counts.
    if (afterVerse && phrase && (inSilence || isCloserPhrase(run.map((f) => f.asr)))) {
      out = out.slice(0, runAt);
    }
  }
  return out;
}

function extraStart(flag, asr) {
  if (flag && flag.start != null) return Number(flag.start);
  const aw = flag && flag.asr;
  if (!asr || aw == null) return null;
  for (let i = asr.length - 1; i >= 0; i--) {
    if (asrWord(asr[i]) === aw && asr[i].start != null) return Number(asr[i].start);
  }
  return null;
}

function lastAsrTime(words) {
  let t = null;
  for (const w of words || []) {
    const e = w && w.end != null ? Number(w.end) : (w && w.start != null ? Number(w.start) : null);
    if (e != null && !Number.isNaN(e)) t = Math.max(t == null ? -Infinity : t, e);
  }
  return t;
}

export function flagOps(ops, kjv, asr, verseConf) { // align_unit.py:165-190
  const flags = [];
  for (const [kind, i, j] of ops) {
    if (kind === "match") continue;
    const kj = i != null ? kjv[i] : null;
    const aw = j != null ? asrWord(asr[j]) : null;
    const kn = kj ? norm(kj) : "", an = aw ? norm(aw) : "";
    if (kind === "sub" && equivTokens(kj, aw)) continue;
    if (verseConf >= 0.75 && ((FUNC.has(kn) && kind === "missing") || (FUNC.has(an) && kind === "extra")
        || (FUNC.has(kn) && FUNC.has(an) && kind === "sub"))) continue;
    let wp = null;
    if (j != null) wp = asrProb(asr[j]);
    let conf = "high";
    if (verseConf < 0.55 || (wp != null && wp < 0.45)) conf = "low";
    else if (verseConf < 0.75 || (wp != null && wp < 0.7)) conf = "medium";
    const start = (j != null && asr[j] && asr[j].start != null) ? asr[j].start : null;
    const end = (j != null && asr[j] && asr[j].end != null) ? asr[j].end : null;
    flags.push({
      type: kind, kjv: kj, asr: aw, confidence: conf,
      word_prob: wp == null ? null : Math.round(wp * 1000) / 1000,
      start, end,
    });
  }
  return cleanFlags(flags);
}

function lastMatchedKjvIndex(ops) {
  let last = -1;
  for (const [kind, i] of ops) {
    if ((kind === "match" || kind === "sub") && i != null) last = Math.max(last, i);
  }
  return last;
}

function hasTrailingMissingContent(ops, kjv) {
  const last = lastMatchedKjvIndex(ops);
  for (const [kind, i] of ops) {
    if (kind !== "missing" || i == null || i <= last) continue;
    if (!FUNC.has(norm(kjv[i]))) return true;
  }
  return false;
}

function dropTrailingMissing(flags, ops, kjv) {
  const last = lastMatchedKjvIndex(ops);
  return flags.filter((f) => {
    if (f.type !== "missing") return true;
    const idx = kjv.indexOf(f.kjv);
    // drop missing tokens after the last heard KJV word (the unheard tail)
    const i = kjv.findIndex((_, n) => kjv[n] === f.kjv && n > last && !flags._used);
    // Safer: use ops to know which kjv indexes were trailing missing
    return true;
  });
}

function dropUnheardTailFlags(flags, ops, kjv) {
  const last = lastMatchedKjvIndex(ops);
  const tailMissing = new Set();
  for (const [kind, i] of ops) {
    if (kind === "missing" && i != null && i > last) tailMissing.add(i);
  }
  return flags.filter((f) => {
    if (f.type !== "missing") return true;
    for (const i of tailMissing) {
      if (f.kjv === kjv[i]) {
        tailMissing.delete(i);
        return false;
      }
    }
    return true;
  });
}

export function checkTranscript(kjvText, asrWords, opts = {}) {
  const kjv = tokensOf(kjvText);
  const asr = (asrWords || []).map((w) => (typeof w === "string" ? { word: w, prob: null } : w));
  if (!kjv.length) return { flags: [], coverage: 0, ops: [], kjv, asr, unclearEnd: false };
  const ops = alignTokens(asr, kjv);
  const nMatch = ops.reduce((n, [k, i2]) => n + (k === "match" && i2 != null ? 1 : 0), 0);
  const coverage = nMatch / Math.max(1, kjv.length);
  let flags = flagOps(ops, kjv, asr, coverage);
  flags = dropTrailingHallucinations(flags, asr, {
    speechEnd: opts.speechEnd,
    lastMatchEnd: lastAsrTime(asr.filter((_, j) => ops.some(([k, _i, aj]) => (k === "match" || k === "sub") && aj === j))),
  });
  let unclearEnd = !!opts.unclearEnd;
  if (unclearEnd && hasTrailingMissingContent(ops, kjv)) {
    flags = dropUnheardTailFlags(flags, ops, kjv);
  }
  return { flags, coverage, ops, kjv, asr, unclearEnd };
}

function displayWord(tok) {
  if (!tok) return "";
  return String(tok).replace(/\u2019/g, "'").replace(/\u2018/g, "'").replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "");
}

export function issueLines(flags, opts = {}) {
  const lines = [];
  for (const f of flags || []) {
    if (f.type === "missing") lines.push("Missing word: " + displayWord(f.kjv));
    else if (f.type === "extra") lines.push("Extra word: " + displayWord(f.asr));
    else lines.push("Heard '" + displayWord(f.asr) + "' instead of '" + displayWord(f.kjv) + "'");
  }
  if (opts && opts.unclearEnd) lines.push("Couldn't hear the end clearly.");
  return lines;
}

export function formatNote(flags, opts = {}) {
  const lines = issueLines(flags, opts);
  if (!lines.length) return "Word check: all words heard.";
  return lines.join(" · ");
}

export function isModelCached() {
  try { return !!(globalThis.localStorage && localStorage.getItem(CACHE_KEY)); }
  catch { return false; }
}

function markModelReady() {
  try { if (globalThis.localStorage) localStorage.setItem(CACHE_KEY, "1"); } catch {}
}

export function decodeWavPcm16(buf) {
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (u8.byteLength < 44) throw new Error("WAV too short");
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "RIFF") throw new Error("not a RIFF WAV");
  let off = 12, sr = 0, ch = 0, bits = 0, dataOff = -1, dataLen = 0;
  while (off + 8 <= u8.byteLength) {
    const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    const sz = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      ch = view.getUint16(off + 10, true);
      sr = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
    } else if (id === "data") {
      dataOff = off + 8; dataLen = sz; break;
    }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) throw new Error("WAV has no data chunk");
  if (bits !== 16) throw new Error("expected 16-bit WAV");
  const nFrames = Math.floor(dataLen / (2 * Math.max(1, ch)));
  const samples = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    samples[i] = view.getInt16(dataOff + i * 2 * ch, true) / 32768;
  }
  return { samples, sampleRate: sr };
}

export function resampleLinear(samples, fromRate, toRate) { // align_unit.py:281-286
  if (fromRate === toRate) return samples;
  const nOut = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const out = new Float32Array(nOut);
  const denom = Math.max(1, samples.length);
  for (let i = 0; i < nOut; i++) {
    const x = i / nOut * denom;
    const i0 = Math.min(samples.length - 1, Math.floor(x));
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = x - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

export function speechBounds(samples, sampleRate, opts = {}) {
  const frameMs = opts.frameMs || 20;
  const hop = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const n = Math.max(1, Math.ceil(samples.length / hop));
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    const a = i * hop, b = Math.min(samples.length, a + hop);
    for (let j = a; j < b; j++) { s += samples[j] * samples[j]; c++; }
    rms[i] = Math.sqrt(s / Math.max(1, c));
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.max(0, Math.floor(sorted.length * 0.2))] || 0;
  let peak = 0;
  for (let i = 0; i < n; i++) if (rms[i] > peak) peak = rms[i];
  const thresh = Math.max(opts.thresh || 0.02, noise * 4, peak * 0.08);
  let first = -1, last = -1, run = 0, runStart = 0;
  const minRun = 2;
  for (let i = 0; i < n; i++) {
    if (rms[i] >= thresh) {
      if (run === 0) runStart = i;
      run++;
      if (run >= minRun) {
        if (first < 0) first = runStart;
        last = i;
      }
    } else run = 0;
  }
  const hang = Math.ceil((opts.hangMs || 200) / frameMs);
  const duration = samples.length / sampleRate;
  const start = first < 0 ? 0 : first * hop / sampleRate;
  const end = last < 0 ? duration : Math.min(duration, (last + 1 + hang) * hop / sampleRate);
  return { start, end, duration, peak, thresh, noise };
}

let _pipe = null;
let _pipePromise = null;
let _pipeModel = null;
let _pipeRuntime = null;

export function getRuntime() {
  return _pipeRuntime ? { device: _pipeRuntime.device, dtype: _pipeRuntime.dtype, label: _pipeRuntime.label } : null;
}

async function gpuAdapterAvailable() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function applyEnv(env) {
  if (!env) return;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useCustomCache = false;
  try {
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.numThreads = 1; // GitHub Pages has no COOP/COEP
    }
  } catch {}
}

async function makePipeline(mod, modelId, device, dtype) {
  const transcriber = await mod.pipeline("automatic-speech-recognition", modelId, { device, dtype });
  transcriber._vbvModel = modelId;
  try {
    const cfg = transcriber.model && transcriber.model.generation_config;
    if (cfg) cfg.forced_decoder_ids = null;
  } catch {}
  return transcriber;
}

export async function loadPipeline(modelId = MODEL_ID, opts = {}) {
  const forceDevice = opts.device || null;
  if (_pipe && _pipe._vbvModel === modelId && (!forceDevice || (_pipeRuntime && _pipeRuntime.device === forceDevice))) {
    return _pipe;
  }
  if (_pipePromise && _pipeModel === modelId && !forceDevice) return _pipePromise;
  if (_pipe || _pipePromise) await resetPipeline();
  _pipeModel = modelId;
  _pipePromise = (async () => {
    const mod = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    applyEnv(mod.env);
    const attempts = [];
    if (forceDevice === "wasm") {
      attempts.push({ device: "wasm", dtype: "q8", label: "WASM" });
    } else {
      if (forceDevice !== "wasm" && await gpuAdapterAvailable()) {
        attempts.push({ device: "webgpu", dtype: { encoder_model: "fp16", decoder_model_merged: "q4f16" }, label: "GPU" });
        attempts.push({ device: "webgpu", dtype: "fp16", label: "GPU" });
      }
      attempts.push({ device: "wasm", dtype: "q8", label: "WASM" });
    }
    let lastErr = null;
    for (const att of attempts) {
      try {
        const transcriber = await makePipeline(mod, modelId, att.device, att.dtype);
        _pipe = transcriber;
        _pipeRuntime = { device: att.device, dtype: att.dtype, label: att.label };
        markModelReady();
        return transcriber;
      } catch (e) {
        lastErr = e;
        try { /* continue to the next device/dtype */ } catch {}
      }
    }
    throw lastErr || new Error("Could not load the word-check model");
  })();
  try {
    return await _pipePromise;
  } catch (e) {
    _pipePromise = null;
    _pipeModel = null;
    _pipeRuntime = null;
    throw e;
  }
}

export async function resetPipeline() {
  const old = _pipe;
  _pipe = null;
  _pipePromise = null;
  _pipeModel = null;
  _pipeRuntime = null;
  try { if (old && typeof old.dispose === "function") await old.dispose(); } catch {}
}

/** Load (and lightly run) the model when the recorder opens, so Stop is not paying the first-load cost. */
export async function warmup(modelId = MODEL_ID, opts = {}) {
  const t = await loadPipeline(modelId, opts);
  try {
    await transcribePcm(t, new Float32Array(8000), "King James Bible.", { numBeams: 1, prompt: true });
  } catch {}
  return getRuntime();
}

function toIdList(ids) {
  if (ids == null) return [];
  if (typeof ids.tolist === "function") {
    const a = ids.tolist();
    return (Array.isArray(a[0]) ? a[0] : a).map(Number);
  }
  if (ArrayBuffer.isView(ids)) return Array.from(ids, Number);
  if (Array.isArray(ids)) return (Array.isArray(ids[0]) ? ids[0] : ids).map(Number);
  return [];
}

function encodeIds(tokenizer, text) {
  if (!tokenizer) return [];
  try {
    if (typeof tokenizer.encode === "function") {
      return toIdList(tokenizer.encode(text, { add_special_tokens: false }));
    }
  } catch {}
  try {
    const out = tokenizer(text, { add_special_tokens: false });
    return toIdList(out && (out.input_ids != null ? out.input_ids : out));
  } catch {}
  return [];
}

function lookupSpecial(tokenizer, piece, fallback) {
  const ids = encodeIds(tokenizer, piece);
  if (ids.length === 1) return ids[0];
  try {
    const vocab = tokenizer.get_vocab ? tokenizer.get_vocab() : (tokenizer.model && tokenizer.model.tokens_to_ids);
    if (vocab && vocab[piece] != null) return Number(vocab[piece]);
  } catch {}
  return fallback;
}

// Bias rare / archaic spellings and names without feeding the verse as a
// script to recite. A fluent full-verse decoder prompt makes Whisper write
// the prompt even when a word was actually missing or swapped.
export function vocabPrompt(kjvText) {
  const toks = tokensOf(kjvText);
  const out = [];
  const seen = new Set();
  for (const t of toks) {
    const n = norm(t);
    if (!n || seen.has(n) || FUNC.has(n)) continue;
    if (ARCHAIC[n] || NEAR[n] || n.length >= 7 || (isCapped(t) && n.length >= 5)) {
      out.push(t);
      seen.add(n);
    }
  }
  const body = out.length ? out.join(", ") : "";
  return body ? "King James Bible. " + body : "King James Bible.";
}

export function buildPromptDecoderIds(transcriber, prompt, returnTimestamps = true) {
  const tokenizer = transcriber && transcriber.tokenizer;
  const model = transcriber && transcriber.model;
  const text = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!text) return null;
  const startPrev = lookupSpecial(tokenizer, "<|startofprev|>", WHISPER_EN.startofprev);
  const startTr = lookupSpecial(tokenizer, "<|startoftranscript|>", WHISPER_EN.startoftranscript);
  const noTs = lookupSpecial(tokenizer, "<|notimestamps|>", WHISPER_EN.notimestamps);
  let body = encodeIds(tokenizer, " " + text);
  const specials = new Set([startPrev, startTr, noTs, WHISPER_EN.endoftext]);
  body = body.filter((id) => !specials.has(id));
  if (!body.length) return null;
  let suffix = [];
  try {
    if (model && typeof model._retrieve_init_tokens === "function") {
      const gen = Object.assign({}, model.generation_config || {}, {
        return_timestamps: !!returnTimestamps,
        // .en models must not be given language/task
        language: null,
        task: null,
      });
      suffix = toIdList(model._retrieve_init_tokens(gen));
    }
  } catch {}
  if (!suffix.length) suffix = [startTr];
  // Ensure timestamps stay on: drop a trailing notimestamps token.
  if (returnTimestamps) suffix = suffix.filter((id) => id !== noTs);
  if (!suffix.length) suffix = [startTr];
  let promptIds = [startPrev].concat(body);
  const maxPrompt = 223;
  if (promptIds.length > maxPrompt) promptIds = [promptIds[0]].concat(promptIds.slice(-(maxPrompt - 1)));
  return promptIds.concat(suffix);
}

function chunksToWords(out) {
  const words = [];
  const chunks = (out && out.chunks) || [];
  if (chunks.length) {
    for (const c of chunks) {
      const wt = String((c.text != null ? c.text : c.word) || "").trim();
      if (!wt || !WORD_RE.test(wt)) continue;
      const p = c.probability != null ? c.probability : (c.score != null ? c.score : null);
      words.push({ word: wt, prob: p, start: c.timestamp ? c.timestamp[0] : null, end: c.timestamp ? c.timestamp[1] : null });
    }
  } else if (out && out.text) {
    for (const w of tokensOf(out.text)) words.push({ word: w, prob: null });
  }
  return words;
}

async function transcribePcm(transcriber, pcm, prompt, callOpts = {}) {
  const asrOpts = {
    // Do not set language/task: .en models reject them in transformers.js 4.x
    return_timestamps: "word",
    condition_on_previous_text: false,
    temperature: 0,
    do_sample: false,
    num_beams: callOpts.numBeams != null ? callOpts.numBeams : 5,
    // Model default forced_decoder_ids pins <|notimestamps|> at index 1, which
    // would break both word timestamps and a prepended startofprev prompt.
    forced_decoder_ids: null,
  };
  let promptApplied = false;
  let decIds = null;
  if (callOpts.prompt !== false && prompt) {
    decIds = buildPromptDecoderIds(transcriber, prompt, true);
    if (decIds && decIds.length) {
      // 1-D token list; the pipeline batches it. A 2-D [[...]] also works.
      asrOpts.decoder_input_ids = decIds;
      promptApplied = true;
    }
  }
  try {
    const cfg = transcriber.model && transcriber.model.generation_config;
    if (cfg) cfg.forced_decoder_ids = null;
  } catch {}
  const audio = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
  const out = await transcriber(audio, asrOpts);
  return { words: chunksToWords(out), promptApplied, numBeams: asrOpts.num_beams, promptIds: decIds ? decIds.length : 0, text: out && out.text };
}

export async function transcribeWav(wav, prompt, callOpts = {}) {
  const { samples, sampleRate } = decodeWavPcm16(wav);
  const audio = resampleLinear(samples, sampleRate, 16000);
  const transcriber = await loadPipeline(callOpts.model || MODEL_ID);
  const r = await transcribePcm(transcriber, audio, prompt, callOpts);
  const words = r.words;
  words._meta = { promptApplied: r.promptApplied, numBeams: r.numBeams, promptIds: r.promptIds };
  return words;
}

function remainingKjvPrompt(kjvText, words) {
  const r = checkTranscript(kjvText, words);
  const last = lastMatchedKjvIndex(r.ops);
  const rest = r.kjv.slice(Math.max(0, last + (last >= 0 ? 1 : 0)));
  return rest.length ? rest.join(" ") : kjvText;
}

export function isEarlyCutoff(words, speech, kjvText) {
  if (!speech) return false;
  const r = checkTranscript(kjvText, words);
  const trailing = hasTrailingMissingContent(r.ops, r.kjv);
  if (!trailing && r.coverage >= 0.92) return false;
  const lastT = lastAsrTime(words);
  const end = speech.end != null ? speech.end : speech.duration;
  if (lastT == null) {
    // No timestamps: treat a low-coverage take with trailing gaps as a possible cut-off.
    return trailing && r.coverage < 0.9;
  }
  return trailing && (end - lastT) >= EARLY_GAP_S;
}

function shiftWords(words, dt) {
  return (words || []).map((w) => ({
    word: w.word, prob: w.prob,
    start: w.start != null ? w.start + dt : null,
    end: w.end != null ? w.end + dt : null,
  }));
}

export function mergeTail(head, tail, tailOffset, overlapS) {
  const shifted = shiftWords(tail, tailOffset);
  const headNorms = (head || []).slice(-5).map((w) => norm(w.word));
  const out = (head || []).slice();
  let started = false;
  for (const w of shifted) {
    const t = w.start != null ? w.start : tailOffset;
    if (!started && t < tailOffset + overlapS * 0.6 && headNorms.includes(norm(w.word))) continue;
    started = true;
    out.push(w);
  }
  return out;
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Common English words the unprompted pass may hallucinate in place of a name.
const COMMON_ASR = new Set([
  "never", "ever", "even", "every", "very", "only", "also", "just", "over", "under",
  "into", "onto", "good", "god", "lord", "okay", "yes", "yeah", "well", "back",
]);

function isTypoLike(a, b) {
  const d = editDistance(a, b);
  const minL = Math.min(a.length, b.length);
  if (minL >= 4 && d <= 2) return true;
  if (d <= 2 && minL >= 3 && commonPrefixLen(a, b) >= 2) return true;
  return false;
}

export function isStrongFlag(f) {
  const a = norm(f && f.kjv), b = norm(f && f.asr);
  if (f.type === "missing") return !!(a && !FUNC.has(a));
  if (f.type === "extra") return !!(b && !FUNC.has(b));
  if (f.type === "sub") {
    if (!a || !b) return true;
    if (FUNC.has(a) && FUNC.has(b)) return false;
    if (isTypoLike(a, b)) return false;
    return true;
  }
  return false;
}

// Verifier flags that should override a clean prompted pass. Subs are only
// kept when they look like a real name swap or a badly fragmented long word,
// not when unprompted ASR merely mishears (Nineveh→never, gourd→God).
export function verifyShouldKeep(f) {
  const a = norm(f && f.kjv), b = norm(f && f.asr);
  if (f.type === "missing") return !!(a && !FUNC.has(a));
  if (f.type === "extra") return !!(b && !FUNC.has(b) && !COMMON_ASR.has(b));
  if (f.type !== "sub" || !a || !b || isTypoLike(a, b)) return false;
  if (FUNC.has(a) && FUNC.has(b)) return false;
  if (COMMON_ASR.has(b)) return false;
  const d = editDistance(a, b);
  // Long name reduced to a fragment (Amittai → "A").
  if (a.length >= 6 && b.length <= a.length - 3) return true;
  // Distinct proper names (Jonah → Nineveh / Jonimha).
  if (isCapped(f.kjv) && isCapped(f.asr) && b.length >= 5 && d >= 3) return true;
  // Short content word swapped for a clearly different word (son → Sir).
  if (a.length <= 4 && !FUNC.has(a) && d >= 2) return true;
  return false;
}

const LOW_COVERAGE = 0.92;
const LOW_WORD_PROB = 0.55;

/** Non-exact alignments that the near-miss / archaic rules accepted as a match. */
export function hasNearMiss(ops, kjv, asr) {
  for (const [kind, i, j] of ops || []) {
    if (kind !== "match" || i == null || j == null) continue;
    const a = norm(kjv[i]), b = norm(asrWord(asr[j]));
    if (a && b && a !== b) return true;
  }
  return false;
}

export function hasLowConfidence(words, flags) {
  if ((flags || []).some((f) => f && f.confidence === "low")) return true;
  for (const w of words || []) {
    const p = asrProb(w);
    if (p != null && p < LOW_WORD_PROB) return true;
  }
  return false;
}

/**
 * A second listen runs only when the first pass is in doubt:
 * any flag, low coverage, early cut-off, a near-miss match, or a low-confidence segment.
 */
export function firstPassDoubt(checked, words, speech, kjvText) {
  const reasons = [];
  if (!checked) return ["no-result"];
  if ((checked.flags || []).length) reasons.push("flags");
  if ((checked.coverage == null) || checked.coverage < LOW_COVERAGE) reasons.push("low-coverage");
  if (checked.unclearEnd || isEarlyCutoff(words, speech, kjvText)) reasons.push("cutoff");
  if (hasNearMiss(checked.ops, checked.kjv, checked.asr || words)) reasons.push("near-miss");
  if (hasLowConfidence(words, checked.flags)) reasons.push("low-confidence");
  // A prompted proper name can be recited over a swap (Jonah heard, Nineveh said).
  if (hasPromptedNameMatch(checked, kjvText)) reasons.push("prompted-name");
  return reasons;
}

function hasPromptedNameMatch(checked, kjvText) {
  const names = new Set();
  for (const tok of tokensOf(kjvText)) {
    if (isCapped(tok) && norm(tok).length >= 5) names.add(norm(tok));
  }
  if (!names.size) return false;
  for (const [kind, i] of checked.ops || []) {
    if (kind === "match" && i != null && names.has(norm(checked.kjv[i]))) return true;
  }
  return false;
}

export async function checkAudio(wav, text, callOpts = {}) {
  const kjvText = text || "";
  if (!kjvText || !wav) return { flags: [], note: "", coverage: 0, words: [], unclearEnd: false };
  const { samples, sampleRate } = decodeWavPcm16(wav);
  const audio = resampleLinear(samples, sampleRate, 16000);
  const speech = speechBounds(audio, 16000);
  const transcriber = await loadPipeline(callOpts.model || MODEL_ID, { device: callOpts.device });
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();
  const onStatus = callOpts.onStatus;
  // Coordinate the one listen: bias names/archaic forms, but do not feed the
  // whole verse as a script to recite (that hid real missing/swapped words).
  const mainPrompt = callOpts.promptText != null ? callOpts.promptText : vocabPrompt(kjvText);
  let pass = await transcribePcm(transcriber, audio, mainPrompt, callOpts);
  let words = pass.words;
  let retried = false;
  const overlap = callOpts.overlapS != null ? callOpts.overlapS : TAIL_OVERLAP_S;

  const tryTail = async (pcm, offset, prompt, opt) => {
    if (pcm.length < 16000 * 0.4) return;
    retried = true;
    const tail = await transcribePcm(transcriber, pcm, prompt, opt || callOpts);
    words = mergeTail(words, tail.words, offset, overlap);
  };

  // Cheap cut-off handling: only re-run the uncovered tail when coverage is clearly short.
  if (isEarlyCutoff(words, speech, kjvText)) {
    const lastT = lastAsrTime(words) ?? (speech.start + (words.length / Math.max(1, tokensOf(kjvText).length)) * (speech.end - speech.start));
    const tailStart = Math.max(0, Math.min(speech.end - 0.6, lastT - overlap));
    const i0 = Math.max(0, Math.floor(tailStart * 16000));
    await tryTail(audio.subarray(i0), tailStart, remainingKjvPrompt(kjvText, words) || kjvText, { ...callOpts, numBeams: 1 });
  }
  const stillCut = isEarlyCutoff(words, speech, kjvText);
  let checked = checkTranscript(kjvText, words, { speechEnd: speech.end, unclearEnd: stillCut });
  let verified = false;
  let verifyFlags = [];
  let secondPass = false;
  // Robin: one listen by default; a second listen only when the first is in doubt.
  let doubtReasons = [];
  if (callOpts.verify === true) doubtReasons = ["forced"];
  else if (callOpts.verify !== false) doubtReasons = firstPassDoubt(checked, words, speech, kjvText);
  if (doubtReasons.length) {
    secondPass = true;
    try { if (onStatus) onStatus("checking-again"); } catch {}
    const verifyPass = await transcribePcm(transcriber, audio, "King James Bible.", { ...callOpts, prompt: true });
    const vChecked = checkTranscript(kjvText, verifyPass.words, { speechEnd: speech.end, unclearEnd: false });
    verifyFlags = (vChecked.flags || []).filter(verifyShouldKeep);
    if (verifyFlags.length) {
      verified = true;
      words = verifyPass.words;
      checked = { ...vChecked, flags: verifyFlags, unclearEnd: false };
    } else {
      // Second listen did not confirm a real missing/extra/swap. Drop typo-like
      // first-pass slips (rowed/rode, gourd/God) so they do not stand as flags.
      const kept = (checked.flags || []).filter((f) => {
        const a = norm(f && f.kjv), b = norm(f && f.asr);
        if (f.type === "sub" && a && b && (isTypoLike(a, b) || COMMON_ASR.has(b))) return false;
        return true;
      });
      checked = { ...checked, flags: kept };
    }
  }
  const issues = issueLines(checked.flags, { unclearEnd: checked.unclearEnd });
  const note = formatNote(checked.flags, { unclearEnd: checked.unclearEnd });
  return {
    flags: checked.flags,
    issues,
    coverage: checked.coverage,
    ops: checked.ops,
    note,
    unclearEnd: checked.unclearEnd,
    words,
    transcript: words.map((w) => w.word).join(" "),
    promptApplied: pass.promptApplied,
    promptIds: pass.promptIds,
    numBeams: pass.numBeams,
    retried,
    verified,
    verifyFlags,
    secondPass,
    doubtReasons,
    runtime: getRuntime(),
    speech,
    asr_ms: Math.round(now() - t0),
  };
}

export async function checkTake({ wav, text, onStatus } = {}) {
  const kjvText = text || "";
  if (!kjvText || !wav) return "";
  try {
    if (onStatus) onStatus(isModelCached() ? "listening" : "download");
    const r = await checkAudio(wav, kjvText);
    if (!r.words || !r.words.length) return "Word check: no words heard.";
    return r.note;
  } catch {
    return ""; // quietly skip — recording is never affected
  }
}

const api = {
  tokensOf, norm, editDistance, equiv, equivTokens, alignTokens, flagOps, cleanFlags,
  checkTranscript, formatNote, issueLines, isModelCached, decodeWavPcm16, resampleLinear,
  transcribeWav, checkTake, checkAudio, loadPipeline, resetPipeline, warmup, getRuntime,
  buildPromptDecoderIds, vocabPrompt, speechBounds, dropTrailingHallucinations,
  isEarlyCutoff, mergeTail, firstPassDoubt, hasNearMiss, hasLowConfidence,
  ARCHAIC, FUNC, HALLUC, CLOSED, NEAR, MODEL_ID, WHISPER_EN,
};
export default api;
if (typeof window !== "undefined") window.VBVWordCheck = api;
