/* ============================================================================
 * MIDI 自动演奏调度器 —— 双时钟方案
 *
 *  · 音频时钟：25ms lookahead 定时器把未来 ~160ms（歌曲时间轴）内的音符用
 *    AudioContext.currentTime 精确排程给音频线程（声音采样级精准）；
 *  · UI 时钟：灯效事件进入队列，由 rAF 在到期时点亮/熄灭琴键（视觉同步）；
 *  · 进度 = 锚点换算（anchorCtx / anchorSong + speed），支持：
 *      - 进度条任意位置起播（seek 停声部→重锚→重排程）；
 *      - 播放中实时变速（重锚，未触发事件重排）；
 *      - 转调/选轨/超域模式热切换（重建队列，保持当前进度与播放状态）。
 *
 * 处理管线：选轨 → 转调 → 超域(fold/shift/cut) → 同键 10ms 去重 → 事件队列
 * ==========================================================================*/
const MidiPlayer = {
  song: null,
  state: 'stopped',          // stopped | playing | paused
  events: [],                // [{t, midi, vel, dur}] 歌曲时间轴（秒）
  duration: 1,
  offset: 0,
  anchorSong: 0,
  anchorCtx: 0,
  speed: 1,
  settings: { trackSel: 'all', customTracks: '', transpose: 0, rangeMode: 'fold' },
  cursor: 0,
  timer: null,
  uiQueue: [],               // [{at, midi, on}]（at = ctx 时间）
  stats: { total: 0, mapped: 0, dropped: 0 },
  activeTrackLabel: '',
  melodyTrack: -1,
  LOOKAHEAD: 0.16,
  TICK: 25,

  onStateChange: null,       // () => void
  onSeek: null,              // () => void
  log: null,                 // (text, cls) => void

  /* ---------------- 加载与构建 ---------------- */
  load(song) {
    this.stop();
    this.song = song;
    this.rebuild(true);
  },

  rebuild(resetPos) {
    if (!this.song) return;
    const wasPlaying = this.state === 'playing';
    const pos = this.songTimeNow();
    /* 关键：先把状态置为 paused，否则下方 play() 会因"已在播放"提前返回，
     * 旧调度游标/锚点残留 → 热切换后无声（须暂停再播放才能恢复的根因）。 */
    if (wasPlaying) this.state = 'paused';
    this._cancelVoices();
    const res = this._buildQueue(this.song, this.settings);
    this.events = res.events;
    this.duration = Math.max(res.lastT + 0.5, this.song.duration || 0, 1);
    this.stats = res.stats;
    this.activeTrackLabel = res.trackLabel;
    this.melodyTrack = res.melodyTrack;
    this.offset = Math.max(0, Math.min(pos, this.duration));
    if (wasPlaying) this.play();
    this.onStateChange && this.onStateChange();
  },

  _buildQueue(song, st, target) {
    const min = target ? target.min : 48;
    const max = target ? target.max : 83;
    const center = (min + max) / 2;
    /* --- 选轨 --- */
    let idxs = [];
    let trackLabel = '';
    let melodyIdx = -1;
    if (st.trackSel === 'all') {
      /* 全部轨道：排除打击乐通道（ch9）——打击乐的"音高"是鼓件编号，混入会变成怪音 */
      song.tracks.forEach((t, i) => { if (t.channel !== 9) idxs.push(i); });
      trackLabel = `全部${idxs.length}/${song.tracks.length}轨`;
    } else if (st.trackSel === 'melody') {
      let best = -1, bestN = -1;
      song.tracks.forEach((t, i) => {
        if (t.channel === 9) return; // 通道 9 = 打击乐
        if (t.noteCount > bestN) { bestN = t.noteCount; best = i; }
      });
      idxs = best >= 0 ? [best] : [];
      melodyIdx = best;
      trackLabel = best >= 0 ? `主旋律:轨道${best}(${bestN}音)` : '无可用轨道';
    } else {
      idxs = st.customTracks.split(/[,，\s]+/).map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < song.tracks.length);
      trackLabel = `轨道 ${idxs.join(',') || '—'}`;
    }

    /* --- 取音符 + 转调 + 延音踏板（CC64）扩展 ---
     * 踏板踩下期间的 note-off 延迟到抬板（参考 MaaNTE midi_processor 的算法），
     * 这是 MIDI "还原度"的关键之一：许多乐谱的连奏全靠踏板记号。 */
    let notes = [];
    for (const i of idxs) {
      const track = song.tracks[i];
      const spans = track.pedalSpans || [];
      const extendOff = (offT) => {
        if (!spans.length) return offT;
        for (const [s, e] of spans) {
          if (offT > s && offT < e) return Math.min(e, offT + 10); // 抬板即止，最长补 10s 防异常
          if (s >= offT) break; // spans 有序，后面的更晚
        }
        return offT;
      };
      for (const n of track.notes) {
        const rawOff = n.time + n.dur;
        const offT = extendOff(rawOff);
        notes.push({
          tr: i,
          midi: n.midi + (st.transpose || 0),
          t: n.time,
          dur: Math.max(n.dur, offT - n.time),
          vel: n.vel,
        });
      }
    }
    const total = notes.length;

    /* --- 超域处理（目标音域：练习模式 48–83 / 演奏模式 60–95，语义一致） --- */
    let dropped = 0;
    if (st.rangeMode === 'cut') {
      notes = notes.filter((n) => n.midi >= min && n.midi <= max);
      dropped = total - notes.length;
    } else if (st.rangeMode === 'shift') {
      /* 枚举八度平移：优先"范围内音符最多"，平手时取整体离音域中心最近的 */
      let bestS = 0, bestScore = -Infinity;
      for (let s = -36; s <= 36; s += 12) {
        let inRange = 0, disp = 0;
        for (const n of notes) {
          const m = n.midi + s;
          if (m >= min && m <= max) { inRange++; disp += Math.abs(m - center); }
        }
        const score = inRange * 10000 - disp;
        if (score > bestScore) { bestScore = score; bestS = s; }
      }
      notes = notes
        .map((n) => ({ ...n, midi: n.midi + bestS }))
        .filter((n) => n.midi >= min && n.midi <= max);
      dropped = total - notes.length;
      trackLabel += bestS ? ` 移${bestS > 0 ? '+' : ''}${bestS / 12}个八度` : '';
    } else {
      // fold：就近八度折叠（MaaNTE adjust_pitch 同款）——只移动到最近的音区边界，
      // 保持各声部相对音区关系。此前用的模运算会把低音 Bass 抛到高音区（"怪高音"根源）。
      notes = notes.map((n) => {
        let m = n.midi;
        if (m < min) m += Math.ceil((min - m) / 12) * 12;
        else if (m > max) m -= Math.ceil((m - max) / 12) * 12;
        return { ...n, midi: m };
      });
    }

    /* --- 同键 10ms 内重复触发去重（多轨合并常见，避免声部无谓翻倍） --- */
    notes.sort((a, b) => a.t - b.t || a.midi - b.midi);
    const seen = new Set();
    const events = [];
    for (const n of notes) {
      if (n.t < 0) continue;
      const key = n.midi * 1e7 + Math.round(n.t * 100);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ t: n.t, midi: n.midi, vel: n.vel, dur: Math.max(0.05, n.dur), tr: n.tr ?? 0 });
    }
    events.sort((a, b) => a.t - b.t);
    const lastT = events.length ? events[events.length - 1].t + events[events.length - 1].dur : 0;
    return {
      events, lastT,
      stats: { total, mapped: events.length, dropped },
      trackLabel,
      melodyTrack: melodyIdx,
    };
  },

  /* ---------------- 播放状态机 ---------------- */
  songTimeNow() {
    if (this.state === 'playing' && AudioEngine.ctx) {
      return this.anchorSong + (AudioEngine.ctx.currentTime - this.anchorCtx) * this.speed;
    }
    return this.offset;
  },

  play() {
    if (!this.song || !this.events.length) return;
    AudioEngine.ensureCtx();
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.anchorSong = Math.min(this.offset, this.duration);
    this.anchorCtx = AudioEngine.ctx.currentTime;
    this.cursor = this._lowerBound(this.anchorSong);
    this._schedIdx = this.cursor;
    if (!this.timer) this.timer = setInterval(() => this._tick(), this.TICK);
    this._tick();
    this.onStateChange && this.onStateChange();
  },

  pause() {
    if (this.state !== 'playing') return;
    this.offset = this.songTimeNow();
    this.state = 'paused';
    this._cancelVoices();
    this.onStateChange && this.onStateChange();
  },

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  },

  stop() {
    const changed = this.state !== 'stopped';
    this.state = 'stopped';
    this._cancelVoices();
    this.offset = 0;
    if (changed) this.onStateChange && this.onStateChange();
  },

  seek(t) {
    if (!this.song) return;
    t = Math.max(0, Math.min(t, this.duration));
    if (this.state === 'playing') {
      this._cancelVoices();
      this.offset = t;
      this.anchorSong = t;
      this.anchorCtx = AudioEngine.ctx.currentTime;
      this.cursor = this._lowerBound(t);
      this._schedIdx = this.cursor;
      this._tick();
    } else {
      this.offset = t;
    }
    this.onSeek && this.onSeek();
  },

  setSpeed(v) {
    v = Math.max(0.25, Math.min(3, v));
    if (this.state === 'playing') {
      /* 丝滑变速：不杀声部、原地重锚，正在响的音自然延续。
       * cursor 从"已排程下标"起（跳过已排进 lookahead 窗口的音符，防止双发）。 */
      const pos = this.songTimeNow();
      this.speed = v;
      this.offset = pos;
      this.anchorSong = pos;
      this.anchorCtx = AudioEngine.ctx.currentTime;
      this.cursor = Math.max(this._lowerBound(pos), this._schedIdx || 0);
      this._tick();
    } else {
      this.speed = v;
    }
  },

  /* ---------------- 内部 ---------------- */
  _lowerBound(t) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  },

  _tick() {
    if (this.state !== 'playing') return;
    const now = this.songTimeNow();
    const horizon = now + this.LOOKAHEAD * this.speed;
    while (this.cursor < this.events.length && this.events[this.cursor].t <= horizon) {
      const ev = this.events[this.cursor++];
      let atCtx = this.anchorCtx + (ev.t - this.anchorSong) / this.speed;
      const nowCtx = AudioEngine.ctx.currentTime;
      if (atCtx < nowCtx) atCtx = nowCtx;
      AudioEngine.scheduleNote(ev.midi, atCtx, ev.dur / this.speed, ev.vel);
      this.uiQueue.push({ at: atCtx, midi: ev.midi, on: true });
      this.uiQueue.push({ at: atCtx + ev.dur / this.speed, midi: ev.midi, on: false });
      if (this.log) this.log(`${midiToName(ev.midi)} · ${keyLabel(ev.midi)}`, 'note');
    }
    this._schedIdx = this.cursor; /* 已排程下标（丝滑变速防双发用） */
    if (now >= this.duration) this.stop();
  },

  _cancelVoices() {
    AudioEngine.releaseAll('play');   // 已响 + 已排程未响的播放声部全部快速淡出
    this.uiQueue.length = 0;
    Keyboard.releaseAll('play');
  },

  /* rAF 每帧调用：到期灯效 */
  consumeUi() {
    if (!AudioEngine.ctx || !this.uiQueue.length) return;
    const nowCtx = AudioEngine.ctx.currentTime;
    while (this.uiQueue.length && this.uiQueue[0].at <= nowCtx + 0.005) {
      const it = this.uiQueue.shift();
      if (it.on) Keyboard.press(it.midi, 'play');
      else Keyboard.release(it.midi, 'play');
    }
  },
};
window.MidiPlayer = MidiPlayer;

