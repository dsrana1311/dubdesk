/**
 * DubDesk — engine.js
 * The audio engine under the recording workspace.
 *
 *   AudioEngine — one AudioContext and a microphone that stays open ("armed")
 *                 once you've used it, so a take starts the instant you press
 *                 record instead of waiting for the hardware to wake up.
 *                 Samples are captured in an AudioWorklet together with their
 *                 exact position on the audio clock; that is what lets a take
 *                 be placed on the timeline to the millisecond.
 *   DSP         — waveform peaks, speech detection, pitch-preserving
 *                 time-stretch (WSOLA, run in a worker), WAV and MP3 encoding.
 *   Store       — IndexedDB, so takes and the project survive a reload.
 */

'use strict';

const SAMPLE_RATE   = 48000;
const PEAKS_PER_SEC = 200;

// ─────────────────────────────────────────────
// CAPTURE WORKLET
// ─────────────────────────────────────────────
// Runs on the audio thread. While recording it hands the main thread blocks
// of raw samples tagged with the context frame of their first sample, so the
// main thread always knows exactly when each sample was captured. It also
// reports the input level about 30 times a second for the meter.

const CAPTURE_WORKLET_SOURCE = `
class DubDeskCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channel = 0;
    this.id = 0;
    this.recording = false;
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
    this.frame = 0;
    this.mix = new Float32Array(128);
    this.peak = 0;
    this.sum = 0;
    this.count = 0;
    this.every = Math.round(sampleRate / 30);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'start') { this.flush(); this.id = m.id; this.fill = 0; this.recording = true; }
      else if (m.cmd === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ type: 'stopped', id: m.id }); }
      else if (m.cmd === 'channel') { this.channel = m.value; }
    };
  }
  flush() {
    if (!this.fill) return;
    const data = this.buf.slice(0, this.fill);
    this.port.postMessage({ type: 'chunk', id: this.id, frame: this.frame, data }, [data.buffer]);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0] || [];
    const n = input.length ? input[0].length : 128;
    let data = null;
    if (input.length) {
      if (this.channel < 0 && input.length > 1) {
        if (this.mix.length !== n) this.mix = new Float32Array(n);
        const a = input[0], b = input[1];
        for (let i = 0; i < n; i++) this.mix[i] = (a[i] + b[i]) * 0.5;
        data = this.mix;
      } else {
        data = input[Math.min(Math.max(this.channel, 0), input.length - 1)];
      }
      for (let i = 0; i < n; i++) {
        const s = data[i];
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
        this.sum += s * s;
      }
    }
    this.count += n;
    if (this.count >= this.every) {
      this.port.postMessage({ type: 'meter', peak: this.peak, rms: Math.sqrt(this.sum / this.count) });
      this.peak = 0; this.sum = 0; this.count = 0;
    }
    if (this.recording) {
      if (this.fill + n > this.size) this.flush();
      if (!this.fill) this.frame = currentFrame;
      if (data) this.buf.set(data, this.fill); else this.buf.fill(0, this.fill, this.fill + n);
      this.fill += n;
      if (this.fill >= this.size) this.flush();
    }
    return true;
  }
}
registerProcessor('dubdesk-capture', DubDeskCapture);
`;

// ─────────────────────────────────────────────
// AUDIO ENGINE
// ─────────────────────────────────────────────

