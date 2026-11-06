/* ============================================================================
 * 演奏模式调度 worker —— 独立线程，事件循环保持存活
 *
 *  · 自调度 setTimeout 链（步进 ≤25ms，按绝对锚点校正）：worker 的消息
 *    （pause/resume/stop）可即时处理——注意不能用同步 Atomics 循环占死线程，
 *    否则消息永远进不来；
 *  · 按键持续保持（sustain）：每个音符按下后保持到自身时长结束才抬起
 *    （与练习模式的延音一致）；同一键在保持期内再次触发 = 先抬后按（重击）；
 *  · 修饰键（shift/ctrl）引用计数：多个保持中的音符共享修饰键，
 *    全部释放后才真正抬起，避免"半路松 shift 跑音"。
 * ==========================================================================*/
const { parentPort } = require('worker_threads');
const ffi = require('./perf-ffi.js');

const _gate = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(_gate, 0, 0, ms); }
function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

const HOLD_MIN_MS = 60;     /* 短于该时长的音按短击处理（保证游戏能识别为一次触发） */
const HOLD_MAX_MS = 30000;  /* 踏板扩展可能给出超长时长，钳制防粘键 */

const S = {
  running: false, paused: false, stop: false,
  sid: 0,
  chords: [], idx: 0,
  anchorMs: 0, offsetMs: 0,
  hwnd: 0, mode: 'bg', holdMs: 8,
  lastProgress: 0, fgWarned: false,
  timer: null,
  finishTimer: null,   /* 自然结束后等待尾音收尾的定时器 */
  holds: new Map(),    /* spec -> { timer, vk, mod, endAt } 当前保持中的键 */
  modRefs: new Map(),  /* 'shift'|'ctrl' -> 引用计数 */
};

function post(msg) { try { parentPort.postMessage(msg); } catch { /* 主进程退出中 */ } }


/* spec = 'z' | 'shift+z' | 'ctrl+v' → { mod: 'shift'|'ctrl'|null, vk: 主键 VK 码 } */
function parseSpec(spec) {
  const [mod, key] = spec.includes('+') ? spec.split('+') : [null, spec];
  const vk = ffi.VK[key];
  if (!vk) throw new Error('未知键位: ' + spec);
  if (mod && mod !== 'shift' && mod !== 'ctrl') throw new Error('未知修饰键: ' + spec);
  return { mod: mod || null, vk };
}

function acquireMod(mod) {
  if (!mod) return;
  const n = (S.modRefs.get(mod) || 0) + 1;
  S.modRefs.set(mod, n);
  if (n === 1) ffi.postKey(S.hwnd, mod === 'shift' ? 0xa0 : 0xa2, true, S.mode);
}

function releaseMod(mod) {
  if (!mod) return;
  const n = (S.modRefs.get(mod) || 0) - 1;
  if (n <= 0) { S.modRefs.delete(mod); ffi.postKey(S.hwnd, mod === 'shift' ? 0xa0 : 0xa2, false, S.mode); }
  else S.modRefs.set(mod, n);
}

function releaseHold(spec) {
  const h = S.holds.get(spec);
  if (!h) return;
  if (h.timer) clearTimeout(h.timer);
  S.holds.delete(spec);
  /* 抬起顺序与按下相反：主键先抬，修饰键后抬 */
  ffi.postKey(S.hwnd, h.vk, false, S.mode);
  releaseMod(h.mod);
}

function releaseAllHolds() {
  for (const spec of [...S.holds.keys()]) releaseHold(spec);
  /* 兜底：引用计数残留直接清零（正常不应发生） */
  for (const mod of [...S.modRefs.keys()]) { releaseMod(mod); }
}

