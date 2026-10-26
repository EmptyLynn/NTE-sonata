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
    };
  },
};
window.MidiSource = MidiSource;
