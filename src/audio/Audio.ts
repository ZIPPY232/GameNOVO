/**
 * Fully procedural Web Audio: no external sound files.
 *
 * Routing:  sources -> [external bus] -> airFilter (vacuum/inside muffling) -> sfx
 *           sources -> [internal bus] (helmet, suit, cockpit) -> sfx
 *           ambience (wind, rain) -> airFilter
 *           music -> reverb -> music bus
 * In vacuum the external bus is closed: only suit/structure-borne sounds remain.
 */

export type Mood = 'explore' | 'discovery' | 'space' | 'danger' | 'entry' | 'mystery' | 'menu' | 'none';
export type StepMaterial = 'rock' | 'soil' | 'sand' | 'snow' | 'ice' | 'metal' | 'glass' | 'crystal' | 'organic';

export interface AudioVolumes { master: number; music: number; sfx: number; ambience: number }

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private amb!: GainNode;
  private external!: GainNode;
  private internal!: GainNode;
  private airFilter!: BiquadFilterNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  // loops
  private wind: { g: GainNode; f: BiquadFilterNode } | null = null;
  private rain: { g: GainNode } | null = null;
  private engine: { g: GainNode; f: BiquadFilterNode; o1: OscillatorNode; o2: OscillatorNode; whine: OscillatorNode; wg: GainNode } | null = null;
  private roar: { g: GainNode; f: BiquadFilterNode } | null = null;
  private laser: { g: GainNode; o: OscillatorNode; f: BiquadFilterNode } | null = null;
  private underwater: { g: GainNode } | null = null;
  private breathT = 0;
  private breathIn = true;
  private musicMood: Mood = 'none';
  private musicTimer = 0;
  private chordIdx = 0;
  private moodGain!: GainNode;
  private volumes: AudioVolumes = { master: 0.8, music: 0.5, sfx: 0.8, ambience: 0.7 };
  vacuum = false;
  inside = false;
  private dripT = 2;
  caveFactor = 0;

  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.disconnect();
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.connect(this.master);
    this.amb = ctx.createGain();
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'lowpass';
    this.airFilter.frequency.value = 18000;
    this.external = ctx.createGain();
    this.external.connect(this.airFilter);
    this.amb.connect(this.airFilter);
    this.airFilter.connect(this.sfx);
    this.internal = ctx.createGain();
    this.internal.connect(this.sfx);
    // noise buffers
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const bd = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
    // reverb impulse
    this.reverb = ctx.createConvolver();
    const irLen = ctx.sampleRate * 4.5;
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.music);
    this.moodGain = ctx.createGain();
    this.moodGain.connect(this.reverbSend);
    const dry = ctx.createGain();
    dry.gain.value = 0.35;
    this.moodGain.connect(dry).connect(this.music);
    this.setVolumes(this.volumes);
    this.startLoops();
  }

  setVolumes(v: AudioVolumes): void {
    this.volumes = { ...v };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(v.master, t, 0.1);
    this.music.gain.setTargetAtTime(v.music * 0.55, t, 0.1);
    this.sfx.gain.setTargetAtTime(v.sfx, t, 0.1);
    this.amb.gain.setTargetAtTime(v.ambience, t, 0.1);
  }

  private loopNoise(buf: AudioBuffer): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random());
    return s;
  }

  private startLoops(): void {
    const ctx = this.ctx!;
    // wind
    {
      const src = this.loopNoise(this.brown);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 400; f.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.amb);
      this.wind = { g, f };
    }
    // rain
    {
      const src = this.loopNoise(this.noise);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(this.amb);
      this.rain = { g };
    }
    // ship engine (internal + external blend handled by gain/filter)
    {
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 48;
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 48.7;
      const n = this.loopNoise(this.brown);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
      const g = ctx.createGain(); g.gain.value = 0;
      const ng = ctx.createGain(); ng.gain.value = 0.6;
      o1.connect(f); o2.connect(f); n.connect(ng).connect(f);
      f.connect(g).connect(this.internal);
      const whine = ctx.createOscillator(); whine.type = 'sine'; whine.frequency.value = 900;
      const wg = ctx.createGain(); wg.gain.value = 0;
      whine.connect(wg).connect(this.internal);
      o1.start(); o2.start(); whine.start();
      this.engine = { g, f, o1, o2, whine, wg };
    }
    // atmospheric roar
    {
      const src = this.loopNoise(this.brown);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 250; f.Q.value = 0.5;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.internal);
      this.roar = { g, f };
    }
    // mining laser
    {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 220;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 9;
      const lg = ctx.createGain(); lg.gain.value = 12;
      lfo.connect(lg).connect(o.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200; f.Q.value = 6;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(f).connect(g).connect(this.internal);
      const n = this.loopNoise(this.noise);
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 3000; nf.Q.value = 1;
      const ng = ctx.createGain(); ng.gain.value = 0.15;
      n.connect(nf).connect(ng).connect(g);
      o.start(); lfo.start();
      this.laser = { g, o, f };
    }
    // underwater ambience
    {
      const src = this.loopNoise(this.brown);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.internal);
      this.underwater = { g };
    }
  }

  /** Per-frame continuous parameters. */
  update(dt: number, p: {
    wind: number; pressure: number; rain: number; engine: number; engineOn: boolean; inCockpit: boolean; roar: number; mining: boolean;
    breathing: number; exertion: number; underwater: boolean; vacuum: boolean; mood: Mood; cave: number;
  }): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.vacuum = p.vacuum;
    const air = p.vacuum ? 0 : Math.min(1, p.pressure);
    // muffle external world in vacuum / underwater / inside the cockpit
    const cutoff = p.vacuum ? 120 : p.underwater ? 500 : p.inCockpit ? 1400 : 18000;
    this.airFilter.frequency.setTargetAtTime(cutoff, t, 0.15);
    this.external.gain.setTargetAtTime(p.vacuum ? 0.05 : 1, t, 0.2);
    this.wind!.g.gain.setTargetAtTime(air * Math.min(1, p.wind / 14) * 0.5 * (1 - p.cave * 0.85), t, 0.4);
    this.wind!.f.frequency.setTargetAtTime(250 + p.wind * 40 + Math.sin(t * 0.3) * 80, t, 0.5);
    this.rain!.g.gain.setTargetAtTime(air * p.rain * 0.25 * (1 - p.cave), t, 0.5);
    const e = this.engine!;
    const on = p.engineOn ? 1 : 0;
    e.g.gain.setTargetAtTime(on * (0.12 + p.engine * 0.35) * (p.inCockpit ? 0.8 : air * 0.9 + 0.15), t, 0.15);
    e.f.frequency.setTargetAtTime(160 + p.engine * 900 * (p.inCockpit ? 0.5 : 1), t, 0.2);
    e.o1.frequency.setTargetAtTime(42 + p.engine * 30, t, 0.2);
    e.o2.frequency.setTargetAtTime(42.6 + p.engine * 31, t, 0.2);
    e.whine.frequency.setTargetAtTime(700 + p.engine * 1600, t, 0.3);
    e.wg.gain.setTargetAtTime(on * p.engine * 0.03, t, 0.2);
    this.roar!.g.gain.setTargetAtTime(p.roar * 0.6, t, 0.2);
    this.roar!.f.frequency.setTargetAtTime(150 + p.roar * 500, t, 0.2);
    this.laser!.g.gain.setTargetAtTime(p.mining ? 0.06 : 0, t, 0.03);
    this.underwater!.g.gain.setTargetAtTime(p.underwater ? 0.35 : 0, t, 0.3);
    // helmet breathing (internal, always audible when suited)
    if (p.breathing > 0) {
      const rate = 3.6 - Math.min(2.2, p.exertion * 2.4);
      this.breathT -= dt;
      if (this.breathT <= 0) {
        this.breath(this.breathIn, p.breathing * (0.4 + p.exertion * 0.6));
        this.breathIn = !this.breathIn;
        this.breathT = this.breathIn ? rate * 0.55 : rate * 0.45;
      }
    }
    // cave drips
    if (p.cave > 0.5) {
      this.dripT -= dt;
      if (this.dripT <= 0) { this.dripT = 0.8 + Math.random() * 4; this.drip(); }
    }
    this.updateMusic(dt, p.mood);
  }

  private env(g: GainNode, a: number, peak: number, d: number, t0 = this.ctx!.currentTime): void {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  private noiseBurst(dest: AudioNode, type: BiquadFilterType, freq: number, q: number, peak: number, a: number, d: number, delay = 0, buf?: AudioBuffer): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = buf ?? this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    s.connect(f).connect(g).connect(dest);
    this.env(g, a, peak, d, t0);
    s.start(t0, Math.random() * 1.5);
    s.stop(t0 + a + d + 0.05);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, peak: number, a: number, d: number, delay = 0): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + a + d);
    const g = ctx.createGain();
    o.connect(g).connect(dest);
    this.env(g, a, peak, d, t0);
    o.start(t0);
    o.stop(t0 + a + d + 0.05);
  }

  private breath(inhale: boolean, vol: number): void {
    if (!this.ctx) return;
    this.noiseBurst(this.internal, 'bandpass', inhale ? 900 : 600, 0.8, 0.03 * vol, inhale ? 0.5 : 0.3, inhale ? 0.6 : 0.9);
  }

  footstep(m: StepMaterial): void {
    if (!this.ctx) return;
    // structure-borne thud always; airborne detail only with atmosphere
    this.noiseBurst(this.internal, 'lowpass', 180, 0.7, 0.08, 0.005, 0.12, 0, this.brown);
    const d = this.external;
    switch (m) {
      case 'sand': this.noiseBurst(d, 'highpass', 2500, 0.5, 0.05, 0.02, 0.18); break;
      case 'snow': this.noiseBurst(d, 'bandpass', 1400, 1.2, 0.07, 0.02, 0.16); this.noiseBurst(d, 'highpass', 4000, 0.5, 0.02, 0.05, 0.1); break;
      case 'metal': this.tone(d, 'triangle', 1100 + Math.random() * 200, 900, 0.04, 0.002, 0.22); this.noiseBurst(d, 'bandpass', 3000, 3, 0.04, 0.002, 0.06); break;
      case 'ice': case 'glass': case 'crystal': this.noiseBurst(d, 'bandpass', 3800, 4, 0.05, 0.002, 0.07); break;
      case 'organic': case 'soil': this.noiseBurst(d, 'lowpass', 700, 0.7, 0.08, 0.01, 0.12); break;
      default: this.noiseBurst(d, 'bandpass', 900, 1.5, 0.07, 0.003, 0.09); this.noiseBurst(d, 'highpass', 3000, 0.7, 0.02, 0.003, 0.04);
    }
  }

  blockBreak(m: StepMaterial): void {
    if (!this.ctx) return;
    const d = this.external;
    this.noiseBurst(this.internal, 'lowpass', 300, 0.7, 0.15, 0.005, 0.25, 0, this.brown);
    switch (m) {
      case 'crystal': case 'glass': case 'ice':
        for (let i = 0; i < 4; i++) this.tone(d, 'sine', 2000 + Math.random() * 3000, 1500, 0.03, 0.002, 0.3, i * 0.03);
        break;
      case 'metal': this.tone(d, 'square', 300, 120, 0.06, 0.003, 0.3); break;
      case 'sand': case 'snow': case 'soil': case 'organic': this.noiseBurst(d, 'lowpass', 1200, 0.6, 0.18, 0.005, 0.35); break;
      default: this.noiseBurst(d, 'bandpass', 600, 1, 0.25, 0.003, 0.4); this.noiseBurst(d, 'highpass', 2500, 0.5, 0.06, 0.003, 0.15, 0.03);
    }
  }

  miningTick(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.external, 'bandpass', 1800 + Math.random() * 1500, 4, 0.025, 0.002, 0.05);
  }

  place(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.internal, 'lowpass', 400, 1, 0.14, 0.003, 0.15, 0, this.brown);
    this.tone(this.external, 'triangle', 520, 380, 0.03, 0.003, 0.12);
  }

  scan(): void {
    if (!this.ctx) return;
    this.tone(this.internal, 'sine', 400, 1600, 0.08, 0.02, 0.8);
    this.tone(this.internal, 'sine', 800, 3200, 0.03, 0.02, 1.2, 0.15);
    this.tone(this.internal, 'sine', 400, 1600, 0.025, 0.02, 0.8, 0.5);
  }

  ui(kind: 'click' | 'hover' | 'open' | 'close' | 'error' | 'craft' | 'pickup' | 'discovery' | 'objective'): void {
    if (!this.ctx) return;
    const d = this.internal;
    switch (kind) {
      case 'hover': this.tone(d, 'sine', 2400, 2400, 0.008, 0.001, 0.03); break;
      case 'click': this.tone(d, 'sine', 1600, 1200, 0.03, 0.001, 0.06); break;
      case 'open': this.tone(d, 'sine', 600, 1200, 0.03, 0.01, 0.15); break;
      case 'close': this.tone(d, 'sine', 1200, 600, 0.03, 0.01, 0.15); break;
      case 'error': this.tone(d, 'square', 220, 180, 0.03, 0.005, 0.18); this.tone(d, 'square', 220, 180, 0.03, 0.005, 0.18, 0.22); break;
      case 'craft': this.tone(d, 'triangle', 660, 880, 0.04, 0.01, 0.2); this.tone(d, 'triangle', 990, 990, 0.03, 0.01, 0.25, 0.12); break;
      case 'pickup': this.tone(d, 'sine', 900 + Math.random() * 200, 1300, 0.025, 0.003, 0.08); break;
      case 'discovery': [523, 659, 784, 1047].forEach((f, i) => this.tone(d, 'triangle', f, f, 0.05, 0.02, 1.4, i * 0.14)); break;
      case 'objective': [784, 1175].forEach((f, i) => this.tone(d, 'sine', f, f, 0.05, 0.01, 0.6, i * 0.12)); break;
    }
  }

  alarm(): void {
    if (!this.ctx) return;
    this.tone(this.internal, 'square', 880, 880, 0.025, 0.005, 0.12);
    this.tone(this.internal, 'square', 660, 660, 0.025, 0.005, 0.12, 0.16);
  }

  thunder(delay: number, intensity: number): void {
    if (!this.ctx || this.vacuum) return;
    this.noiseBurst(this.external, 'lowpass', 160, 0.5, 0.5 * intensity, 0.05, 3.5, delay, this.brown);
    this.noiseBurst(this.external, 'lowpass', 700, 0.5, 0.25 * intensity, 0.01, 0.6, delay);
  }

  splash(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.external, 'lowpass', 1500, 0.5, 0.25, 0.01, 0.6);
  }

  hurt(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.internal, 'lowpass', 500, 1, 0.12, 0.003, 0.2, 0, this.brown);
    this.tone(this.internal, 'sawtooth', 160, 90, 0.04, 0.003, 0.2);
  }

  thrusterPuff(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.internal, 'bandpass', 1200, 0.8, 0.04, 0.005, 0.12);
  }

  creature(pitch: number, hostile: boolean): void {
    if (!this.ctx || this.vacuum) return;
    const d = this.external;
    if (hostile) { this.tone(d, 'sawtooth', 180 * pitch, 90 * pitch, 0.05, 0.02, 0.5); }
    else { this.tone(d, 'sine', 700 * pitch, 1100 * pitch, 0.03, 0.04, 0.25); this.tone(d, 'sine', 1000 * pitch, 650 * pitch, 0.025, 0.03, 0.3, 0.2); }
  }

  warp(): void {
    if (!this.ctx) return;
    this.tone(this.internal, 'sawtooth', 60, 900, 0.12, 1.5, 3.0);
    this.noiseBurst(this.internal, 'bandpass', 600, 0.5, 0.3, 2.5, 2.5, 0, this.brown);
    this.tone(this.internal, 'sine', 2000, 80, 0.1, 0.05, 2.0, 4.0);
  }

  landing(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.internal, 'lowpass', 220, 0.7, 0.3, 0.01, 0.6, 0, this.brown);
  }

  private drip(): void {
    const d = this.external;
    this.tone(d, 'sine', 1400 + Math.random() * 1600, 900, 0.02, 0.001, 0.25);
  }

  // ------------------------------------------------------------- music
  private static readonly MOODS: Record<Exclude<Mood, 'none'>, { chords: number[][]; wave: OscillatorType; cutoff: number; dur: number; arp: boolean; gain: number; pulse: boolean }> = {
    menu: { chords: [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 50, 55, 59, 62], [45, 52, 57, 61, 64]], wave: 'sawtooth', cutoff: 900, dur: 9, arp: true, gain: 0.05, pulse: false },
    explore: { chords: [[50, 57, 64, 66], [48, 55, 62, 64], [45, 52, 59, 64], [47, 54, 61, 66]], wave: 'triangle', cutoff: 1200, dur: 10, arp: true, gain: 0.06, pulse: false },
    discovery: { chords: [[55, 62, 67, 71, 74], [52, 59, 64, 67, 71], [48, 55, 60, 64, 69], [50, 57, 62, 66, 69]], wave: 'sawtooth', cutoff: 1600, dur: 7, arp: true, gain: 0.05, pulse: false },
    space: { chords: [[38, 45, 57, 64], [36, 43, 55, 62], [41, 48, 60, 67], [34, 41, 53, 60]], wave: 'sawtooth', cutoff: 600, dur: 14, arp: false, gain: 0.07, pulse: false },
    danger: { chords: [[45, 48, 52, 57], [44, 48, 51, 56], [41, 45, 48, 53], [40, 44, 47, 52]], wave: 'sawtooth', cutoff: 800, dur: 5, arp: false, gain: 0.06, pulse: true },
    entry: { chords: [[38, 45, 50, 57], [40, 47, 52, 59], [41, 48, 53, 60], [43, 50, 55, 62]], wave: 'sawtooth', cutoff: 1400, dur: 6, arp: false, gain: 0.07, pulse: true },
    mystery: { chords: [[48, 52, 56, 60], [50, 54, 58, 62], [46, 50, 54, 58], [47, 51, 55, 59]], wave: 'triangle', cutoff: 900, dur: 11, arp: true, gain: 0.05, pulse: false },
  };

  private updateMusic(dt: number, mood: Mood): void {
    if (!this.ctx) return;
    if (mood !== this.musicMood) {
      this.musicMood = mood;
      this.musicTimer = 0.5;
    }
    if (mood === 'none') return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    const m = AudioEngine.MOODS[mood];
    const chord = m.chords[this.chordIdx++ % m.chords.length];
    this.musicTimer = m.dur;
    this.playChord(chord, m.dur, m.wave, m.cutoff, m.gain);
    if (m.arp) this.playArp(chord, m.dur);
    if (m.pulse) this.playPulse(chord[0], m.dur);
  }

  private mtof(n: number): number {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  private playChord(notes: number[], dur: number, wave: OscillatorType, cutoff: number, gain: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.05;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff * 0.4, t0);
    f.frequency.linearRampToValueAtTime(cutoff, t0 + dur * 0.5);
    f.frequency.linearRampToValueAtTime(cutoff * 0.5, t0 + dur * 1.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.35);
    g.gain.linearRampToValueAtTime(gain * 0.8, t0 + dur);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur * 1.45);
    f.connect(g).connect(this.moodGain);
    for (const n of notes) {
      for (const det of [-6, 5]) {
        const o = ctx.createOscillator();
        o.type = wave;
        o.frequency.value = this.mtof(n);
        o.detune.value = det;
        o.connect(f);
        o.start(t0);
        o.stop(t0 + dur * 1.5);
      }
    }
  }

  private playArp(notes: number[], dur: number): void {
    const ctx = this.ctx!;
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      if (Math.random() < 0.35) continue;
      const n = notes[Math.floor(Math.random() * notes.length)] + 12 + (Math.random() < 0.3 ? 12 : 0);
      const t = (dur / steps) * i + Math.random() * 0.3;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = this.mtof(n);
      const g = ctx.createGain();
      o.connect(g).connect(this.moodGain);
      this.env(g, 0.01, 0.025, 2.5, ctx.currentTime + t);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 2.7);
    }
  }

  private playPulse(root: number, dur: number): void {
    const ctx = this.ctx!;
    const beats = Math.floor(dur * 2);
    for (let i = 0; i < beats; i++) {
      const t = ctx.currentTime + i * 0.5;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = this.mtof(root - 12);
      const g = ctx.createGain();
      o.connect(g).connect(this.music);
      this.env(g, 0.005, 0.05, 0.3, t);
      o.start(t);
      o.stop(t + 0.4);
    }
  }
}
