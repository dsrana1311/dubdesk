/**
 * DubDesk — ui.js
 * Behaviour of the interface shell: theme, menus, the pace slider's glass thumb,
 * dialogs, and drag-and-drop. Translation, recording and playback stay in app.js.
 */

'use strict';

(() => {
  const root = document.documentElement;

  // ── Floating chrome sizes ─────────────────────
  // Captions scroll under the bar and dock, so the list's padding has to track
  // their real height, which changes when they wrap on narrow windows.
  const measured = [
    [document.getElementById('top-bar'), '--bar-h'],
    [document.getElementById('record-dock'), '--dock-h'],
  ];
  const measure = () => {
    measured.forEach(([element, property]) => {
      root.style.setProperty(property, `${element.offsetHeight}px`);
    });
  };
  new ResizeObserver(measure).observe(measured[0][0]);
  new ResizeObserver(measure).observe(measured[1][0]);
  measure();

  // ── Theme ─────────────────────────────────────
  const themeSwitch = document.getElementById('theme-switch');
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function showTheme(theme) {
    root.dataset.theme = theme;
    themeSwitch.setAttribute('aria-checked', String(theme === 'dark'));
    themeColor.content = theme === 'dark' ? '#0c0c0c' : '#f5f5f7';
    window.dispatchEvent(new Event('dubdesk:themechange'));
  }

  themeSwitch.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    showTheme(next);
    try { localStorage.setItem('dubdesk_theme', next); } catch { /* still applies for this visit */ }
  });
  showTheme(root.dataset.theme === 'light' ? 'light' : 'dark');

  // ── Press to lift ─────────────────────────────
  // Holding the switch or slider lifts its thumb into a clear lens over the track.
  function liftOnPress(control, lifted) {
    const drop = () => lifted.removeAttribute('data-lifted');
    control.addEventListener('pointerdown', () => lifted.setAttribute('data-lifted', ''));
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
  }

  liftOnPress(themeSwitch, themeSwitch);

  // ── Menus ─────────────────────────────────────
  let openMenu = null;

  const menuItems = menu =>
    [...menu.querySelectorAll('.menu-item')].filter(item => !item.classList.contains('hidden'));

  function closeMenu({ refocus = false } = {}) {
    if (!openMenu) return;
    const trigger = openMenu.querySelector('[data-menu-trigger]');
    openMenu.querySelector('.menu-pop').hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
    openMenu = null;
  }

  function showMenu(menu, { focusFirst = false } = {}) {
    closeMenu();
    menu.querySelector('.menu-pop').hidden = false;
    menu.querySelector('[data-menu-trigger]').setAttribute('aria-expanded', 'true');
    openMenu = menu;
    if (focusFirst) menuItems(menu)[0]?.focus();
  }

  document.querySelectorAll('[data-menu]').forEach(menu => {
    const trigger = menu.querySelector('[data-menu-trigger]');
    trigger.addEventListener('click', e => {
      if (openMenu === menu) closeMenu();
      else showMenu(menu, { focusFirst: e.detail === 0 }); // detail 0: keyboard press
    });
    menu.querySelector('.menu-pop').addEventListener('click', e => {
      if (e.target.closest('.menu-item')) closeMenu();
    });
  });

  document.addEventListener('pointerdown', e => {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  });

  // ── Dialogs ───────────────────────────────────
  const modals = [...document.querySelectorAll('.modal')];
  const openModal = () => modals.find(modal => !modal.classList.contains('hidden'));
  const focusable =
    'button:not([disabled]):not(.hidden), input:not([disabled]):not([type="hidden"]), a[href], select:not([disabled])';

  // Hand focus back to whatever opened a dialog once it closes. The opener is
  // noted before the event reaches app.js, which moves focus into the dialog.
  let opener = null;
  const noteOpener = () => {
    if (!openModal()) opener = document.activeElement;
  };
  window.addEventListener('click', noteOpener, true);
  window.addEventListener('keydown', noteOpener, true);

  let modalWasOpen = false;
  new MutationObserver(() => {
    const open = Boolean(openModal());
    if (modalWasOpen && !open && opener?.isConnected) opener.focus();
    modalWasOpen = open;
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  // ── Keyboard ──────────────────────────────────
  // Runs before app.js's global shortcuts, so they can't fire behind an open
  // dialog or menu, or swallow Space on a control reached with the keyboard.
  window.addEventListener('keydown', e => {
    if (openMenu) {
      const items = menuItems(openMenu);
      const at = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        closeMenu({ refocus: true });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        items[(at + step + items.length) % items.length]?.focus();
      } else if (e.key === 'Tab') {
        closeMenu();
      }
      e.stopPropagation();
      return;
    }

    const modal = openModal();
    if (modal) {
      if (e.key === 'Tab') {
        const stops = [...modal.querySelectorAll(focusable)];
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      // Escape and "?" still reach app.js, which closes the dialog.
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (e.key !== 'Escape' && (e.key !== '?' || typing)) e.stopPropagation();
      return;
    }

    const active = document.activeElement;
    const keyboardFocused = active?.matches?.(':focus-visible');
    if (e.key === ' ' && keyboardFocused && active.matches('button, select, a[href]')) {
      e.stopPropagation();
    }
  }, true);

  // ── Resizable panes ───────────────────────────
  // One bar between the captions and the video side, and two on the video
  // side: video | caption band | timeline. Drag them, nudge them with the
  // arrow keys, or double-click one to put it back. The width is kept as a
  // share of the window and the video as a share of its column, so the
  // layout holds when the window changes size; all of it is remembered.
  const LAYOUT_KEY = 'dubdesk_layout';
  const LAYOUT_DEFAULT = { left: 58, video: null, band: 96 };
  const MIN = { left: 360, right: 340, video: 90, band: 46, timeline: 140 };
  const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const main = document.querySelector('.main-content');
  const playerPanel = document.querySelector('.player-panel');
  const videoPane = document.querySelector('.player-video');
  const bandPane = document.getElementById('rythmo');
  const splitCol = document.getElementById('split-col');
  const splitVideo = document.getElementById('split-video');
  const splitBand = document.getElementById('split-band');

  const layout = { ...LAYOUT_DEFAULT };
  try { Object.assign(layout, JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')); } catch { /* defaults */ }

  function applyLayout() {
    root.style.setProperty('--pane-left', `${layout.left}fr`);
    root.style.setProperty('--pane-right', `${100 - layout.left}fr`);
    root.style.setProperty('--pane-left-pct', String(layout.left));
    root.style.setProperty('--pane-band', `${layout.band}px`);
    if (layout.video) root.style.setProperty('--pane-video', `${layout.video}%`);
    else root.style.removeProperty('--pane-video');
    videoPane.classList.toggle('user-sized', !!layout.video);
    splitCol.setAttribute('aria-valuenow', String(Math.round(layout.left)));
    splitVideo.setAttribute('aria-valuenow', String(Math.round(videoPane.offsetHeight)));
    splitBand.setAttribute('aria-valuenow', String(layout.band));
  }

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* applies for this visit */ }
  }

  function columnHeight() {
    const cs = getComputedStyle(playerPanel);
    return playerPanel.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  }
  const bandShown = () => !bandPane.classList.contains('hidden');
  const splitsHeight = () => splitVideo.offsetHeight + (bandShown() ? splitBand.offsetHeight : 0);

  function setLeft(pct) {
    const w = main.clientWidth || window.innerWidth;
    const lo = Math.min(50, (MIN.left / w) * 100);
    const hi = Math.max(50, 100 - (MIN.right / w) * 100);
    layout.left = Math.round(clampTo(pct, lo, hi) * 10) / 10;
    applyLayout();
  }

  function setVideo(px) {
    const H = columnHeight();
    const band = bandShown() ? bandPane.offsetHeight : 0;
    const max = Math.max(MIN.video, H - band - splitsHeight() - MIN.timeline);
    layout.video = Math.round((clampTo(px, MIN.video, max) / H) * 1000) / 10;
    applyLayout();
  }

  function setBand(px) {
    const H = columnHeight();
    const max = Math.max(MIN.band, Math.min(280, H - videoPane.offsetHeight - splitsHeight() - MIN.timeline));
    layout.band = Math.round(clampTo(px, MIN.band, max));
    applyLayout();
  }

  function resizable(handle, kind, onMove, onKey, reset) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
      document.body.classList.add('is-resizing', `resizing-${kind}`);
      const move = ev => onMove(ev);
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        document.body.classList.remove('is-resizing', `resizing-${kind}`);
        saveLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('keydown', e => {
      const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      if (!back && !fwd && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') reset();
      else onKey((fwd ? 1 : -1) * (e.shiftKey ? 5 : 1));
      saveLayout();
    });
    handle.addEventListener('dblclick', () => { reset(); saveLayout(); });
  }

  resizable(splitCol, 'col',
    e => setLeft(((e.clientX - main.getBoundingClientRect().left) / main.clientWidth) * 100),
    d => setLeft(layout.left + d * 2),
    () => { layout.left = LAYOUT_DEFAULT.left; applyLayout(); });
  resizable(splitVideo, 'row',
    e => setVideo(e.clientY - videoPane.getBoundingClientRect().top),
    d => setVideo(videoPane.offsetHeight + d * 12),
    () => { layout.video = LAYOUT_DEFAULT.video; applyLayout(); });
  resizable(splitBand, 'row',
    e => setBand(e.clientY - bandPane.getBoundingClientRect().top),
    d => setBand(layout.band + d * 8),
    () => { layout.band = LAYOUT_DEFAULT.band; applyLayout(); });

  applyLayout();

  // ── Timeline play button ──────────────────────
  // It floats over the timeline, whose pointerdown starts a drag or a seek.
  const timelinePlay = document.getElementById('timeline-play-btn');
  timelinePlay.addEventListener('mousedown', e => e.stopPropagation());
  timelinePlay.addEventListener('pointerdown', e => e.stopPropagation());

  // ── Empty state ───────────────────────────────
  document.addEventListener('click', e => {
    if (e.target.id === 'add-key-empty') document.getElementById('settings-btn').click();
  });

  // ── Drag and drop ─────────────────────────────
  const overlay = document.getElementById('drop-overlay');
  const srtInput = document.getElementById('srt-file-input');
  const carriesFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;

  window.addEventListener('dragenter', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', e => {
    if (carriesFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', e => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', e => {
    if (!carriesFiles(e)) return;
    // Always handled here: a file dropped on the page would otherwise navigate
    // away from it and lose unsaved work.
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');

    const file = e.dataTransfer.files[0];
    if (!file || !/\.srt$/i.test(file.name)) {
      showToast('That isn’t an SRT file', 'error');
      return;
    }
    // Dropping is easy to do by accident, so it never replaces open captions.
    if (state.captions.length) {
      showToast('Use Import to replace the open captions', 'info');
      return;
    }
    const files = new DataTransfer();
    files.items.add(file);
    srtInput.files = files.files;
    srtInput.dispatchEvent(new Event('change'));
  });
})();
