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
  holds: new Map(),    /* spec -> { timer, vks, mods } 当前保持中的键 */
  modRefs: new Map(),  /* 'shift'|'ctrl' -> 引用计数 */
};

function post(msg) { try { parentPort.postMessage(msg); } catch { /* 主进程退出中 */ } }

/* spec = 'z' | 'shift+z' | 'ctrl+v' → 按下顺序 [修饰键..., 主键]（VK 码） */
function specToVks(spec) {
  const [mod, key] = spec.includes('+') ? spec.split('+') : [null, spec];
  const vk = ffi.VK[key];
  if (!vk) throw new Error('未知键位: ' + spec);
  const vks = [];
  if (mod === 'shift' || mod === 'ctrl') vks.push(mod);
  vks.push(vk);
  return vks;
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
  ffi.postKey(S.hwnd, h.vks[h.vks.length - 1], false, S.mode);
  for (let i = h.mods.length - 1; i >= 0; i--) releaseMod(h.mods[i]);
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
  for (let i = 0; i < keys.length; i++) {
    const spec = keys[i];
    const dur = Math.max(HOLD_MIN_MS, Math.min(HOLD_MAX_MS, durs ? durs[i] : S.holdMs));
    if (S.holds.has(spec)) releaseHold(spec); /* 重击：先抬后按 */
    const vks = specToVks(spec);
    const mods = [];
    if (vks.length > 1) { mods.push(vks[0]); acquireMod(vks[0]); }
    ffi.postKey(S.hwnd, vks[vks.length - 1], true, S.mode);
    const timer = setTimeout(() => releaseHold(spec), dur);
    S.holds.set(spec, { timer, vks, mods });
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
    post({ type: 'warn', msg: '和弦发送异常：' + (err.message || err) });
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
  releaseAllHolds(); /* 收尾必须抬键，防止游戏内粘键长鸣 */
  const finished = !S.stop && S.idx >= S.chords.length;
  S.running = false; S.paused = false;
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
    if (!S.running || S.paused) { post({ type: 'paused', t: S.offsetMs / 1000, already: true }); return; }
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
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    S.lastProgress = 0;
    post({ type: 'progress', sid: S.sid, t: S.offsetMs / 1000, idx: S.idx, total: S.chords.length });
  } else if (m.type === 'rebase') {
    /* 热重定基：丝滑变速用——不停顿地替换剩余调度（如速度变更后的新时刻表） */
    if (!S.running || S.stop) return;
    S.chords = m.chords || S.chords;
    S.offsetMs = Math.max(0, m.offsetMs || 0);
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    post({ type: 'rebased', t: S.offsetMs / 1000 });
  }
});
