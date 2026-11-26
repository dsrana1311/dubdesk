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
  editingRow: null,   // index being edited via the keyboard (E); null when navigating
  apiKey: localStorage.getItem('openai_api_key') || '',
  videoId: null,
  isTranslating: false,

  // Recording lives in studio.js; these two are read across the app.
  isRecording:      false,   // a rehearsal or recording session is running
  selectedMicId:    localStorage.getItem('selected_mic') || '',
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
  recSettingsModal:     document.getElementById('rec-settings-modal'),
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
  downloadAllMp3Btn:    document.getElementById('download-all-mp3-btn'),
  micSelect:            document.getElementById('mic-select'),
  rehearseBtn:          document.getElementById('rehearse-btn'),
  recordLineBtn:        document.getElementById('record-line-btn'),
  recordAllBtn:         document.getElementById('record-all-btn'),
  stopRecordingBtn:     document.getElementById('stop-recording-btn'),
  videoTitle:           document.getElementById('video-title'),
  playerPlaceholder:    document.getElementById('player-placeholder'),
  iframeWrapper:        document.getElementById('youtube-iframe-wrapper'),
  toast:                document.getElementById('toast'),
  timelinePlayBtn:      document.getElementById('timeline-play-btn'),
  criblateBtn:          document.getElementById('criblate-btn'),
  criblateModal:        document.getElementById('criblate-modal'),
  criblateUrlInput:     document.getElementById('criblate-url-input'),
  criblateAutosave:     document.getElementById('criblate-autosave'),
  criblateSummary:      document.getElementById('criblate-summary'),
  criblateStatus:       document.getElementById('criblate-status'),
  criblateBookmarklet:  document.getElementById('criblate-bookmarklet'),
  criblateOpenBtn:      document.getElementById('criblate-open-btn'),
  copyBookmarkletBtn:   document.getElementById('copy-bookmarklet-btn'),
  closeCriblate:        document.getElementById('close-criblate'),
  cancelCriblate:       document.getElementById('cancel-criblate'),
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

// The empty state's markup lives in index.html; keep a copy to restore it.
const EMPTY_STATE_HTML = el.captionTable.innerHTML;

