/* Microphone capture: same-origin worklet, browser processing off, then live normalize + 48 kHz mono 16-bit WAV. */
(function () {
  "use strict";
  var SAMPLE_RATE = 48000;
  var workletUrl = new URL("../kjv-capture-worklet.js", document.currentScript && document.currentScript.src || location.href).href;

  function concat(chunks) {
    var n = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i].length;
    var out = new Float32Array(n), o = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }

  async function addWorklet(ctx) {
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } catch (e1) {
      var src = await (await fetch(workletUrl)).text();
      var blob = new Blob([src], { type: "application/javascript" });
      var url = URL.createObjectURL(blob);
      try { await ctx.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
    }
  }

  function Capture() {
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.chunks = [];
    this.sampleRate = SAMPLE_RATE;
    this.recording = false;
  }

  Capture.prototype.start = async function () {
    if (this.recording) return;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
      }
    });
    var AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;
    await addWorklet(this.ctx);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "kjv-capture");
    var self = this;
    this.node.port.onmessage = function (e) {
      if (self.recording && e.data) self.chunks.push(new Float32Array(e.data));
    };
    this.source.connect(this.node);
    // Worklet still runs if not connected to destination, but some Safari builds go quiet; keep a silent gain.
    var mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this.recording = true;
    if (window.KJB && KJB.wake) KJB.wake.hold("record");
  };

  Capture.prototype.stop = async function () {
    this.recording = false;
    if (this.node && this.node.port) {
      try { this.node.port.postMessage("flush"); } catch (e) {}
    }
    await new Promise(function (r) { setTimeout(r, 40); });
    var raw = concat(this.chunks);
    this.chunks = [];
    this._teardown();
    var A = window.KJVAudio;
    var samples = raw;
    var sr = this.sampleRate;
    if (sr !== SAMPLE_RATE) {
      samples = await A.resampleTo(samples, sr, SAMPLE_RATE);
      sr = SAMPLE_RATE;
    }
    var norm = A.normalize(samples, sr);
    var wav = A.encodeWav(norm.samples, sr);
    return {
      wav: wav,
      durationS: samples.length / sr,
      lufs: norm.lufsAfter,
      peak: A.peak(norm.samples),
      resampled: this.sampleRate !== SAMPLE_RATE,
      silent: !isFinite(norm.lufsBefore) || samples.length < sr * 0.15
    };
  };

  Capture.prototype.cancel = function () {
    this.recording = false;
    this.chunks = [];
    this._teardown();
  };

  Capture.prototype._teardown = function () {
    if (window.KJB && KJB.wake) KJB.wake.release("record");
    try { if (this.node) this.node.disconnect(); } catch (e) {}
    try { if (this.source) this.source.disconnect(); } catch (e) {}
    if (this.stream) this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    if (this.ctx) this.ctx.close().catch(function () {});
    this.node = this.source = this.stream = this.ctx = null;
  };

  window.KJVCapture = Capture;
})();
