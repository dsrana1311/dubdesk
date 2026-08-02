/**
 * DubDesk — app.js
 * Subtitle translation tool: SRT → Hinglish via OpenAI API + YouTube player
 */

'use strict';

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

const state = {
  captions: [],       // { index, startTime, endTime, startTimeStr, endTimeStr, text, hinglish, verified }
  selectedRow: null,  // index into state.captions
  bookmark: null,     // index of the "resume here next sitting" caption, or null
  apiKey: localStorage.getItem('openai_api_key') || '',
  videoId: null,
  isTranslating: false,

  // Recording / teleprompter state
  isRecording:      false,
  isContinuousRecording: false,
  recordingRowIdx:  null,
  mediaStream:      null,
  mediaRecorder:    null,
  cellTimer:        null,
  highlightTimers:  [],
  selectedMicId:    localStorage.getItem('selected_mic') || '',
  recordingPace:    1.0,   // 0.3–1.0; lower = slower teleprompter, audio sped up after

  // Continuous recordings — array of completed sessions
  continuousRecordings:   [],     // { blob, mime, url, startIdx, endIdx }
  // Active continuous recording indices (set during recording, then pushed to array)
  continuousRecStartIdx:  null,
  continuousRecEndIdx:    null,

  // Flow teleprompter (continuous recording only)
  flowWordSpans:        null,  // { [capIdx]: HTMLElement[] } or null when inactive
  flowHighlightTimers:  [],
  flowLastScrolledTop:  -Infinity,
};

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────

const el = {
  translateBtn:         document.getElementById('translate-btn'),
  verify90Btn:          document.getElementById('verify-90-btn'),
  verify100Btn:         document.getElementById('verify-100-btn'),
  uploadBtn:            document.getElementById('upload-btn'),
  srtFileInput:         document.getElementById('srt-file-input'),
  uploadHinglishBtn:    document.getElementById('upload-hinglish-btn'),
  hinglishSrtFileInput: document.getElementById('hinglish-srt-file-input'),
  youtubeUrl:           document.getElementById('youtube-url'),
  settingsBtn:          document.getElementById('settings-btn'),
  settingsModal:        document.getElementById('settings-modal'),
  shortcutsBtn:         document.getElementById('shortcuts-btn'),
  shortcutsModal:       document.getElementById('shortcuts-modal'),
  closeShortcuts:       document.getElementById('close-shortcuts'),
  resumeBtn:            document.getElementById('resume-btn'),
  resumeLabel:          document.getElementById('resume-label'),
  closeSettings:        document.getElementById('close-settings'),
  cancelSettings:       document.getElementById('cancel-settings'),
  saveApiKey:           document.getElementById('save-api-key'),
  apiKeyInput:          document.getElementById('api-key-input'),
  captionTable:         document.getElementById('caption-table'),
  progressIndicator:    document.getElementById('progress-indicator'),
  verifyProgress100:    document.getElementById('verify-progress-100'),
  verifyProgress90:     document.getElementById('verify-progress-90'),
  translateProgress:    document.getElementById('translate-progress'),
  translateProgressBar: document.getElementById('translate-progress-bar'),
  saveDraftBtn:         document.getElementById('save-draft-btn'),
  submitBtn:            document.getElementById('submit-btn'),
  downloadAllAudioBtn:  document.getElementById('download-all-audio-btn'),
  paceSlider:           document.getElementById('pace-slider'),
  paceValue:            document.getElementById('pace-value'),
  micSelect:            document.getElementById('mic-select'),
  recordAllBtn:         document.getElementById('record-all-btn'),
  stopRecordingBtn:     document.getElementById('stop-recording-btn'),
  videoTitle:           document.getElementById('video-title'),
  playerPlaceholder:    document.getElementById('player-placeholder'),
  iframeWrapper:        document.getElementById('youtube-iframe-wrapper'),
  toast:                document.getElementById('toast'),
  flowTeleprompter:     document.getElementById('flow-teleprompter'),
  timelinePlayBtn:      document.getElementById('timeline-play-btn'),
};

// ─────────────────────────────────────────────
// DUB TIMELINE — runtime state
// ─────────────────────────────────────────────

const tl = {
  viewport: null, canvas: null, ctx: null,
  playheadEl: null, emptyEl: null, scrollbar: null, thumb: null,

  dpr: 1, cssW: 0, cssH: 0,

  duration: 1,        // total timeline seconds (max of video duration & last caption end)
  videoDuration: 0,   // from the YouTube player, once known
  pxPerSec: 0,        // current zoom
  minPxPerSec: 1,     // fit-whole-video zoom (can't zoom out past this)
  maxPxPerSec: 400,   // max zoom-in
  scrollSec: 0,       // time at the left edge of the viewport
  userZoomed: false,  // true once the user wheels in (so we stop auto-fitting)

  dragging: false, dragMoved: false, dragStartX: 0, dragStartScroll: 0,
  rafId: null,
};

// ─────────────────────────────────────────────
// SRT PARSER
// ─────────────────────────────────────────────

function parseSRT(content) {
  // Normalise line endings and split on blank lines
  const blocks = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\s*\n/);
  const captions = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const index = parseInt(lines[0].trim(), 10);
    if (isNaN(index)) continue;

    const timeLine = lines[1].trim();
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;

    const m = timeLine.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!m) continue;

    captions.push({
      index,
      startTime:    toSeconds(m[1], m[2], m[3], m[4]),
      endTime:      toSeconds(m[5], m[6], m[7], m[8]),
      startTimeStr: `${m[1]}:${m[2]}:${m[3]},${m[4]}`,
      endTimeStr:   `${m[5]}:${m[6]}:${m[7]},${m[8]}`,
      text,
      hinglish:     '',
      excludeWords: '',  // Column D equivalent — optional words to exclude from translation
      verified:     false,  // true when audio is recorded for this caption
    });
  }

  return captions;
}

function toSeconds(h, m, s, ms) {
  return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
}

// ─────────────────────────────────────────────
// RENDER CAPTION TABLE
// ─────────────────────────────────────────────

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function renderTable() {
  if (state.captions.length === 0) {
    el.captionTable.innerHTML = `
      <div class="empty-state" id="empty-state">
        <div class="empty-icon">🎬</div>
        <p>Upload an SRT file to get started</p>
        <button id="upload-btn-empty" class="btn btn-primary">Upload SRT File</button>
      </div>`;
    document.getElementById('upload-btn-empty')
      .addEventListener('click', () => el.srtFileInput.click());
    return;
  }

  const frag = document.createDocumentFragment();

  state.captions.forEach((cap, idx) => {
    const row = document.createElement('div');
    row.className = 'caption-row';
    row.dataset.index = idx;
    applyRowClass(row, cap);
    if (state.selectedRow === idx) row.classList.add('selected');

    const contRec     = findContinuousRec(idx);
    const covered     = !!contRec;
    const isStartCell = contRec && idx === contRec.startIdx;
    const hasEdit     = !!cap.audioUrl;
    const hasCont     = isStartCell && !!contRec?.url;
    const hasAny      = hasEdit || hasCont;
    const hasListen   = hasEdit || hasCont || (covered && !!contRec?.url);
    const hasDl       = hasAny;
    const recLabel    = covered ? '✎ Edit' : '● Rec';
    const recTitle    = covered ? 'Re-record this cell only' : 'Record audio for this caption only';

    const isBookmarked = state.bookmark === idx;
    if (isBookmarked) row.classList.add('bookmarked');

    row.innerHTML = `
      <div class="cell cell-check">
        <span class="row-number">${cap.index}</span>
        <span class="verified-icon">✓</span>
      </div>
      <div class="cell cell-english">${escHtml(cap.text)}</div>
      <div class="cell cell-hinglish">
        <textarea
          class="hinglish-textarea"
          data-index="${idx}"
          placeholder="Hinglish translation…"
          spellcheck="false"
        >${escHtml(cap.hinglish)}</textarea>
      </div>
      <div class="cell cell-time">
        <span class="length-pct" data-pct-index="${idx}">${computeLengthPct(cap)}%</span>
        <div class="row-buttons">
          <button class="play-btn" data-time="${cap.startTime}">▶ Play</button>
          <button class="rec-btn${hasAny ? ' has-recording' : ''}" data-rec-index="${idx}" title="${recTitle}">${recLabel}</button>
          <button class="listen-btn${hasListen ? '' : ' hidden'}" data-listen-index="${idx}" title="Listen to recorded audio">🔊</button>
          <button class="dl-btn${hasDl ? '' : ' hidden'}" data-dl-index="${idx}" title="Download recorded audio">⬇</button>
        </div>
        <input
          type="text"
          class="exclude-input"
          data-index="${idx}"
          placeholder="Exclude words…"
          value="${escHtml(cap.excludeWords || '')}"
          title="Optional: words to exclude from translation (Column D in VBA)">
      </div>`;

    // Row selection (click anywhere except textarea / play btn)
    row.addEventListener('click', e => {
      if (e.target.tagName === 'TEXTAREA' || e.target.classList.contains('play-btn')) return;
      selectRow(idx);
    });

    // Textarea: sync to state on input; select row on focus
    const ta = row.querySelector('.hinglish-textarea');
    ta.addEventListener('input',  e => {
      autoResize(ta);
      state.captions[idx].hinglish = e.target.value;
      updateProgress();
      // Update the length percentage in the utility column
      const pctEl = row.querySelector(`.length-pct[data-pct-index="${idx}"]`);
      if (pctEl) pctEl.textContent = computeLengthPct(state.captions[idx]) + '%';
      // Update row highlight based on percentage
      applyRowClass(row, state.captions[idx]);
    });
    ta.addEventListener('focus',  () => selectRow(idx));

    // Exclude-words input: sync to state, select row on focus
    const exclInput = row.querySelector('.exclude-input');
    exclInput.addEventListener('input', e => { state.captions[idx].excludeWords = e.target.value; });
    exclInput.addEventListener('focus', () => selectRow(idx));
    exclInput.addEventListener('click', e => e.stopPropagation());

    // Play button
    row.querySelector('.play-btn')
      .addEventListener('click', e => { e.stopPropagation(); playSegment(cap.startTime, cap.endTime); });

    // Record button — starts (or overwrites) recording from this row
    row.querySelector('.rec-btn')
      .addEventListener('click', e => {
        e.stopPropagation();
        if (state.isRecording) {
          showToast('Stop the current recording first', 'info');
          return;
        }
        startRecordingFrom(idx, false);
      });

    // Listen button — plays back recorded audio
    row.querySelector('.listen-btn')
      .addEventListener('click', e => { e.stopPropagation(); toggleListen(idx); });

    // Download button — downloads this row's recorded audio
    row.querySelector('.dl-btn')
      .addEventListener('click', e => { e.stopPropagation(); downloadAudio(idx); });

    frag.appendChild(row);
  });

  el.captionTable.innerHTML = '';
  el.captionTable.appendChild(frag);
  el.captionTable.querySelectorAll('.hinglish-textarea').forEach(autoResize);
  updateProgress();
  updateButtons();
}

function applyRowClass(row, cap) {
  row.classList.remove('verified-90', 'verified-100', 'pct-over', 'pct-under');
  if (cap.verified) row.classList.add('verified-100');

  // Highlight based on translation length vs original
  const pct = computeLengthPct(cap);
  if (pct > 0 && pct > 110) row.classList.add('pct-over');
  else if (pct > 0 && pct < 90) row.classList.add('pct-under');
}

function rowEl(idx) {
  return el.captionTable.querySelector(`.caption-row[data-index="${idx}"]`);
}