function renderTable() {
  if (state.captions.length === 0) {
    el.captionTable.innerHTML = EMPTY_STATE_HTML;
    return;
  }

  const frag = document.createDocumentFragment();

  state.captions.forEach((cap, idx) => {
    const row = document.createElement('div');
    row.className = 'caption-row';
    row.dataset.index = idx;
    applyRowClass(row, cap);
    if (state.selectedRow === idx) row.classList.add('selected');

    const clip      = activeClipFor(idx);
    const takeCount = takesFor(idx).length;
    const takeNo    = clip ? takesFor(idx).indexOf(clip) + 1 : 0;
    const hasAudio  = !!clip;
    const recTitle  = hasAudio ? 'Record a new take of this line (T)' : 'Record this line (T)';
    cap.verified    = hasAudio;

    const isBookmarked = state.bookmark === idx;
    if (isBookmarked) row.classList.add('bookmarked');

    row.innerHTML = `
      <div class="cell cell-check">
        <span class="row-number">${cap.index}</span>
        <span class="verified-icon">✓</span>
        <button class="take-chip${takeCount > 1 ? '' : ' hidden'}" data-take-index="${idx}"
          title="Take ${takeNo} of ${takeCount} — click for the next take ([ ])">${takeNo}/${takeCount}</button>
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
          <button class="row-btn play-btn" data-time="${cap.startTime}" title="Play this caption in the video" aria-label="Play caption ${cap.index}"></button>
          <button class="row-btn rec-btn${hasAudio ? ' has-recording' : ''}" data-rec-index="${idx}" title="${recTitle}" aria-label="${recTitle}"></button>
          <button class="row-btn listen-btn${hasAudio ? '' : ' hidden'}" data-listen-index="${idx}" title="Listen to this line’s dub on its own (L)" aria-label="Listen to this line’s dub"></button>
          <button class="row-btn dl-btn${hasAudio ? '' : ' hidden'}" data-dl-index="${idx}" title="Download this line, padded to line up from 0:00" aria-label="Download this line’s audio"></button>
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
      rythmo.dirty = true;
      renderTimeline();
      projectChanged();
    });
    // Focusing the textarea by any route (click, Tab, E) is edit mode, so
    // Ctrl+↑/↓ hopping works the same whether you arrived by mouse or keyboard.
    ta.addEventListener('focus', () => {
      selectRow(idx);
      state.editingRow = idx;
      markEditingRow(idx);
    });
    ta.addEventListener('blur', () => {
      if (state.editingRow === idx) {
        state.editingRow = null;
        markEditingRow(null);
      }
    });

    // Exclude-words input: sync to state, select row on focus
    const exclInput = row.querySelector('.exclude-input');
    exclInput.addEventListener('input', e => {
      state.captions[idx].excludeWords = e.target.value;
      projectChanged();
    });
    exclInput.addEventListener('focus', () => selectRow(idx));
    exclInput.addEventListener('click', e => e.stopPropagation());

    // Play button
    row.querySelector('.play-btn')
      .addEventListener('click', e => { e.stopPropagation(); playSegment(cap.startTime, cap.endTime); });

    // Record button — records a new take of this line (earlier takes are kept)
    row.querySelector('.rec-btn')
      .addEventListener('click', e => {
        e.stopPropagation();
        if (state.isRecording) {
          showToast('Stop the current recording first', 'info');
          return;
        }
        startSession('line', idx);
      });

    // Listen button — this line's dub on its own
    row.querySelector('.listen-btn')
      .addEventListener('click', e => { e.stopPropagation(); soloToggle(idx); });

    // Download button — this line's audio, padded from 0:00
    row.querySelector('.dl-btn')
      .addEventListener('click', e => { e.stopPropagation(); downloadLine(idx); });

    // Take chip — step to the next take
    row.querySelector('.take-chip')
      .addEventListener('click', e => {
        e.stopPropagation();
        if (state.selectedRow !== idx) selectRow(idx);
        cycleTake(idx, 1);
      });

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
  onSelectionChanged();
}

// ─────────────────────────────────────────────
// KEYBOARD EDIT MODE
// ─────────────────────────────────────────────
// Two modes drive caption editing from the keyboard:
//   navigate — arrows move the selection between rows, plain-letter shortcuts live
//   edit     — E puts the caret in the row's textarea; arrows now move within the
//              text, and Ctrl+↑/↓ hops to the neighbouring caption *without*
//              leaving edit mode. Escape returns to navigate.

/** The textarea for a row, or null if the row isn't rendered. */
function rowTextarea(idx) {
  return el.captionTable.querySelector(`.hinglish-textarea[data-index="${idx}"]`);
}

/**
 * Enter edit mode on idx: select the row, focus its textarea and park the caret
 * at the start of the text so the user reads/edits from the beginning.
 */
function enterEditMode(idx) {
  if (idx === null || idx < 0 || idx >= state.captions.length) return;

  selectRow(idx);
  const ta = rowTextarea(idx);
  if (!ta) return;

  // focus() synchronously blurs the previously edited row, whose blur handler
  // clears editingRow — so focus first and let its own focus handler set the
  // new index, rather than assigning it here only to have the blur wipe it.
  ta.focus();
  state.editingRow = idx;
  // Caret at the start. Deferred so it survives the browser's own
  // focus handling, which otherwise drops the caret at the end.
  requestAnimationFrame(() => ta.setSelectionRange(0, 0));

  markEditingRow(idx);
  rowEl(idx)?.scrollIntoView({ block: 'nearest' });
}

/** Leave edit mode and hand focus back to the table for row navigation. */
function exitEditMode() {
  if (state.editingRow === null) return;
  const ta = rowTextarea(state.editingRow);
  state.editingRow = null;
  markEditingRow(null);
  ta?.blur();
}

/** Paint the .editing cue on one row, clearing it everywhere else. */
function markEditingRow(idx) {
  el.captionTable.querySelectorAll('.caption-row.editing')
    .forEach(r => r.classList.remove('editing'));
  if (idx !== null) rowEl(idx)?.classList.add('editing');
}

function updateProgress() {
  const total = state.captions.length;
  const done  = state.captions.filter(c => c.verified).length;
  el.progressIndicator.textContent = `${done} / ${total} recorded`;
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
  const canRecord = hasSel && !state.isRecording;
  el.recordAllBtn.disabled  = !canRecord;
  el.recordLineBtn.disabled = !canRecord;
  el.rehearseBtn.disabled   = !canRecord;

  el.translateBtn.title =
    !has ? 'Upload an SRT file first'
    : !hasKey ? 'Add your OpenAI API key in Settings first'
    : 'Translate every caption to Hinglish';
  const retranslateHint =
    !hasKey ? 'Add your OpenAI API key in Settings first'
    : !hasSel ? 'Select a caption first'
    : null;
  el.verify90Btn.title  = retranslateHint || 'Re-translate the selected caption at 90% length (9)';
  el.verify100Btn.title = retranslateHint || 'Re-translate the selected caption at 100% length (0)';
  el.recordAllBtn.title = hasSel
    ? 'Record continuously from the selected caption, line after line (R)'
    : 'Select a caption first';
  el.recordLineBtn.title = hasSel
    ? 'Record the selected line, with pre-roll and cue beeps (T)'
    : 'Select a caption first';
  el.rehearseBtn.title = hasSel
    ? 'Rehearse the selected line: video and prompter, nothing recorded (P)'
    : 'Select a caption first';

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
    avgPctEl.textContent = `· avg ${pct}%`;
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
let pendingSeek = null;   // a seek asked for before the player was ready
let pendingPlay = true;   // …and whether it should play from there

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
  if (state.videoId !== videoId) projectChanged();
  state.videoId = videoId;
  tl.videoDuration = 0;
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
        onPlayerReady();
        if (pendingSeek !== null) {
          // seekTo on a fresh player starts it, so a seek that shouldn't
          // play is parked in the transport until playback begins.
          if (pendingPlay) {
            ytPlayer.seekTo(pendingSeek, true);
            ytPlayer.playVideo();
          } else {
            transport.park(pendingSeek);
          }
          pendingSeek = null;
          pendingPlay = true;
        }
      },
    },
  });
}

// Playback goes through the transport (studio.js): one clock that the
// prompter, timeline and dub audio all follow, with or without a video.

function seekVideo(seconds, play = true) {
  transport.seek(seconds, play);
}

/**
 * Play one caption and stop at its end. The stop watches the transport
 * clock, which only advances once frames actually play, so buffering after
 * the seek never cuts the segment short.
 */
function playSegment(startTime, endTime) {
  if (state.isRecording) return;
  stopSolo();
  transport.playRange(startTime, endTime);
}

function pauseVideo() {
  transport.pause();
}

function toggleVideoPlayback() {
  transport.toggle();
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
    showToast('Add your OpenAI API key in Settings first', 'error');
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
  if (done > 0) {
    rythmo.dirty = true;
    renderTimeline();
    projectChanged();
  }

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
    showToast('Add your OpenAI API key in Settings first', 'error');
    return;
  }

  if (state.isTranslating) return;

  const idx = state.selectedRow;
  const cap = state.captions[idx];

  const isMode90     = mode === 90;
  const systemPrompt = isMode90 ? SYSTEM_PROMPT_90 : SYSTEM_PROMPT_100;
  const button       = isMode90 ? el.verify90Btn : el.verify100Btn;
  const originalText = isMode90 ? '90%' : '100%';

  state.isTranslating = true;
  updateButtons();
  button.textContent = '…';

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
    rythmo.dirty = true;
    renderTimeline();
    projectChanged();

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
  projectChanged();
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
// PROJECT — SAVE & LOAD
// ─────────────────────────────────────────────
// The project (captions, translations, recordings) saves itself to this
// browser as you work; see saveProject() in studio.js. "Save draft" just
// saves right away.

function saveDraft() {
  saveProject(true);
}

async function loadDraft() {
  let d;
  try {
    d = await loadProject();
  } catch (e) {
    console.error('Failed to load the project:', e);
    return;
  }
  if (!d) return;

  state.videoId = d.videoId || null;

  // Bookmark: prefer the project's own value, else the standalone key
  // (which is written on every toggle, so it can be newer than the project).
  if (typeof d.bookmark === 'number' && d.bookmark < state.captions.length) {
    state.bookmark = d.bookmark;
  }
  restoreBookmark();

  if (d.title) el.videoTitle.textContent = d.title;

  if (state.videoId) {
    el.youtubeUrl.value = `https://www.youtube.com/watch?v=${state.videoId}`;
    embedYouTube(state.videoId);
  }

  if (!state.captions.length) return;
  renderTable();
  fitTimeline();
  updateResumeButton();

  const recorded = state.captions.filter(c => c.verified).length;
  const what = recorded ? `${recorded} recorded line${recorded === 1 ? '' : 's'}` : `${state.captions.length} captions`;
  if (state.bookmark !== null) {
    const cap = state.captions[state.bookmark];
    selectRow(state.bookmark);
    // Wait for layout so offsetTop/clientHeight are real before centring
    requestAnimationFrame(() => goToBookmark());
    showToast(`Project restored (${what}) — resuming at #${cap ? cap.index : state.bookmark + 1}`, 'success');
  } else {
    showToast(`Project restored (${what})`, 'success');
  }
  setSaveStatus('saved');
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
// CRIBLATE UPLOAD
// ─────────────────────────────────────────────
//
// A web page can't reach into another site's DOM, so the filling runs on
// criblate.com itself via a bookmarklet (criblateFiller below). DubDesk hands
// it the captions two ways:
//   1. postMessage — DubDesk opens the Criblate tab, so the bookmarklet can ask
//      window.opener for the payload. No prompts, instant.
//   2. Clipboard  — fallback when the opener link is gone (tab opened by hand,
//      or Criblate cuts it). The payload is copied when you click Open.
// Caption N goes into Criblate box N, exactly like the old Auto_Fill.docx flow.

const CRIBLATE_MARK   = 'DUBDESK_CRIBLATE_V1';
const CRIBLATE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*criblate\.com$/i;

let criblatePayload = null;   // payload served to the bookmarklet via postMessage

/**
 * Runs ON criblate.com (as a bookmarklet). Must be fully self-contained:
 * no outer variables, no // comments (it's serialised into a javascript: URL).
 */
function criblateFiller() {
  var MARK = 'DUBDESK_CRIBLATE_V1';
  var BOX_SEL = 'div[data-replicated-value] > textarea';

  var panel = document.getElementById('dubdesk-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'dubdesk-panel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:340px;' +
      'padding:12px 16px;border-radius:10px;background:#1d1d1f;color:#fff;' +
      'font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:pre-line';
    panel.onclick = function () { panel.remove(); };
    document.body.appendChild(panel);
  }
  function say(msg) { panel.textContent = 'DubDesk → Criblate\n' + msg; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function parse(raw) {
    if (!raw || raw.indexOf(MARK) !== 0) return null;
    try { return JSON.parse(raw.slice(MARK.length)); } catch (e) { return null; }
  }

  function fromOpener() {
    return new Promise(function (resolve) {
      if (!window.opener) return resolve(null);
      var done = false;
      function onMsg(ev) {
        if (!ev.data || ev.data.dubdesk !== 'payload') return;
        done = true; window.removeEventListener('message', onMsg); resolve(ev.data.payload);
      }
      window.addEventListener('message', onMsg);
      try { window.opener.postMessage({ dubdesk: 'ready' }, '*'); } catch (e) {}
      setTimeout(function () { if (!done) { window.removeEventListener('message', onMsg); resolve(null); } }, 1500);
    });
  }

  async function fromClipboard() {
    try { return parse(await navigator.clipboard.readText()); } catch (e) { return null; }
  }

  function setValue(ta, text) {
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) {}
    if (!ok || ta.value !== text) {
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, text);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    }
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    if (ta.parentElement) ta.parentElement.setAttribute('data-replicated-value', text);
    ta.blur();
    return ta.value === text;
  }

  function report(msg) {
    try { if (window.opener) window.opener.postMessage(Object.assign({ dubdesk: 'done' }, msg), '*'); } catch (e) {}
  }

  (async function () {
    say('Fetching captions from DubDesk…');
    var data = await fromOpener();
    if (!data) data = await fromClipboard();
    if (!data) data = parse(window.prompt('DubDesk: paste the captions copied from DubDesk (Ctrl+V), then OK.') || '');
    if (!data || !data.captions) { say('No DubDesk captions found. Click "Open Criblate" in DubDesk first, then try again.'); return; }

    say('Waiting for caption boxes…');
    var boxes = [];
    for (var t = 0; t < 60; t++) {
      boxes = Array.prototype.slice.call(document.querySelectorAll(BOX_SEL));
      if (boxes.length) break;
      await sleep(250);
    }
    if (!boxes.length) { say('No caption boxes found on this page. Open the transcript page (…/transcript/current) and try again.'); return; }

    var caps = data.captions;
    if (boxes.length !== caps.length &&
        !window.confirm('DubDesk: Criblate has ' + boxes.length + ' caption boxes but DubDesk sent ' + caps.length +
          ' captions.\n\nThey will be filled in order, so lines may drift out of alignment.\nFill anyway?')) {
      say('Cancelled — caption counts differ (' + boxes.length + ' boxes vs ' + caps.length + ' captions).');
      return;
    }

    var n = Math.min(boxes.length, caps.length), filled = 0, skipped = 0, failed = [];
    for (var i = 0; i < n; i++) {
      if (!caps[i]) { skipped++; continue; }
      if (setValue(boxes[i], caps[i])) filled++; else failed.push(i + 1);
      if (i % 10 === 0) { say('Filling ' + (i + 1) + ' / ' + n + '…'); await sleep(0); }
    }

    await sleep(600);
    var lost = [];
    for (var j = 0; j < n; j++) {
      if (caps[j] && boxes[j].value !== caps[j]) { setValue(boxes[j], caps[j]); if (boxes[j].value !== caps[j]) lost.push(j + 1); }
    }

    var saved = false;
    if (data.autoSave) {
      var btn = Array.prototype.find.call(document.querySelectorAll('button'), function (b) {
        return b.textContent.trim().toLowerCase() === 'save draft' && !b.disabled;
      });
      if (btn) { btn.click(); saved = true; }
    }

    var msg = 'Filled ' + filled + ' of ' + n + ' boxes.';
    if (skipped) msg += '\n' + skipped + (skipped === 1 ? ' empty translation' : ' empty translations') + ' left untouched.';
    if (lost.length) msg += '\n⚠ Not sticking: #' + lost.slice(0, 15).join(', #') + (lost.length > 15 ? '…' : '');
    if (boxes.length !== caps.length) msg += '\n⚠ Count mismatch: ' + boxes.length + ' boxes vs ' + caps.length + ' captions.';
    msg += data.autoSave ? (saved ? '\n✓ Save draft clicked.' : '\n⚠ "Save draft" button not found — save manually.') : '\nRemember to click Save draft.';
    say(msg + '\n(click to dismiss)');
    report({ filled: filled, total: n, boxes: boxes.length, captions: caps.length, lost: lost.length, saved: saved });
  })();
}

function criblateBookmarkletHref() {
  return 'javascript:' + encodeURIComponent('(' + criblateFiller.toString() + ')();void 0');
}

/**
 * Turn whatever the user pasted into the transcript-editor URL.
 * Accepts the transcript URL, a bare criblate.com/video/ID[/lang] URL,
 * or just a video ID.
 */
function normaliseCriblateUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return `https://criblate.com/video/${raw}/hi/transcript/current`;

  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (!/(^|\.)criblate\.com$/i.test(u.hostname)) return null;

  const m = u.pathname.match(/^\/video\/([^/]+)(?:\/([^/]+))?(\/transcript.*)?$/);
  if (!m) return u.href;                              // some other Criblate page — trust it
  if (m[3]) return `https://criblate.com${u.pathname}`;
  return `https://criblate.com/video/${m[1]}/${m[2] || 'hi'}/transcript/current`;
}