const AudioEngine = (() => {
  let ctx = null;
  let moduleLoad = null;
  let input = null;        // the armed microphone and its nodes
  let capture = null;      // the take being recorded, if any
  let captureSeq = 0;
  let lostHandler = null;
  const meter = { peak: 0, rms: 0, at: 0 };

  function context() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('This browser doesn’t support Web Audio');
      try { ctx = new Ctx({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }); }
      catch { ctx = new Ctx({ latencyHint: 'interactive' }); }
    }
    return ctx;
  }

  function resume() {
    let c;
    try { c = context(); } catch (e) { return Promise.reject(e); }
    return c.state === 'running' ? Promise.resolve() : c.resume().catch(() => {});
  }

  function loadModule() {
    if (!moduleLoad) {
      const c = context();
      if (!c.audioWorklet || typeof AudioWorkletNode === 'undefined') {
        return Promise.reject(new Error('This browser can’t record with low latency. Use Chrome, Edge or Firefox.'));
      }
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }));
      moduleLoad = c.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      moduleLoad.catch(() => { moduleLoad = null; });
    }
    return moduleLoad;
  }

  // Browser voice processing (echo cancellation, noise suppression, automatic
  // gain) is built for calls. It pumps, gates and smears a performance, so a
  // recording studio turns it off unless asked otherwise.
  function constraintsFor(o) {
    const audio = {
      echoCancellation: !!o.echoCancellation,
      noiseSuppression: !!o.noiseSuppression,
      autoGainControl:  !!o.autoGainControl,
      channelCount:     { ideal: 2 },
      sampleRate:       { ideal: SAMPLE_RATE },
      latency:          { ideal: 0 },
    };
    if (o.deviceId) audio.deviceId = { exact: o.deviceId };
    return audio;
  }

  async function arm(o) {
    const key = JSON.stringify([o.deviceId || '', !!o.echoCancellation, !!o.noiseSuppression, !!o.autoGainControl]);
    if (input && input.key === key && input.track.readyState === 'live') {
      setChannel(o.channel);
      setMonitor(o.monitor);
      return;
    }
    if (capture) throw new Error('Can’t change the microphone while recording');
    await resume();
    await loadModule();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This page can’t reach a microphone. Open it over https or from localhost.');
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraintsFor(o) });
    } catch (e) {
      // A remembered device that has since been unplugged: fall back to the default.
      if (!o.deviceId || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraintsFor({ ...o, deviceId: '' }) });
    }

    release();
    const c = context();
    const track = stream.getAudioTracks()[0];
    const source = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, 'dubdesk-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
    });
    // The worklet only runs while something downstream pulls on it.
    const sink = c.createGain();
    sink.gain.value = 0;
    const monitor = c.createGain();
    monitor.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(c.destination);
    source.connect(monitor);
    monitor.connect(c.destination);
    node.port.onmessage = onMessage;

    input = { key, stream, track, source, node, sink, monitor };
    track.addEventListener('ended', () => {
      if (!input || input.track !== track) return;
      if (lostHandler) lostHandler(!!capture);
    });
    setChannel(o.channel);
    setMonitor(o.monitor);
  }

  function release() {
    if (!input) return;
    const i = input;
    input = null;
    for (const n of [i.source, i.node, i.monitor, i.sink]) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
    i.node.port.onmessage = null;
    i.stream.getTracks().forEach(t => t.stop());
    meter.peak = 0;
    meter.rms = 0;
  }

  /** Close the microphone. Refused while a take is being recorded. */
  function disarm() {
    if (capture) return false;
    release();
    return true;
  }

  const isArmed = () => !!input && input.track.readyState === 'live';

  function setChannel(v) {
    if (input) input.node.port.postMessage({ cmd: 'channel', value: Number(v) || 0 });
  }

  function setMonitor(on) {
    if (input) input.monitor.gain.setTargetAtTime(on ? 1 : 0, context().currentTime, 0.01);
  }

  function onMessage(e) {
    const m = e.data;
    if (m.type === 'meter') {
      meter.peak = m.peak;
      meter.rms = m.rms;
      meter.at = performance.now();
    } else if (m.type === 'chunk') {
      if (capture && m.id === capture.id) addChunk(capture, m.frame, m.data);
    } else if (m.type === 'stopped') {
      if (capture && m.id === capture.id && capture.done) capture.done();
    }
  }

  function addChunk(cap, frame, data) {
    if (cap.first === null) {
      cap.first = frame;
      cap.next = frame;
    }
    if (frame > cap.next) {
      // The audio thread skipped blocks: pad with silence so sample N is
      // always frame first+N, which is what keeps the take in sync.
      const pad = new Float32Array(frame - cap.next);
      cap.chunks.push(pad);
      cap.length += pad.length;
      cap.next = frame;
      if (cap.onData) cap.onData(pad);
    } else if (frame < cap.next) {
      const skip = cap.next - frame;
      if (skip >= data.length) return;
      data = data.subarray(skip);
    }
    cap.chunks.push(data);
    cap.length += data.length;
    cap.next += data.length;
    if (cap.onData) cap.onData(data);
  }

  function startCapture(onData) {
    if (!isArmed()) throw new Error('The microphone isn’t ready');
    capture = { id: ++captureSeq, chunks: [], first: null, next: 0, length: 0, onData, done: null };
    input.node.port.postMessage({ cmd: 'start', id: capture.id });
    return capture.id;
  }

  /** Context time of the first captured sample, once it has arrived. */
  function captureStart() {
    return capture && capture.first !== null ? capture.first / context().sampleRate : null;
  }

  function stopCapture() {
    const cap = capture;
    if (!cap) return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (capture === cap) capture = null;
        resolve(assemble(cap));
      };
      cap.done = done;
      if (input) input.node.port.postMessage({ cmd: 'stop', id: cap.id });
      else done();
      setTimeout(done, 750);
    });
  }

  function abortCapture() {
    const cap = capture;
    if (!cap) return;
    capture = null;
    if (input) input.node.port.postMessage({ cmd: 'stop', id: cap.id });
  }

  function assemble(cap) {
    if (cap.first === null || !cap.length) return null;
    const data = new Float32Array(cap.length);
    let o = 0;
    for (const c of cap.chunks) { data.set(c, o); o += c.length; }
    const sr = context().sampleRate;
    return { data, sampleRate: sr, startTime: cap.first / sr };
  }

  // ── Clock maths ─────────────────────────────
  // getOutputTimestamp() pairs a context time with the performance-clock time
  // at which that sample reaches the speakers. The graph renders ahead of the
  // speakers by the output latency, and a microphone sample reaches the graph
  // after the input latency. Together they give, for any moment on the
  // performance clock, where the sample captured at that moment sits in the
  // take — and when a scheduled sound will actually be heard.

  function latency() {
    const c = context();
    const out = (c.baseLatency || 0) + (c.outputLatency || 0);
    let inp = 0.01;
    try {
      const s = input?.track?.getSettings?.();
      if (s && s.latency > 0 && s.latency < 0.5) inp = s.latency;
    } catch { /* not reported */ }
    return { out, inp };
  }

  function presentedAt(perf) {
    const c = context();
    const ts = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
      return ts.contextTime + (perf - ts.performanceTime) / 1000;
    }
    return c.currentTime + (perf - performance.now()) / 1000 - latency().out;
  }

  /** Context time a sound must be scheduled at to be heard at `perf`. */
  const outputTimeAt = perf => presentedAt(perf);

  /** Context time of the microphone sample captured at `perf`. */
  function captureTimeAt(perf, extraMs = 0) {
    const l = latency();
    return presentedAt(perf) + l.out + l.inp + extraMs / 1000;
  }

  /** A short cue tone, as in ADR's three beeps. Returns a handle to cancel it. */
  function beep(when, freq = 1000, dur = 0.08, level = 0.2) {
    const c = context();
    const t = Math.max(when, c.currentTime + 0.01);
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.setValueAtTime(level, t + dur - 0.006);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    return { stop() { try { g.disconnect(); } catch { /* done */ } } };
  }

  return {
    context, resume, arm, disarm, isArmed, setChannel, setMonitor,
    startCapture, stopCapture, abortCapture, captureStart,
    captureTimeAt, outputTimeAt, beep, meter,
    sampleRate: () => context().sampleRate,
    deviceLabel: () => input?.track?.label || '',
    onLost: fn => { lostHandler = fn; },
  };
})();