/** Return the continuous recording object that covers idx, or null. */
function findContinuousRec(idx) {
  return state.continuousRecordings.find(
    r => idx >= r.startIdx && idx <= r.endIdx
  ) || null;
}

/** True if idx falls within any completed continuous recording range. */
function isCellCovered(idx) {
  return findContinuousRec(idx) !== null;
}

function scrollRowToCenter(idx) {
  const row = rowEl(idx);
  if (!row) return;
  const container = el.captionTable;
  const target = row.offsetTop - (container.clientHeight / 2) + (row.offsetHeight / 2);
  container.scrollTo({ top: target, behavior: 'smooth' });
}

function selectRow(idx) {
  const prev = el.captionTable.querySelector('.caption-row.selected');
  if (prev) prev.classList.remove('selected');
  state.selectedRow = idx;
  const curr = rowEl(idx);
  if (curr) curr.classList.add('selected');
  updateButtons();
  renderTimeline();
}

function updateProgress() {
  const total = state.captions.length;
  const done  = state.captions.filter(c => c.verified).length;
  el.progressIndicator.textContent = `${done} / ${total} captions recorded`;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  el.verifyProgress100.style.width = `${pct}%`;
  el.verifyProgress90.style.width  = '0%';
  updateAvgUtility();
  updateResumeButton();
}

function updateButtons() {
  const has    = state.captions.length > 0;
  const hasKey = !!state.apiKey;
  const hasSel = state.selectedRow !== null;
  el.translateBtn.disabled   = !has || !hasKey || state.isTranslating;
  el.verify90Btn.disabled    = !hasSel || !hasKey || state.isTranslating;
  el.verify100Btn.disabled   = !hasSel || !hasKey || state.isTranslating;
  if (el.recordAllBtn) el.recordAllBtn.disabled = !hasSel || state.isRecording;
  if (el.uploadHinglishBtn) {
    if (has) el.uploadHinglishBtn.classList.remove('hidden');
    else el.uploadHinglishBtn.classList.add('hidden');
  }
}

/**
 * Compute what percentage the Hinglish translation length is of the English original.
 * Returns 0 if there's no translation yet.
 */
function computeLengthPct(cap) {
  const origLen = (cap.text || '').trim().length;
  const transLen = (cap.hinglish || '').trim().length;
  if (origLen === 0) return 0;
  return Math.round((transLen / origLen) * 100);
}

function updateAvgUtility() {
  const avgPctEl = document.getElementById('avg-utility-pct');
  if (!avgPctEl) return;
  if (!state.captions || state.captions.length === 0) {
    avgPctEl.textContent = '';
    return;
  }
  let totalOrigLen = 0;
  let totalTransLen = 0;
  state.captions.forEach(cap => {
    totalOrigLen  += (cap.text     || '').trim().length;
    totalTransLen += (cap.hinglish || '').trim().length;
  });
  if (totalOrigLen === 0 || totalTransLen === 0) {
    avgPctEl.textContent = '';
  } else {
    const pct = ((totalTransLen / totalOrigLen) * 100).toFixed(1);
    avgPctEl.textContent = `(Avg: ${pct}%)`;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// YOUTUBE INTEGRATION
// ─────────────────────────────────────────────

let ytPlayer    = null;
let ytReady     = false;
let pendingSeek = null;

// Load YouTube IFrame API script
function loadYTApi() {
  if (window.YT) { ytReady = true; return; }
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

// Called automatically by the YT script when ready
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  if (state.videoId) createPlayer(state.videoId);
};

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function embedYouTube(videoId) {
  state.videoId = videoId;
  el.playerPlaceholder.classList.add('hidden');
  el.iframeWrapper.classList.remove('hidden');
  el.iframeWrapper.innerHTML = '<div id="yt-player"></div>';
  ytPlayer = null;

  if (ytReady && window.YT?.Player) {
    createPlayer(videoId);
  }
  // else: onYouTubeIframeAPIReady will call createPlayer once the API loads
}

function createPlayer(videoId) {
  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { enablejsapi: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady() {
        if (pendingSeek !== null) {
          ytPlayer.seekTo(pendingSeek, true);
          ytPlayer.playVideo();
          pendingSeek = null;
        }
      },
    },
  });
}

function seekVideo(seconds, play = true) {
  if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
    ytPlayer.seekTo(seconds, true);
    if (play) ytPlayer.playVideo();
  } else {
    pendingSeek = seconds;
  }
}

let _segmentStopTimer = null;

function playSegment(startTime, endTime) {
  if (_segmentStopTimer !== null) {
    clearTimeout(_segmentStopTimer);
    _segmentStopTimer = null;
  }

  seekVideo(startTime);

  // Stop by watching the real playhead rather than by wall-clock duration.
  // A timer started at seek time runs while the player is still buffering
  // (state 3), which cuts the first play of a segment short by the buffering
  // delay; polling getCurrentTime() only advances when frames actually play,
  // so it is immune to seek latency, buffering and playback-rate changes.
  const POLL_MS    = 30;
  const EPSILON    = 0.02;  // stop a hair early rather than overshooting a frame
  const MAX_WAIT_MS = 10000; // safety net if the player never reaches endTime

  const started = Date.now();
  let reachedStart = false;

  function tick() {
    _segmentStopTimer = null;

    const t = ytPlayer && typeof ytPlayer.getCurrentTime === 'function'
      ? ytPlayer.getCurrentTime()
      : null;

    if (t === null || Date.now() - started > MAX_WAIT_MS) {
      pauseVideo();
      return;
    }

    // Ignore stale positions from before the seek lands: only start checking
    // for the end once the playhead has actually arrived in the segment.
    if (!reachedStart) {
      if (t >= startTime - 0.3) reachedStart = true;
    } else if (t >= endTime - EPSILON) {
      pauseVideo();
      return;
    }

    _segmentStopTimer = setTimeout(tick, POLL_MS);
  }

  _segmentStopTimer = setTimeout(tick, POLL_MS);
}

function pauseVideo() {
  if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
    ytPlayer.pauseVideo();
  }
}

function toggleVideoPlayback() {
  if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
  const playing = ytPlayer.getPlayerState() === 1;
  if (playing) {
    ytPlayer.pauseVideo();
  } else {
    ytPlayer.playVideo();
  }
}

function syncTimelinePlayBtn() {
  if (!el.timelinePlayBtn) return;
  const playing = ytPlayer &&
    typeof ytPlayer.getPlayerState === 'function' &&
    ytPlayer.getPlayerState() === 1;
  el.timelinePlayBtn.textContent = playing ? '⏸' : '▶';
  el.timelinePlayBtn.classList.toggle('playing', !!playing);
}

// ─────────────────────────────────────────────
// TRANSLATION — OPENAI API
// ─────────────────────────────────────────────

const OPENAI_URL   = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4.1';
const BATCH_SIZE   = 20;

// Shared between 90 / 100 prompts — only one sentence differs (the length rule)
const SYSTEM_PROMPT_PREFIX =
  'You are a skilled translator. Translate English text into natural Hinglish (Hindi written in Roman script).' +
  ' Preserve the original meaning and sentence structure closely. Do not add explanations or extra information.' +
  ' Make the translation sound natural, conversational, and how Hindi speakers actually talk — not robotic or overly formal.' +
  ' Keep commonly used English words in English when they naturally fit Hinglish speech.' +
  ' Always use \'aap\' instead of \'tum\' or \'tu\'.' +
  ' Whenever the English text uses "I", "me", or "my", translate the Hindi equivalent "main" as "mai" (without the ending "n") to avoid confusion with the English word "main".';

const SYSTEM_PROMPT_SUFFIX =
  ' Output must be concise, natural, coherent and should make sense while reading or listening, never robotic Hindi or over-paraphrased Hinglish.' +
  ' Return only the translation inside the same <row_x>...</row_x> tags.';

// 100% prompt — used by bulk Translate and "Selected Cell 100%"
const SYSTEM_PROMPT_100 =
  SYSTEM_PROMPT_PREFIX +
  ' Keep the translation roughly the same length as the original, suitable for voiceover or dubbing.' +
  SYSTEM_PROMPT_SUFFIX;

// 90% prompt — used by "Selected Cell 90%"
const SYSTEM_PROMPT_90 =
  SYSTEM_PROMPT_PREFIX +
  ' Keep the translation 90% of the original.' +
  SYSTEM_PROMPT_SUFFIX;

async function translateAll() {
  if (!state.apiKey) {
    showToast('Add your OpenAI API key in ⚙ Settings first', 'error');
    return;
  }

  const toTranslate = state.captions
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.hinglish || !c.hinglish.trim());

  if (!toTranslate.length) {
    showToast('All captions already translated', 'info');
    return;
  }

  state.isTranslating = true;
  updateButtons();
  el.translateBtn.textContent = 'Translating…';
  el.translateProgress.classList.remove('hidden');
  el.translateProgressBar.style.width = '0%';

  // Mark textareas as translating
  toTranslate.forEach(({ i }) => {
    const ta = el.captionTable.querySelector(`.hinglish-textarea[data-index="${i}"]`);
    if (ta) ta.classList.add('translating');
  });

  let done = 0;
  const total = toTranslate.length;

  for (let b = 0; b < toTranslate.length; b += BATCH_SIZE) {
    const batch = toTranslate.slice(b, b + BATCH_SIZE);
    try {
      // Bulk translate uses no exclude words (matches VBA TranslateColumnAtoBwholescript)
      const translations = await translateBatch(batch.map(({ c }) => ({ text: c.text, excludeWords: '' })));

      translations.forEach((hinglish, j) => {
        const { c, i } = batch[j];
        c.hinglish = hinglish;
        const ta = el.captionTable.querySelector(`.hinglish-textarea[data-index="${i}"]`);
        if (ta) { 
          ta.value = hinglish; 
          ta.classList.remove('translating'); 
          autoResize(ta);
        }
        // Update the length percentage in the Utility column
        const pctEl = el.captionTable.querySelector(`.length-pct[data-pct-index="${i}"]`);
        if (pctEl) pctEl.textContent = computeLengthPct(c) + '%';
        // Update row highlight based on percentage
        const r = rowEl(i);
        if (r) applyRowClass(r, c);
      });

      done += batch.length;
      el.translateProgressBar.style.width = `${Math.round((done / total) * 100)}%`;

    } catch (err) {
      console.error('Batch translation error:', err);
      batch.forEach(({ i }) => {
        const ta = el.captionTable.querySelector(`.hinglish-textarea[data-index="${i}"]`);
        if (ta) ta.classList.remove('translating');
      });
      showToast(`Translation error: ${err.message}`, 'error');
      break;
    }
  }

  el.translateBtn.textContent = 'Translate';
  state.isTranslating = false;
  updateButtons();
  updateAvgUtility();

  setTimeout(() => el.translateProgress.classList.add('hidden'), 600);
  if (done > 0) showToast(`Translated ${done} caption${done !== 1 ? 's' : ''}`, 'success');
}

/**
 * Send a batch to OpenAI.
 * @param {Array<{text: string, excludeWords: string}>} items
 * @param {string} systemPrompt — defaults to the 100% prompt (used by bulk Translate)
 * @returns {Promise<string[]>} translations, one per item
 *
 * Mirrors the VBA macro: each item becomes <row_N>text [EXCLUDE_WORDS: ...]</row_N>
 * (the [EXCLUDE_WORDS: ...] suffix is only added if excludeWords is non-empty)
 */