function strikeChord(chord) {
  if (S.mode === 'bg') {
    /* 激活欺骗（50ms 超时，防游戏忙时卡住调用线程） */
    ffi.spoofActivate(S.hwnd);
  }
  const keys = chord.keys || [];
  const durs = (chord.durs && chord.durs.length === keys.length) ? chord.durs : null;

  /* ── 通用按法：全音持续保持（MIDI 时长），半音原子轻点 ──
   * 第一步：全音（无修饰键）先按下并长按——键位按下时不带任何修饰键，
   * 游戏在按键瞬间确定的音高必然正确，且按 MIDI 长度延音；
   * 第二步：半音（Shift/Ctrl）逐个原子轻点——修饰键只在自身窗口内，
   * 不与任何全音的「按下瞬间」重叠（全音的按下都发生在轻点之前）。
   * 吉他延音关闭时 durs 缺省 → 全音也走短击（chord.holdMs）
   * 吉他延音开启 / 钢琴（自带 MIDI 时长）→ 全音延音生效 */
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < keys.length; i++) {
      const spec = keys[i];
      const { mod, vk } = parseSpec(spec);
      const isMod = !!mod;
      if ((pass === 0) === isMod) continue; /* 第一步只处理全音，第二步只处理半音 */

      if (!isMod) {
        /* 全音：持续保持（有 durs 按 MIDI 时长，无 durs 按按键时长） */
        const specKey = 'plain#' + vk;
        if (S.holds.has(specKey)) releaseHold(specKey); /* 密集重击：前音未结束先抬 */
        const dur = durs
          ? Math.max(HOLD_MIN_MS, Math.min(HOLD_MAX_MS, durs[i]))
          : Math.max(15, Math.min(120, chord.holdMs ?? S.holdMs));
        ffi.postKey(S.hwnd, vk, true, S.mode);
        const tid = setTimeout(() => {
          ffi.postKey(S.hwnd, vk, false, S.mode);
          S.holds.delete(specKey);
        }, dur);
        S.holds.set(specKey, { timer: tid, vk, mod: null, endAt: nowMs() + dur });
      } else {
        /* 半音：原子轻点——修饰键按下 → 主键按下 → 保持 → 主键抬起 → 修饰键抬起 */
        const hold = Math.max(20, Math.min(120, chord.holdMs ?? S.holdMs));
        const mvk = mod === 'shift' ? 0xa0 : 0xa2;
        acquireMod(mod);
        ffi.postKey(S.hwnd, vk, true, S.mode);
        const tid = setTimeout(() => {
          ffi.postKey(S.hwnd, vk, false, S.mode);
          releaseMod(mod);
          S.holds.delete(spec);
        }, hold);
        S.holds.set(spec, { timer: tid, vk, mod, endAt: nowMs() + hold });
      }
    }
  }
}

function startPlay(p) {
  S.sid = p.sid || 0;
  S.chords = p.chords || [];
  S.timeline = p.timeline || null;
  S.hwnd = Number(p.hwnd);
  S.mode = p.mode === 'fg' ? 'fg' : 'bg';
  S.holdMs = Math.max(2, Math.min(120, p.holdMs | 0 || 35));
  S.offsetMs = Math.max(0, p.offset || 0) * 1000;
  S.idx = 0;
  S.stop = false; S.paused = false; S.running = true;
  S.lastProgress = 0; S.fgWarned = false;
  if (S.finishTimer) { clearTimeout(S.finishTimer); S.finishTimer = null; } /* 上一曲的延迟收尾作废 */
  releaseAllHolds();
  while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
  S.anchorMs = nowMs() - S.offsetMs;
  if (S.mode === 'fg') {
    /* 仅做一次无害尝试；是否就位由用户点击游戏保证（弹窗引导 + 失焦自停兜底） */
    ffi.forceForeground(S.hwnd);
  }
  post({ type: 'started', sid: S.sid, chordCount: S.chords.length, startIdx: S.idx });
  if (S.timer) clearTimeout(S.timer);
  S.timer = setTimeout(scheduleNext, 0);
}

function scheduleNext() {
  if (S.stop || S.idx >= S.chords.length) return finish();
  if (S.paused) { S.timer = setTimeout(scheduleNext, 15); return; }
  const chord = S.chords[S.idx];
  const delay = (S.anchorMs + chord.t) - nowMs();
  if (delay > 2.5) {
    S.timer = setTimeout(scheduleNext, Math.min(delay - 1.5, 25));
    return;
  }
  /* 前台模式安全检查：游戏窗口失去焦点立即停止（真实按键会打进别的窗口） */
  if (S.mode === 'fg' && Number(ffi.F.GetForegroundWindow()) !== S.hwnd) {
    releaseAllHolds();
    S.running = false;
    finish();
    post({ type: 'warn', msg: '前台模式：游戏窗口失去焦点，已自动停止演奏' });
    return;
  }
  try {
    strikeChord(chord);
  } catch (err) {
    releaseAllHolds();
    S.running = false;
    finish();
    post({ type: 'warn', msg: '和弦发送异常：' + (err.message || err) + ' | ' + String(err.stack || '').split('\n').slice(0, 4).join(' << ') });
    return;
  }
  S.idx++;
  post({
    type: 'note', sid: S.sid, idx: S.idx - 1, pitches: chord.pitches,
    holdMs: chord.holdMs ?? S.holdMs,
    durMs: (chord.durs && chord.durs.length === (chord.keys || []).length)
      ? Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, ...chord.durs)) : (chord.holdMs ?? S.holdMs),
  });
  const now = nowMs();
  if (now - S.lastProgress > 100) {
    S.lastProgress = now;
    post({ type: 'progress', sid: S.sid, t: (now - S.anchorMs) / 1000, idx: S.idx, total: S.chords.length });
  }
  if (S.idx >= S.chords.length) return finish();
  S.timer = setTimeout(scheduleNext, 0);
}

