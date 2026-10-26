/* ============================================================================
 * 演奏模式 FFI 公共层 —— 主进程与 worker 共用
 *
 *  窗口捕获（对异环/UE 引擎的适配）：
 *   · MaaNTE 实证的游戏窗口标题为 "NTE  " / "异环  "（尾部双空格）；
 *   · 异环是 UE 游戏，主窗口类名 UnrealWindow —— 自动检测优先
 *     "标题含异环/NTE 且类名为 UnrealWindow" 的窗口，其次按标题匹配；
 *   · 激活消息用 SendMessageTimeoutW（50ms 超时），避免游戏忙时阻塞调用线程。
 *
 *  按键注入（MaaNTE 同款）：
 *   · 专用左 Shift(0xA0)/左 Ctrl(0xA2)；lParam = repeat1 | 扫描码<<16，
 *     keyup 加 0xC0000000 —— 以无符号 32 位零扩展传入（与 Python ctypes 一致）。
 * ==========================================================================*/
const koffi = require('koffi');

const u32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const shell32 = koffi.load('shell32.dll');
const ShellExecuteW = shell32.func('ShellExecuteW', 'int64',
  ['int64', 'str16', 'str16', 'str16', 'str16', 'int32']);
const F = {
  GetDesktopWindow: u32.func('GetDesktopWindow', 'int64', []),
  GetTopWindow: u32.func('GetTopWindow', 'int64', ['int64']),
  GetWindow: u32.func('GetWindow', 'int64', ['int64', 'uint32']),
  GetWindowTextW: u32.func('GetWindowTextW', 'int32', ['int64', 'void *', 'int32']),
  GetClassNameW: u32.func('GetClassNameW', 'int32', ['int64', 'void *', 'int32']),
  IsWindowVisible: u32.func('IsWindowVisible', 'int32', ['int64']),
  IsWindow: u32.func('IsWindow', 'int32', ['int64']),
  IsIconic: u32.func('IsIconic', 'int32', ['int64']),
  FindWindowW: u32.func('FindWindowW', 'int64', ['str', 'str']),
  PostMessageW: u32.func('PostMessageW', 'int32', ['int64', 'uint32', 'uint64', 'int64']),
  SendMessageTimeoutW: u32.func('SendMessageTimeoutW', 'int64',
    ['int64', 'uint32', 'uint64', 'int64', 'uint32', 'uint32', 'void *']),
  MapVirtualKeyW: u32.func('MapVirtualKeyW', 'uint32', ['uint32', 'uint32']),
  keybd_event: u32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uint64']),
  SetForegroundWindow: u32.func('SetForegroundWindow', 'int32', ['int64']),
  GetForegroundWindow: u32.func('GetForegroundWindow', 'int64', []),
  GetWindowThreadProcessId: u32.func('GetWindowThreadProcessId', 'uint32', ['int64', 'void *']),
  /* 权限检测（UIPI：低权限进程无法向管理员进程发消息） */
  GetCurrentProcess: kernel32.func('GetCurrentProcess', 'void *', []),
  OpenProcess: kernel32.func('OpenProcess', 'void *', ['uint32', 'int32', 'uint32']),
  CloseHandle: kernel32.func('CloseHandle', 'int32', ['void *']),
  OpenProcessToken: advapi32.func('OpenProcessToken', 'int32', ['void *', 'uint32', 'void *']),
  GetTokenInformation: advapi32.func('GetTokenInformation', 'int32',
    ['void *', 'int32', 'void *', 'uint32', 'void *']),
};
const TOKEN_QUERY = 0x8;
const TokenElevation = 20;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_ACTIVATE = 0x0006, WA_CLICKACTIVE = 2;
const SMTO_NORMAL = 0;
const VK = {
  shift: 0xa0, ctrl: 0xa2, // VK_LSHIFT / VK_LCTRL（专用左修饰键，防跑调）
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  /* 吉他扩展键位 */
  '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35,
  '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39, '0': 0x30,
  '-': 0xbd, '=': 0xbb,
  '[': 0xdb, ']': 0xdd,
  ';': 0xba, "'": 0xde,
  enter: 0x0d,
};

const _titleBuf = koffi.alloc('char16', 1024);
const _classBuf = koffi.alloc('char16', 512);
const _resultBuf = koffi.alloc('int64', 1);

const GAME_TITLES = ['NTE  ', '异环  ']; /* MaaNTE 实证：尾部双空格 */
const isGameTitle = (t) => {
  const s = String(t).trim().toLowerCase();
  return s === 'nte' || s === '异环' || s.startsWith('nte ') || s.startsWith('异环 ');
};

