/* Light page shell: event bus, one Google sign-in (same client and token key as live), wake lock, header height. */
(function () {
  "use strict";
  var BUILD = "recorder-test-sync-20261127";
  var KJB = window.KJB = { build: BUILD };
  var H = {};
  KJB.on = function (n, f) { (H[n] = H[n] || []).push(f); };
  KJB.emit = function (n, d) { (H[n] || []).slice().forEach(function (f) { try { f(d); } catch (e) { console.warn(e); } }); };

  var CLIENT = "456053541349-mqe47qb198sts80j0oqkrqof1ep5gtb0.apps.googleusercontent.com";
  var FILE = "https://www.googleapis.com/auth/drive.file";
  var META = "https://www.googleapis.com/auth/drive.metadata.readonly";

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { s.remove(); rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  var gisP = null, gapiP = null, real = null, active = null;
  function ensureReal() {
    if (real) return real;
    real = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT,
      scope: G.SCOPE,
      include_granted_scopes: false,
      callback: function (r) {
        var a = active; active = null;
        if (a && a.opts.callback) a.opts.callback(r);
        G.noteToken(r, a ? a.who : "?");
      },
      error_callback: function (e) {
        var a = active; active = null;
        if (a && a.opts.error_callback) a.opts.error_callback(e);
      }
    });
    return real;
  }

  var G = KJB.google = {
    TOKEN_KEY: "kjb1.google.token.v1",
    FILE: FILE,
    META: META,
    SCOPE: FILE + " " + META + " openid email", // test-sync: openid email lets the same Google sign-in also open Firebase
    loadGis: function () {
      if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
      return gisP || (gisP = loadScript("https://accounts.google.com/gsi/client").catch(function (e) { gisP = null; throw e; }));
    },
    loadGapi: function () {
      if (window.gapi && gapi.load) return Promise.resolve();
      return gapiP || (gapiP = loadScript("https://apis.google.com/js/api.js").catch(function (e) { gapiP = null; throw e; }));
    },
    tokenClient: function (opts) {
      var who = opts.who || "?";
      ensureReal();
      return {
        requestAccessToken: function (o) {
          ensureReal();
          active = { opts: opts, who: who };
          real.requestAccessToken(o || {});
        }
      };
    },
    noteToken: function (r, who) {
      if (!r || r.error || typeof r.access_token !== "string" || !r.access_token) return;
      try { if (!google.accounts.oauth2.hasGrantedAllScopes(r, FILE, META)) return; } catch (e) { return; }
      var exp = Date.now() + Math.max(0, Number(r.expires_in) * 1000 - 30000);
      if (!isFinite(exp) || Date.now() >= exp) return;
      try { localStorage.setItem(G.TOKEN_KEY, JSON.stringify({ token: r.access_token, expiresAt: exp })); } catch (e) {}
      KJB.emit("google-token", { token: r.access_token, expiresAt: exp, from: who });
    },
    forget: function (who) { KJB.emit("google-token-cleared", { from: who }); }
  };

  var wakeWhy = {}, wakeLock = null, wakeAsking = false;
  function wakeWant() { return Object.keys(wakeWhy).length > 0; }
  function wakeSync() {
    if (wakeWant()) {
      if (wakeLock || wakeAsking || !navigator.wakeLock || document.visibilityState !== "visible") return;
      wakeAsking = true;
      navigator.wakeLock.request("screen").then(function (l) {
        wakeAsking = false;
        if (!wakeWant()) { l.release().catch(function () {}); return; }
        wakeLock = l;
        l.addEventListener("release", function () { if (wakeLock === l) wakeLock = null; });
      }, function () { wakeAsking = false; });
    } else if (wakeLock) {
      var l = wakeLock; wakeLock = null; l.release().catch(function () {});
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") wakeSync();
  });
  KJB.wake = {
    hold: function (why) { wakeWhy[why || "rec"] = true; wakeSync(); },
    release: function (why) { delete wakeWhy[why || "rec"]; wakeSync(); },
    state: function () { return { reasons: Object.keys(wakeWhy), held: !!wakeLock }; }
  };

  function setScale() {
    var w = window.innerWidth || 1024;
    document.documentElement.style.setProperty("--scale", String(Math.min(Math.max(w / 2048, 0.5), 1366 / 2048)));
  }
  KJB.setScale = setScale;
  KJB.setTop = function () {
    var top = document.getElementById("shell-top");
    if (top) document.documentElement.style.setProperty("--kjb-top", Math.round(top.getBoundingClientRect().height) + "px");
  };
  setScale();
  addEventListener("resize", function () { setScale(); KJB.setTop(); });
  document.addEventListener("DOMContentLoaded", function () {
    setScale();
    KJB.setTop();
    var top = document.getElementById("shell-top");
    if (window.ResizeObserver && top) new ResizeObserver(KJB.setTop).observe(top);
  });
})();
