/**
 * DubDesk — glass.js
 * Liquid Glass refraction for anything marked [data-glass].
 *
 * Each surface gets a displacement map, drawn for its exact size and corners,
 * and an SVG filter that its CSS backdrop-filter picks up through --lg-filter.
 * Near the rim the glass shows what's further in, with the colours splitting
 * slightly. The middle is left untouched, so text passing under stays steady.
 *
 * Only Chromium can use an SVG filter in backdrop-filter. Everywhere else the
 * surfaces keep the plain frosted look from styles.css.
 *
 * The technique and its tuning are adapted from Glisse:
 * https://github.com/0kzh/glisse
 * MIT License, Copyright (c) 2026 Kelvin Zhang
 */

'use strict';

const LiquidGlass = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const BEND = 0.45;        // how far the rim reaches, as a share of the short side
  const RIM_DEPTH = 0.25;   // width of the bending band, as a share of the short side
  const MAX_RIM_DEPTH = 22; // px — keeps long bars from bending deep into their middle
  const DISPERSION = 0.4;   // how far the colour channels split at the rim

  const supported =
    /Chrom(?:e|ium)\//.test(navigator.userAgent) &&
    !matchMedia('(prefers-reduced-transparency: reduce)').matches;

  let defs = null;
  const filters = new Map();   // size key → filter id
  const observed = new Map();  // element → last size key

  function svg(name, attributes) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function defsRoot() {
    if (defs) return defs;
    const root = svg('svg', { width: 0, height: 0, 'aria-hidden': 'true' });
    root.style.cssText = 'position:absolute;pointer-events:none';
    defs = svg('defs', {});
    root.append(defs);
    document.body.append(root);
    return defs;
  }

  /** Signed distance to a rounded box centred on the origin: negative inside. */
  function sdf(x, y, halfW, halfH, radius) {
    const qx = Math.abs(x) - halfW + radius;
    const qy = Math.abs(y) - halfH + radius;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  }

  /** PNG of the bend at each pixel: red pulls across, green pulls down, 128 is none. */
  function drawMap(width, height, radius, depth) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const image = context.createImageData(width, height);
    const { data } = image;
    const halfW = width / 2;
    const halfH = height / 2;

    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const i = (row * width + column) * 4;
        const x = column + 0.5 - halfW;
        const y = row + 0.5 - halfH;
        const edge = sdf(x, y, halfW, halfH, radius);
        let pullX = 128;
        let pullY = 128;

        if (edge < 0 && -edge < depth) {
          const gradX = sdf(x + 1, y, halfW, halfH, radius) - sdf(x - 1, y, halfW, halfH, radius);
          const gradY = sdf(x, y + 1, halfW, halfH, radius) - sdf(x, y - 1, halfW, halfH, radius);
          const length = Math.hypot(gradX, gradY) || 1;
          // A dome's slope: steep at the rim, flat where the band meets the middle.
          const t = 1 + edge / depth;
          const amount = 1 - Math.sqrt(Math.max(0, 1 - t * t));
          pullX = Math.round(127.5 - 127.5 * (gradX / length) * amount);
          pullY = Math.round(127.5 - 127.5 * (gradY / length) * amount);
        }

        data[i] = pullX;
        data[i + 1] = pullY;
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }

  function filterFor(width, height, radius, bend) {
    const key = `${width}x${height}r${radius}b${bend}`;
    if (filters.has(key)) return filters.get(key);

    const short = Math.min(width, height);
    const depth = Math.min(MAX_RIM_DEPTH, short * RIM_DEPTH);
    const href = drawMap(width, height, radius, depth);
    if (!href) return null;

    const box = { x: 0, y: 0, width, height };
    const reach = bend * Math.min(short, MAX_RIM_DEPTH / RIM_DEPTH);
    const id = `lg-glass-${filters.size}`;
    const filter = svg('filter', {
      id,
      ...box,
      filterUnits: 'userSpaceOnUse',
      primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
    });

    filter.append(svg('feImage', { href, ...box, preserveAspectRatio: 'none', result: 'map' }));

    const channels = [
      { name: 'r', spread: 1 + 0.2 * DISPERSION, keep: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0' },
      { name: 'g', spread: 1 + 0.1 * DISPERSION, keep: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0' },
      { name: 'b', spread: 1,                    keep: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' },
    ];
    for (const { name, spread, keep } of channels) {
      filter.append(
        svg('feDisplacementMap', {
          in: 'SourceGraphic',
          in2: 'map',
          scale: reach * spread,
          xChannelSelector: 'R',
          yChannelSelector: 'G',
          result: `${name}-bent`,
        }),
        svg('feColorMatrix', { in: `${name}-bent`, type: 'matrix', values: keep, result: name }),
      );
    }
    filter.append(
      svg('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }),
      svg('feBlend', { in: 'rg', in2: 'b', mode: 'screen' }),
    );

    defsRoot().append(filter);
    filters.set(key, id);
    return id;
  }

  function fit(element) {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (!width || !height) return;

    const style = getComputedStyle(element);
    const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2);
    const bend = parseFloat(element.dataset.glassBend) || BEND;
    const key = `${width}x${height}r${radius}b${bend}`;
    if (observed.get(element) === key) return;
    observed.set(element, key);

    const id = filterFor(width, height, radius, bend);
    if (id) element.style.setProperty('--lg-filter', `url("#${id}") saturate(1.5)`);
  }

  function init() {
    if (!supported) return;
    document.documentElement.dataset.refraction = 'on';

    let pending = new Set();
    let timer = 0;
    const observer = new ResizeObserver(entries => {
      // Dragging a window resizes the bars every frame; redraw once it settles.
      entries.forEach(entry => pending.add(entry.target));
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending.forEach(fit);
        pending = new Set();
      }, 120);
    });

    document.querySelectorAll('[data-glass]').forEach(element => {
      fit(element);
      observer.observe(element);
    });
  }

  return { init };
})();

LiquidGlass.init();
