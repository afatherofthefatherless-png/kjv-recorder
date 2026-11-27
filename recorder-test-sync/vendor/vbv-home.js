/* Extracted from live index.html (vbv-home.js). Tracker book grid, chapter Record, verse list. */
/* ---- vbv-home.js ---- */
/* VBV M2: the verse dots map as the first view of the Tracker tab (screens 01a/01), and screen 02 "lined-up verses".
   Starts empty: it shows only new per-verse recordings from VBVStages. The old red/green marks stay in the existing views, untouched.
   Verse text: the page's embedded KJV (TTBible), checked equal to /home/box/kjv-repository `text` with Psalm titles stripped (tests-vbv). */
var VBV = window.VBV = window.VBV || {};
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var home = $('vbv-home'), mapEl = $('vbvMap'), lined = $('vbvLined'); if (!home || !window.DotsMap) return;
  var DM = window.DotsMap, map = null, saveStates = new Map(), unit = null, sel = null, bible = null;

  // ---- verse text (no network): reuse TTBible; if the Recorder has not started yet, run its text block in a private scope ----
  function bibleText() {
    if (bible) return bible;
    var TB = window.TTBible;
    if (!TB) { var b = $('code-recorder-0'); if (b) { var box = {}; try { new Function('window', 'globalThis', b.textContent)(box, box); TB = box.TTBible; } catch (e) { console.warn(e); } } }
    bible = TB ? TB.load() : Promise.reject(new Error('Verse text not available'));
    return bible;
  }
  var textCache = null; bibleText().then(function (t) { textCache = t; if (unit) renderLined(); }).catch(function () {});
  function bookIdx(code) { return DM.BOOKS.findIndex(function (b) { return b.code === code; }); }
  function verseText(id) { if (!textCache) return ''; var p = id.split('.'), bi = bookIdx(p[0]); return bi < 0 ? '' : ((textCache[bi][+p[1] - 1] || [])[+p[2] - 1] || ''); }
  function refOf(id) { var g = DM.verseIndex(id); return g < 0 ? id : DM.verseRef(g); }

  // ---- dots map (v7.1 list; m3.2 shows it one book at a time under a grid of books, Record on every chapter) ----
  function stagesArr() { return VBVStages.toArray(function (id) { return DM.verseIndex(id); }); }
  function units() { return VBVStages.load().units || {}; }
  function lastActive() { var best = null, at = ''; VBVStages.each(function (id, r) { if (r && r.at && r.at > at) { at = r.at; best = id; } }); return best; }
  function topInset() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kjb-top')) || 0; }
  map = DM.render(mapEl, stagesArr(), {
    units: units(), last: lastActive(), topInset: topInset,
    getVerseText: function (id) { return verseText(id); },
    // Record on a chapter panel goes straight to the verse recorder, starting at the ringed verse (fromId).
    // On a short book, Record <Book>, the whole book also starts from the ringed verse.
    onPickChapter: function (code, ch, fromId) { var u = idsFor(code, ch); if (VBV.openVerseRecorder) VBV.openVerseRecorder(u, fromId || ringedIn(u)); else openUnit(code, ch); },
    onPickBook: function (code, fromId) { var u = idsFor(code, null); if (fromId && VBV.openVerseRecorder) VBV.openVerseRecorder(u, fromId); else openUnit(code, null); },
  });
  // header: counts ONLY new verse recordings (Designer: the map header must not count old marks)
  function header() { var a = stagesArr(), n = 0; for (var i = 0; i < a.length; i++) if (a[i]) n++;
    var txt = $('vbvProgText'), fill = $('vbvProgFill'); if (txt) txt.textContent = 'Recorded ' + n.toLocaleString('en-GB') + ' of ' + DM.TOTAL.toLocaleString('en-GB') + ' verses';
    if (fill) { fill.style.width = (100 * n / DM.TOTAL) + '%'; fill.style.display = n ? '' : 'none'; } }
  header();
  // v7.1's verse-number grid is taller on a phone (48px columns). Keep Record on screen by
  // capping the open panel to the remaining viewport; the dots can scroll, text does not shrink.
  function fitOpenPanel() {
    var panel = mapEl.querySelector('.dm-panel'); if (!panel) return;
    panel.style.maxHeight = '';
    var room = Math.floor((window.innerHeight || 0) - panel.getBoundingClientRect().top - 8);
    if (room > 120 && panel.scrollHeight > room) panel.style.maxHeight = room + 'px';
  }
  var fitT = 0;
  function scheduleFit() { clearTimeout(fitT); fitT = setTimeout(fitOpenPanel, 50); }
  addEventListener('resize', scheduleFit);
  if (window.MutationObserver) new MutationObserver(scheduleFit).observe(mapEl, { childList: true, subtree: true });
  scheduleFit();
  VBVStages.onChange(function () { map.update(stagesArr(), { units: units() }); header(); if (unit) renderLined(); scheduleFit(); refreshBooks(); });

  // ---- m3.2 (Robin 20:17): two levels again. A grid of books; tap a book to see its chapters, each with its own Record button.
  // Layer over BRT's v7.1 list (its file is unchanged): the list is filtered to one book, the per-row Record buttons are added here,
  // and a chapter's verse-dots panel shows only after Robin taps that chapter's row (to pick a start verse). Verse by verse only.
  var curBook = null, books = $('vbvBooks'), bar = $('vbvBookBar'), filterCss = document.createElement('style'), recRows = [];
  filterCss.id = 'vbv-book-filter'; document.head.appendChild(filterCss);
  function bookTotal(b) { return b.counts.reduce(function (t, n) { return t + n; }, 0); }
  var recArr = null; // one stages array per refresh (31,102 entries), not one lookup per verse
  function bookRec(b) { var a = recArr || stagesArr(), g0 = DM.verseIndex(b.code + '.1.1'), t = bookTotal(b), k = 0; for (var g = g0; g < g0 + t; g++) if (a[g]) k++; return k; }
  function chName(b, ch) { return b.chapters === 1 ? b.name : (b.code === 'PSA' ? 'Psalm' : b.name) + ' ' + ch; }
  function firstOpenCh(b) { for (var c = 1; c <= b.chapters; c++) for (var v = 1; v <= b.counts[c - 1]; v++) if (!stageOf(b.code + '.' + c + '.' + v)) return c; return 1; }
  function fmt(n) { return n.toLocaleString('en-GB'); }
  function buildBooks() {
    if (!books) return; books.innerHTML = '';
    var last = lastActive();
    if (last) { var lp = last.split('.'), lb = DM.BOOKS[bookIdx(lp[0])];
      var bp = el('button', 'kjb-second vbvg-place', 'Back to my place  \u00b7  ' + chName(lb, +lp[1])); bp.type = 'button';
      bp.addEventListener('click', function () { showBook(lp[0], +lp[1]); }); books.appendChild(bp); }
    [['OT', 'Old Testament'], ['NT', 'New Testament']].forEach(function (t, ti) {
      books.appendChild(el('h2', 'vbvg-th', t[1]));
      var g = el('div', 'vbvg-grid'); g.setAttribute('role', 'list'); g.setAttribute('aria-label', t[1]);
      DM.BOOKS.forEach(function (b) {
        if ((b.testament ? b.testament === t[0] : (ti === 0 ? b.bi < 39 : b.bi >= 39)) === false) return;
        var x = el('button', 'vbvg-book'); x.type = 'button'; x.dataset.book = b.code; x.setAttribute('role', 'listitem');
        x.appendChild(el('span', 'vbvg-bn', b.name)); x.appendChild(el('span', 'vbvg-bc', ''));
        x.addEventListener('click', function () { showBook(b.code); }); g.appendChild(x);
      });
      books.appendChild(g);
    });
    refreshBooks();
  }
  function refreshBooks() {
    recArr = stagesArr();
    if (books) Array.prototype.forEach.call(books.querySelectorAll('.vbvg-book'), function (x) { var b = DM.BOOKS[bookIdx(x.dataset.book)], r = bookRec(b), t = bookTotal(b);
      x.querySelector('.vbvg-bc').textContent = fmt(r) + ' / ' + fmt(t) + ' verses'; x.classList.toggle('is-started', r > 0); x.classList.toggle('is-done', r === t);
      x.setAttribute('aria-label', b.name + ': ' + fmt(r) + ' of ' + fmt(t) + ' verses recorded. Show its chapters'); });
    recRows.forEach(function (w) { var cb = w.querySelector('.vbvg-clearbtn'); if (!cb) return; var bk = DM.BOOKS[bookIdx(cb.dataset.book)], c = +cb.dataset.ch, g0 = DM.verseIndex(bk.code + '.' + c + '.1'), any = false;
      for (var g = g0; g < g0 + bk.counts[c - 1]; g++) if (recArr[g]) { any = true; break; } if (cb.hidden === any) cb.hidden = !any; }); // m4.2
    if (curBook && bar) { var b = DM.BOOKS[bookIdx(curBook)], s = bar.querySelector('.vbvg-sub'); if (s) s.textContent = fmt(bookRec(b)) + ' of ' + fmt(bookTotal(b)) + ' verses recorded  \u00b7  ' + b.chapters + (b.chapters === 1 ? ' chapter' : ' chapters'); }
    recArr = null;
  }
  function recordChapter(code, ch) { var u = idsFor(code, ch); if (VBV.openVerseRecorder) VBV.openVerseRecorder(u, ringedIn(u)); else openUnit(code, ch); }
  function addRecButtons(b) {
    recRows.forEach(function (r) { r.remove(); }); recRows = [];
    for (var c = 1; c <= b.chapters; c++) (function (ch) {
      var row = mapEl.querySelector('.dm-row[data-book="' + b.code + '"][data-ch="' + ch + '"]'); if (!row) return;
      var w = el('div', 'vbvg-rec'), x = el('button', 'kjb-primary vbvg-recbtn', 'Record ' + chName(b, ch)); x.type = 'button'; x.dataset.book = b.code; x.dataset.ch = ch;
      x.addEventListener('click', function (e) { e.stopPropagation(); recordChapter(b.code, ch); });
      w.appendChild(x);
      var cb = el('button', 'vbvg-clearbtn', 'Clear this chapter'); cb.type = 'button'; cb.dataset.book = b.code; cb.dataset.ch = ch; cb.setAttribute('aria-label', 'Clear ' + chName(b, ch) + ': mark its verses as not recorded');
      cb.addEventListener('click', function (e) { e.stopPropagation(); if (VBV.clearChapter) VBV.clearChapter(b.code, ch, chName(b, ch)); });
      w.appendChild(cb); row.after(w); recRows.push(w);
    })(c);
  }
  function showBook(code, ch) {
    var b = DM.BOOKS[bookIdx(code)]; if (!b) return; closeUnitQuiet();
    curBook = code; home.setAttribute('data-vbv-level', 'chapters'); mapEl.setAttribute('data-vbv-book', code); mapEl.removeAttribute('data-vbv-panel');
    // v7.1 measures its row width on Genesis 1's row, so that row keeps its width (zero height, invisible) instead of display: none.
    var keep = code === 'GEN' ? '' : '#vbvMap .dm-row[data-book="GEN"][data-ch="1"] { visibility: hidden !important; height: 0 !important; min-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; border-width: 0 !important; margin: 0 !important; overflow: hidden !important; }\n';
    filterCss.textContent = keep + '#vbvMap .dm-bh, #vbvMap .dm-row:not([data-book="' + code + '"]):not([data-book="GEN"][data-ch="1"]), #vbvMap:not([data-vbv-panel]) .dm-panel, #vbvMap .dm-row:not([data-book="' + code + '"]) + .dm-panel, #vbvMap:not([data-vbv-panel]) .dm-backbtn { display: none !important; }';
    books.hidden = true; bar.hidden = false; mapEl.hidden = false;
    var h = bar.querySelector('.vbvg-h'); h.textContent = b.name; refreshBooks();
    addRecButtons(b); refreshBooks(); // m4.2: Clear this chapter visibility
    var last = lastActive(), lp = last && last.split('.');
    var open = ch || (lp && lp[0] === code ? +lp[1] : firstOpenCh(b));
    map.openChapter(code, open);
    if (map.redraw) map.redraw();
    requestAnimationFrame(function () { window.scrollTo(0, Math.max(0, home.getBoundingClientRect().top + (window.scrollY || 0) - topInset() - 4));
      if (ch) { var w = mapEl.querySelector('.vbvg-recbtn[data-ch="' + ch + '"]'); if (w) { var r = w.getBoundingClientRect(); if (r.bottom > innerHeight - 8) window.scrollBy(0, r.bottom - innerHeight + 24); } }
      try { h.focus({ preventScroll: true }); } catch (e) {} });
  }
  function showBooks() {
    var was = curBook; closeUnitQuiet(); curBook = null; home.setAttribute('data-vbv-level', 'books'); mapEl.removeAttribute('data-vbv-book'); filterCss.textContent = '';
    mapEl.hidden = true; bar.hidden = true; books.hidden = false; buildBooks();
    window.scrollTo(0, 0);
    var f = was && books.querySelector('.vbvg-book[data-book="' + was + '"]'); if (f) try { f.focus({ preventScroll: true }); var r = f.getBoundingClientRect(); if (r.bottom > innerHeight) window.scrollBy(0, r.bottom - innerHeight + 24); } catch (e) {}
  }
  mapEl.addEventListener('click', function (e) { if (curBook && e.target.closest && e.target.closest('.dm-row')) mapEl.setAttribute('data-vbv-panel', '1'); }, true);
  mapEl.addEventListener('keydown', function (e) { if (curBook && (e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('dm-row')) mapEl.setAttribute('data-vbv-panel', '1'); }, true);
  if (bar) bar.querySelector('.vbvg-all').addEventListener('click', showBooks);
  VBV.showBook = showBook; VBV.showBooks = showBooks; VBV.level = function () { return curBook ? { level: 'chapters', book: curBook } : { level: 'books' }; };

  // ---- save states (from the upload queue in M4; a test hook until then) ----
  VBV.setSaveState = function (list) {
    (list || []).forEach(function (s) { var i = typeof s.index === 'string' ? DM.verseIndex(s.index) : s.index; if (s.state) saveStates.set(i, s.state); else saveStates.delete(i); });
    map.setSaveState(list); if (unit) renderLined();
  };
  VBV.map = function () { return map; };

  // ---- screen 02: lined-up verses ----
  function idsFor(code, ch) {
    var b = DM.BOOKS[bookIdx(code)], out = [], chs = ch ? [ch] : b.counts.map(function (_, i) { return i + 1; });
    chs.forEach(function (c) { for (var v = 1; v <= b.counts[c - 1]; v++) out.push(code + '.' + c + '.' + v); });
    return { code: code, chapter: ch, name: (ch && b.chapters > 1 && !b.short ? DM.unitStem(code, ch) : b.name), whole: !ch, ids: out };
  }
  function stageOf(id) { var r = VBVStages.get(id); return r ? r.st | 0 : 0; }
  function openUnit(code, ch) {
    unit = idsFor(code, ch); sel = null; home.setAttribute('data-vbv-view', 'lined'); mapEl.hidden = true; if (books) books.hidden = true; if (bar) bar.hidden = true; lined.hidden = false;
    renderLined(); window.scrollTo(0, 0); var h = lined.querySelector('h2'); if (h) { try { h.focus({ preventScroll: true }); } catch (e) {} }
  }
  function closeUnitQuiet() { if (!unit) return; unit = null; home.removeAttribute('data-vbv-view'); lined.hidden = true; lined.innerHTML = ''; }
  function closeUnit() { closeUnitQuiet(); if (curBook) showBook(curBook); else showBooks(); }
  function ringedIn(u) { // the map's ringed / next verse, if it is inside this unit (accepts a global index or an id, so v6 and v7 both work)
    var m = VBV.map && VBV.map(), n = null; try { n = m && (typeof m.next === 'function' ? m.next() : m.next); } catch (e) {}
    if (n && typeof n === 'object') n = n.id != null ? n.id : n.index;
    var id = typeof n === 'number' ? DM.verseId(n) : typeof n === 'string' ? n : null;
    return id && u.ids.indexOf(id) >= 0 ? id : null;
  }
  VBV.ringedIn = ringedIn;
  VBV.openUnit = openUnit; VBV.closeUnit = closeUnit; VBV.idsFor = idsFor; VBV.stageOf = function (id) { return stageOf(id); }; VBV.verseText = function (id) { return verseText(id); }; VBV.bibleText = bibleText; VBV.unit = function () { return unit; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderLined() {
    if (!unit) return;
    var ids = unit.ids, rec = ids.filter(function (id) { return stageOf(id) > 0; }).length;
    var next = sel || ids.filter(function (id) { return stageOf(id) === 0; })[0] || ids[0];
    lined.innerHTML = '';
    var top = el('div', 'vbvh-top'), tl = el('div', 'vbvh-tl');
    var h = el('h2', 'vbvh-h', unit.name); h.tabIndex = -1; tl.appendChild(h);
    tl.appendChild(el('p', 'vbvh-sub', rec + ' of ' + ids.length + ' recorded  ·  lined up for the Recorder' + (unit.whole ? '  ·  one video for the whole book' : '')));
    var nav = el('button', 'vbvh-quiet', 'All books'); nav.type = 'button'; nav.addEventListener('click', closeUnit);
    top.appendChild(tl); top.appendChild(nav);
    var grid = el('div', 'vbvh-lgrid'), col = el('div', 'vbvh-col'), list = el('div', 'vbvh-list'), panel = el('div', 'vbvh-next');
    col.appendChild(top);
    list.appendChild(el('p', 'vbvh-muted', ids.length + ' verses, in order'));
    var ul = el('ul', 'vbvh-rows'); ul.setAttribute('aria-label', unit.name + ', verses');
    ids.forEach(function (id) {
      var st = stageOf(id), ss = saveStates.get(DM.verseIndex(id)), isNext = id === next, ref = refOf(id);
      var li = el('li'), b = el('button', 'vbvh-row' + (isNext ? ' is-next' : '')); b.type = 'button';
      var dot = el('span', 'vbvh-dot ' + (ss === 'failed' ? 'is-failed' : st > 0 || ss === 'saving' ? 'is-rec' : 'is-none') + (isNext ? ' is-cur' : ''));
      if (ss === 'failed') dot.textContent = '!'; else if (ss === 'saving') dot.textContent = '…';
      dot.setAttribute('aria-hidden', 'true');
      var word = ss === 'failed' ? 'Not saved' : ss === 'saving' ? 'Saving' : isNext ? 'NEXT' : st > 0 ? ['', 'Recorded', 'Stitched', 'Video', 'On YouTube'][st] : 'Not recorded';
      b.appendChild(dot); b.appendChild(el('span', 'vbvh-ref', id.split('.').slice(1).join(':'))); b.appendChild(el('span', 'vbvh-word ' + (ss === 'failed' ? 'w-failed' : isNext ? 'w-next' : st > 0 ? 'w-rec' : 'w-none'), word));
      b.setAttribute('aria-label', ref + ', ' + word.toLowerCase().replace('next', 'next to record'));
      b.addEventListener('click', function () { sel = id; renderLined(); var n = lined.querySelector('.vbvh-row.is-next'); if (n) n.focus({ preventScroll: true });
        var g = lined.querySelector('.vbvh-lgrid'), pn = lined.querySelector('.vbvh-next'); // one column (phone, portrait): the panel is above the list, so bring it (verse + buttons) into view
        if (g && pn && getComputedStyle(g).gridTemplateColumns.split(' ').length === 1) { var t = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kjb-top')) || 0; window.scrollTo(0, pn.getBoundingClientRect().top + window.scrollY - t - 8); } });
      li.appendChild(b); ul.appendChild(li);
    });
    list.appendChild(ul);
    panel.appendChild(el('h3', 'vbvh-nexth', 'NEXT  ·  ' + refOf(next)));
    var vt = verseText(next); panel.appendChild(el('p', 'vbvh-verse', vt || 'Loading the verse text…'));
    var btns = el('div', 'vbvh-btns');
    var back = el('button', 'kjb-second vbvh-btn', 'Back to the map'); back.type = 'button'; back.addEventListener('click', closeUnit);
    var go = el('button', 'kjb-primary vbvh-btn', 'Record from here'); go.type = 'button';
    go.addEventListener('click', function () { if (VBV.openVerseRecorder) VBV.openVerseRecorder(unit, next); });
    btns.appendChild(back); btns.appendChild(go);
    panel.appendChild(btns);
    col.appendChild(list); grid.appendChild(col); grid.appendChild(panel); lined.appendChild(grid);
    fitLined();
  }
  // M2.1 (Designer fix 2): at load the NEXT verse shows whole and both buttons are on screen, at every size. The verse never shrinks;
  // on iPad landscape the list is cut to whole rows to make room (and scrolls inside); portrait and phone put the panel first.
  function fitLined() {
    var grid = lined.querySelector('.vbvh-lgrid'), ul = lined.querySelector('.vbvh-rows'), list = lined.querySelector('.vbvh-list'), panel = lined.querySelector('.vbvh-next');
    if (!grid || !ul) return;
    ul.style.maxHeight = ''; ul.scrollTop = 0;
    var lis = ul.children, cur = ul.querySelector('.is-next'), idx = cur ? Array.prototype.indexOf.call(lis, cur.parentNode) : 0;
    var two = getComputedStyle(grid).gridTemplateColumns.split(' ').length > 1;
    if (!two || lis.length < 2) return;
    var pitch = lis[1].offsetTop - lis[0].offsetTop || lis[0].offsetHeight;
    var gTop = grid.getBoundingClientRect().top + (window.scrollY || 0), avail = innerHeight - gTop - 12 - (list.getBoundingClientRect().top - grid.getBoundingClientRect().top);
    var room = avail - (ul.getBoundingClientRect().top - list.getBoundingClientRect().top) - 14;
    var n = Math.max(3, Math.floor(room / pitch));
    if (n >= lis.length) return;
    ul.style.maxHeight = (n * pitch) + 'px';
    ul.scrollTop = Math.max(0, Math.min(lis.length - n, idx - Math.floor(n / 3))) * pitch; // whole rows only, NEXT a third of the way down
  }
  addEventListener('resize', function () { if (unit && !lined.hidden) fitLined(); });
  // Settings & info: the verse map's own save code (never the old Tracker's)
  (function () {
    var ci = document.getElementById('vbvCode'), cu = document.getElementById('vbvCodeUse'), cs = document.getElementById('vbvCodeStatus'); if (!ci || !cu) return;
    var say = function (t) { cs.textContent = t; };
    ci.value = VBVStages.code(); say(VBVStages.code() ? 'This device uses a save code.' : 'No save code yet. Recorded verses stay on this device.');
    cu.addEventListener('click', function () {
      var c = VBVStages.setCode(ci.value); ci.value = c;
      if (!c) { say('No save code on this device now. Recorded verses stay on this device.'); return; }
      say('Checking the shared copy\u2026');
      Promise.resolve(VBVStages.pull()).then(function () { say('Using this save code. Recorded verses are shared with your other devices.'); }, function () { say('Could not reach the shared copy. Your verses are kept here; try again later.'); });
    });
  })();
  showBooks(); // m3.2: the Tracker opens on the grid of books
  Promise.resolve(VBVStages.pull()).catch(function () {}); // second slot only; does nothing without a save code
})();
