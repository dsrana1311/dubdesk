/**
 * DubDesk — studio.js
 * The recording workspace on top of the audio engine.
 *
 *   transport  — one clock for the whole app, locked to the YouTube player
 *                (or running on its own when no video is loaded). The
 *                prompter, rythmo band, timeline and dub playback all read it,
 *                so they stay in step through seeks, buffering and slow-motion.
 *   sessions   — rehearse a line, record a line, or record continuously.
 *                Pre-roll, ADR beeps and post-roll; the take is captured from
 *                an always-open microphone and placed by matching the audio
 *                clock against the video clock, not by guessing.
 *   takes/clips— every take is kept. A caption's active clip is what plays
 *                and exports; older takes stay as alternates. Clips can be
 *                moved, trimmed, aligned, fitted and gained, with undo.
 *   playback   — the dub plays in sync with the video, mixed with the original.
 *   storage    — the project and its audio are saved to IndexedDB as you work.
 */

'use strict';

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

const STUDIO_SETTINGS_KEY = 'dubdesk_studio';

const SETTINGS_VERSION = 2;

const STUDIO_DEFAULTS = {
  v: SETTINGS_VERSION,
  preRoll: 2,              // s of picture before the line
  postRoll: 1,             // s kept rolling after the line
  beeps: true,             // three ADR beeps leading into the line
  pace: 1,                 // 1, 0.75 or 0.5: video speed while recording
  rythmo: true,            // caption band under the video
  bandMode: 'static',      // static: the line stands still, a highlight follows the words
                           // scroll: the words scroll past a sync line (rythmo band)
  overlay: false,          // large teleprompter window while recording (opt-in)
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  inputChannel: 0,         // 0 = input 1, 1 = input 2, -1 = mix
  monitor: false,          // hear the microphone through the speakers
  latencyMs: 0,            // manual sync offset for new takes
  dubVolume: 100,          // dub audio during playback
  afterTake: 'next',       // next | stay | chain | loop
  autoAlign: false,
  snap: true,
  rythmoZoom: 170,         // rythmo band px per second
};

// The original video's sound is never set here: the YouTube player's own
// speaker and volume control decide it, during playback and recording alike.

const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STUDIO_SETTINGS_KEY) || '{}') || {}; } catch { saved = {}; }
  const s = { ...STUDIO_DEFAULTS, ...saved };
  // The old pace slider ran 0.3–1.0, but YouTube only plays at a few fixed speeds.
  if (saved.pace === undefined) {
    const old = parseFloat(localStorage.getItem('recording_pace'));
    if (old > 0 && old < 1) s.pace = old <= 0.62 ? 0.5 : old <= 0.87 ? 0.75 : 1;
  }
  if (![1, 0.75, 0.5].includes(s.pace)) s.pace = 1;
  // Version 1 opened a teleprompter window for every take and set the
  // video's volume itself; both are gone.
  if ((saved.v || 1) < 2) s.overlay = false;
  delete s.guideVolume;
  delete s.originalVolume;
  if (!['static', 'scroll'].includes(s.bandMode)) s.bandMode = 'static';
  s.v = SETTINGS_VERSION;
  return s;
})();

