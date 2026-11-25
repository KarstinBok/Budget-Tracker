/* Walkthrough player: spotlights the real buttons on the real pages, one step at a time.
 * Adapted from the product-tour player in the portfolio demos.
 *
 * AppTour.define("feature-id", [{
 *   page: "/daily/",            // page the step lives on (the tour moves between pages by itself)
 *   sel: "#sharedSwitch",       // element to spotlight (optional; the card is centred without it)
 *   title: "Shared? switch",    // 2–4 words
 *   text: "Tap 🤝 Shared to split it.",  // one short line
 *   before: () => {...},        // optional: switch tab, open a form… (may return a Promise)
 *   after: () => {...},         // optional: tidy up when leaving the step
 * }], { cleanup: () => {...} }); // optional: run when the tour closes (close forms it opened)
 *
 * Start with ?tour=feature-id on any page that loads this file and tours.js (What's new links do).
 * Controls: Play/Pause, Back, Next, speed, Close. Keys: Space, ←, →, Esc.
 * Nothing is ever saved: steps only open forms, switch tabs and fill in examples.
 */
(function () {
  "use strict";
  var KEY = "appTourResume", SPEED_KEY = "appTourSpeed";
  var tours = {}, cfg = null, steps = [];
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function store(v) { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  var norm = function (p) { p = (p || "/").split(/[?#]/)[0].replace(/index\.html$/, ""); return p.endsWith("/") ? p : p + "/"; };
  var samePage = function (page) { return !page || norm(page) === norm(location.pathname); };

  // Wait until an element is on screen (pages draw after their data loads).
  function waitFor(sel, ms) {
    var end = Date.now() + (ms || 4000);
    return new Promise(function (res) {
      (function poll() {
        var el = document.querySelector(sel);
        if ((el && el.getBoundingClientRect().height) || Date.now() > end) res(el); else setTimeout(poll, 80);
      })();
    });
  }
  function click(sel) { return waitFor(sel).then(function (el) { if (el) el.click(); return wait(150); }); }
  function closeDialogs() { document.querySelectorAll("dialog[open]").forEach(function (d) { try { d.close(); } catch (e) { /* ignore */ } }); }

  var spot, card, q, bar, playBtn, speedBtn;
  var idx = -1, playing = false, timer = null, rafId = null, t0 = 0, delay = 2500, left = 2500, busy = false, open = false, speed = 1;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  try { speed = +localStorage.getItem(SPEED_KEY) === 2 ? 2 : 1; } catch (e) { /* ignore */ }

  // Time on a step while playing: reading time for its words plus a beat to look at the screen.
  function stepMs(s) {
    if (s.ms) return s.ms;
    var words = [s.title, s.text].join(" ").split(/\s+/).filter(Boolean).length;
    return Math.round(Math.min(8000, Math.max(3000, 1600 + words * 60000 / 200)));
  }

  function build() {
    spot = document.createElement("div"); spot.className = "at-spot at-none"; spot.hidden = true;
    card = document.createElement("div"); card.className = "at-card"; card.hidden = true;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite"); card.setAttribute("aria-label", "Walkthrough");
    card.innerHTML =
      '<div class="at-bar"><i></i></div>' +
      '<div class="at-body"><div class="at-step"></div><p class="at-title"></p><p class="at-text"></p></div>' +
      '<div class="at-ctrl">' +
      '<button type="button" class="at-play" aria-label="Play">&#9654;</button>' +
      '<button type="button" class="at-prev" aria-label="Back">&#8592;</button>' +
      '<button type="button" class="at-next" aria-label="Next">&#8594;</button>' +
      '<button type="button" class="at-speed" aria-label="Playback speed"></button>' +
      '<span class="at-sp"></span><span class="at-dots"></span>' +
      '<button type="button" class="at-x" aria-label="Close walkthrough">&#10005;</button></div>';
    document.body.appendChild(spot); document.body.appendChild(card);
    q = function (s) { return card.querySelector(s); };
    bar = q(".at-bar i"); playBtn = q(".at-play"); speedBtn = q(".at-speed");
    showSpeed();
    playBtn.addEventListener("click", function () { setPlaying(!playing); });
    speedBtn.addEventListener("click", function () { setSpeed(speed === 1 ? 2 : 1); });
    q(".at-prev").addEventListener("click", function () { go(idx - 1); });
    q(".at-next").addEventListener("click", function () { if (idx === steps.length - 1) close(); else go(idx + 1); });
    q(".at-x").addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (!open) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); if (idx === steps.length - 1) close(); else go(idx + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
      else if (e.key === " " && document.activeElement && document.activeElement.closest && document.activeElement.closest(".at-card")) { e.preventDefault(); setPlaying(!playing); }
    }, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
  }

  function showSpeed() { speedBtn.textContent = speed + "x"; speedBtn.title = speed === 1 ? "Normal speed — switch to 2x" : "Double speed — switch to 1x"; speedBtn.setAttribute("aria-pressed", speed === 2 ? "true" : "false"); }
  function setSpeed(v) {
    if (playing && timer) { left = Math.max(0, left - (Date.now() - t0)) * speed / v; } else { left = left * speed / v; }
    delay = delay * speed / v; speed = v; showSpeed();
    try { localStorage.setItem(SPEED_KEY, String(v)); } catch (e) { /* ignore */ }
    if (playing) startTimer();
  }

  function target() { var s = steps[idx]; if (!s || !s.sel) return null; var el = document.querySelector(s.sel); if (!el) return null; var r = el.getBoundingClientRect(); return r.width || r.height ? el : null; }
  // A form open on top of the page blocks everything outside it, so the card moves inside it.
  function host() { var d = document.querySelectorAll("dialog[open]"); return d.length ? d[d.length - 1] : document.body; }
  function place() {
    if (!open) return;
    var h = host();
    if (spot.parentNode !== h) { h.appendChild(spot); h.appendChild(card); }
    var el = target(), vw = window.innerWidth, vh = window.innerHeight, narrow = vw <= 640;
    var cw = card.offsetWidth, ch = card.offsetHeight;
    if (!el) {
      spot.className = "at-spot at-none";
      card.style.left = Math.max(12, (vw - cw) / 2) + "px"; card.style.top = Math.max(12, (vh - ch) / 2) + "px"; return;
    }
    var r = el.getBoundingClientRect(), pad = 6;
    var x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
    var w = Math.min(vw - 8, r.right + pad) - x, hh = Math.min(vh - 8, r.bottom + pad) - y;
    spot.className = "at-spot"; spot.style.left = x + "px"; spot.style.top = y + "px"; spot.style.width = Math.max(0, w) + "px"; spot.style.height = Math.max(0, hh) + "px";
    var gap = 12, cx, cy;
    if (narrow) { // full width, above or below the highlight, whichever has room
      cx = 12;
      cy = y + hh + gap + ch <= vh - 8 ? y + hh + gap : y - gap - ch >= 8 ? y - gap - ch : (y + hh / 2 > vh / 2 ? 12 : vh - ch - 12);
    } else {
      if (y + hh + gap + ch <= vh) cy = y + hh + gap; else if (y - gap - ch >= 0) cy = y - gap - ch; else cy = vh - ch - 12;
      cx = Math.min(Math.max(12, x + w / 2 - cw / 2), vw - cw - 12);
      if (cy === vh - ch - 12 && x + w + gap + cw <= vw) { cx = x + w + gap; cy = Math.min(Math.max(12, y), vh - ch - 12); }
    }
    card.style.left = cx + "px"; card.style.top = cy + "px";
  }
  function stopTimer() { clearTimeout(timer); cancelAnimationFrame(rafId); timer = null; }
  function tick() {
    bar.style.width = ((1 - Math.max(0, left - (Date.now() - t0)) / delay) * 100).toFixed(1) + "%";
    if (playing) rafId = requestAnimationFrame(tick);
  }
  function startTimer() {
    stopTimer(); t0 = Date.now();
    timer = setTimeout(function () { left = delay; if (idx < steps.length - 1) go(idx + 1); else { setPlaying(false); bar.style.width = "100%"; } }, left);
    tick();
  }
  function setPlaying(v) {
    playing = v;
    playBtn.innerHTML = v ? "&#10074;&#10074;" : "&#9654;"; playBtn.setAttribute("aria-label", v ? "Pause" : "Play");
    if (v) startTimer(); else { if (timer) left = Math.max(0, left - (Date.now() - t0)); stopTimer(); }
  }
  function render() {
    var s = steps[idx];
    q(".at-step").textContent = cfg.title ? cfg.title + " · " + (idx + 1) + " / " + steps.length : (idx + 1) + " / " + steps.length;
    q(".at-title").textContent = s.title || "";
    q(".at-text").textContent = s.text || "";
    q(".at-dots").innerHTML = steps.length <= 12 ? steps.map(function (_, i) { return '<i class="' + (i === idx ? "on" : "") + '"></i>'; }).join("") : "";
    q(".at-prev").disabled = idx === 0;
    q(".at-next").innerHTML = idx === steps.length - 1 ? "Done" : "&#8594;";
  }
  function go(n) {
    if (busy || n < 0 || n >= steps.length) return;
    var prev = steps[idx], s = steps[n];
    if (s.page && !samePage(s.page)) { // carry on on another page
      try { if (prev && prev.after) prev.after(); } catch (e) { /* ignore */ }
      store({ id: cfg.id, idx: n, playing: playing }); location.href = s.page; return;
    }
    busy = true; stopTimer(); left = delay; bar.style.width = "0";
    Promise.resolve(prev && prev.after && prev.after()).catch(function () {})
      .then(function () { return s.before && s.before(); }).catch(function () {})
      .then(function () { return s.sel ? waitFor(s.sel, 2500) : null; })
      .then(function () { return wait(s.before ? 300 : 60); })
      .then(function () {
        // Forms focus their first field; don't let the phone keyboard pop up during the walkthrough.
        var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) a.blur();
        idx = n; delay = left = stepMs(s) / speed; render();
        var el = target();
        if (el && el.scrollIntoView) {
          var r = el.getBoundingClientRect();
          if (r.top < 70 || r.bottom > window.innerHeight * 0.6) el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
        }
        return wait(reduce ? 30 : 380);
      })
      .then(function () { busy = false; place(); try { playBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } if (playing) startTimer(); });
  }
  function start(id, at, play) {
    cfg = tours[id]; if (!cfg) return;
    steps = cfg.steps;
    if (!samePage(steps[at || 0].page)) { store({ id: id, idx: at || 0, playing: play !== false }); location.href = steps[at || 0].page; return; }
    if (!card) build();
    open = true; spot.hidden = false; card.hidden = false;
    idx = -1; setPlaying(false); go(at || 0); if (play !== false) setPlaying(true);
  }
  function close() {
    var s = steps[idx]; if (s && s.after) { try { s.after(); } catch (e) { /* ignore */ } }
    try { if (cfg && cfg.cleanup) cfg.cleanup(); } catch (e) { /* ignore */ }
    open = false; setPlaying(false); store(null); spot.hidden = true; card.hidden = true; idx = -1;
    document.body.appendChild(spot); document.body.appendChild(card);
  }

  function define(id, list, opts) { tours[id] = Object.assign({ id: id, steps: list }, opts || {}); }

  // Start from ?tour=id, or carry on a walkthrough that moved here from another page.
  function boot() {
    var m = /[?&]tour=([\w-]+)/.exec(location.search);
    if (m) {
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) { /* ignore */ }
      store(null);
      setTimeout(function () { start(m[1], 0, true); }, 700);
      return;
    }
    var res = load();
    if (res && tours[res.id] && tours[res.id].steps[res.idx] && samePage(tours[res.id].steps[res.idx].page)) {
      store(null); setTimeout(function () { start(res.id, res.idx, res.playing); }, 700);
    }
  }

  window.AppTour = { define: define, boot: boot, start: start, close: close, waitFor: waitFor, click: click, wait: wait, closeDialogs: closeDialogs };
})();
