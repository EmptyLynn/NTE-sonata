/* 多维度测试 MIDI 生成器
 * 每个段落针对一个已知的潜在问题维度，段落间留 0.5s 静默便于分辨。
 * 输出: D:\多维测试.mid（Type 0 / 单轨 / 480 ticks per beat / 120 BPM）
 * 用法: node tools/gen-test-midi.js
 */
const fs = require('fs');

const PPQ = 480;                 // ticks per beat
const SEC_TO_TICKS = 1920;       // 120 BPM → 1 beat = 0.5s → 1s = 1920 ticks
const VEL = 100;

const events = [];              // { tick, type: 'on'|'off', midi, vel }
let cursor = 0;                 // 秒

function note(t, midi, dur, vel = VEL) {
  events.push({ tick: Math.round((cursor + t) * SEC_TO_TICKS), type: 'on', midi, vel });
  events.push({ tick: Math.round((cursor + t + dur) * SEC_TO_TICKS), type: 'off', midi });
}

function rest(sec) { cursor += sec; }

/* ── 段1: 半音+全音同和弦（同字母冲突对：b/shift+b、v/shift+v、n/ctrl+m）── */
note(0.0, 55, 0.4); note(0.0, 56, 0.4);          // G3 + G#3（同字母 b）
note(0.5, 53, 0.4); note(0.5, 54, 0.4);          // F3 + F#3（同字母 v）
note(1.0, 57, 0.4); note(1.0, 58, 0.4);          // A3 + A#3（同字母 n，Ctrl 变化）
note(1.5, 51, 0.4); note(1.5, 52, 0.4);          // D#3 + D3（同字母 x，Ctrl 变化）
note(2.0, 55, 0.4); note(2.0, 56, 0.4); note(2.0, 59, 0.4);   // G3+G#3+B3 三音混合
note(2.5, 53, 0.4); note(2.5, 54, 0.4); note(2.5, 50, 0.4);   // F3+F#3+D3
rest(3.2);

/* ── 段2: 半音颤音（快速交替，修饰键频繁切换）── */
for (let i = 0; i < 16; i++) note(i * 0.125, 60 + (i % 2), 0.11);   // C4/C#4 交替
rest(2.4);
for (let i = 0; i < 16; i++) note(i * 0.125, 53 + (i % 2) * 3, 0.11); // F3/G3 大二度交替（无修饰键对照）
rest(2.4);

/* ── 段3: 快速重复音（同键连击，回声条/重击验证）── */
for (let i = 0; i < 10; i++) note(i * 0.1, 60, 0.07);               // C4 ×10 @100ms
rest(1.2);
for (let i = 0; i < 10; i++) note(i * 0.1, 55, 0.07);               // G3 ×10
rest(1.2);

/* ── 段4: 长音+短音叠加（保持中的键被其他音覆盖）── */
note(0.0, 48, 2.0);                              // C3 长按 2s
for (let i = 0; i < 6; i++) note(0.1 + i * 0.3, 64 + (i % 3) * 2, 0.15); // E4/F#4/G#4 短音叠加
rest(2.3);
note(0.0, 55, 1.5);                              // G3 长按
for (let i = 0; i < 4; i++) note(0.2 + i * 0.3, 60 + i, 0.12);           // C4.. 叠加
rest(2.0);

/* ── 段5: 音区边界与八度折叠（47 折到 59、84 折到 72）── */
note(0.0, 48, 0.3);   // C3 下边界（不折叠）
note(0.35, 47, 0.3);  // B2 → 折叠 +12 → B3
note(0.7, 46, 0.3);   // A#2 → 折叠 → A#3
note(1.05, 83, 0.3);  // B5 上边界（不折叠）
note(1.4, 84, 0.3);   // C6 → 折叠 -12 → C5
note(1.75, 86, 0.3);  // D6 → 折叠 → D5
note(2.1, 45, 0.3);   // A2 → 折叠 → A3
note(2.45, 88, 0.3);  // E6 → 折叠 → E5
rest(3.0);

/* ── 段6: 密集和弦（时序/利落度）── */
for (let i = 0; i < 8; i++) {
  const base = 48 + (i % 12);
  note(i * 0.15, base, 0.12);
  note(i * 0.15, base + 4, 0.12);
  note(i * 0.15, base + 7, 0.12);                // 三和弦每 150ms
}
rest(1.6);
for (let i = 0; i < 6; i++) {
  const base = 55 + (i % 5) * 2;
  note(i * 0.125, base, 0.1);
  note(i * 0.125, base + 3, 0.1);                // 含半音的双音每 125ms
}
rest(1.2);

/* ── 段7: 延音踏板（CC64：音符关闭延迟到踏板抬起）── */
events.push({ tick: Math.round(cursor * SEC_TO_TICKS), type: 'cc64', value: 127 });
note(0.0, 60, 0.2); note(0.25, 64, 0.2); note(0.5, 67, 0.2);   // 琶音（踏板延音中）
events.push({ tick: Math.round((cursor + 1.2) * SEC_TO_TICKS), type: 'cc64', value: 0 }); // 抬板 → 音符关闭
rest(1.8);

/* ── 段8: 半音阶全音域扫弦（48→83 全键位覆盖）── */
for (let m = 48; m <= 83; m++) note((m - 48) * 0.06, m, 0.05);  // 每 60ms 半音上行
rest(2.0);

/* ── 编码为 MIDI ── */
events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1) - (b.type === 'off' ? -1 : 1));

const track = [];
function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}
// tempo meta @0
track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 500000 = 120bpm
// CC64 初始为 0
let lastTick = 0, prevCC = -1;
for (const ev of events) {
  const delta = ev.tick - lastTick;
  track.push(...vlq(delta));
  lastTick = ev.tick;
  if (ev.type === 'on') track.push(0x90, ev.midi, ev.vel);
  else if (ev.type === 'off') track.push(0x80, ev.midi, 0);
  else if (ev.type === 'cc64') {
    if (prevCC !== -1) track.push(...vlq(0)); // 与前一事件同 tick 的分隔由 delta 处理
    track.push(0xb0, 64, ev.value);
    prevCC = ev.value;
  }
}
track.push(...vlq(480), 0xff, 0x2f, 0x00); // 1 拍后结束

const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
const trackLen = track.length;
const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff];

const midi = Buffer.from([...header, ...trackHeader, ...track]);
fs.writeFileSync('D:/多维测试.mid', midi);
console.log('生成: D:/多维测试.mid (' + midi.length + ' 字节, ' + events.length + ' 事件, 约 ' + Math.round(cursor + 2) + 's)');
