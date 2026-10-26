/* ============================================================================
 * UI 装配层 —— 控件绑定 / 日志 / 进度 / 设置持久化 / 音色管理 / 文件加载
 *
 * 调试参数（URL query）：
 *   ?midi=<相对或绝对路径>   启动即加载 MIDI（浏览器/自动化测试用）
 *   ?auto=1                  加载后自动播放
 *   ?inst=<id>               指定初始音色
 *   ?pitchtest=1             音高自检：解码全部音色采样并估算基频，校验映射
 * ==========================================================================*/
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'yihuan.piano.settings.v1';

  const el = {
    pick: $('btn-pick'), play: $('btn-play'), pause: $('btn-pause'), stop: $('btn-stop'),
    progress: $('progress'), timeCur: $('time-cur'), timeTotal: $('time-total'),
    progressNote: $('progress-note'),
    speed: $('speed'), speedVal: $('speed-val'),
    trMinus: $('tr-minus'), trPlus: $('tr-plus'), trVal: $('tr-val'),
    trackSel: $('track-sel'), trackCustom: $('track-custom'),
    rangeMode: $('range-mode'), instSel: $('inst-sel'), volume: $('volume'),
    sustain: $('sustain'), sustainVal: $('sustain-val'),
    teachSel: $('teach-sel'), exportChart: $('btn-export-chart'),
    echoColor: $('echo-color'),
    instPiano: $('instr-piano'), instGuitar: $('instr-guitar'),
    songName: $('song-name'), songMeta: $('song-meta'),
    keyboard: $('keyboard'), hints: $('btn-hints'),
    tabViz: $('tab-viz'), tabEcho: $('tab-echo'), tabLog: $('tab-log'),
    vizWrap: $('viz-wrap'), echoWrap: $('echo-wrap'), viz: $('viz'), echoViz: $('echo-viz'),
    log: $('log'), stats: $('stats'), clearLog: $('btn-clear-log'),
    fileInput: $('file-input'),
  };

  const UI = {
    seeking: false,
    instruments: [],
    dragProgress: false,

    init() {
      Keyboard.init(el.keyboard);
      Keyboard.onNoteOn = (midi, tag) => {
        if (tag === 'manual') {
          Teaching.onUserNote(midi); /* 跟弹判定 */
          Viz.riserStart(midi); /* 瀑布流倒流回声：开始生长 */
        }
        this.logNote(midi, tag);
        Viz.burst(midi); // 手动演奏的粒子反馈
      };

      Keyboard.onNoteOff = (midi) => Viz.riserEnd(midi); /* 回声音条收尾 */
      el.instPiano.addEventListener('click', () => this.switchInstrumentType('piano'));
      el.instGuitar.addEventListener('click', () => this.switchInstrumentType('guitar'));
      MidiPlayer.onStateChange = () => this.refreshTransport();
      MidiPlayer.onSeek = () => this.refreshProgress();
      /* 实时按键提示改由主循环统一渲染（显示"当前所有按下的键"，不再单音覆盖） */
      Keyboard.onPanic = () => {
        AudioEngine.panic();
        Keyboard.releaseAll('manual');
        if (Teaching.active) Teaching.stop();
        if (Perf.active) Perf.stop();
        else if (MidiPlayer.state === 'playing') MidiPlayer.pause();
        Viz.riserEndAll();
        this.log('已紧急静音/停止（Esc）', 'warn');
      };

      this.bindControls();
      this.restoreSettings();
      this.refreshRangeFill(el.progress);
      this.refreshRangeFill(el.speed);
      this.refreshRangeFill(el.volume);
      this.refreshRangeFill(el.sustain);
      window.VizSource = MidiPlayer;
      Perf.init();
      Viz.init(el.viz);
      Viz.initEcho($('echo-viz'));
      Tour.init();
      setTimeout(() => { Tour.maybeAuto('practice'); this.fitWindowHeight(); }, 1400);

      this.initInstruments().then(() => this.handleUrlParams());
      Library.init();
      setTimeout(() => this.fitWindowHeight(), 800); /* 音色下拉填充后高度定型 */

      window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code === 'F8') { e.preventDefault(); this.togglePlay(); }
        else if (e.code === 'F9') { e.preventDefault(); this.stopPlay(); }
      });
      if (window.yihuan && window.yihuan.isElectron) {
        window.yihuan.onGlobalHotkey((key) => {
          if (key === 'F8') this.togglePlay();
          else if (key === 'F9') this.stopPlay();
        });
      }

      this.log('欢迎使用异环钢琴模拟器（by 林羽empty）—— 按 Z~M / A~J / Q~U 演奏，Shift 高半音，Ctrl 低半音', 'info');
      this.log('选择本地 MIDI 后即可自动演奏；F8 播放/暂停、F9 停止（失焦可用）', 'info');
    },

    /* ---------------- 控件 ---------------- */
    bindControls() {
      el.pick.addEventListener('click', () => this.pickFile());
      el.fileInput.multiple = true; /* 批量导入 */
      el.fileInput.addEventListener('change', async () => {
        const files = [...el.fileInput.files];
        if (files.length && window.yihuan && window.yihuan.isElectron) {
          await this.importMidiFiles(files.map((f) => f.path).filter(Boolean));
        } else if (files.length) {
          /* 浏览器（非 Electron）回退：批量入库（IndexedDB），第一首载入播放器 */
          await Library.refresh();
          const have = new Set(Library.entries.map((e) => String(e.title).trim().toLowerCase()));
          let loadedFirst = false;
          const added = [], skipped = [];
          for (const f of files) {
            const buf = await f.arrayBuffer();
            let song;
            try { song = MidiSource.parse(buf); }
            catch (err) { this.log(`解析失败：${f.name}（${err.message}）`, 'err'); continue; }
            const title = song.name || f.name.replace(/\.(midi?|rmi)$/i, '') || '未命名';
            if (have.has(title.trim().toLowerCase())) { skipped.push(title); continue; }
            have.add(title.trim().toLowerCase());
            added.push(title);
            const meta = { duration: song.duration, notes: song.totalNotes, tracks: song.trackCount, bpm: song.tempo };
            Library.add({ data: buf, title, meta });
            if (!loadedFirst) { loadedFirst = true; this.loadSong(buf, f.name); }
          }
          if (skipped.length) this.log(`已跳过曲库中已有的同名曲目：${skipped.join('、')}`, 'warn');
          if (added.length > 1) this.log(`批量导入完成：新增 ${added.length} 首入库，当前加载「${added[0]}」`, 'info');
        }
        el.fileInput.value = '';
      });

      el.play.addEventListener('click', () => this.playSong());
      el.pause.addEventListener('click', () => {
        if (Perf.active) { Perf.pause(); return; }
        AudioEngine.ensureCtx();
        MidiPlayer.pause();
      });
      el.stop.addEventListener('click', () => this.stopPlay());

      el.speed.addEventListener('input', () => {
        const v = parseFloat(el.speed.value);
        el.speedVal.textContent = v.toFixed(2) + '×';
        this.refreshRangeFill(el.speed);
        MidiPlayer.setSpeed(v);
        /* 演奏模式：丝滑变速——热重定基替换剩余调度，不断音 */
        if (Perf.active && MidiPlayer.song) {
          const playing = Perf.state === 'playing';
          const pos = Perf.songPos(); /* 歌曲时间轴位置 */
          Perf.rebuild();
          if (playing && window.yihuan && window.yihuan.perfRebase) {
            window.yihuan.perfRebase(Perf.chords, pos / MidiPlayer.speed);
            Perf._dispT = pos / MidiPlayer.speed;
            Perf._dispAt = performance.now();
          } else {
            Perf._dispT = Math.min(Perf._dispT, Perf.duration);
          }
        }
        this.saveSettings();
      });

      el.trMinus.addEventListener('click', () => this.setTranspose(MidiPlayer.settings.transpose - 1));
      el.trPlus.addEventListener('click', () => this.setTranspose(MidiPlayer.settings.transpose + 1));

      el.trackSel.addEventListener('change', () => {
        el.trackCustom.classList.toggle('hidden', el.trackSel.value !== 'custom');
        this.applyAndRestart(() => {
          MidiPlayer.settings.trackSel = el.trackSel.value;
          MidiPlayer.rebuild(false);
        });
        this.saveSettings();
      });
      el.trackCustom.addEventListener('change', () => {
        this.applyAndRestart(() => {
          MidiPlayer.settings.customTracks = el.trackCustom.value.trim();
          MidiPlayer.rebuild(false);
        });
        this.saveSettings();
      });

      el.rangeMode.addEventListener('change', () => {
        this.applyAndRestart(() => {
          MidiPlayer.settings.rangeMode = el.rangeMode.value;
          MidiPlayer.rebuild(false);
        });
        this.saveSettings();
      });

      el.instSel.addEventListener('change', async () => {
        await this.switchInstrument(el.instSel.value);
        this.saveSettings();
      });

      el.volume.addEventListener('input', () => {
        this.refreshRangeFill(el.volume);
        AudioEngine.setMasterVolume(parseFloat(el.volume.value));
        this.saveSettings();
      });

      el.teachSel.addEventListener('change', () => {
        Teaching.setMode(el.teachSel.value);
        this.saveSettings();
      });
      el.echoColor.addEventListener('input', () => {
        Viz.echoColor = el.echoColor.value;
        this.saveSettings();
      });
      el.exportChart.addEventListener('click', () => this.exportChartTxt());

      el.sustain.addEventListener('input', () => {
        const v = parseInt(el.sustain.value, 10);
        el.sustainVal.textContent = v + 'ms';
        this.refreshRangeFill(el.sustain);
        AudioEngine.setSustain(v);
        this.saveSettings();
      });

      /* 滑杆松手后归还焦点：调完即可直接演奏 */
      for (const input of [el.speed, el.volume, el.sustain, el.progress]) {
        input.addEventListener('change', () => input.blur());
      }

      /* 下拉框 / 文本输入变更后归还焦点（音色、轨道、超域、演奏模式各项等）：
       * 调完即弹，无需先点空白处或琴键 */
      document.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || !t.tagName) return;
        const type = (t.getAttribute('type') || '').toLowerCase();
        const isTextInput = t.tagName === 'INPUT' && !['range', 'button', 'checkbox', 'radio'].includes(type);
        if (t.tagName === 'SELECT' || isTextInput) t.blur();
      });
      /* 按钮点击后归还焦点：否则空格/回车会再次触发最后点过的按钮
       * （如导出键盘谱后按空格会再弹保存框）。e.detail>0 = 鼠标点击；
       * 键盘 Enter 触发的 click（detail=0）不.blur，保留无障碍键盘操作。 */
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'BUTTON' || e.detail === 0) return;
        t.blur();
      });

      /* 底部面板页签：瀑布流 / 实时日志 */
      el.tabViz.addEventListener('click', () => this.switchTab('viz'));
      el.tabEcho.addEventListener('click', () => this.switchTab('echo'));
      el.tabLog.addEventListener('click', () => this.switchTab('log'));

      el.hints.addEventListener('click', () => {
        const visible = Keyboard.toggleHints();
        el.hints.textContent = visible ? '隐藏键位提示' : '显示键位提示';
        this.saveSettings();
      });

      el.clearLog.addEventListener('click', () => { el.log.innerHTML = ''; });

      /* 进度条：input 事件拖动即时 seek（拖动中暂停重排的抖动由 seek 内部消化） */
      el.progress.addEventListener('pointerdown', () => { this.dragProgress = true; });
      window.addEventListener('pointerup', () => { this.dragProgress = false; });
      /* 进度条统一使用「歌曲时间轴」刻度（与速度无关），两种模式手感一致 */
      const progressSongT = () => (parseFloat(el.progress.value) / 1000) * MidiPlayer.duration;
      el.progress.addEventListener('input', () => {
        if (!MidiPlayer.song) return;
        const t = progressSongT();
        this.refreshRangeFill(el.progress);
        el.timeCur.textContent = this.fmtTime(t);
        this.seekPending = t;
      });
      el.progress.addEventListener('change', () => {
        if (!MidiPlayer.song) return;
        const t = progressSongT();
        if (Perf.active) { Perf.seek(t); }
        else {
          if (Teaching.active) Teaching.stop(); /* 教学中拖动：结束本次，播放从新位置重新开始教学 */
          MidiPlayer.seek(t);
        }
        el.timeTotal.textContent = this.fmtTime(MidiPlayer.duration);
        el.timeCur.textContent = this.fmtTime(Math.min(t, MidiPlayer.duration));
        el.progressNote.textContent = '';
        this.seekPending = null;
      });
    },

    /* 播放中变更轨道/超域/转调/音色：先暂停、应用、再短暂续播——
     * 避免热切换时新旧调度的声部/游标交错造成爆音或无声。
     * 演奏模式下走 Perf 的暂停/重建/续演路径。 */
    applyAndRestart(apply, gapMs = 130) {
      if (Perf.active) {
        const playing = Perf.state === 'playing';
        if (playing) Perf.pause();
        apply();
        MidiPlayer.rebuild(false);
        Perf.rebuild();
        if (playing) setTimeout(() => { if (Perf.state === 'paused') Perf.resume(); }, gapMs);
        return;
      }
      /* 教学中改参数：教学和弦必须随新队列重建，否则判定与显示失配 → 等待模式卡死。
       * 从当前教学位置无缝续跟（等待=驻留位置，同步=播放位置）。 */
      const teach = Teaching.active ? { mode: Teaching.mode, off: Teaching.songTimeNow(), wasPlaying: MidiPlayer.state === 'playing' } : null;
      if (teach) Teaching.stop();
      const playing = MidiPlayer.state === 'playing';
      if (playing) MidiPlayer.pause();
      apply();
      if (teach) {
        Teaching.mode = teach.mode;
        if (teach.mode === 'flow') {
          /* MidiPlayer.stop() 会把播放头归零：flow 续跟必须先 seek 回原位置 */
          MidiPlayer.seek(teach.off);
          if (teach.wasPlaying) MidiPlayer.play();
        }
        Teaching.start(teach.off);
        UI.log('参数已更新，跟弹已从当前位置继续', 'info');
        return;
      }
      if (playing) {
        setTimeout(() => {
          if (MidiPlayer.state === 'paused') MidiPlayer.play();
        }, gapMs);
      }
    },

    setTranspose(v) {
      v = Math.max(-36, Math.min(36, v | 0));
      if (Perf.active) {
        /* 演奏模式：转调丝滑——热重定基换调度，不暂停不断音 */
        const playing = Perf.state === 'playing';
        const pos = Perf.songPos();
        MidiPlayer.settings.transpose = v;
        el.trVal.textContent = (v > 0 ? '+' : '') + v;
        MidiPlayer.rebuild(false);
        Perf.rebuild();
        if (playing && window.yihuan && window.yihuan.perfRebase) {
          window.yihuan.perfRebase(Perf.chords, pos / MidiPlayer.speed);
          Perf._dispT = pos / MidiPlayer.speed;
          Perf._dispAt = performance.now();
        } else {
          Perf._dispT = Math.min(Perf._dispT, Perf.duration);
        }
        this.saveSettings();
        return;
      }
      this.applyAndRestart(() => {
        MidiPlayer.settings.transpose = v;
        el.trVal.textContent = (v > 0 ? '+' : '') + v;
        MidiPlayer.rebuild(false);
      });
      this.saveSettings();
    },

    switchTab(which) {
      const states = { viz: which === 'viz', echo: which === 'echo', log: which === 'log' };
      el.tabViz.classList.toggle('active', states.viz);
      el.tabEcho.classList.toggle('active', states.echo);
      el.tabLog.classList.toggle('active', states.log);
      el.vizWrap.classList.toggle('hidden', !states.viz);
      el.echoWrap.classList.toggle('hidden', !states.echo);
      el.log.classList.toggle('hidden', !states.log);
      if (states.viz) Viz._resize();
      if (states.echo) Viz._resizeEcho();
      this.saveSettings();
    },

    refreshRangeFill(input) {
      const min = parseFloat(input.min) || 0;
      const max = parseFloat(input.max) || 1;
      const pct = ((parseFloat(input.value) - min) / (max - min)) * 100;
      input.style.setProperty('--fill', pct + '%');
    },

    refreshTransport() {
      Perf.syncLockState(); /* 演奏模式非停止态锁定全部参数；练习模式确保解锁 */
      if (Perf.active) {
        const has = !!MidiPlayer.song;
        const busy = Perf.state === 'playing' || Perf.state === 'countdown';
        el.play.disabled = !has || busy;
        el.pause.disabled = !has || Perf.state !== 'playing';
        el.stop.disabled = !has || Perf.state === 'stopped';
        el.progress.disabled = !has;
        el.play.querySelector('.ic').innerHTML = busy
          ? '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4"/>' +
            '<path d="M8 4.8a3.2 3.2 0 1 0 3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/></path>'
          : '<path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/>';
        this.refreshProgress();
        return;
      }
      if (Teaching.active) {
        const has = !!MidiPlayer.song;
        el.play.disabled = true;
        el.pause.disabled = !has || Teaching.mode !== 'flow' || MidiPlayer.state !== 'playing';
        el.stop.disabled = !has;
        el.progress.disabled = !has;
        this.refreshProgress();
        return;
      }
      const has = !!MidiPlayer.song;
      const playing = MidiPlayer.state === 'playing';
      el.play.disabled = !has || playing;
      el.pause.disabled = !has || !playing;
      el.stop.disabled = !has;
      el.progress.disabled = !has;
      this.refreshProgress();
    },

    refreshProgress() {
      if (!MidiPlayer.song || this.dragProgress) return;
      if (Teaching.active && Teaching.mode === 'wait') {
        const t = Teaching.songTimeNow();
        const dur = Teaching.duration || 1;
        el.progress.value = String(Math.round((t / dur) * 1000));
        this.refreshRangeFill(el.progress);
        el.timeCur.textContent = this.fmtTime(t);
        el.timeTotal.textContent = this.fmtTime(dur);
        return;
      }
      if (Perf.active) {
        const t = Perf.songPos(); /* 歌曲时间轴（速度无关） */
        el.progress.value = String(Math.round((t / MidiPlayer.duration) * 1000));
        this.refreshRangeFill(el.progress);
        el.timeCur.textContent = this.fmtTime(t);
        el.timeTotal.textContent = this.fmtTime(MidiPlayer.duration);
        return;
      }
      const t = MidiPlayer.songTimeNow();
      el.progress.value = String(Math.round((t / MidiPlayer.duration) * 1000));
      this.refreshRangeFill(el.progress);
      el.timeCur.textContent = this.fmtTime(t);
    },

    /* ---------------- 动作 ---------------- */
    playSong() {
      if (Perf.active) { Perf.play(); return; }
      if (Teaching.mode !== 'off') {
        AudioEngine.ensureCtx();
        if (!MidiPlayer.song) { this.log('请先选择 MIDI 文件', 'warn'); return; }
        Teaching.start();
        return;
      }
      AudioEngine.ensureCtx();
      if (!MidiPlayer.song) { this.log('请先选择 MIDI 文件', 'warn'); return; }
      /* 播放结束（stopped 且 offset 在末尾）后再按播放 → 从头开始 */
      if (MidiPlayer.state === 'stopped' && MidiPlayer.offset >= MidiPlayer.duration - 0.01) {
        MidiPlayer.offset = 0;
      }
      MidiPlayer.play();
    },
    stopPlay() {
      if (Perf.active) { Perf.stop(); el.progressNote.textContent = ''; this.refreshProgress(); return; }
      if (Teaching.active) { Teaching.stop(); el.progressNote.textContent = ''; this.refreshProgress(); return; }
      MidiPlayer.stop(); el.progressNote.textContent = ''; this.refreshProgress();
    },
    togglePlay() {
      if (!MidiPlayer.song) return;
      if (Perf.active) { Perf.toggle(); return; }
      if (Teaching.active) {
        if (Teaching.mode === 'flow') MidiPlayer.toggle(); /* 同步模式：暂停/恢复原曲 */
        return; /* 等待模式：无暂停概念（时间本就驻留） */
      }
      AudioEngine.ensureCtx();
      MidiPlayer.toggle();
    },

    /* 窗口高度自适应内容（桌面版）：加载后与切模式后调用，保证无滚动条 */
    fitWindowHeight() {
      if (!window.yihuan || !window.yihuan.fitWindowHeight) return;
      requestAnimationFrame(() => {
        window.yihuan.fitWindowHeight(document.documentElement.scrollHeight);
      });
    },

    /* ---------------- 键盘谱 TXT 导出 ----------------
     * 按当前设置（轨道/转调/超域）生成人性化键盘谱：8 分音符网格分组，
     * 每行一个起音（小节.拍 + 按键 + 唱名），每 4 小节留空行便于视读。 */
    async exportChartTxt() {
      if (!MidiPlayer.song || !MidiPlayer.events.length) { this.log('请先选择 MIDI 文件', 'warn'); return; }
      const content = this.buildChartText();
      const m = /^《(.+?)》/.exec(content);
      const title = m ? m[1] : '未命名';
      const defaultName = `${title} 键盘谱.txt`;
      if (window.yihuan && window.yihuan.saveText) {
        const r = await window.yihuan.saveText(defaultName, content);
        if (r.ok) this.log(`键盘谱已导出：${r.path}`, 'info');
        else if (!r.canceled) this.log('导出失败：' + r.error, 'err');
      } else {
        /* 浏览器兜底：Blob 下载 */
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(a.href);
        this.log('键盘谱已开始下载', 'info');
      }
    },

    /* 键盘谱文本生成（纯函数，自测用）：一行一小节，拍位:按键 */
    buildChartText() {
      const song = MidiPlayer.song;
      const bpm = song.tempo || 120;
      const beat = 60 / bpm;
      const grid = beat / 2; /* 8 分音符网格 */
      const groups = [];
      let curSlot = null;
      for (const ev of MidiPlayer.events) {
        const slot = Math.round(ev.t / grid);
        if (slot !== curSlot) { groups.push({ slot, keys: [] }); curSlot = slot; }
        const g = groups[groups.length - 1];
        if (!g.keys.includes(midiKeyHint(ev.midi))) g.keys.push(midiKeyHint(ev.midi));
      }
      const title = (song.name || el.songName.textContent || '未命名').replace(/\.[a-z]+$/i, '');
      const now = new Date();
      const L = [];
      L.push(`《${title}》 键盘谱`);
      L.push(`BPM ${bpm} · 共 ${MidiPlayer.events.length} 音 · 时长 ${this.fmtTime(song.duration)} · 生成于 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
      L.push(`设置：${MidiPlayer.activeTrackLabel || '-'} · 转调 ${MidiPlayer.settings.transpose > 0 ? '+' : ''}${MidiPlayer.settings.transpose} · 超域 ${MidiPlayer.settings.rangeMode}`);
      L.push('─'.repeat(52));
      L.push('键位：低音 Z 行 ｜ 中音 A 行 ｜ 高音 Q 行　⇧+键=升半音　↓+键=降半音');
      L.push('格式：小节 │ 拍位:按键（1.5 = 第 2 拍后半拍，+ = 同时按下）');
      L.push('─'.repeat(52));
      let lastBar = 0, line = '';
      for (const g of groups) {
        const bar = Math.floor(g.slot / 8) + 1;
        if (bar !== lastBar) {
          if (line) L.push(line.trimEnd());
          if (lastBar > 0 && (bar - 1) % 4 === 0) L.push(''); /* 每 4 小节空行 */
          line = `${String(bar).padStart(3)} │ `;
          lastBar = bar;
        }
        const beatPos = (g.slot % 8) * 0.5 + 1; /* 拍位（半拍精度，无浮点尾差） */
        const beatTxt = String(beatPos).replace(/\.0$/, '');
        line += `${beatTxt}:${g.keys.join('+')}  `;
      }
      if (line.trimEnd()) L.push(line.trimEnd());
      L.push('─'.repeat(52));
      L.push('—— 由 异环钢琴模拟器 (by 林羽empty) 导出 ——');
      return L.join('\r\n') + '\r\n';
    },

    /* 切换乐器（钢琴/吉他） */
    switchInstrumentType(id) {
      if (Keyboard.instrument === id) return;
      Keyboard.setInstrument(id);
      el.instPiano.classList.toggle('active', id === 'piano');
      el.instGuitar.classList.toggle('active', id === 'guitar');
      /* 切乐器：教学和弦按旧键位生成，已失效 → 先结束教学（重新点播放即可开始） */
      if (Teaching.active) Teaching.stop();
      /* 关键：切乐器后一律重建演奏调度（无条件）——停止态不重建会让旧乐器的
       * 键位映射残留到下一次演奏，把"域外音"打进游戏 */
      if (MidiPlayer.song) {
        Perf.rebuild();
        MidiPlayer.rebuild(false);
      }
      this.rebuildTimbreOptions(id);
      /* 音域文字 + 顶部提示按乐器更新 */
      const rangeEl = document.querySelector('.kbd-range');
      if (rangeEl) {
        const mn = midiToName(Keyboard.min), mx = midiToName(Keyboard.max);
        const mi = Keyboard.min, ma = Keyboard.max;
        rangeEl.innerHTML = `音域 <b>${mn} – ${mx}</b>（MIDI ${mi} – ${ma}）· 每排 12 音：${id === 'guitar' ? '半音阶（每键一个音）' : '1 #1 2 ♭3 3 4 #4 5 #5 6 ♭7 7'}`;
      }
      document.body.classList.toggle('guitar-mode', id === 'guitar');
      this.log(`已切换乐器：${id === 'guitar' ? '🎸 吉他（E3–D#6）' : '🎹 钢琴（C3–B5）'}`, 'info');
      this.saveSettings();
    },

    rebuildTimbreOptions(instrId) {
      const opts = this.instruments.filter((i) => {
        const gid = i.id || '';
        return instrId === 'guitar' ? /guitar|asteel/.test(gid) : !/guitar|asteel/.test(gid);
      });
      el.instSel.innerHTML = opts.map((i) => `<option value="${i.id}">${i.name}（${i.samples}音）</option>`).join('') || '<option value="">（暂无音色）</option>';
      if (el.instSel.options.length) {
        const saved = (this.loadSettings().timbre || {})[instrId];
        el.instSel.value = el.instSel.querySelector(`option[value="${saved}"]`) ? saved : el.instSel.options[0].value;
        this.switchInstrument(el.instSel.value, true);
      }
    },

    /* ---------------- 模式切换回调（Perf.setActive 调用） */
    onModeChanged(perfOn) {
      if (Teaching.active) Teaching.stop();
      window.VizSource = perfOn ? Perf : MidiPlayer;
      if (perfOn) {
        MidiPlayer.stop();
        Perf.rebuild();
      } else {
        Perf.stop();
      }
      this.refreshTransport();
      this.fitWindowHeight();
    },

    /* ---------------- 音色 ---------------- */
    async initInstruments() {
      this.instruments = await AudioEngine.listInstruments();
      el.instSel.innerHTML = this.instruments
        .map((i) => `<option value="${i.id}">${i.name}（${i.samples}音）</option>`).join('');
      const saved = this.loadSettings();
      /* 默认音色 = 明亮钢琴；旧版默认 grand 的存量用户一次性迁移到 bright */
      let want = saved.instrument;
      if (!el.instSel.querySelector(`option[value="${want}"]`)) want = null;
      if (!want && saved.instrument === 'grand' && !saved.__brightMigrated) {
        want = el.instSel.querySelector('option[value="bright"]') ? 'bright' : null;
        if (want) {
          saved.__brightMigrated = true;
          try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* 忽略 */ }
        }
      }
      if (!want) want = (this.instruments.find((i) => i.id === 'bright') ? 'bright' : this.instruments[0].id);
      el.instSel.value = want;
      await this.switchInstrument(want, true);
    },

    async switchInstrument(id, silent) {
      const meta = this.instruments.find((i) => i.id === id);
      if (!meta) return;
      /* 丝滑换音色：不暂停——已响声部在旧音色上自然衰减，
       * 新采样后台加载、就绪即切（新音符无缝过渡到新音色）。 */
      if (!AudioEngine.instruments.get(id) || !AudioEngine.instruments.get(id).ready) {
        if (!silent) this.log(`加载音色「${meta.name}」中…`, 'info');
        const inst = await AudioEngine.loadInstrument(id, meta.name);
        if (inst.missing.length) {
          this.log(`音色「${meta.name}」缺失采样：${inst.missing.map(midiToName).join('、')}（相关琴键将无声）`, 'err');
        } else if (!silent) {
          this.log(`音色「${meta.name}」加载完成（${inst.sortedMidis.length} 采样）`, 'info');
        }
        if (el.instSel.value !== id) return; /* 用户在加载期间又切走了 */
      }
      AudioEngine.setCurrent(id);
    },

    /* ---------------- 文件 ---------------- */
    async pickFile() {
      AudioEngine.ensureCtx();
      if (window.yihuan && window.yihuan.isElectron) {
        const picked = await window.yihuan.pickMidiFile();
        if (!picked) return;
        await this.importMidiFiles(picked.paths || [picked.path]);
      } else {
        el.fileInput.click();
      }
    },

    /* 批量导入：解析校验 + 重名拒绝（曲库已有同名曲目则跳过），加载第一首新曲 */
    async importMidiFiles(paths) {
      await Library.refresh();
      const have = new Set(Library.entries.map((e) => String(e.title).trim().toLowerCase()));
      const added = [], skipped = [];
      let loadedFirst = false;
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop();
        const res = await window.yihuan.readMidiFile(p);
        if (!res.ok) { this.log(`读取失败：${name}（${res.error}）`, 'err'); continue; }
        let song;
        try { song = MidiSource.parse(res.data); }
        catch (err) { this.log(`解析失败：${name}（${err.message}）`, 'err'); continue; }
        const title = song.name || name.replace(/\.(midi?|rmi)$/i, '') || '未命名';
        if (have.has(title.trim().toLowerCase())) { skipped.push(title); continue; }
        have.add(title.trim().toLowerCase());
        added.push(title);
        const meta = { duration: song.duration, notes: song.totalNotes, tracks: song.trackCount, bpm: song.tempo };
        Library.add({ srcPath: p, data: res.data, title, meta });
        if (!loadedFirst) {
          loadedFirst = true;
          this.loadSong(res.data, name); /* 第一首新曲直接载入播放器 */
        }
      }
      if (skipped.length) this.log(`已跳过曲库中已有的同名曲目：${skipped.join('、')}`, 'warn');
      if (added.length > 1) this.log(`批量导入完成：新增 ${added.length} 首入库，当前加载「${added[0]}」`, 'info');
      else if (added.length === 1) this.log(`已导入「${added[0]}」`, 'info');
      else if (!skipped.length) this.log('没有可导入的文件', 'warn');
    },

    /* 导入成功后存入曲库（复制源文件） */
    saveToLibrary(srcPath, data, name) {
      const song = MidiPlayer.song;
      const meta = song ? {
        duration: song.duration, notes: song.totalNotes,
        tracks: song.trackCount, bpm: song.tempo,
      } : {};
      const title = (song && song.name) || name.replace(/\.(midi?|rmi)$/i, '') || '未命名';
      Library.add({ srcPath, data, title, meta });
    },

    loadSong(data, name) {
      let song;
      try {
        song = MidiSource.parse(data);
      } catch (err) {
        this.log('MIDI 解析失败：' + err.message, 'err');
        this.log('常见原因：文件损坏、不是标准 MIDI（如 0 号 RIFF 剥壳失败）、加密容器', 'info');
        return;
      }
      MidiPlayer.load(song);

      el.songName.textContent = song.name || name || '未命名乐曲';
      el.songMeta.textContent =
        `${song.trackCount} 轨 · ${song.totalNotes} 音符 · ${this.fmtTime(song.duration)} · ${song.tempo} BPM`;
      this.buildTrackInfo(song);
      el.timeTotal.textContent = this.fmtTime(MidiPlayer.duration);
      el.progressNote.textContent = '';
      if (Teaching.active) Teaching.stop();
      this.refreshTransport();
      this.refreshProgress();
      if (Perf.active) Perf.rebuild();
      this.log(`已加载「${song.name || name}」：${song.trackCount} 轨 ${song.totalNotes} 音符`, 'info');
    },

    buildTrackInfo(song) {
      /* 在日志里列出轨道，帮助用户决定选轨方式 */
      song.tracks.forEach((t, i) => {
        const drum = t.channel === 9 ? '（打击乐通道）' : '';
        this.log(`轨道${i}「${t.name}」ch${t.channel}${drum}：${t.noteCount} 音符`, 'info');
      });
      const auto = MidiPlayer._buildQueue(song, { ...MidiPlayer.settings, trackSel: 'melody' });
      if (auto.trackLabel) this.log(`melody 模式将自动选择：${auto.trackLabel}`, 'info');
    },

    /* ---------------- 日志 ---------------- */
    log(text, cls) {
      const li = document.createElement('li');
      if (cls && cls !== 'note') li.className = cls;
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = this.fmtTime(MidiPlayer.song ? MidiPlayer.songTimeNow() : 0);
      li.appendChild(time);
      li.appendChild(document.createTextNode(text));
      el.log.prepend(li);
      while (el.log.children.length > 200) el.log.lastChild.remove();
    },

    logNote(midi, tag) {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = this.fmtTime(MidiPlayer.song ? MidiPlayer.songTimeNow() : 0);
      const name = document.createElement('span');
      name.className = 'note-name';
      name.textContent = midiToName(midi);
      const key = document.createElement('span');
      key.className = 'key-label';
      key.textContent = keyLabel(midi);
      const src = document.createElement('span');
      src.className = 'tag ' + (tag === 'manual' ? 'manual' : 'track');
      src.textContent = tag === 'manual' ? '手动' : MidiPlayer.activeTrackLabel || '播放';
      li.append(time, name, key, src);
      el.log.prepend(li);
      while (el.log.children.length > 200) el.log.lastChild.remove();
    },

    /* ---------------- 持久化 ---------------- */
    loadSettings() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
    },
    saveSettings() {
      const s = {
        speed: parseFloat(el.speed.value),
        transpose: MidiPlayer.settings.transpose,
        trackSel: el.trackSel.value,
        customTracks: el.trackCustom.value,
        rangeMode: el.rangeMode.value,
        volume: parseFloat(el.volume.value),
        sustain: parseInt(el.sustain.value, 10),
        instrument: el.instSel.value,
        teaching: el.teachSel.value,
        instrument: Keyboard.instrument,
        echoColor: el.echoColor.value,
        hints: Keyboard.hintsVisible,
        bottomTab: el.tabEcho.classList.contains('active') ? 'echo'
          : el.tabLog.classList.contains('active') ? 'log' : 'viz',
      };
      try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
    },
    restoreSettings() {
      const s = this.loadSettings();
      if (typeof s.speed === 'number' && s.speed >= 0.25 && s.speed <= 3) {
        el.speed.value = String(s.speed);
        el.speedVal.textContent = s.speed.toFixed(2) + '×';
        MidiPlayer.setSpeed(s.speed);
        this.refreshRangeFill(el.speed);
      }
      if (typeof s.transpose === 'number') this.setTranspose(s.transpose);
      if (s.trackSel) {
        el.trackSel.value = s.trackSel;
        el.trackCustom.classList.toggle('hidden', s.trackSel !== 'custom');
        MidiPlayer.settings.trackSel = s.trackSel;
      }
      if (typeof s.customTracks === 'string') {
        el.trackCustom.value = s.customTracks;
        MidiPlayer.settings.customTracks = s.customTracks;
      }
      if (s.rangeMode) {
        el.rangeMode.value = s.rangeMode;
        MidiPlayer.settings.rangeMode = s.rangeMode;
      }
      if (typeof s.volume === 'number') {
        el.volume.value = String(s.volume);
        this.refreshRangeFill(el.volume);
      }
      if (typeof s.sustain === 'number') {
        const v = Math.max(0, Math.min(5000, s.sustain));
        el.sustain.value = String(v);
        el.sustainVal.textContent = v + 'ms';
        this.refreshRangeFill(el.sustain);
        AudioEngine.setSustain(v);
      }
      if (s.bottomTab === 'log') this.switchTab('log');
      if (s.bottomTab === 'echo') this.switchTab('echo');
      if (s.instrument === 'guitar' || s.instrument === 'piano') {
        Keyboard.setInstrument(s.instrument);
        el.instPiano.classList.toggle('active', s.instrument === 'piano');
        el.instGuitar.classList.toggle('active', s.instrument === 'guitar');
      }
      if (typeof s.echoColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.echoColor)) {
        el.echoColor.value = s.echoColor;
        Viz.echoColor = s.echoColor;
      }
      if (s.teaching && s.teaching !== 'off') {
        el.teachSel.value = s.teaching;
        Teaching.mode = s.teaching;
      }
      if (s.hints === false) {
        Keyboard.toggleHints();
        el.hints.textContent = '显示键位提示';
      }
      AudioEngine.setMasterVolume(typeof s.volume === 'number' ? s.volume : 0.85);
    },

    /* ---------------- rAF 主循环 ---------------- */
    startLoop() {
      const loop = () => {
        const perfOn = Perf.active;
        if (!perfOn) MidiPlayer.consumeUi();
        Viz.recyclePresses();
        Teaching.tick();
        if (perfOn) {
          if (Perf.state === 'playing' || Perf.state === 'countdown') this.refreshProgress();
        } else if (MidiPlayer.state === 'playing' || Teaching.active) {
          this.refreshProgress();
        }
        if (!el.vizWrap.classList.contains('hidden')) {
          try { Viz.render(); } catch (e) { console.error('[viz] 渲染异常:', e.message); }
        }
        if (!el.echoWrap.classList.contains('hidden')) {
          try { Viz.renderEcho(); } catch (e) { /* 单帧异常忽略 */ }
        }
        /* 实时按键提示：当前所有按下的键（练习/演奏统一），教学等待模式显示应按键 */
        let pn = '';
        if (Teaching.active && Teaching.mode === 'wait') {
          pn = Teaching.currentHintText();
        } else {
          const parts = [];
          for (const [midi, tags] of Keyboard.counts) {
            if ((tags.get('play') || 0) > 0) parts.push(keyLabel(midi));
          }
          pn = parts.join(' ');
        }
        if (pn !== this._lastPN) { el.progressNote.textContent = pn; this._lastPN = pn; }
        const src = perfOn ? Perf : MidiPlayer;
        if (Teaching.active) {
          el.stats.textContent = `教学${Teaching.mode === 'wait' ? '（等待）' : '（同步）'} · ` + Teaching.progressText();
        } else {
          el.stats.textContent = src.song
            ? (perfOn ? '演奏模式 · ' : '') +
              `总音符 ${src.stats.total} · 映射后 ${src.stats.mapped}` +
              (src.stats.dropped ? ` · 截断 ${src.stats.dropped}` : '') +
              (perfOn ? '' : ` · 声部 ${AudioEngine.activeVoiceCount()}`)
            : (perfOn ? '演奏模式 · ' : '') + (perfOn ? '未加载乐谱' : `声部 ${AudioEngine.activeVoiceCount()}`);
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    fmtTime(sec) {
      sec = Math.max(0, sec || 0);
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    },

    /* ---------------- URL 调试参数 ---------------- */
    async handleUrlParams() {
      const q = new URLSearchParams(location.search);
      if (q.get('teachtest') === '1') { this.teachTest(); return; }
      if (q.get('risertest') === '1') { this.riserTest(); return; }
      if (q.get('guitarvisual') === '1') {
        setTimeout(() => {
          this.switchInstrumentType('guitar');
          setTimeout(() => {
            console.log('[guitarvisual] inst=' + Keyboard.instrument +
              ' rows=' + Keyboard.ROWS.length +
              ' keys=' + Keyboard.keyEls.size);
          }, 500);
        }, 500);
        return;
      }
      if (q.get('echotest') === '1') { this.echoTest(); return; }
      if (q.get('mincheck') === '1') { this.minCheck(); return; }
      if (q.get('perftest') === '1') { this.perfSelfTest(); return; }
      if (q.get('selftest') === '1') { this.selfTest(q.get('midipath') || ''); return; }
      if (q.get('pitchtest') === '1') { this.pitchTest(); return; }
      const midiParam = q.get('midi');
      if (midiParam) {
        try {
          let data;
          if (window.yihuan && window.yihuan.isElectron) {
            const res = await window.yihuan.readMidiFile(midiParam);
            if (!res.ok) throw new Error(res.error);
            data = res.data;
          } else {
            const resp = await fetch(midiParam);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            data = await resp.arrayBuffer();
          }
          this.loadSong(data, midiParam.split(/[\\/]/).pop());
          if (q.get('auto') === '1') {
            AudioEngine.ensureCtx();
            this.playSong();
          }
        } catch (err) {
          this.log('自动加载 MIDI 失败：' + err.message, 'err');
        }
      }
    },

    /* 倒流回声自测：连按 4 键 → 断言 risers 队列与按钮样式 */
    async riserTest() {
      const R = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        this.switchTab('viz'); /* 确保瀑布流页签可见（render 才会运行） */
        const r = await fetch('../assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid');
        this.loadSong(await r.arrayBuffer(), '小星星');
        /* 长按 600ms：音符条生长（长度 ≈ 按键时长 × 速度） */
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
        await sleep(600);
        const pr1 = Viz.presses[0];
        R.grow = {
          exists: !!pr1,
          lengthPx: Math.round(((performance.now() - pr1.born) / 1000) * Viz.lastPps),
          growing: pr1.releasedAt == null,
        };
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }));
        R.released = {
          lenPx: Math.round(((pr1.releasedAt - pr1.born) / 1000) * Viz.lastPps),
          stillVisibleAt1s: null,
        };
        await sleep(1000);
        R.released.stillVisibleAt1s = Viz.presses.includes(pr1); /* 1.75s 内仍在 */
        await sleep(1000); /* 1.75s 后消失 */
        R.gone = !Viz.presses.includes(pr1);
        /* 连按 3 键：多条并存 */
        for (const c of ['KeyS', 'KeyD', 'KeyF']) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
          await sleep(120);
        }
        R.multi = Viz.presses.length;
        await sleep(2000);
        R.allGone = Viz.presses.length === 0;
        R.leftover = Viz.presses.map((x) => ({ m: x.midi, rel: x.releasedAt != null, heldMs: Math.round(((x.releasedAt ?? performance.now()) - x.born)) }));
        this.stopPlay();
      } catch (err) {
        console.log('[risertest] ERR ' + (err.message || err));
      }
      console.log('[risertest] ' + JSON.stringify(R));
      document.title = 'risertest-done';
      async function ElectronCapture() {
        /* 抓瀑布流画布本体（含按键名标签与绿色判定条） */
        const data = $('viz').toDataURL('image/png');
        const rr = await window.yihuan.saveText ? await window.yihuan.writeData('tools/teach-shot.png', data) : { ok: false };
        return rr.ok ? 'tools/teach-shot.png' : null;
      }
    },

    /* ---------------- 回声小框自测 ----------------
     * 关→按→无；开→按住→长条生长；松手→上移流出；截取小框画面 */
    async echoTest() {
      const R = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        this.switchTab('echo'); /* 回声页签可见（画布全尺寸） */
        const r = await fetch('../assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid');
        this.loadSong(await r.arrayBuffer(), '小星星');
        Viz.echoColor = '#20c997';
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
        await sleep(700);
        R.growing = Viz.presses.some((x) => x.midi === 60 && x.releasedAt == null);
        R.echoDims = { W: Viz.echo.W, H: Viz.echo.H, cw: $('echo-viz').width, ch: $('echo-viz').height, wrapHidden: $('echo-wrap').classList.contains('hidden'), wrapW: $('echo-wrap').getBoundingClientRect().width };
        const shot1 = $('echo-viz').toDataURL('image/png');
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }));
        await sleep(250);
        const shot2 = $('echo-viz').toDataURL('image/png');
        await sleep(2000);
        R.drained = !Viz.presses.some((x) => x.midi === 60);
        if (window.yihuan && window.yihuan.writeData) {
          await window.yihuan.writeData('tools/echo-shot1.png', shot1);
          await window.yihuan.writeData('tools/echo-shot2.png', shot2);
          R.saved = true;
        }
        this.switchTab('viz');
      } catch (err) {
        R.error = String((err && err.message) || err);
      }
      console.log('[echotest] ' + JSON.stringify(R));
      document.title = 'echotest-done';
    },

    /* ---------------- 跟弹教学自测 ---------------- */
    async teachTest() {
      const R = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const $ = (id) => document.getElementById(id);
      const kd = (c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
      const ku = (c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
      try {
        this.switchTab('viz'); /* 确保瀑布流页签可见 */
        Keyboard.setInstrument('piano'); /* teachtest 假定钢琴 */
        el.instPiano.classList.add('active');
        el.instGuitar.classList.remove('active');
        const r = await fetch('../assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid');
        this.loadSong(await r.arrayBuffer(), '小星星');

        /* ---- 等待模式 ---- */
        $('teach-sel').value = 'wait';
        $('teach-sel').dispatchEvent(new Event('change'));
        this.playSong();
        await sleep(600);
        R.waitStart = {
          active: Teaching.active, sounding: !Keyboard.silentDemo, /* 教学模式应发声 */
          locked: document.body.classList.contains('perf-busy'),
          nowChord: Teaching._nowChord ? Teaching._nowChord.midis : null,
          nowKeys: [...document.querySelectorAll('.key.teach-now')].map((k) => +k.dataset.midi),
          nextKeys: [...document.querySelectorAll('.key.teach-next')].map((k) => +k.dataset.midi),
          hint: $('progress-note').textContent,
        };
        const t1 = Teaching.songTimeNow();
        await sleep(700);
        R.waitHold = { t1: +t1.toFixed(3), t2: +Teaching.songTimeNow().toFixed(3), held: Math.abs(Teaching.songTimeNow() - t1) < 0.005 };
        kd('KeyA'); await sleep(80); ku('KeyA'); await sleep(300);
        R.waitCorrect = {
          idx: Teaching.idx, hits: Teaching.hits,
          firstOk: MidiPlayer.events[0]._ok === true,
          advanced: Teaching.songTimeNow() > t1 + 0.05,
        };
        const idxB = Teaching.idx;
        kd('KeyQ'); await sleep(60); ku('KeyQ'); await sleep(150);
        R.waitWrong = { unchanged: Teaching.idx === idxB };
        for (let i = 0; i < 2; i++) { kd('KeyA'); await sleep(60); ku('KeyA'); await sleep(120); }
        R.waitRepeat = { idx: Teaching.idx, hits: Teaching.hits };
        this.stopPlay(); await sleep(200);
        R.waitStop = {
          active: Teaching.active, silent: Keyboard.silentDemo,
          unlocked: !document.body.classList.contains('perf-busy'),
          hintsCleared: document.querySelectorAll('.key.teach-now, .key.teach-next').length === 0,
        };

        /* ---- 同步模式：原曲播放 + 判定绿 ---- */
        $('teach-sel').value = 'flow';
        $('teach-sel').dispatchEvent(new Event('change'));
        this.playSong();
        await sleep(300);
        R.flowStart = {
          active: Teaching.active, playerState: MidiPlayer.state,
          silent: Keyboard.silentDemo,
        };
        /* 确定性判定：seek 到 1.0s（该处音符=67/G）后立即判 67 → 必中 */
        MidiPlayer.seek(1.0);
        Teaching._dbg = { calls: [], matched: 0 };
        Teaching.onUserNote(67);
        await sleep(100);
        R.flowJudge = {
          anyOk: MidiPlayer.events.some((e) => e._ok),
          playerStill: MidiPlayer.state,
          dbg: Teaching._dbg,
        };
        this.stopPlay(); await sleep(200);
        R.flowStop = { active: Teaching.active, playerStopped: MidiPlayer.state === 'stopped' };

        /* ---- 键盘谱导出（纯文本生成） ---- */
        const txt = this.buildChartText();
        R.export = {
          length: txt.length,
          head: txt.split('\r\n').slice(0, 5),
          firstNotes: txt.split('\r\n').slice(6, 10),
          hasLegend: txt.includes('⇧=Shift'),
        };

        /* ---- 实时按键全显（练习播放中和弦齐显） ---- */
        $('teach-sel').value = 'off';
        $('teach-sel').dispatchEvent(new Event('change'));
        this.playSong();
        const samples = new Set();
        for (let i = 0; i < 24; i++) { const v = $('progress-note').textContent.trim(); if (v) samples.add(v); await sleep(100); }
        this.stopPlay();
        R.liveKeys = { distinct: [...samples], nonEmpty: samples.size > 0 };
      } catch (err) {
        R.error = String((err && err.message) || err);
      }
      console.log('[teachtest] ' + JSON.stringify(R));
      document.title = 'teachtest-done';
    },

    /* ---------------- 最小化复现探针 ---------------- */
    async minCheck() {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const vis = () => `[mincheck] t=${Math.round(performance.now())} vis=${document.visibilityState} hidden=${document.hidden} state=${Perf.active ? Perf.state : 'practice/' + MidiPlayer.state}`;
      const timer = setInterval(() => console.log(vis()), 500);
      setTimeout(() => console.log('[mincheck] DONE'), 16000);
      try {
        /* 练习模式自动播放 4s */
        AudioEngine.ensureCtx();
        const r = await fetch('../assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid');
        this.loadSong(await r.arrayBuffer(), '小星星');
        MidiPlayer.play();
        await sleep(4000);
        MidiPlayer.stop();
        /* 演奏模式 bg 自动播放 5s（目标=自身窗口） */
        Perf.setActive(true);
        Perf.countdown = 0;
        Perf._allowUnelevated = true;
        Perf.hwnd = await window.yihuan.perfSelfHwnd();
        Perf.windowTitle = '（自检）';
        await Perf.play();
        await sleep(5000);
        await Perf.stop();
        /* fg 模式闭环：AttachThreadInput 前台切换 + 真实按键到自身窗口 */
        Perf.mode = 'fg';
        Perf.els.inputMode.value = 'fg';
        let fgKeys = 0;
        const recFg = () => fgKeys++;
        window.addEventListener('keydown', recFg, true);
        await Perf.play();
        await sleep(3000);
        window.removeEventListener('keydown', recFg, true);
        await Perf.stop();
        Perf.setActive(false);
        console.log('[mincheck] FG-KEYS=' + fgKeys);
      } catch (err) {
        console.log('[mincheck] ERR ' + (err.message || err));
      }
    },

    /* ---------------- 演奏模式闭环自检 ----------------
     * 目标窗口 = 本应用自身：后台注入的按键会被自己的渲染层收到，
     * 统计 code/修饰键/数量/时序即可验证整条注入链路。 */
    async perfSelfTest() {
      const R = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        if (!window.yihuan || !window.yihuan.isElectron) throw new Error('仅桌面版');
        R.endedEvents = [];
        const origOnEvent = Perf.onEvent.bind(Perf);
        Perf.onEvent = (k, d) => {
          if (k === 'ended') R.endedEvents.push({ f: d.finished, p: d.played, st: Perf.state });
          origOnEvent(k, d);
        };
        MidiPlayer.setSpeed(3);
        document.getElementById("speed").value = "3";
        document.getElementById("speed-val").textContent = "3.00×";
        if (MidiPlayer.speed !== 3) throw new Error('速度断言失败: ' + MidiPlayer.speed);
        const r = await fetch('../assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid');
        this.loadSong(await r.arrayBuffer(), '小星星');
        Perf.setActive(true);
        Perf.countdown = 0;
        Perf._allowUnelevated = true; /* 自测进程非管理员：豁免后台注入的提权拦截 */
        const selfHwnd = await window.yihuan.perfSelfHwnd();
        if (!selfHwnd) throw new Error('未取得自身窗口句柄');
        Perf.hwnd = selfHwnd;
        Perf.windowTitle = '（自检：本窗口）';
        Perf.updateStatus();
        /* 重建调度（速度断言通过后），校准 duration */
        Perf.rebuild();
        R.speed = MidiPlayer.speed;
        R.durationExpected = +(Perf.duration).toFixed(2);

        const got = [];
        const rec = (e) => got.push({
          code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey,
          trusted: e.isTrusted, t: performance.now(),
        });
        window.addEventListener('keydown', rec, true);
        const t0 = performance.now();
        /* 时钟平滑度采样：每 30ms 记录 songTimeNow（Viz 的驱动时间） */
        const clock = [];
        const clockTimer = setInterval(() => clock.push(Perf.songTimeNow()), 30);
        Perf.play();
        for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
        R.started = Perf.state;
        for (let i = 0; i < 60 && Perf.state !== 'stopped'; i++) await sleep(500);
        clearInterval(clockTimer);
        let backJumps = 0, maxFwd = 0, maxFwdIdx = -1;
        for (let i = 1; i < clock.length; i++) {
          const d = clock[i] - clock[i - 1];
          if (d < -0.002) backJumps++;
          if (d > maxFwd) { maxFwd = d; maxFwdIdx = i; }
        }
        R.clockSmooth = { samples: clock.length, backJumps, maxFwdMs: Math.round(maxFwd * 1000), maxFwdIdx, tail: clock.length - maxFwdIdx };
        window.removeEventListener('keydown', rec, true);
        R.chords = Perf.chords.length;
        R.keysReceived = got.length;
        R.first8 = got.slice(0, 8).map((g) => g.code + (g.shift ? '⇧' : '') + (g.ctrl ? '⌃' : ''));
        R.trusted = got.length ? got[0].trusted : null;
        R.elapsedS = +((performance.now() - t0) / 1000).toFixed(2);
        /* 暂停/恢复/停止 */
        Perf.seek(1);
        Perf.play();
        for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
        const playingState = Perf.state;
        await sleep(700);
        await Perf.pause();
        const pauseR = Perf._lastPauseR;
        const paused = Perf.state;
        const offAfterPause = +Perf.songPos().toFixed(2);
        await sleep(600);
        const heldAt = Perf.songTimeNow();
        await Perf.resume();
        const resumedAt = Perf.state;
        await sleep(500);
        await Perf.stop();
        R.pauseResume = { playingState, pauseR, paused, offAfterPause, heldAt: +heldAt.toFixed(2), resumedAt, stopped: Perf.state, duration: +Perf.duration.toFixed(2) };
        R.keysTotal = got.length;

        /* 丝滑变速（演奏模式）：播放中改速度，应持续演奏不断音 */
        {
          const gotS = [];
          const recS = (e) => gotS.push(e.code);
          window.addEventListener('keydown', recS, true);
          Perf.seek(0);
          Perf.play();
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          await sleep(1000);
          const beforeChange = Perf.state;
          const spd = document.getElementById('speed');
          spd.value = '1.5';
          spd.dispatchEvent(new Event('input'));
          await sleep(400);
          const stateAfterChange = Perf.state;
          await sleep(1200);
          const keysAfterChange = gotS.length;
          window.removeEventListener('keydown', recS, true);
          await Perf.stop();
          spd.value = '3';
          spd.dispatchEvent(new Event('input'));
          await sleep(200);
          R.perfSmoothSpeed = { beforeChange, stateAfterChange, keysAfterChange };
        }

        /* 暂停 → 拖动进度：应停在 stopped 并定位新位置，再按播放从该处全新启动 */
        {
          const gotP = [];
          const recP = (e) => gotP.push(e.code);
          window.addEventListener('keydown', recP, true);
          Perf.seek(0);
          Perf.play();
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          await sleep(800);
          await Perf.pause();
          const pausedAt = +Perf.songPos().toFixed(2);
          Perf.seek(2.5);
          await sleep(600); /* 安静停止完成 */
          const stateAfterSeek = Perf.state;
          const offsetAfterSeek = +Perf.songPos().toFixed(2);
          const progAfter = [];
          const origOE2 = Perf.onEvent.bind(Perf);
          Perf.onEvent = (k, d) => {
            if (k === 'progress' && progAfter.length < 3) progAfter.push(+(d.t * MidiPlayer.speed).toFixed(2));
            if (k === 'ended') R.endedEvents.push({ f: d.finished, p: d.played, st: Perf.state });
            origOE2(k, d);
          };
          await Perf.play(); /* stopped → 全新启动，从 2.5 开始 */
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          await sleep(1200);
          const tAfter = +Perf.songTimeNow().toFixed(2);
          Perf.onEvent = origOE2;
          window.removeEventListener('keydown', recP, true);
          await Perf.stop();
          R.pauseSeekResume = { pausedAt, stateAfterSeek, offsetAfterSeek, progAfter, tAfter, keysDuring: gotP.length };
        }

        /* 播放中直接拖动进度条：安静停止 → 自动按未开始流程从新位置重启 */
        {
          const gotQ = [];
          const recQ = (e) => gotQ.push(e.code);
          window.addEventListener('keydown', recQ, true);
          Perf.seek(0);
          Perf.play();
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          await sleep(600);
          const beforeSeek = +Perf.songPos().toFixed(2);
          const progQ = [];
          const origOE3 = Perf.onEvent.bind(Perf);
          Perf.onEvent = (k, d) => {
            if (k === 'progress' && progQ.length < 3) progQ.push(+(d.t * MidiPlayer.speed).toFixed(2));
            if (k === 'ended') R.endedEvents.push({ f: d.finished, p: d.played, st: Perf.state });
            origOE3(k, d);
          };
          Perf.seek(5.0); /* 播放中拖到歌曲 5 秒处 */
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          const stateAfterSeek = Perf.state;
          await sleep(1000);
          Perf.onEvent = origOE3;
          window.removeEventListener('keydown', recQ, true);
          await Perf.stop();
          R.seekWhilePlaying = { beforeSeek, stateAfterSeek, progAfter: progQ, keysAfter: gotQ.length };
        }

        /* 极限：播放中连续 6 次快速 seek（间隔 120ms）→ 必须收敛到最后位置 */
        {
          const progR = [];
          const oeR = Perf.onEvent.bind(Perf);
          Perf.onEvent = (k, d) => {
            if (k === 'progress') { const song = +(d.t * MidiPlayer.speed).toFixed(2); progR.push(song); if (progR.length > 30) progR.shift(); }
            if (k === 'ended') R.endedEvents.push({ f: d.finished, p: d.played, st: Perf.state });
            oeR(k, d);
          };
          Perf.seek(0);
          Perf.play();
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          const seqR = [];
          for (const t of [6, 2, 8, 4, 7, 5]) {
            Perf.seek(t);
            seqR.push(Perf.state + ':' + Perf.songPos().toFixed(1));
            await sleep(120);
          }
          await sleep(2500);
          Perf.onEvent = oeR;
          /* 终验：最后一次 seek(5) 后按播放 → 应从 5.0 精确起播 */
          await Perf.play();
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          const progTail = [];
          const oeE = Perf.onEvent.bind(Perf);
          Perf.onEvent = (k, d) => { if (k === 'progress' && progTail.length < 3) progTail.push(+d.t.toFixed(2)); oeE(k, d); };
          await sleep(600);
          Perf.onEvent = oeE;
          /* 一致性断言（必须在 stop 前采样）：此刻应仍在播放（曲长未到）；
           * 若 state='stopped' 且 offset 既不在播完点也不在目标位置 → 状态脱节 */
          const offAfter = +Perf.songPos().toFixed(2);
          const stateAfter = Perf.state;
          const desync = stateAfter === 'stopped' && Math.abs(offAfter - Perf.duration) > 0.5 && Math.abs(offAfter - 5) > 0.01;
          await Perf.stop();
          const inWin = progTail.filter(t => t >= 4.9 && t <= 6.2).length;
          R.rapidSeek = { seq: seqR, progTail, inTargetWindow: inWin, converged: inWin >= 2, offAfter, stateAfter, desync };
        }

        /* 模拟真实点击：滑杆设到 25% 刻度 → change → 演奏模式应落在歌曲 25% 处 */
        {
          Perf.setActive(true);
          Perf.rebuild();
          const dur = MidiPlayer.duration; /* 歌曲时长（速度无关） */
          el.progress.value = '250'; /* 25% */
          el.progress.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(500);
          const landed = +Perf.songPos().toFixed(2); /* 换算歌曲时间 */
          const expected = +(0.25 * dur).toFixed(2);
          el.progress.value = '600';
          el.progress.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(500);
          const landed2 = +Perf.songPos().toFixed(2);
          const expected2 = +(0.6 * dur).toFixed(2);
          Perf.setActive(false);
          R.sliderClick = { dur: +dur.toFixed(2), clicked: expected, landed, clicked2: expected2, landed2, factor: +(landed / Math.max(expected, 0.01)).toFixed(2) };
        }

        /* 复现场景A：完整播完 → 换曲 → 再播（用户报告失效的路径） */
        const runSong = async (url, name, secs) => {
          const got2 = [];
          const rec2 = (e) => got2.push(e.code);
          window.addEventListener('keydown', rec2, true);
          const rr = await fetch(url);
          this.loadSong(await rr.arrayBuffer(), name);
          Perf.seek(0);
          await Perf.play();
          for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
          for (let i = 0; i < Math.ceil(secs / 0.5) + 6 && Perf.state !== 'stopped'; i++) await sleep(500);
          window.removeEventListener('keydown', rec2, true);
          return { keys: got2.length, state: Perf.state, chords: Perf.chords.length };
        };
        R.playAfterEnd = await runSong('/assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid', '小星星', 9);
        /* 复现场景B：中途停止 → 换曲 → 再播 */
        const rr2 = await fetch('/assets/demo/demo1_%E5%B0%8F%E6%98%9F%E6%98%9F_%E5%8D%95%E8%BD%A8.mid');
        this.loadSong(await rr2.arrayBuffer(), '小星星B');
        Perf.seek(0);
        await Perf.play();
        for (let i = 0; i < 20 && Perf.state !== 'playing'; i++) await sleep(300);
        await sleep(1500);
        await Perf.stop();
        R.stoppedMid = { state: Perf.state };
        R.playAfterStop = await runSong('/assets/demo/demo2_%E5%8D%A1%E5%86%9C%E7%89%87%E6%AE%B5_%E5%8F%8C%E8%BD%A8.mid', '卡农', 3);
        await Perf.stop();
        Perf.setActive(false);
      } catch (err) {
        R.error = String((err && err.message) || err);
      }
      window.__perftest = R;
      console.log('[perftest] ' + JSON.stringify(R));
      document.title = 'perftest-done';
    },

    /* ---------------- Electron 冒烟自检 ----------------
     * 验证主进程链路：IPC 音色扫描 / IPC 读文件 / app:// 协议音频加载 / 解析。
     * 结果输出到 console（--enable-logging 可见）并写入 window.__selftest。 */
    async selfTest(midiPath) {
      const results = {};
      try {
        const insts = await window.yihuan.listInstruments();
        results.instruments = insts.map((i) => `${i.id}:${i.samples}`);
        const inst = await AudioEngine.loadInstrument(insts.find((i) => i.id === 'grand') ? 'grand' : insts[0].id);
        AudioEngine.setCurrent(inst.id);
        results.samplesLoaded = inst.buffers.size;
        results.missingSamples = inst.missing.length;
        const voice = AudioEngine.noteOn(60, 0.9, 'manual');
        results.noteOn = !!voice;
        if (voice) setTimeout(() => AudioEngine.release(voice), 200);
        if (midiPath) {
          const res = await window.yihuan.readMidiFile(midiPath);
          if (!res.ok) throw new Error('readMidiFile: ' + res.error);
          const song = MidiSource.parse(res.data);
          results.parse = { tracks: song.trackCount, notes: song.totalNotes, name: song.name || '(无标题)' };
        }
        results.hotkeyBridge = typeof window.yihuan.onGlobalHotkey === 'function';
        if (midiPath && window.yihuan.libraryAdd) {
          const add = await window.yihuan.libraryAdd(midiPath, '自检曲目', { duration: 1, notes: 2, tracks: 3, bpm: 4 }, ['自检']);
          const list = await window.yihuan.libraryList();
          const rm = await window.yihuan.libraryRemove(add.entry.id);
          results.library = { add: add.ok, listed: list.entries.some((e) => e.id === add.entry.id), removed: rm.ok };
        }
      } catch (err) {
        results.error = String((err && err.message) || err);
      }
      window.__selftest = results;
      console.log('[selftest] ' + JSON.stringify(results));
      document.title = 'selftest-done';
    },

    /* ---------------- 音高自检 ----------------
     * 解码每个采样，自相关法估算基频 → 与文件名标注的 MIDI 音高比对。
     * 用于校验老项目迁移过来的「文件↔音高」映射是否正确。 */
    async pitchTest() {
      this.log('===== 音高自检开始 =====', 'info');
      const report = [];
      const table = {};
      for (const inst of this.instruments) {
        const loaded = await AudioEngine.loadInstrument(inst.id, inst.name);
        AudioEngine.setCurrent(inst.id);
        let ok = 0;
        const bad = [];
        table[inst.id] = {};
        for (const [midi, buf] of loaded.buffers) {
          const est = this.estimateMidi(buf);
          table[inst.id][midi] = est;
          if (est === midi) ok++;
          else bad.push(`${midiToName(midi)}(${midi}) → 实测 ${est != null ? midiToName(est) + '(' + est + ')' : '?'}`);
        }
        report.push({ id: inst.id, ok, bad });
        this.log(`音色「${inst.name}」：${ok}/36 正确` + (bad.length ? `，异常 ${bad.length}` : ''), bad.length ? 'warn' : 'info');
        bad.forEach((b) => this.log('  ' + b, 'warn'));
      }
      this.log('===== 音高自检结束 =====', 'info');
      window.__pitchReport = report;
      window.__pitchTable = table;
      document.title = 'pitchtest-done';
    },

    estimateMidi(buffer) {
      const SR_DIV = 4;
      const sr = buffer.sampleRate / SR_DIV;
      const src = buffer.getChannelData(0);
      /* 降采样 ×4 */
      const dsLen = Math.floor(src.length / SR_DIV);
      if (dsLen < 1024) return null;
      const ds = new Float32Array(dsLen);
      for (let i = 0; i < dsLen; i++) {
        ds[i] = (src[i * SR_DIV] + src[i * SR_DIV + 1] + src[i * SR_DIV + 2] + src[i * SR_DIV + 3]) / 4;
      }
      let peak = 0;
      for (let i = 0; i < dsLen; i++) peak = Math.max(peak, Math.abs(ds[i]));
      if (peak < 1e-4) return null;
      /* 跳过前导静音 */
      let start = 0;
      for (let i = 0; i < dsLen; i++) {
        if (Math.abs(ds[i]) > peak * 0.2) { start = i; break; }
      }
      const W = Math.min(dsLen - start, Math.floor(sr * 0.35));
      if (W < 256) return null;
      /* 多窗平均自相关（三窗：起音 / +W/3 / +2W/3），抗瞬态与衰减失真 */
      const minLag = Math.max(2, Math.floor(sr / 1150));
      const maxLag = Math.min(W - 64, Math.ceil(sr / 105));
      const r = new Float64Array(maxLag + 1);
      let windows = 0;
      for (const frac of [0, 1 / 3, 2 / 3]) {
        const p = start + Math.floor(W * frac);
        if (p + W > dsLen) continue;
        const seg = ds.subarray(p, p + W);
        let mean = 0;
        for (let i = 0; i < W; i++) mean += seg[i];
        mean /= W;
        let e0 = 0;
        for (let i = 0; i < W; i++) { const v = seg[i] - mean; e0 += v * v; }
        if (e0 < 1e-9) continue;
        windows++;
        for (let lag = minLag; lag <= maxLag; lag++) {
          let sum = 0;
          for (let i = 0; i < W - lag; i++) { const v = seg[i] - mean; sum += v * (seg[i + lag] - mean); }
          r[lag] += sum / e0; // 归一化自相关
        }
      }
      if (!windows) return null;
      let bestLag = -1, bestVal = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (r[lag] > bestVal) { bestVal = r[lag]; bestLag = lag; }
      }
      if (bestLag < 0 || bestVal <= 0.05) return null;
      /* 子谐波校正：若折半周期处自相关依然很强，取更高八度 */
      for (const div of [4, 3, 2]) {
        const half = Math.round(bestLag / div);
        if (half >= minLag && r[half] > 0.82 * bestVal) {
          bestVal = r[half];
          bestLag = half;
        }
      }
      const f0 = sr / bestLag;
      const m = Math.round(69 + 12 * Math.log2(f0 / 440));
      return m >= 0 && m <= 127 ? m : null;
    },
  };

  window.UI = UI;
  window.addEventListener('DOMContentLoaded', () => {
    UI.init();
    UI.startLoop();
  });
})();