// ─────────────────────────────────────────────
// DSP
// ─────────────────────────────────────────────

/** Builds a waveform: the loudest sample in every 1/PEAKS_PER_SEC of a second. */
class PeakBuilder {
  constructor(sampleRate, perSec = PEAKS_PER_SEC) {
    this.size = sampleRate / perSec;
    this.peaks = new Float32Array(1024);
    this.count = 0;
    this.acc = 0;
    this.filled = 0;
  }
  push(data) {
    for (let i = 0; i < data.length; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > this.acc) this.acc = v;
      if (++this.filled >= this.size) {
        this.append(this.acc);
        this.acc = 0;
        this.filled -= this.size;
      }
    }
  }
  append(v) {
    if (this.count >= this.peaks.length) {
      const grown = new Float32Array(this.peaks.length * 2);
      grown.set(this.peaks);
      this.peaks = grown;
    }
    this.peaks[this.count++] = v;
  }
  finish() {
    if (this.filled > 0) {
      this.append(this.acc);
      this.acc = 0;
      this.filled = 0;
    }
    return this.peaks.subarray(0, this.count);
  }
}

/**
 * Time-stretch without changing pitch (WSOLA). factor is output length over
 * input length: 0.75 makes speech a third faster, 1.1 makes it 10% slower.
 * Kept free of outside references: it is also serialised into a worker.
 */