async function translateBatch(items, systemPrompt = SYSTEM_PROMPT_100) {
  const userPrompt = items
    .map((item, i) => {
      const n     = i + 1;
      const excl  = item.excludeWords && item.excludeWords.trim()
                      ? ` [EXCLUDE_WORDS: ${item.excludeWords.trim()}]`
                      : '';
      return `<row_${n}>${item.text}${excl}</row_${n}>`;
    })
    .join('\n');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify({
      model:       OPENAI_MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const e = await res.json(); msg = e.error?.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '';
  return parseRowTags(raw, items.length);
}

// Extract translations from <row_x>...</row_x> tags — mirrors VBA Mid() extraction
function parseRowTags(raw, count) {
  const out = new Array(count).fill('');
  for (let i = 0; i < count; i++) {
    const tag    = `<row_${i + 1}>`;
    const endTag = `</row_${i + 1}>`;
    const start  = raw.indexOf(tag);
    const end    = raw.indexOf(endTag);
    if (start !== -1 && end > start) {
      out[i] = raw.slice(start + tag.length, end).trim();
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// RE-TRANSLATION (90% / 100% modes)
// ─────────────────────────────────────────────

/**
 * "Selected Cell 90% / 100%" — re-translate the currently selected row using OpenAI.
 * Mirrors VBA TranslateSelectedCells90percent / TranslateSelectedCells100percent (single-cell case).
 *
 * @param {number} mode — 90 or 100
 *   - 100: uses the "roughly the same length, suitable for voiceover" prompt
 *          and supports the per-row Exclude Words input ([EXCLUDE_WORDS: ...])
 *   - 90:  uses the "Keep the translation 90% of the original" prompt
 *          and ignores Exclude Words (matches the VBA which doesn't read Column D)
 */
async function retranslateSelected(mode) {
  if (state.selectedRow === null) return;

  if (!state.apiKey) {
    showToast('Add your OpenAI API key in ⚙ Settings first', 'error');
    return;
  }

  if (state.isTranslating) return;

  const idx = state.selectedRow;
  const cap = state.captions[idx];

  const isMode90     = mode === 90;
  const systemPrompt = isMode90 ? SYSTEM_PROMPT_90 : SYSTEM_PROMPT_100;
  const button       = isMode90 ? el.verify90Btn : el.verify100Btn;
  const originalText = isMode90 ? 'Selected Cell 90%' : 'Selected Cell 100%';

  state.isTranslating = true;
  updateButtons();
  button.textContent = 'Translating…';

  const ta = el.captionTable.querySelector(`.hinglish-textarea[data-index="${idx}"]`);
  if (ta) ta.classList.add('translating');

  try {
    const translations = await translateBatch(
      [{
        text:         cap.text,
        excludeWords: isMode90 ? '' : (cap.excludeWords || ''),
      }],
      systemPrompt,
    );

    const result = translations[0];
    if (!result) throw new Error('No translation returned');

    cap.hinglish = result;
    if (ta) {
      ta.value = result;
      ta.classList.remove('translating');
      autoResize(ta);
    }
    const pctEl = el.captionTable.querySelector(`.length-pct[data-pct-index="${idx}"]`);
    if (pctEl) pctEl.textContent = computeLengthPct(cap) + '%';
    const row = rowEl(idx);
    if (row) applyRowClass(row, cap);

    showToast(`Re-translated (${mode}%)`, 'success');

  } catch (err) {
    console.error('Retranslate error:', err);
    if (ta) ta.classList.remove('translating');
    showToast(`Translation error: ${err.message}`, 'error');
  } finally {
    button.textContent = originalText;
    state.isTranslating = false;
    updateButtons();
    updateAvgUtility();
  }
}

// ─────────────────────────────────────────────
// BOOKMARK — "resume here next sitting"
// ─────────────────────────────────────────────
//
// A single resume point. Setting a bookmark on a new row moves it off the
// old one. Persisted with the draft so it survives a reload, and also
// written immediately (not only on Save Draft) so an accidental tab close
// doesn't lose your place.

const BOOKMARK_KEY = 'dubdesk_bookmark';

/** Toggle the bookmark on idx: sets it, or clears it if already there. */
function toggleBookmark(idx) {
  if (state.bookmark === idx) {
    setBookmark(null);
    showToast('Bookmark removed', 'info');
  } else {
    setBookmark(idx);
    const cap = state.captions[idx];
    showToast(`Bookmarked caption #${cap ? cap.index : idx + 1}`, 'success');
  }
}

/**
 * Set (or clear, with null) the resume point and refresh everything that
 * reflects it — the old row, the new row, the sub-header button, storage.
 */
function setBookmark(idx) {
  const prev = state.bookmark;
  state.bookmark = idx;

  if (prev !== null && prev !== idx) refreshBookmarkRow(prev);
  if (idx !== null) refreshBookmarkRow(idx);

  persistBookmark();
  updateResumeButton();
}

/** Re-sync a single row's bookmark highlight without a full table re-render. */
function refreshBookmarkRow(idx) {
  const row = rowEl(idx);
  if (!row) return;
  row.classList.toggle('bookmarked', state.bookmark === idx);
}

/**
 * Jump to the bookmarked caption: select it, centre it, and flash it so the
 * eye lands in the right place. Also seeks the video to that caption.
 */
function goToBookmark() {
  if (state.bookmark === null) {
    showToast('No bookmark set — press B on a caption to set one', 'info');
    return;
  }
  if (state.bookmark >= state.captions.length) {
    showToast('Bookmark points past the end of this SRT', 'error');
    return;
  }

  const idx = state.bookmark;
  selectRow(idx);
  scrollRowToCenter(idx);

  const row = rowEl(idx);
  if (row) {
    row.classList.remove('bookmark-flash');
    // Force reflow so the animation restarts on repeat jumps
    void row.offsetWidth;
    row.classList.add('bookmark-flash');
    setTimeout(() => row.classList.remove('bookmark-flash'), 1000);
  }

  const cap = state.captions[idx];
  if (cap) seekVideo(cap.startTime, false);
}

/** Show/hide + label the sub-header resume button. */
function updateResumeButton() {
  if (!el.resumeBtn) return;

  const idx = state.bookmark;
  const valid = idx !== null && idx < state.captions.length;

  if (!valid) {
    el.resumeBtn.classList.add('hidden');
    return;
  }

  const cap = state.captions[idx];
  el.resumeBtn.classList.remove('hidden');
  el.resumeLabel.textContent = `Resume at #${cap ? cap.index : idx + 1}`;
  el.resumeBtn.title = `Jump to your bookmarked caption (Shift+B)`;
}

function persistBookmark() {
  try {
    if (state.bookmark === null) localStorage.removeItem(BOOKMARK_KEY);
    else localStorage.setItem(BOOKMARK_KEY, String(state.bookmark));
  } catch (_) { /* storage full / disabled — bookmark just won't persist */ }
}

function restoreBookmark() {
  try {
    const raw = localStorage.getItem(BOOKMARK_KEY);
    if (raw === null) return;
    const idx = parseInt(raw, 10);
    if (!isNaN(idx) && idx >= 0 && idx < state.captions.length) {
      state.bookmark = idx;
    }
  } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────
// DRAFT — SAVE & LOAD
// ─────────────────────────────────────────────

function saveDraft() {
  // Strip in-memory audio fields — Blobs / typed arrays can't be JSON-stringified
  const captions = state.captions.map(c => {
    const { audioBlob, audioUrl, audioMime, _wave, ...rest } = c;
    return rest;
  });
  const draft = {
    captions,
    videoId:  state.videoId,
    title:    el.videoTitle.textContent,
    bookmark: state.bookmark,
    savedAt:  new Date().toISOString(),
  };
  localStorage.setItem('dubdesk_draft', JSON.stringify(draft));
  showToast('Draft saved', 'success');
}

function loadDraft() {
  const raw = localStorage.getItem('dubdesk_draft');
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    state.captions = d.captions || [];
    state.videoId  = d.videoId  || null;

    // Bookmark: prefer the draft's own value, else the standalone key
    // (which is written on every toggle, so it can be newer than the draft).
    if (typeof d.bookmark === 'number' && d.bookmark < state.captions.length) {
      state.bookmark = d.bookmark;
    }
    restoreBookmark();

    if (d.title) el.videoTitle.textContent = d.title;

    if (state.videoId) {
      el.youtubeUrl.value = `https://www.youtube.com/watch?v=${state.videoId}`;
      embedYouTube(state.videoId);
    }

    if (state.captions.length) {
      renderTable();
      fitTimeline();
      updateResumeButton();

      // Resume where the last sitting left off
      if (state.bookmark !== null) {
        const cap = state.captions[state.bookmark];
        selectRow(state.bookmark);
        // Wait for layout so offsetTop/clientHeight are real before centring
        requestAnimationFrame(() => goToBookmark());
        showToast(
          `Draft loaded — resuming at caption #${cap ? cap.index : state.bookmark + 1}`,
          'success'
        );
      } else {
        showToast(`Draft loaded (${state.captions.length} captions)`, 'success');
      }
    }
  } catch (e) {
    console.error('Failed to load draft:', e);
  }
}

// ─────────────────────────────────────────────
// EXPORT SRT
// ─────────────────────────────────────────────

function exportSRT() {
  if (!state.captions.length) {
    showToast('No captions to download', 'error');
    return;
  }

  const lines = state.captions.map(c =>
    `${c.index}\n${c.startTimeStr} --> ${c.endTimeStr}\n${c.hinglish || ''}\n`
  );

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'translated_subtitles.srt';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Hinglish SRT downloaded', 'success');
}

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────

let toastTimer = null;

function showToast(msg, type = '') {
  clearTimeout(toastTimer);
  el.toast.textContent = msg;
  el.toast.className   = `toast${type ? ' ' + type : ''}`;

  requestAnimationFrame(() => {
    el.toast.classList.add('show');
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3000);
  });
}

// ─────────────────────────────────────────────
// AUDIO RECORDING / TELEPROMPTER
// ─────────────────────────────────────────────

/**
 * Populate the mic selector <select> with available audio input devices.
 * Labels are empty until mic permission is granted — that's expected on first load.
 * Call again after getUserMedia succeeds to refresh with proper labels.
 */
async function refreshMicList() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    el.micSelect.innerHTML = '<option value="">Audio not supported</option>';
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');

    el.micSelect.innerHTML = '';

    if (mics.length === 0) {
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

async function acquireMicStream() {
  const get = c => navigator.mediaDevices.getUserMedia(c);
  try {
    return await get(
      state.selectedMicId
        ? { audio: { deviceId: { exact: state.selectedMicId } } }
        : { audio: true }
    );
  } catch (e) {
    // Fall back to default if the stored deviceId is stale
    if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
      return await get({ audio: true });
    }
    throw e;
  }
}

/**
 * Entry point — begin a recording session starting from `idx`.
 *
 * continuous=true  → ONE MediaRecorder runs for the entire session (no
 *                    per-cell chopping). The single blob is saved when the
 *                    user presses Stop.
 * continuous=false → per-cell (edit) recording: one recorder for one cell.
 */
async function startRecordingFrom(idx, continuous = false) {
  if (state.isRecording) return;

  const cap = state.captions[idx];
  if (!cap) return;

  // Overwrite confirmation
  if (continuous) {
    const existing = findContinuousRec(idx);
    if (existing) {
      const ok = window.confirm('Overwrite existing continuous recording for this range?');
      if (!ok) return;
      // Remove the old recording that starts at this idx
      const ri = state.continuousRecordings.indexOf(existing);
      if (ri !== -1) {
        URL.revokeObjectURL(existing.url);
        state.continuousRecordings.splice(ri, 1);
        renderTimeline();
      }
    }
  }

  try {
    state.mediaStream = await acquireMicStream();
  } catch (e) {
    showToast(`Microphone error: ${e.message}`, 'error');
    return;
  }

  // Now that permission is granted, re-enumerate to get proper device labels
  refreshMicList().catch(() => {});

  state.isRecording = true;
  state.isContinuousRecording = continuous;
  el.stopRecordingBtn.classList.remove('hidden');
  updateButtons();

  if (continuous) {
    state.continuousRecStartIdx = idx;
    buildFlowTeleprompter(idx);
  }

  if (continuous) {
    // Continuous mode still needs a mic warm-up because the recorder captures
    // the entire session and the very first audio frames can be silent/distorted.
    setTimeout(() => {
      if (!state.isRecording) return;
      startContinuousRecorder(idx);
      recordCell(idx);
    }, 1200);
  } else {
    // Single-cell mode: no global warm-up delay. The recorder starts immediately
    // inside recordCell() and records a short pre-roll silence internally —
    // the teleprompter only appears AFTER the mic has stabilised, so the user's
    // speech is captured cleanly even on very short (1-second) captions.
    recordCell(idx);
  }
}

/**
 * Spin up a single MediaRecorder that captures the entire continuous
 * session.  Its onstop handler saves the blob to state-level fields
 * (not per-caption) and updates the UI for all covered cells.
 */
function startContinuousRecorder(startIdx) {
  let recorder;
  try {
    recorder = new MediaRecorder(state.mediaStream);
  } catch (e) {
    showToast(`Recorder error: ${e.message}`, 'error');
    stopRecording();
    return;
  }

  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    if (chunks.length === 0) return;
    const mime = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });

    const url = URL.createObjectURL(blob);
    const endIdx = state.continuousRecEndIdx ?? startIdx;

    // Store this session in the recordings array
    const rec = { blob, mime, url, startIdx, endIdx };
    state.continuousRecordings.push(rec);

    // Clear any old per-cell recordings that this continuous take supersedes
    for (let i = startIdx; i <= endIdx; i++) {
      const c = state.captions[i];
      if (c && c.audioUrl) {
        URL.revokeObjectURL(c.audioUrl);
        c.audioBlob = null;
        c.audioMime = null;
        c.audioUrl  = null;
        c._wave     = null;
      }
      updateRowRecordUI(i);
    }

    // Fill the timeline pills immediately, then draw waveforms once decoded.
    renderTimeline();
    buildWaveForContinuous(rec);
  };
  recorder.start();
  state.mediaRecorder = recorder;
}

/**
 * Drive one caption's UI (teleprompter, word highlights, cell selection).
 *
 * Continuous mode  → the MediaRecorder is already running (started in
 *                    startContinuousRecorder). This function only advances
 *                    the visual state and sets a timer to move to the next
 *                    cell. No recorder is stopped or started. Video plays
 *                    naturally (only the first cell seeks).
 *
 * Edit / single    → creates a per-cell MediaRecorder, stops it after the
 *                    caption's duration, and saves the blob to cap.audioBlob.
 */
function recordCell(idx) {
  if (!state.isRecording) return;

  const cap = state.captions[idx];
  if (!cap) { stopRecording(); return; }

  state.recordingRowIdx = idx;
  selectRow(idx);
  scrollRowToCenter(idx);

  const captionDurationMs = Math.max(500, (cap.endTime - cap.startTime) * 1000);

  if (state.isContinuousRecording) {
    // ── CONTINUOUS MODE ────────────────────────────────────
    // Only seek for the very first cell; after that, let the video play
    // naturally so the recording captures the real timeline (including gaps).
    if (idx === state.continuousRecStartIdx) {
      seekVideo(cap.startTime);
    }

    // UI timer — extend to cover the gap to the next caption
    let uiDurationMs = captionDurationMs;
    const nextCap = state.captions[idx + 1];
    if (nextCap) {
      const spanToNextMs = (nextCap.startTime - cap.startTime) * 1000;
      if (spanToNextMs > uiDurationMs) uiDurationMs = spanToNextMs;
    }

    showTeleprompter(idx);
    scheduleWordHighlights(idx, captionDurationMs);
    scheduleFlowHighlights(idx, captionDurationMs);

    state.cellTimer = setTimeout(() => {
      clearWordHighlights();
      hideTeleprompter(idx);

      if (!state.isRecording) return;

      const nextIdx = idx + 1;
      if (nextIdx >= state.captions.length) {
        stopRecording();
        showToast('Reached end of captions', 'info');
        return;
      }

      // Advance UI directly — the recorder keeps running.
      recordCell(nextIdx);
    }, uiDurationMs);

  } else {
    // ── SINGLE-CELL (EDIT) MODE ────────────────────────────
    // Pre-roll: record silence for this long BEFORE showing the teleprompter.
    // Serves two purposes: (1) hardware warm-up so the user's first word is
    // captured cleanly, (2) the audio is trimmed off before saving so nothing
    // leaks into the file. Value tuned to cover typical mic start-up latency.
    const PRE_ROLL_MS  = 300;
    // Post-roll: keep recording for this long AFTER the caption window ends
    // so the user has breathing room to finish the sentence without being cut.
    const POST_ROLL_MS = 500;

    // Apply pace: slower teleprompter gives the speaker more time.
    // speedFactor is how much the recorded audio must be sped up afterwards.
    const pace = state.recordingPace;
    const slowDurationMs = captionDurationMs / pace;
    const speedFactor    = 1 / pace;

    let recorder;
    try {
      recorder = new MediaRecorder(state.mediaStream);
    } catch (e) {
      showToast(`Recorder error: ${e.message}`, 'error');
      stopRecording();
      return;
    }

    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      if (chunks.length === 0) return;
      const mime = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      processSingleCellRecording(blob, mime, cap, idx, PRE_ROLL_MS, speedFactor)
        .catch(err => {
          console.error('processSingleCellRecording failed', err);
          showToast('Failed to process audio: ' + err.message, 'error');
        });
    };

    // Start recording IMMEDIATELY — the first PRE_ROLL_MS ms capture silence
    // while the mic hardware stabilises, and will be trimmed off on save.
    recorder.start();
    state.mediaRecorder = recorder;

    // After the pre-roll, show the teleprompter and play the video.
    setTimeout(() => {
      if (!state.isRecording) return;

      seekVideo(cap.startTime);
      if (pace < 1 && ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
        ytPlayer.setPlaybackRate(pace);
      }

      showTeleprompter(idx);
      scheduleWordHighlights(idx, slowDurationMs);

      // Stop the recorder after the caption window + post-roll buffer.
      state.cellTimer = setTimeout(() => {
        clearWordHighlights();
        hideTeleprompter(idx);
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (_) {}
        }
        stopRecording();
      }, slowDurationMs + POST_ROLL_MS);
    }, PRE_ROLL_MS);
  }
}

