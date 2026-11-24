// Background FIFO word-check worker. One transcription at a time (iPad RAM).
// The main thread must post a *copy* of the WAV ArrayBuffer; this worker may
// detach the transferred copy. It never touches the caller's take.wav.
import { warmup, checkAudio, getRuntime } from "./word-check.js";

const queue = [];
let running = false;

function post(msg) {
  try { self.postMessage(msg); } catch {}
}

async function runJob(job) {
  const { jobId, verseId, takeToken, wav, text, ref, wavName } = job;
  const base = { jobId, verseId, takeToken };
  try {
    post({ type: "status", ...base, status: "checking" });
    const r = await checkAudio(wav, text, {
      onStatus: (s) => post({ type: "status", ...base, status: s }),
      ref: ref || verseId || "",
      wavName: wavName || "",
    });
    post({
      type: "result",
      ...base,
      ok: true,
      issues: r.issues || [],
      note: r.note || "",
      unclearEnd: !!r.unclearEnd,
      asr_ms: r.asr_ms,
      runtime: r.runtime || getRuntime(),
      transcript: r.transcript || "",
      flags: r.flags || [],
      error: null,
    });
  } catch (err) {
    post({
      type: "result",
      ...base,
      ok: false,
      issues: [],
      note: "",
      unclearEnd: false,
      asr_ms: null,
      runtime: getRuntime(),
      transcript: "",
      flags: [],
      error: String(err && err.message || err),
    });
  }
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await runJob(job);
    }
  } finally {
    running = false;
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "warmup") {
    warmup()
      .then((runtime) => post({ type: "status", status: "ready", runtime: runtime || getRuntime() }))
      .catch((err) => post({ type: "result", ok: false, error: String(err && err.message || err) }));
    return;
  }
  if (msg.type === "enqueue") {
    queue.push({
      jobId: msg.jobId,
      verseId: msg.verseId,
      takeToken: msg.takeToken,
      wav: msg.wav,
      text: msg.text,
      ref: msg.ref || "",
      wavName: msg.wavName || "",
    });
    pump();
    return;
  }
  if (msg.type === "cancel-verse") {
    const vid = msg.verseId;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].verseId === vid) queue.splice(i, 1);
    }
    return;
  }
};