/* ---------------- 窗口枚举与识别 ---------------- */
function windowInfo(h) {
  const nT = F.GetWindowTextW(h, _titleBuf, 500);
  const nC = F.GetClassNameW(h, _classBuf, 250);
  return {
    hwnd: Number(h),
    title: nT > 0 ? String(koffi.decode(_titleBuf, 'char16', nT)) : '',
    className: nC > 0 ? String(koffi.decode(_classBuf, 'char16', nC)) : '',
  };
}

function listWindows() {
  const out = [];
  let h = F.GetTopWindow(F.GetDesktopWindow());
  let guard = 0;
  while (h !== 0 && guard++ < 5000) {
    if (F.IsWindowVisible(h)) {
      const info = windowInfo(h);
      if (info.title) out.push(info);
    }
    h = F.GetWindow(h, 2 /* GW_HWNDNEXT */);
  }
  return out;
}

/* 自动检测：优先 UE 主窗口（标题匹配 + UnrealWindow 类名），其次精确标题，再次标题前缀 */
function findGameWindow() {
  for (const t of GAME_TITLES) {
    const h = F.FindWindowW(null, t);
    if (h) return Number(h);
  }
  const wins = listWindows().filter((w) => isGameTitle(w.title));
  if (!wins.length) return 0;
  const ue = wins.find((w) => /unreal/i.test(w.className));
  return (ue || wins[0]).hwnd;
}

/* ---------------- 按键注入 ---------------- */
function keyLparam(vk, isDown) {
  let lp = 1 | (F.MapVirtualKeyW(vk, 0) << 16);
  if (!isDown) lp = (lp | 0xc0000000) >>> 0; /* 无符号 32 位，零扩展传入 */
  return lp;
}

function postKey(hwnd, vk, isDown, mode) {
  if (mode === 'fg') {
    F.keybd_event(vk, F.MapVirtualKeyW(vk, 0), isDown ? 0 : 2, 0);
    return 1;
  }
  /* PostMessageW 返回非 0 = 已入队 */
  return F.PostMessageW(hwnd, isDown ? WM_KEYDOWN : WM_KEYUP,
    BigInt(vk), BigInt(keyLparam(vk, isDown)));
}

/* 前台切换：仅做一次无害的 SetForegroundWindow 尝试。
 * 绝不使用 ALT 键技巧（真实输入会触发本应用菜单栏抽搐、窗口状态异常）
 * 或 AttachThreadInput（跨线程附加在边界情况下会导致窗口被最小化/还原）。
 * 前台模式是否就位由用户保证（倒计时弹窗引导），失焦自动停止兜底。 */
function forceForeground(hwnd) {
  try { F.SetForegroundWindow(hwnd); } catch { /* ignore */ }
  return F.GetForegroundWindow() === hwnd;
}

/* 修饰键分组短按（MaaNTE _press_group 同款时序）；sleep 由调用方提供 */
function pressGroup(hwnd, keys, modifier, holdMs, mode, sleep) {
  if (!keys.length) return;
  if (modifier) {
    postKey(hwnd, VK[modifier], true, mode);
    sleep(2);
  }
  for (const k of keys) postKey(hwnd, VK[k], true, mode);
  if (holdMs > 0) sleep(holdMs);
  for (let i = keys.length - 1; i >= 0; i--) postKey(hwnd, VK[keys[i]], false, mode);
  if (modifier) {
    sleep(1);
    postKey(hwnd, VK[modifier], false, mode);
  }
}

/* 激活欺骗：让后台游戏以为自己是活动窗口（50ms 超时，防游戏忙时卡住调用线程） */
function spoofActivate(hwnd) {
  F.SendMessageTimeoutW(hwnd, WM_ACTIVATE, BigInt(WA_CLICKACTIVE), 0n, SMTO_NORMAL, 50, _resultBuf);
}

/* 执行和弦：keys = ['z' | 'shift+z' | 'ctrl+v' ...] */
function executeChord(hwnd, keys, holdMs, mode, sleep) {
  if (mode === 'bg') {
    spoofActivate(hwnd);
  }
  const normal = [], shift = [], ctrl = [];
  for (const spec of keys) {
    const [mod, key] = spec.includes('+') ? spec.split('+') : [null, spec];
    if (mod === 'shift') shift.push(key);
    else if (mod === 'ctrl') ctrl.push(key);
    else normal.push(key);
  }
  pressGroup(hwnd, normal, null, holdMs, mode, sleep);
  pressGroup(hwnd, shift, 'shift', holdMs, mode, sleep);
  pressGroup(hwnd, ctrl, 'ctrl', holdMs, mode, sleep);
}