function saveSettings() {
  try { localStorage.setItem(STUDIO_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* applies for this visit */ }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const FADE = 0.004;                       // s — edge fades so clips never click
const LEAD = { min: 0.12, max: 0.6 };     // s kept before a line
const TAIL = { min: 0.25, max: 1.2 };     // s kept after a line

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dbToGain = db => Math.pow(10, db / 20);
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const pad2 = n => String(n).padStart(2, '0');

function fmtClock(sec) {
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${neg ? '−' : ''}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function fmtTimecode(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, '0')}`;
}

function fmtMs(sec) {
  const ms = Math.round(sec * 1000);
  if (!ms) return '0 ms';
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`;
}

function safeFileName(s) {
  return (s || 'dub').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'dub';
}

let uidSeq = 0;
const uid = prefix => `${prefix}${Date.now().toString(36)}${(uidSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─────────────────────────────────────────────
// MODEL — takes and clips
// ─────────────────────────────────────────────
//
// A take is raw audio, never changed once made. A clip places part of a take
// on the timeline: take time 0 sits at timeline time `offset`, and the clip
// plays take seconds `in`…`out`. So moving a clip changes offset, trimming
// changes in/out, and the audio outside the trim stays available as handles.

const studio = {
  takes: new Map(),   // id → { id, sampleRate, data, duration, peaks, buffer, createdAt, derivedFrom }
  clips: [],          // { id, takeId, capIdx, offset, origOffset, in, out, gain, active, createdAt, fit? }
  cache: null,
  busy: false,
  starting: false,
  chainTimer: null,
};

const pendingTakeWrites = new Set();
let storageWarned = false;
let persistRequested = false;

function makeTake(rec) {
  const data = rec.data instanceof Float32Array ? rec.data : new Float32Array(rec.data);
  return {
    id: rec.id,
    sampleRate: rec.sampleRate,
    data,
    duration: data.length / rec.sampleRate,
    peaks: DSP.peaks(data, rec.sampleRate),
    buffer: null,
    createdAt: rec.createdAt || Date.now(),
    derivedFrom: rec.derivedFrom || null,
  };
}

function addTake(data, sampleRate, meta = {}) {
  const take = makeTake({ id: uid('t'), sampleRate, data, createdAt: Date.now(), ...meta });
  studio.takes.set(take.id, take);
  persistTake(take);
  return take;
}

function persistTake(take) {
  const write = Store.putTake({
    id: take.id,
    sampleRate: take.sampleRate,
    data: take.data,
    createdAt: take.createdAt,
    derivedFrom: take.derivedFrom,
  }).catch(err => {
    console.error('Saving take failed', err);
    if (!storageWarned) {
      storageWarned = true;
      showToast('Couldn’t save audio to this browser — export your dub before closing the tab', 'error');
    }
  }).finally(() => pendingTakeWrites.delete(write));
  pendingTakeWrites.add(write);

  // Ask once for storage the browser won't clear on its own.
  if (!persistRequested && navigator.storage?.persist) {
    persistRequested = true;
    navigator.storage.persist().catch(() => {});
  }
}

function takeBuffer(take) {
  if (!take.buffer) {
    let b;
    try {
      b = new AudioBuffer({ length: take.data.length, numberOfChannels: 1, sampleRate: take.sampleRate });
    } catch {
      b = AudioEngine.context().createBuffer(1, take.data.length, take.sampleRate);
    }
    b.copyToChannel(take.data, 0);
    take.buffer = b;
  }
  return take.buffer;
}

const clipStart = c => c.offset + c.in;
const clipEnd = c => c.offset + c.out;

function clipIndex() {
  if (!studio.cache) {
    const active = new Map();
    const all = new Map();
    for (const c of studio.clips) {
      if (!all.has(c.capIdx)) all.set(c.capIdx, []);
      all.get(c.capIdx).push(c);
      if (c.active) active.set(c.capIdx, c);
    }
    for (const list of all.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    const sorted = [...active.values()].sort((a, b) => clipStart(a) - clipStart(b));
    studio.cache = { active, all, sorted };
  }
  return studio.cache;
}

function invalidateClips() { studio.cache = null; }
function activeClipFor(i) { return clipIndex().active.get(i) || null; }
function takesFor(i) { return clipIndex().all.get(i) || []; }
function activeClips() { return clipIndex().sorted; }

/** Every caption with takes has exactly one active one. */
function ensureActive() {
  invalidateClips();
  for (const [, list] of clipIndex().all) {
    const actives = list.filter(c => c.active);
    if (actives.length === 1) continue;
    list.forEach(c => { c.active = false; });
    list[list.length - 1].active = true;
  }
  invalidateClips();
}

function addClip(clip) {
  for (const c of studio.clips) if (c.capIdx === clip.capIdx) c.active = false;
  clip.active = true;
  studio.clips.push(clip);
  invalidateClips();
}

/** Refresh a caption row's recording controls from the model. */
function refreshRow(idx) {
  const cap = state.captions[idx];
  if (!cap) return;
  const clip = activeClipFor(idx);
  const takes = takesFor(idx);
  cap.verified = !!clip;

  const row = rowEl(idx);
  if (!row) return;
  const rec = row.querySelector('.rec-btn');
  const listen = row.querySelector('.listen-btn');
  const dl = row.querySelector('.dl-btn');
  const chip = row.querySelector('.take-chip');
  const recTitle = clip ? 'Record a new take of this line (T)' : 'Record this line (T)';
  if (rec) {
    rec.classList.toggle('has-recording', !!clip);
    rec.title = recTitle;
    rec.setAttribute('aria-label', recTitle);
  }
  listen?.classList.toggle('hidden', !clip);
  dl?.classList.toggle('hidden', !clip);
  if (chip) {
    chip.classList.toggle('hidden', takes.length < 2);
    if (takes.length > 1) {
      const k = takes.indexOf(clip) + 1;
      chip.textContent = `${k}/${takes.length}`;
      chip.title = `Take ${k} of ${takes.length} — click for the next take ([ ])`;
    }
  }
  applyRowClass(row, cap);
}

function refreshAllRows() {
  for (let i = 0; i < state.captions.length; i++) refreshRow(i);
  updateProgress();
}

/** Everything that has to follow a change to the clips. */
function clipsChanged(rows = 'all') {
  invalidateClips();
  if (rows === 'all') refreshAllRows();
  else { rows.forEach(refreshRow); updateProgress(); }
  dubPlayer.reset();
  renderTimeline();
  rythmo.dirty = true;
  updateInspector();
  updateUndoButtons();
  projectChanged();
}

// ─────────────────────────────────────────────
// TRANSPORT — the one clock
// ─────────────────────────────────────────────
//
// The YouTube player reports its time over postMessage, so a raw reading can
// be a moment old. The transport keeps a linear clock (anchor + rate × elapsed)
// and pulls it toward each fresh reading, giving a smooth, accurate time every
// frame. Fresh readings are also what recordings are placed against.

const transport = {
  vt: 0,               // anchor: video time…
  perf: 0,             // …at this performance-clock time
  rate: 1,
  playing: false,
  ytState: -1,
  raw: 0,
  lastRaw: null,
  fresh: false,        // a new reading from the player arrived this update
  epoch: 0,            // bumps on every jump, so scheduled audio can resync
  rangeEnd: null,
  internalRate: 1,
  seekHold: null,
  pauseHold: 0,
  parked: null,        // playhead set before the video was started

  hasVideo() {
    return !!(ytPlayer && typeof ytPlayer.getPlayerState === 'function' && typeof ytPlayer.getCurrentTime === 'function');
  },

  now(p = performance.now()) {
    return this.playing ? this.vt + ((p - this.perf) / 1000) * this.rate : this.vt;
  },

  isPlaying() { return this.playing; },

  update(p = performance.now()) {
    this.fresh = false;
    if (this.hasVideo()) {
      this.followVideo(p);
    } else if (this.playing && this.now(p) >= timelineDuration()) {
      this.vt = timelineDuration();
      this.perf = p;
      this.playing = false;
      this.epoch++;
    }
    if (this.rangeEnd !== null && this.playing && this.now(p) >= this.rangeEnd) {
      this.rangeEnd = null;
      this.pause();
    }
  },

  followVideo(p) {
    let st, raw, rate;
    try {
      st = ytPlayer.getPlayerState();
      raw = ytPlayer.getCurrentTime() || 0;
      rate = ytPlayer.getPlaybackRate() || 1;
    } catch { return; }
    this.ytState = st;

    // A playhead parked while the video wasn't started: show it, and apply it
    // as soon as the video starts, even from YouTube's own play button.
    if (this.parked !== null) {
      if (st === -1 || st === 5 || st === 0) {
        raw = this.parked;
      } else {
        const t = this.parked;
        this.parked = null;
        try { ytPlayer.seekTo(t, true); } catch { /* player gone */ }
        this.seekHold = { t, until: p + 800 };
      }
    }

    // Right after a seek the player can still report the old position.
    if (this.seekHold) {
      if (p > this.seekHold.until || Math.abs(raw - this.seekHold.t) < 0.08) this.seekHold = null;
      else raw = this.seekHold.t;
    }
    const held = !!this.seekHold;

    let playing = st === 1;
    if (playing && p < this.pauseHold) playing = false;   // asked to pause; player catching up
    if (!playing) {
      if (this.playing) this.epoch++;
      this.playing = false;
      this.vt = raw;
      this.perf = p;
      this.rate = rate;
      this.lastRaw = raw;
      return;
    }

    if (!this.playing || rate !== this.rate) {
      this.playing = true;
      this.rate = rate;
      this.vt = raw;
      this.perf = p;
      this.lastRaw = raw;
      this.raw = raw;
      this.fresh = !held;
      this.epoch++;
      return;
    }

    if (raw !== this.lastRaw) {
      const predicted = this.now(p);
      const err = raw - predicted;
      if (Math.abs(err) > 0.3) {
        this.vt = raw;
        this.epoch++;
      } else {
        this.vt = predicted + err * 0.5;
      }
      this.perf = p;
      this.lastRaw = raw;
      this.raw = raw;
      this.fresh = !held;
    }
  },

  play() {
    this.pauseHold = 0;
    if (this.hasVideo()) {
      try {
        if (this.parked !== null) {
          const t = this.parked;
          this.parked = null;
          ytPlayer.seekTo(t, true);
          this.seekHold = { t, until: performance.now() + 800 };
        }
        ytPlayer.playVideo();
      } catch { /* player gone */ }
      return;
    }
    if (ytPlayer || this.playing) return;   // a player that is still loading plays once ready
    if (this.vt >= timelineDuration() - 0.05) this.vt = 0;
    this.perf = performance.now();
    this.rate = this.internalRate;
    this.playing = true;
    this.epoch++;
  },

  pause() {
    this.rangeEnd = null;
    if (this.playing) {
      this.vt = this.now();
      this.perf = performance.now();
      this.playing = false;
      this.epoch++;
    }
    if (this.hasVideo()) {
      this.pauseHold = performance.now() + 500;
      try { ytPlayer.pauseVideo(); } catch { /* player gone */ }
    }
  },

  toggle() {
    const buffering = this.hasVideo() && this.ytState === 3 && performance.now() >= this.pauseHold;
    if (this.playing || buffering) this.pause();
    else this.play();
  },

  seek(t, play = false) {
    t = clamp(t, 0, Math.max(0, timelineDuration()));
    this.rangeEnd = null;
    this.vt = t;
    this.perf = performance.now();
    this.epoch++;
    if (this.hasVideo()) {
      // Seeking a video that hasn't started (or has ended) makes YouTube play
      // it, so just park the playhead until it does play.
      if (!play && this.notStarted()) {
        this.park(t);
        return;
      }
      const wasPlaying = this.playing || this.ytState === 1;
      this.parked = null;
      this.seekHold = { t, until: performance.now() + 800 };
      try {
        ytPlayer.seekTo(t, true);
        if (play) {
          this.pauseHold = 0;
          ytPlayer.playVideo();
        } else if (!wasPlaying) {
          this.holdStill();
        }
      } catch { /* player gone */ }
    } else if (ytPlayer || state.videoId) {
      // The player is still loading: it picks this up when it's ready.
      pendingSeek = t;
      pendingPlay = play;
    } else if (play && !this.playing) {
      this.play();
    }
  },

  /** Unstarted, cued or ended: states where a seek would start playback. */
  notStarted() {
    let st = this.ytState;
    try { st = ytPlayer.getPlayerState(); } catch { /* use the last one */ }
    return st === -1 || st === 5 || st === 0;
  },

  park(t) {
    this.parked = t;
    this.vt = t;
    this.perf = performance.now();
    this.seekHold = null;
    this.epoch++;
  },

  /** A seek from paused can bounce into play on some players; pause it back. */
  holdStill() {
    this.pauseHold = performance.now() + 500;
    try { ytPlayer.pauseVideo(); } catch { /* player gone */ }
  },

  /** Drag-scrubbing: cheap seeks while moving, an exact one on release. */
  scrub(t, final) {
    t = clamp(t, 0, Math.max(0, timelineDuration()));
    this.vt = t;
    this.perf = performance.now();
    this.epoch++;
    if (this.hasVideo()) {
      if (this.notStarted()) { this.park(t); return; }
      this.parked = null;
      const wasPlaying = this.playing || this.ytState === 1;
      this.seekHold = { t, until: performance.now() + 800 };
      try {
        ytPlayer.seekTo(t, !!final);
        if (!wasPlaying) this.holdStill();
      } catch { /* player gone */ }
    }
  },

  /** Ask for a playback speed; returns the speed the player can actually do. */
  setRate(r) {
    if (this.hasVideo()) {
      let best = 1;
      try {
        const rates = ytPlayer.getAvailablePlaybackRates?.() || [1];
        best = rates.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 1);
        ytPlayer.setPlaybackRate(best);
      } catch { /* keep 1× */ }
      return best;
    }
    if (this.playing) {
      this.vt = this.now();
      this.perf = performance.now();
    }
    this.internalRate = r;
    this.rate = r;
    this.epoch++;
    return r;
  },

  playRange(start, end) {
    this.seek(start, true);
    this.rangeEnd = end;
  },
};

/**
 * The original's level as the YouTube player has it: 0 when muted, null
 * without a player. Only the Mix slider ever changes it, because you moved it.
 */
function originalVolume() {
  if (!transport.hasVideo()) return null;
  try { return ytPlayer.isMuted() ? 0 : Math.round(ytPlayer.getVolume()); } catch { return null; }
}

function setOriginalVolume(v) {
  if (!transport.hasVideo()) return;
  try {
    v = clamp(Math.round(v), 0, 100);
    if (v === 0) {
      ytPlayer.mute();
    } else {
      ytPlayer.setVolume(v);
      if (ytPlayer.isMuted()) ytPlayer.unMute();
    }
  } catch { /* player gone */ }
}

/** Called by app.js when the YouTube player is ready. */
function onPlayerReady() {
  showMix();
}

// ─────────────────────────────────────────────
// MICROPHONE + METER
// ─────────────────────────────────────────────

async function refreshMicList() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    el.micSelect.innerHTML = '<option value="">Audio not supported</option>';
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    el.micSelect.innerHTML = '';
    if (!mics.length) {
      el.micSelect.innerHTML = '<option value="">No microphones</option>';
      return;
    }
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      el.micSelect.appendChild(opt);
    });
    if (state.selectedMicId && mics.some(m => m.deviceId === state.selectedMicId)) {
      el.micSelect.value = state.selectedMicId;
    } else {
      state.selectedMicId = mics[0].deviceId;
      localStorage.setItem('selected_mic', state.selectedMicId);
    }
  } catch (e) {
    console.error('enumerateDevices failed:', e);
  }
}

function inputOptions() {
  return {
    deviceId: state.selectedMicId,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    channel: settings.inputChannel,
    monitor: settings.monitor,
  };
}

async function armInput() {
  await AudioEngine.arm(inputOptions());
  sd.meter.classList.add('armed');
  sd.meter.setAttribute('aria-pressed', 'true');
  const label = AudioEngine.deviceLabel();
  sd.meter.title = `${label || 'Microphone'} is open — click to close it`;
  refreshMicList().catch(() => {});
}

function disarmInput() {
  if (session || !AudioEngine.disarm()) return;
  sd.meter.classList.remove('armed', 'clipped');
  sd.meter.setAttribute('aria-pressed', 'false');
  sd.meter.title = 'Check your input level (opens the microphone)';
}

/** Re-open the microphone after its settings change, if it is open. */
function rearmIfArmed() {
  if (!AudioEngine.isArmed() || session) return;
  armInput().catch(e => showToast(micErrorMessage(e), 'error'));
}

function micErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':  return 'Microphone access is blocked. Allow it from the icon in the address bar, then try again.';
    case 'NotFoundError':    return 'No microphone found. Plug one in and try again.';
    case 'NotReadableError': return 'The microphone is busy in another app. Close that app and try again.';
    default:                 return `Microphone: ${e?.message || e}`;
  }
}

const meterUI = { level: 0, hold: 0, holdAt: 0, clipAt: 0, last: 0, shownLevel: -1, shownHold: -1 };
const dbFrac = v => (v <= 0.001 ? 0 : clamp((20 * Math.log10(v) + 60) / 60, 0, 1));

function updateMeter(p) {
  const dt = meterUI.last ? (p - meterUI.last) / 1000 : 0;
  meterUI.last = p;
  const fresh = AudioEngine.isArmed() && p - AudioEngine.meter.at < 250;
  const target = fresh ? dbFrac(AudioEngine.meter.peak) : 0;

  // Instant attack, a steady fall, and a peak that holds for a moment.
  meterUI.level = target >= meterUI.level ? target : Math.max(target, meterUI.level - dt * 0.75);
  if (target >= meterUI.hold || p - meterUI.holdAt > 1500) {
    meterUI.hold = target;
    meterUI.holdAt = p;
  }
  if (fresh && AudioEngine.meter.peak >= 0.985) meterUI.clipAt = p;

  if (Math.abs(meterUI.level - meterUI.shownLevel) > 0.004) {
    sd.meterCover.style.transform = `scaleX(${(1 - meterUI.level).toFixed(3)})`;
    meterUI.shownLevel = meterUI.level;
  }
  if (Math.abs(meterUI.hold - meterUI.shownHold) > 0.004) {
    sd.meterPeak.style.left = `${(meterUI.hold * 100).toFixed(1)}%`;
    sd.meterPeak.style.opacity = meterUI.hold > 0.02 ? '1' : '0';
    meterUI.shownHold = meterUI.hold;
  }
  sd.meter.classList.toggle('clipped', p - meterUI.clipAt < 2000);
}

// ─────────────────────────────────────────────
// SESSIONS — rehearse, record a line, record from here
// ─────────────────────────────────────────────

let session = null;

/**
 * mode: 'line'     — one caption, with pre-roll and post-roll
 *       'flow'     — from this caption on, continuously, until stopped
 *       'rehearse' — like 'line' with the prompter and video, but no recording
 */
async function startSession(mode, idx) {
  if (session || studio.starting) return;
  const cap = state.captions[idx];
  if (!cap) {
    showToast('Select a caption first', 'info');
    return;
  }
  if (studio.chainTimer) { clearTimeout(studio.chainTimer); studio.chainTimer = null; }

  const recording = mode !== 'rehearse';
  studio.starting = true;
  try {
    exitEditMode();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    stopSolo();
    transport.pause();
    await AudioEngine.resume();
    if (recording) await armInput();
  } catch (e) {
    studio.starting = false;
    showToast(micErrorMessage(e), 'error');
    return;
  }
  studio.starting = false;

  const caps = state.captions;
  const lastIdx = mode === 'flow' ? caps.length - 1 : idx;
  session = {
    mode,
    recording,
    startIdx: idx,
    lastIdx,
    cueVt: cap.startTime,
    startVt: Math.max(0, cap.startTime - settings.preRoll),
    stopVt: caps[lastIdx].endTime + settings.postRoll,
    log: [],
    reached: new Set(),
    reachNext: idx,
    beeps: [],
    beeped: new Set(),
    started: false,
    createdAt: performance.now(),
    finishing: false,
    rate: 1,
    display: null,
    livePeaks: null,
  };
  state.isRecording = true;
  setSessionUI(session);

  transport.setRate(settings.pace);
  transport.seek(session.startVt, true);

  if (recording) {
    try {
      const peaks = new PeakBuilder(AudioEngine.sampleRate());
      session.livePeaks = peaks;
      AudioEngine.startCapture(data => peaks.push(data));
    } catch (e) {
      abortSession(micErrorMessage(e));
      return;
    }
  }

  selectRow(idx);
  scrollRowToCenter(idx);
  prompterOpen(session);
  renderTimeline();
  rythmo.dirty = true;
}

function sessionTick(p) {
  const s = session;
  if (!s || s.finishing) return;
  const playing = transport.isPlaying();
  const vt = transport.now(p);

  if (!s.started) {
    if (playing) {
      s.started = true;
      s.rate = transport.rate || 1;
    } else {
      if (p - s.createdAt > 10000) {
        abortSession('The video didn’t start. Press play on the video once, then try again.');
        return;
      }
      prompterUpdate(s, vt);
      updateRecStatus(s, vt);
      return;
    }
  }

  // Pair "this sample of the take" with "this moment of the video".
  if (s.recording && playing) {
    if (transport.hasVideo()) {
      if (transport.fresh) s.log.push({ c: AudioEngine.captureTimeAt(p, settings.latencyMs), vt: transport.raw });
    } else {
      s.log.push({ c: AudioEngine.captureTimeAt(p, settings.latencyMs), vt });
    }
  }

  // ADR beeps at −3, −2, −1 s. Each is scheduled just before it is due, from
  // the latest clock, so it lands on time even if the video was slow to start.
  if (settings.beeps && playing) {
    for (const k of [3, 2, 1]) {
      const bt = s.cueVt - k;
      if (s.beeped.has(k) || bt < s.startVt + 0.05) continue;
      const lead = bt - vt;
      if (lead > 0.35) continue;
      s.beeped.add(k);
      if (lead < -0.05) continue;
      const at = AudioEngine.outputTimeAt(p + (lead / (transport.rate || 1)) * 1000);
      s.beeps.push(AudioEngine.beep(at));
    }
  }

  if (playing) {
    const caps = state.captions;
    while (s.reachNext <= s.lastIdx && caps[s.reachNext].startTime <= vt) {
      s.reached.add(s.reachNext);
      s.reachNext++;
    }
  }

  prompterUpdate(s, vt);
  updateRecStatus(s, vt);

  const ended = transport.hasVideo() && transport.ytState === 0;
  if (vt >= s.stopVt || ended) finishSession(false);
}

async function finishSession(userStopped) {
  const s = session;
  if (!s || s.finishing) return;
  s.finishing = true;
  s.beeps.forEach(b => b.stop());
  transport.pause();
  transport.setRate(1);
  prompterClose(s);

  const result = s.recording ? await AudioEngine.stopCapture() : null;
  session = null;
  state.isRecording = false;
  setSessionUI(null);
  renderTimeline();
  rythmo.dirty = true;

  if (!s.recording) return;
  if (!s.started || !result) {
    showToast('Nothing was recorded', 'info');
    return;
  }

  let created = [];
  try {
    created = await commitTake(s, result);
  } catch (err) {
    console.error('commitTake failed', err);
    showToast(`Couldn’t keep that take: ${err.message}`, 'error');
    return;
  }
  if (!created.length || s.mode !== 'line') return;

  // Park the playhead where the next thing happens, so the band, the video
  // and the timeline are already showing it.
  const next = s.startIdx + 1 < state.captions.length ? s.startIdx + 1 : null;
  const after = settings.afterTake;
  if (after === 'loop' && !userStopped) {
    cueCaption(s.startIdx);
    studio.chainTimer = setTimeout(() => { studio.chainTimer = null; startSession('line', s.startIdx); }, 600);
  } else if (after === 'chain' && !userStopped && next !== null) {
    cueCaption(next);
    studio.chainTimer = setTimeout(() => { studio.chainTimer = null; startSession('line', next); }, 600);
  } else if ((after === 'next' || after === 'chain') && next !== null) {
    cueCaption(next);
  } else {
    cueCaption(s.startIdx);
  }
}

/**
 * Select a caption and park the playhead on its start (left alone while
 * something is playing), so the video frame, band and timeline all show it.
 */
function cueCaption(i, { center = true } = {}) {
  if (i === null || i < 0 || i >= state.captions.length) return;
  selectRow(i);
  if (center) scrollRowToCenter(i);
  else rowEl(i)?.scrollIntoView({ block: 'nearest' });
  if (!transport.isPlaying() && !session) transport.seek(state.captions[i].startTime);
}

/** End the session without keeping anything. */
function abortSession(message) {
  const s = session;
  if (!s) return;
  s.finishing = true;
  s.beeps.forEach(b => b.stop());
  AudioEngine.abortCapture();
  transport.pause();
  transport.setRate(1);
  prompterClose(s);
  session = null;
  state.isRecording = false;
  setSessionUI(null);
  renderTimeline();
  if (message) showToast(message, 'error');
}

/** Stop button, Esc and Space. Keeps the take. */
function stopSession() {
  if (studio.chainTimer) {
    clearTimeout(studio.chainTimer);
    studio.chainTimer = null;
    showToast('Stopped', 'info');
  }
  if (session) finishSession(true);
}

// ─────────────────────────────────────────────
// PLACING A TAKE
// ─────────────────────────────────────────────

/**
 * Least-squares line through (video time → take time) points, refitted
 * without outliers. b is take seconds per video second: 1/rate.
 */
function linearFit(pts, rate) {
  const fit = list => {
    const n = list.length;
    if (n === 1) return { a: list[0].t - list[0].vt / rate, b: 1 / rate };
    let mv = 0, mt = 0;
    for (const p of list) { mv += p.vt; mt += p.t; }
    mv /= n;
    mt /= n;
    let svv = 0, svt = 0;
    for (const p of list) {
      const dv = p.vt - mv;
      svv += dv * dv;
      svt += dv * (p.t - mt);
    }
    let b = svv > 1e-6 ? svt / svv : 1 / rate;
    if (!(b > 0.85 / rate && b < 1.18 / rate)) b = 1 / rate;
    return { a: mt - b * mv, b };
  };
  let f = fit(pts);
  if (pts.length > 8) {
    const res = pts.map(p => Math.abs(p.t - (f.a + f.b * p.vt)));
    const sorted = [...res].sort((x, y) => x - y);
    const limit = Math.max(0.03, sorted[Math.floor(sorted.length * 0.8)] * 2.5);
    const kept = pts.filter((_, i) => res[i] <= limit);
    if (kept.length >= 4) f = fit(kept);
  }
  return { ...f, vtMin: pts[0].vt, vtMax: pts[pts.length - 1].vt, n: pts.length };
}

/** Split the log wherever the video jumped or stalled, and fit each run. */
function fitRuns(points, rate) {
  const runs = [];
  let cur = [];
  for (const pt of points) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const dt = pt.t - prev.t;
      const dv = pt.vt - prev.vt;
      if (dt <= 0 || dv < -0.001 || Math.abs(dv - dt * rate) > 0.25 + 0.02 * dt) {
        runs.push(cur);
        cur = [];
      }
    }
    cur.push(pt);
  }
  if (cur.length) runs.push(cur);
  return runs.map(r => linearFit(r, rate));
}

function runFor(runs, v) {
  let best = null;
  let bestDist = Infinity;
  for (const r of runs) {
    const d = v < r.vtMin ? r.vtMin - v : v > r.vtMax ? v - r.vtMax : 0;
    if (d < bestDist || (d === bestDist && best && r.n > best.n)) {
      best = r;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The stretch of timeline a caption's clip covers. Neighbours recorded in the
 * same take meet in the middle of the gap, so the take still plays through
 * seamlessly; elsewhere the clip keeps a little room before and after the line.
 */
function clipRegion(i, sameTake) {
  const caps = state.captions;
  const cap = caps[i];
  const prev = caps[i - 1];
  const next = caps[i + 1];
  const joinable = gap => gap <= LEAD.max + TAIL.max;
  const boundary = (a, b) => (a.endTime <= b.startTime ? (a.endTime + b.startTime) / 2 : b.startTime);

  let L, R;
  if (prev && sameTake.has(i - 1) && joinable(cap.startTime - prev.endTime)) {
    L = boundary(prev, cap);
  } else {
    const gap = prev ? cap.startTime - prev.endTime : Infinity;
    L = cap.startTime - clamp(gap / 2, LEAD.min, LEAD.max);
  }
  if (next && sameTake.has(i + 1) && joinable(next.startTime - cap.endTime)) {
    R = boundary(cap, next);
  } else {
    const gap = next ? next.startTime - cap.endTime : Infinity;
    R = cap.endTime + clamp(gap / 2, TAIL.min, TAIL.max);
  }
  return [Math.max(0, L), R];
}

async function commitTake(s, result) {
  const { sampleRate: sr, startTime } = result;
  let data = result.data;
  const rate = s.rate || 1;

  let pts = s.log
    .map(e => ({ t: e.c - startTime, vt: e.vt }))
    .filter(e => e.t >= 0 && e.t <= data.length / sr + 0.5);
  if (pts.length < 2) {
    showToast('That take was too short to place — try again', 'error');
    return [];
  }

  let runs = fitRuns(pts, rate);

  // Recorded slower than real time: speed the take back up, keeping pitch.
  if (Math.abs(rate - 1) > 0.01) {
    showToast(`Speeding the take up to 1× (from ${rate}×)…`, 'info');
    data = await DSP.stretch(data, rate, sr);
    runs = runs.map(r => ({ ...r, a: r.a * rate, b: r.b * rate }));
  }

  const indices = s.mode === 'line' ? [s.startIdx] : [...s.reached].sort((a, b) => a - b);
  if (!indices.length) {
    showToast('Stopped before the first line — nothing kept', 'info');
    return [];
  }

  const take = addTake(data, sr);
  const sameTake = new Set(indices);
  const dur = take.duration;
  const made = [];
  pushUndo();

  for (const i of indices) {
    const cap = state.captions[i];
    const run = runFor(runs, cap.startTime);
    if (!run) continue;
    const offset = cap.startTime - (run.a + run.b * cap.startTime);
    const [L, R] = clipRegion(i, sameTake);
    const inn = clamp(L - offset, 0, dur);
    const out = clamp(R - offset, 0, dur);
    if (out - inn < 0.05) continue;
    const clip = {
      id: uid('c'), takeId: take.id, capIdx: i,
      offset, origOffset: offset, in: inn, out,
      gain: 0, active: true, createdAt: Date.now() + made.length,
    };
    addClip(clip);
    if (settings.autoAlign) alignClip(clip, true);
    made.push(clip);
  }

  if (!made.length) {
    editHistory.undo.pop();
    updateUndoButtons();
    showToast('Nothing usable in that take', 'error');
    return [];
  }

  clipsChanged(made.map(c => c.capIdx));
  if (s.mode === 'line') {
    const cap = state.captions[s.startIdx];
    const n = takesFor(s.startIdx).length;
    showToast(n > 1 ? `Take ${n} of #${cap.index} saved — [ ] switches takes` : `#${cap.index} recorded`, 'success');
  } else {
    const a = state.captions[made[0].capIdx].index;
    const b = state.captions[made[made.length - 1].capIdx].index;
    showToast(`Recorded ${made.length} line${made.length === 1 ? '' : 's'} (#${a}–#${b})`, 'success');
  }
  return made;
}