function stopRecording() {
  clearTimeout(state.cellTimer);
  state.cellTimer = null;

  pauseVideo();
  // Restore normal video speed after paced recording
  if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
    ytPlayer.setPlaybackRate(1);
  }

  clearWordHighlights();
  hideFlowTeleprompter();

  if (state.recordingRowIdx !== null) {
    hideTeleprompter(state.recordingRowIdx);
  }

  // Capture the last-recorded cell index BEFORE clearing — the
  // continuous recorder's onstop handler needs it to know the range.
  if (state.isContinuousRecording && state.recordingRowIdx !== null) {
    state.continuousRecEndIdx = state.recordingRowIdx;
  }

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    try { state.mediaRecorder.stop(); } catch (_) {}
  }
  state.mediaRecorder = null;

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }

  state.isRecording           = false;
  state.isContinuousRecording = false;
  state.recordingRowIdx       = null;

  el.stopRecordingBtn.classList.add('hidden');
  updateButtons();
}

/**
 * Replace the hinglish textarea with a .teleprompter div whose words
 * are wrapped in .tp-word spans (so we can highlight them as time passes).
 */
function showTeleprompter(idx) {
  const row = rowEl(idx);
  if (!row) return;
  const cell = row.querySelector('.cell-hinglish');
  const ta   = cell?.querySelector('.hinglish-textarea');
  if (!cell || !ta) return;

  const text = ta.value || '';
  const tp = document.createElement('div');
  tp.className = 'teleprompter';

  // Preserve whitespace (including newlines) between words
  const parts = text.split(/(\s+)/);
  parts.forEach(part => {
    if (!part) return;
    if (/^\s+$/.test(part)) {
      tp.appendChild(document.createTextNode(part));
    } else {
      const span = document.createElement('span');
      span.className = 'tp-word';
      span.textContent = part;
      tp.appendChild(span);
    }
  });

  ta.classList.add('hidden');
  cell.appendChild(tp);
  row.classList.add('recording');
}

function hideTeleprompter(idx) {
  const row = rowEl(idx);
  if (!row) return;
  const cell = row.querySelector('.cell-hinglish');
  const tp   = cell?.querySelector('.teleprompter');
  const ta   = cell?.querySelector('.hinglish-textarea');
  if (tp) tp.remove();
  if (ta) ta.classList.remove('hidden');
  row.classList.remove('recording');
}

function scheduleWordHighlights(idx, durationMs) {
  const row = rowEl(idx);
  if (!row) return;
  const spans = row.querySelectorAll('.tp-word');
  if (spans.length === 0) return;

  const interval = durationMs / spans.length;
  state.highlightTimers = [];
  spans.forEach((span, i) => {
    const t = setTimeout(() => span.classList.add('tp-word-active'), i * interval);
    state.highlightTimers.push(t);
  });
}

function clearWordHighlights() {
  state.highlightTimers.forEach(clearTimeout);
  state.highlightTimers = [];
}

// ─────────────────────────────────────────────
// FLOW TELEPROMPTER — continuous-recording overlay
// ─────────────────────────────────────────────

/**
 * Build the flow teleprompter DOM: all captions from startIdx onwards
 * rendered as one continuous paragraph, each word wrapped in a .flow-word
 * span. Shows the overlay and records the per-caption word-span groups
 * in state.flowWordSpans so scheduleFlowHighlights can drive them.
 */
function buildFlowTeleprompter(startIdx) {
  const container = el.flowTeleprompter;
  if (!container) return;
  const content = container.querySelector('.flow-tp-content');
  content.innerHTML = '';
  state.flowWordSpans = {};
  state.flowLastScrolledTop = -Infinity;

  for (let i = startIdx; i < state.captions.length; i++) {
    const cap = state.captions[i];
    const text = (cap.hinglish || '').trim();
    if (!text) continue;

    state.flowWordSpans[i] = [];
    const parts = text.split(/(\s+)/);
    parts.forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        content.appendChild(document.createTextNode(' '));
      } else {
        const span = document.createElement('span');
        span.className = 'flow-word';
        span.textContent = part;
        state.flowWordSpans[i].push(span);
        content.appendChild(span);
      }
    });
    // Single space between captions — reader sees a continuous flow.
    content.appendChild(document.createTextNode(' '));
  }

  container.classList.remove('hidden');
  container.setAttribute('aria-hidden', 'false');

  // Pad top & bottom by half the container height so the first and last
  // lines can still scroll to the vertical center.
  const halfH = container.clientHeight / 2;
  content.style.paddingTop    = halfH + 'px';
  content.style.paddingBottom = halfH + 'px';

  // Start scrolled to the very top so the first line will glide into center.
  container.scrollTop = 0;
}

function hideFlowTeleprompter() {
  const container = el.flowTeleprompter;
  if (!container) return;
  clearFlowHighlightTimers();
  container.classList.add('hidden');
  container.setAttribute('aria-hidden', 'true');
  const content = container.querySelector('.flow-tp-content');
  if (content) {
    content.innerHTML = '';
    content.style.paddingTop = '';
    content.style.paddingBottom = '';
  }
  state.flowWordSpans = null;
  state.flowLastScrolledTop = -Infinity;
}

