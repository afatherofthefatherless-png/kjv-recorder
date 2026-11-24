/* Extracted from live verse-recorder: loudness + 16-bit WAV encode. */
(function (root) {
'use strict';
var LOUDNESS = Object.freeze({ targetLufs: -16, ceilingDbfs: -1.5 });
var SAMPLE_RATE = 48000;
  // ../verse-recorder/src/recorder/loudness.js
  function kCoeffs(fs) {
    let G = 3.99984385397, Q = 0.7071752369554193, fc = 1681.974450955532;
    let K2 = Math.tan(Math.PI * fc / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.499666774155);
    let a0 = 1 + K2 / Q + K2 * K2;
    const s1 = { b: [(Vh + Vb * K2 / Q + K2 * K2) / a0, 2 * (K2 * K2 - Vh) / a0, (Vh - Vb * K2 / Q + K2 * K2) / a0], a: [2 * (K2 * K2 - 1) / a0, (1 - K2 / Q + K2 * K2) / a0] };
    fc = 38.13547087613982;
    Q = 0.5003270373253953;
    K2 = Math.tan(Math.PI * fc / fs);
    a0 = 1 + K2 / Q + K2 * K2;
    const s2 = { b: [1, -2, 1], a: [2 * (K2 * K2 - 1) / a0, (1 - K2 / Q + K2 * K2) / a0] };
    return [s1, s2];
  }
  function biquad(x, { b, a }) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1;
      x1 = x[i];
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    return y;
  }
  function integratedLufs(samples, fs) {
    const [s1, s2] = kCoeffs(fs);
    const y = biquad(biquad(samples, s1), s2);
    const block = Math.round(0.4 * fs), step = Math.round(0.1 * fs);
    if (y.length < block) return -Infinity;
    const z = [];
    for (let st = 0; st + block <= y.length; st += step) {
      let acc = 0;
      for (let i = st; i < st + block; i++) acc += y[i] * y[i];
      z.push(acc / block);
    }
    const L = (v) => -0.691 + 10 * Math.log10(v);
    const abs = z.filter((v) => L(v) > -70);
    if (!abs.length) return -Infinity;
    const relThr = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const rel = abs.filter((v) => L(v) > relThr);
    if (!rel.length) return -Infinity;
    return L(rel.reduce((a, b) => a + b, 0) / rel.length);
  }
  function peak(samples) {
    let p = 0;
    for (const v of samples) {
      const a = Math.abs(v);
      if (a > p) p = a;
    }
    return p;
  }
  function normalize(samples, fs, { targetLufs = LOUDNESS.targetLufs, ceilingDbfs = LOUDNESS.ceilingDbfs } = {}) {
    const before = integratedLufs(samples, fs);
    if (!isFinite(before)) return { samples, gainDb: 0, lufsBefore: before, lufsAfter: before, limited: false };
    let gainDb = targetLufs - before;
    const pk = peak(samples);
    let limited = false;
    if (pk > 0) {
      const maxGain = ceilingDbfs - 20 * Math.log10(pk);
      if (gainDb > maxGain) {
        gainDb = maxGain;
        limited = true;
      }
    }
    if (limited) { // m3.6: look-ahead soft limiter so the -1.5 dBFS ceiling no longer stops the take reaching the target
      const ceil = Math.pow(10, ceilingDbfs / 20);
      let want = Math.min(targetLufs - before, maxGainDbOf(pk, ceilingDbfs) + 12), out2 = null, after = before;
      for (let pass = 0; pass < 2; pass++) {
        out2 = limitPeaks(samples, fs, Math.pow(10, want / 20), ceil);
        after = integratedLufs(out2, fs);
        if (!isFinite(after) || Math.abs(after - targetLufs) <= 0.3) break;
        want = Math.min(want + (targetLufs - after), maxGainDbOf(pk, ceilingDbfs) + 12);
      }
      return { samples: out2, gainDb: want, lufsBefore: before, lufsAfter: after, limited: true, softLimited: true };
    }
    const g = Math.pow(10, gainDb / 20), out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
    return { samples: out, gainDb, lufsBefore: before, lufsAfter: before + gainDb, limited };
  }
  function maxGainDbOf(pk, ceilingDbfs) { return ceilingDbfs - 20 * Math.log10(pk); }
  function limitPeaks(x, fs, g, ceil) {
    const n = x.length, la = Math.max(1, Math.round(fs * 0.005)), rel = 1 - Math.exp(-1 / (fs * 0.08)), att = 1 - Math.exp(-1 / (fs * 0.002));
    const req = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.abs(x[i]) * g; req[i] = a > ceil ? ceil / a : 1; }
    const m = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0; // sliding min over [i-la, i+la]
    for (let j = 0, i = -la; i < n; j++, i++) {
      if (j < n) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; }
      if (i < 0) continue;
      while (dq[h] < i - la) h++;
      m[i] = req[dq[h]];
    }
    let e = 1;
    for (let i = 0; i < n; i++) { e = m[i] < e ? m[i] : e + (1 - e) * rel; m[i] = e; }
    e = 1;
    for (let i = n - 1; i >= 0; i--) { e = m[i] < e ? m[i] : e + (1 - e) * att; if (e < m[i]) m[i] = e; }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = x[i] * g * m[i]; if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil; out[i] = v; }
    return out;
  }

  // ../verse-recorder/src/recorder/wav.js
  function encodeWav(samples, sampleRate) {
    const n = samples.length, dataBytes = n * 2;
    const buf = new ArrayBuffer(44 + dataBytes), dv = new DataView(buf);
    const str = (o, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    dv.setUint32(4, 36 + dataBytes, true);
    str(8, "WAVE");
    str(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    str(36, "data");
    dv.setUint32(40, dataBytes, true);
    for (let i = 0, o = 44; i < n; i++, o += 2) {
      let s = samples[i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      dv.setInt16(o, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return buf;
  }
  async function resampleTo(samples, fromRate, toRate = SAMPLE_RATE) {
    if (fromRate === toRate) return samples;
    const len = Math.ceil(samples.length * toRate / fromRate);
    const oc = new OfflineAudioContext(1, len, toRate);
    const b = oc.createBuffer(1, samples.length, fromRate);
    b.copyToChannel(samples, 0);
    const src = oc.createBufferSource();
    src.buffer = b;
    src.connect(oc.destination);
    src.start();
    return (await oc.startRendering()).getChannelData(0).slice();
  }
  root.KJVAudio = {
    LOUDNESS: LOUDNESS,
    SAMPLE_RATE: SAMPLE_RATE,
    normalize: normalize,
    encodeWav: encodeWav,
    resampleTo: resampleTo,
    integratedLufs: integratedLufs,
    peak: peak
  };
})(window);

