/* ============================================================================
 * 音色资产工具
 *
 * 用法：
 *   node tools/fetch-audio.mjs legacy <老项目audio目录>   把老项目的 a/b 编号音频
 *                                                          按「文件↔音高映射表」迁移为
 *                                                          assets/audio/autopiano/{midi}.mp3
 *   node tools/fetch-audio.mjs download [名称...]          从 gleitz/midi-js-soundfonts
 *                                                          下载音色（默认 grand bright）
 *
 * 目录约定（多音色架构）：assets/audio/<音色id>/48.mp3 … 83.mp3 + manifest.json
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = path.join(ROOT, 'assets', 'audio');

/* 老项目（D:\JOY\异环钢琴模拟er/renderer/renderer.js OCTAVES 表）中提取的映射：
 * 文件编号是 AutoPiano 的内部采样 id，与 MIDI 音高无规律对应，此表为唯一权威。 */
const LEGACY_MAP = {
  48: 'a56.mp3', 49: 'b56.mp3', 50: 'a57.mp3', 51: 'b57.mp3', 52: 'a48.mp3',
  53: 'a81.mp3', 54: 'b81.mp3', 55: 'a87.mp3', 56: 'b87.mp3', 57: 'a69.mp3',
  58: 'b69.mp3', 59: 'a82.mp3',
  60: 'a84.mp3', 61: 'b84.mp3', 62: 'a89.mp3', 63: 'b89.mp3', 64: 'a85.mp3',
  65: 'a73.mp3', 66: 'b73.mp3', 67: 'a79.mp3', 68: 'b79.mp3', 69: 'a80.mp3',
  70: 'b80.mp3', 71: 'a65.mp3',
  72: 'a83.mp3', 73: 'b83.mp3', 74: 'a68.mp3', 75: 'b68.mp3', 76: 'a70.mp3',
  77: 'a71.mp3', 78: 'b71.mp3', 79: 'a72.mp3', 80: 'b72.mp3', 81: 'a74.mp3',
  82: 'b74.mp3', 83: 'a75.mp3',
};

/* 音名（降号）：gleitz 仓库用 Db3.mp3 风格；升号：Salamander（tonejs.github.io）用 "D#3.mp3" */
const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToName = (m, sharp = false) => {
  const names = sharp ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT;
  return names[m % 12] + (Math.floor(m / 12) - 1);
};
const midiToUrl = (m, sharp) => encodeURIComponent(midiToName(m, sharp)) + '.mp3'; // C# → C%23

/* 全音域 A0(21) – C8(108)：超出琴键映射范围的音符用最近采样 + playbackRate 变调，
 * 音高始终忠实于 MIDI（采样密度越高，变调越小） */
const MIDIS = Array.from({ length: 108 - 21 + 1 }, (_, i) => 21 + i);

const SETS = {
  salamander: {
    target: 'salamander', name: '演奏会大钢琴', branch: '',
    dir: '', min: 21, max: 108,
    base: 'https://tonejs.github.io/audio/salamander/', sharp: true,
  },
  grand: {
    target: 'grand', name: '古典钢琴', branch: 'gh-pages',
    dir: 'MusyngKite/acoustic_grand_piano-mp3', min: 21, max: 108,
  },
  bright: {
    target: 'bright', name: '明亮钢琴', branch: 'gh-pages',
    dir: 'FatBoy/acoustic_grand_piano-mp3', min: 21, max: 108,
  },
  upright: {
    target: 'upright', name: '明亮原声钢琴', branch: 'gh-pages',
    dir: 'MusyngKite/bright_acoustic_piano-mp3', min: 21, max: 108,
  },
  epiano: {
    target: 'epiano', name: '电钢琴', branch: 'gh-pages',
    dir: 'MusyngKite/electric_piano_1-mp3', min: 21, max: 108,
  },
  musicbox: {
    target: 'musicbox', name: '八音盒', branch: 'gh-pages',
    dir: 'MusyngKite/music_box-mp3', min: 21, max: 108,
  },
  strings: {
    target: 'strings', name: '弦乐合奏', branch: 'gh-pages',
    dir: 'MusyngKite/string_ensemble_1-mp3', min: 21, max: 108,
  },
  harp: {
    target: 'harp', name: '竖琴', branch: 'gh-pages',
    dir: 'MusyngKite/orchestral_harp-mp3', min: 21, max: 108,
  },
  marimba: {
    target: 'marimba', name: '马林巴', branch: 'gh-pages',
    dir: 'MusyngKite/marimba-mp3', min: 21, max: 108,
  },
  vibraphone: {
    target: 'vibraphone', name: '颤音琴', branch: 'gh-pages',
    dir: 'MusyngKite/vibraphone-mp3', min: 21, max: 108,
  },
  celesta: {
    target: 'celesta', name: '钢片琴', branch: 'gh-pages',
    dir: 'MusyngKite/celesta-mp3', min: 21, max: 108,
  },
  guitar: {
    target: 'guitar', name: '尼龙吉他', branch: 'gh-pages',
    dir: 'MusyngKite/acoustic_guitar_nylon-mp3', min: 21, max: 108,
  },
  flute: {
    target: 'flute', name: '长笛', branch: 'gh-pages',
    dir: 'MusyngKite/flute-mp3', min: 21, max: 108,
  },
  choir: {
    target: 'choir', name: '人声合唱', branch: 'gh-pages',
    dir: 'MusyngKite/choir_aahs-mp3', min: 21, max: 108,
  },
  /* 吉他乐器组（音符从 E 起，与游戏吉他键位对齐：52–87） */
  eguitar_clean: {
    target: 'eguitar_clean', name: '电吉他·清音', branch: 'gh-pages', instr: 'guitar',
    dir: 'MusyngKite/electric_guitar_clean-mp3', min: 52, max: 87,
  },
  eguitar_over: {
    target: 'eguitar_over', name: '电吉他·过载', branch: 'gh-pages', instr: 'guitar',
    dir: 'MusyngKite/overdriven_guitar-mp3', min: 52, max: 87,
  },
  asteel: {
    target: 'asteel', name: '木吉他·钢弦', branch: 'gh-pages', instr: 'guitar',
    dir: 'MusyngKite/acoustic_guitar_steel-mp3', min: 52, max: 108,
  },
};

