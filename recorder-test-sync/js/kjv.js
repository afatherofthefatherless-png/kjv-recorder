/* Load reading text from the verified KJV repository export (Psalm titles / Psalm 119 acrostics already cut). */
(function () {
  "use strict";
  var cache = null;
  var pending = null;

  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || location.href;
  function dataUrl() {
    return new URL("../data/kjv-reading.json.gz", SCRIPT_SRC).href;
  }

  function booksArray(payload) {
    return payload.books.map(function (b) { return b.text; });
  }

  async function fetchPayload() {
    var res = await fetch(dataUrl());
    if (!res.ok) throw new Error("Could not load the Bible text (" + res.status + ")");
    var bytes = new Uint8Array(await res.arrayBuffer());
    if (typeof DecompressionStream !== "function") throw new Error("This browser cannot open the Bible text file");
    var ds = new DecompressionStream("gzip");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var raw = new Uint8Array(await new Response(stream).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(raw));
  }

  function load() {
    if (cache) return Promise.resolve(cache);
    if (pending) return pending;
    pending = fetchPayload().then(function (payload) {
      cache = booksArray(payload);
      window.KJVData = payload;
      return cache;
    }).catch(function (e) {
      pending = null;
      throw e;
    });
    return pending;
  }

  function verseById(id) {
    if (!cache || !window.DotsMap) return "";
    var p = String(id).split(".");
    var bi = window.DotsMap.BOOKS.findIndex(function (b) { return b.code === p[0]; });
    if (bi < 0) return "";
    return ((cache[bi][+p[1] - 1] || [])[+p[2] - 1] || "");
  }

  window.TTBible = { load: load, verseById: verseById };
})();
