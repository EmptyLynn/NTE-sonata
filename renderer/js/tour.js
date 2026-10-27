/* ============================================================================
 * 新手引导（聚焦讲解式 Tour）
 *
 *  · 两套独立教程：practice（首次打开自动开始）与 perf（首次切到演奏模式开始）；
 *  · 聚焦效果：高亮目标元素（box-shadow 大范围遮罩挖洞）+ 讲解卡片（自动
 *    放到目标上方/下方），支持 上一步/下一步/跳过，Esc 退出；
 *  · 完成状态记 localStorage，顶栏「?」可随时重看当前模式的教程。
 * ==========================================================================*/
const Tour = {
  KEY: 'yihuan.tour.done.v1',
  done: {},
  _steps: [],
  _idx: 0,
  _els: {},

  TOURS: {
    practice: [
      { sel: '#mode-seg', title: '两种模式', text: '🎹 练习模式：本模拟器发声演奏，随时手动弹奏。\n（网页版仅提供练习模式。）' },
      { sel: '#btn-pick', title: '选择 MIDI', text: '加载本地 .mid/.midi/.rmi 乐谱；导入的乐曲会自动存入曲库，即使原文件删除也不受影响。' },
      { sel: '#btn-play', title: '播放控制', text: '播放 / 暂停 / 停止，进度条可拖到任意位置起播。\n（网页版无全局热键，请点按钮控制。）' },
      { sel: '#speed', title: '演奏参数', text: '速度（0.25–3×，丝滑变速）、转调、轨道选择、超域处理（超出 36 键的音符如何折叠）。\n音色内置 13 套，切换不打断正在响的音。' },
      { sel: '#keyboard', title: '琴键与键位', text: '低音 Z~M · 中音 A~J · 高音 Q~U 三排 36 键。\nShift+白键=升半音，Ctrl+白键=降半音；鼠标点击也可演奏（按住修饰键点击同理）。' },
      { sel: '#viz-wrap', title: '瀑布流可视化', text: '音符下落触底即弹响；半音车道为暗色墨条，底部有简谱标注。\n右侧页签可切换为实时日志。' },
      { sel: '#btn-settings', title: '个性化设置', text: '主题色、回声条颜色（含炫彩模式）、粒子反馈开关都在这里，\n还有我的 B站 / GitHub 主页入口，欢迎来玩。' },
    ],
    perf: [
      { sel: '#mode-seg', title: '演奏模式', text: '把 MIDI 作为真实按键弹进《异环》游戏内的钢琴。\n本模拟器琴键只作演示（点亮对应键位），声音由游戏发出。' },
      { sel: '#perf-window', title: '目标窗口', text: '打开游戏后点「自动检测」（推荐，优先 UnrealWindow 类名的窗口），或从列表手动选。\n不确定选哪个时看下拉框里的 ⟨类名⟩ 标记。' },
      { sel: '#perf-input-mode', title: '输入方式', text: '后台注入（推荐）：游戏无需前台，但需要本应用以管理员运行。\n前台模拟：真实键盘输入，需要游戏在前台，演奏中失去焦点会自动停止。' },
      { sel: '#perf-admin-chip', title: '权限状态', text: '游戏以管理员运行时，Windows 会拦截普通权限的按键（UIPI）。\n若显示"权限：普通"，点「以管理员重启」提权后再使用后台注入。' },
      { sel: '#perf-test', title: '测试与诊断', text: '先点「测试按键」——游戏里应响起 C-E-G；无反应就点「诊断」，会检查窗口/权限/投递状态并给出建议。' },
      { sel: '#perf-countdown', title: '开始演奏', text: '设好倒计时（前台模式会弹窗提醒切换到游戏窗口），点播放即开始。\n演奏中仅允许调速度/转调/进度，其余参数自动锁定防止调度错乱。' },
    ],
  },

  init() {
    try { this.done = JSON.parse(localStorage.getItem(this.KEY)) || {}; } catch { this.done = {}; }
    const btn = document.getElementById('btn-tour');
    if (btn) btn.addEventListener('click', () => this.start(Perf.active ? 'perf' : 'practice', true));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._els.overlay && !this._els.overlay.classList.contains('hidden')) this.end(true);
    });
    window.addEventListener('resize', () => this._place());
  },

  maybeAuto(key) {
    return false; /* 网页版：教程不自动弹出，顶栏「?」可手动查看 */
  },

  start(key, manual) {
    const steps = this.TOURS[key];
    if (!steps || !steps.length) return;
    this._key = key;
    this._manual = !!manual;
    this._steps = steps;
    this._idx = 0;
    this._build();
    this._show();
  },

  _build() {
    if (!this._els.overlay) {
      const ov = document.createElement('div');
      ov.id = 'tour-overlay';
      ov.className = 'hidden';
      ov.innerHTML = `
        <div id="tour-spot"></div>
        <div id="tour-card">
          <div id="tour-title"></div>
          <div id="tour-text"></div>
          <div id="tour-foot">
            <span id="tour-step"></span>
            <span class="tour-btns">
              <button id="tour-prev" class="btn btn-ghost">上一步</button>
              <button id="tour-skip" class="btn btn-ghost">跳过</button>
              <button id="tour-next" class="btn btn-primary">下一步</button>
            </span>
          </div>
        </div>`;
      document.body.appendChild(ov);
      this._els = {
        overlay: ov,
        spot: ov.querySelector('#tour-spot'),
        card: ov.querySelector('#tour-card'),
        title: ov.querySelector('#tour-title'),
        text: ov.querySelector('#tour-text'),
        step: ov.querySelector('#tour-step'),
        prev: ov.querySelector('#tour-prev'),
        skip: ov.querySelector('#tour-skip'),
        next: ov.querySelector('#tour-next'),
      };
      this._els.prev.addEventListener('click', () => this._go(-1));
      this._els.next.addEventListener('click', () => this._go(1));
      this._els.skip.addEventListener('click', () => this.end(true));
      ov.addEventListener('click', (e) => {
        if (e.target === ov) this.end(true);
      });
    }
  },

  _show() {
    this._els.overlay.classList.remove('hidden');
    this._render();
  },

  _render() {
    const st = this._steps[this._idx];
    this._els.title.textContent = st.title;
    this._els.text.textContent = st.text;
    this._els.step.textContent = `${this._idx + 1} / ${this._steps.length}`;
    this._els.prev.disabled = this._idx === 0;
    this._els.next.textContent = this._idx === this._steps.length - 1 ? '完成' : '下一步';
    this._place();
  },

  _place() {
    const st = this._steps[this._idx];
    if (!st) return;
    const target = document.querySelector(st.sel);
    const spot = this._els.spot;
    const card = this._els.card;
    if (!target) { /* 目标不可见（如演奏模式面板未展开）：卡片居中 */
      spot.style.display = 'none';
      card.style.left = '50%';
      card.style.top = '50%';
      card.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const r = target.getBoundingClientRect();
    spot.style.display = 'block';
    spot.style.transform = 'translate(0,0)';
    spot.style.left = (r.left - 8) + 'px';
    spot.style.top = (r.top - 8) + 'px';
    spot.style.width = (r.width + 16) + 'px';
    spot.style.height = (r.height + 16) + 'px';
    /* 卡片：优先放目标下方，放不下放上方 */
    card.style.transform = 'none';
    const cardW = Math.min(380, window.innerWidth - 48);
    card.style.width = cardW + 'px';
    let cx = Math.max(16, Math.min(r.left, window.innerWidth - cardW - 16));
    let cy = r.bottom + 18;
    if (cy + 190 > window.innerHeight) cy = Math.max(16, r.top - 195);
    card.style.left = cx + 'px';
    card.style.top = cy + 'px';
  },

  _go(d) {
    const next = this._idx + d;
    if (next >= this._steps.length) { this.end(false); return; }
    if (next < 0) return;
    this._idx = next;
    this._render();
  },

  end(skipped) {
    if (!this._els.overlay) return;
    this._els.overlay.classList.add('hidden');
    /* 完成或手动跳过都记为已看（自动触发时跳过也算看过，避免反复打扰） */
    if (this._key) {
      this.done[this._key] = true;
      try { localStorage.setItem(this.KEY, JSON.stringify(this.done)); } catch { /* 忽略 */ }
    }
  },
};
window.Tour = Tour;