function clearFlowHighlightTimers() {
  state.flowHighlightTimers.forEach(clearTimeout);
  state.flowHighlightTimers = [];
}

/**
 * Highlight the flow teleprompter's words for the caption at idx, pacing
 * them linearly across durationMs. Each word activation also smooth-scrolls
 * the overlay so the active line stays vertically centered.
 */
function scheduleFlowHighlights(idx, durationMs) {
  const spans = state.flowWordSpans?.[idx];
  if (!spans || spans.length === 0) return;

  const interval = durationMs / spans.length;
  spans.forEach((span, i) => {
    const t = setTimeout(() => {
      if (i > 0) {
        const prev = spans[i - 1];
        prev.classList.remove('flow-word-active');
        prev.classList.add('flow-word-past');
      }
      span.classList.add('flow-word-active');
      scrollFlowWordIntoCenter(span);
    }, i * interval);
    state.flowHighlightTimers.push(t);
  });

  // After the full duration, demote the last word from active → past so it
  // doesn't stay highlighted through the silent gap before the next cell.
  const finalT = setTimeout(() => {
    const last = spans[spans.length - 1];
    if (last) {
      last.classList.remove('flow-word-active');
      last.classList.add('flow-word-past');
    }
  }, durationMs);
  state.flowHighlightTimers.push(finalT);
}

/**
 * Smooth-scroll the overlay so the given word span is vertically centered.
 * We only actually scroll when the span's line (offsetTop) has changed — on
 * same-line word transitions the eye stays fixed and scrolling would feel
 * jittery. This gives the line-by-line glide the user wants.
 */
function scrollFlowWordIntoCenter(span) {
  const container = el.flowTeleprompter;
  if (!container || container.classList.contains('hidden')) return;

  // .flow-tp is position:fixed so the word spans' offsetParent is .flow-tp
  // itself — offsetTop is measured relative to the scroll container.
  const spanTop = span.offsetTop;

  // 4px dead-zone: catches rounding / sub-pixel layouts so words on the
  // same visual line don't each re-trigger a scroll.
  if (Math.abs(spanTop - state.flowLastScrolledTop) < 4) return;
  state.flowLastScrolledTop = spanTop;

  const target = spanTop - (container.clientHeight / 2) + (span.offsetHeight / 2);
  container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

function updateRowRecordUI(idx) {
  const row = rowEl(idx);
  if (!row) return;
  const cap = state.captions[idx];
  const recBtn    = row.querySelector('.rec-btn');
  const dlBtn     = row.querySelector('.dl-btn');
  const listenBtn = row.querySelector('.listen-btn');

  const contRec     = findContinuousRec(idx);
  const covered     = !!contRec;
  const isStartCell = contRec && idx === contRec.startIdx;
  const hasEdit     = !!cap.audioUrl;
  const hasCont     = isStartCell && !!contRec?.url;
  const hasAny      = hasEdit || hasCont;
  const hasListen   = hasEdit || hasCont || (covered && !!contRec?.url);

  // Rec button label
  if (recBtn) {
    recBtn.textContent = covered ? '✎ Edit' : '● Rec';
    recBtn.title       = covered ? 'Re-record this cell only' : 'Record audio for this caption only';
  }

  if (hasAny) {
    recBtn?.classList.add('has-recording');
    dlBtn?.classList.remove('hidden');
  } else {
    recBtn?.classList.remove('has-recording');
    dlBtn?.classList.add('hidden');
  }

  if (hasListen) {
    listenBtn?.classList.remove('hidden');
  } else {
    listenBtn?.classList.add('hidden');
  }

  // Auto-verify: tick appears when audio covers this cell (own edit or continuous), disappears when it doesn't
  cap.verified = hasEdit || (covered && !!contRec?.url);
  applyRowClass(row, cap);
  updateProgress();
}

function downloadAudio(idx) {
  const cap = state.captions[idx];
  if (!cap) return;

  const contRec     = findContinuousRec(idx);
  const isStartCell = contRec && idx === contRec.startIdx;

  // Start cell with no edit → convert continuous recording to MP3 and download.
  if (isStartCell && !cap.audioUrl && contRec?.blob) {
    const startNum = state.captions[contRec.startIdx].index;
    const endNum   = state.captions[contRec.endIdx].index;
    showToast('Converting to MP3…', 'info');
    blobToMP3Blob(contRec.blob).then(mp3Blob => {
      const url = URL.createObjectURL(mp3Blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `Track-${startNum}-${endNum}.mp3`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }).catch(err => showToast('MP3 conversion failed: ' + err.message, 'error'));
    return;
  }

  if (!cap.audioUrl) return;

  // Always silence-pad individual cell recordings so the audio aligns
  // to the video timeline at 0:00 — just drop it on the editor timeline.
  downloadSilencePadded(idx);
}

/**
 * Download an edit recording prepended with silence equal to
 * cap.startTime so it aligns to the video timeline at position 0:00.
 */
async function downloadSilencePadded(idx) {
  const cap = state.captions[idx];
  if (!cap || !cap.audioBlob) return;

  showToast('Preparing silence-padded audio…', 'info');

  try {
    const Ctx = window.AudioContext || window['webkitAudioContext'];
    if (!Ctx) throw new Error('Web Audio API not supported');
    const ctx = new Ctx();

    const arrayBuf = await cap.audioBlob.arrayBuffer();
    const editBuf  = await ctx.decodeAudioData(arrayBuf.slice(0));

    // Create a silence buffer matching cap.startTime
    const silenceSamples = Math.round(cap.startTime * editBuf.sampleRate);
    const silenceBuf     = ctx.createBuffer(
      editBuf.numberOfChannels, Math.max(1, silenceSamples), editBuf.sampleRate
    );
    // Channels are zero-filled by default — pure silence.

    const mp3Blob = encodeMP3([silenceBuf, editBuf]);
    ctx.close();

    const url = URL.createObjectURL(mp3Blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `Track-${cap.index}.mp3`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast('Edit audio downloaded', 'success');
  } catch (err) {
    console.error('downloadSilencePadded failed', err);
    showToast('Failed to prepare audio: ' + err.message, 'error');
  }
}

function audioExt(mime) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('mp4'))  return 'm4a';
  if (mime.includes('wav'))  return 'wav';
  return 'webm';
}

/**
 * "All Audio" download — render the ENTIRE dub timeline, exactly as it sits
 * right now, into a single MP3 spanning 0:00 → end of timeline.
 *
 * Every recording is mixed in at its real timeline position with silence
 * filling the gaps:
 *   • Continuous takes start at captions[startIdx].startTime and play straight
 *     through (they were recorded continuously, gaps included).
 *   • Per-cell edit recordings are placed at their caption's startTime.
 * The result is a single file that sounds like playing the timeline top to
 * bottom — start to end — as recorded up to this moment.
 */
async function downloadAllAudio() {
  const contRecs    = state.continuousRecordings;
  const editIndices = [];
  state.captions.forEach((cap, idx) => { if (cap.audioBlob) editIndices.push(idx); });

  if (contRecs.length === 0 && editIndices.length === 0) {
    showToast('No recordings to download', 'info');
    return;
  }

  const Ctx = window.AudioContext || window['webkitAudioContext'];
  if (!Ctx) {
    showToast('Web Audio API not supported in this browser', 'error');
    return;
  }

  showToast('Rendering full dub timeline…', 'info');

  let mp3Blob;
  try {
    mp3Blob = await renderTimelineMixdown(Ctx);
  } catch (err) {
    console.error('Timeline mixdown failed', err);
    showToast('Failed to render timeline: ' + err.message, 'error');
    return;
  }
  if (!mp3Blob) {
    showToast('Nothing to render — no audio on the timeline', 'info');
    return;
  }

  const filename = 'DubTimeline.mp3';

  // Prefer the directory picker so the user controls the destination; fall
  // back to a normal <a> download where the API isn't available.
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const dirHandle  = await window.showDirectoryPicker({ mode: 'readwrite' });
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable   = await fileHandle.createWritable();
      await writable.write(mp3Blob);
      await writable.close();
      showToast(`Saved dub timeline to "${dirHandle.name}" folder`, 'success');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user cancelled — don't proceed
      console.warn('showDirectoryPicker failed, falling back to download link', err);
    }
  }

  const url = URL.createObjectURL(mp3Blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Dub timeline downloaded', 'success');
}

/**
 * Decode every recording, place each at its timeline offset, and mix them
 * down into one MP3 covering 0:00 → end of timeline. Overlapping audio is
 * summed (with clipping protection on encode), so re-records that bleed past
 * a caption boundary still come through cleanly.
 *
 * @returns {Promise<Blob|null>} the MP3 blob, or null if there's no audio.
 */
async function renderTimelineMixdown(Ctx) {
  const ctx = new Ctx();
  try {
    // ── 1. Decode each placed recording into { buf, startTime } ─────────
    const placed = [];

    // Continuous takes start at their first caption's startTime and run straight.
    for (const rec of state.continuousRecordings) {
      if (!rec.blob) continue;
      const arrayBuf = await rec.blob.arrayBuffer();
      const buf      = await ctx.decodeAudioData(arrayBuf.slice(0));
      placed.push({ buf, startTime: state.captions[rec.startIdx].startTime });
    }

    // Per-cell edits placed at their caption's startTime.
    for (const cap of state.captions) {
      if (!cap.audioBlob) continue;
      const arrayBuf = await cap.audioBlob.arrayBuffer();
      const buf      = await ctx.decodeAudioData(arrayBuf.slice(0));
      placed.push({ buf, startTime: cap.startTime });
    }

    if (placed.length === 0) return null;

    // ── 2. Figure out the mixdown geometry ──────────────────────────────
    const sampleRate  = placed[0].buf.sampleRate;
    const numChannels = Math.min(2, Math.max(...placed.map(p => p.buf.numberOfChannels)));

    // End of the timeline: the furthest of the last caption end, the video
    // duration, and the actual tail of every placed recording.
    let endSec = 0;
    const lastCap = state.captions[state.captions.length - 1];
    if (lastCap) endSec = Math.max(endSec, lastCap.endTime);
    if (tl.videoDuration > 0) endSec = Math.max(endSec, tl.videoDuration);
    for (const p of placed) {
      endSec = Math.max(endSec, p.startTime + p.buf.duration);
    }

    const totalFrames = Math.max(1, Math.ceil(endSec * sampleRate));

    // ── 3. Mix every recording into the master buffer at its offset ─────
    const master = [];
    for (let ch = 0; ch < numChannels; ch++) master.push(new Float32Array(totalFrames));

    for (const { buf, startTime } of placed) {
      const offset = Math.round(startTime * sampleRate);
      for (let ch = 0; ch < numChannels; ch++) {
        const src = buf.getChannelData(ch < buf.numberOfChannels ? ch : buf.numberOfChannels - 1);
        const dst = master[ch];
        const n   = Math.min(src.length, totalFrames - offset);
        for (let i = 0; i < n; i++) dst[offset + i] += src[i];
      }
    }

    // ── 4. Wrap the mixed channels in an AudioBuffer and encode ─────────
    const outBuf = ctx.createBuffer(numChannels, totalFrames, sampleRate);
    for (let ch = 0; ch < numChannels; ch++) outBuf.getChannelData(ch).set(master[ch]);

    return encodeMP3([outBuf]);
  } finally {
    ctx.close();
  }
}

/**
 * Encode an array of AudioBuffers into a single 16-bit PCM WAV Blob.
 * All buffers are assumed to be at the first buffer's sample rate —
 * `decodeAudioData` on a shared AudioContext normalizes to the ctx rate,
 * so in practice that's always true here.
 */