// ─────────────────────────────────────────────
// DUB PLAYBACK — in sync with the video
// ─────────────────────────────────────────────

const dubPlayer = {
  nodes: new Map(),   // clip id → { src, g } scheduled in this epoch (null: done)
  epoch: -1,
  bus: null,
  solo: null,

  ensureBus() {
    const c = AudioEngine.context();
    if (!this.bus) {
      this.bus = c.createGain();
      this.bus.connect(c.destination);
    }
    this.bus.gain.value = settings.dubVolume / 100;
    return this.bus;
  },

  reset() {
    for (const n of this.nodes.values()) fadeOutNode(n);
    this.nodes.clear();
  },

  tick(p) {
    const want = transport.isPlaying() && !session && settings.dubVolume > 0 && studio.clips.length > 0;
    if (!want) {
      if (this.nodes.size) this.reset();
      this.epoch = transport.epoch;
      return;
    }
    if (this.epoch !== transport.epoch) {
      this.reset();
      this.epoch = transport.epoch;
    }
    let c;
    try { c = AudioEngine.context(); } catch { return; }
    if (c.state !== 'running') { AudioEngine.resume(); return; }

    const rate = transport.rate || 1;
    const vt = transport.now(p);
    const horizon = vt + 0.6 * rate;
    const bus = this.ensureBus();

    for (const clip of activeClips()) {
      const s0 = clipStart(clip);
      if (s0 > horizon) break;
      const e0 = clipEnd(clip);
      if (e0 <= vt + 0.01 || this.nodes.has(clip.id)) continue;
      const take = studio.takes.get(clip.takeId);
      if (!take) continue;

      const s = Math.max(vt, s0);
      let when = AudioEngine.outputTimeAt(p + ((s - vt) / rate) * 1000);
      let offset = clip.in + (s - s0);
      let dur = e0 - s;
      const now = c.currentTime + 0.005;
      if (when < now) {
        const late = (now - when) * rate;
        offset += late;
        dur -= late;
        when = now;
      }
      if (dur <= 0.01) { this.nodes.set(clip.id, null); continue; }

      const src = c.createBufferSource();
      src.buffer = takeBuffer(take);
      src.playbackRate.value = rate;
      const g = c.createGain();
      const gain = dbToGain(clip.gain);
      const span = dur / rate;
      const fadeIn = offset - clip.in < FADE ? FADE : 0.002;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(gain, when + fadeIn);
      g.gain.setValueAtTime(gain, Math.max(when + fadeIn, when + span - FADE));
      g.gain.linearRampToValueAtTime(0, when + span);
      src.connect(g);
      g.connect(bus);
      src.start(when, offset, dur);
      this.nodes.set(clip.id, { src, g });
    }
  },
};

