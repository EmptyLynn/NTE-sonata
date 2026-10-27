/* ============================================================================
 * 音频引擎 —— Web Audio 多声部钢琴（v2：全音域采样 + 音高保真）
 *
 * 设计要点：
 *  · 采样器标准做法：每个目标音高用"最近的可用采样 + playbackRate 变调"播放，
 *    音高始终忠实于 MIDI（超域音符不再被八度折叠改调）；采样覆盖越密，变调越小；
 *  · 每次触发新建 BufferSource 声部：同键连击/重叠互不打断（叠音）；
 *  · velocity → 每声部 GainNode 包络（3ms 起音防爆音），主音量后接压缩器防削波；
 *  · 可调延音：松键后延音 sustainMs 再淡出（0 = 立即止音）；
 *  · 多音色：assets/audio/<音色id>/ 采样按 MIDI 音高命名 + manifest.json
 *    （{name, min, max}），按需加载、缓存解码结果。
 * ==========================================================================*/
const AudioEngine = {
  ctx: null,
  master: null,
  instruments: new Map(),   // id -> {id, name, min, max, buffers:Map, sortedMidis:[], missing:[], ready}
  currentId: null,
  voices: new Map(),        // voiceId -> {id, src, g, midi, sampleMidi, source, t0, released, releaseWhen}
  nextVoiceId: 1,
  MAX_VOICES: 64,
  sustainMs: 800,           // 松键后的延音时长（手动演奏）
  BOOST: 2.2,               // 总音量增益（滑杆 1.0 时为 2.2，经限制器防削波）

  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85 * this.BOOST;
      /* 透明限制器：只在接近削波时起效（此前 -14dB 压缩器把整体音量压死了） */
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -2; comp.knee.value = 3; comp.ratio.value = 12;
      comp.attack.value = 0.002; comp.release.value = 0.16;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  baseUrl(id) { return `../assets/audio/${id}/`; },

  /* 浏览器模式用 instruments.json；Electron 模式由主进程 IPC 扫描目录 */
  async listInstruments() {
    if (window.yihuan && window.yihuan.isElectron) {
      try { return await window.yihuan.listInstruments(); } catch { /* fallthrough */ }
    }
    try {
      const resp = await fetch('../assets/audio/instruments.json');
      if (resp.ok) return await resp.json();
    } catch { /* fallthrough */ }
    return [{ id: 'grand', name: '古典钢琴', samples: 36 }];
  },

  async loadInstrument(id, name) {
    if (this.instruments.has(id)) return this.instruments.get(id);
    this.ensureCtx();
    const inst = {
      id, name: name || id, min: 48, max: 83,
      buffers: new Map(), sortedMidis: [], missing: [], ready: false,
    };
    this.instruments.set(id, inst); // 先占位，防并发重复加载

    /* manifest v2：{name, min, max}，缺省按 48–83 */
    try {
      const mResp = await fetch(`${this.baseUrl(id)}manifest.json`);
      if (mResp.ok) {
        const m = await mResp.json();
        inst.name = m.name || inst.name;
        if (Number.isInteger(m.min) && Number.isInteger(m.max)) { inst.min = m.min; inst.max = m.max; }
      }
    } catch { /* 无 manifest 用默认范围 */ }

    let ok = 0;
    await Promise.all(Array.from({ length: inst.max - inst.min + 1 }, async (_, i) => {
      const midi = inst.min + i;
      try {
        const resp = await fetch(`${this.baseUrl(id)}${midi}.mp3`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw = await resp.arrayBuffer();
        const audio = await this.ctx.decodeAudioData(raw);
        inst.buffers.set(midi, audio);
        ok++;
      } catch {
        inst.missing.push(midi);
      }
    }));
    inst.sortedMidis = [...inst.buffers.keys()].sort((a, b) => a - b);
    inst.ready = true;
    if (inst.missing.length) {
      console.warn(`[audio] 音色 ${id} 缺失 ${inst.missing.length} 个采样:`, inst.missing.join(','));
    }
    return inst;
  },

  setCurrent(id) {
    if (this.instruments.has(id)) this.currentId = id;
  },

  /* 最近的可用采样（二分）；音域内命中率取决于采样密度 */
  nearestSample(midi) {
    const inst = this.instruments.get(this.currentId);
    if (!inst || !inst.sortedMidis.length) return null;
    const arr = inst.sortedMidis;
    if (midi <= arr[0]) return arr[0];
    if (midi >= arr[arr.length - 1]) return arr[arr.length - 1];
    let lo = 0, hi = arr.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < midi) lo = mid; else hi = mid;
    }
    return (midi - arr[lo]) <= (arr[hi] - midi) ? arr[lo] : arr[hi];
  },

  velocityGain(v) {
    const x = Math.max(0, Math.min(1, v));
    return 0.14 + 0.86 * Math.pow(x, 1.35);
  },

  _createVoice(midi, velocity, when, source) {
    const inst = this.instruments.get(this.currentId);
    if (!inst || !inst.ready) return null;
    const sampleMidi = this.nearestSample(midi);
    if (sampleMidi == null) return null;
    const buffer = inst.buffers.get(sampleMidi);
    if (!buffer) return null;
    if (this.voices.size >= this.MAX_VOICES) this._stealOldest();
    const t0 = Math.max(when || 0, this.ctx.currentTime);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    /* 音高保真：目标音高与采样音高的偏差用 playbackRate 补偿 */
    const rate = Math.pow(2, (midi - sampleMidi) / 12);
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    const peak = this.velocityGain(velocity);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.006); // 起音防爆音
    src.connect(g);
    g.connect(this.master);
    const voice = { id: this.nextVoiceId++, src, g, midi, sampleMidi, source, t0, released: false };
    this.voices.set(voice.id, voice);
    return voice;
  },

  /* 手动演奏：立即发声，返回 voiceId（keyup 时 releaseManual） */
  noteOn(midi, velocity = 0.9, source = 'manual') {
    this.ensureCtx();
    const voice = this._createVoice(midi, velocity, 0, source);
    if (!voice) return null;
    voice.src.start(voice.t0);
    return voice.id;
  },

  /* MIDI 调度：在 ctx 时间轴 when 精确发声，自动在音符末尾安排收尾淡出。
   * 力度提升映射：MIDI 文件的原始力度普遍偏低（典型 0.5–0.8），
   * 与手动演奏（0.92）差距明显——线性抬升仍保留强弱层次。 */
  scheduleNote(midi, when, dur, velocity = 0.9) {
    const lifted = Math.min(1, 0.55 + 0.45 * Math.max(0, Math.min(1, velocity)));
    const voice = this._createVoice(midi, lifted, when, 'play');
    if (!voice) return null;
    voice.src.start(voice.t0);
    this._releaseAt(voice, voice.t0 + Math.max(dur, 0.06), 0.12);
    return voice.id;
  },

  /* 松键：按延音设置安排收尾（延音期内保持自然衰减，随后温和淡出） */
  releaseManual(id) {
    const voice = this.voices.get(id);
    if (!voice) return;
    const s = Math.max(0, this.sustainMs || 0) / 1000;
    if (s <= 0.01) this._releaseAt(voice, this.ctx.currentTime, 0.22);
    else this._releaseAt(voice, this.ctx.currentTime + s, Math.min(0.8, 0.3 + s / 8));
  },

  release(id, fade = 0.28) {
    const voice = this.voices.get(id);
    if (voice) this._releaseAt(voice, this.ctx.currentTime, fade);
  },

  _releaseAt(voice, when, fade) {
    if (voice.released) {
      /* 已安排过收尾：允许用更早的时间覆盖（如紧急静音） */
      if (when < voice.releaseWhen) voice.released = false;
      else return;
    }
    voice.released = true;
    voice.releaseWhen = when;
    const { g, src } = voice;
    try {
      g.gain.setTargetAtTime(0.0001, when, Math.max(fade / 4, 0.012));
      src.stop(when + fade + 0.1);
    } catch { /* 声部已自然结束 */ }
    src.onended = () => this.voices.delete(voice.id);
  },

  /* 平滑接管音量包络：优先 cancelAndHoldAtTime（保持当前值，避免跳变爆音） */
  _holdGain(g, when) {
    if (typeof g.cancelAndHoldAtTime === 'function') {
      try { g.cancelAndHoldAtTime(when); return; } catch { /* fallthrough */ }
    }
    try { g.cancelScheduledValues(when); } catch { /* ignore */ }
  },

  _stealOldest() {
    let oldest = null;
    for (const v of this.voices.values()) {
      if (!oldest || v.t0 < oldest.t0) oldest = v;
    }
    if (oldest) {
      this._holdGain(oldest.g, this.ctx.currentTime);
      oldest.released = false;
      this._releaseAt(oldest, this.ctx.currentTime, 0.04);
    }
  },

  /* 释放某类声部（'manual' / 'play'）；不传则全部释放（紧急静音） */
  releaseAll(source) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      if (!source || v.source === source) {
        if (v.t0 > now + 0.005) {
          /* 已排程但尚未发声：直接掐掉（stop 早于 start 即不播放），杜绝淡出窗口内的突响 */
          try { v.src.onended = null; v.src.stop(now); } catch { /* ignore */ }
          this.voices.delete(v.id);
        } else {
          this._holdGain(v.g, now);
          v.released = false;
          this._releaseAt(v, now, 0.08);
        }
      }
    }
  },

  panic() { this.releaseAll(null); },

  activeVoiceCount() { return this.voices.size; },

  setMasterVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(Math.max(0, v) * this.BOOST, this.ctx.currentTime, 0.02);
  },

  setSustain(ms) { this.sustainMs = Math.max(0, Math.min(8000, ms | 0)); },
};
window.AudioEngine = AudioEngine;