function encodeWAV(audioBuffers) {
  const sampleRate  = audioBuffers[0].sampleRate;
  const numChannels = Math.max(...audioBuffers.map(b => b.numberOfChannels));

  let totalFrames = 0;
  for (const b of audioBuffers) totalFrames += b.length;

  const bytesPerSample = 2;
  const dataSize       = totalFrames * numChannels * bytesPerSample;
  const buffer         = new ArrayBuffer(44 + dataSize);
  const view           = new DataView(buffer);

  // ── RIFF / WAVE header ─────────────────────────────
  writeAscii(view, 0,  'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8,  'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                                   // PCM chunk size
  view.setUint16(20, 1, true);                                    // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);         // block align
  view.setUint16(34, 16, true);                                   // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // ── Interleaved sample data ────────────────────────
  let offset = 44;
  for (const buf of audioBuffers) {
    const channels = [];
    for (let c = 0; c < numChannels; c++) {
      // If this clip has fewer channels than the target, duplicate the
      // last available channel so mono clips expand cleanly to stereo.
      const srcIdx = c < buf.numberOfChannels ? c : buf.numberOfChannels - 1;
      channels.push(buf.getChannelData(srcIdx));
    }
    for (let i = 0; i < buf.length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let s = channels[c][i];
        if (s > 1)  s = 1;
        if (s < -1) s = -1;
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Encode an array of AudioBuffers into a single MP3 Blob using lamejs.
 * All buffers are concatenated before encoding.
 */
function encodeMP3(audioBuffers) {
  const sampleRate  = audioBuffers[0].sampleRate;
  const numChannels = Math.min(2, Math.max(...audioBuffers.map(b => b.numberOfChannels)));
  const bitrate     = 128;

  // Merge buffers per channel
  let totalFrames = 0;
  for (const b of audioBuffers) totalFrames += b.length;

  const merged = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const arr = new Float32Array(totalFrames);
    let off = 0;
    for (const b of audioBuffers) {
      const srcCh = ch < b.numberOfChannels ? ch : b.numberOfChannels - 1;
      arr.set(b.getChannelData(srcCh), off);
      off += b.length;
    }
    merged.push(arr);
  }

  // Float32 → Int16
  function toInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  const encoder  = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
  const mp3Parts = [];
  const blockSize = 1152;

  for (let i = 0; i < totalFrames; i += blockSize) {
    let buf;
    if (numChannels === 1) {
      buf = encoder.encodeBuffer(toInt16(merged[0].subarray(i, i + blockSize)));
    } else {
      buf = encoder.encodeBuffer(
        toInt16(merged[0].subarray(i, i + blockSize)),
        toInt16(merged[1].subarray(i, i + blockSize))
      );
    }
    if (buf.length > 0) mp3Parts.push(new Uint8Array(buf));
  }
  const tail = encoder.flush();
  if (tail.length > 0) mp3Parts.push(new Uint8Array(tail));

  return new Blob(mp3Parts, { type: 'audio/mp3' });
}

/**
 * Process a single-cell recording blob: trim the pre-roll silence from the
 * beginning, optionally speed it up (pitch-preserving resample), then encode
 * as MP3 and assign to the caption. This runs after recorder.onstop fires.
 */
async function processSingleCellRecording(blob, mime, cap, idx, preRollMs, speedFactor) {
  const Ctx = window.AudioContext || window['webkitAudioContext'];
  if (!Ctx) {
    // Web Audio not available — fall back to raw blob
    if (cap.audioUrl) URL.revokeObjectURL(cap.audioUrl);
    cap.audioBlob = blob;
    cap.audioMime = mime;
    cap.audioUrl  = URL.createObjectURL(blob);
    cap._wave     = null;
    updateRowRecordUI(idx);
    renderTimeline();
    return;
  }

  const ctx = new Ctx();
  const arrayBuf = await blob.arrayBuffer();
  const srcBuf   = await ctx.decodeAudioData(arrayBuf.slice(0));
  ctx.close();

  const sampleRate  = srcBuf.sampleRate;
  const numChannels = srcBuf.numberOfChannels;
  const trimSamples = Math.min(
    srcBuf.length,
    Math.round((preRollMs / 1000) * sampleRate)
  );
  const afterTrimLen = srcBuf.length - trimSamples;
  if (afterTrimLen <= 0) {
    showToast('Recording too short — please try again', 'error');
    return;
  }

  // Resample if speeding up (factor > 1 means shorter audio).
  const needSpeed = speedFactor > 1;
  const finalLen  = needSpeed ? Math.ceil(afterTrimLen / speedFactor) : afterTrimLen;

  // Build the final AudioBuffer directly
  const offlineCtx = new OfflineAudioContext(numChannels, finalLen, sampleRate);
  const outBuf     = offlineCtx.createBuffer(numChannels, finalLen, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const srcData = srcBuf.getChannelData(ch);
    const outData = outBuf.getChannelData(ch);

    if (needSpeed) {
      // Linear-interpolation resample starting from trimSamples offset
      for (let i = 0; i < finalLen; i++) {
        const srcPos = trimSamples + i * speedFactor;
        const lo     = Math.floor(srcPos);
        const hi     = Math.min(lo + 1, srcBuf.length - 1);
        const frac   = srcPos - lo;
        outData[i]   = srcData[lo] + frac * (srcData[hi] - srcData[lo]);
      }
    } else {
      // Plain copy from trimSamples onwards
      for (let i = 0; i < finalLen; i++) {
        outData[i] = srcData[trimSamples + i];
      }
    }
  }

  const mp3Blob = encodeMP3([outBuf]);
  if (cap.audioUrl) URL.revokeObjectURL(cap.audioUrl);
  cap.audioBlob = mp3Blob;
  cap.audioMime = 'audio/mp3';
  cap.audioUrl  = URL.createObjectURL(mp3Blob);
  cap._wave     = null;
  updateRowRecordUI(idx);

  // Fill the timeline pill immediately, then draw the waveform once decoded.
  renderTimeline();
  buildWaveForCaption(idx);

  const msg = needSpeed
    ? `Recording saved (sped up ${speedFactor.toFixed(1)}x)`
    : 'Recording saved';
  showToast(msg, 'success');
}

/**
 * Speed up an audio Blob by the given factor WITHOUT changing pitch.
 * Uses linear-interpolation resampling: drops samples to shorten the
 * audio while keeping the same sample rate, so pitch stays natural.
 * factor > 1 means faster (shorter). Returns a new MP3 Blob.
 */
async function speedUpAudio(blob, factor) {
  if (!factor || factor <= 1) return blob;
  const Ctx = window.AudioContext || window['webkitAudioContext'];
  const ctx = new Ctx();
  const arrayBuf = await blob.arrayBuffer();
  const srcBuf   = await ctx.decodeAudioData(arrayBuf.slice(0));
  ctx.close();

  const numChannels = srcBuf.numberOfChannels;
  const srcLength   = srcBuf.length;
  const newLength   = Math.ceil(srcLength / factor);
  const sampleRate  = srcBuf.sampleRate;

  // Create an output AudioBuffer at the SAME sample rate (preserves pitch)
  const offlineCtx = new OfflineAudioContext(numChannels, newLength, sampleRate);
  const outBuf     = offlineCtx.createBuffer(numChannels, newLength, sampleRate);

  // Resample each channel via linear interpolation
  for (let ch = 0; ch < numChannels; ch++) {
    const srcData = srcBuf.getChannelData(ch);
    const outData = outBuf.getChannelData(ch);
    for (let i = 0; i < newLength; i++) {
      const srcPos = i * factor;
      const lo     = Math.floor(srcPos);
      const hi     = Math.min(lo + 1, srcLength - 1);
      const frac   = srcPos - lo;
      outData[i]   = srcData[lo] + frac * (srcData[hi] - srcData[lo]);
    }
  }

  const mp3Blob = encodeMP3([outBuf]);
  return mp3Blob;
}

/**
 * Decode any audio Blob (webm, ogg, etc.) and re-encode it as MP3.
 */
async function blobToMP3Blob(blob) {
  const Ctx = window.AudioContext || window['webkitAudioContext'];
  const ctx  = new Ctx();
  const arrayBuf = await blob.arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  ctx.close();
  return encodeMP3([audioBuf]);
}

let playbackAudio = null;
let playbackIdx = null;

function toggleListen(idx) {
  const cap = state.captions[idx];

  // Resolve URL, start offset within the audio, and duration for this caption.
  let url, startOffset = 0, capDurationMs = null, limitEnd = false;

  if (cap?.audioUrl) {
    // Own edit recording — play from the start, use caption duration for highlights.
    url = cap.audioUrl;
    capDurationMs = (cap.endTime - cap.startTime) * 1000;
  } else {
    const contRec = findContinuousRec(idx);
    if (contRec?.url) {
      // Covered cell — seek into the correct continuous recording.
      url = contRec.url;
      const startCap = state.captions[contRec.startIdx];
      startOffset = Math.max(0, cap.startTime - startCap.startTime);
      capDurationMs = (cap.endTime - cap.startTime) * 1000;
      limitEnd = true;
    }
  }
  if (!url) return;

  const row = rowEl(idx);
  const listenBtn = row?.querySelector('.listen-btn');

  // Stop any existing playback and clean up highlights.
  if (playbackAudio) {
    playbackAudio.pause();
    playbackAudio.ontimeupdate = null;
    rowEl(playbackIdx)?.querySelector('.listen-btn')?.classList.remove('playing');
    clearWordHighlights();
    hideTeleprompter(playbackIdx);

    // Toggle off if same cell.
    if (playbackIdx === idx) {
      playbackAudio = null;
      playbackIdx = null;
      return;
    }
  }

  const audio = new Audio(url);
  playbackAudio = audio;
  playbackIdx   = idx;

  if (startOffset > 0) audio.currentTime = startOffset;

  // For continuous-recording slices, stop at the end of this caption's window.
  if (limitEnd && capDurationMs !== null) {
    const stopAt = startOffset + capDurationMs / 1000;
    audio.ontimeupdate = () => {
      if (audio.currentTime >= stopAt) {
        audio.pause();
        audio.ontimeupdate = null;
        audio.dispatchEvent(new Event('ended'));
      }
    };
  }

  audio.play();
  listenBtn?.classList.add('playing');

  // Show word highlights in the hinglish cell while audio plays.
  showTeleprompter(idx);
  if (capDurationMs !== null) scheduleWordHighlights(idx, capDurationMs);

  audio.onended = () => {
    if (playbackAudio !== audio) return; // stale event after a new playback started
    listenBtn?.classList.remove('playing');
    clearWordHighlights();
    hideTeleprompter(idx);
    playbackAudio = null;
    playbackIdx   = null;
  };
}

// ─────────────────────────────────────────────
// DUB TIMELINE — waveforms + per-caption pills
// ─────────────────────────────────────────────

/** Wire up the timeline canvas, listeners and the per-frame playhead loop. */
function initTimeline() {
  tl.viewport   = document.getElementById('timeline-viewport');
  tl.canvas     = document.getElementById('timeline-canvas');
  tl.playheadEl = document.getElementById('timeline-playhead');
  tl.emptyEl    = document.getElementById('timeline-empty');
  tl.scrollbar  = document.getElementById('timeline-scrollbar');
  tl.thumb      = document.getElementById('timeline-scrollbar-thumb');
  if (!tl.canvas) return;
  tl.ctx = tl.canvas.getContext('2d');

  // Wheel: zoom (centered on cursor); shift / horizontal wheel: pan.
  tl.viewport.addEventListener('wheel', onTimelineWheel, { passive: false });

  // Drag to pan; a click that doesn't move is a seek/select.
  tl.viewport.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    tl.dragging = true;
    tl.dragMoved = false;
    tl.dragStartX = e.clientX;
    tl.dragStartScroll = tl.scrollSec;
  });
  window.addEventListener('mousemove', e => {
    if (!tl.dragging) return;
    const dx = e.clientX - tl.dragStartX;
    if (Math.abs(dx) > 4) tl.dragMoved = true;
    tl.scrollSec = tl.dragStartScroll - dx / tl.pxPerSec;
    clampTimelineScroll();
    renderTimeline();
  });
  window.addEventListener('mouseup', e => {
    if (!tl.dragging) return;
    tl.dragging = false;
    if (!tl.dragMoved) {
      const rect = tl.viewport.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x >= 0 && x <= tl.cssW) onTimelineClick(x);
    }
  });

  // Scrollbar thumb drag.
  tl.thumb.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const track = tl.scrollbar;
    const tw = track.clientWidth;
    const startX = e.clientX;
    const startScroll = tl.scrollSec;
    const move = ev => {
      const dx = ev.clientX - startX;
      tl.scrollSec = startScroll + (dx / Math.max(1, tw)) * tl.duration;
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

  if (window.ResizeObserver) {
    new ResizeObserver(() => resizeTimeline()).observe(tl.viewport);
  } else {
    window.addEventListener('resize', resizeTimeline);
  }

  resizeTimeline();
  timelineTick();
}

/** Total timeline length: whichever is longer — the video or the last caption. */
function timelineDuration() {
  let last = 0;
  for (const c of state.captions) if (c.endTime > last) last = c.endTime;
  return Math.max(tl.videoDuration || 0, last, 1);
}

function recomputeTimelineBounds() {
  tl.duration    = timelineDuration();
  tl.minPxPerSec = tl.cssW > 0 ? tl.cssW / tl.duration : 1;
  if (tl.pxPerSec < tl.minPxPerSec) tl.pxPerSec = tl.minPxPerSec;
  if (tl.pxPerSec > tl.maxPxPerSec) tl.pxPerSec = tl.maxPxPerSec;
}

/** Reset zoom to fit the whole timeline and scroll back to 0. */
function fitTimeline() {
  recomputeTimelineBounds();
  tl.pxPerSec  = tl.minPxPerSec;
  tl.scrollSec = 0;
  tl.userZoomed = false;
  renderTimeline();
}

function clampTimelineScroll() {
  const viewSec = tl.cssW / tl.pxPerSec;
  const maxScroll = Math.max(0, tl.duration - viewSec);
  if (tl.scrollSec < 0) tl.scrollSec = 0;
  if (tl.scrollSec > maxScroll) tl.scrollSec = maxScroll;
}

function resizeTimeline() {
  if (!tl.viewport || !tl.ctx) return;
  const rect = tl.viewport.getBoundingClientRect();
  tl.cssW = rect.width;
  tl.cssH = rect.height;
  tl.dpr  = window.devicePixelRatio || 1;
  tl.canvas.width  = Math.max(1, Math.round(tl.cssW * tl.dpr));
  tl.canvas.height = Math.max(1, Math.round(tl.cssH * tl.dpr));
  tl.canvas.style.width  = tl.cssW + 'px';
  tl.canvas.style.height = tl.cssH + 'px';
  tl.ctx.setTransform(tl.dpr, 0, 0, tl.dpr, 0, 0);
  recomputeTimelineBounds();
  if (!tl.userZoomed) tl.pxPerSec = tl.minPxPerSec;
  clampTimelineScroll();
  renderTimeline();
}

function onTimelineWheel(e) {
  e.preventDefault();
  if (!tl.duration || !tl.pxPerSec) return;

  // Pan when shift is held or the gesture is mostly horizontal.
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    tl.scrollSec += dx / tl.pxPerSec;
    clampTimelineScroll();
    renderTimeline();
    return;
  }

  const rect = tl.viewport.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tUnderCursor = tl.scrollSec + x / tl.pxPerSec;

  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  let np = tl.pxPerSec * factor;
  np = Math.max(tl.minPxPerSec, Math.min(tl.maxPxPerSec, np));
  tl.pxPerSec = np;
  tl.userZoomed = np > tl.minPxPerSec + 1e-6;

  // Keep the time under the cursor fixed in place.
  tl.scrollSec = tUnderCursor - x / np;
  clampTimelineScroll();
  renderTimeline();
}