function fadeOutNode(n) {
  if (!n) return;
  try {
    const t = AudioEngine.context().currentTime;
    n.g.gain.cancelScheduledValues(t);
    n.g.gain.setTargetAtTime(0, t, 0.006);
    n.src.stop(t + 0.04);
  } catch { /* already stopped */ }
}

/** Listen to one line's dub on its own (the speaker button). */
function soloToggle(idx) {
  if (dubPlayer.solo && dubPlayer.solo.idx === idx) { stopSolo(); return; }
  stopSolo();
  const clip = activeClipFor(idx);
  const take = clip && studio.takes.get(clip.takeId);
  if (!take) return;
  transport.pause();
  AudioEngine.resume().then(() => {
    const c = AudioEngine.context();
    const src = c.createBufferSource();
    src.buffer = takeBuffer(take);
    const g = c.createGain();
    const gain = dbToGain(clip.gain);
    const when = c.currentTime + 0.03;
    const span = clip.out - clip.in;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + FADE);
    g.gain.setValueAtTime(gain, when + span - FADE);
    g.gain.linearRampToValueAtTime(0, when + span);
    src.connect(g);
    g.connect(c.destination);
    src.start(when, clip.in, span);
    dubPlayer.solo = { idx, clip, src, g, when };
    src.onended = () => { if (dubPlayer.solo?.src === src) stopSolo(); };
    rowEl(idx)?.querySelector('.listen-btn')?.classList.add('playing');
    showTeleprompter(idx);
  });
}

function stopSolo() {
  const s = dubPlayer.solo;
  if (!s) return;
  dubPlayer.solo = null;
  fadeOutNode(s);
  rowEl(s.idx)?.querySelector('.listen-btn')?.classList.remove('playing');
  if (!session || prompter.rowIdx !== s.idx) hideTeleprompter(s.idx);
}

function soloFrame() {
  const s = dubPlayer.solo;
  if (!s) return;
  const cap = state.captions[s.idx];
  const vt = clipStart(s.clip) + (AudioEngine.context().currentTime - s.when);
  const plan = wordPlan(cap.hinglish);
  const progress = (vt - cap.startTime) / Math.max(0.05, cap.endTime - cap.startTime);
  setRowWords(s.idx, activeWordIndex(plan, progress));
}

// ─────────────────────────────────────────────
// EDITING — undo, takes, nudge, align, fit, gain
// ─────────────────────────────────────────────

