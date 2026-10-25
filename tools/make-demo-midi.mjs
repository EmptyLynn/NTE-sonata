/* ============================================================================
 * 生成 demo MIDI（纯手写 SMF 字节，零依赖）
 *   node tools/make-demo-midi.mjs
 * 产物：
 *   assets/demo/demo1_小星星_单轨.mid   —— 单轨主旋律，验证基础播放/进度/变速
 *   assets/demo/demo2_卡农片段_双轨.mid —— 双轨（旋律+贝斯），验证 melody 自动选轨
 *   assets/demo/demo3_超宽音域.mid      —— C2–C7 全跨度，验证 fold/shift/cut 超域处理
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = path.join(ROOT, 'assets', 'demo');

/* ---------------- SMF 编码 ---------------- */
const varLen = (n) => {
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
};
const u32 = (n) => [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const chunk = (type, payload) => [...type].map((c) => c.charCodeAt(0)).concat(u32(payload.length), payload);

function trackBytes({ notes, program = 0, channel = 0, name = '', ccs = [] }) {
  const evs = [];
  if (name) {
    const utf8 = [...new TextEncoder().encode(name)];
    evs.push({ t: 0, bytes: [0xff, 0x03, utf8.length, ...utf8] });
  }
  evs.push({ t: 0, bytes: [0xc0 | channel, program] });
  for (const n of notes) {
    evs.push({ t: n.start, bytes: [0x90 | channel, n.midi, n.vel ?? 90] });
    evs.push({ t: n.start + n.dur, bytes: [0x80 | channel, n.midi, 0] });
  }
  for (const cc of ccs) {
    evs.push({ t: cc.t, bytes: [0xb0 | channel, cc.controller, cc.value] });
  }
  evs.sort((a, b) => a.t - b.t);
  const out = [];
  let prev = 0;
  for (const e of evs) {
    out.push(...varLen(Math.round(e.t - prev)), ...e.bytes);
    prev = e.t;
  }
  out.push(...varLen(0), 0xff, 0x2f, 0x00);
  return out;
}

function writeMidi(file, { bpm = 120, tracks }) {
  const ppq = 480;
  const usPerBeat = Math.round(60000000 / bpm);
  const header = chunk('MThd', [...u16(1), ...u16(tracks.length + 1), ...u16(ppq)]); // +1 为 tempo 轨
  const tempoTrack = chunk('MTrk', [...varLen(0), 0xff, 0x51, 0x03, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255, ...varLen(0), 0xff, 0x2f, 0x00]);
  const body = tracks.map((t) => chunk('MTrk', trackBytes(t)));
  fs.writeFileSync(path.join(DEMO_DIR, file), Buffer.from([...header, ...tempoTrack, ...body.flat()]));
  console.log('生成', file);
}

/* ---------------- 曲目 ---------------- */
const q = (b) => b * 480; // 拍 → tick

/* 小星星：C C G G A A G | F F E E D D C，单轨 */
{
  const seq = [
    [60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2],
    [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2],
    [67, 1], [67, 1], [65, 1], [65, 1], [64, 1], [64, 1], [62, 2],
    [67, 1], [67, 1], [65, 1], [65, 1], [64, 1], [64, 1], [62, 2],
    [60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2],
    [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2],
  ];
  let t = 0;
  const notes = seq.map(([m, d]) => ({ midi: m, start: q(t), dur: q(d) * 0.9, vel: 100, t: (t += d) - d }));
  writeMidi('demo1_小星星_单轨.mid', { bpm: 120, tracks: [{ name: '主旋律', channel: 0, program: 0, notes }] });
}

/* 卡农片段：旋律轨音符多（channel0），贝斯轨音符少（channel1）→ melody 自动选轨应选旋律 */
{
  // D 大调卡农和声进行，每小节一个和弦：D A Bm F#m G D G A
  const chords = [
    [62, 66, 69], [57, 61, 64], [59, 62, 66], [54, 57, 61],
    [55, 59, 62], [50, 54, 57], [55, 59, 62], [57, 61, 64],
  ];
  const melodyNotes = [];
  chords.forEach((ch, i) => {
    const [a, b, c] = ch.map((m) => m + 12); // 高八度
    melodyNotes.push({ midi: a + 12, start: q(i * 2), dur: q(0.5), vel: 100 });
    melodyNotes.push({ midi: b + 12, start: q(i * 2 + 0.5), dur: q(0.5), vel: 95 });
    melodyNotes.push({ midi: c + 12, start: q(i * 2 + 1), dur: q(0.5), vel: 95 });
    melodyNotes.push({ midi: b + 12, start: q(i * 2 + 1.5), dur: q(0.5), vel: 90 });
  });
  const bassNotes = chords.map((ch, i) => ({ midi: ch[0] - 12, start: q(i * 2), dur: q(2) * 0.95, vel: 80 }));
  writeMidi('demo2_卡农片段_双轨.mid', {
    bpm: 110,
    tracks: [
      { name: '主旋律', channel: 0, program: 0, notes: melodyNotes },
      { name: '贝斯', channel: 1, program: 33, notes: bassNotes },
    ],
  });
}

/* 超宽音域：C2(36) 到 C7(96) 爬音阶 + 低音持续 → 三种超域模式都有明显效果 */
{
  const notes = [];
  const scale = [0, 2, 4, 5, 7, 9, 11];
  let t = 0;
  for (let m = 36; m <= 96; m += 12) {
    for (const s of scale) {
      notes.push({ midi: m + s, start: q(t), dur: q(0.5), vel: 90 });
      t += 0.5;
    }
  }
  // 末尾低音持续 + 高音柱式和弦（超出 48–83）
  notes.push({ midi: 36, start: q(t), dur: q(4), vel: 95 });
  [84, 88, 91, 96].forEach((m, i) => notes.push({ midi: m, start: q(t + i * 0.5), dur: q(1), vel: 95 }));
  notes.push({ midi: 48, start: q(t), dur: q(4), vel: 85 });
  writeMidi('demo3_超宽音域.mid', { bpm: 140, tracks: [{ name: '全跨度', channel: 0, program: 0, notes }] });
}

/* 延音踏板测试：断奏短音符 + CC64 长踏板 → 自动演奏时应听到踏板延长的连奏 */
{
  const notes = [60, 64, 67, 72, 76, 79, 84].map((m, i) => ({
    midi: m, start: q(i), dur: q(0.25), vel: 95, // 每音只按 1/4 拍就松手
  }));
  const ccs = [
    { t: q(0), controller: 64, value: 127 },  // 踩下踏板
    { t: q(8), controller: 64, value: 0 },    // 8 拍后抬板（注意：ccs 的 t 单位是 tick）
  ];
  writeMidi('demo4_延音踏板.mid', {
    bpm: 100,
    tracks: [{ name: '踏板测试', channel: 0, program: 0, notes, ccs }],
  });
}

/* 同步生成浏览器模式的音色索引（Electron 走主进程 IPC 自动扫描，不依赖此文件） */
const AUDIO_DIR = path.join(ROOT, 'assets', 'audio');
const instruments = fs.readdirSync(AUDIO_DIR).flatMap((dir) => {
  const full = path.join(AUDIO_DIR, dir);
  if (!fs.statSync(full).isDirectory()) return [];
  const mp3s = fs.readdirSync(full).filter((f) => f.endsWith('.mp3')).map((f) => parseInt(f, 10)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (!mp3s.length) return [];
  let meta = { name: dir, min: mp3s[0], max: mp3s[mp3s.length - 1] };
  try {
    meta = { ...meta, ...JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')) };
  } catch { }
  return [{ id: dir, name: meta.name, samples: mp3s.length, min: meta.min, max: meta.max }];
});
fs.writeFileSync(path.join(AUDIO_DIR, 'instruments.json'), JSON.stringify(instruments, null, 2));
console.log('instruments.json:', instruments.map((i) => `${i.id}(${i.name},${i.samples}音 ${i.min}-${i.max})`).join(' / '));
