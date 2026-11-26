/**
 * DubDesk — timeline.js
 * The dub timeline: a ruler, the captions, and the recorded clips with their
 * waveforms. Drag a clip to move it, drag its edges to trim it (the audio
 * beyond the trim is kept, so you can always pull it back), right-click for
 * more. Snapping lines a clip's speech up with its caption.
 */

'use strict';

const tl = {
  viewport: null, canvas: null, ctx: null,
  playheadEl: null, emptyEl: null, scrollbar: null, thumb: null,

  dpr: 1, cssW: 0, cssH: 0,

  duration: 1,        // total timeline seconds
  videoDuration: 0,   // from the YouTube player, once known
  pxPerSec: 0,        // current zoom
  minPxPerSec: 1,     // fit-everything zoom
  maxPxPerSec: 600,
  scrollSec: 0,       // time at the left edge
  userZoomed: false,

  dirty: true,
  drag: null,
  palette: null,
  cursor: '',
};

const TL = { RULER: 18, CAP_TOP: 22, CAP_H: 20, GAP: 6, EDGE: 6, SNAP_PX: 8 };

function tlLayout() {
  const capTop = TL.CAP_TOP;
  const capBottom = capTop + TL.CAP_H;
  const dubTop = capBottom + TL.GAP;
  return { capTop, capBottom, dubTop, dubBottom: Math.max(dubTop + 16, tl.cssH - 6) };
}

const tX = t => (t - tl.scrollSec) * tl.pxPerSec;
const xT = x => tl.scrollSec + x / tl.pxPerSec;

// ─────────────────────────────────────────────
// SETUP + GEOMETRY
// ─────────────────────────────────────────────

function initTimeline() {
  const $ = id => document.getElementById(id);
  tl.viewport = $('timeline-viewport');
  tl.canvas = $('timeline-canvas');
  tl.playheadEl = $('timeline-playhead');
  tl.emptyEl = $('timeline-empty');
  tl.scrollbar = $('timeline-scrollbar');
  tl.thumb = $('timeline-scrollbar-thumb');
  if (!tl.canvas) return;
  tl.ctx = tl.canvas.getContext('2d');

  tl.viewport.addEventListener('wheel', onTimelineWheel, { passive: false });
  tl.viewport.addEventListener('pointerdown', onTimelinePointerDown);
  tl.viewport.addEventListener('pointermove', onTimelinePointerMove);
  tl.viewport.addEventListener('pointerup', onTimelinePointerUp);
  tl.viewport.addEventListener('pointercancel', onTimelinePointerCancel);
  tl.viewport.addEventListener('pointerleave', () => { if (!tl.drag) setTimelineCursor(''); });
  tl.viewport.addEventListener('dblclick', onTimelineDblClick);
  tl.viewport.addEventListener('contextmenu', onTimelineContextMenu);

  tl.thumb.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const tw = tl.scrollbar.clientWidth;
    const startX = e.clientX;
    const startScroll = tl.scrollSec;
    const move = ev => {
      tl.scrollSec = startScroll + ((ev.clientX - startX) / Math.max(1, tw)) * tl.duration;
      clampTimelineScroll();
      renderTimeline();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  new ResizeObserver(() => resizeTimeline()).observe(tl.viewport);
  window.addEventListener('dubdesk:themechange', () => {
    tl.palette = null;
    renderTimeline();
  });
  resizeTimeline();
}

/** Whichever is longest: the video, the captions, or the clips. */
function timelineDuration() {
  let last = 0;
  for (const c of state.captions) if (c.endTime > last) last = c.endTime;
  if (studio.clips.length) for (const c of activeClips()) { const e = clipEnd(c); if (e > last) last = e; }
  return Math.max(tl.videoDuration || 0, last, 1);
}

function recomputeTimelineBounds() {
  tl.duration = timelineDuration();
  tl.minPxPerSec = tl.cssW > 0 ? tl.cssW / tl.duration : 1;
  tl.pxPerSec = clamp(tl.pxPerSec, tl.minPxPerSec, tl.maxPxPerSec);
}

function fitTimeline() {
  recomputeTimelineBounds();
  tl.pxPerSec = tl.minPxPerSec;
  tl.scrollSec = 0;
  tl.userZoomed = false;
  renderTimeline();
}

function clampTimelineScroll() {
  const viewSec = tl.cssW / tl.pxPerSec;
  tl.scrollSec = clamp(tl.scrollSec, 0, Math.max(0, tl.duration - viewSec));
}

function resizeTimeline() {
  if (!tl.viewport || !tl.ctx) return;
  const rect = tl.viewport.getBoundingClientRect();
  tl.cssW = rect.width;
  tl.cssH = rect.height;
  tl.dpr = window.devicePixelRatio || 1;
  tl.canvas.width = Math.max(1, Math.round(tl.cssW * tl.dpr));
  tl.canvas.height = Math.max(1, Math.round(tl.cssH * tl.dpr));
  tl.canvas.style.width = `${tl.cssW}px`;
  tl.canvas.style.height = `${tl.cssH}px`;
  tl.ctx.setTransform(tl.dpr, 0, 0, tl.dpr, 0, 0);
  recomputeTimelineBounds();
  if (!tl.userZoomed) tl.pxPerSec = tl.minPxPerSec;
  clampTimelineScroll();
  drawTimeline();
}

/** Scroll the timeline so time t is in view (a third of the way in). */
function revealTime(t) {
  if (!tl.cssW || !tl.pxPerSec) return;
  const x = tX(t);
  if (x >= 12 && x <= tl.cssW - 12) return;
  tl.scrollSec = t - (tl.cssW * 0.33) / tl.pxPerSec;
  clampTimelineScroll();
  renderTimeline();
}

/** Zoom around a point (the playhead, or the middle, by default). */
function zoomTimeline(factor, anchorX) {
  if (!tl.cssW) return;
  recomputeTimelineBounds();
  if (anchorX === undefined) {
    const px = tX(transport.now());
    anchorX = px >= 0 && px <= tl.cssW ? px : tl.cssW / 2;
  }
  const t = xT(anchorX);
  tl.pxPerSec = clamp(tl.pxPerSec * factor, tl.minPxPerSec, tl.maxPxPerSec);
  tl.userZoomed = tl.pxPerSec > tl.minPxPerSec + 1e-6;
  tl.scrollSec = t - anchorX / tl.pxPerSec;
  clampTimelineScroll();
  renderTimeline();
}

function onTimelineWheel(e) {
  e.preventDefault();
  if (!tl.duration || !tl.pxPerSec) return;
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    tl.scrollSec += (e.shiftKey ? e.deltaY : e.deltaX) / tl.pxPerSec;
    clampTimelineScroll();
    renderTimeline();
    return;
  }
  const rect = tl.viewport.getBoundingClientRect();
  zoomTimeline(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left);
}

