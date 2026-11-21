/* ============================================================================
 * 虚拟键盘 —— 映射表 / DOM 生成 / 物理键盘与鼠标输入 / 高亮状态
 *
 * 映射规则（e.code，与大小写、输入法无关）：
 *   低音 Z X C V B N M → C3..B3(48-59)   Shift+Z/V/B→#1/#4/#5  Ctrl+C/M→b3/b7
 *   中音 A S D F G H J → C4..B4(60-71)   Shift+A/F/G→#1/#4/#5  Ctrl+D/J→b3/b7
 *   高音 Q W E R T Y U → C5..B5(72-83)   Shift+Q/R/T→#1/#4/#5  Ctrl+E/U→b3/b7
 * 高亮按 (midi, tag) 引用计数：手动演奏与 MIDI 播放可叠加在同一键上互不冲突。
 * ==========================================================================*/
const SOLFEGE = ['1', '#1', '2', 'b3', '3', '4', '#4', '5', '#5', '6', 'b7', '7'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ACCIDENTALS = new Set([1, 3, 6, 8, 10]);

const midiToName = (m) => SHARP_NAMES[m % 12] + (Math.floor(m / 12) - 1);
/* 键位标签：如 "中音3"、"高音#5" */
function keyLabel(midi) {
  if (Keyboard.instrument === 'guitar') return midiToName(midi);
  const zone = midi < 60 ? '低音' : midi < 72 ? '中音' : '高音';
  return zone + SOLFEGE[midi % 12];
}

const Keyboard = {
  ROWS: [
    {
      id: 'high', label: '高音', base: 72,
      letter: ['Q', 'W', 'E', 'R', 'T', 'Y', 'U'],
      codes: { KeyQ: 0, KeyW: 2, KeyE: 4, KeyR: 5, KeyT: 7, KeyY: 9, KeyU: 11 },
      sharp: { KeyQ: 1, KeyR: 6, KeyT: 8 },
      flat: { KeyE: 3, KeyU: 10 },
    },
    {
      id: 'mid', label: '中音', base: 60,
      letter: ['A', 'S', 'D', 'F', 'G', 'H', 'J'],
      codes: { KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 5, KeyG: 7, KeyH: 9, KeyJ: 11 },
      sharp: { KeyA: 1, KeyF: 6, KeyG: 8 },
      flat: { KeyD: 3, KeyJ: 10 },
    },
    {
      id: 'low', label: '低音', base: 48,
      letter: ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
      codes: { KeyZ: 0, KeyX: 2, KeyC: 4, KeyV: 5, KeyB: 7, KeyN: 9, KeyM: 11 },
      sharp: { KeyZ: 1, KeyV: 6, KeyB: 8 },
      flat: { KeyC: 3, KeyM: 10 },
    },
  ],

  keyEls: new Map(),        // midi -> element
  counts: new Map(),        // midi -> Map(tag -> n)
  heldCodes: new Map(),     // e.code -> {midi, voiceId}
  pointerVoices: new Map(), // pointerId -> {midi, voiceId}
  hintsVisible: true,
  silentDemo: false,        // 演奏模式：琴键仅演示（点亮键位），不发声

  onNoteOn: null,   // (midi, tag) => void，由 ui 层注入
  onNoteOff: null,  // (midi) => void，松键/抬笔时通知（回声音条收尾）
  onPanic: null,    // () => void

  init(container) {
    this.container = container; /* 供 setInstrument 重建 DOM */
    this._buildDOM(container);
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
    window.addEventListener('blur', () => this._releaseAllManual());
    window.addEventListener('pointerup', (e) => this._onPointerEnd(e));
    window.addEventListener('pointercancel', (e) => this._onPointerEnd(e));
  },

  _buildDOM(container) {
    for (const row of this.ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'kbd-row';
      const label = document.createElement('div');
      label.className = 'row-label';
      label.textContent = row.label;
      rowEl.appendChild(label);

      const keys = document.createElement('div');
      keys.className = 'keys';
      /* 反查：变化音 → 组合键提示 */
      const accHint = {};
      for (const [code, off] of Object.entries(row.sharp)) accHint[off] = '⇧' + this._letterOf(row, code);
      for (const [code, off] of Object.entries(row.flat)) accHint[off] = '↓' + this._letterOf(row, code);

      for (let off = 0; off < 12; off++) {
        const midi = row.base + off;
        const el = document.createElement('div');
        el.className = 'key' + (this.instrument !== 'guitar' && ACCIDENTALS.has(off) ? ' acc' : '');
        el.dataset.midi = midi;

        if (this.instrument === 'guitar') {
          /* 吉他：键面 = 音名（E3、F#3…） */
          const sol = document.createElement('span');
          sol.className = 'solfege face-sm';
          sol.textContent = midiToName(midi);
          el.appendChild(sol);
        } else {
          /* 钢琴（原有逻辑不变） */
          if (row.id === 'high') {
            const dot = document.createElement('span');
            dot.className = 'oct-dot top';
            el.appendChild(dot);
          }
          const sol = document.createElement('span');
          sol.className = 'solfege';
          sol.textContent = SOLFEGE[off];
          el.appendChild(sol);
          if (row.id === 'low') {
            const dot = document.createElement('span');
            dot.className = 'oct-dot bottom';
            el.appendChild(dot);
          }
        }

        const hint = document.createElement('span');
        hint.className = 'hint';
        if (this.instrument === 'guitar') {
          hint.textContent = row.letter[off];
        } else if (ACCIDENTALS.has(off)) {
          hint.textContent = accHint[off] || '';
        } else {
          const code = Object.keys(row.codes).find((c) => row.codes[c] === off);
          hint.textContent = this._letterOf(row, code);
        }
        el.appendChild(hint);

        el.addEventListener('pointerdown', (e) => this._onPointerDown(e, midi));
        this.keyEls.set(midi, el);
        keys.appendChild(el);
      }
      rowEl.appendChild(keys);
      container.appendChild(rowEl);
    }
  },

  _letterOf(row, code) {
    if (!code) return '';
    const idx = Object.keys(row.codes).indexOf(code);
    return idx >= 0 ? row.letter[idx] : code.replace('Key', '');
  },

  /* ---------- 高亮（引用计数，支持手动/播放叠加） ---------- */
  press(midi, tag = 'manual') {
    if (!this.keyEls.has(midi)) return;
    let tags = this.counts.get(midi);
    const first = !tags || tags.size === 0; /* 0→1 过渡：回声条记一次 */
    if (!tags) { tags = new Map(); this.counts.set(midi, tags); }
    tags.set(tag, (tags.get(tag) || 0) + 1);
    if (first && window.Viz && Viz.noteOn) Viz.noteOn(midi);
    if (tags.get(tag) === 1 && tags.size === 1) {
      const el = this.keyEls.get(midi);
      el.classList.add('active');
      const r = document.createElement('span');
      r.className = 'ripple';
      el.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }
  },

  release(midi, tag = 'manual') {
    const tags = this.counts.get(midi);
    if (!tags) return;
    const n = (tags.get(tag) || 1) - 1;
    if (n <= 0) tags.delete(tag); else tags.set(tag, n);
    if (!tags.size) {
      this.counts.delete(midi);
      this.keyEls.get(midi).classList.remove('active');
      if (window.Viz && Viz.noteOff) Viz.noteOff(midi);
    }
  },

  releaseAll(tag) {
    for (const midi of [...this.counts.keys()]) this.release(midi, tag);
  },

  _releaseAllManual() {
    for (const [, h] of this.heldCodes) {
      if (h.voiceId) AudioEngine.releaseManual(h.voiceId);
      this.release(h.midi, 'manual');
      if (this.onNoteOff) this.onNoteOff(h.midi);
    }
    this.heldCodes.clear();
    for (const [, h] of this.pointerVoices) {
      if (h.voiceId) AudioEngine.releaseManual(h.voiceId);
      this.release(h.midi, 'manual');
      if (this.onNoteOff) this.onNoteOff(h.midi);
    }
    this.pointerVoices.clear();
  },

  /* ---------- 物理键盘 ---------- */
  _isTypingTarget(e) {
    const t = e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return true;
    if (t.tagName === 'INPUT') {
      /* 滑杆不阻断演奏：调完延音/速度/音量后直接弹琴 */
      const type = (t.getAttribute('type') || '').toLowerCase();
      return !['range', 'button', 'checkbox', 'radio'].includes(type);
    }
    return false;
  },

  resolveMidi(code, shiftKey, ctrlKey) {
    for (const row of this.ROWS) {
      if (ctrlKey && row.flat[code] != null) return row.base + row.flat[code];
      if (shiftKey && row.sharp[code] != null) return row.base + row.sharp[code];
      if (row.codes[code] != null) return row.base + row.codes[code];
    }
    return null;
  },

  _onKeyDown(e) {
    if (e.repeat || this._isTypingTarget(e)) return;
    if (e.code === 'Escape') { e.preventDefault(); this.onPanic && this.onPanic(); return; }
    const midi = this.resolveMidi(e.code, e.shiftKey, e.ctrlKey);
    if (midi == null) return;
    e.preventDefault(); // 拦截 Ctrl+C 等组合键的系统行为
    if (this.heldCodes.has(e.code)) return;
    /* 演奏模式：仅演示键位点亮，不发声（真实声音由游戏发出） */
    const voiceId = this.silentDemo ? null : AudioEngine.noteOn(midi, 0.92, 'manual');
    this.heldCodes.set(e.code, { midi, voiceId });
    this.press(midi, 'manual');
    if (this.onNoteOn) this.onNoteOn(midi, 'manual');
  },

  _onKeyUp(e) {
    const held = this.heldCodes.get(e.code);
    if (!held) return;
    this.heldCodes.delete(e.code);
    if (held.voiceId) AudioEngine.releaseManual(held.voiceId);
    this.release(held.midi, 'manual');
    if (this.onNoteOff) this.onNoteOff(held.midi);
  },

  /* ---------- 鼠标 / 触控（按住 Shift/Ctrl 点击 → 变化音，与键盘规则一致） ---------- */
  _onPointerDown(e, clickedMidi) {
    if (e.button !== 0) return;
    e.preventDefault();
    let midi = clickedMidi;
    const off = clickedMidi % 12;
    if (e.ctrlKey && [4, 11].includes(off)) midi -= 1;       // 3→b3, 7→b7
    else if (e.shiftKey && [0, 5, 7].includes(off)) midi += 1; // 1→#1, 4→#4, 5→#5
    const voiceId = this.silentDemo ? null : AudioEngine.noteOn(midi, 0.92, 'manual');
    this.pointerVoices.set(e.pointerId, { midi, voiceId });
    this.press(midi, 'manual');
    if (this.onNoteOn) this.onNoteOn(midi, 'manual');
  },

  _onPointerEnd(e) {
    const held = this.pointerVoices.get(e.pointerId);
    if (!held) return;
    this.pointerVoices.delete(e.pointerId);
    if (held.voiceId) AudioEngine.releaseManual(held.voiceId);
    this.release(held.midi, 'manual');
    if (this.onNoteOff) this.onNoteOff(held.midi);
  },

  toggleHints() {
    this.hintsVisible = !this.hintsVisible;
    document.body.classList.toggle('no-hints', !this.hintsVisible);
    return this.hintsVisible;
  },

  /* ---------- 乐器切换（纯添加，不影响钢琴逻辑） ---------- */
  instrument: 'piano',
  get min() { return this.instrument === 'guitar' ? 52 : 48; },
  get max() { return this.instrument === 'guitar' ? 87 : 83; },
  _pianoRows: null,  /* 缓存钢琴 ROWS（切回时恢复） */

  setInstrument(id) {
    if (id === this.instrument) return;
    this._releaseAllManual();
    if (id === 'piano' && this._pianoRows) {
      this.ROWS = this._pianoRows;
    } else if (id === 'guitar') {
      if (!this._pianoRows) this._pianoRows = this.ROWS;
      this.ROWS = this._buildGuitarRows();
    } else { return; }
    this.instrument = id;
    this.keyEls.clear();
    this.counts.clear();
    this.container.innerHTML = '';
    this._buildDOM(this.container);
    if (this.onInstrumentChanged) this.onInstrumentChanged(id);
  },

  _buildGuitarRows() {
    /* 吉他键位（与游戏一致）：低音 A-⏎(52-63)、中音 Q-](64-75)、高音 1-=(76-87)
     * 每键一个半音，无 Shift/Ctrl 修饰 */
    const G = {
      low:  { label: '低音', base: 52, letter: ['A','S','D','F','G','H','J','K','L',';',"'",'⏎'],
              codes: { KeyA:0, KeyS:1, KeyD:2, KeyF:3, KeyG:4, KeyH:5, KeyJ:6, KeyK:7, KeyL:8, Semicolon:9, Quote:10, Enter:11 } },
      mid:  { label: '中音', base: 64, letter: ['Q','W','E','R','T','Y','U','I','O','P','[',']'],
              codes: { KeyQ:0, KeyW:1, KeyE:2, KeyR:3, KeyT:4, KeyY:5, KeyU:6, KeyI:7, KeyO:8, KeyP:9, BracketLeft:10, BracketRight:11 } },
      high: { label: '高音', base: 76, letter: ['1','2','3','4','5','6','7','8','9','0','-','='],
              codes: { Digit1:0, Digit2:1, Digit3:2, Digit4:3, Digit5:4, Digit6:5, Digit7:6, Digit8:7, Digit9:8, Digit0:9, Minus:10, Equal:11 } },
    };
    return [G.high, G.mid, G.low].map((r) => ({
      id: r.label === '低音' ? 'low' : r.label === '中音' ? 'mid' : 'high',
      label: r.label, base: r.base, letter: r.letter,
      codes: r.codes,
      sharp: {},  /* 吉他无修饰键 */
      flat: {},
    }));
  },
};
window.Keyboard = Keyboard;
window.midiToName = midiToName;
window.keyLabel = keyLabel;

/* 音高 → 物理按键提示（如 'A' / '⇧A' / '↓E'）：跟弹提示条与键盘谱导出共用 */
function midiKeyHint(midi) {
  if (Keyboard.instrument === 'guitar') {
    for (const row of Keyboard.ROWS) {
      const off = midi - row.base;
      if (off >= 0 && off <= 11 && row.codes[Object.keys(row.codes).find((c) => row.codes[c] === off)] != null) {
        return row.letter[Object.values(row.codes).indexOf(off)];
      }
    }
    return '?';
  }
  for (const row of Keyboard.ROWS) {
    const off = midi - row.base;
    if (off < 0 || off > 11) continue;
    for (const [code, o] of Object.entries(row.codes)) {
      if (o === off) {
        const idx = Object.keys(row.codes).indexOf(code);
        return row.letter[idx];
      }
    }
    for (const [code, o] of Object.entries(row.sharp)) {
      if (o === off) {
        const idx = Object.keys(row.codes).indexOf(code);
        return '⇧' + row.letter[idx];
      }
    }
    for (const [code, o] of Object.entries(row.flat)) {
      if (o === off) {
        const idx = Object.keys(row.codes).indexOf(code);
        return '↓' + row.letter[idx];
      }
    }
  }
  return '?';
}
window.midiKeyHint = midiKeyHint;
