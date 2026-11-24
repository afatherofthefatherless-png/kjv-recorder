/* Extracted from live index.html (vbv-drive-mark.js). */
/* ---- vbv-drive-mark.js ---- */
/* m3.9: always-visible Drive signed-in marker in the header. Reuses VBVDrive token + Inbox grant. */
(function () {
  'use strict';
  var D = window.VBVDrive, head = document.querySelector('.vbv-head');
  if (!D || !head || head.querySelector('.vbv-drive-mark')) return;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vbv-drive-mark';
  btn.id = 'vbvDriveMark';
  var dot = document.createElement('span'); dot.className = 'vbv-drive-mark-dot'; dot.setAttribute('aria-hidden', 'true');
  var lab = document.createElement('span'); lab.className = 'vbv-drive-mark-lab';
  btn.appendChild(dot); btn.appendChild(lab);
  var prog = document.getElementById('vbvProgText');
  if (prog && prog.parentNode === head) head.insertBefore(btn, prog);
  else head.appendChild(btn);

  var last = '';
  function paint() {
    var s = D.authState ? D.authState() : { kind: 'off', label: 'Drive: not signed in' };
    var kind = s.kind || 'off';
    var label = s.label || 'Drive: not signed in';
    btn.classList.remove('is-ok', 'is-off', 'is-pick');
    btn.classList.add(kind === 'ok' ? 'is-ok' : kind === 'pick' ? 'is-pick' : 'is-off');
    lab.textContent = label;
    btn.disabled = kind === 'ok';
    if (kind === 'ok') {
      btn.setAttribute('aria-label', label);
      btn.removeAttribute('aria-haspopup');
    } else if (kind === 'pick') {
      btn.setAttribute('aria-label', 'Drive: signed in, pick 00 Inbox. Tap to choose the folder.');
    } else {
      btn.setAttribute('aria-label', 'Drive: not signed in. Tap to connect or sign in again.');
    }
    if (label !== last) last = label;
  }

  btn.addEventListener('click', function () {
    var s = D.authState ? D.authState() : { kind: 'off' };
    if (s.kind === 'ok') return;
    var go = (s.kind === 'pick' && D.pickInbox) ? D.pickInbox() : D.signInAgain();
    go.then(function () { paint(); if (window.VBV && VBV.driveBanner) VBV.driveBanner(); },
      function () { paint(); if (window.VBV && VBV.driveBanner) VBV.driveBanner(); });
  });

  paint();
  if (D.onAuthChange) D.onAuthChange(paint);
  setInterval(paint, 60000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') paint(); });
})();