/* raw.githubusercontent 直连常被墙，依次尝试直连与常见加速代理 */
const PROXIES = ['', 'https://ghfast.top/', 'https://gh-proxy.com/'];

function writeManifest(dir, set) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name: set.name, min: set.min, max: set.max, instr: set.instr || 'piano',
  }, null, 2));
}

function copyLegacy(srcDir) {
  const target = path.join(AUDIO_DIR, 'autopiano');
  fs.mkdirSync(target, { recursive: true });
  let ok = 0;
  for (const [midi, file] of Object.entries(LEGACY_MAP)) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) {
      console.warn(`[缺失] ${file}（MIDI ${midi}）在 ${srcDir} 中不存在`);
      continue;
    }
    fs.copyFileSync(src, path.join(target, `${midi}.mp3`));
    ok++;
  }
  writeManifest(target, { name: 'AutoPiano钢琴', min: 48, max: 83 });
  console.log(`legacy 迁移完成：${ok}/36 → ${target}`);
}

async function fetchWithRetry(url) {
  let lastErr;
  for (const proxy of PROXIES) {
    try {
      const resp = await fetch(proxy + url, { signal: AbortSignal.timeout(25000) });
      if (resp.ok) return Buffer.from(await resp.arrayBuffer());
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function downloadSet(key) {
  const set = SETS[key];
  if (!set) throw new Error(`未知音色集：${key}（可选：${Object.keys(SETS).join(', ')}）`);
  const target = path.join(AUDIO_DIR, set.target);
  fs.mkdirSync(target, { recursive: true });
  const total = set.max - set.min + 1;
  const urlFor = (midi) => set.base
    ? set.base + midiToUrl(midi, set.sharp)
    : `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${set.branch}/${set.dir}/${midiToUrl(midi, false)}`;
  let ok = 0, skip = 0;
  for (const midi of MIDIS) {
    if (midi < set.min || midi > set.max) continue;
    const dest = path.join(target, `${midi}.mp3`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 4000) { skip++; continue; }
    try {
      const buf = await fetchWithRetry(urlFor(midi));
      fs.writeFileSync(dest, buf);
      ok++;
      process.stdout.write(`\r${set.target}: ${ok + skip}/${total}（新下载 ${ok}）`);
    } catch (e) {
      console.warn(`\n[失败] MIDI ${midi}: ${e.message}`);
    }
  }
  console.log(`\n${set.target} 下载完成：${ok + skip}/${total} → ${target}`);
  writeManifest(target, set);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'legacy') copyLegacy(path.resolve(args[0] || '.'));
else if (cmd === 'download') {
  const keys = args.length ? args : ['grand', 'bright'];
  for (const k of keys) await downloadSet(k);
} else {
  console.log('用法：node tools/fetch-audio.mjs legacy <老项目audio目录> | download [grand|bright]');
}
