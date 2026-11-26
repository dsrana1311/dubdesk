/**
 * DubDesk — prompter.js
 * What the actor reads while recording, all of it driven by the transport
 * clock so it stays locked to the picture through seeks, buffering and
 * slow-motion recording:
 *
 *   caption band — under the video, in one of two styles:
 *                  line:   the current line stands still and a highlight
 *                          follows the words, with a bar filling into the
 *                          line and the next line shown to read ahead;
 *                  scroll: the rythmo band — the words scroll past a sync
 *                          line and you say each one as it crosses.
 *   teleprompter — an optional large window: the current line big, the next
 *                  ones below, and a 3-2-1 countdown during the pre-roll.
 *   caption row  — the selected row's words light up as they are due.
 */

'use strict';

// ─────────────────────────────────────────────
// WORD TIMING
// ─────────────────────────────────────────────
// Captions only say when a line starts and ends. Inside it, each word gets a
// share of the time that grows with its length, plus a little for the pause
// after punctuation: close to how a line is actually spoken.

const wordPlans = new Map();

function wordPlan(text) {
  text = (text || '').trim();
  let plan = wordPlans.get(text);
  if (plan) return plan;
  const words = text ? text.split(/\s+/) : [];
  const weights = words.map(w => {
    const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length || 1;
    const pause = /[.!?…]["')\]]*$/.test(w) ? 3 : /[,;:—–]["')\]]*$/.test(w) ? 1.5 : 0;
    return letters + 1.2 + pause;
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const starts = [];
  let acc = 0;
  for (const w of weights) {
    starts.push(acc / total);
    acc += w;
  }
  plan = { words, starts };
  if (wordPlans.size > 5000) wordPlans.clear();
  wordPlans.set(text, plan);
  return plan;
}

/** Index of the word being spoken at `progress` (0–1 through the line); −1 before it starts. */
function activeWordIndex(plan, progress) {
  if (progress < 0 || !plan.words.length) return -1;
  let k = 0;
  for (let i = 0; i < plan.starts.length; i++) {
    if (plan.starts[i] <= progress) k = i;
    else break;
  }
  return k;
}

// ─────────────────────────────────────────────
// TELEPROMPTER + CAPTION ROW
// ─────────────────────────────────────────────

const STREAMER_SEC = 2;

const prompter = {
  el: null, viewport: null, lines: null, badge: null, cue: null, clock: null, count: null,
  items: new Map(),     // caption index → { line, words, bar, plan, k, punched }
  rowIdx: null,
  rowSpans: null,
  rowK: -2,
  shownCount: '',
  shownClock: '',
};

function initPrompter() {
  const $ = id => document.getElementById(id);
  prompter.el = $('prompter');
  prompter.viewport = $('prompter-viewport');
  prompter.lines = $('prompter-lines');
  prompter.badge = $('prompter-badge');
  prompter.cue = $('prompter-cue');
  prompter.clock = $('prompter-clock');
  prompter.count = $('prompter-count');
}

function prompterOpen(s) {
  const caps = state.captions;
  const from = s.mode === 'flow' ? s.startIdx : Math.max(0, s.startIdx - 1);
  const to = s.mode === 'flow' ? caps.length - 1 : Math.min(caps.length - 1, s.startIdx + 1);
  prompter.items.clear();
  prompter.rowIdx = null;
  prompter.rowSpans = null;

  const frag = document.createDocumentFragment();
  for (let i = from; i <= to; i++) {
    const cap = caps[i];
    const line = document.createElement('div');
    line.className = 'pl';
    if (s.mode !== 'flow' && i !== s.startIdx) line.classList.add('pl-context');

    const num = document.createElement('span');
    num.className = 'pl-num';
    num.textContent = `#${cap.index}`;

    const text = document.createElement('div');
    text.className = 'pl-text';
    const plan = wordPlan(cap.hinglish);
    const words = [];
    if (!plan.words.length) {
      text.classList.add('pl-empty');
      text.textContent = cap.text ? `(${cap.text})` : '—';
    }
    plan.words.forEach((w, k) => {
      if (k) text.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'pw';
      span.textContent = w;
      text.appendChild(span);
      words.push(span);
    });

    const streamer = document.createElement('div');
    streamer.className = 'pl-streamer';
    const bar = document.createElement('i');
    streamer.appendChild(bar);

    line.append(num, text, streamer);
    frag.appendChild(line);
    prompter.items.set(i, { line, words, bar, plan, k: -1, punched: false });
  }
  prompter.lines.replaceChildren(frag);
  prompter.lines.style.transform = 'translateY(0)';
  prompter.badge.textContent = s.recording ? 'REC' : 'Rehearsal';
  prompter.el.classList.toggle('is-rehearsal', !s.recording);
  prompter.el.classList.toggle('hidden', !settings.overlay);
  prompter.el.setAttribute('aria-hidden', String(!settings.overlay));
  prompter.count.textContent = '';
  prompter.count.classList.remove('show');
  prompter.shownCount = '';
  prompter.shownClock = '';
  prompter.clock.textContent = 'Cueing…';
}

function setItemWords(item, k) {
  if (k === item.k) return;
  const words = item.words;
  if (k > item.k) {
    for (let i = Math.max(0, item.k); i <= k && i < words.length; i++) words[i].classList.add('on');
  } else {
    for (let i = Math.max(0, k + 1); i <= item.k && i < words.length; i++) words[i].classList.remove('on');
  }
  if (item.k >= 0) words[item.k]?.classList.remove('now');
  if (k >= 0) words[k]?.classList.add('now');
  item.k = k;
}

/** Move the prompter on to caption d. */
function prompterShow(s, d) {
  const prev = s.display;
  s.display = d;
  if (prev !== null && prev !== d) {
    const pi = prompter.items.get(prev);
    if (pi) {
      setItemWords(pi, pi.words.length - 1);
      pi.words[pi.k]?.classList.remove('now');
      pi.line.classList.remove('pl-current', 'pl-cue');
      pi.line.classList.add('pl-done');
    }
    hideRowPrompter();
  }
  const item = prompter.items.get(d);
  if (item) {
    item.line.classList.add('pl-current');
    const y = Math.max(0, item.line.offsetTop - prompter.viewport.clientHeight * 0.3);
    prompter.lines.style.transform = `translateY(${-y}px)`;
  }
  if (s.mode === 'flow' && state.selectedRow !== d) {
    selectRow(d);
    scrollRowToCenter(d);
  }
  showRowPrompter(d);

  const cap = state.captions[d];
  prompter.cue.textContent = s.mode === 'flow'
    ? `#${cap.index} · line ${d - s.startIdx + 1}`
    : s.recording ? `#${cap.index} · take ${takesFor(d).length + 1}` : `#${cap.index}`;
}

function prompterUpdate(s, vt) {
  const caps = state.captions;
  let d = s.display ?? s.startIdx;
  if (s.mode === 'flow') {
    while (d < s.lastIdx && vt >= caps[d].endTime) d++;
  } else {
    d = s.startIdx;
  }
  if (d !== s.display) prompterShow(s, d);

  const cap = caps[d];
  const item = prompter.items.get(d);
  const lead = cap.startTime - vt;
  let k = -1;
  if (lead > 0) {
    const f = s.started ? clamp(1 - lead / STREAMER_SEC, 0, 1) : 0;
    if (item) {
      item.bar.style.transform = `scaleX(${f.toFixed(3)})`;
      item.line.classList.toggle('pl-cue', f > 0);
    }
  } else {
    if (item) {
      if (!item.punched) {
        item.punched = true;
        item.bar.style.transform = 'scaleX(0)';
        item.line.classList.remove('pl-cue');
        item.line.classList.add('pl-punch');
        setTimeout(() => item.line.classList.remove('pl-punch'), 450);
      }
    }
    const progress = (vt - cap.startTime) / Math.max(0.05, cap.endTime - cap.startTime);
    k = activeWordIndex(wordPlan(cap.hinglish), progress);
  }
  if (item) setItemWords(item, k);
  setRowWords(d, k);

  // 3-2-1 before the first line
  let count = '';
  if (s.started && vt < s.cueVt) {
    const left = s.cueVt - vt;
    if (left <= 3.05) count = String(Math.max(1, Math.ceil(left - 0.05)));
  }
  if (count !== prompter.shownCount) {
    prompter.shownCount = count;
    prompter.count.classList.remove('show');
    prompter.count.textContent = count;
    if (count) {
      void prompter.count.offsetWidth;   // restart the pop animation for each number
      prompter.count.classList.add('show');
    }
  }

  const clock = s.started ? fmtClock(vt - s.cueVt) : 'Cueing…';
  if (clock !== prompter.shownClock) {
    prompter.clock.textContent = clock;
    prompter.shownClock = clock;
  }
}

function prompterClose() {
  hideRowPrompter();
  prompter.el.classList.add('hidden');
  prompter.el.setAttribute('aria-hidden', 'true');
  prompter.lines.replaceChildren();
  prompter.items.clear();
  prompter.count.classList.remove('show');
  prompter.count.textContent = '';
}

function showRowPrompter(idx) {
  hideRowPrompter();
  showTeleprompter(idx);
  prompter.rowIdx = idx;
  prompter.rowSpans = [...(rowEl(idx)?.querySelectorAll('.tp-word') || [])];
  prompter.rowK = -2;
}

function hideRowPrompter() {
  if (prompter.rowIdx === null) return;
  hideTeleprompter(prompter.rowIdx);
  prompter.rowIdx = null;
  prompter.rowSpans = null;
}

/** Light up the caption row's words up to word k. */
function setRowWords(idx, k) {
  let spans;
  if (prompter.rowIdx === idx && prompter.rowSpans) {
    if (prompter.rowK === k) return;
    prompter.rowK = k;
    spans = prompter.rowSpans;
  } else {
    spans = rowEl(idx)?.querySelectorAll('.tp-word') || [];
  }
  spans.forEach((sp, i) => sp.classList.toggle('tp-word-active', i <= k));
}

// ─────────────────────────────────────────────
// RYTHMO BAND
// ─────────────────────────────────────────────

const SYNC_AT = 0.24;   // the sync line, as a share of the band's width

const rythmo = {
  wrap: null, canvas: null, ctx: null,
  W: 0, H: 0, dpr: 1,
  dirty: true,
  visible: false,
  widths: new Map(),
  font: '',
  palette: null,
  drag: null,
};

function rythmoPalette() {
  if (rythmo.palette) return rythmo.palette;
  const style = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  rythmo.palette = {
    word: read('--ry-word'),
    past: read('--ry-past'),
    now: read('--ry-now'),
    fallback: read('--ry-fallback'),
    bar: read('--ry-bar'),
    barRec: read('--ry-bar-rec'),
    barSel: read('--ry-bar-sel'),
    sync: read('--ry-sync'),
    syncRec: read('--red'),
    shade: read('--ry-shade'),
    num: read('--ry-num'),
    beep: read('--amber'),
    font: read('--font'),
  };
  return rythmo.palette;
}

function initRythmo() {
  rythmo.wrap = document.getElementById('rythmo');
  rythmo.canvas = document.getElementById('rythmo-canvas');
  if (!rythmo.canvas) return;
  rythmo.ctx = rythmo.canvas.getContext('2d');
  new ResizeObserver(resizeRythmo).observe(rythmo.wrap);

  const scrolling = () => settings.bandMode === 'scroll';

  rythmo.wrap.addEventListener('wheel', e => {
    if (!scrolling()) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    settings.rythmoZoom = clamp(settings.rythmoZoom * f, 60, 480);
    saveSettings();
    rythmo.dirty = true;
  }, { passive: false });

  // Line / Scroll switch in the band's corner
  const modes = rythmo.wrap.querySelector('.band-mode');
  modes.addEventListener('pointerdown', e => e.stopPropagation());
  modes.addEventListener('click', e => {
    const b = e.target.closest('[data-band]');
    if (b) setBandMode(b.dataset.band);
  });
  showBandMode();

  // Scroll style: drag to scrub; click to bring the clicked word to the sync line.
  rythmo.wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || session || !scrolling()) return;
    rythmo.drag = { x: e.clientX, vt: transport.now(), moved: false, wasPlaying: transport.isPlaying() };
    try { rythmo.wrap.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });
  rythmo.wrap.addEventListener('pointermove', e => {
    const d = rythmo.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    if (!d.moved) {
      d.moved = true;
      if (d.wasPlaying) transport.pause();
    }
    transport.scrub(d.vt - dx / settings.rythmoZoom, false);
    rythmo.dirty = true;
  });
  rythmo.wrap.addEventListener('pointerup', e => {
    const d = rythmo.drag;
    if (!d) return;
    rythmo.drag = null;
    if (d.moved) {
      transport.scrub(d.vt - (e.clientX - d.x) / settings.rythmoZoom, true);
    } else {
      const r = rythmo.wrap.getBoundingClientRect();
      transport.seek(d.vt + (e.clientX - r.left - rythmo.W * SYNC_AT) / settings.rythmoZoom);
    }
    rythmo.dirty = true;
  });
  rythmo.wrap.addEventListener('pointercancel', () => { rythmo.drag = null; });

  window.addEventListener('dubdesk:themechange', () => {
    rythmo.palette = null;
    rythmo.dirty = true;
  });
}

function setBandMode(mode) {
  settings.bandMode = mode === 'scroll' ? 'scroll' : 'static';
  saveSettings();
  showBandMode();
  rythmo.dirty = true;
}

function showBandMode() {
  const scroll = settings.bandMode === 'scroll';
  rythmo.wrap.classList.toggle('band-scroll', scroll);
  rythmo.wrap.title = scroll
    ? 'Rythmo band: say each word as it crosses the line. Drag to scrub, scroll to zoom.'
    : 'The line stands still; the highlight follows the words as they’re due. The next line is on the right.';
  rythmo.wrap.querySelectorAll('[data-band]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.band === settings.bandMode));
  });
  const select = document.getElementById('set-band');
  if (select) select.value = settings.bandMode;
}