function wsolaStretch(x, factor, sr) {
  const outLen = Math.max(1, Math.round(x.length * factor));
  const N = Math.max(256, Math.round(sr * 0.03) & ~1);
  if (x.length < N * 2) {
    const y = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i / factor;
      const lo = Math.min(Math.floor(p), x.length - 1);
      const hi = Math.min(lo + 1, x.length - 1);
      const f = p - Math.floor(p);
      y[i] = (x[lo] || 0) * (1 - f) + (x[hi] || 0) * f;
    }
    return y;
  }
  const Hs = N >> 1;
  const Ha = Hs / factor;
  const tol = Math.round(sr * 0.01);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const y = new Float32Array(outLen + N);
  const w = new Float32Array(outLen + N);
  const maxPos = x.length - N;
  let prev = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    const outPos = k * Hs;
    let pos = Math.min(maxPos, Math.round(k * Ha));
    if (k > 0) {
      // Pick the frame near its nominal place whose start best continues the
      // previous frame, so the overlap adds up in phase instead of warbling.
      const target = prev + Hs;
      if (target <= maxPos) {
        const lo = Math.max(0, pos - tol);
        const hi = Math.min(maxPos, pos + tol);
        let best = pos;
        let bestScore = -Infinity;
        for (let p = lo; p <= hi; p += 2) {
          let s = 0;
          for (let i = 0; i < Hs; i += 4) s += x[p + i] * x[target + i];
          if (s > bestScore) { bestScore = s; best = p; }
        }
        const coarse = best;
        bestScore = -Infinity;
        for (let p = Math.max(lo, coarse - 2); p <= Math.min(hi, coarse + 2); p++) {
          let s = 0;
          for (let i = 0; i < Hs; i += 2) s += x[p + i] * x[target + i];
          if (s > bestScore) { bestScore = s; best = p; }
        }
        pos = best;
      }
    }
    for (let i = 0; i < N; i++) {
      y[outPos + i] += x[pos + i] * win[i];
      w[outPos + i] += win[i];
    }
    prev = pos;
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = w[i] > 1e-4 ? y[i] / w[i] : 0;
  return out;
}

const STRETCH_WORKER_SOURCE = `${wsolaStretch.toString()}
self.onmessage = (e) => {
  const { id, data, factor, sampleRate } = e.data;
  let out;
  try { out = wsolaStretch(data, factor, sampleRate); }
  catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); return; }
  self.postMessage({ id, data: out }, [out.buffer]);
};`;

