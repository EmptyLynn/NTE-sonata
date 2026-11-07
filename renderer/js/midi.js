/* ============================================================================
 * MIDI 解析封装 —— @tonejs/midi（vendor UMD）
 *  · RIFF / RMID 封装的 .rmi 自动剥壳（有的工具把 SMF 包在 RIFF 容器里）；
 *  · 输出统一结构：{name, tempo, duration, tracks:[{index,name,channel,noteCount,notes}]}；
 *  · 解析异常抛出可读错误。
 * ==========================================================================*/
const MidiSource = {
  resolveCtor() {
    if (typeof Midi !== 'undefined' && typeof Midi === 'function') return Midi;
    if (window.Midi) {
      if (typeof window.Midi === 'function') return window.Midi;
      if (window.Midi.Midi) return window.Midi.Midi;
    }
    const ns = window['@tonejs/midi'];
    if (ns && ns.Midi) return ns.Midi;
    throw new Error('未找到 MIDI 解析库（vendor/midi.js 加载失败）');
  },

  /* 乱码修复：@tonejs/midi 按字节解名，UTF-8 中文会变成 Latin-1 乱码。
   * 检测到非 ASCII 时尝试按 UTF-8 重解码；失败（GBK/Shift-JIS 等）保持原样。 */
  _fixMojibake(s) {
    if (!s || !/[^\x00-\x7F]/.test(s)) return s;
    try {
      const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return s;
    }
  },

  _stripRIFF(u8) {
    const head = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (head !== 'RIFF') return u8;
    for (let i = 4; i < Math.min(u8.length - 4, 512); i++) {
      if (u8[i] === 0x4d && u8[i + 1] === 0x54 && u8[i + 2] === 0x68 && u8[i + 3] === 0x64) {
        return u8.slice(i); // 找到 'MThd'
      }
    }
    throw new Error('RIFF 容器中未找到 MIDI 数据（MThd）');
  },

  parse(input /* ArrayBuffer | Uint8Array */) {
    let u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (u8.length < 14) throw new Error('文件太小，不是有效的 MIDI');
    u8 = this._stripRIFF(u8);
    const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (sig !== 'MThd') {
      throw new Error('无法识别的文件格式（不是标准 MIDI，也不是 RIFF 封装）');
    }
    let midi;
    try {
      midi = new (this.resolveCtor())(u8);
    } catch (err) {
      throw new Error('MIDI 解析失败：' + (err && err.message ? err.message : '数据损坏'));
    }

    const tracks = midi.tracks.map((t, i) => {
      /* CC64 延音踏板 → 按下区间。
       * 注意 @tonejs/midi 已把 CC 值归一化到 0..1（127→1），故以 0.5 为踩下阈值；
       * 兼容未归一化的原始值（≥64），参考 MaaNTE midi_processor 的算法。 */
      const pedalSpans = [];
      const cc = t.controlChanges && t.controlChanges[64];
      if (Array.isArray(cc)) {
        let open = null;
        for (const ev of cc) {
          const down = ev.value >= (ev.value > 1 ? 64 : 0.5);
          if (down && open == null) open = ev.time;
          else if (!down && open != null) { pedalSpans.push([open, ev.time]); open = null; }
        }
        if (open != null) pedalSpans.push([open, Infinity]);
        pedalSpans.sort((a, b) => a[0] - b[0]);
      }
      return {
        index: i,
        name: this._fixMojibake(((t.name || '').trim() || (t.instrument && t.instrument.name) || `轨道 ${i}`).trim()),
        channel: typeof t.channel === 'number' ? t.channel : -1,
        noteCount: t.notes.length,
        pedalSpans,
        notes: t.notes.map((n) => ({
          midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity,
        })),
      };
    });

    return {
      name: this._fixMojibake((midi.header.name || '').trim()),
      tempo: midi.header.tempos && midi.header.tempos.length
        ? Math.round(midi.header.tempos[0].bpm) : 120,
      duration: midi.duration || 0,
      trackCount: midi.tracks.length,
      tracks,
      totalNotes: tracks.reduce((s, t) => s + t.noteCount, 0),
      key: this.detectKey(midi, tracks),
    };
  },

  /* ---------- 调性检测 ----------
   * 优先用 MIDI 调号元事件（SMF FF59，@tonejs/midi 解析为 header.keySignatures）；
   * 缺失时退回 Krumhansl-Schmuckler 算法：时长加权的音级直方图与 24 个
   * 大小调音阶轮廓做相关，取相关系数最高者。 */
  detectKey(midi, tracks) {
    try {
      const ks = midi.header && midi.header.keySignatures;
      if (Array.isArray(ks) && ks.length) {
        return this._keyName(ks[0].key, ks[0].scale);
      }
      const hist = new Array(12).fill(0);
      for (const t of tracks) {
        for (const n of t.notes) hist[((n.midi % 12) + 12) % 12] += (n.dur || 0.25);
      }
      if (!hist.some((v) => v > 0)) return '';
      const maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
      const min = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const corr = (h, prof) => {
        const mh = mean(h), mp = mean(prof);
        let num = 0, dh = 0, dp = 0;
        for (let i = 0; i < 12; i++) { const a = h[i] - mh, b = prof[i] - mp; num += a * b; dh += a * a; dp += b * b; }
        return num / Math.sqrt((dh * dp) || 1);
      };
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      let best = '', bestR = -2;
      for (let r = 0; r < 12; r++) {
        const rot = (p) => p.map((_, i) => p[(i + r) % 12]);
        const rm = corr(hist, rot(maj));
        const rn = corr(hist, rot(min));
        if (rm > bestR) { bestR = rm; best = names[r] + '大调'; }
        if (rn > bestR) { bestR = rn; best = names[r] + '小调'; }
      }
      return best;
    } catch { return ''; }
  },

  _keyName(key, scale) {
    const map = { C: 0, G: 7, D: 2, A: 9, E: 4, B: 11, 'F#': 6, 'C#': 1, F: 5, Bb: 10, Eb: 3, Ab: 8, Db: 1, Gb: 6, Cb: 11 };
    const n = map[key] != null ? ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][map[key]] : key;
    return (n || key) + (scale === 'minor' ? '小调' : '大调');
  },
};
window.MidiSource = MidiSource;
