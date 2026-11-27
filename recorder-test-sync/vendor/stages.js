/* Extracted verbatim from live index.html (stages.js). Key: bible-coverage-tracker.vbv.stages.v1 */
/* ---- stages.js ---- */
/* VBV stages.js (Builder-bot). Per-verse stage store for the verse-by-verse recorder.
   - Local: localStorage 'bible-coverage-tracker.vbv.stages.v1'.
   - Cloud: the SECOND save-code slot  /t/<sha256('bible-coverage-tracker.vbv.v1:' + code)>.json  (same database and save code as the
     Tracker's own snapshot, a different slot). This file is the ONLY writer of that slot.
   - Never reads or writes the Tracker's own snapshot ('bible-coverage-tracker.v2', /t/<sha256('bible-coverage-tracker.sync.v1:'+code)>).
     Robin 19:21: old Tracker marks are not used. The verse map has its OWN save code key 'bible-coverage-tracker.vbv.code.v1'
     (set in the Tracker's Settings & info); the old key 'bible-coverage-tracker.sync.v1' is never read or written.
   - Merge: per verse, the higher stage wins; same stage -> the newer 'at' wins. Units: newer 'at' wins. Never uploads an empty store,
     and ignores any cloud document that is not ours.
   Shape: { app:'bible-coverage-tracker.vbv', version:1, saved:ISO,
            verses: { 'GEN-6': { 'v19': { st:1, at:ISO, sha256, drive_id, gate, rev } } },
            units:  { 'Genesis 6': { st, at, stitch_sha256, restitch, video:{status, visibility, at, reason} } } }  */