/** One caption per Criblate box. Multi-line captions collapse to one line. */
function buildCriblateCaptions() {
  return state.captions.map(c => (c.hinglish || '').replace(/\s+/g, ' ').trim());
}

function setCriblateStatus(msg, kind = '') {
  el.criblateStatus.textContent = msg;
  el.criblateStatus.className = `hint${kind ? ' ' + kind : ''}`;
}

function openCriblateModal() {
  if (!state.captions.length) {
    showToast('Load and translate an SRT first', 'error');
    return;
  }
  const caps    = buildCriblateCaptions();
  const missing = caps.filter(t => !t).length;

  const saved = localStorage.getItem('criblate_url') || '';
  const savedId = (saved.match(/\/video\/([^/]+)/) || [])[1];
  el.criblateUrlInput.value =
    (state.videoId && savedId !== state.videoId)
      ? `https://criblate.com/video/${state.videoId}/hi/transcript/current`
      : saved;

  el.criblateSummary.textContent =
    `${caps.length} captions ready` +
    (missing ? ` — ${missing} ${missing === 1 ? 'has' : 'have'} no translation; those Criblate boxes will be left as they are.` : '.');
  setCriblateStatus('');
  el.criblateModal.classList.remove('hidden');
  el.criblateUrlInput.focus();
  el.criblateUrlInput.select();
}

