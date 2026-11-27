/* Extracted verbatim from live index.html (vbv-drive.js). Do not edit to change save behaviour. */
/* ---- vbv-drive.js ---- */
/* VBV M4: Drive Save. The recorder's storage (§E) backed by Google Drive.
   Writes only into 00 Inbox (by id). Exact whole-name match 'Book C.V.wav'. New file = one multipart/resumable create;
   retake = media PATCH on the stored fileId. Before a create, the exact name is looked up in the Inbox and the
   02 KJB verse audio book folders (by id chain) so a retake never duplicates. Queue lives in IndexedDB.
   Uses only the page's existing token (drive.file + drive.metadata.readonly). Never logs a token or key. */
(function () {
  'use strict';
  var INBOX = '1gTlRsu_nVCdeErA6uykcsGc3IikESxa2';
  var ROOT = '1YztdP5Gd_3Is3SrQ7LXz588nhZXq_KAf';
  var TOKEN_KEY = 'kjb1.google.token.v1';
  var PICK_KEY = 'vbv.drive.inboxFolder.v1';
  var API = 'https://www.googleapis.com/drive/v3/files';
  var UP = 'https://www.googleapis.com/upload/drive/v3/files';
  var FIELDS = 'id,name,parents,sha256Checksum,size,appProperties,properties';
  var PICKER = {"appId": "456053541349", "key": "AIzaSyAJhoFJTyoEIMx00CmQRKVe7uOPD-lOhUQ"}; // filled at build time from the base page's own constants; never printed

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function sha256(ab) { return crypto.subtle.digest('SHA-256', ab).then(hex); }
  function err(kind, msg, extra) { var e = new Error(msg); e.kind = kind; if (extra) for (var k in extra) e[k] = extra[k]; return e; }

  /* ---------- IndexedDB ---------- */
  function idb() {
    if (idb.p) return idb.p;
    idb.p = new Promise(function (res, rej) {
      var r = indexedDB.open('vbv.queue.v1', 1);
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('takes')) d.createObjectStore('takes', { keyPath: 'id' }); if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
    return idb.p;
  }
  function tx(store, mode, fn) { return idb().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction(store, mode), s = t.objectStore(store), out; var q = fn(s); if (q) q.onsuccess = function () { out = q.result; }; t.oncomplete = function () { res(out); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); }; }); }); }
  var put = function (store, v) { return tx(store, 'readwrite', function (s) { return s.put(v); }); };
  var del = function (store, k) { return tx(store, 'readwrite', function (s) { return s.delete(k); }); };
  var all = function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); };
  var get = function (store, k) { return tx(store, 'readonly', function (s) { return s.get(k); }); };

  /* ---------- token + folder grant ---------- */
  var badToken = null, authListeners = [];
  function token() {
    try { var t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); if (t && t.token && t.expiresAt > Date.now() + 30000 && t.token !== badToken) return t.token; } catch (e) {}
    return null;
  }
  function inboxGranted() { try { return localStorage.getItem(PICK_KEY) === INBOX; } catch (e) { return false; } }
  function tokenOk() { return !!token(); }
  function authState() {
    var tok = tokenOk(), folder = inboxGranted();
    if (tok && folder) return { kind: 'ok', label: 'Drive: signed in' };
    if (tok && !folder) return { kind: 'pick', label: 'Drive: signed in, pick 00 Inbox' };
    return { kind: 'off', label: 'Drive: not signed in' };
  }
  function onAuthChange(f) { authListeners.push(f); return function () { authListeners = authListeners.filter(function (x) { return x !== f; }); }; }
  function notifyAuth() { var s = authState(); authListeners.slice().forEach(function (f) { try { f(s); } catch (e) {} }); }

  /* ---------- HTTP ---------- */
  function call(method, url, tok, body, headers) {
    var h = { Authorization: 'Bearer ' + tok }; if (headers) for (var k in headers) h[k] = headers[k];
    return fetch(url, { method: method, headers: h, body: body }).then(function (r) {
      if (r.ok) return r;
      return r.text().then(function (t) {
        var reason = ''; try { var j = JSON.parse(t); reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || (j.error && j.error.status) || ''; } catch (e) {}
        if (r.status === 401) { badToken = tok || badToken; notifyAuth(); }
        throw err(r.status === 401 ? 'auth' : 'http', 'Drive answered ' + r.status + (reason ? ' (' + reason + ')' : ''), { status: r.status, reason: reason });
      });
    }, function () { throw err('offline', 'No connection to Google Drive'); });
  }
  function json(r) { return r.json(); }
  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  function createStorage(opts) {
    opts = opts || {};
    // same policy as KJBVR src/save/retry.js: 3 attempts in all, 2 s then 4 s (then 8 s if the cap is raised); auth never auto-retries.
    // The recorder itself never retries (it only calls retry() on Try again), so there is one retry loop, here.
    var maxTries = opts.maxAutoRetries || 3, baseMs = opts.retryDelayMs || 2000;
    var bigBytes = opts.resumableOver || 4.5 * 1024 * 1024;
    var refOf = opts.refOf || function (id) { return id; };
    var items = new Map(), files = new Map(), listeners = [], savedCbs = [], busy = false, stopped = false, timer = 0, parentCache = new Map();
    var ready = Promise.all([all('takes'), all('files')]).then(function (r) {
      (r[1] || []).forEach(function (f) { files.set(f.id, f); });
      (r[0] || []).forEach(function (t) { if (t.state !== 'saved' && !items.has(t.id)) { t.state = t.state === 'needs-signin' ? 'needs-signin' : 'saving'; t.tries = 0; t.nextAt = 0; items.set(t.id, t); } });
      emit(); kick();
    }).catch(function () { emit(); });

    function isStitch(t) { return t.kind === 'stitch'; }
    function isSide(t) { return t.kind === 'stitch' || t.kind === 'passage'; } // m4.0: not a verse
    var waiters = new Map(); // m4.0: id -> {res, rej}; settled when Drive confirms (or gives up)
    function settle(id, e, r) { var w = waiters.get(id); if (!w) return; waiters.delete(id); if (e) w.rej(e); else w.res(r); }
    function waitFor(p) { return p.then(function (q) { return new Promise(function (res, rej) { waiters.set(q.id, { res: function (r) { res(Object.assign({}, q, r)); }, rej: rej }); }); }); }
    function pub(t) { return { id: t.id, file: t.file, state: t.state, tries: t.tries, error: t.error || null, at: t.at, drive_id: t.drive_id || null, sha256: t.sha256, why: t.why || null }; }
    function queue() { return Array.from(items.values()).filter(function (t) { return !isSide(t); }).map(pub); }
    function stitchQueue() { return Array.from(items.values()).filter(isStitch).map(pub); }
    function emit() { var q = queue(); listeners.slice().forEach(function (f) { try { f(q); } catch (e) {} }); }
    function persist(t) { return put('takes', t).catch(function () {}); }
    function set(t, state, error, why) { t.state = state; t.error = error || null; t.why = why || null; persist(t); emit(); }

    function enqueue(t) {
      items.set(t.id, t);
      return put('takes', t).then(function () { emit(); kick(); return { queued: true, sha256: t.sha256, file: t.file, id: t.id }; });
    }
    function saveVerse(id, wav, meta) {
      meta = meta || {};
      var gate = meta.gate && meta.gate.overall;
      if (gate !== 'PASS' && gate !== 'WARN-OK' && gate !== 'WARN') return Promise.reject(err('refused', 'A take that failed the check is never saved'));
      var ab = wav instanceof ArrayBuffer ? wav : (wav.buffer ? wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) : wav);
      return sha256(ab).then(function (sum) {
        var prev = items.get(id);
        return enqueue({ id: id, file: meta.file || (refOf(id) + '.wav'), wav: ab, sha256: sum, meta: meta, gate: gate === 'WARN' ? 'WARN-OK' : gate,
          state: 'saving', tries: 0, nextAt: 0, at: new Date().toISOString(), seq: Math.max((prev && prev.seq) || 0, (files.get(id) || {}).rev || 0) + 1, drive_id: (files.get(id) || {}).fileId || null, mime: 'audio/wav' });
      });
    }
    // m3.7: Stitch now writes a plain-text request into 00 Inbox; same queue, lookup-by-name overwrite, and retry as a verse WAV
    function saveStitchRequest(spec) {
      spec = spec || {};
      var book = spec.book, chapter = spec.chapter == null ? null : spec.chapter;
      var file = spec.name || (chapter == null ? book + '.stitch-request' : book + ' ' + chapter + '.stitch-request');
      var body = JSON.stringify(Object.assign({ book: book, chapter: chapter, requestedAt: spec.requestedAt || new Date().toISOString(), verses: spec.verses | 0 }, spec.extra || {}));
      var u8 = new TextEncoder().encode(body), ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      var id = 'stitch:' + file;
      return sha256(ab).then(function (sum) {
        var prev = items.get(id);
        return enqueue({ id: id, kind: 'stitch', file: file, mime: 'text/plain', wav: ab, sha256: sum, meta: {}, gate: null,
          state: 'saving', tries: 0, nextAt: 0, at: new Date().toISOString(), seq: Math.max((prev && prev.seq) || 0, (files.get(id) || {}).rev || 0) + 1, drive_id: (files.get(id) || {}).fileId || null });
      });
    }
    // m4.0: whole-passage WAV ('Genesis 1.1-31.wav') into 00 Inbox; same queue, lookup-by-name overwrite and retry as a verse WAV
    function savePassage(file, wav) {
      var ab = wav instanceof ArrayBuffer ? wav : wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength), id = 'passage:' + file;
      return sha256(ab).then(function (sum) {
        var prev = items.get(id);
        return enqueue({ id: id, kind: 'passage', file: file, mime: 'audio/wav', wav: ab, sha256: sum, meta: {}, gate: null,
          state: 'saving', tries: 0, nextAt: 0, at: new Date().toISOString(), seq: Math.max((prev && prev.seq) || 0, (files.get(id) || {}).rev || 0) + 1, drive_id: (files.get(id) || {}).fileId || null });
      });
    }

    function next() { var now = Date.now(), best = null; items.forEach(function (t) { if (t.state === 'saving' && (t.nextAt || 0) <= now && !best) best = t; }); return best; }
    function kick() {
      if (busy || stopped) return;
      var t = next(); if (!t) return;
      busy = true;
      var seq = t.seq;
      upload(t).then(function (r) {
        busy = false;
        if (items.get(t.id) !== t || t.seq !== seq) { kick(); return; } // a newer take replaced it while uploading: it uploads next (PATCH)
        t.drive_id = r.fileId; files.set(t.id, { id: t.id, fileId: r.fileId, sha256: r.sha256, at: t.at, rev: t.seq, file: t.file });
        put('files', files.get(t.id)).catch(function () {});
        delete t.wav; t.state = 'saved'; t.error = null; t.why = null; del('takes', t.id).catch(function () {}); emit();
        settle(t.id, null, { fileId: r.fileId, replaced: r.replaced });
        if (!isSide(t)) {
          var m = t.meta || {};
          var h = { id: t.id, ref: refOf(t.id), file: t.file, drive_id: r.fileId, sha256: t.sha256, bytes: r.bytes, duration_s: m.duration_s, speech_start_s: m.speech_start_s, speech_end_s: m.speech_end_s, gate: t.gate, take_at: m.take_at, retake: !!m.retake, resampled: !!m.resampled, replaced: r.replaced };
          savedCbs.slice().forEach(function (f) { try { f(h); } catch (e) {} });
        }
        kick();
      }, function (e) {
        busy = false;
        if (items.get(t.id) !== t) { kick(); return; }
        if (e.kind === 'auth' || e.kind === 'signin' || e.kind === 'folder') {
          if (e.kind === 'auth') badToken = e.token || badToken;
          // every waiting take needs the same sign-in
          items.forEach(function (x) { if (x.state === 'saving' || x === t) { set(x, 'needs-signin', e.message, e.kind === 'folder' ? 'folder' : 'signin'); settle(x.id, e); } });
          return;
        }
        t.tries++;
        var auto = e.kind !== 'final' && e.kind !== 'refused' && t.tries < maxTries;
        set(t, 'failed', e.message, e.kind);
        if (auto) { t.retryAt = Date.now() + baseMs * Math.pow(2, t.tries - 1); schedule(); } else settle(t.id, e);
        kick();
      });
    }
    function schedule() {
      clearTimeout(timer); var soon = Infinity;
      items.forEach(function (t) { if (t.state === 'failed' && t.retryAt && t.retryAt < soon) soon = t.retryAt; });
      if (soon === Infinity) return;
      timer = setTimeout(function () { var now = Date.now(); items.forEach(function (t) { if (t.state === 'failed' && t.retryAt && t.retryAt <= now + 20) { t.retryAt = 0; set(t, 'saving'); } }); schedule(); kick(); }, Math.max(0, soon - Date.now()));
    }

    /* ---------- Drive steps ---------- */
    function parentsOf(id, tok) {
      if (parentCache.has(id)) return Promise.resolve(parentCache.get(id));
      return call('GET', API + '/' + encodeURIComponent(id) + '?fields=id,parents&supportsAllDrives=true', tok).then(json).then(function (j) { var p = j.parents || []; parentCache.set(id, p); return p; }, function (e) { if (e.kind === 'http' && e.status === 404) return []; throw e; });
    }
    // is folder id the Inbox, or a book folder inside 02 KJB verse audio (book -> OT/NT -> root), matched by id only
    function inTree(folder, tok, depth) {
      if (folder === INBOX || folder === ROOT) return Promise.resolve(true);
      if (depth >= 3) return Promise.resolve(false);
      return parentsOf(folder, tok).then(function (ps) {
        var i = 0; function step() { if (i >= ps.length) return false; return inTree(ps[i++], tok, depth + 1).then(function (ok) { return ok || step(); }); } return step();
      });
    }
    function lookup(name, id, tok, skip) {
      var q = "name = '" + esc(name) + "' and trashed = false";
      var url = API + '?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name,parents,modifiedTime,appProperties,properties)') + '&pageSize=50&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true';
      return call('GET', url, tok).then(json).then(function (j) {
        var hits = (j.files || []).filter(function (f) { return f.name === name && f.id !== skip; }); // whole-name match only, never a prefix
        var ok = [], i = 0;
        function step() {
          if (i >= hits.length) return ok;
          var f = hits[i++], ps = f.parents || [], k = 0;
          function p() { if (k >= ps.length) return false; return inTree(ps[k++], tok, 0).then(function (y) { return y || p(); }); }
          return Promise.resolve(p()).then(function (y) { if (y) ok.push(f); return step(); });
        }
        return Promise.resolve(step()).then(function (list) {
          list.sort(function (a, b) {
            var av = ((a.appProperties || {}).vbv_id === id || (a.properties || {}).vbv_id === id) ? 1 : 0, bv = ((b.appProperties || {}).vbv_id === id || (b.properties || {}).vbv_id === id) ? 1 : 0;
            return bv - av || String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''));
          });
          return list;
        });
      });
    }
    function props(t) {
      var p = (window.KJBVR && KJBVR.verseProperties) ? KJBVR.verseProperties({ id: t.id, sha256: t.sha256, takeAt: (t.meta && t.meta.take_at) || t.at, gate: t.gate, rev: t.seq, trim: 'half' }) : {};
      // INTERFACES' seven keys minus vbv_stitch_req (withdrawn by CoS 18:31; stitching is automatic), so six are written
      var out = { vbv_id: t.id, vbv_sha256: t.sha256, vbv_take_at: (t.meta && t.meta.take_at) || t.at, vbv_gate: t.gate, vbv_rev: String(t.seq), vbv_trim: 'half' };
      for (var k in p) if (k !== 'vbv_stitch_req' && p[k] != null) out[k] = String(p[k]);
      return out;
    }
    function multipart(meta, ab, mime) {
      var b = 'vbv' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      var head = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: ' + (mime || 'audio/wav') + '\r\n\r\n';
      return { body: new Blob([head, ab, '\r\n--' + b + '--']), type: 'multipart/related; boundary=' + b };
    }
    function send(method, fileId, meta, t, tok) {
      var base = UP + (fileId ? '/' + encodeURIComponent(fileId) : '');
      var qs = '&fields=' + encodeURIComponent(FIELDS) + '&supportsAllDrives=true';
      var mime = t.mime || 'audio/wav';
      if (t.wav.byteLength <= bigBytes) {
        var mp = multipart(meta, t.wav, mime);
        return call(method, base + '?uploadType=multipart' + qs, tok, mp.body, { 'Content-Type': mp.type }).then(json);
      }
      return call(method, base + '?uploadType=resumable' + qs, tok, JSON.stringify(meta), { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(t.wav.byteLength) })
        .then(function (r) { var loc = r.headers.get('Location'); if (!loc) throw err('http', 'Drive gave no upload address'); return call('PUT', loc, tok, new Blob([t.wav]), { 'Content-Type': mime }).then(json); });
    }
    function verify(res, t, tok) {
      var got = res.sha256Checksum ? Promise.resolve(res) : call('GET', API + '/' + encodeURIComponent(res.id) + '?fields=id,sha256Checksum,size&supportsAllDrives=true', tok).then(json).catch(function () { return {}; });
      return got.then(function (g) {
        if (g.sha256Checksum && g.sha256Checksum.toLowerCase() !== t.sha256) throw err('checksum', 'Saved file did not match the take (checksum)');
        return { fileId: res.id, sha256: t.sha256, verified: !!g.sha256Checksum, bytes: Number(g.size || res.size || t.wav.byteLength) };
      });
    }
    function upload(t) {
      var tok = token();
      if (!tok) return Promise.reject(err('signin', 'Google sign-in has run out'));
      if (!inboxGranted()) return Promise.reject(err('folder', 'Choose the 00 Inbox folder once'));
      var meta = isSide(t) ? {} : props(t);
      var mime = t.mime || 'audio/wav';
      function wrap(e) { if (e && e.kind === 'auth') e.token = tok; throw e; }
      function patch(fileId) {
        return send('PATCH', fileId, { appProperties: meta, properties: meta, mimeType: mime }, t, tok).then(function (res) { return verify(res, t, tok); }).then(function (r) { r.replaced = true; return r; });
      }
      function create() {
        return send('POST', null, { name: t.file, parents: [INBOX], mimeType: mime, appProperties: meta, properties: meta }, t, tok)
          .then(function (res) { return verify(res, t, tok).then(function (r) { r.replaced = false; return r; }); })
          .catch(function (e) { if (e.kind === 'http' && e.status === 404) { try { localStorage.removeItem(PICK_KEY); } catch (x) {} throw err('folder', 'Choose the 00 Inbox folder once'); } throw e; });
      }
      function viaLookup(skip) {
        return lookup(t.file, t.id, tok, skip).then(function (list) { return list.length ? patch(list[0].id) : create(); });
      }
      // Same path as a first whole-passage send: find the exact name in 00 Inbox (or the inbox tree) and overwrite, or create in 00 Inbox.
      // Do not PATCH a remembered fileId that may sit outside 00 Inbox — that is what made verse-by-verse say "Saved" with no WAV in the inbox.
      var p = viaLookup(null);
      return p.catch(function (e) {
        if (e.kind === 'http' && e.status === 403 && /insufficient|forbidden|appNotAuthorized|cannotModify/i.test(e.reason || '')) throw err('final', 'This page may not replace that file in Drive (it was not made here)', { status: 403 });
        throw e;
      }).catch(wrap);
    }

    function retry(id, auto) {
      items.forEach(function (t) { if (auto && t.why === 'final') return; if ((id == null || t.id === id) && (t.state === 'failed' || t.state === 'needs-signin')) { t.retryAt = 0; t.tries = 0; set(t, 'saving'); } });
      kick();
    }
    window.addEventListener('online', function () { retry(null, true); });
    if (window.KJB && KJB.on) KJB.on('google-token', function () { badToken = null; items.forEach(function (t) { if (t.state === 'needs-signin' && (t.why !== 'folder' || inboxGranted())) set(t, 'saving'); }); kick(); });

    return {
      kind: 'drive', ready: ready,
      saveVerse: function (id, wav, meta) { return waitFor(saveVerse(id, wav, meta)); },
      saveStitchRequest: saveStitchRequest,
      savePassage: function (file, wav) { return waitFor(savePassage(file, wav)); },
      saveStitchRequestConfirmed: function (spec) { return waitFor(saveStitchRequest(spec)); },
      pending: function () { var n = 0; items.forEach(function (t) { if (!isSide(t) && t.state !== 'saved') n++; }); return n; },
      stitchQueue: stitchQueue,
      queue: queue,
      onQueueChange: function (f) { listeners.push(f); return function () { listeners = listeners.filter(function (x) { return x !== f; }); }; },
      onVerseSaved: function (f) { savedCbs.push(f); return function () { savedCbs = savedCbs.filter(function (x) { return x !== f; }); }; },
      stateOf: function (id) { var t = items.get(id); if (t) return t.state === 'saved' ? 'saved' : t.state === 'saving' ? 'saving' : 'not-saved'; return files.has(id) ? 'saved' : null; },
      // m4.2 Clear this chapter: forget this device's record of these ids (queued takes not yet in Drive, and the remembered Drive file id).
      // Local only: no Drive call. A later take finds the same-named file in 00 Inbox by name and overwrites it, as on a fresh device.
      forget: function (ids) { ids.forEach(function (id) { items.delete(id); settle(id, err('cleared', 'Chapter cleared')); if (files.has(id)) { files.delete(id); del('files', id).catch(function () {}); } del('takes', id).catch(function () {}); }); emit(); },
      fileIdOf: function (id) { return (files.get(id) || {}).fileId || null; },
      retry: retry,
      needsSignIn: function () { var n = false; items.forEach(function (t) { if (t.state === 'needs-signin') n = t.why || 'signin'; }); return n; },
      getVerse: function (id) { var t = items.get(id); if (t && t.wav) return Promise.resolve(t.wav); return get('takes', id).then(function (r) { return r && r.wav ? r.wav : null; }); },
      listUnit: function () { return Promise.resolve(Array.from(files.values())); },
      readUnitStatus: function () { return Promise.resolve(null); },
      stop: function () { stopped = true; clearTimeout(timer); },
    };
  }

  /* ---------- Sign in again (needs a click) ---------- */
  function pickInbox() {
    return new Promise(function (res, rej) {
      var tok = token(); if (!tok) return rej(err('signin', 'Sign in first'));
      var cfg = typeof PICKER === 'object' ? PICKER : null; if (!cfg || !cfg.key) return rej(err('setup', 'Picker is not set up on this page'));
      KJB.google.loadGapi().then(function () {
        gapi.load('picker', { callback: function () {
          try {
            var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
            if (view.setParent) view.setParent(ROOT);
            new google.picker.PickerBuilder().setAppId(cfg.appId).setDeveloperKey(cfg.key).setOAuthToken(tok).addView(view)
              .setTitle('Choose the folder named 00 Inbox (inside 02 KJB verse audio)')
              .setCallback(function (d) {
                if (d.action === google.picker.Action.CANCEL) return rej(err('cancel', 'No folder chosen'));
                if (d.action !== google.picker.Action.PICKED) return;
                var doc = (d.docs || [])[0] || {};
                if (doc.id !== INBOX) return rej(err('wrong', 'That is not the 00 Inbox folder. Choose 00 Inbox inside 02 KJB verse audio.'));
                try { localStorage.setItem(PICK_KEY, INBOX); } catch (e) {}
                notifyAuth();
                res(INBOX);
              }).build().setVisible(true);
          } catch (e) { rej(err('setup', 'Google Picker could not open')); }
        }, onerror: function () { rej(err('setup', 'Google Picker could not load')); } });
      }, function () { rej(err('setup', 'Google Picker could not load')); });
    });
  }
  function signInAgain() {
    return new Promise(function (res, rej) {
      if (token()) return res(true);
      KJB.google.loadGis().then(function () {
        var c = KJB.google.tokenClient({ who: 'vbv', callback: function (r) { if (r && r.access_token) res(true); else rej(err('signin', 'Sign-in did not finish')); }, error_callback: function () { rej(err('signin', 'Sign-in did not finish')); } });
        c.requestAccessToken({ prompt: '' });
      }, function () { rej(err('setup', 'Google sign-in could not load')); });
    }).then(function () { badToken = null; notifyAuth(); return inboxGranted() ? INBOX : pickInbox(); });
  }