/* ============================================================================
 * 演奏模式辅助 —— 游戏键位映射（60–95，迁移自 MaaNTE key_mapping.py 实证表）
 *   低音 Z 行 = C4(60)-B4(71)，中音 A 行 = C5(72)-B5(83)，高音 Q 行 = C6(84)-B6(95)
 *   Shift+白键 = 升半音；Ctrl+白键 = 降半音（与游戏内一致）
 * ==========================================================================*/
const GAME_KEY_MAP = {
  60: 'z', 61: 'shift+z', 62: 'x', 63: 'ctrl+c', 64: 'c', 65: 'v', 66: 'shift+v',
  67: 'b', 68: 'shift+b', 69: 'n', 70: 'ctrl+m', 71: 'm',
  72: 'a', 73: 'shift+a', 74: 's', 75: 'ctrl+d', 76: 'd', 77: 'f', 78: 'shift+f',
  79: 'g', 80: 'shift+g', 81: 'h', 82: 'ctrl+j', 83: 'j',
  84: 'q', 85: 'shift+q', 86: 'w', 87: 'ctrl+e', 88: 'e', 89: 'r', 90: 'shift+r',
  91: 't', 92: 'shift+t', 93: 'y', 94: 'ctrl+u', 95: 'u',
};

/* 构造演奏模式和弦调度：
 *  · 完全复用练习模式的事件管线（同样的选轨/转调/踏板/超域处理，目标音域同为
 *    48–83）——保证两种模式弹奏内容逐音一致；
 *  · 仅在发送按键前把结果 +12 平移到游戏键位（60–95）：模拟器 Z/A/Q 三排与
 *    游戏三排物理键一一对应，同一琴位同一键；
 *  · 5ms 内齐响的音符合并为一个和弦（MaaNTE DEFAULT_CHORD_WINDOW 同款）；
 *  · t 已按速度换算（主进程直接对齐绝对时刻）；
 *  · 可视事件 midi 即模拟器音域（48–83），瀑布流/琴键联动与练习模式同源。 */