// ─────────────────────────────────────────────
// INTERACTION
// ─────────────────────────────────────────────

function tlLocal(e) {
  const r = tl.viewport.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function tlHit(x, y) {
  if (!state.captions.length) return { type: 'none' };
  const L = tlLayout();
  if (y < TL.RULER) return { type: 'ruler' };

  if (y >= L.dubTop - 3 && y <= L.dubBottom + 3) {
    const sel = state.selectedRow;
    let best = null;
    for (const c of activeClips()) {
      const x0 = tX(clipStart(c));
      const x1 = tX(clipEnd(c));
      const edge = Math.min(TL.EDGE, (x1 - x0) / 3);
      if (x < x0 - edge || x > x1 + edge) continue;
      let part = 'body';
      if (Math.abs(x - x0) <= edge) part = 'left';
      else if (Math.abs(x - x1) <= edge) part = 'right';
      else if (x < x0 || x > x1) continue;
      const hit = { type: 'clip', clip: c, edge: part === 'body' ? null : part };
      // The selected clip wins where clips overlap.
      if (!best || c.capIdx === sel) best = hit;
    }
    if (best) return best;
    return { type: 'lane', t: xT(x) };
  }

  if (y >= L.capTop - 2 && y <= L.capBottom + 2) {
    const t = xT(x);
    const idx = state.captions.findIndex(c => t >= c.startTime && t <= c.endTime);
    if (idx !== -1) return { type: 'caption', idx };
  }
  return { type: 'empty', t: xT(x) };
}

function setTimelineCursor(c) {
  if (tl.cursor === c) return;
  tl.cursor = c;
  tl.viewport.style.cursor = c;
}

function snapTargets(clip) {
  const out = [];
  const cap = state.captions[clip.capIdx];
  if (cap) out.push({ t: cap.startTime, label: 'caption start' }, { t: cap.endTime, label: 'caption end' });
  out.push({ t: transport.now(), label: 'playhead' });
  const lo = xT(-80);
  const hi = xT(tl.cssW + 80);
  for (const c of activeClips()) {
    if (c === clip) continue;
    const s = clipStart(c);
    const e = clipEnd(c);
    if (e < lo || s > hi) continue;
    out.push({ t: s, label: 'clip edge' }, { t: e, label: 'clip edge' });
  }
  return out;
}

function onTimelinePointerDown(e) {
  if (e.button !== 0 || e.target.closest('.timeline-play-btn')) return;
  closeClipMenu();
  const { x, y } = tlLocal(e);
  const hit = tlHit(x, y);
  if (hit.type === 'none') return;
  try { tl.viewport.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }

  if (hit.type === 'clip') {
    const clip = hit.clip;
    if (state.selectedRow !== clip.capIdx) {
      selectRow(clip.capIdx);
      rowEl(clip.capIdx)?.scrollIntoView({ block: 'nearest' });
    }
    if (session) { tl.drag = null; return; }
    tl.drag = {
      kind: hit.edge ? `trim-${hit.edge}` : 'move',
      clip,
      startX: e.clientX,
      orig: { offset: clip.offset, in: clip.in, out: clip.out },
      snap: snapshotClips(),
      moved: false,
      onset: hit.edge ? null : clipOnset(clip),
      targets: snapTargets(clip),
      label: '',
    };
  } else if (hit.type === 'ruler') {
    tl.drag = { kind: 'scrub' };
    if (!session) transport.scrub(xT(x), false);
  } else {
    tl.drag = { kind: 'pan', startX: e.clientX, startScroll: tl.scrollSec, moved: false, hit, x };
  }
}

function onTimelinePointerMove(e) {
  const { x, y } = tlLocal(e);
  const d = tl.drag;
  if (!d) {
    const hit = tlHit(x, y);
    if (hit.type === 'clip' && !session) setTimelineCursor(hit.edge ? 'ew-resize' : 'grab');
    else if (hit.type === 'ruler') setTimelineCursor('text');
    else if (hit.type === 'caption') setTimelineCursor('pointer');
    else setTimelineCursor('');
    return;
  }
  const dx = e.clientX - (d.startX ?? e.clientX);
  if (d.kind === 'pan') {
    if (Math.abs(dx) > 4) d.moved = true;
    if (d.moved) {
      setTimelineCursor('grabbing');
      tl.scrollSec = d.startScroll - dx / tl.pxPerSec;
      clampTimelineScroll();
      renderTimeline();
    }
  } else if (d.kind === 'scrub') {
    if (!session) transport.scrub(xT(x), false);
  } else {
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    setTimelineCursor(d.kind === 'move' ? 'grabbing' : 'ew-resize');
    applyClipDrag(d, dx, e.altKey);
    renderTimeline();
  }
}

function onTimelinePointerUp(e) {
  const d = tl.drag;
  tl.drag = null;
  if (!d) return;
  const { x } = tlLocal(e);
  if (d.kind === 'pan' && !d.moved) {
    if (d.hit.type === 'caption') {
      selectRow(d.hit.idx);
      scrollRowToCenter(d.hit.idx);
      if (!session) transport.seek(state.captions[d.hit.idx].startTime);
    } else if (!session) {
      transport.seek(xT(d.x));
    }
  } else if (d.kind === 'scrub') {
    if (!session) transport.scrub(xT(x), true);
  } else if (d.kind !== 'pan' && d.moved) {
    pushUndoSnapshot(d.snap);
    clipsChanged([d.clip.capIdx]);
  }
  setTimelineCursor('');
  renderTimeline();
}

function onTimelinePointerCancel() {
  const d = tl.drag;
  tl.drag = null;
  if (d && d.clip && d.moved) {
    // Put a half-dragged clip back.
    Object.assign(d.clip, d.orig);
    invalidateClips();
  }
  renderTimeline();
}

function applyClipDrag(d, dx, free) {
  const clip = d.clip;
  const take = studio.takes.get(clip.takeId);
  const dt = dx / tl.pxPerSec;
  const snapOn = settings.snap && !free;
  const thr = TL.SNAP_PX / tl.pxPerSec;
  let best = null;
  const consider = (cand, cur, label) => {
    const dist = Math.abs(cand - cur);
    if (dist < thr && (!best || dist < best.dist)) best = { cand, dist, label };
  };

  if (d.kind === 'move') {
    let offset = d.orig.offset + dt;
    if (snapOn) {
      const cap = state.captions[clip.capIdx];
      if (d.onset !== null && cap) consider(cap.startTime - d.onset, offset, 'speech on caption start');
      for (const tg of d.targets) {
        consider(tg.t - clip.in, offset, tg.label);
        consider(tg.t - clip.out, offset, tg.label);
      }
      consider(clip.origOffset, offset, 'where it was recorded');
      if (best) offset = best.cand;
    }
    clip.offset = offset;
    d.label = `${fmtMs(offset - clip.origOffset)}${best ? ` · ${best.label}` : ''}`;
  } else if (d.kind === 'trim-left') {
    let inn = clamp(d.orig.in + dt, 0, clip.out - 0.05);
    if (snapOn) {
      for (const tg of d.targets) {
        const cand = tg.t - clip.offset;
        if (cand >= 0 && cand <= clip.out - 0.05) consider(cand, inn, tg.label);
      }
      if (best) inn = best.cand;
    }
    clip.in = inn;
    d.label = `Starts ${fmtTimecode(clipStart(clip)).slice(3)}${best ? ` · ${best.label}` : ''}`;
  } else {
    let out = clamp(d.orig.out + dt, clip.in + 0.05, take.duration);
    if (snapOn) {
      for (const tg of d.targets) {
        const cand = tg.t - clip.offset;
        if (cand >= clip.in + 0.05 && cand <= take.duration) consider(cand, out, tg.label);
      }
      if (best) out = best.cand;
    }
    clip.out = out;
    d.label = `Ends ${fmtTimecode(clipEnd(clip)).slice(3)}${best ? ` · ${best.label}` : ''}`;
  }
  invalidateClips();
  updateInspector();
}

function onTimelineDblClick(e) {
  if (session) return;
  const { x, y } = tlLocal(e);
  const hit = tlHit(x, y);
  if (hit.type === 'clip') auditionClip(hit.clip);
  else if (hit.type === 'caption') {
    const cap = state.captions[hit.idx];
    playSegment(cap.startTime, cap.endTime);
  }
}

function onTimelineContextMenu(e) {
  const { x, y } = tlLocal(e);
  const hit = tlHit(x, y);
  if (hit.type !== 'clip' || session) return;
  e.preventDefault();
  if (state.selectedRow !== hit.clip.capIdx) selectRow(hit.clip.capIdx);
  openClipMenu(hit.clip, e.clientX, e.clientY);
}

// ─────────────────────────────────────────────
// DRAWING
// ─────────────────────────────────────────────

function timelinePalette() {
  if (tl.palette) return tl.palette;
  const style = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  tl.palette = {
    label: read('--tl-label'),
    grid: read('--tl-grid'),
    cap: read('--tl-pill'),
    capRec: read('--tl-cap-rec'),
    capText: read('--tl-cap-text'),
    lane: read('--tl-lane'),
    clip: read('--tl-clip'),
    clipSel: read('--tl-clip-selected'),
    wave: read('--tl-audio'),
    waveSel: read('--tl-wave-selected'),
    clipLabel: read('--tl-clip-label'),
    selected: read('--tl-selected'),
    guide: read('--tl-guide'),
    overlap: read('--tl-overlap'),
    rec: read('--red'),
    recTint: read('--tl-rec-tint'),
    tipBg: read('--panel'),
    tipFg: read('--fg'),
    onset: read('--amber'),
    font: read('--font'),
  };
  return tl.palette;
}

/** Ask for a redraw on the next frame. */
function renderTimeline() { tl.dirty = true; }

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmtTimelineTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${pad2(sec)}` : `${mm}:${pad2(sec)}`;
}

function drawTimelineRuler(ctx, W, P) {
  const rulerH = TL.RULER;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];
  let step = steps[steps.length - 1];
  for (const s of steps) if (s * tl.pxPerSec >= 70) { step = s; break; }
  const minor = step / (step >= 1 && step % 5 === 0 ? 5 : 2);

  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let t = Math.ceil(tl.scrollSec / minor) * minor; ; t += minor) {
    const x = Math.round(tX(t)) + 0.5;
    if (x > W) break;
    ctx.moveTo(x, rulerH - 4);
    ctx.lineTo(x, rulerH);
  }
  ctx.stroke();

  ctx.fillStyle = P.label;
  ctx.font = `10px ${P.font}`;
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  for (let t = Math.ceil(tl.scrollSec / step) * step; ; t += step) {
    const x = Math.round(tX(t)) + 0.5;
    if (x > W) break;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rulerH);
    const label = step < 1 ? `${fmtTimelineTime(Math.floor(t))}.${String(Math.round((t % 1) * 100)).padStart(2, '0')}` : fmtTimelineTime(t);
    ctx.fillText(label, x + 3, rulerH / 2 - 1);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, rulerH + 0.5);
  ctx.lineTo(W, rulerH + 0.5);
  ctx.stroke();
}

function drawWave(ctx, peaks, offset, x0, x1, cy, half, gain, W) {
  const n = peaks.length;
  const a = Math.max(0, Math.floor(x0));
  const b = Math.min(W, Math.ceil(x1));
  for (let px = a; px < b; px++) {
    const t0 = xT(px) - offset;
    const t1 = xT(px + 1) - offset;
    let b0 = Math.floor(t0 * PEAKS_PER_SEC);
    let b1 = Math.max(b0 + 1, Math.floor(t1 * PEAKS_PER_SEC));
    if (b1 <= 0 || b0 >= n) continue;
    b0 = Math.max(0, b0);
    b1 = Math.min(n, b1);
    let m = 0;
    for (let k = b0; k < b1; k++) if (peaks[k] > m) m = peaks[k];
    const h = Math.max(0.5, Math.min(1, Math.sqrt(m * gain)) * half);
    ctx.fillRect(px, cy - h, 1, h * 2);
  }
}

function drawClip(ctx, clip, L, P, W, selected) {
  const take = studio.takes.get(clip.takeId);
  if (!take) return;
  const x0 = tX(clipStart(clip));
  const x1 = tX(clipEnd(clip));
  if (x1 < -2 || x0 > W + 2) return;
  const top = L.dubTop;
  const h = L.dubBottom - L.dubTop;
  const w = Math.max(2, x1 - x0);

  roundRectPath(ctx, x0, top, w, h, 6);
  ctx.fillStyle = selected ? P.clipSel : P.clip;
  ctx.fill();

  ctx.save();
  roundRectPath(ctx, x0, top, w, h, 6);
  ctx.clip();
  ctx.fillStyle = selected ? P.waveSel : P.wave;
  const labelRoom = h > 40 && w > 34 ? 6 : 0;
  drawWave(ctx, take.peaks, clip.offset, x0, x1, top + h / 2 + labelRoom / 2, h / 2 - 3 - labelRoom / 2, dbToGain(clip.gain), W);

  if (w > 34 && h > 26) {
    const cap = state.captions[clip.capIdx];
    const takes = takesFor(clip.capIdx);
    let label = `#${cap ? cap.index : '?'}`;
    if (takes.length > 1) label += ` · T${takes.indexOf(clip) + 1}`;
    if (clip.gain) label += ` · ${clip.gain > 0 ? '+' : ''}${clip.gain.toFixed(1)} dB`;
    if (clip.fit) label += ' · fitted';
    ctx.font = `600 10px ${P.font}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = P.clipLabel;
    ctx.fillText(label, x0 + 6, top + 4);
  }
  ctx.restore();

  if (selected) {
    roundRectPath(ctx, x0 + 0.75, top + 0.75, w - 1.5, h - 1.5, 6);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = P.selected;
    ctx.stroke();
    if (w > 18) {
      ctx.fillStyle = P.selected;
      roundRectPath(ctx, x0 + 2, top + h / 2 - 9, 3, 18, 1.5);
      ctx.fill();
      roundRectPath(ctx, x1 - 5, top + h / 2 - 9, 3, 18, 1.5);
      ctx.fill();
    }
    // Where the speech starts: the point that should sit on the caption start.
    const on = clipOnset(clip);
    if (on !== null) {
      const ox = tX(clip.offset + on);
      if (ox >= x0 && ox <= x1) {
        ctx.fillStyle = P.onset;
        ctx.beginPath();
        ctx.moveTo(ox - 4, L.dubBottom + 1);
        ctx.lineTo(ox + 4, L.dubBottom + 1);
        ctx.lineTo(ox, L.dubBottom - 5);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

function drawLiveTake(ctx, L, P, W) {
  const s = session;
  const start = AudioEngine.captureStart();
  if (!s.livePeaks || start === null || !s.started) return;
  const p = performance.now();
  const vtNow = transport.now(p);
  const tNow = AudioEngine.captureTimeAt(p, settings.latencyMs) - start;
  const rate = s.rate || 1;
  const vtAt = t => vtNow + (t - tNow) * rate;
  const from = Math.max(s.startVt, vtAt(0));
  const x0 = tX(from);
  const x1 = tX(vtNow);
  if (x1 < 0 || x0 > W || x1 <= x0) return;

  const top = L.dubTop;
  const h = L.dubBottom - L.dubTop;
  ctx.fillStyle = P.recTint;
  roundRectPath(ctx, x0, top, x1 - x0, h, 6);
  ctx.fill();

  const peaks = s.livePeaks.peaks;
  const n = s.livePeaks.count;
  const cy = top + h / 2;
  const half = h / 2 - 3;
  ctx.fillStyle = P.rec;
  for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, Math.ceil(x1)); px++) {
    const ta = tNow + (xT(px) - vtNow) / rate;
    const tb = tNow + (xT(px + 1) - vtNow) / rate;
    let b0 = Math.floor(ta * PEAKS_PER_SEC);
    let b1 = Math.max(b0 + 1, Math.floor(tb * PEAKS_PER_SEC));
    if (b1 <= 0 || b0 >= n) continue;
    b0 = Math.max(0, b0);
    b1 = Math.min(n, b1);
    let m = 0;
    for (let k = b0; k < b1; k++) if (peaks[k] > m) m = peaks[k];
    const hh = Math.max(0.5, Math.min(1, Math.sqrt(m)) * half);
    ctx.fillRect(px, cy - hh, 1, hh * 2);
  }
}

function drawDragLabel(ctx, text, P, W) {
  ctx.font = `600 11px ${P.font}`;
  const w = ctx.measureText(text).width + 16;
  const playX = tX(clipStart(tl.drag.clip));
  const x = clamp(playX, 4, W - w - 4);
  const y = TL.RULER + 2;
  ctx.fillStyle = P.tipBg;
  roundRectPath(ctx, x, y, w, 20, 10);
  ctx.fill();
  ctx.fillStyle = P.tipFg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 8, y + 10);
}

function drawTimeline() {
  tl.dirty = false;
  const ctx = tl.ctx;
  if (!ctx) return;
  const W = tl.cssW;
  const H = tl.cssH;
  ctx.clearRect(0, 0, W, H);

  const hasCaps = state.captions.length > 0;
  tl.emptyEl?.classList.toggle('hidden', hasCaps);
  if (!hasCaps) { updateTimelineScrollbar(); return; }

  const P = timelinePalette();
  const L = tlLayout();
  recomputeTimelineBounds();
  if (!tl.userZoomed) tl.pxPerSec = tl.minPxPerSec;
  clampTimelineScroll();
  drawTimelineRuler(ctx, W, P);

  ctx.fillStyle = P.lane;
  roundRectPath(ctx, 0, L.dubTop - 2, W, L.dubBottom - L.dubTop + 4, 8);
  ctx.fill();

  // Captions
  const sel = state.selectedRow;
  ctx.font = `500 10px ${P.font}`;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < state.captions.length; i++) {
    const cap = state.captions[i];
    const x0 = tX(cap.startTime);
    const x1 = tX(cap.endTime);
    if (x1 < 0 || x0 > W) continue;
    const w = Math.max(2, x1 - x0);
    roundRectPath(ctx, x0, L.capTop, w, TL.CAP_H, 5);
    ctx.fillStyle = i === sel ? P.selected : activeClipFor(i) ? P.capRec : P.cap;
    ctx.fill();
    if (w > 22) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 4, L.capTop, w - 8, TL.CAP_H);
      ctx.clip();
      ctx.fillStyle = i === sel ? '#fff' : P.capText;
      const words = w > 90 ? ` ${(cap.hinglish || cap.text || '').trim()}` : '';
      ctx.fillText(`${cap.index}${words}`, x0 + 6, L.capTop + TL.CAP_H / 2);
      ctx.restore();
    }
  }

  // Where the selected line should start and end, carried down into the clips
  if (sel !== null && state.captions[sel]) {
    const cap = state.captions[sel];
    ctx.strokeStyle = P.guide;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const t of [cap.startTime, cap.endTime]) {
      const x = Math.round(tX(t)) + 0.5;
      ctx.moveTo(x, L.capBottom);
      ctx.lineTo(x, L.dubBottom);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Clips, selected last so it sits on top
  const clips = activeClips();
  let selectedClipObj = null;
  for (const c of clips) {
    if (c.capIdx === sel) { selectedClipObj = c; continue; }
    drawClip(ctx, c, L, P, W, false);
  }
  if (selectedClipObj) drawClip(ctx, selectedClipObj, L, P, W, true);

  // Overlaps: two voices, or the same audio twice
  ctx.fillStyle = P.overlap;
  for (let i = 1; i < clips.length; i++) {
    const a = clips[i - 1];
    const b = clips[i];
    const over = clipEnd(a) - clipStart(b);
    if (over > 0.01) {
      const x0 = tX(clipStart(b));
      const x1 = tX(Math.min(clipEnd(a), clipEnd(b)));
      if (x1 > 0 && x0 < W) ctx.fillRect(x0, L.dubBottom - 3, Math.max(1, x1 - x0), 3);
    }
  }

  if (session?.recording) drawLiveTake(ctx, L, P, W);
  if (tl.drag?.clip && tl.drag.moved && tl.drag.label) drawDragLabel(ctx, tl.drag.label, P, W);

  updateTimelineScrollbar();
}

function updateTimelineScrollbar() {
  if (!tl.scrollbar || !tl.thumb) return;
  const dur = tl.duration || 1;
  const frac = Math.min(1, (tl.cssW / tl.pxPerSec) / dur);
  if (frac >= 1 || !isFinite(frac)) {
    tl.scrollbar.classList.add('disabled');
    tl.thumb.style.width = '100%';
    tl.thumb.style.left = '0';
    return;
  }
  tl.scrollbar.classList.remove('disabled');
  const tw = tl.scrollbar.clientWidth;
  const thumbW = Math.max(24, tw * frac);
  const left = clamp((tl.scrollSec / dur) * tw, 0, tw - thumbW);
  tl.thumb.style.width = `${thumbW}px`;
  tl.thumb.style.left = `${left}px`;
}

/** Per frame: follow the video's length and the playhead, redraw if needed. */
function timelineFrame(p) {
  if (!tl.ctx) return;

  if (transport.hasVideo()) {
    let d = 0;
    try { d = ytPlayer.getDuration() || 0; } catch { /* not ready */ }
    if (d > 0 && Math.abs(d - tl.videoDuration) > 0.5) {
      tl.videoDuration = d;
      recomputeTimelineBounds();
      if (!tl.userZoomed) fitTimeline();
      else { clampTimelineScroll(); renderTimeline(); }
    }
  }

  const t = transport.now(p);
  if ((transport.isPlaying() || session) && !tl.drag) {
    const x = tX(t);
    if (x < 0 || x > tl.cssW * 0.94) {
      tl.scrollSec = Math.max(0, t - (tl.cssW * 0.1) / tl.pxPerSec);
      clampTimelineScroll();
      tl.dirty = true;
    }
  }
  if (session?.recording) tl.dirty = true;
  if (tl.dirty) drawTimeline();

  const ph = tl.playheadEl;
  if (ph) {
    const x = tX(t);
    const show = state.captions.length > 0 && x >= 0 && x <= tl.cssW;
    ph.classList.toggle('hidden', !show);
    ph.classList.toggle('rec', !!session?.recording);
    if (show) ph.style.transform = `translateX(${x.toFixed(1)}px)`;
  }
}

function syncTimelinePlayBtn() {
  const btn = el.timelinePlayBtn;
  if (!btn) return;
  const playing = transport.isPlaying();
  if (btn.classList.contains('playing') === playing) return;
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