/** A click (not a drag) on the timeline: seek + select the caption under it. */
function onTimelineClick(x) {
  if (!state.captions.length) return;
  const t = tl.scrollSec + x / tl.pxPerSec;
  const idx = state.captions.findIndex(c => t >= c.startTime && t <= c.endTime);
  if (idx !== -1) {
    selectRow(idx);
    scrollRowToCenter(idx);
    seekVideo(state.captions[idx].startTime, false);
  } else {
    seekVideo(t, false);
  }
}

/** True if this caption has dub audio (own edit or covered by a continuous take). */
function captionHasAudio(idx) {
  const cap = state.captions[idx];
  if (cap && cap.audioUrl) return true;
  return findContinuousRec(idx) !== null;
}

/**
 * Resolve the waveform source for a caption and the peak-bucket range to draw.
 * Edit clips are stretched to fill the caption slot; continuous takes are
 * sliced by the caption's time offset within the take.
 */
function captionWave(idx) {
  const cap = state.captions[idx];
  if (cap && cap.audioBlob && cap._wave) {
    return { wave: cap._wave, b0: 0, b1: cap._wave.peaks.length };
  }
  const rec = findContinuousRec(idx);
  if (rec && rec._wave) {
    const takeStart = state.captions[rec.startIdx].startTime;
    const dur = rec._wave.duration ||
                (state.captions[rec.endIdx].endTime - takeStart) || 1;
    const n = rec._wave.peaks.length;
    let b0 = Math.floor(((cap.startTime - takeStart) / dur) * n);
    let b1 = Math.ceil(((cap.endTime - takeStart) / dur) * n);
    b0 = Math.max(0, Math.min(n - 1, b0));
    b1 = Math.max(b0 + 1, Math.min(n, b1));
    return { wave: rec._wave, b0, b1 };
  }
  return null;
}

/** Decode a blob and reduce it to a normalized peak array for drawing. */
async function computePeaks(blob) {
  const Ctx = window.AudioContext || window['webkitAudioContext'];
  if (!Ctx) throw new Error('Web Audio API not supported');
  const ctx = new Ctx();
  try {
    const arrayBuf = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(arrayBuf.slice(0));
    const ch = buf.getChannelData(0);
    const duration = buf.duration;
    const buckets = Math.min(6000, Math.max(50, Math.round(duration * 200)));
    const peaks = new Float32Array(buckets);
    const size = ch.length / buckets;
    let max = 0;
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * size);
      const e = Math.min(ch.length, Math.floor((b + 1) * size));
      let peak = 0;
      for (let i = s; i < e; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      peaks[b] = peak;
      if (peak > max) max = peak;
    }
    if (max > 0) for (let i = 0; i < buckets; i++) peaks[i] /= max;
    return { peaks, duration };
  } finally {
    ctx.close();
  }
}

async function buildWaveForCaption(idx) {
  const cap = state.captions[idx];
  if (!cap || !cap.audioBlob) return;
  try { cap._wave = await computePeaks(cap.audioBlob); }
  catch (e) { console.warn('Waveform build failed (caption)', e); }
  renderTimeline();
}

async function buildWaveForContinuous(rec) {
  if (!rec || !rec.blob) return;
  try { rec._wave = await computePeaks(rec.blob); }
  catch (e) { console.warn('Waveform build failed (continuous)', e); }
  renderTimeline();
}

function fmtTimelineTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTimelineRuler(ctx, W, rulerH) {
  const sec = tl.scrollSec;
  const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];
  let step = intervals[intervals.length - 1];
  for (const s of intervals) {
    if (s * tl.pxPerSec >= 64) { step = s; break; }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.font = '10px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;

  const firstTick = Math.ceil(sec / step) * step;
  for (let t = firstTick; ; t += step) {
    const x = (t - sec) * tl.pxPerSec;
    if (x > W) break;
    if (x >= 0) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rulerH - 6);
      ctx.stroke();
      ctx.fillText(fmtTimelineTime(t), x + 3, rulerH / 2);
    }
  }
  ctx.beginPath();
  ctx.moveTo(0, rulerH);
  ctx.lineTo(W, rulerH);
  ctx.stroke();
}

function drawTimelineWave(ctx, wsrc, x0, x1, cy, half, W) {
  const { wave, b0, b1 } = wsrc;
  const w = x1 - x0;
  if (w <= 0) return;
  const segN = b1 - b0;
  ctx.fillStyle = '#34C759';
  const startPx = Math.max(0, Math.floor(x0));
  const endPx = Math.min(W, Math.ceil(x1));
  const n = wave.peaks.length;
  for (let px = startPx; px < endPx; px++) {
    const frac = (px - x0) / w;
    let bi = b0 + Math.floor(frac * segN);
    if (bi < 0) bi = 0;
    if (bi >= n) bi = n - 1;
    const h = Math.max(0.6, wave.peaks[bi] * half);
    ctx.fillRect(px, cy - h, 1, 2 * h);
  }
}

/** Full canvas repaint: ruler, then each caption's pill + waveform. */
function renderTimeline() {
  const ctx = tl.ctx;
  if (!ctx) return;
  const W = tl.cssW, H = tl.cssH;
  ctx.clearRect(0, 0, W, H);

  const hasCaps = state.captions.length > 0;
  if (tl.emptyEl) tl.emptyEl.classList.toggle('hidden', hasCaps);
  if (!hasCaps) { updateTimelineScrollbar(); return; }

  const rulerH = 20;
  const pillH = 12;
  const pad = 8;
  const pillTop = H - pillH - pad;
  const waveTop = rulerH + 6;
  const waveBottom = pillTop - 6;
  const waveCenter = (waveTop + waveBottom) / 2;
  const halfWave = Math.max(2, (waveBottom - waveTop) / 2);

  drawTimelineRuler(ctx, W, rulerH);

  for (let i = 0; i < state.captions.length; i++) {
    const cap = state.captions[i];
    const x0 = (cap.startTime - tl.scrollSec) * tl.pxPerSec;
    const x1 = (cap.endTime - tl.scrollSec) * tl.pxPerSec;
    if (x1 < 0 || x0 > W) continue;

    const has = captionHasAudio(i);
    const selected = state.selectedRow === i;

    // Pill
    const px0 = Math.max(0, x0);
    const px1 = Math.min(W, x1);
    const pw = Math.max(2, px1 - px0);
    roundRectPath(ctx, px0, pillTop, pw, pillH, pillH / 2);
    ctx.fillStyle = has ? '#34C759' : 'rgba(0,0,0,0.08)';
    ctx.fill();
    if (selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0071e3';
      ctx.stroke();
    }

    // Waveform
    if (has) {
      const wsrc = captionWave(i);
      if (wsrc) {
        drawTimelineWave(ctx, wsrc, x0, x1, waveCenter, halfWave, W);
      } else {
        // Audio present but peaks not computed yet — faint placeholder line.
        ctx.fillStyle = 'rgba(52,199,89,0.3)';
        ctx.fillRect(px0, waveCenter - 1, pw, 2);
      }
    }
  }

  updateTimelineScrollbar();
}

