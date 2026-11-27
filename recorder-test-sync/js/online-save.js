/* test-sync (Builder-bot, 2026-11-27): online save of recorder progress.
   - Uses the SAME Google sign-in the page already has for Drive (token key kjb1.google.token.v1). No new button, no second login.
   - Firebase project bible-reading-tracker-18cf8 (same as the reader), Realtime Database path users/<uid>/recorder-progress.
     Its own Firebase app name, so signing in or out of the reader never changes this page, and the other way round.
   - Merge only: on load the online copy is folded into this device's (higher stage per verse wins, never lowers);
     after a verse is saved locally, its mark is written online. Nothing online is ever deleted.
   - Fail-soft: if anything here fails, the recorder works exactly as before. Never logs a token or key. */
(function () {
  'use strict';
  if (!window.VBVStages || !VBVStages.absorb) return;
  var FB_CONFIG = {
    apiKey: 'AIzaSyCvK1qqhrdqvKiaJIZrPORbeOcQKPpNyoI',
    authDomain: 'bible-reading-tracker-18cf8.firebaseapp.com',
    databaseURL: 'https://bible-reading-tracker-18cf8-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'bible-reading-tracker-18cf8',
    storageBucket: 'bible-reading-tracker-18cf8.firebasestorage.app',
    messagingSenderId: '577346979030',
    appId: '1:577346979030:web:014b5407d905fedd9cb577'
  };
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var TOKEN_KEY = 'kjb1.google.token.v1', APP_NAME = 'kjv-recorder';
  var A = null, D = null, auth = null, db = null, user = null, ready = false, mirror = null, timer = 0, triedTok = '', busy = false;
  var st = { status: 'off', note: '' };
  var el = document.getElementById('onlineSave');

  function say(status, text) {
    st.status = status; st.note = text;
    if (el && el.textContent !== text) el.textContent = text;
  }
  function why(e) {
    var s = String((e && (e.code || '')) + ' ' + (e && e.message || e || ''));
    if (/audience|not authorized|INVALID_IDP_RESPONSE|invalid-credential|operation-not-allowed|CONFIGURATION_NOT_FOUND/i.test(s)) return 'Online save off (Firebase setting needed). Saved on this device.';
    if (/PERMISSION_DENIED|permission-denied|permission_denied/i.test(s)) return 'Online save off (database rule needed). Saved on this device.';
    if (/network|offline|unavailable|Failed to fetch|import/i.test(s)) return 'Online save off (no connection). Saved on this device.';
    return 'Online save off. Saved on this device.';
  }
  function googleToken() {
    try { var t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); if (t && t.token && t.expiresAt > Date.now() + 30000) return t.token; } catch (e) {}
    return '';
  }
  function clean(x) { return x == null ? null : JSON.parse(JSON.stringify(x, function (k, v) { return k === 'stitch_req' ? undefined : v; })); }
  function path(rest) { return 'users/' + user.uid + '/recorder-progress' + (rest ? '/' + rest : ''); }
  function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  /* Everything on this device that the online copy does not have yet, as one multi-path update. Never removes anything. */
  function diff(local, cloud) {
    var up = {}, n = 0; cloud = cloud || {};
    var cv = cloud.verses || {}, cu = cloud.units || {}, cc = cloud.cleared || {};
    Object.keys(local.verses || {}).forEach(function (ck) { var lv = local.verses[ck] || {}, cvc = cv[ck] || {};
      Object.keys(lv).forEach(function (vk) { var r = clean(lv[vk]); if (!eq(r, cvc[vk])) { up['verses/' + ck + '/' + vk] = r; n++; } }); });
    Object.keys(local.units || {}).forEach(function (u) { var r = clean(local.units[u]); if (!eq(r, cu[u])) { up['units/' + u] = r; n++; } });
    Object.keys(local.cleared || {}).forEach(function (k) { if (local.cleared[k] !== cc[k]) { up['cleared/' + k] = local.cleared[k]; n++; } });
    if (n) { up.app = local.app; up.version = local.version; up.saved = local.saved || new Date().toISOString(); }
    return n ? up : null;
  }
  function applyToMirror(up) {
    mirror = mirror || { verses: {}, units: {}, cleared: {} };
    Object.keys(up).forEach(function (p) { var parts = p.split('/'), o = mirror;
      for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]] || (o[parts[i]] = {});
      o[parts[parts.length - 1]] = up[p]; });
  }
  function push() {
    if (!ready || !user) return Promise.resolve();
    var up = diff(VBVStages.doc(), mirror);
    if (!up) { say('on', 'Progress saved online'); return Promise.resolve(); }
    return D.update(D.ref(db, path()), up).then(function () { applyToMirror(up); say('on', 'Progress saved online'); })
      .catch(function (e) { say('error', why(e)); });
  }
  function schedule() { if (!ready) return; clearTimeout(timer); timer = setTimeout(push, 400); }

  function firstSync() {
    if (busy) return; busy = true;
    say('busy', 'Online save: checking\u2026');
    D.get(D.ref(db, path())).then(function (snap) {
      var cloud = snap.exists() ? snap.val() : null;
      mirror = cloud && typeof cloud === 'object' ? cloud : { verses: {}, units: {}, cleared: {} };
      if (cloud && VBVStages.valid(cloud)) VBVStages.absorb(cloud);
      ready = true;
      return push();
    }).catch(function (e) { ready = false; say('error', why(e)); }).then(function () { busy = false; });
  }

  function trySignIn() {
    if (!A || user) return;
    var tok = googleToken();
    if (!tok) { say('off', 'Online save off until Drive is signed in'); return; }
    if (tok === triedTok) return; triedTok = tok;
    say('busy', 'Online save: connecting\u2026');
    A.signInWithCredential(auth, A.GoogleAuthProvider.credential(null, tok)).catch(function (e) { say('error', why(e)); });
  }

  VBVStages.onChange(function () { schedule(); });
  if (window.KJB && KJB.on) KJB.on('google-token', function () { setTimeout(trySignIn, 0); });

  Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-database.js')]).then(function (m) {
    var appMod = m[0]; A = m[1]; D = m[2];
    var app = (appMod.getApps() || []).filter(function (a) { return a.name === APP_NAME; })[0] || appMod.initializeApp(FB_CONFIG, APP_NAME);
    auth = A.getAuth(app); db = D.getDatabase(app, FB_CONFIG.databaseURL);
    return Promise.resolve(A.setPersistence(auth, A.browserLocalPersistence)).catch(function () {}).then(function () {
      A.onAuthStateChanged(auth, function (u) {
        user = u || null; ready = false; mirror = null;
        if (user) firstSync(); else trySignIn();
      });
    });
  }).catch(function (e) { say('error', why(e)); });

  window.VBVOnline = { state: function () { return { status: st.status, note: st.note, signedIn: !!user, ready: ready }; }, _diff: diff };
})();