/* ---------- m3.7: read-only list of VideoBot status files (never writes) ---------- */
  var STATUS_FOLDER = '1JkplywPuY1HmqKz5RvsIt-iJKlG1l493';
  function listStatusFolder() {
    var tok = token();
    if (!tok) return Promise.reject(err('signin', 'Status not available yet'));
    var base = (window.VBVVideoStatus && VBVVideoStatus.listUrl) ? VBVVideoStatus.listUrl(STATUS_FOLDER)
      : 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'" + STATUS_FOLDER + "' in parents and trashed = false") +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,modifiedTime)') + '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true';
    function page(pageToken, acc) {
      var url = base + (pageToken ? (base.indexOf('?') >= 0 ? '&' : '?') + 'pageToken=' + encodeURIComponent(pageToken) : '');
      return call('GET', url, tok).then(json).then(function (j) {
        var files = acc.concat(j.files || []);
        return j.nextPageToken ? page(j.nextPageToken, files) : files;
      });
    }
    return page(null, []).catch(function (e) {
      throw err(e.kind || 'http', 'Status not available yet', { status: e.status, reason: e.reason });
    });
  }

  function readStatusFile(id) {
    var tok = token();
    if (!tok || !id) return Promise.resolve(null);
    return call('GET', API + '/' + encodeURIComponent(id) + '?alt=media', tok).then(function (r) { return r.text(); }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { return null; }
    }).catch(function () { return null; });
  }
  if (window.KJB && KJB.on) {
    KJB.on('google-token', function () { badToken = null; notifyAuth(); });
    KJB.on('google-token-cleared', function () { notifyAuth(); });
  }
  window.VBVDrive = { createStorage: createStorage, signInAgain: signInAgain, pickInbox: pickInbox, inboxGranted: inboxGranted, tokenOk: tokenOk, authState: authState, onAuthChange: onAuthChange, INBOX: INBOX, ROOT: ROOT, PICK_KEY: PICK_KEY, listStatusFolder: listStatusFolder, readStatusFile: readStatusFile, STATUS_FOLDER: STATUS_FOLDER };

})();