function updateTimelineScrollbar() {
  if (!tl.scrollbar || !tl.thumb) return;
  const dur = tl.duration || 1;
  const viewSec = tl.cssW / tl.pxPerSec;
  const frac = Math.min(1, viewSec / dur);

  if (frac >= 1 || !isFinite(frac)) {
    tl.scrollbar.classList.add('disabled');
    tl.thumb.style.width = '100%';
    tl.thumb.style.left = '0';
    return;
  }
  tl.scrollbar.classList.remove('disabled');
  const tw = tl.scrollbar.clientWidth;
  const thumbW = Math.max(24, tw * frac);
  const maxLeft = tw - thumbW;
  const left = Math.min(maxLeft, Math.max(0, (tl.scrollSec / dur) * tw));
  tl.thumb.style.width = thumbW + 'px';
  tl.thumb.style.left = left + 'px';
}

/** Per-frame loop: keep the playhead synced to the video and follow playback. */
function timelineTick() {
  tl.rafId = requestAnimationFrame(timelineTick);
  if (!tl.ctx) return;

  // Pick up the real video duration once the player reports it.
  if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
    const d = ytPlayer.getDuration() || 0;
    if (d > 0 && Math.abs(d - tl.videoDuration) > 0.5) {
      tl.videoDuration = d;
      recomputeTimelineBounds();
      if (!tl.userZoomed) fitTimeline();
      else { clampTimelineScroll(); renderTimeline(); }
    }
  }

  updateTimelinePlayhead();
  syncTimelinePlayBtn();
}

function updateTimelinePlayhead() {
  const ph = tl.playheadEl;
  if (!ph) return;
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function' || tl.duration <= 0) {
    ph.classList.add('hidden');
    return;
  }
  const t = ytPlayer.getCurrentTime() || 0;
  const playing = typeof ytPlayer.getPlayerState === 'function' &&
                  ytPlayer.getPlayerState() === 1;

  // While playing, scroll to keep the playhead on screen.
  if (playing) {
    const x = (t - tl.scrollSec) * tl.pxPerSec;
    if (x < 0 || x > tl.cssW) {
      tl.scrollSec = Math.max(0, t - (tl.cssW * 0.15) / tl.pxPerSec);
      clampTimelineScroll();
      renderTimeline();
    }
  }

  const x = (t - tl.scrollSec) * tl.pxPerSec;
  if (x >= 0 && x <= tl.cssW) {
    ph.style.left = x + 'px';
    ph.classList.remove('hidden');
  } else {
    ph.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────
// INIT — WIRE UP EVENTS
// ─────────────────────────────────────────────

function init() {

  // ── SRT Upload ──────────────────────────────
  el.uploadBtn.addEventListener('click', () => el.srtFileInput.click());

  // Delegated handler for the empty-state "Upload SRT File" button
  // (works for both the initial static HTML and dynamically re-rendered empty states)
  el.captionTable.addEventListener('click', e => {
    if (e.target.id === 'upload-btn-empty') el.srtFileInput.click();
  });

  el.srtFileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    el.videoTitle.textContent = file.name.replace(/\.srt$/i, '');

    const reader = new FileReader();
    reader.onload = ev => {
      state.captions    = parseSRT(ev.target.result);
      state.selectedRow = null;
      // New source file — the old resume point no longer means anything
      setBookmark(null);
      renderTable();
      fitTimeline();
      if (state.captions.length) {
        showToast(`Loaded ${state.captions.length} captions`, 'success');
      } else {
        showToast('No captions found — check SRT format', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // allow re-upload of same file
  });

  // ── Hinglish SRT Upload ──────────────────────────────
  if (el.uploadHinglishBtn && el.hinglishSrtFileInput) {
    el.uploadHinglishBtn.addEventListener('click', () => el.hinglishSrtFileInput.click());

    el.hinglishSrtFileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = ev => {
        const hinglishCaptions = parseSRT(ev.target.result);
        if (!hinglishCaptions.length) {
          showToast('No captions found in Hinglish SRT', 'error');
          return;
        }

        let matched = 0;
        hinglishCaptions.forEach(hinglishCap => {
          const matchingEngCap = state.captions.find(c => c.index === hinglishCap.index);
          // Only overwrite if text exists
          if (matchingEngCap && hinglishCap.text) {
            matchingEngCap.hinglish = hinglishCap.text;
            matched++;
          }
        });

        renderTable();
        if (matched > 0) {
          showToast(`Loaded ${matched} Hinglish captions`, 'success');
        } else {
          showToast('No matching captions found to update', 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = ''; // allow re-upload of same file
    });
  }

  // ── YouTube URL ─────────────────────────────
  function handleYTUrl() {
    const url = el.youtubeUrl.value.trim();
    if (!url) return;
    const vid = extractVideoId(url);
    if (vid) embedYouTube(vid);
    else showToast('Could not find a valid YouTube video ID', 'error');
  }

  el.youtubeUrl.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleYTUrl();
  });
  el.youtubeUrl.addEventListener('paste', () => setTimeout(handleYTUrl, 60));

  // ── Translation ─────────────────────────────
  el.translateBtn.addEventListener('click', translateAll);

  // ── Re-translation ──────────────────────────
  el.verify90Btn.addEventListener('click',  () => retranslateSelected(90));
  el.verify100Btn.addEventListener('click', () => retranslateSelected(100));

  // ── Settings Modal ──────────────────────────
  el.settingsBtn.addEventListener('click', () => {
    el.apiKeyInput.value = state.apiKey;
    el.settingsModal.classList.remove('hidden');
    el.apiKeyInput.focus();
  });

  function closeModal() { el.settingsModal.classList.add('hidden'); }
  el.closeSettings.addEventListener('click', closeModal);
  el.cancelSettings.addEventListener('click', closeModal);
  el.settingsModal.addEventListener('click', e => {
    if (e.target === el.settingsModal) closeModal();
  });

  el.saveApiKey.addEventListener('click', () => {
    state.apiKey = el.apiKeyInput.value.trim();
    localStorage.setItem('openai_api_key', state.apiKey);
    closeModal();
    showToast('API key saved', 'success');
    updateButtons();
  });
  el.apiKeyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') el.saveApiKey.click();
  });

  // ── Keyboard shortcuts modal ────────────────
  // Show ⌘ instead of Ctrl on Mac (the handler accepts either)
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    el.shortcutsModal.querySelectorAll('kbd').forEach(k => {
      if (k.textContent.trim() === 'Ctrl') k.textContent = '⌘';
    });
  }

  function openShortcuts()  { el.shortcutsModal.classList.remove('hidden'); el.closeShortcuts.focus(); }
  function closeShortcuts() { el.shortcutsModal.classList.add('hidden'); }

  if (el.shortcutsBtn) el.shortcutsBtn.addEventListener('click', openShortcuts);
  if (el.closeShortcuts) el.closeShortcuts.addEventListener('click', closeShortcuts);
  if (el.shortcutsModal) {
    el.shortcutsModal.addEventListener('click', e => {
      if (e.target === el.shortcutsModal) closeShortcuts();
    });
  }

  // ── Bookmark / resume ───────────────────────
  if (el.resumeBtn) el.resumeBtn.addEventListener('click', goToBookmark);

  // ── Draft & Export ───────────────────────────
  el.saveDraftBtn.addEventListener('click', saveDraft);
  el.submitBtn.addEventListener('click', exportSRT);
  if (el.downloadAllAudioBtn) {
    el.downloadAllAudioBtn.addEventListener('click', downloadAllAudio);
  }

  // ── Recording ────────────────────────────────
  refreshMicList();
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => refreshMicList());
  }
  el.micSelect.addEventListener('change', e => {
    state.selectedMicId = e.target.value;
    localStorage.setItem('selected_mic', state.selectedMicId);
  });

  // ── Pace slider ──────────────────────────────
  if (el.paceSlider) {
    const saved = localStorage.getItem('recording_pace');
    if (saved) {
      state.recordingPace = parseFloat(saved);
      el.paceSlider.value = Math.round(state.recordingPace * 100);
      el.paceValue.textContent = state.recordingPace.toFixed(1) + 'x';
    }
    el.paceSlider.addEventListener('input', e => {
      state.recordingPace = parseInt(e.target.value, 10) / 100;
      el.paceValue.textContent = state.recordingPace.toFixed(1) + 'x';
      localStorage.setItem('recording_pace', state.recordingPace);
    });
  }
  el.stopRecordingBtn.addEventListener('click', stopRecording);
  if (el.recordAllBtn) {
    el.recordAllBtn.addEventListener('click', () => {
      if (state.selectedRow !== null) {
        startRecordingFrom(state.selectedRow, true);
      }
    });
  }
  // ── Keyboard shortcuts ───────────────────────
  document.addEventListener('keydown', e => {
    // Escape stops any active recording, regardless of focus
    if (e.key === 'Escape' && state.isRecording) {
      e.preventDefault();
      stopRecording();
      return;
    }

    // Escape also dismisses whichever modal is open
    if (e.key === 'Escape') {
      if (!el.shortcutsModal.classList.contains('hidden')) {
        closeShortcuts();
        return;
      }
      if (!el.settingsModal.classList.contains('hidden')) {
        closeModal();
        return;
      }
    }

    const tag = document.activeElement?.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'INPUT';

    // ── Bookmark ────────────────────────────────
    // Clicking a caption row puts focus in its Hinglish textarea, so the
    // usual "ignore keys while typing" rule would make a plain-letter
    // shortcut unreachable in normal use. Ctrl/Cmd+B works everywhere,
    // including mid-edit; plain B is the shorthand when not typing.
    const bookmarkKey = (e.key === 'b' || e.key === 'B');

    if (bookmarkKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) goToBookmark();
      else if (state.selectedRow !== null) toggleBookmark(state.selectedRow);
      else showToast('Select a caption first', 'info');
      return;
    }

    // Don't intercept plain keys while the user is typing
    if (typing) return;

    // ? — keyboard shortcut help
    if (e.key === '?') {
      e.preventDefault();
      if (el.shortcutsModal.classList.contains('hidden')) openShortcuts();
      else closeShortcuts();
      return;
    }

    // B — bookmark the selected caption; Shift+B — jump to the bookmark
    if (bookmarkKey) {
      e.preventDefault();
      if (e.shiftKey) {
        goToBookmark();
      } else if (state.selectedRow !== null) {
        toggleBookmark(state.selectedRow);
      } else {
        showToast('Select a caption first', 'info');
      }
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      toggleVideoPlayback();
      return;
    }

    if ((e.key === 'r' || e.key === 'R') && state.selectedRow !== null && !state.isRecording) {
      e.preventDefault();
      startRecordingFrom(state.selectedRow, true);
      return;
    }

    if ((e.key === 'e' || e.key === 'E') && state.selectedRow !== null && !state.isRecording) {
      e.preventDefault();
      startRecordingFrom(state.selectedRow, false);
      return;
    }

    if (e.key === 'ArrowDown' && state.selectedRow !== null) {
      e.preventDefault();
      const next = Math.min(state.selectedRow + 1, state.captions.length - 1);
      selectRow(next);
      rowEl(next)?.scrollIntoView({ block: 'nearest' });
    }

    if (e.key === 'ArrowUp' && state.selectedRow !== null) {
      e.preventDefault();
      const prev = Math.max(state.selectedRow - 1, 0);
      selectRow(prev);
      rowEl(prev)?.scrollIntoView({ block: 'nearest' });
    }

    // 9 = re-translate selected (90% mode), 0 = re-translate selected (100% mode)
    if (e.key === '9' && state.selectedRow !== null) retranslateSelected(90);
    if (e.key === '0' && state.selectedRow !== null) retranslateSelected(100);
  });

  // ── Timeline play/pause button ───────────────
  if (el.timelinePlayBtn) {
    el.timelinePlayBtn.addEventListener('click', toggleVideoPlayback);
  }

  // ── Bootstrap ───────────────────────────────
  loadYTApi();
  initTimeline();
  loadDraft();
  updateButtons();
}

document.addEventListener('DOMContentLoaded', init);