function finish() {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  const finished = !S.stop && S.idx >= S.chords.length;
  S.running = false; S.paused = false;
  if (finished && S.holds.size > 0) {
    /* 自然结束且仍有延音保持中的键（如曲末长按音）：等它们自然收尾再报结束。
     * 立刻抬键会把最后的尾音掐断（表现为曲末 2-3 秒被吞、戛然而止）。 */
    if (S.finishTimer) clearTimeout(S.finishTimer);
    let waitMs = 0;
    for (const h of S.holds.values()) waitMs = Math.max(waitMs, (h.endAt || 0) - nowMs());
    waitMs = Math.max(0, Math.min(waitMs + 60, HOLD_MAX_MS));
    S.finishTimer = setTimeout(() => {
      S.finishTimer = null;
      releaseAllHolds(); /* 兜底抬键（正常此时已全部自然抬起，防游戏内粘键长鸣） */
      post({ type: 'ended', sid: S.sid, finished: true, played: S.idx });
    }, waitMs);
    return;
  }
  if (S.finishTimer) { clearTimeout(S.finishTimer); S.finishTimer = null; }
  releaseAllHolds(); /* 手动停止/异常/前台失焦：立即抬键防粘键 */
  post({ type: 'ended', sid: S.sid, finished, played: S.idx });
}

parentPort.on('message', (m) => {
  if (!m || !m.type) return;
  if (m.type === 'play') {
    /* 永不拒绝：若仍在运行/暂停（如渲染层状态脱节），先静默收尾再启动 */
    if (S.running) {
      S.stop = true;
      S.running = false;
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
      releaseAllHolds();
    }
    startPlay(m);
  } else if (m.type === 'pause') {
    if (!S.running) { post({ type: 'paused', t: 0, already: true }); return; } /* 未运行报 t=0，主进程映射为 stopped */
    if (S.paused) { post({ type: 'paused', t: S.offsetMs / 1000, already: true }); return; }
    S.paused = true;
    S.offsetMs = Math.max(0, nowMs() - S.anchorMs);
    releaseAllHolds(); /* 暂停即抬键：游戏内不残留长音 */
    post({ type: 'paused', t: S.offsetMs / 1000 });
  } else if (m.type === 'resume') {
    if (!S.running) { post({ type: 'resumed', ok: false, error: 'not-running' }); return; }
    if (!S.paused) { post({ type: 'resumed', ok: true, t: S.offsetMs / 1000, already: true }); return; }
    S.paused = false;
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    /* 暂停期间用户点过模拟器 → 游戏失焦：前台模式恢复焦点，否则继续后
     * 第一拍就会被"失焦自停"检查终止（表现为继续后一个键都没按下） */
    if (!ffi.F.IsWindow(S.hwnd)) {
      const h = ffi.findGameWindow();
      if (h) S.hwnd = h;
    }
    if (S.mode === 'fg') ffi.forceForeground(S.hwnd);
    post({ type: 'resumed', ok: true, t: S.offsetMs / 1000 });
  } else if (m.type === 'hold') {
    /* 演奏中实时调整按键时长（不影响调度时序，安全）：后续和弦即刻生效 */
    S.holdMs = Math.max(2, Math.min(120, (m.value | 0) || 25));
  } else if (m.type === 'stop') {
    S.stop = true;
    S.running = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    releaseAllHolds();
    finish();
  } else if (m.type === 'seek') {
    /* 进度跳转 = 原地重定基：会话不中断（播放中无缝跳、暂停中改锚点），
     * 跳过新位置之前的和弦，立即回报一次进度供界面同步 */
    if (S.stop) return;
    if (m.sid != null) S.sid = m.sid;
    releaseAllHolds(); /* 位置已变，保持中的音全部抬键 */
    S.offsetMs = Math.max(0, m.offsetMs || 0);
    /* 索引重置到 0 再快进：向前回溯时旧索引不改写会卡在远期和弦上 */
    S.idx = 0;
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    S.lastProgress = 0;
    post({ type: 'progress', sid: S.sid, t: S.offsetMs / 1000, idx: S.idx, total: S.chords.length });
  } else if (m.type === 'rebase') {
    /* 热重定基：丝滑变速用——不停顿地替换剩余调度（如速度变更后的新时刻表） */
    if (!S.running || S.stop) return;
    S.chords = m.chords || S.chords;
    S.offsetMs = Math.max(0, m.offsetMs || 0);
    S.idx = 0;
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    post({ type: 'rebased', t: S.offsetMs / 1000 });
  }
});