const editHistory = { undo: [], redo: [], tag: null, at: 0 };

const snapshotClips = () => JSON.stringify(studio.clips);

/** Remember the clips before a change. Repeated tagged changes coalesce. */
function pushUndo(tag = null) {
  const now = performance.now();
  if (tag && tag === editHistory.tag && now - editHistory.at < 1500) {
    editHistory.at = now;
    return;
  }
  pushUndoSnapshot(snapshotClips(), tag);
}

function pushUndoSnapshot(snap, tag = null) {
  editHistory.undo.push(snap);
  if (editHistory.undo.length > 200) editHistory.undo.shift();
  editHistory.redo.length = 0;
  editHistory.tag = tag;
  editHistory.at = performance.now();
  updateUndoButtons();
}

function undo() {
  if (session) return;
  if (!editHistory.undo.length) { showToast('Nothing to undo', 'info'); return; }
  editHistory.redo.push(snapshotClips());
  studio.clips = JSON.parse(editHistory.undo.pop());
  editHistory.tag = null;
  clipsChanged('all');
  showToast('Undone', 'info');
}

function redo() {
  if (session) return;
  if (!editHistory.redo.length) { showToast('Nothing to redo', 'info'); return; }
  editHistory.undo.push(snapshotClips());
  studio.clips = JSON.parse(editHistory.redo.pop());
  editHistory.tag = null;
  clipsChanged('all');
  showToast('Redone', 'info');
}

function updateUndoButtons() {
  if (!sd.undoBtn) return;
  sd.undoBtn.disabled = !editHistory.undo.length || !!session;
  sd.redoBtn.disabled = !editHistory.redo.length || !!session;
}

function selectedClip() {
  return state.selectedRow !== null ? activeClipFor(state.selectedRow) : null;
}

function requireClip() {
  if (session) return null;
  const c = selectedClip();
  if (!c) showToast(state.selectedRow === null ? 'Select a caption first' : 'This line has no recording yet', 'info');
  return c;
}

function nudgeSelected(delta) {
  const c = requireClip();
  if (!c) return;
  pushUndo(`nudge:${c.id}`);
  c.offset += delta;
  clipsChanged([c.capIdx]);
}

function cycleTake(i, dir) {
  if (session || i === null) return;
  const list = takesFor(i);
  if (list.length < 2) {
    showToast(list.length ? 'This line has only one take' : 'This line has no recording yet', 'info');
    return;
  }
  const cur = activeClipFor(i);
  const k = (list.indexOf(cur) + dir + list.length) % list.length;
  pushUndo();
  list.forEach(c => { c.active = false; });
  list[k].active = true;
  clipsChanged([i]);
  showToast(`Take ${k + 1} of ${list.length}`, 'info');
}

function deleteSelectedClip() {
  const c = requireClip();
  if (!c) return;
  const i = c.capIdx;
  pushUndo();
  studio.clips = studio.clips.filter(x => x !== c);
  invalidateClips();
  const rest = takesFor(i);
  if (rest.length) rest[rest.length - 1].active = true;
  clipsChanged([i]);
  showToast(rest.length ? `Take deleted — now using take ${rest.length}` : 'Recording deleted — Ctrl+Z brings it back', 'info');
}

function setClipGain(c, db) {
  pushUndo(`gain:${c.id}`);
  c.gain = Math.round(clamp(db, -24, 24) * 10) / 10;
  clipsChanged([c.capIdx]);
}

function resetClip(c) {
  if (Math.abs(c.offset - c.origOffset) < 1e-6) { showToast('Already where it was recorded', 'info'); return; }
  pushUndo();
  c.offset = c.origOffset;
  clipsChanged([c.capIdx]);
}

/** Take seconds to search for a clip's speech, clear of the previous line. */
function speechWindow(c) {
  const take = studio.takes.get(c.takeId);
  const prev = activeClipFor(c.capIdx - 1);
  const room = prev && prev.takeId === c.takeId ? 0 : 0.4;
  return [Math.max(0, c.in - room), Math.min(take.duration, c.out)];
}

const onsetCache = new Map();

/** Speech onset inside a clip, in take seconds (cached). */
function clipOnset(c) {
  const take = studio.takes.get(c.takeId);
  if (!take) return null;
  const key = `${c.takeId}:${c.in.toFixed(4)}:${c.out.toFixed(4)}`;
  if (!onsetCache.has(key)) {
    const sp = DSP.speech(take.data, take.sampleRate, c.in, c.out);
    if (onsetCache.size > 500) onsetCache.clear();
    onsetCache.set(key, sp ? sp.on : null);
  }
  return onsetCache.get(key);
}

/** Move a clip so its speech starts exactly on the caption. */
function alignClip(c, quiet = false) {
  const take = studio.takes.get(c.takeId);
  const cap = state.captions[c.capIdx];
  if (!take || !cap) return false;
  const [lo, hi] = speechWindow(c);
  const sp = DSP.speech(take.data, take.sampleRate, lo, hi);
  if (!sp) {
    if (!quiet) showToast('No speech found in this take', 'error');
    return false;
  }
  const shift = cap.startTime - (c.offset + sp.on);
  if (!quiet && Math.abs(shift) < 0.004) {
    showToast('Already aligned to the caption', 'info');
    return false;
  }
  if (!quiet) pushUndo();
  c.offset += shift;
  if (sp.on < c.in + 0.04) c.in = Math.max(0, sp.on - 0.08);
  if (!quiet) {
    clipsChanged([c.capIdx]);
    showToast(`Aligned #${cap.index} (${fmtMs(shift)})`, 'success');
  }
  return true;
}

function alignSelected() {
  const c = requireClip();
  if (c) alignClip(c);
}

/** Time-stretch a clip's speech to the caption's length, keeping pitch. */
async function fitSelected() {
  const c = requireClip();
  if (!c || studio.busy) return;
  const take = studio.takes.get(c.takeId);
  const cap = state.captions[c.capIdx];
  const sp = DSP.speech(take.data, take.sampleRate, c.in, c.out);
  if (!sp) { showToast('No speech found in this take', 'error'); return; }

  const target = cap.endTime - cap.startTime;
  const factor = target / Math.max(0.05, sp.off - sp.on);
  if (Math.abs(factor - 1) < 0.015) {
    showToast('This take already fits the caption', 'info');
    return;
  }
  const applied = clamp(factor, 0.7, 1.4);
  studio.busy = true;
  showToast(`Fitting #${cap.index}…`, 'info');
  try {
    const sr = take.sampleRate;
    const src = take.data.subarray(Math.round(c.in * sr), Math.round(c.out * sr));
    const out = await DSP.stretch(src, applied, sr);
    if (!studio.clips.includes(c)) return;   // undone meanwhile
    const fitted = addTake(out, sr, { derivedFrom: take.id });
    pushUndo();
    c.takeId = fitted.id;
    c.offset = cap.startTime - (sp.on - c.in) * applied;
    c.origOffset = c.offset;
    c.in = 0;
    c.out = fitted.duration;
    c.fit = Math.round((c.fit || 1) * applied * 1000) / 1000;
    clipsChanged([c.capIdx]);
    const speed = Math.round(100 / applied);
    showToast(applied !== factor
      ? `Fitted as far as it sounds natural (${speed}% speed) — it still runs ${factor < 1 ? 'long' : 'short'}`
      : `Fitted #${cap.index} to the caption (${speed}% speed)`, applied !== factor ? 'info' : 'success');
  } catch (e) {
    showToast(`Couldn’t fit the take: ${e.message}`, 'error');
  } finally {
    studio.busy = false;
  }
}

function auditionClip(c) {
  if (session) return;
  stopSolo();
  transport.playRange(Math.max(0, clipStart(c) - 0.4), clipEnd(c) + 0.3);
}

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

/** Add a clip's audio into dst (which starts at timeline time dstStart). */
function mixClip(dst, clip, sr, dstStart = 0) {
  const take = studio.takes.get(clip.takeId);
  if (!take) return;
  const src = take.data;
  const ratio = take.sampleRate / sr;
  const gain = dbToGain(clip.gain);
  const n = Math.round((clip.out - clip.in) * sr);
  const start = Math.round((clipStart(clip) - dstStart) * sr);
  const fade = Math.max(1, Math.round(FADE * sr));
  const s0 = clip.in * take.sampleRate;
  for (let k = 0; k < n; k++) {
    const d = start + k;
    if (d < 0) continue;
    if (d >= dst.length) break;
    const pos = s0 + k * ratio;
    const i = Math.floor(pos);
    if (i >= src.length) break;
    const f = pos - i;
    const v = f ? src[i] + (src[Math.min(i + 1, src.length - 1)] - src[i]) * f : src[i];
    let env = gain;
    if (k < fade) env *= k / fade;
    else if (n - k < fade) env *= (n - k) / fade;
    dst[d] += v * env;
  }
}

async function saveBlob(blob, name, description, accept) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      showToast(`Saved ${handle.name}`, 'success');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('Save picker unavailable, downloading instead', e);
    }
  }
  downloadBlob(blob, name);
  showToast(`Downloaded ${name}`, 'success');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** The whole dub, start to end, exactly as the timeline plays it. */