function resizeRythmo() {
  const r = rythmo.wrap.getBoundingClientRect();
  rythmo.W = r.width;
  rythmo.H = r.height;
  rythmo.dpr = window.devicePixelRatio || 1;
  rythmo.canvas.width = Math.max(1, Math.round(r.width * rythmo.dpr));
  rythmo.canvas.height = Math.max(1, Math.round(r.height * rythmo.dpr));
  rythmo.canvas.style.width = `${r.width}px`;
  rythmo.canvas.style.height = `${r.height}px`;
  rythmo.dirty = true;
}

function updateRythmoVisibility() {
  if (!rythmo.wrap) return;
  const show = settings.rythmo && state.captions.length > 0;
  if (show === rythmo.visible) return;
  rythmo.visible = show;
  rythmo.wrap.classList.toggle('hidden', !show);
  rythmo.wrap.setAttribute('aria-hidden', String(!show));
  if (show) resizeRythmo();
}

function rythmoFrame(p) {
  updateRythmoVisibility();
  if (!rythmo.visible || !rythmo.ctx) return;
  const busy = !!session;
  if (rythmo.wrap.classList.contains('in-session') !== busy) {
    rythmo.wrap.classList.toggle('in-session', busy);
    rythmo.dirty = true;
  }
  if (!(rythmo.dirty || transport.isPlaying() || session || rythmo.drag)) return;
  drawRythmo(transport.now(p));
}