var VBVStages = (function () {
  'use strict';
  var KEY = 'bible-coverage-tracker.vbv.stages.v1', SYNCKEY = 'bible-coverage-tracker.vbv.code.v1', APP = 'bible-coverage-tracker.vbv';
  var BASE = 'https://bible-reading-tracker-18cf8-default-rtdb.europe-west1.firebasedatabase.app';
  var TOTAL = 31102, listeners = [], doc = null, pushTimer = 0, state = { slot: '', lastPull: '', lastPush: '', error: '' };
  function empty() { return { app: APP, version: 1, saved: '', verses: {}, units: {} }; }
  function valid(d) { return d && typeof d === 'object' && d.app === APP && d.version === 1 && d.verses && typeof d.verses === 'object'; }
  function nowIso() { var d = new Date(), o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-', p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + s + p(Math.floor(Math.abs(o) / 60)) + ':' + p(Math.abs(o) % 60); }
  function t(x) { var v = Date.parse(x || ''); return isNaN(v) ? 0 : v; }
  // 'GEN.6.19' <-> chapter key 'GEN-6' + verse key 'v19' (Firebase keys may not contain '.', and numeric keys turn into arrays)
  function split(id) { var m = /^([1-3]?[A-Z]{2,3})\.(\d+)\.(\d+)$/.exec(String(id)); if (!m) throw new Error('Bad verse id ' + id); return [m[1] + '-' + m[2], 'v' + m[3]]; }
  function join(ck, vk) { var i = ck.lastIndexOf('-'); return ck.slice(0, i) + '.' + ck.slice(i + 1) + '.' + vk.slice(1); }
  function isEmpty(d) { return !Object.keys(d.verses).length && !Object.keys(d.units || {}).length && !Object.keys(d.cleared || {}).length; }

  function mergeRec(a, b) { if (!a) return b; if (!b) return a; if ((b.st | 0) !== (a.st | 0)) return (b.st | 0) > (a.st | 0) ? b : a; return t(b.at) > t(a.at) ? b : a; }
  function merge(a, b) {
    a = valid(a) ? a : empty(); b = valid(b) ? b : empty();
    var out = empty(); out.saved = t(a.saved) >= t(b.saved) ? a.saved : b.saved;
    [a, b].forEach(function (d) { Object.keys(d.verses).forEach(function (ck) { var src = d.verses[ck] || {};
      Object.keys(src).forEach(function (vk) { var o = out.verses[ck] || (out.verses[ck] = {}); o[vk] = mergeRec(o[vk], src[vk]); }); }); });
    [a, b].forEach(function (d) { Object.keys(d.units || {}).forEach(function (u) { var x = out.units[u], y = d.units[u]; out.units[u] = !x || t(y && y.at) > t(x.at) ? y : x; }); });
    // m4.2 Clear this chapter: cleared = { 'GEN-7': ISO, 'Genesis 7': ISO } (tombstones, newest wins). Any verse / unit record not newer
    // than its chapter's clear is dropped, so another device's copy never brings cleared marks back; a take made after the clear stays.
    [a, b].forEach(function (d) { Object.keys(d.cleared || {}).forEach(function (k) { var c = out.cleared || (out.cleared = {}); if (!c[k] || t(d.cleared[k]) > t(c[k])) c[k] = d.cleared[k]; }); });
    Object.keys(out.cleared || {}).forEach(function (k) { var ct = t(out.cleared[k]), vs = out.verses[k];
      if (vs) { Object.keys(vs).forEach(function (vk) { if (t(vs[vk] && vs[vk].at) <= ct) delete vs[vk]; }); if (!Object.keys(vs).length) delete out.verses[k]; }
      if (out.units[k] && t(out.units[k].at) <= ct) delete out.units[k]; });
    return out;
  }
  function same(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
  function canon(d) { var o = { verses: {}, units: {} }; Object.keys(d.verses).sort().forEach(function (ck) { o.verses[ck] = {}; Object.keys(d.verses[ck]).sort().forEach(function (vk) { o.verses[ck][vk] = d.verses[ck][vk]; }); });
    Object.keys(d.units || {}).sort().forEach(function (u) { o.units[u] = d.units[u]; });
    if (d.cleared) { o.cleared = {}; Object.keys(d.cleared).sort().forEach(function (k) { o.cleared[k] = d.cleared[k]; }); } return o; }

  function load() { if (doc) return doc; try { var d = JSON.parse(localStorage.getItem(KEY) || 'null'); doc = valid(d) ? d : empty(); } catch (e) { doc = empty(); } return doc; }
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch (e) { state.error = 'local save failed'; } }
  function emit(changed) { listeners.slice().forEach(function (f) { try { f(changed); } catch (e) { console.warn(e); } }); }
  function get(id) { var k = split(id), c = load().verses[k[0]]; return c && c[k[1]] || null; }
  function setVerse(id, rec) {
    load(); var k = split(id), r = Object.assign({}, rec); if (!r.at) r.at = nowIso(); if (typeof r.st !== 'number') throw new Error('st (0-4) required');
    var c = doc.verses[k[0]] || (doc.verses[k[0]] = {}); var prev = c[k[1]];
    c[k[1]] = prev && (prev.st | 0) > r.st && !rec.force ? Object.assign({}, prev, r, { st: prev.st }) : Object.assign({}, prev && (prev.st | 0) === r.st ? prev : {}, r); // a retake never lowers a later stage unless forced; other fields (sha256, drive_id, rev) take the new values
    delete c[k[1]].force;
    doc.saved = r.at; saveLocal(); emit([id]); schedulePush(); return c[k[1]];
  }
  function setUnit(stem, rec) { load(); var r = Object.assign({}, rec); if (!r.at) r.at = nowIso(); doc.units = doc.units || {}; doc.units[stem] = r; doc.saved = r.at; saveLocal(); emit([]); schedulePush(); return r; }
  // Robin 18:30: no stitch_req in the slot (VideoBot counts files in 00 Inbox). The page's own stitch status is LOCAL ONLY, never synced.
  var STITCHKEY = 'bible-coverage-tracker.vbv.stitch.v1';
  function localStitch(stem, rec) { var all; try { all = JSON.parse(localStorage.getItem(STITCHKEY) || '{}') || {}; } catch (e) { all = {}; }
    if (rec === undefined) return stem ? all[stem] || null : all; all[stem] = Object.assign({}, rec, { at: rec.at || nowIso() });
    try { localStorage.setItem(STITCHKEY, JSON.stringify(all)); } catch (e) {} return all[stem]; }
  // m4.2: Clear this chapter. Drops every verse record of chapter key ck ('GEN-7'), the unit record and the local stitch status of stem
  // ('Genesis 7'), and leaves a tombstone so the merge never resurrects them; syncs through the usual pull-merge-push.
  function clearChapter(ck, stem) {
    load(); var at = new Date().toISOString(); doc.cleared = doc.cleared || {}; doc.cleared[ck] = at; delete doc.verses[ck];
    if (stem) { doc.cleared[stem] = at; if (doc.units) delete doc.units[stem];
      try { var all = JSON.parse(localStorage.getItem(STITCHKEY) || '{}') || {}; if (all[stem]) { delete all[stem]; localStorage.setItem(STITCHKEY, JSON.stringify(all)); } } catch (e) {} }
    doc.saved = at; saveLocal(); emit(null); schedulePush();
  }
  function each(fn) { load(); Object.keys(doc.verses).forEach(function (ck) { Object.keys(doc.verses[ck]).forEach(function (vk) { fn(join(ck, vk), doc.verses[ck][vk]); }); }); }
  function toArray(indexOf) { var a = new Uint8Array(TOTAL); each(function (id, r) { var i = indexOf(id); if (i >= 0 && i < TOTAL) a[i] = Math.max(0, Math.min(4, r.st | 0)); }); return a; }
  function onChange(f) { listeners.push(f); }

  // ---- cloud (second slot) ----
  function norm(c) { return String(c || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function setCode(c) { c = norm(c); try { if (c) localStorage.setItem(SYNCKEY, JSON.stringify({ code: c, at: nowIso() })); else localStorage.removeItem(SYNCKEY); } catch (e) {} return c; }
  function code() { try { var c = JSON.parse(localStorage.getItem(SYNCKEY) || 'null'); return c && typeof c.code === 'string' ? String(c.code).trim().toLowerCase().replace(/\s+/g, ' ') : ''; } catch (e) { return ''; } }
  function sha256hex(s) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }); }
  function slot() { var c = code(); if (!c || !(window.crypto && crypto.subtle)) return Promise.resolve(''); return sha256hex('bible-coverage-tracker.vbv.v1:' + c).then(function (s) { state.slot = s; return s; }); }
  function url(s) { return BASE + '/t/' + s + '.json'; }
  function pull() {
    return slot().then(function (s) { if (!s) return null;
      return fetch(url(s), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (cloud) {
        state.lastPull = nowIso(); load();
        var m = merge(doc, valid(cloud) ? cloud : null), changed = !same(m, doc);
        if (changed) { doc = m; saveLocal(); emit(null); }
        if (!isEmpty(doc) && (!valid(cloud) || !same(doc, cloud))) return push();
        return null;
      });
    }).catch(function (e) { state.error = String(e && e.message || e); });
  }
  function push() {
    load(); if (isEmpty(doc)) return Promise.resolve(null); // never upload an empty store
    return slot().then(function (s) { if (!s) return null;
      return fetch(url(s), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc, function (k, v) { return k === 'stitch_req' ? undefined : v; }) }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); state.lastPush = nowIso(); state.error = ''; });
    }).catch(function (e) { state.error = String(e && e.message || e); });
  }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(function () { pull(); }, 1500); } // pull-merge-push, so another device's verses are never overwritten
  // One-off: if this browser still has ticks from the /test/ page, merge them into the live register
  try {
    var testDoc = JSON.parse(localStorage.getItem('kjvrec-test-bible-coverage-tracker.vbv.stages.v1') || 'null');
    if (valid(testDoc) && !isEmpty(testDoc)) {
      load();
      var merged = merge(doc, testDoc);
      if (!same(merged, doc)) { doc = merged; saveLocal(); }
    }
  } catch (e) {}
  // test-sync: fold another copy (the online save) into this device's store. Same merge as the save code: higher stage wins, never lowers.
  function absorb(other) { load(); var m = merge(doc, valid(other) ? other : null); if (same(m, doc)) return false; doc = m; saveLocal(); emit(null); return true; }
  return { absorb: absorb, valid: valid, KEY: KEY, load: load, get: get, setVerse: setVerse, setUnit: setUnit, localStitch: localStitch, clearChapter: clearChapter, each: each, toArray: toArray, onChange: onChange, merge: merge,
    pull: pull, push: push, slot: slot, code: code, setCode: setCode, CODEKEY: SYNCKEY, state: function () { return Object.assign({}, state); }, doc: function () { return JSON.parse(JSON.stringify(load())); } };
})();

