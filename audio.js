// Small, gesture-unlocked Web Audio synthesizer for the push-pop toy.
export class PopAudio {
  constructor() {
    this._context = null;
    this._master = null;
    this._compressor = null;
    this._voices = new Set();
    this._volume = 0.45;
    this._muted = false;
    this._tone = 'soft';
    this._totalPops = 0;
    this._disposed = false;
  }

  // Call from a user gesture. Nothing creates or resumes audio before this.
  async unlock() {
    if (this._disposed) return false;
    try {
      if (!this._context) {
        const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextCtor) return false;
        this._context = new AudioContextCtor();
        this._master = this._context.createGain();
        this._master.gain.value = this._muted ? 0 : this._volume;
        this._compressor = this._context.createDynamicsCompressor();
        this._compressor.threshold.value = -14;
        this._compressor.knee.value = 18;
        this._compressor.ratio.value = 8;
        this._compressor.attack.value = 0.002;
        this._compressor.release.value = 0.08;
        this._master.connect(this._compressor);
        this._compressor.connect(this._context.destination);
      }
      if (this._context.state !== 'running') await this._context.resume();
      return this._context.state === 'running';
    } catch {
      return false;
    }
  }

  setVolume(value) {
    const next = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : this._volume;
    this._volume = next;
    if (this._master && this._context) {
      this._master.gain.setTargetAtTime(this._muted ? 0 : next, this._context.currentTime, 0.012);
    }
  }

  setMuted(value) {
    this._muted = Boolean(value);
    if (this._master && this._context) {
      this._master.gain.setTargetAtTime(this._muted ? 0 : this._volume, this._context.currentTime, 0.008);
    }
  }

  setTone(value) {
    if (value === 'soft' || value === 'deep') this._tone = value;
  }

  pop(index, side = 1) {
    this._totalPops += 1;
    if (this._disposed || this._muted || !this._context || this._context.state !== 'running') return;

    // Stable variation keeps repeated cells from sounding mechanically identical.
    const n = (Number(index) || 0) * 0.754877666 + (Number(side) || 1) * 1.618033988;
    const wobble = 0.94 + (Math.sin(n) * 0.5 + 0.5) * 0.12;
    const now = this._context.currentTime;
    const duration = this._tone === 'deep' ? 0.19 : 0.145;
    const base = (this._tone === 'deep' ? 145 : 225) * wobble;

    while (this._voices.size >= 12) {
      const oldest = this._voices.values().next().value;
      this._finishVoice(oldest, true);
    }

    const voice = { nodes: [], timer: null, done: false };
    this._voices.add(voice);
    const ctx = this._context;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(this._tone === 'deep' ? 0.66 : 0.58, now + 0.003);
    out.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    out.connect(this._master);
    voice.nodes.push(out);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * 1.65, now);
    osc.frequency.exponentialRampToValueAtTime(base * 0.48, now + duration);
    osc.connect(out);
    voice.nodes.push(osc);

    // A short, band-limited noise puff supplies the soft silicone impact texture.
    const noise = ctx.createBufferSource();
    const noiseBuffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.055)), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let seed = ((Math.floor(Math.abs(n) * 1000003) ^ (Number(index) | 0) ^ ((Number(side) | 0) * 2654435761)) >>> 0) || 1;
    for (let i = 0; i < data.length; i += 1) {
      const phase = i / data.length;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = ((seed / 0x80000000) - 1) * Math.exp(-phase * 8);
    }
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = this._tone === 'deep' ? 580 : 920;
    filter.Q.value = 0.65;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.18, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
    noise.connect(filter).connect(noiseGain).connect(out);
    voice.nodes.push(noise, filter, noiseGain);

    const done = () => this._finishVoice(voice);
    osc.addEventListener('ended', done, { once: true });
    try {
      osc.start(now);
      osc.stop(now + duration + 0.015);
      noise.start(now);
      noise.stop(now + 0.06);
    } catch {
      done();
    }
    voice.timer = globalThis.setTimeout(done, (duration + 0.08) * 1000);
  }

  _finishVoice(voice, immediate = false) {
    if (!voice || voice.done) return;
    voice.done = true;
    this._voices.delete(voice);
    if (voice.timer != null) globalThis.clearTimeout(voice.timer);
    for (const node of voice.nodes) {
      if (immediate && typeof node.stop === 'function') {
        try { node.stop(); } catch { /* already ended */ }
      }
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const voice of [...this._voices]) this._finishVoice(voice, true);
    try { this._master?.disconnect(); } catch { /* noop */ }
    try { this._compressor?.disconnect(); } catch { /* noop */ }
    try {
      const closing = this._context?.close();
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    } catch { /* noop */ }
    this._context = null;
    this._master = null;
    this._compressor = null;
  }

  get diagnostics() {
    return {
      state: this._context?.state || 'unavailable',
      voiceCount: this._voices.size,
      totalPops: this._totalPops,
      muted: this._muted,
      volume: this._volume,
      tone: this._tone,
    };
  }
}

export default PopAudio;