const DSP = (() => {
  let worker = null;
  let workerBroken = false;
  const jobs = new Map();
  let seq = 0;

  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      const url = URL.createObjectURL(new Blob([STRETCH_WORKER_SOURCE], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = e => {
        const job = jobs.get(e.data.id);
        if (!job) return;
        jobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.data);
      };
      worker.onerror = () => {
        for (const job of jobs.values()) job.fallback();
        jobs.clear();
        worker = null;
        workerBroken = true;
      };
    } catch {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  /** Pitch-preserving time-stretch, off the main thread where possible. */
  function stretch(data, factor, sr) {
    if (Math.abs(factor - 1) < 0.002) return Promise.resolve(data.slice());
    const w = getWorker();
    if (!w) return new Promise(resolve => setTimeout(() => resolve(wsolaStretch(data, factor, sr)), 0));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const copy = data.slice();
      jobs.set(id, { resolve, reject, fallback: () => resolve(wsolaStretch(data, factor, sr)) });
      w.postMessage({ id, data: copy, factor, sampleRate: sr }, [copy.buffer]);
    });
  }

  function peaks(data, sr) {
    const b = new PeakBuilder(sr);
    b.push(data);
    return b.finish().slice();
  }

  /**
   * Where speech starts and stops between fromSec and toSec, in seconds.
   * Loudness in 10 ms frames, against a threshold set from the room's own
   * noise floor and the loudest part of the line, so it works on quiet and
   * loud takes alike. Returns null when nothing stands out as speech.
   */
  function speech(data, sr, fromSec, toSec) {
    const hop = Math.round(sr * 0.01);
    const s0 = Math.max(0, Math.floor(fromSec * sr));
    const s1 = Math.min(data.length, Math.ceil(toSec * sr));
    const n = Math.floor((s1 - s0) / hop);
    if (n < 6) return null;

    const rms = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let sum = 0;
      const b = s0 + f * hop;
      for (let i = 0; i < hop; i++) { const v = data[b + i]; sum += v * v; }
      rms[f] = Math.sqrt(sum / hop);
    }
    const sorted = Float32Array.from(rms).sort();
    const floor = sorted[Math.floor(n * 0.1)];
    const top = sorted[Math.min(n - 1, Math.floor(n * 0.98))];
    if (top < 0.003) return null;                        // nothing above −50 dBFS
    const thr = Math.max(floor * 3.5, top * 0.1, 0.0025);
    if (top < thr * 1.4) return null;                    // no part stands out

    const RUN = 4;                                       // 40 ms sustained
    let on = -1;
    for (let f = 0, run = 0; f < n; f++) {
      if (rms[f] > thr) { if (++run >= RUN) { on = f - RUN + 1; break; } } else run = 0;
    }
    if (on < 0) return null;
    let off = n;
    for (let f = n - 1, run = 0; f >= 0; f--) {
      if (rms[f] > thr) { if (++run >= RUN) { off = Math.min(n, f + RUN + 1); break; } } else run = 0;
    }
    on = Math.max(0, on - 1);                            // keep the soft attack
    return { on: (s0 + on * hop) / sr, off: (s0 + off * hop) / sr };
  }

  /** Mono PCM WAV, 16- or 24-bit. */
  function wav(data, sr, bits = 24) {
    const bytes = bits >> 3;
    const size = data.length * bytes;
    const buf = new ArrayBuffer(44 + size);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + size, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * bytes, true);
    v.setUint16(32, bytes, true);
    v.setUint16(34, bits, true);
    str(36, 'data');
    v.setUint32(40, size, true);

    let o = 44;
    if (bits === 24) {
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < data.length; i++) {
        let s = data[i];
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        let n = Math.round(s * 8388607);
        if (n < 0) n += 16777216;
        u8[o] = n & 255;
        u8[o + 1] = (n >> 8) & 255;
        u8[o + 2] = (n >> 16) & 255;
        o += 3;
      }
    } else {
      for (let i = 0; i < data.length; i++) {
        let s = data[i];
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        v.setInt16(o, Math.round(s * 32767), true);
        o += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /** Mono MP3 through lamejs. */
  function mp3(data, sr, kbps = 128) {
    if (typeof lamejs === 'undefined') {
      throw new Error('The MP3 encoder didn’t load. Check your connection, or export WAV.');
    }
    const enc = new lamejs.Mp3Encoder(1, sr, kbps);
    const parts = [];
    const block = 1152;
    for (let i = 0; i < data.length; i += block) {
      const n = Math.min(block, data.length - i);
      const pcm = new Int16Array(n);
      for (let j = 0; j < n; j++) {
        let s = data[i + j];
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const out = enc.encodeBuffer(pcm);
      if (out.length) parts.push(new Uint8Array(out));
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  return { peaks, speech, stretch, wav, mp3 };
})();

// ─────────────────────────────────────────────
// STORE — IndexedDB
// ─────────────────────────────────────────────

const Store = (() => {
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('This browser has no IndexedDB')); return; }
        const req = indexedDB.open('dubdesk', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  }

  function run(storeName, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      let result;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage write was aborted'));
    }));
  }

  return {
    putTake:    take => run('takes', 'readwrite', s => s.put(take)),
    getTake:    id   => run('takes', 'readonly', s => s.get(id)),
    deleteTake: id   => run('takes', 'readwrite', s => s.delete(id)),
    takeIds:    ()   => run('takes', 'readonly', s => s.getAllKeys()),
    put:        (key, value) => run('kv', 'readwrite', s => s.put(value, key)),
    get:        key  => run('kv', 'readonly', s => s.get(key)),
  };
})();