async function exportFullAudio(format) {
  const clips = activeClips();
  if (!clips.length) { showToast('Nothing recorded yet', 'info'); return; }
  showToast('Rendering the dub…', 'info');
  await nextFrame();

  const sr = studio.takes.get(clips[0].takeId)?.sampleRate || SAMPLE_RATE;
  let end = tl.videoDuration || 0;
  const last = state.captions[state.captions.length - 1];
  if (last) end = Math.max(end, last.endTime);
  for (const c of clips) end = Math.max(end, clipEnd(c));

  const master = new Float32Array(Math.ceil(end * sr) + 1);
  for (const c of clips) mixClip(master, c, sr, 0);
  let peak = 0;
  for (let i = 0; i < master.length; i++) {
    const v = master[i] < 0 ? -master[i] : master[i];
    if (v > peak) peak = v;
  }

  let blob;
  try {
    blob = format === 'mp3' ? DSP.mp3(master, sr) : DSP.wav(master, sr, 24);
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  const name = `${safeFileName(el.videoTitle.textContent)} - dub.${format}`;
  await saveBlob(blob, name,
    format === 'mp3' ? 'MP3 audio' : 'WAV audio',
    format === 'mp3' ? { 'audio/mpeg': ['.mp3'] } : { 'audio/wav': ['.wav'] });
  if (peak > 1) showToast('Exported, but some peaks clipped — lower the gain on the loudest clips', 'error');
}

/** One line, padded with silence from 0:00 so it drops straight onto an editor timeline. */
async function downloadLine(idx) {
  const clip = activeClipFor(idx);
  const take = clip && studio.takes.get(clip.takeId);
  if (!take) return;
  const cap = state.captions[idx];
  showToast('Preparing audio…', 'info');
  await nextFrame();
  const sr = take.sampleRate;
  const buf = new Float32Array(Math.ceil(clipEnd(clip) * sr) + 1);
  mixClip(buf, clip, sr, 0);
  try {
    downloadBlob(DSP.mp3(buf, sr), `Track-${cap.index}.mp3`);
  } catch {
    downloadBlob(DSP.wav(buf, sr, 16), `Track-${cap.index}.wav`);
  }
  showToast(`Line #${cap.index} downloaded`, 'success');
}

// ─────────────────────────────────────────────
// PROJECT STORAGE
// ─────────────────────────────────────────────
//
// IndexedDB holds the project and every take. A copy of the project (no
// audio) also goes to localStorage on every save and when the tab closes,
// because an IndexedDB write can be cut off by a reload.

const PROJECT_KEY = 'project';
const MIRROR_KEY = 'dubdesk_project_mirror';
let saveTimer = null;

function projectSnapshot() {
  return {
    v: 2,
    captions: state.captions.map(c => ({
      index: c.index,
      startTime: c.startTime,
      endTime: c.endTime,
      startTimeStr: c.startTimeStr,
      endTimeStr: c.endTimeStr,
      text: c.text,
      hinglish: c.hinglish || '',
      excludeWords: c.excludeWords || '',
    })),
    videoId: state.videoId,
    title: el.videoTitle.textContent,
    bookmark: state.bookmark,
    clips: studio.clips,
    savedAt: new Date().toISOString(),
  };
}

function writeMirror(project = projectSnapshot()) {
  try { localStorage.setItem(MIRROR_KEY, JSON.stringify(project)); } catch { /* too big or blocked */ }
}

function readMirror() {
  try { return JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null'); } catch { return null; }
}

/** Something in the project changed: save shortly. */
function projectChanged() {
  setSaveStatus('edited');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveProject(), 900);
}

async function saveProject(announce = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const project = projectSnapshot();
  writeMirror(project);
  setSaveStatus('saving');
  try {
    await Promise.all([...pendingTakeWrites]);
    await Store.put(PROJECT_KEY, project);
    setSaveStatus('saved');
    if (announce) showToast('Project saved in this browser', 'success');
  } catch (e) {
    console.error('Saving the project failed', e);
    setSaveStatus('error');
    if (announce) showToast(`Couldn’t save: ${e.message}`, 'error');
  }
}

function setSaveStatus(kind) {
  const node = document.getElementById('save-status');
  if (!node) return;
  const text = { edited: '', saving: 'Saving…', saved: 'Saved', error: 'Not saved' }[kind] ?? '';
  node.textContent = text;
  node.dataset.state = kind;
}

function normaliseCaption(c) {
  return {
    index: c.index,
    startTime: +c.startTime,
    endTime: +c.endTime,
    startTimeStr: c.startTimeStr,
    endTimeStr: c.endTimeStr,
    text: c.text || '',
    hinglish: c.hinglish || '',
    excludeWords: c.excludeWords || '',
    verified: false,
  };
}

function normaliseClip(c) {
  return {
    id: c.id || uid('c'),
    takeId: c.takeId,
    capIdx: c.capIdx,
    offset: +c.offset,
    origOffset: Number.isFinite(+c.origOffset) ? +c.origOffset : +c.offset,
    in: +c.in,
    out: +c.out,
    gain: +c.gain || 0,
    active: !!c.active,
    createdAt: c.createdAt || 0,
    ...(c.fit ? { fit: c.fit } : {}),
  };
}

/**
 * Load the saved project into state.captions and the studio, audio included.
 * Returns the project (for its title, video and bookmark) or null.
 */
async function loadProject() {
  let project = null;
  try { project = await Store.get(PROJECT_KEY); } catch (e) { console.warn('Couldn’t open the saved project', e); }
  const mirror = readMirror();
  if (mirror && Array.isArray(mirror.captions) && (!project || (mirror.savedAt || '') > (project.savedAt || ''))) {
    project = mirror;
  }
  if (!project) {
    // Drafts saved before recordings were stored.
    try {
      const d = JSON.parse(localStorage.getItem('dubdesk_draft') || 'null');
      if (d && Array.isArray(d.captions)) project = { captions: d.captions, videoId: d.videoId, title: d.title, bookmark: d.bookmark, clips: [] };
    } catch { /* unreadable */ }
  }
  if (!project || !Array.isArray(project.captions)) return null;

  state.captions = project.captions.map(normaliseCaption);
  const clips = Array.isArray(project.clips) ? project.clips : [];
  const ids = [...new Set(clips.map(c => c.takeId))];
  let missing = 0;
  for (const id of ids) {
    try {
      const rec = await Store.getTake(id);
      if (rec && rec.data) studio.takes.set(id, makeTake(rec));
      else missing++;
    } catch { missing++; }
  }
  studio.clips = clips
    .filter(c => studio.takes.has(c.takeId) && c.capIdx >= 0 && c.capIdx < state.captions.length)
    .map(normaliseClip);
  ensureActive();
  editHistory.undo.length = 0;
  editHistory.redo.length = 0;
  state.captions.forEach((cap, i) => { cap.verified = !!activeClipFor(i); });

  collectGarbage(new Set(ids));
  if (missing) {
    setTimeout(() => showToast(`${missing} recording${missing === 1 ? '' : 's'} couldn’t be restored from this browser`, 'error'), 1200);
  }
  return project;
}

async function collectGarbage(keep) {
  try {
    const all = await Store.takeIds();
    for (const id of all) if (!keep.has(id) && !studio.takes.has(id)) await Store.deleteTake(id);
  } catch { /* nothing to collect */ }
}

/** A new SRT starts a new project: forget every recording. */
function clearRecordings() {
  stopSolo();
  dubPlayer.reset();
  studio.clips = [];
  studio.takes.clear();
  invalidateClips();
  editHistory.undo.length = 0;
  editHistory.redo.length = 0;
  updateUndoButtons();
  collectGarbage(new Set());
}

/** Drop takes that aren't the active one, and the audio nothing uses. */
async function deleteAlternateTakes() {
  if (session) return;
  const before = studio.takes.size;
  studio.clips = studio.clips.filter(c => c.active);
  const used = new Set(studio.clips.map(c => c.takeId));
  for (const id of [...studio.takes.keys()]) if (!used.has(id)) studio.takes.delete(id);
  editHistory.undo.length = 0;
  editHistory.redo.length = 0;
  clipsChanged('all');
  await collectGarbage(used);
  updateStorageInfo();
  const freed = before - studio.takes.size;
  showToast(freed ? `Deleted ${freed} unused take${freed === 1 ? '' : 's'}` : 'No unused takes to delete', 'success');
}

function updateStorageInfo() {
  const node = document.getElementById('set-storage');
  if (!node) return;
  let bytes = 0;
  for (const t of studio.takes.values()) bytes += t.data.byteLength;
  const used = new Set(studio.clips.filter(c => c.active).map(c => c.takeId));
  const spare = [...studio.takes.keys()].filter(id => !used.has(id)).length;
  const mb = bytes / 1048576;
  node.textContent = `${studio.takes.size} take${studio.takes.size === 1 ? '' : 's'} · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB in this browser` +
    (spare ? ` · ${spare} not in use` : '');
  document.getElementById('set-cleanup').disabled = !spare;
}

// ─────────────────────────────────────────────
// UI — dock, inspector, clip menu, settings
// ─────────────────────────────────────────────

const sd = {};

function bindStudioDom() {
  const $ = id => document.getElementById(id);
  Object.assign(sd, {
    dock: $('record-dock'),
    meter: $('input-meter'),
    meterCover: $('meter-cover'),
    meterPeak: $('meter-peak'),
    rehearseBtn: $('rehearse-btn'),
    recordLineBtn: $('record-line-btn'),
    recStatus: $('rec-status'),
    recLabel: $('rec-status-label'),
    recTime: $('rec-status-time'),
    settingsBtn: $('rec-settings-btn'),
    paceBadge: $('pace-badge'),
    timecode: $('timecode'),
    undoBtn: $('tl-undo'),
    redoBtn: $('tl-redo'),
    snapBtn: $('tl-snap'),
    zoomIn: $('tl-zoom-in'),
    zoomOut: $('tl-zoom-out'),
    fitBtn: $('tl-fit'),
    mixOriginal: $('mix-original'),
    mixOriginalValue: $('mix-original-value'),
    mixDub: $('mix-dub'),
    mixDubValue: $('mix-dub-value'),
    insp: $('clip-inspector'),
    ciTitle: $('ci-title'),
    ciTake: $('ci-take'),
    ciPrev: $('ci-prev-take'),
    ciNext: $('ci-next-take'),
    ciOffset: $('ci-offset'),
    ciGain: $('ci-gain'),
    ciGainDown: $('ci-gain-down'),
    ciGainUp: $('ci-gain-up'),
    ciAlign: $('ci-align'),
    ciFit: $('ci-fit'),
    ciReset: $('ci-reset'),
    ciDelete: $('ci-delete'),
    clipMenu: $('clip-menu'),
    modal: $('rec-settings-modal'),
  });
}

function setSessionUI(s) {
  const busy = !!s;
  sd.dock.classList.toggle('is-busy', busy);
  sd.dock.classList.toggle('is-recording', !!s?.recording);
  sd.dock.classList.toggle('is-rehearsing', busy && !s.recording);
  el.stopRecordingBtn.classList.toggle('hidden', !busy);
  sd.recStatus.classList.toggle('hidden', !busy);
  sd.timecode.classList.toggle('rec', !!s?.recording);
  if (s) {
    sd.recLabel.textContent = 'Cueing';
    sd.recTime.textContent = '';
    if (s) { s.shownLabel = 'Cueing'; s.shownTime = ''; }
  }
  updateButtons();
  updateUndoButtons();
  updateInspector();
  closeClipMenu();
}

function updateRecStatus(s, vt) {
  let label;
  let time = '';
  const cur = s.display !== null ? state.captions[s.display] : null;
  if (!s.started) {
    label = 'Cueing';
  } else if (vt < s.cueVt) {
    label = s.recording ? 'Rec · cue in' : 'Cue in';
    time = `${(s.cueVt - vt).toFixed(1)} s`;
  } else {
    label = (s.recording ? 'REC' : 'Rehearsal') + (cur ? ` #${cur.index}` : '');
    time = fmtClock(vt - s.cueVt);
  }
  if (label !== s.shownLabel) { sd.recLabel.textContent = label; s.shownLabel = label; }
  if (time !== s.shownTime) { sd.recTime.textContent = time; s.shownTime = time; }
}

function updatePaceBadge() {
  const slow = settings.pace !== 1;
  sd.paceBadge.classList.toggle('hidden', !slow);
  sd.paceBadge.textContent = slow ? `${settings.pace}×` : '';
  sd.settingsBtn.title = slow ? `Recording settings — recording at ${settings.pace}× speed` : 'Recording settings';
}

function updateInspector() {
  if (!sd.insp) return;
  const clip = selectedClip();
  sd.insp.classList.toggle('hidden', !clip);
  if (!clip) return;
  const cap = state.captions[clip.capIdx];
  const takes = takesFor(clip.capIdx);
  const k = takes.indexOf(clip) + 1;
  sd.ciTitle.textContent = `#${cap.index}`;
  sd.ciTake.textContent = `Take ${k}/${takes.length}`;
  sd.ciPrev.disabled = sd.ciNext.disabled = takes.length < 2 || !!session;
  sd.ciOffset.textContent = fmtMs(clip.offset - clip.origOffset);
  sd.ciGain.textContent = `${clip.gain > 0 ? '+' : ''}${clip.gain.toFixed(1)} dB`;
  sd.ciReset.disabled = Math.abs(clip.offset - clip.origOffset) < 1e-6 || !!session;
  for (const b of [sd.ciGainDown, sd.ciGainUp, sd.ciAlign, sd.ciFit, sd.ciDelete]) b.disabled = !!session;
  sd.ciFit.title = clip.fit
    ? `Fitted to ${Math.round(100 / clip.fit)}% speed. Fit again (F)`
    : 'Time-stretch the speech to the caption’s length, keeping the pitch (F)';
}

function wireInspector() {
  sd.ciPrev.addEventListener('click', () => cycleTake(state.selectedRow, -1));
  sd.ciNext.addEventListener('click', () => cycleTake(state.selectedRow, 1));
  sd.ciGainDown.addEventListener('click', () => { const c = requireClip(); if (c) setClipGain(c, c.gain - 1); });
  sd.ciGainUp.addEventListener('click', () => { const c = requireClip(); if (c) setClipGain(c, c.gain + 1); });
  sd.ciAlign.addEventListener('click', alignSelected);
  sd.ciFit.addEventListener('click', fitSelected);
  sd.ciReset.addEventListener('click', () => { const c = requireClip(); if (c) resetClip(c); });
  sd.ciDelete.addEventListener('click', deleteSelectedClip);
}

// ── Clip context menu ──
let clipMenuFor = null;

function openClipMenu(clip, x, y) {
  clipMenuFor = clip;
  const m = sd.clipMenu;
  const takes = takesFor(clip.capIdx);
  m.querySelector('[data-action="prev-take"]').disabled = takes.length < 2;
  m.querySelector('[data-action="next-take"]').disabled = takes.length < 2;
  m.querySelector('[data-action="reset"]').disabled = Math.abs(clip.offset - clip.origOffset) < 1e-6;
  m.hidden = false;
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  m.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
  m.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  m.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
}

function closeClipMenu() {
  if (!sd.clipMenu || sd.clipMenu.hidden) return;
  sd.clipMenu.hidden = true;
  clipMenuFor = null;
}

function wireClipMenu() {
  sd.clipMenu.addEventListener('click', e => {
    const item = e.target.closest('[data-action]');
    if (!item || item.disabled) return;
    const clip = clipMenuFor;
    closeClipMenu();
    if (!clip || !studio.clips.includes(clip)) return;
    if (state.selectedRow !== clip.capIdx) selectRow(clip.capIdx);
    switch (item.dataset.action) {
      case 'play':      auditionClip(clip); break;
      case 'align':     alignSelected(); break;
      case 'fit':       fitSelected(); break;
      case 'reset':     resetClip(clip); break;
      case 'prev-take': cycleTake(clip.capIdx, -1); break;
      case 'next-take': cycleTake(clip.capIdx, 1); break;
      case 'download':  downloadLine(clip.capIdx); break;
      case 'delete':    deleteSelectedClip(); break;
    }
  });
  sd.clipMenu.addEventListener('keydown', e => {
    const items = [...sd.clipMenu.querySelectorAll('.menu-item:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeClipMenu(); }
    e.stopPropagation();
  });
  document.addEventListener('pointerdown', e => {
    if (!sd.clipMenu.hidden && !sd.clipMenu.contains(e.target)) closeClipMenu();
  }, true);
  window.addEventListener('blur', closeClipMenu);
}

// ── Mix ──
// "Original" mirrors the YouTube player: mute or change the volume there and
// the slider follows; move the slider and the player follows. Nothing else
// touches it, so recording never turns the video's sound back on.

let mixShownAt = 0;

function showMix() {
  if (!sd.mixOriginal) return;
  const v = originalVolume();
  if (document.activeElement !== sd.mixOriginal) {
    sd.mixOriginal.disabled = v === null;
    sd.mixOriginal.value = v ?? 100;
  }
  sd.mixOriginalValue.textContent = v === null ? '—' : v === 0 ? 'Muted' : String(v);
  sd.mixDub.value = settings.dubVolume;
  sd.mixDubValue.textContent = settings.dubVolume;
}

/** Keep the mirror current while the Mix popover is open. */
function mixFrame(p) {
  if (!sd.mixPop || sd.mixPop.hidden || p - mixShownAt < 250) return;
  mixShownAt = p;
  showMix();
}

function wireMix() {
  sd.mixPop = sd.mixOriginal.closest('.menu-pop');
  sd.mixPop.previousElementSibling?.addEventListener('click', () => setTimeout(showMix, 0));
  showMix();
  sd.mixOriginal.addEventListener('input', () => {
    setOriginalVolume(+sd.mixOriginal.value);
    const v = +sd.mixOriginal.value;
    sd.mixOriginalValue.textContent = v === 0 ? 'Muted' : String(v);
  });
  sd.mixDub.addEventListener('input', () => {
    settings.dubVolume = +sd.mixDub.value;
    sd.mixDubValue.textContent = settings.dubVolume;
    if (dubPlayer.bus) dubPlayer.bus.gain.value = settings.dubVolume / 100;
    saveSettings();
  });
}

// ── Recording settings dialog ──
function wireSettingsModal() {
  const $ = id => document.getElementById(id);
  const f = {
    channel: $('set-channel'), ec: $('set-ec'), ns: $('set-ns'), agc: $('set-agc'), monitor: $('set-monitor'),
    preroll: $('set-preroll'), postroll: $('set-postroll'), beeps: $('set-beeps'), pace: $('set-pace'),
    rythmo: $('set-rythmo'), band: $('set-band'), overlay: $('set-overlay'), after: $('set-after'),
    autoalign: $('set-autoalign'), latency: $('set-latency'), cleanup: $('set-cleanup'),
  };

  const showPace = () => f.pace.querySelectorAll('[data-pace]').forEach(b => {
    b.setAttribute('aria-pressed', String(+b.dataset.pace === settings.pace));
  });

  const fill = () => {
    f.channel.value = String(settings.inputChannel);
    f.ec.checked = settings.echoCancellation;
    f.ns.checked = settings.noiseSuppression;
    f.agc.checked = settings.autoGainControl;
    f.monitor.checked = settings.monitor;
    f.preroll.value = String(settings.preRoll);
    f.postroll.value = String(settings.postRoll);
    f.beeps.checked = settings.beeps;
    f.rythmo.checked = settings.rythmo;
    f.band.value = settings.bandMode;
    f.overlay.checked = settings.overlay;
    f.after.value = settings.afterTake;
    f.autoalign.checked = settings.autoAlign;
    f.latency.value = settings.latencyMs;
    showPace();
    updateStorageInfo();
  };

  const open = () => {
    if (session) { showToast('Stop recording first', 'info'); return; }
    fill();
    sd.modal.classList.remove('hidden');
    $('done-rec-settings').focus();
  };
  const close = () => sd.modal.classList.add('hidden');
  sd.settingsBtn.addEventListener('click', open);
  $('close-rec-settings').addEventListener('click', close);
  $('done-rec-settings').addEventListener('click', close);
  sd.modal.addEventListener('click', e => { if (e.target === sd.modal) close(); });

  const changed = () => { saveSettings(); updatePaceBadge(); };
  const onInput = (node, fn) => node.addEventListener('change', () => { fn(); changed(); });

  onInput(f.channel, () => { settings.inputChannel = +f.channel.value; AudioEngine.setChannel(settings.inputChannel); });
  onInput(f.ec, () => { settings.echoCancellation = f.ec.checked; rearmIfArmed(); });
  onInput(f.ns, () => { settings.noiseSuppression = f.ns.checked; rearmIfArmed(); });
  onInput(f.agc, () => { settings.autoGainControl = f.agc.checked; rearmIfArmed(); });
  onInput(f.monitor, () => { settings.monitor = f.monitor.checked; AudioEngine.setMonitor(settings.monitor); });
  onInput(f.preroll, () => { settings.preRoll = +f.preroll.value; });
  onInput(f.postroll, () => { settings.postRoll = +f.postroll.value; });
  onInput(f.beeps, () => { settings.beeps = f.beeps.checked; });
  onInput(f.rythmo, () => { settings.rythmo = f.rythmo.checked; updateRythmoVisibility(); });
  onInput(f.band, () => { setBandMode(f.band.value); });
  onInput(f.overlay, () => { settings.overlay = f.overlay.checked; });
  onInput(f.after, () => { settings.afterTake = f.after.value; });
  onInput(f.autoalign, () => { settings.autoAlign = f.autoalign.checked; });
  onInput(f.latency, () => {
    const v = clamp(Math.round(+f.latency.value || 0), -500, 500);
    settings.latencyMs = v;
    f.latency.value = v;
  });
  f.pace.addEventListener('click', e => {
    const b = e.target.closest('[data-pace]');
    if (!b) return;
    settings.pace = +b.dataset.pace;
    showPace();
    changed();
  });
  f.cleanup.addEventListener('click', deleteAlternateTakes);
}

function wireTimelineTools() {
  document.getElementById('tp-prev').addEventListener('click', () => stepCaption(-1));
  document.getElementById('tp-next').addEventListener('click', () => stepCaption(1));
  document.getElementById('tp-start').addEventListener('click', () => goToCaptionEdge('start'));
  document.getElementById('tp-end').addEventListener('click', () => goToCaptionEdge('end'));
  sd.undoBtn.addEventListener('click', undo);
  sd.redoBtn.addEventListener('click', redo);
  const showSnap = () => sd.snapBtn.setAttribute('aria-pressed', String(settings.snap));
  showSnap();
  sd.snapBtn.addEventListener('click', () => { settings.snap = !settings.snap; showSnap(); saveSettings(); });
  sd.zoomIn.addEventListener('click', () => zoomTimeline(1.4));
  sd.zoomOut.addEventListener('click', () => zoomTimeline(1 / 1.4));
  sd.fitBtn.addEventListener('click', fitTimeline);
  updateUndoButtons();
}

function wireDock() {
  sd.meter.addEventListener('click', () => {
    if (AudioEngine.isArmed()) disarmInput();
    else armInput().catch(e => showToast(micErrorMessage(e), 'error'));
  });
  sd.rehearseBtn.addEventListener('click', () => startSession('rehearse', state.selectedRow));
  sd.recordLineBtn.addEventListener('click', () => startSession('line', state.selectedRow));
  el.recordAllBtn.addEventListener('click', () => startSession('flow', state.selectedRow));
  el.stopRecordingBtn.addEventListener('click', stopSession);
  el.micSelect.addEventListener('change', e => {
    state.selectedMicId = e.target.value;
    localStorage.setItem('selected_mic', state.selectedMicId);
    rearmIfArmed();
  });
  updatePaceBadge();
}

/** Selection moved in the caption list. */
function onSelectionChanged() {
  updateInspector();
  rythmo.dirty = true;
}

// ─────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────

const FRAME_SEC = 1 / 30;

/** The caption to navigate from: the selected one, else the one at the playhead. */
function navCaption() {
  if (state.selectedRow !== null) return state.selectedRow;
  if (!state.captions.length) return null;
  const t = transport.now();
  const i = state.captions.findIndex(c => c.endTime > t);
  return i === -1 ? state.captions.length - 1 : i;
}

/** I / O: put the playhead on the selected caption's start or end. */
function goToCaptionEdge(edge) {
  if (session) return;
  const i = navCaption();
  if (i === null) { showToast('Load captions first', 'info'); return; }
  if (state.selectedRow !== i) {
    selectRow(i);
    rowEl(i)?.scrollIntoView({ block: 'nearest' });
  }
  const cap = state.captions[i];
  const t = edge === 'end' ? cap.endTime : cap.startTime;
  transport.seek(t);
  revealTime(t);
}

/** ↑ / ↓ and the transport's skip buttons: select a neighbour and go to its start. */
function stepCaption(dir) {
  if (session || !state.captions.length) return;
  const cur = state.selectedRow;
  const i = cur === null ? navCaption() : clamp(cur + dir, 0, state.captions.length - 1);
  selectRow(i);
  rowEl(i)?.scrollIntoView({ block: 'nearest' });
  transport.seek(state.captions[i].startTime);
  revealTime(state.captions[i].startTime);
}

/** ← / →: one frame (with Shift, one second), from a stopped playhead. */
function stepFrames(n) {
  if (session) return;
  if (transport.isPlaying()) transport.pause();
  const t = transport.now() + n * FRAME_SEC;
  transport.seek(t);
  revealTime(t);
}

function goToTimelineEdge(edge) {
  if (session) return;
  const t = edge === 'end' ? timelineDuration() : 0;
  transport.seek(t);
  revealTime(t);
}

/** Enter: play the selected caption with its dub, and stop at its end. */
function playSelectedCaption() {
  const i = navCaption();
  if (i === null || session) return;
  const cap = state.captions[i];
  playSegment(cap.startTime, cap.endTime);
}

// ─────────────────────────────────────────────
// KEYBOARD — called by app.js when not typing
// ─────────────────────────────────────────────

function studioKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return true;
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return true;
  }
  if (mod || e.altKey) return false;

  const sel = state.selectedRow;
  const key = e.code === 'Comma' ? ',' : e.code === 'Period' ? '.' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const act = fn => { e.preventDefault(); fn(); return true; };

  switch (key) {
    case 't': return act(() => { if (!session) startSession('line', sel); });
    case 'p': return act(() => { if (!session) startSession('rehearse', sel); });
    case 'l': return act(() => { if (sel !== null) soloToggle(sel); });
    case '[': return act(() => cycleTake(sel, -1));
    case ']': return act(() => cycleTake(sel, 1));
    case ',': return act(() => nudgeSelected(e.shiftKey ? -0.1 : -0.01));
    case '.': return act(() => nudgeSelected(e.shiftKey ? 0.1 : 0.01));
    case 'a': return act(alignSelected);
    case 'f': return act(fitSelected);
    case 'Delete':
    case 'Backspace': return act(deleteSelectedClip);
    case '=':
    case '+': return act(() => zoomTimeline(1.4));
    case '-': return act(() => zoomTimeline(1 / 1.4));
    case 'i': return act(() => goToCaptionEdge('start'));
    case 'o': return act(() => goToCaptionEdge('end'));
    case 'ArrowLeft': return act(() => stepFrames(e.shiftKey ? -30 : -1));
    case 'ArrowRight': return act(() => stepFrames(e.shiftKey ? 30 : 1));
    case 'Home': return act(() => goToTimelineEdge('start'));
    case 'End': return act(() => goToTimelineEdge('end'));
    case 'Enter':
      // A focused button or splitter keeps Enter for itself.
      if (document.activeElement?.matches?.('button, a[href], [role="separator"], summary')) return false;
      return act(playSelectedCaption);
    default: return false;
  }
}

// ─────────────────────────────────────────────
// FRAME LOOP + INIT
// ─────────────────────────────────────────────

let lastFrameAt = 0;

function studioTick() {
  const p = performance.now();
  lastFrameAt = p;
  transport.update(p);
  if (session) sessionTick(p);
  dubPlayer.tick(p);
  soloFrame();
  return p;
}

function studioFrame() {
  requestAnimationFrame(studioFrame);
  const p = studioTick();
  updateMeter(p);
  mixFrame(p);
  rythmoFrame(p);
  timelineFrame(p);
  if (sd.timecode) {
    const tc = fmtTimecode(transport.now(p));
    if (tc !== sd.timecode.textContent) sd.timecode.textContent = tc;
  }
  syncTimelinePlayBtn();
}

function initStudio() {
  bindStudioDom();
  initTimeline();
  initRythmo();
  initPrompter();
  wireDock();
  wireInspector();
  wireClipMenu();
  wireMix();
  wireTimelineTools();
  wireSettingsModal();

  refreshMicList();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshMicList());

  AudioEngine.onLost(() => {
    sd.meter.classList.remove('armed', 'clipped');
    sd.meter.setAttribute('aria-pressed', 'false');
    if (session?.recording) {
      showToast('The microphone was disconnected — keeping what was recorded', 'error');
      finishSession(true).then(() => AudioEngine.disarm());
    } else {
      AudioEngine.disarm();
      showToast('The microphone was disconnected', 'error');
    }
  });

  // Browsers only start audio after the first click or key press.
  const unlock = () => { AudioEngine.resume().catch(() => {}); };
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });

  // A mouse click on a tool button shouldn't leave focus on it: the next
  // Space or Enter belongs to the shortcuts, not to that button again.
  document.addEventListener('mousedown', e => {
    if (e.button === 0 && e.target.closest(
      '.tool-btn, .row-btn, .take-chip, .seg-btn, .btn-record, .btn-record-line, .btn-rehearse, .btn-stop, .meter, #rec-settings-btn')) {
      e.preventDefault();
    }
  }, true);

  // Clicking the YouTube player (its speaker, say) moves keyboard focus into
  // it, and every shortcut after that would go to YouTube instead. Take focus
  // back once the click has landed; the click itself still works.
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (a?.tagName === 'IFRAME' && a.closest('#youtube-iframe-wrapper')) {
        a.blur();
        window.focus();
      }
    }, 0);
  });

  requestAnimationFrame(studioFrame);
  // rAF pauses in background tabs; keep sessions and playback ticking anyway.
  setInterval(() => { if (performance.now() - lastFrameAt > 200) studioTick(); }, 100);

  window.addEventListener('beforeunload', e => {
    if (saveTimer || session) writeMirror();
    if (session?.recording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) saveProject();
  });
}
