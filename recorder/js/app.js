/* Light tracker + verse-by-verse recorder. Save uses live VBVDrive unchanged. */
(function () {
  "use strict";
  var VBV = window.VBV = window.VBV || {};
  var $ = function (id) { return document.getElementById(id); };
  var FS_KEY = "kjvrec.light.fontScale.v1";
  var NUM_KEY = "kjvrec.light.verseNums.v1";
  var ALERT_DB = "kjvrec.alerts.v1";
  var CHECK_CAP_MS = 10000;

  var ramTake = null; // only one take's WAV in RAM
  var recording = false;
  var capture = null;
  var unitCur = null;
  var verseId = null;
  var storage = null;
  var worker = null;
  var checkSeq = 0;
  var recGen = 0;
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || location.href;

  function refBookName(code) {
    var b = window.DotsMap && DotsMap.BOOKS.find(function (x) { return x.code === code; });
    if (!b) return code;
    return b.code === "PSA" ? "Psalm" : b.name;
  }
  function verseRef(id) {
    var p = String(id).split(".");
    return refBookName(p[0]) + " " + p[1] + "." + p[2];
  }
  function verseFileName(id) {
    // Live format: 'Ruth 1.1.wav'. Any leftover colon becomes a hyphen.
    return (verseRef(id) + ".wav").replace(/:/g, "-");
  }
  function verseText(id) {
    return (window.TTBible && TTBible.verseById(id)) || (VBV.verseText && VBV.verseText(id)) || "";
  }

  /* ---------- alerts IndexedDB (flagged takes only; not RAM) ---------- */
  function alertDb() {
    if (alertDb.p) return alertDb.p;
    alertDb.p = new Promise(function (res, rej) {
      var r = indexedDB.open(ALERT_DB, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("alerts")) d.createObjectStore("alerts", { keyPath: "id" });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return alertDb.p;
  }
  function alertTx(mode, fn) {
    return alertDb().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction("alerts", mode), s = t.objectStore("alerts"), out;
        var q = fn(s);
        if (q) q.onsuccess = function () { out = q.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  var putAlert = function (row) { return alertTx("readwrite", function (s) { return s.put(row); }); };
  var delAlert = function (id) { return alertTx("readwrite", function (s) { return s.delete(id); }); };
  var getAlert = function (id) { return alertTx("readonly", function (s) { return s.get(id); }); };
  var allAlerts = function () { return alertTx("readonly", function (s) { return s.getAll(); }); };

  function setRam(take) {
    if (ramTake && ramTake.wav && ramTake !== take) ramTake.wav = null;
    ramTake = take;
    window.__kjvRamTakes = ramTake && ramTake.wav ? 1 : 0;
  }
  function clearRam() {
    if (ramTake) ramTake.wav = null;
    ramTake = null;
    window.__kjvRamTakes = 0;
  }

  /* ---------- word check: one reused worker, 10 s cap ---------- */
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("../word-check-worker.js", SCRIPT_SRC), { type: "module" });
    return worker;
  }
  function warmupCheck() {
    try { getWorker().postMessage({ type: "warmup" }); } catch (e) {}
  }
  function runCheck(opts) {
    var w = getWorker();
    var jobId = "j" + (++checkSeq);
    var wavCopy = opts.wav.slice(0);
    return new Promise(function (resolve) {
      var done = false;
      function finish(result) {
        if (done) return;
        done = true;
        w.removeEventListener("message", onMsg);
        resolve(result);
      }
      var timer = setTimeout(function () {
        finish({ status: "not-checked", note: "Not checked", issues: [], flags: [], silence: false });
      }, CHECK_CAP_MS);
      function onMsg(e) {
        var m = e.data || {};
        if (m.jobId !== jobId && m.takeToken !== opts.takeToken) return;
        if (m.type !== "result") return;
        clearTimeout(timer);
        var flags = m.flags || [];
        var issues = m.issues || [];
        var silence = false;
        if (m.ok === false && (!issues.length)) {
          finish({ status: "not-checked", note: "Not checked", issues: [], flags: [], silence: false, error: m.error });
          return;
        }
        if ((!m.transcript && !flags.length) || /no words heard/i.test(m.note || "")) silence = true;
        if (silence && !issues.length) issues = ["Silence, or no words heard"];
        var hasWord = flags.some(function (f) {
          var k = (f && (f.kind || f.type || f.op)) || "";
          return k === "ins" || k === "del" || k === "extra" || k === "missing" || k === "add" || k === "inserted" || k === "deleted" || k === "swap" || k === "sub";
        }) || issues.some(function (line) {
          return /missing|added|extra|silence|no words|swap|instead/i.test(String(line));
        });
        var flagged = silence || hasWord || (issues.length > 0);
        finish({
          status: flagged ? "flagged" : "ok",
          note: silence && !m.note ? "Silence, or no words heard" : (m.note || (flagged ? issues[0] : "")),
          issues: issues,
          flags: flags,
          silence: silence,
          transcript: m.transcript || ""
        });
      }
      w.addEventListener("message", onMsg);
      w.postMessage({
        type: "enqueue",
        jobId: jobId,
        verseId: opts.verseId,
        takeToken: opts.takeToken,
        wav: wavCopy,
        text: opts.text,
        ref: verseRef(opts.verseId),
        wavName: verseFileName(opts.verseId)
      }, [wavCopy]);
    });
  }

  /* ---------- views ---------- */
  function showView(name) {
    ["tracker", "recorder", "checks"].forEach(function (v) {
      var el = $("view-" + v);
      if (el) el.hidden = v !== name;
      var tab = $("tab-" + v);
      if (tab) tab.setAttribute("aria-selected", v === name ? "true" : "false");
    });
    if (window.KJB) KJB.setTop();
    if (name === "checks") renderChecks();
    if (name === "tracker" && window.KJB) requestAnimationFrame(KJB.setTop);
  }
  VBV.showView = showView;

  function setStatus(text, kind) {
    var el = $("recStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "rec-status" + (kind ? " is-" + kind : "");
  }

  function applyFont() {
    var n = parseInt(localStorage.getItem(FS_KEY) || "3", 10);
    if (!isFinite(n)) n = 3;
    n = Math.max(1, Math.min(6, n));
    document.documentElement.style.setProperty("--verse-fs", (18 + n * 4) + "px");
    localStorage.setItem(FS_KEY, String(n));
  }
  function showNums() {
    try { return localStorage.getItem(NUM_KEY) !== "0"; } catch (e) { return true; }
  }
  function renderVerse() {
    var box = $("verseText");
    var refEl = $("verseRef");
    if (!box || !verseId) return;
    if (refEl) refEl.textContent = verseRef(verseId);
    var t = verseText(verseId);
    var p = verseId.split(".");
    box.textContent = "";
    if (showNums()) {
      var num = document.createElement("span");
      num.className = "verse-num";
      num.textContent = p[2] + " ";
      box.appendChild(num);
    }
    box.appendChild(document.createTextNode(t || "Loading the verse text…"));
    $("recPos").textContent = positionLabel();
  }
  function positionLabel() {
    if (!unitCur || !verseId) return "";
    var i = unitCur.ids.indexOf(verseId);
    return (i + 1) + " of " + unitCur.ids.length;
  }

  function firstUnsaved(fromId) {
    if (!unitCur) return fromId;
    if (fromId && unitCur.ids.indexOf(fromId) >= 0) return fromId;
    for (var i = 0; i < unitCur.ids.length; i++) {
      var st = VBV.stageOf ? VBV.stageOf(unitCur.ids[i]) : 0;
      if (!st) return unitCur.ids[i];
    }
    return unitCur.ids[0];
  }

  VBV.openVerseRecorder = function (unit, fromId) {
    unitCur = unit;
    verseId = firstUnsaved(fromId);
    $("recChapter").textContent = unit && unit.name ? unit.name : "";
    renderVerse();
    setStatus("", "");
    updateToggle(false);
    showView("recorder");
    warmupCheck();
  };

  /* ---------- Drive save + ticks ---------- */
  function onSaved(h) {
    if (!h || !h.id) return;
    try {
      VBVStages.setVerse(h.id, { st: 1, at: h.take_at || new Date().toISOString(), drive_id: h.drive_id || null, sha256: h.sha256 || null, force: true });
    } catch (e) { console.warn(e); }
    if (VBV.setSaveState) VBV.setSaveState([{ index: h.id, state: "saved" }]);
    if (verseId === h.id) setStatus("Saved", "ok");
  }

  function goNext() {
    if (!unitCur) return;
    var i = unitCur.ids.indexOf(verseId);
    var next = null;
    for (var k = i + 1; k < unitCur.ids.length; k++) {
      if (!(VBV.stageOf && VBV.stageOf(unitCur.ids[k]))) { next = unitCur.ids[k]; break; }
    }
    if (!next) {
      for (k = 0; k < unitCur.ids.length; k++) {
        if (!(VBV.stageOf && VBV.stageOf(unitCur.ids[k]))) { next = unitCur.ids[k]; break; }
      }
    }
    if (!next) {
      setStatus("Chapter finished. Open Checks if anything was flagged, or go back to the Tracker.", "ok");
      return;
    }
    verseId = next;
    renderVerse();
  }

  async function saveTake(take) {
    if (!storage) throw new Error("Drive is not ready");
    // Word/silence flags must not block the upload. The live adapter only accepts PASS/WARN/WARN-OK.
    return storage.saveVerse(take.verseId, take.wav, {
      file: take.fileName,
      take_at: new Date().toISOString(),
      retake: !!take.retake,
      duration_s: take.durationS,
      resampled: !!take.resampled,
      gate: { overall: "PASS" }
    });
  }

  /* ---------- Record / Stop ---------- */
  function updateToggle(on) {
    var b = $("recBtn");
    if (!b) return;
    b.textContent = on ? "Stop" : "Record";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.classList.toggle("is-stop", on);
  }

  async function onRecordStop() {
    if (recording) {
      recGen++;
      var g = recGen;
      recording = false;
      updateToggle(false);
      setStatus("Saving…", "busy");
      var result;
      try { result = await capture.stop(); }
      catch (e) {
        setStatus((e && e.message) || "Recording failed.", "err");
        capture = null;
        return;
      }
      capture = null;
      if (g !== recGen) return;
      var take = {
        verseId: verseId,
        wav: result.wav,
        fileName: verseFileName(verseId),
        durationS: result.durationS,
        resampled: result.resampled,
        silent: !!result.silent,
        retake: true
      };
      setRam(take);
      var text = verseText(verseId);
      var token = "t" + Date.now();
      var checkP = runCheck({ verseId: take.verseId, takeToken: token, wav: take.wav, text: text });
      if (VBV.setSaveState) VBV.setSaveState([{ index: take.verseId, state: "saving" }]);
      var saveP = saveTake(take).catch(function (e) {
        var k = e && e.kind;
        if (k === "signin" || k === "auth" || k === "folder") {
          setStatus("Not signed in to Google Drive. Sign in, then it will upload.", "err");
        } else {
          setStatus((e && e.message) || "Not saved. Try again.", "err");
        }
        return null;
      });
      var checked = await checkP;
      if (g !== recGen) return;
      if (take.silent && checked.status === "ok") {
        checked = { status: "flagged", note: "Silence, or no words heard", issues: ["Silence, or no words heard"], flags: [], silence: true };
      }
      if (checked.status === "ok") {
        await delAlert(take.verseId).catch(function () {});
        clearRam();
        if ($("recStatus").textContent === "Saving…" || $("recStatus").textContent === "") setStatus("Saved", "ok");
        goNext();
      } else if (checked.status === "not-checked") {
        await delAlert(take.verseId).catch(function () {});
        clearRam();
        setStatus("Saved · Not checked", "warn");
        goNext();
      } else {
        await putAlert({
          id: take.verseId,
          file: take.fileName,
          note: checked.note || "Flagged",
          issues: checked.issues || [],
          flags: checked.flags || [],
          silence: !!checked.silence,
          wav: take.wav,
          at: new Date().toISOString()
        });
        clearRam();
        setStatus("Saved · flagged — see Checks", "warn");
        updateCheckBadge();
        goNext();
      }
      return;
    }

    if (!verseId) return;
    recGen++;
    try {
      capture = new KJVCapture();
      await capture.start();
    } catch (e) {
      var en = e && e.name;
      var msg = "Could not use the microphone.";
      if (en === "NotAllowedError" || en === "SecurityError") {
        msg = "Recording failed: the microphone is blocked for this site. On iPad: tap aA in the Safari address bar, Website Settings, Microphone, Allow. Then reload the page.";
      } else if (en === "NotFoundError") {
        msg = "Recording failed: no microphone was found.";
      } else if (e && e.message) msg = "Recording failed: " + e.message;
      setStatus(msg, "err");
      capture = null;
      return;
    }
    recording = true;
    updateToggle(true);
    setStatus("Recording…", "rec");
    warmupCheck();
  }

  function onRerecord() {
    if (recording) return;
    if (!verseId) return;
    setStatus("", "");
    onRecordStop();
  }

  /* ---------- Checks page ---------- */
  async function updateCheckBadge() {
    var rows = [];
    try { rows = await allAlerts(); } catch (e) { rows = []; }
    var n = (rows || []).length;
    var badge = $("checkCount");
    if (badge) {
      badge.textContent = n ? String(n) : "";
      badge.hidden = !n;
    }
    var tab = $("tab-checks");
    if (tab) tab.textContent = n ? "Checks (" + n + ")" : "Checks";
    return rows;
  }

  async function renderChecks() {
    var list = $("checkList");
    if (!list) return;
    var rows = await updateCheckBadge();
    list.textContent = "";
    if (!rows.length) {
      var p = document.createElement("p");
      p.className = "kjb-muted";
      p.textContent = "Nothing to check. Flagged takes stay here so you can listen and decide.";
      list.appendChild(p);
      return;
    }
    rows.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    rows.forEach(function (row) {
      var item = document.createElement("div");
      item.className = "chk-row";
      item.dataset.id = row.id;
      var head = document.createElement("div");
      head.className = "chk-head";
      var ref = document.createElement("strong");
      ref.textContent = verseRef(row.id);
      var note = document.createElement("span");
      note.className = "chk-note";
      note.textContent = row.note || (row.issues && row.issues[0]) || "Flagged";
      head.appendChild(ref);
      head.appendChild(note);
      var acts = document.createElement("div");
      acts.className = "chk-acts";
      [["Listen", "listen"], ["Ignore", "ignore"], ["Re-record", "rerecord"]].forEach(function (pair) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chk-btn";
        b.dataset.act = pair[1];
        b.dataset.id = row.id;
        b.textContent = pair[0];
        acts.appendChild(b);
      });
      item.appendChild(head);
      item.appendChild(acts);
      list.appendChild(item);
    });
  }

  var listenUrl = null;
  var listenAudio = null;
  async function listenAlert(id) {
    var row = await getAlert(id);
    if (!row || !row.wav) return;
    if (listenAudio) { try { listenAudio.pause(); } catch (e) {} listenAudio = null; }
    if (listenUrl) URL.revokeObjectURL(listenUrl);
    var blob = new Blob([row.wav], { type: "audio/wav" });
    listenUrl = URL.createObjectURL(blob);
    listenAudio = new Audio(listenUrl);
    listenAudio.addEventListener("ended", function () {
      if (listenUrl) { URL.revokeObjectURL(listenUrl); listenUrl = null; }
      listenAudio = null;
    });
    await listenAudio.play();
  }
  async function ignoreAlert(id) {
    if (listenAudio) { try { listenAudio.pause(); } catch (e) {} listenAudio = null; }
    await delAlert(id);
    await renderChecks();
  }
  async function rerecordAlert(id) {
    if (listenAudio) { try { listenAudio.pause(); } catch (e) {} listenAudio = null; }
    var p = String(id).split(".");
    var unit = VBV.idsFor ? VBV.idsFor(p[0], +p[1]) : { code: p[0], chapter: +p[1], name: verseRef(id).replace(/\.\d+$/, ""), ids: [id] };
    VBV.openVerseRecorder(unit, id);
  }

  /* ---------- Clear this chapter (local register only; never Drive) ---------- */
  VBV.clearChapter = function (code, ch, label) {
    var name = label || (refBookName(code) + " " + ch);
    if (!confirm("Clear " + name + " on this page? This does not delete any file in Drive.")) return;
    try { VBVStages.clearChapter(code + "-" + ch, name); } catch (e) { console.warn(e); }
    var ids = VBV.idsFor ? VBV.idsFor(code, ch).ids : [];
    if (storage && storage.forget) try { storage.forget(ids); } catch (e) {}
    if (VBV.setSaveState) VBV.setSaveState(ids.map(function (id) { return { index: id, state: null }; }));
    ids.forEach(function (id) { delAlert(id).catch(function () {}); });
    updateCheckBadge();
  };

  /* ---------- settings ---------- */
  function bindSettings() {
    var open = $("settingsBtn"), close = $("settingsClose"), scrim = $("scrim-settings"), drawer = $("drawer-settings");
    function hide() {
      if (drawer) { drawer.classList.remove("open"); drawer.hidden = true; }
      if (scrim) scrim.hidden = true;
      document.documentElement.classList.remove("kjb-drawer-open");
    }
    function show() {
      if (drawer) { drawer.hidden = false; drawer.classList.add("open"); }
      if (scrim) scrim.hidden = false;
      document.documentElement.classList.add("kjb-drawer-open");
    }
    if (open) open.addEventListener("click", show);
    if (close) close.addEventListener("click", hide);
    if (scrim) scrim.addEventListener("click", hide);
    $("ptSmaller") && $("ptSmaller").addEventListener("click", function () {
      localStorage.setItem(FS_KEY, String(Math.max(1, (parseInt(localStorage.getItem(FS_KEY) || "3", 10) || 3) - 1)));
      applyFont();
    });
    $("ptBigger") && $("ptBigger").addEventListener("click", function () {
      localStorage.setItem(FS_KEY, String(Math.min(6, (parseInt(localStorage.getItem(FS_KEY) || "3", 10) || 3) + 1)));
      applyFont();
    });
    var nums = $("ptNums");
    if (nums) {
      nums.checked = showNums();
      nums.addEventListener("change", function () {
        localStorage.setItem(NUM_KEY, nums.checked ? "1" : "0");
        renderVerse();
      });
    }
  }

  function bind() {
    $("recBtn").addEventListener("click", function () { onRecordStop().catch(function (e) { setStatus((e && e.message) || String(e), "err"); }); });
    $("reRecBtn").addEventListener("click", onRerecord);
    $("tab-tracker").addEventListener("click", function () { if (recording) return; showView("tracker"); });
    $("tab-checks").addEventListener("click", function () { if (recording) return; showView("checks"); });
    $("backTracker") && $("backTracker").addEventListener("click", function () { if (recording) return; showView("tracker"); });
    $("checkList").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".chk-btn");
      if (!b) return;
      var id = b.dataset.id, act = b.dataset.act;
      if (act === "listen") listenAlert(id);
      else if (act === "ignore") ignoreAlert(id);
      else if (act === "rerecord") rerecordAlert(id);
    });
    // One tap on a lined-up verse opens the recorder for that verse.
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("#vbvLined .vbvh-row");
      if (!b) return;
      var unit = VBV.unit && VBV.unit();
      if (!unit) return;
      var shown = (b.querySelector(".vbvh-ref") || {}).textContent || "";
      var id = unit.ids.filter(function (i) { return i.split(".").slice(1).join(":") === shown; })[0];
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      VBV.openVerseRecorder(unit, id);
    }, true);
  }

  function bootStorage() {
    storage = VBVDrive.createStorage({
      refOf: function (id) { return verseRef(id); }
    });
    storage.onVerseSaved(onSaved);
    VBV.storage = storage;
    storage.onQueueChange && storage.onQueueChange(function (q) {
      if (!VBV.setSaveState) return;
      VBV.setSaveState((q || []).map(function (it) {
        return { index: it.id, state: it.state === "saved" ? "saved" : (it.state === "failed" || it.error ? "failed" : "saving") };
      }));
    });
  }

  function boot() {
    applyFont();
    bindSettings();
    bind();
    bootStorage();
    updateCheckBadge();
    showView("tracker");
    if (window.KJB) KJB.setTop();
    warmupCheck();
    window.__kjvRamTakes = 0;
    window.KJVRec = {
      verseFileName: verseFileName,
      verseRef: verseRef,
      showView: showView,
      ramTakes: function () { return window.__kjvRamTakes || 0; },
      alerts: allAlerts,
      currentVerse: function () { return verseId; },
      injectTake: async function (opts) {
        opts = opts || {};
        if (opts.verseId) verseId = opts.verseId;
        if (!verseId) throw new Error("no verse");
        var take = {
          verseId: verseId,
          wav: opts.wav,
          fileName: verseFileName(verseId),
          durationS: opts.durationS || 0,
          resampled: false,
          silent: !!opts.silent,
          retake: true
        };
        setRam(take);
        setStatus("Saving…", "busy");
        var text = verseText(verseId);
        var token = "t" + Date.now();
        var checkP = opts.skipCheck ? Promise.resolve({ status: opts.silent ? "flagged" : "ok", note: opts.silent ? "Silence, or no words heard" : "", issues: opts.silent ? ["Silence, or no words heard"] : [], flags: [], silence: !!opts.silent }) : runCheck({ verseId: take.verseId, takeToken: token, wav: take.wav, text: text });
        if (VBV.setSaveState) VBV.setSaveState([{ index: take.verseId, state: "saving" }]);
        var saved = await saveTake(take).catch(function (e) { return { error: e }; });
        var checked = await checkP;
        if (take.silent && checked.status === "ok") {
          checked = { status: "flagged", note: "Silence, or no words heard", issues: ["Silence, or no words heard"], flags: [], silence: true };
        }
        if (checked.status === "ok" || checked.status === "not-checked") {
          await delAlert(take.verseId).catch(function () {});
          clearRam();
          if (checked.status === "ok") goNext();
          else { setStatus("Saved · Not checked", "warn"); goNext(); }
        } else {
          await putAlert({
            id: take.verseId,
            file: take.fileName,
            note: checked.note || "Flagged",
            issues: checked.issues || [],
            flags: checked.flags || [],
            silence: !!checked.silence,
            wav: take.wav,
            at: new Date().toISOString()
          });
          clearRam();
          setStatus("Saved · flagged — see Checks", "warn");
          updateCheckBadge();
          goNext();
        }
        return { saved: saved, checked: checked, ram: window.__kjvRamTakes, next: verseId };
      }
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