function closeCriblateModal() { el.criblateModal.classList.add('hidden'); }

async function sendToCriblate() {
  const url = normaliseCriblateUrl(el.criblateUrlInput.value);
  if (!url) {
    setCriblateStatus('Enter a criblate.com video URL (or the 11-character video ID).', 'error');
    return;
  }
  el.criblateUrlInput.value = url;
  localStorage.setItem('criblate_url', url);

  criblatePayload = {
    v: 1,
    captions: buildCriblateCaptions(),
    autoSave: el.criblateAutosave.checked,
    title:    el.videoTitle.textContent,
  };

  // Clipboard copy is the fallback channel; failure here isn't fatal.
  let copied = false;
  try {
    await navigator.clipboard.writeText(CRIBLATE_MARK + JSON.stringify(criblatePayload));
    copied = true;
  } catch (e) {
    console.warn('Clipboard write failed', e);
  }

  // Named window: re-clicking reuses the same Criblate tab instead of piling up tabs.
  const win = window.open(url, 'dubdesk-criblate');
  if (!win) {
    setCriblateStatus('Pop-up blocked — allow pop-ups for DubDesk, or open the URL yourself and click the bookmark.', 'error');
    return;
  }
  setCriblateStatus(
    `Criblate opened${copied ? ' and captions copied' : ''}. Click the “DubDesk → Criblate” bookmark on that tab once it has loaded.`
  );
}