/* ---------------- 权限检测（UIPI） ---------------- */
const _tokenBuf = koffi.alloc('void *', 1);
const _elevBuf = koffi.alloc('int32', 1);
const _retLenBuf = koffi.alloc('uint32', 1);

/* 本进程是否以管理员（提升）运行 */
function isElevated() {
  try {
    if (!F.OpenProcessToken(F.GetCurrentProcess(), TOKEN_QUERY, _tokenBuf)) return false;
    const token = koffi.decode(_tokenBuf, 'void *');
    const ok = F.GetTokenInformation(token, TokenElevation, _elevBuf, 4, _retLenBuf);
    F.CloseHandle(token);
    return !!ok && koffi.decode(_elevBuf, 'int32') !== 0;
  } catch {
    return false;
  }
}

/* 目标窗口所属进程是否以管理员运行（OpenProcess 失败 = 权限不足 = 目标更高权限） */
function isTargetElevated(hwnd) {
  const pidBuf = koffi.alloc('uint32', 1);
  F.GetWindowThreadProcessId(Number(hwnd), pidBuf);
  const pid = koffi.decode(pidBuf, 'uint32');
  if (!pid) return false;
  const h = F.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (h) { F.CloseHandle(h); return false; }
  return true; /* 打不开：目标进程权限高于本进程（管理员） */
}

/* ---------------- 诊断 ---------------- */
function diagnose(hwnd) {
  const h = Number(hwnd);
  const out = { hwnd: h, isWindow: !!F.IsWindow(h), selfElevated: isElevated() };
  if (!out.isWindow) return out;
  const info = windowInfo(h);
  out.title = info.title;
  out.className = info.className;
  out.visible = !!F.IsWindowVisible(h);
  out.minimized = !!F.IsIconic(h);
  const fg = F.GetForegroundWindow();
  out.foregroundTitle = fg ? windowInfo(fg).title : '';
  out.isForeground = Number(fg) === h;
  out.targetElevated = isTargetElevated(h);
  /* 试发一个 Z 键down/up，返回 PostMessage 结果（非 0 = 已投递到目标队列） */
  out.testKeyDown = F.PostMessageW(h, WM_KEYDOWN, BigInt(VK.z), BigInt(keyLparam(VK.z, true)));
  out.testKeyUp = F.PostMessageW(h, WM_KEYUP, BigInt(VK.z), BigInt(keyLparam(VK.z, false)));
  const advice = [];
  if (out.targetElevated && !out.selfElevated) {
    advice.push('目标进程以管理员运行，而本应用是普通权限——Windows 会拦截低权限进程的按键消息（UIPI），请点「以管理员重启」');
  }
  if (out.minimized) advice.push('目标窗口处于最小化状态——请恢复窗口（后台注入也需要窗口非最小化）');
  if (!out.visible) advice.push('目标窗口不可见');
  if (!/unreal/i.test(info.className) && isGameTitle(info.title)) {
    advice.push(`窗口类名不是 UnrealWindow（实际: ${info.className || '?'}），可能选到了游戏的启动器/子窗口，请在下拉框选择类名为 UnrealWindow 的窗口`);
  }
  if (!out.testKeyDown) advice.push('PostMessage 投递失败（窗口可能已销毁或拒绝消息）');
  if (!advice.length) advice.push('窗口状态正常；若游戏仍无反应，请尝试：前台模拟模式 / 确认游戏内钢琴界面已打开 / 稍增按键时长');
  out.advice = advice;
  return out;
}

/* 以管理员身份运行程序（ShellExecuteW 'runas' 触发 UAC，比 PowerShell 可靠） */
function runAsAdmin(exe, args, dir) {
  const r = Number(ShellExecuteW(0, 'runas', exe, args || '', dir || '', 1 /* SW_SHOWNORMAL */));
  return r > 32; /* >32 = 成功 */
}

module.exports = {
  F, VK, WM_KEYDOWN, WM_KEYUP,
  listWindows, findGameWindow, isGameTitle,
  keyLparam, postKey, executeChord, forceForeground, diagnose, spoofActivate,
  isElevated, isTargetElevated, runAsAdmin,
};
