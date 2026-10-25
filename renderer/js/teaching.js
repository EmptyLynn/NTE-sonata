/* ============================================================================
 * 跟弹教学 —— 练习模式的实验性教学功能
 *
 * 两种模式：
 *  · wait（跟弹·等待）：琴键静音，瀑布流与琴键高亮指示"当前应按的键"，
 *    时间轴推进到当前和弦处驻留，按下正确琴键（判定宽松：不限时序、
 *    和弦内任意顺序、错误键无惩罚）后该音符条变绿并继续；全部完成即通关；
 *  · flow（跟弹·同步）：谱面正常播放（有原曲伴奏），用户跟弹不阻塞，
 *    ±0.6s 内按对即绿。
 *
 *  · 琴键提示：当前和弦 teach-now（金色脉动）、下一和弦 teach-next（虚线）；
 *  · 瀑布流：音符条附带按键名（密集谱面按车道自动去堆叠，见 visualizer）。
 * ==========================================================================*/
const Teaching = {
  mode: 'off',        // off | wait | flow
  active: false,
  chords: [],         // [{t, midis:[], evs:[], hit:Set, done:bool}]
  idx: 0,             // wait 模式当前和弦下标
  _now: 0,            // wait 模式时钟（秒，歌曲时间轴）
  _lastTs: 0,
  hits: 0,
  total: 0,
  state: 'idle',      // idle | teaching | done

  get song() { return MidiPlayer.song; },
  get events() { return MidiPlayer.events; },
  get melodyTrack() { return MidiPlayer.melodyTrack; },
  get duration() { return MidiPlayer.duration; },

  /* Viz 数据源接口：等待模式返回钳制时钟（和弦驻留在判定线上） */
  songTimeNow() {
    if (this.mode === 'wait' && this.active) return this._now;
    return MidiPlayer.songTimeNow();
  },

  /* ---------------- 会话 ---------------- */
  setMode(m) {
    if (this.active) this.stop();
    this.mode = m;
    if (m !== 'off' && MidiPlayer.song) {
      UI.log(m === 'wait'
        ? '教学模式（等待）：跟随高亮与瀑布流按键演奏，按对变绿、时间驻留等待'
        : '教学模式（同步）：原曲正常播放，跟随指示弹奏，按对变绿（不阻塞）', 'info');
    }
  },

  start(fromOffset) {
    if (!MidiPlayer.song || !MidiPlayer.events.length) { UI.log('请先选择 MIDI 文件', 'warn'); return; }
    if (this.mode === 'off') return;
    const evs = MidiPlayer.events;
    for (const ev of evs) { ev._ok = false; }
    /* 按 5ms 起音窗合并为和弦 */
    const chords = [];
    let i = 0;
    while (i < evs.length) {
      const base = evs[i].t;
      const group = [];
      let j = i;
      while (j < evs.length && evs[j].t - base <= 0.005) { group.push(evs[j]); j++; }
      /* 同和弦重复音去重（保留一个） */
      const seen = new Set();
      const midis = [];
      const uniq = [];
      for (const ev of group) {
        if (seen.has(ev.midi)) continue;
        seen.add(ev.midi);
        midis.push(ev.midi);
        uniq.push(ev);
      }
      chords.push({ t: base, midis, evs: uniq, hit: new Set(), done: false });
      i = j;
    }
    this.chords = chords;
    this.total = chords.length;
    this.hits = 0;
    const startAt = Math.max(0, fromOffset != null ? fromOffset : MidiPlayer.offset);
    this.idx = 0;
    while (this.idx < chords.length && chords[this.idx].t < startAt - 0.001) {
      for (const ev of chords[this.idx].evs) ev._ok = true; /* 跳过的直接标记 */
      chords[this.idx].done = true;
      this.idx++;
    }
    this._now = startAt;
    this._lastTs = performance.now();
    this.active = true;
    this.state = 'teaching';
    /* 教学模式下用户按键正常发声（只是不自动弹奏） */
    document.body.classList.add('perf-busy'); /* 锁定参数，复用演奏中锁定样式 */
    if (this.mode === 'wait') {
      window.VizSource = this;
    } else {
      window.VizSource = MidiPlayer;
      MidiPlayer.offset = startAt;
      MidiPlayer.play();
    }
    this._updateHints();
    UI.refreshTransport();
    Viz.lastNow = -1; /* 强制瀑布流重置迸发标记 */
  },

  stop(finished) {
    if (!this.active) return;
    this.active = false;
    this.state = finished ? 'done' : 'idle';
    this._clearHints();
    document.body.classList.remove('perf-busy');
    if (this.mode === 'flow') MidiPlayer.stop();
    window.VizSource = MidiPlayer;
    if (finished) {
      UI.log(`🎉 跟弹完成：命中 ${this.hits}/${this.total} 个和弦`, 'info');
    } else {
      UI.log(`跟弹结束（${this.hits}/${this.total}）`, 'info');
    }
    UI.refreshTransport();
  },

  /* ---------------- 逐帧驱动（ui 主循环调用） ---------------- */
  tick() {
    if (!this.active) return;
    const ts = performance.now();
    const dt = Math.min((ts - this._lastTs) / 1000, 0.25); /* 后台节流/断点保护 */
    this._lastTs = ts;
    if (this.mode === 'wait') {
      const cur = this.chords[this.idx];
      if (cur) {
        /* 驻留在当前和弦（首音给 1.2s 预备余量，之后完全驻留等待） */
        this._now = Math.min(this._now + dt, Math.max(cur.t, this._now));
      } else {
        this._now = Math.min(this._now + dt, this.duration);
        if (this._now >= this.duration - 0.01) { this.stop(true); return; }
      }
    } else {
      /* flow：原曲驱动，结束后收尾（延迟防 ended 时序抖动） */
      if (MidiPlayer.state === 'stopped' && !this._flowEndLatch) {
        this._flowEndLatch = true;
        setTimeout(() => { if (this.active) this.stop(true); }, 600);
      }
      if (MidiPlayer.state !== 'stopped') this._flowEndLatch = false;
    }
    this._updateHints();
  },

  /* ---------------- 用户按键判定（宽松） ---------------- */
  onUserNote(midi) {
    if (this._dbg) this._dbg.calls.push({ midi, active: this.active, mode: this.mode, now: this.mode === 'flow' ? +MidiPlayer.songTimeNow().toFixed(2) : null });
    if (!this.active || this.mode === 'off') return;
    if (this.mode === 'wait') {
      const cur = this.chords[this.idx];
      if (!cur) return;
      if (cur.midis.includes(midi) && !cur.hit.has(midi)) {
        cur.hit.add(midi);
        const ev = cur.evs[cur.midis.indexOf(midi)];
        if (ev) ev._ok = true;
        if (cur.hit.size >= cur.midis.length) {
          cur.done = true;
          this.hits++;
          this.idx++;
          /* 驻留解除，时间继续流向下一和弦 */
        }
      }
      /* 按错：无惩罚（判定宽松） */
    } else {
      /* flow：±0.6s 宽松窗口内匹配最近的同键未命中音符 */
      const now = MidiPlayer.songTimeNow();
      let best = null;
      for (const ev of MidiPlayer.events) {
        if (ev._ok || ev.midi !== midi) continue;
        const d = Math.abs(ev.t - now);
        if (d <= 0.6 && (!best || d < Math.abs(best.t - now))) best = ev;
        if (ev.t > now + 0.6) break;
      }
      if (best) best._ok = true;
      if (this._dbg) this._dbg.matched = (this._dbg.matched || 0) + 1;
    }
  },

  /* ---------------- 琴键提示高亮 ---------------- */
  _updateHints() {
    if (!this.active) return;
    let nowChord = null, nextChord = null;
    if (this.mode === 'wait') {
      nowChord = this.chords[this.idx] || null;
      nextChord = this.chords[this.idx + 1] || null;
    } else {
      const now = MidiPlayer.songTimeNow();
      for (let k = 0; k < this.chords.length; k++) {
        if (this.chords[k].t >= now - 0.15) { nowChord = this.chords[k]; nextChord = this.chords[k + 1] || null; break; }
      }
    }
    this._clearHints();
    if (nextChord) for (const m of nextChord.midis) Keyboard.keyEls.get(m)?.classList.add('teach-next');
    if (nowChord) for (const m of nowChord.midis) Keyboard.keyEls.get(m)?.classList.add('teach-now');
    this._nowChord = nowChord;
  },

  _clearHints() {
    for (const el of document.querySelectorAll('.key.teach-now, .key.teach-next')) {
      el.classList.remove('teach-now', 'teach-next');
    }
  },

  /* 当前进度描述（供进度条下方实时提示） */
  currentHintText() {
    if (!this.active) return '';
    const c = this.mode === 'wait' ? this.chords[this.idx] : this._nowChord;
    return c ? c.midis.map((m) => keyLabel(m)).join(' ') : '';
  },

  progressText() {
    return `跟弹 ${Math.min(this.mode === 'wait' ? this.idx : this.hits, this.total)}/${this.total}`;
  },

  /* 等待模式的进度（0-1，供进度条） */
  progress() {
    if (!this.active || this.mode !== 'wait') return null;
    return this._now / Math.max(this.duration, 0.001);
  },
};
window.Teaching = Teaching;