function onCriblateMessage(ev) {
  if (!CRIBLATE_ORIGIN.test(ev.origin) || !ev.data || typeof ev.data !== 'object') return;

  if (ev.data.dubdesk === 'ready') {
    if (!criblatePayload) return;   // nothing queued — bookmarklet falls back to clipboard
    ev.source.postMessage({ dubdesk: 'payload', payload: criblatePayload }, ev.origin);
    return;
  }

  if (ev.data.dubdesk === 'done') {
    const r = ev.data;
    const problems = [];
    if (r.lost)                 problems.push(`${r.lost} didn't stick`);
    if (r.boxes !== r.captions) problems.push(`count mismatch ${r.boxes} vs ${r.captions}`);
    if (!r.saved && criblatePayload?.autoSave) problems.push('draft not saved');
    const msg = `Criblate: filled ${r.filled}/${r.total}` + (problems.length ? ` — ${problems.join(', ')}` : r.saved ? ', draft saved' : '');
    setCriblateStatus(msg, problems.length ? 'error' : 'ok');
    showToast(msg, problems.length ? 'error' : 'success');
  }
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
// CAPTION ROW TELEPROMPTER
// ─────────────────────────────────────────────
// Recording, playback and the timeline live in studio.js, prompter.js and
// timeline.js. While a line is recorded or played back, its Hinglish text is
// swapped for word spans that light up as each word comes due.

function showTeleprompter(idx) {
  const row = rowEl(idx);
  if (!row) return;
  const cell = row.querySelector('.cell-hinglish');
  const ta   = cell?.querySelector('.hinglish-textarea');
  if (!cell || !ta || cell.querySelector('.teleprompter')) return;

  const tp = document.createElement('div');
  tp.className = 'teleprompter';
  (ta.value || '').split(/(\s+)/).forEach(part => {
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
  cell?.querySelector('.teleprompter')?.remove();
  cell?.querySelector('.hinglish-textarea')?.classList.remove('hidden');
  row.classList.remove('recording');
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
    e.target.value = ''; // allow re-upload of same file
    if (!file) return;
    if (state.isRecording) {
      showToast('Stop recording first', 'info');
      return;
    }

    const reader = new FileReader();
    reader.onload = ev => {
      const captions = parseSRT(ev.target.result);
      if (!captions.length) {
        showToast('No captions found — check SRT format', 'error');
        return;
      }
      // A new SRT is a new project; recordings belong to the old captions.
      const recorded = state.captions.filter(c => c.verified).length;
      if (recorded && !window.confirm(
        `Start a new project from “${file.name}”?\n\n` +
        `The ${recorded} recorded line${recorded === 1 ? '' : 's'} in this project will be removed. ` +
        'Export your dub first if you want to keep it.')) {
        return;
      }
      clearRecordings();
      el.videoTitle.textContent = file.name.replace(/\.srt$/i, '');
      state.captions    = captions;
      state.selectedRow = null;
      // New source file — the old resume point no longer means anything
      setBookmark(null);
      renderTable();
      fitTimeline();
      updateInspector();
      projectChanged();
      showToast(`Loaded ${state.captions.length} captions`, 'success');
    };
    reader.readAsText(file);
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
        rythmo.dirty = true;
        renderTimeline();
        if (matched > 0) projectChanged();
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
  el.downloadAllAudioBtn.addEventListener('click', () => exportFullAudio('wav'));
  el.downloadAllMp3Btn.addEventListener('click', () => exportFullAudio('mp3'));

  // ── Criblate upload ──────────────────────────
  el.criblateBookmarklet.href = criblateBookmarkletHref();
  el.criblateBookmarklet.addEventListener('click', e => {
    e.preventDefault();
    showToast('Drag this button to your bookmarks bar, then click it on Criblate', 'info');
  });
  el.copyBookmarkletBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(criblateBookmarkletHref());
      showToast('Bookmarklet code copied — paste it as a new bookmark\'s URL', 'success');
    } catch {
      showToast('Could not access clipboard', 'error');
    }
  });
  el.criblateBtn.addEventListener('click', openCriblateModal);
  el.criblateOpenBtn.addEventListener('click', sendToCriblate);
  el.criblateUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendToCriblate(); });
  el.closeCriblate.addEventListener('click', closeCriblateModal);
  el.cancelCriblate.addEventListener('click', closeCriblateModal);
  el.criblateModal.addEventListener('click', e => { if (e.target === el.criblateModal) closeCriblateModal(); });
  window.addEventListener('message', onCriblateMessage);

  // Recording, the dock, the mixer and the timeline tools are wired in
  // initStudio() (studio.js).

  // ── Keyboard shortcuts ───────────────────────
  document.addEventListener('keydown', e => {
    // Escape stops a recording or rehearsal (keeping the take), regardless of focus
    if (e.key === 'Escape' && (state.isRecording || studio.chainTimer)) {
      e.preventDefault();
      stopSession();
      return;
    }

    if (e.key === 'Escape' && !el.recSettingsModal.classList.contains('hidden')) {
      el.recSettingsModal.classList.add('hidden');
      return;
    }
    if (e.key === 'Escape' && !sd.clipMenu.hidden) {
      closeClipMenu();
      return;
    }

    // Escape leaves keyboard edit mode (no recording in progress at this point)
    if (e.key === 'Escape' && state.editingRow !== null) {
      e.preventDefault();
      exitEditMode();
      return;
    }

    // Ctrl/Cmd + ↑/↓ — hop to the neighbouring caption, staying in edit mode.
    // Handled before the "typing" guard because the caret is inside a textarea.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        (e.ctrlKey || e.metaKey) &&
        state.editingRow !== null) {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next  = state.editingRow + delta;
      if (next < 0 || next >= state.captions.length) return;  // stop at the ends
      enterEditMode(next);
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
      if (!el.criblateModal.classList.contains('hidden')) {
        closeCriblateModal();
        return;
      }
    }

    const tag = document.activeElement?.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';

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

    // Space: play / pause — or, while recording, stop like a tape machine
    if (e.key === ' ') {
      e.preventDefault();
      if (state.isRecording) stopSession();
      else toggleVideoPlayback();
      return;
    }

    if ((e.key === 'r' || e.key === 'R') && state.selectedRow !== null && !state.isRecording) {
      e.preventDefault();
      startSession('flow', state.selectedRow);
      return;
    }

    // T, P, L, [ ], , . A F Del, Ctrl+Z… — recording and clip editing
    if (studioKey(e)) return;

    // E — edit the selected caption's translation from the keyboard
    if ((e.key === 'e' || e.key === 'E') && state.selectedRow !== null && !state.isRecording) {
      e.preventDefault();
      enterEditMode(state.selectedRow);
      return;
    }

    // ↑ / ↓ — previous / next caption, with the playhead cued to its start
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.captions.length && !state.isRecording) {
      e.preventDefault();
      stepCaption(e.key === 'ArrowDown' ? 1 : -1);
      return;
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
  initStudio();
  updateButtons();
  loadDraft();
}

document.addEventListener('DOMContentLoaded', init);
