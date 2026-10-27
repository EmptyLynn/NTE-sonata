/* ============================================================================
 * 演奏模式 —— 渲染层控制器
 *
 *  职责：
 *   · 模式切换（练习 ⇄ 演奏）与专属面板（窗口选择/输入方式/按键时长/测试）；
 *   · 把 MidiPlayer 的解析结果转成主进程和弦调度（buildPerfSchedule）；
 *   · 接收主进程 perf-note/progress/ended 事件，驱动琴键高亮与瀑布流
 *     （Perf 自身实现 Viz 所需的 events/songTimeNow 接口，作为可视化数据源）。
 * ==========================================================================*/
const Perf = {
  active: false,
  mode: 'bg',            // bg 后台注入 | fg 前台模拟
  hwnd: 0,
  windowTitle: '',
  holdMs: 8,
  countdown: 3,
  windows: [],
  autoHwnd: 0,

  /* 播放状态（Viz 接口） */
  state: 'stopped',      // stopped | countdown | playing | paused
  events: [],            // 可视事件（midi 已 -12 映射到 48–83）
  duration: 1,
  melodyTrack: -1,
  song: null,
  /* 显示时钟：worker 是位置的唯一权威，每 ~100ms 报告一次（盖纪元章）；
   * 渲染层在两次报告之间线性外推（抖动 ≤30ms 不可见），不做人漂移校正 */
  _dispT: 0,             // worker 最近报告的真实时间位置（秒）
  _dispAt: 0,            // 该位置对应的本机时刻（performance.now()）
  _sidSeq: 0,            // 纪元计数器：play/seek 都会递增
  sid: 0,                // 当前纪元：worker 事件盖章比对，不符即弃
  stats: { total: 0, mapped: 0, dropped: 0 },
  activeTrackLabel: '',
  _lastProgT: 0,

  els: {},

  init() {
    this.els = {
      panel: document.getElementById('perf-panel'),
      modeSeg: document.getElementById('mode-seg'),
      btnPractice: document.getElementById('mode-practice'),
      btnPerf: document.getElementById('mode-perf'),
      winSel: document.getElementById('perf-window'),
      btnRefresh: document.getElementById('perf-refresh'),
      btnAuto: document.getElementById('perf-auto'),
      inputMode: document.getElementById('perf-input-mode'),
      hold: document.getElementById('perf-hold'),
      countdown: document.getElementById('perf-countdown'),
      btnTest: document.getElementById('perf-test'),
      btnDiag: document.getElementById('perf-diagnose'),
      btnAdmin: document.getElementById('perf-admin'),
      adminChip: document.getElementById('perf-admin-chip'),
      status: document.getElementById('perf-status'),
    };
    this.els.btnPractice.addEventListener('click', () => this.setActive(false));
    this.els.btnPerf.addEventListener('click', () => this.setActive(true));
    this.els.btnRefresh.addEventListener('click', () => this.refreshWindows(true));
    this.els.btnAuto.addEventListener('click', () => {
      this.hwnd = this.autoHwnd;
      this.syncWindowSel();
      this.updateStatus(this.autoHwnd ? `已自动连接游戏窗口` : '未检测到游戏窗口（异环/NTE）');
    });
    this.els.winSel.addEventListener('change', () => {
      const opt = this.els.winSel.selectedOptions[0];
      this.hwnd = Number(this.els.winSel.value) || 0;
      this.windowTitle = opt ? opt.textContent : '';
      this.updateStatus();
    });
    this.els.inputMode.addEventListener('change', () => {
      this.mode = this.els.inputMode.value;
      this.savePrefs();
      this.updateStatus();
    });
    this.els.hold.addEventListener('change', () => {
      this.holdMs = Math.max(2, Math.min(60, parseInt(this.els.hold.value, 10) || 8));
      this.savePrefs();
    });
    this.els.countdown.addEventListener('change', () => {
      this.countdown = parseInt(this.els.countdown.value, 10) || 0;
      this.savePrefs();
    });
    this.els.btnTest.addEventListener('click', async () => {
      if (!window.yihuan || !window.yihuan.isElectron) { UI.log('演奏模式仅在桌面版可用', 'warn'); return; }
      if (!this.ensureHwnd()) return;
      const r = await window.yihuan.perfTest(this.hwnd, this.mode);
      UI.log(r.ok ? '测试和弦已发送（C-E-G），游戏内应有反应' : '测试失败：' + r.error, r.ok ? 'info' : 'err');
    });

    this.els.btnDiag.addEventListener('click', async () => {
      if (!window.yihuan || !window.yihuan.isElectron) { UI.log('演奏模式仅在桌面版可用', 'warn'); return; }
      if (!this.ensureHwnd()) return;
      const r = await window.yihuan.perfDiagnose(this.hwnd);
      if (!r.ok) { UI.log('诊断失败：' + r.error, 'err'); return; }
      const d = r.report;
      UI.log(`诊断：窗口「${d.title}」类名 ${d.className || '?'} · ${d.visible ? '可见' : '不可见'}${d.minimized ? ' · 已最小化' : ''}${d.isForeground ? ' · 前台' : ''} · 投递${d.testKeyDown ? '成功' : '失败'}`, d.testKeyDown ? 'info' : 'warn');
      d.advice.forEach((a) => UI.log('　→ ' + a, 'warn'));
    });

    /* 权限：以管理员重启（游戏管理员运行时必需，UIPI 会拦截普通权限的按键） */
    const cdCancel = document.getElementById('countdown-cancel');
    if (cdCancel) cdCancel.addEventListener('click', () => this.stop());
    const amCancel = document.getElementById('admin-cancel');
    if (amCancel) amCancel.addEventListener('click', () => this.hideAdminModal());
    const amFg = document.getElementById('admin-fg');
    if (amFg) amFg.addEventListener('click', () => {
      this.hideAdminModal();
      this.els.inputMode.value = 'fg';
      this.els.inputMode.dispatchEvent(new Event('change'));
      UI.log('已切换为前台模式（无需管理员权限，但演奏时需保持游戏在前台）', 'info');
    });
    const amElevate = document.getElementById('admin-elevate');
    if (amElevate) amElevate.addEventListener('click', async () => {
      this.hideAdminModal();
      const r = await window.yihuan.perfRelaunchAdmin();
      if (!r.ok) UI.log('提权重启失败：' + r.error, 'err');
    });
    this.els.btnAdmin.addEventListener('click', async () => {
      if (!window.yihuan || !window.yihuan.isElectron) return;
      const r = await window.yihuan.perfRelaunchAdmin();
      if (!r.ok) UI.log('提权重启失败：' + r.error, 'err');
    });

    const prefs = this.loadPrefs();
    this.mode = prefs.mode || 'bg';
    this.holdMs = prefs.holdMs || 35;
    this.countdown = prefs.countdown != null ? prefs.countdown : 3;
    this.els.inputMode.value = this.mode;
    this.els.hold.value = String(this.holdMs);
    this.els.countdown.value = String(this.countdown);

    if (window.yihuan && window.yihuan.onPerfEvent) {
      window.yihuan.onPerfEvent((kind, data) => this.onEvent(kind, data));
    }
    this.refreshWindows(false);
    this.refreshElevation();
  },

  async refreshElevation() {
    if (!window.yihuan || !window.yihuan.perfElevated) return;
    try {
      const elevated = await window.yihuan.perfElevated();
      this.selfElevated = elevated;
      this.els.adminChip.textContent = elevated ? '权限：管理员 ✓' : '权限：普通';
      this.els.adminChip.classList.toggle('warn', !elevated);
      this.els.btnAdmin.classList.toggle('hidden', elevated);
      if (!elevated) {
        UI.log('提示：游戏若以管理员运行，普通权限的按键会被 Windows 拦截（UIPI）。如演奏无效请点「以管理员重启」', 'info');
      }
    } catch { /* 非桌面版忽略 */ }
  },

  /* ---------------- 持久化 ---------------- */
  loadPrefs() { try { return JSON.parse(localStorage.getItem('yihuan.piano.perf')) || {}; } catch { return {}; } },
  savePrefs() {
    try {
      localStorage.setItem('yihuan.piano.perf', JSON.stringify({
        mode: this.mode, holdMs: this.holdMs, countdown: this.countdown,
      }));
    } catch { /* 忽略 */ }
  },

  /* ---------------- 模式切换 ---------------- */
  setActive(on) {
    if (on === this.active) return;
    this.stop();
    this.active = on;
    Keyboard.silentDemo = on; /* 演奏模式：琴键仅演示，不发声 */
    if (!on) AudioEngine.panic();
    this.els.btnPractice.classList.toggle('active', !on);
    this.els.btnPerf.classList.toggle('active', on);
    this.els.panel.classList.toggle('hidden', !on);
    document.body.classList.toggle('perf-mode', on);
    UI.onModeChanged(on);
    if (on) {
      UI.log('已切换到演奏模式：琴键仅作演示不发声，按键将发送到游戏窗口', 'info');
      this.refreshWindows(false);
      setTimeout(() => Tour.maybeAuto('perf'), 500);
    } else {
      UI.log('已切换到练习模式', 'info');
    }
  },

  /* ---------------- 窗口 ---------------- */
  async refreshWindows(logIt) {
    if (!window.yihuan || !window.yihuan.isElectron) {
      this.els.winSel.innerHTML = '<option value="">（仅桌面版可用）</option>';
      return;
    }
    let r;
    try {
      r = await window.yihuan.perfListWindows();
    } catch (e) {
      this.els.winSel.innerHTML = '<option value="">（演奏模式引擎不可用）</option>';
      this.updateStatus('演奏模式引擎不可用：' + (e.message || e));
      return;
    }
    if (!r.ok) { this.updateStatus('窗口枚举失败：' + r.error); return; }
    this.windows = r.windows;
    this.autoHwnd = r.auto || 0;
    const isGame = (w) => /异环|NTE/i.test(w.title) || /unreal/i.test(w.className || '');
    const isUE = (w) => /unreal/i.test(w.className || '');
    const rank = (w) => (w.hwnd === this.autoHwnd ? 0 : (isGame(w) ? (isUE(w) ? 1 : 2) : 3));
    const sorted = [...r.windows].sort((a, b) => rank(a) - rank(b));
    this.els.winSel.innerHTML = sorted.slice(0, 80).map((w) => {
      const cls = w.className ? ` ⟨${w.className}⟩` : '';
      const mark = w.hwnd === this.autoHwnd ? ' ★已选' : (isGame(w) ? (isUE(w) ? ' ·游戏' : ' ·疑似') : '');
      return `<option value="${w.hwnd}">${w.title.replace(/[<>&]/g, '')}${cls}${mark}</option>`;
    }).join('') || '<option value="">（未发现可见窗口）</option>';
    if (!this.hwnd) {
      this.hwnd = this.autoHwnd || (sorted[0] ? sorted[0].hwnd : 0);
      if (this.autoHwnd) UI.log('已自动检测到游戏窗口', 'info');
    }
    this.syncWindowSel();
    this.updateStatus();
    if (logIt) UI.log(`已刷新窗口列表（${r.windows.length} 个）`, 'info');
  },

  syncWindowSel() {
    if (this.hwnd && [...this.els.winSel.options].some((o) => Number(o.value) === this.hwnd)) {
      this.els.winSel.value = String(this.hwnd);
    }
  },

  ensureHwnd() {
    if (this.hwnd) return true;
    UI.log('请先选择目标窗口（游戏需已启动）', 'warn');
    return false;
  },

  updateStatus(msgOverride) {
    let text = msgOverride;
    if (!text) {
      if (!window.yihuan || !window.yihuan.isElectron) text = '演奏模式仅在桌面版可用';
      else if (this.hwnd) text = `目标窗口：${this.windowTitle || this.els.winSel.selectedOptions[0]?.textContent || this.hwnd}`;
      else text = '未选择目标窗口';
      text += this.mode === 'bg' ? ' · 后台注入' : ' · 前台模拟';
      /* 乐器 + 按法一目了然：钢琴=短击，吉他=延音（防误判当前按法） */
      text += Keyboard.instrument === 'guitar' ? ' · 🎸 吉他：延音按法' : ' · 🎹 钢琴：短击';
    }
    this.els.status.textContent = text;
  },

  /* ---------------- 时钟（Viz 接口，真实时间轴） ----------------
   * 播放中：worker 最近位置 + 本机流逝时间（外推）；其余状态：冻结 */
  songTimeNow() {
    if (this.state === 'playing' && this._dispAt) {
      return Math.min(this._dispT + (performance.now() - this._dispAt) / 1000, this.duration);
    }
    return this._dispT;
  },

  buildGuitarSchedule(st, speed) {
    /* 吉他演奏模式：音域 52–87，键位映射走吉他 Keyboard ROWS */
    const MIN = (typeof Keyboard !== 'undefined') ? Keyboard.min : 52;
    const MAX = (typeof Keyboard !== 'undefined') ? Keyboard.max : 87;
    const res = MidiPlayer._buildQueue(MidiPlayer.song, st, { min: MIN, max: MAX });
    const evs = res.events.map((e) => ({ ...e, t: e.t / speed }));
    evs.sort((a, b) => a.t - b.t);
    const chords = [], visual = [];
    let i = 0;
    while (i < evs.length) {
      const base = evs[i].t;
      let j = i;
      while (j < evs.length && evs[j].t - base <= 0.005) { j++; }
      const seen = new Set(), keys = [], pitches = [], durs = [];
      for (let k = i; k < j; k++) {
        /* 硬性 36 音域约束：任何映射结果落在键盘之外的一律不弹不显 */
        if (evs[k].midi < MIN || evs[k].midi > MAX) continue;
        if (seen.has(evs[k].midi)) continue;
        seen.add(evs[k].midi);
        const hint = midiKeyHint(evs[k].midi);
        if (hint === '?') continue;
        keys.push(hint === '⏎' ? 'enter' : hint.toLowerCase());
        pitches.push(evs[k].midi + 12); /* 游戏音高约定（=模拟器 midi+12），onEvent 以 p-12 还原琴键 */
        durs.push(Math.round(Math.max(0.08, evs[k].dur / speed) * 1000)); /* 按音符时长保持 */
        visual.push({ ...evs[k], dur: evs[k].dur / speed });
      }
      if (!keys.length) { i = j; continue; } /* 整和弦不可弹 → 跳过 */
      chords.push({ t: base * 1000, keys, pitches, durs });
      i = j;
    }
    return { chords, visual, stats: res.stats, trackLabel: res.trackLabel,
             melodyTrack: res.melodyTrack, duration: res.lastT / speed + 0.5 };
  },

  rebuild() {
    if (!MidiPlayer.song) return;
    const st = { ...MidiPlayer.settings };
    const speed = MidiPlayer.speed;
    const isGuitar = Keyboard.instrument === 'guitar';
    const sched = isGuitar ? this.buildGuitarSchedule(st, speed) : buildPerfSchedule(MidiPlayer.song, st, speed);
    this.events = sched.visual;
    this.chords = sched.chords;
    this.duration = Math.max(sched.duration, 1);
    this.stats = sched.stats;
    this.activeTrackLabel = sched.trackLabel;
    this.melodyTrack = sched.melodyTrack;
    this.song = MidiPlayer.song;
    this._builtFor = Keyboard.instrument; /* 记录构建时乐器，play 前检测陈旧调度 */
    UI.refreshTransport();
  },

  /* ---------------- 播放控制 ---------------- */
  async play() {
    if (!MidiPlayer.song) { UI.log('请先选择 MIDI 文件', 'warn'); return; }
    if (this.state === 'playing') return;
    /* 暂停态按「播放」= 恢复（引擎会话仍在，原地继续） */
    if (this.state === 'paused') return this.resume();
    if (!window.yihuan || !window.yihuan.isElectron) { UI.log('演奏模式仅在桌面版可用', 'warn'); return; }
    if (!this.ensureHwnd()) return;
    /* 后台注入受 UIPI 限制：游戏（管理员）会拦截普通权限进程的消息。
     * 未提权时明确拦截并提示（前台模式不受此限制，走倒计时弹窗引导）。 */
    if (this.mode === 'bg' && !this._allowUnelevated && this.selfElevated === false) {
      this.showAdminModal();
      return;
    }
    /* 乐器切换后（切换时 Perf 已停止 → 未重建）旧和弦仍是上一件乐器的键位映射，
     * 直接播放会把"域外音"打进游戏——构建乐器不符必须重建 */
    if (!this.chords || !this.chords.length || this._builtFor !== Keyboard.instrument) this.rebuild();
    /* 曲末再按播放 → 从头开始 */
    if (this.songTimeNow() >= this.duration - 0.01) {
      this._dispT = 0;
      this._dispAt = performance.now();
    }
    /* 倒计时弹窗：fg = "切到游戏点一下"的必要仪式；bg = 提示可放手做别的事 */
    if (this.countdown > 0) {
      this.showCountdown(this.countdown, this.mode === 'fg');
      this.state = 'countdown';
      UI.refreshTransport();
      for (let s = this.countdown; s > 0; s--) {
        this.updateCountdown(s);
        await new Promise((r) => setTimeout(r, 1000));
        if (this.state !== 'countdown') { this.hideCountdown(); return; } // 被取消
      }
      this.hideCountdown();
    }

    /* 启动期间用户又拖了进度条 → seek 命令会在启动后对引擎重定基（FIFO 有序），
     * 因此这里单次 perfPlay 即可，无需收敛循环 */
    const sid = ++this._sidSeq;
    this.sid = sid;
    const startReal = Math.min(Math.max(this.songTimeNow(), 0), this.duration);
    const r = await window.yihuan.perfPlay({
      chords: this.chords,
      hwnd: this.hwnd,
      mode: this.mode,
      holdMs: this.holdMs,
      offset: startReal,
      sid,
    });
    if (!r || !r.ok) {
      this.state = 'stopped';
      this._dispT = startReal;
      this._dispAt = performance.now();
      UI.log('演奏启动失败：' + (r && r.error ? r.error : '未知错误'), 'err');
      UI.refreshTransport();
      return;
    }
    this.sid = Math.max(this.sid, r.sid);
    this._dispT = startReal;
    this._dispAt = performance.now();
    this.state = 'playing';
    Keyboard.releaseAll('play');
    UI.refreshTransport();
    UI.log(`演奏开始：${r.chordCount} 个和弦 → ${this.mode === 'bg' ? '后台注入' : '前台模拟'}`, 'info');
  },

  async pause() {
    if (this.state !== 'playing') return;
    const r = await window.yihuan.perfPause();
    /* worker 报告的位置为准（冻结显示时钟） */
    this.state = r.state === 'stopped' ? 'stopped' : 'paused';
    if (typeof r.t === 'number' && r.state !== 'stopped') {
      this._dispT = r.t;
      this._dispAt = performance.now();
    }
    Keyboard.releaseAll('play');
    UI.refreshTransport();
  },

  async resume() {
    if (this.state !== 'paused') return;
    const r = await window.yihuan.perfResume();
    if (!r.ok) { this.state = 'stopped'; UI.log('恢复失败：' + r.error, 'err'); UI.refreshTransport(); return; }
    this._dispAt = performance.now(); /* 从冻结位置继续外推 */
    this.state = 'playing';
    UI.refreshTransport();
  },

  toggle() {
    if (this.state === 'countdown') { this.stop(); return; } /* 倒计时中再按 = 取消 */
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else this.play();
  },

  async stop() {
    const was = this.state;
    this.sid = ++this._sidSeq; /* 新纪元：旧会话事件作废 */
    this.state = 'stopped';
    if (window.yihuan && window.yihuan.isElectron) await window.yihuan.perfStop();
    this._dispT = 0;
    this._dispAt = performance.now();
    this._lastProgT = 0;
    Keyboard.releaseAll('play');
    if (was !== 'stopped') {
      UI.refreshTransport();
      UI.log('演奏已停止', 'info');
    }
  },

  /* 进度条跳转（songT = 歌曲时间轴位置，与练习模式同刻度、与速度无关）：
   * 乐观显示（进度条立即到位）+ 引擎「原地重定基」——会话不中断、不重启、
   * 不弹任何窗：播放中无缝跳、暂停中改锚点（恢复即从新位置继续）。
   * 新纪元 id 随命令下发，旧会话的一切迟到事件自动作废。 */
  seek(songT) {
    songT = Math.max(0, Math.min(songT, MidiPlayer.duration));
    const real = Math.min(songT / MidiPlayer.speed, this.duration);
    this.sid = ++this._sidSeq;
    this._dispT = real;
    this._dispAt = performance.now();
    if ((this.state === 'playing' || this.state === 'paused') && window.yihuan && window.yihuan.isElectron) {
      window.yihuan.perfSeek(real, this.sid);
    }
    UI.refreshProgress && UI.refreshProgress();
  },
  /* 歌曲时间轴当前位置（进度条/标签用，与练习模式同刻度） */
  songPos() { return this.songTimeNow() * MidiPlayer.speed; },

  /* ---------------- 后台需管理员提示弹窗 ---------------- */
  showAdminModal() {
    const m = document.getElementById('admin-modal');
    if (!m) return;
    m.classList.remove('hidden');
    UI.log('后台注入需要管理员权限：Windows 会拦截普通权限进程发往游戏的按键（UIPI）', 'err');
  },
  hideAdminModal() {
    const m = document.getElementById('admin-modal');
    if (m) m.classList.add('hidden');
  },

  /* ---------------- 前台模式倒计时弹窗 ---------------- */
  showCountdown(from, isFg) {
    const m = document.getElementById('countdown-modal');
    if (!m) return;
    const txt = document.getElementById('countdown-text');
    if (txt) {
      txt.innerHTML = isFg
        ? '<b>即将开始演奏（前台模式）</b><br>请现在切换到《异环》游戏主窗口，<b>点击一下游戏画面</b>确保它获得焦点。<br><span class="dim">演奏过程中游戏窗口失去焦点会自动停止。</span>'
        : '<b>即将开始演奏（后台模式）</b><br>无需切换窗口，演奏期间可正常使用电脑做其他事。<br><span class="dim">若游戏内无反应，请检查是否已以管理员运行本应用。</span>';
    }
    m.classList.remove('hidden');
    this.updateCountdown(from);
  },
  updateCountdown(n) {
    const num = document.getElementById('countdown-num');
    if (num) num.textContent = String(n);
  },
  hideCountdown() {
    const m = document.getElementById('countdown-modal');
    if (m) m.classList.add('hidden');
  },

  /* ---------------- 演奏中锁定 ----------------
   * 用原生 disabled 属性（鼠标+键盘全阻断；CSS 置灰只挡鼠标不够）。
   * 演奏模式下仅完全停止（stopped）才可调整参数；播放/倒计时/暂停全部锁定。 */
  LOCK_IDS: [
    'track-sel', 'track-custom', 'range-mode', 'speed', 'tr-minus', 'tr-plus',
    'inst-sel', 'volume', 'sustain',
    'perf-window', 'perf-refresh', 'perf-auto', 'perf-input-mode', 'perf-hold',
    'perf-countdown', 'perf-test', 'perf-diagnose', 'perf-admin',
    'btn-pick', 'btn-library', 'mode-practice', 'mode-perf', 'btn-tour', 'btn-hints',
    'inst-piano', 'inst-guitar',
  ],
  syncLockState() {
    /* 演奏非停止态与跟弹教学共用一把锁（参数禁改防调度/判定错乱） */
    const teaching = typeof Teaching !== 'undefined' && Teaching.active;
    const lock = (this.active && this.state !== 'stopped') || teaching;
    document.body.classList.toggle('perf-busy', lock);
    for (const id of this.LOCK_IDS) {
      const el = document.getElementById(id);
      if (el) el.disabled = lock;
    }
  },

  /* 主进程事件 → 可视联动（note 事件高频，仅更新文本避免 DOM 日志刷屏卡顿） */
  _lastNoteLog: 0,
  onEvent(kind, data) {
    if (kind === 'started') {
      /* 新会话确认（worker 盖章回传）；旧纪元的 started 不予采纳 */
      if (data.sid != null && data.sid > this.sid) this.sid = data.sid;
      return;
    }
    /* 纪元不符 = 旧会话的迟到事件：一律丢弃（含 ended——用户停止时已自置状态） */
    if (data.sid != null && data.sid !== this.sid) return;
    if (kind === 'note') {
      /* 琴键高亮与游戏内真实保持时长同步（worker 回传 durMs；旧会话回退 holdMs） */
      const hold = data.durMs != null
        ? Math.min(15000, Math.max(150, data.durMs))
        : Math.max(120, (data.holdMs || 8) + 60);
      const names = [];
      for (const p of data.pitches) {
        const lane = p - 12; // 游戏音高 → 模拟器音域
        names.push(midiToName(p));
        /* 重击语义：保持中的同键先松开再按下——快速重复音也能各自产生
         * 新的回声条与涟漪（否则 0→1 判定吞掉后按的音符条） */
        Keyboard.release(lane, 'play');
        Keyboard.press(lane, 'play');
        setTimeout(() => Keyboard.release(lane, 'play'), hold);
      }
      const pn = document.getElementById('progress-note');
      if (pn) pn.textContent = names.join('+');
      /* 日志节流：最多每 2 秒记一条，防止密集音符刷屏造成界面卡顿 */
      const now = performance.now();
      if (UI && UI.log && now - this._lastNoteLog > 2000) {
        this._lastNoteLog = now;
        UI.log(`演奏中… 已发送至第 ${data.idx + 1} 个和弦`, 'info');
      }
    } else if (kind === 'progress') {
      /* worker 时钟为唯一权威：直接采纳（每 ~100ms 一次，抖动 ≤30ms 不可见） */
      this._dispT = data.t;
      this._dispAt = performance.now();
    } else if (kind === 'warn') {
      if (UI && UI.log) UI.log(data.msg, 'warn');
    } else if (kind === 'ended') {
      if (data.finished) {
        this._dispT = this.duration;
        UI.log(`演奏结束（共 ${data.played} 个和弦）`, 'info');
      }
      this.state = 'stopped';
      this._dispAt = performance.now();
      Keyboard.releaseAll('play');
      UI.refreshTransport();
    }
  },
};
window.Perf = Perf;