function buildPerfSchedule(song, st, speed) {
  const res = MidiPlayer._buildQueue(song, st); /* 与练习模式完全一致 */
  const evs = res.events.map((e) => ({ ...e, t: e.t / speed }));
  evs.sort((a, b) => a.t - b.t);

  const CHORD_WINDOW = 0.005;
  const chords = [];
  const visual = [];
  let i = 0;
  while (i < evs.length) {
    const base = evs[i].t;
    const group = [];
    let j = i;
    while (j < evs.length && Math.abs(evs[j].t - base) <= CHORD_WINDOW) {
      group.push(evs[j]);
      j++;
    }
    const seen = new Set();
    const keys = [];
    const pitches = [];
    for (const ev of group) {
      if (seen.has(ev.midi)) continue; // 同和弦重复音去重
      seen.add(ev.midi);
      const gameMidi = ev.midi + 12; // 模拟器音域(48–83) → 游戏键位(60–95)，同一物理键
      keys.push(GAME_KEY_MAP[gameMidi]);
      pitches.push(gameMidi);
      visual.push({ ...ev, dur: ev.dur / speed }); // midi 保持 48–83，与练习模式同源
    }
    chords.push({ t: base * 1000, keys, pitches });
    i = j;
  }
  return {
    chords, visual,
    stats: res.stats,
    trackLabel: res.trackLabel,
    melodyTrack: res.melodyTrack,
    duration: res.lastT / speed + 0.5, /* 和弦时刻已按速度换算，时长同步换算 */
  };
}
window.buildPerfSchedule = buildPerfSchedule;
window.GAME_KEY_MAP = GAME_KEY_MAP;