// ── Line style ──────────────────────────────

/** Which caption the band shows: the session's, the one playing, or the next one due. */
function bandCaption(vt) {
  const caps = state.captions;
  if (!caps.length) return -1;
  if (session) return session.display ?? session.startIdx;
  const inside = caps.findIndex(c => vt >= c.startTime && vt < c.endTime);
  if (inside !== -1) return inside;
  if (!transport.isPlaying() && state.selectedRow !== null) return state.selectedRow;
  const next = caps.findIndex(c => c.endTime > vt);
  return next === -1 ? caps.length - 1 : next;
}

const cueLayouts = new Map();

/** Wrap a line into the band at the largest size that fits its height. */
function cueLayout(words, italic, maxW, maxH, family) {
  const key = `${italic ? 'i' : 'n'}|${Math.round(maxW)}|${Math.round(maxH)}|${words.join(' ')}`;
  let layout = cueLayouts.get(key);
  if (layout) return layout;
  const ctx = rythmo.ctx;
  for (let fs = Math.round(clamp(maxH * 0.62, 15, 58)); ; fs--) {
    ctx.font = `${italic ? 'italic 500' : '600'} ${fs}px ${family}`;
    const space = ctx.measureText(' ').width;
    const lines = [[]];
    let x = 0;
    words.forEach((word, k) => {
      const w = ctx.measureText(word).width;
      if (x > 0 && x + w > maxW) { lines.push([]); x = 0; }
      lines[lines.length - 1].push({ k, x, w });
      x += w + space;
    });
    const lineH = Math.round(fs * 1.24);
    if (lines.length * lineH <= maxH || fs <= 12) {
      layout = { fs, lines, lineH, font: ctx.font };
      break;
    }
  }
  if (cueLayouts.size > 80) cueLayouts.clear();
  cueLayouts.set(key, layout);
  return layout;
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/**
 * The line style: the words stay put, so they're easy to read, and the timing
 * comes from a highlight that moves through them, a bar that fills into the
 * line and then across it, and the next line waiting on the right.
 */
function drawCueLine(vt) {
  const { ctx, W, H } = rythmo;
  const P = rythmoPalette();
  const caps = state.captions;
  const idx = bandCaption(vt);
  const cap = caps[idx];
  if (!cap) return;

  const s = session;
  const recording = !!s?.recording;
  const running = transport.isPlaying() || !!s;
  const own = (cap.hinglish || '').trim();
  const plan = wordPlan(own || cap.text);
  const dur = Math.max(0.05, cap.endTime - cap.startTime);
  const lead = cap.startTime - vt;
  let k = -1;
  if (vt >= cap.endTime) k = plan.words.length;
  else if (vt >= cap.startTime) k = activeWordIndex(plan, (vt - cap.startTime) / dur);
  const pad = 16;

  // Top row: state, line number, timing — and the next line to read ahead
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const my = 13;
  let x = pad;
  if (s) {
    const label = recording ? 'REC' : 'REHEARSAL';
    ctx.font = `700 9.5px ${P.font}`;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = recording ? P.syncRec : P.sync;
    roundRectPath(ctx, x, my - 7, w, 14, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 5, my + 0.5);
    x += w + 8;
  }
  let status;
  if (s && !s.started) status = 'cueing…';
  else if (lead > 0 && running) status = `starts in ${lead.toFixed(1)} s`;
  else if (vt >= cap.startTime && vt < cap.endTime) status = `${(vt - cap.startTime).toFixed(1)} / ${dur.toFixed(1)} s`;
  else status = `${dur.toFixed(1)} s`;
  const head = `#${cap.index}   ${status}`;
  ctx.font = `600 11px ${P.font}`;
  ctx.fillStyle = lead > 0 && lead <= STREAMER_SEC && running ? P.beep : P.num;
  ctx.fillText(head, x, my);
  x += ctx.measureText(head).width + 24;

  const rightEdge = W - pad - (s ? 0 : 112);
  let right = '';
  if (s?.mode === 'line') right = s.recording ? `take ${takesFor(idx).length + 1}` : '';
  else if (caps[idx + 1]) right = `Next ›  ${(caps[idx + 1].hinglish || caps[idx + 1].text || '').trim()}`;
  if (right && rightEdge - x > 70) {
    ctx.font = `500 11.5px ${P.font}`;
    ctx.fillStyle = P.num;
    ctx.textAlign = 'right';
    ctx.fillText(fitText(ctx, right, rightEdge - x), rightEdge, my);
    ctx.textAlign = 'left';
  }

  // The line itself, as large as fits
  const top = 26;
  const area = Math.max(14, H - 16 - top);
  const layout = cueLayout(plan.words, !own, W - pad * 2, area, P.font);
  ctx.font = layout.font;
  const y0 = top + (area - layout.lines.length * layout.lineH) / 2 + layout.lineH / 2;
  layout.lines.forEach((line, li) => {
    const y = y0 + li * layout.lineH;
    for (const w of line) {
      ctx.fillStyle = !own ? P.fallback : w.k < k ? P.past : w.k === k ? P.now : P.word;
      ctx.fillText(plan.words[w.k], pad + w.x, y);
      if (own && w.k === k) ctx.fillRect(pad + w.x, y + layout.fs * 0.56, w.w, 2);
    }
  });

  // Amber fills toward the line's start; then the line's progress
  const barY = H - 8;
  const barW = W - pad * 2;
  ctx.fillStyle = P.bar;
  roundRectPath(ctx, pad, barY, barW, 3, 1.5);
  ctx.fill();
  let f;
  let color;
  if (lead > 0) {
    f = running ? clamp(1 - lead / STREAMER_SEC, 0, 1) : 0;
    color = P.beep;
  } else {
    f = clamp((vt - cap.startTime) / dur, 0, 1);
    color = recording ? P.syncRec : P.now;
  }
  if (f > 0) {
    ctx.fillStyle = color;
    roundRectPath(ctx, pad, barY, Math.max(3, barW * f), 3, 1.5);
    ctx.fill();
  }
}

function measureWord(word) {
  let w = rythmo.widths.get(word);
  if (w === undefined) {
    w = rythmo.ctx.measureText(word).width;
    if (rythmo.widths.size > 8000) rythmo.widths.clear();
    rythmo.widths.set(word, w);
  }
  return w;
}

function drawRythmo(vt) {
  rythmo.dirty = false;
  const { ctx, W, H, dpr } = rythmo;
  if (!W || !H) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (settings.bandMode !== 'scroll') {
    drawCueLine(vt);
    return;
  }

  const P = rythmoPalette();
  const pps = settings.rythmoZoom;
  const sync = Math.round(W * SYNC_AT);
  const t0 = vt - sync / pps - 0.5;
  const t1 = vt + (W - sync) / pps + 0.5;
  const textY = Math.round(H * 0.5);
  const barY = H - 11;
  const recording = !!session?.recording;

  ctx.fillStyle = P.shade;
  ctx.fillRect(0, 0, sync, H);

  // Text grows with the band, so a taller band is easier to read.
  const fs = Math.round(clamp(H * 0.26, 16, 30));
  const wordFont = `600 ${fs}px ${P.font}`;
  const italicFont = `italic 500 ${fs - 2}px ${P.font}`;
  const numFont = `600 10px ${P.font}`;
  if (rythmo.font !== wordFont) {
    rythmo.font = wordFont;
    rythmo.widths.clear();
  }
  ctx.textBaseline = 'middle';

  const caps = state.captions;
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];
    if (cap.endTime < t0 || cap.startTime > t1) continue;
    const x0 = sync + (cap.startTime - vt) * pps;
    const x1 = sync + (cap.endTime - vt) * pps;
    const span = Math.max(1, x1 - x0);
    const recorded = !!activeClipFor(i);
    const selected = i === state.selectedRow;

    // Duration bar and cue mark
    ctx.fillStyle = selected ? P.barSel : recorded ? P.barRec : P.bar;
    roundRectPath(ctx, x0, barY, span, 4, 2);
    ctx.fill();
    ctx.fillRect(Math.round(x0), 6, 1, barY - 6);
    ctx.font = numFont;
    ctx.fillStyle = selected ? P.barSel : P.num;
    ctx.fillText(String(cap.index), x0 + 4, 11);

    // Words, each placed when it is due
    const own = (cap.hinglish || '').trim();
    const plan = wordPlan(own || cap.text);
    const n = plan.words.length;
    ctx.font = own ? wordFont : italicFont;
    for (let k = 0; k < n; k++) {
      const wx0 = x0 + plan.starts[k] * span;
      const wx1 = k + 1 < n ? x0 + plan.starts[k + 1] * span : x1;
      if (wx1 < -20 || wx0 > W + 20) continue;
      const word = plan.words[k];
      const natural = own ? measureWord(word) : ctx.measureText(word).width;
      const room = Math.max(4, wx1 - wx0 - 6);
      const sx = natural > room ? Math.max(0.3, room / natural) : 1;
      let color = own ? P.word : P.fallback;
      if (wx0 + natural * sx < sync) color = P.past;
      else if (wx0 <= sync && wx1 > sync && vt >= cap.startTime && vt < cap.endTime) color = P.now;
      ctx.fillStyle = color;
      if (sx === 1) {
        ctx.fillText(word, wx0, textY);
      } else {
        ctx.setTransform(dpr * sx, 0, 0, dpr, dpr * wx0, 0);
        ctx.fillText(word, 0, textY);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
  }

  // The ADR beeps, as dots, while a line is being cued
  if (session && settings.beeps) {
    ctx.fillStyle = P.beep;
    for (const k of [3, 2, 1]) {
      const bt = session.cueVt - k;
      if (bt < session.startVt + 0.05) continue;
      const x = sync + (bt - vt) * pps;
      if (x < -6 || x > W + 6) continue;
      ctx.beginPath();
      ctx.arc(x, 20, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The sync line
  ctx.fillStyle = recording ? P.syncRec : P.sync;
  ctx.fillRect(sync - 1, 0, 2, H);
  ctx.beginPath();
  ctx.moveTo(sync - 5, 0);
  ctx.lineTo(sync + 5, 0);
  ctx.lineTo(sync, 6);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sync - 5, H);
  ctx.lineTo(sync + 5, H);
  ctx.lineTo(sync, H - 6);
  ctx.closePath();
  ctx.fill();
}
