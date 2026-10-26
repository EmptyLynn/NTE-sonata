/* ============================================================================
 * 网页版构建 —— 仅练习模式的静态站点（GitHub Pages 部署用）
 *
 *  输出 site/：
 *    index.html   → 自动跳转 ./renderer/
 *    renderer/    → 完整前端（打 web-edition 标记，CSS 隐藏演奏模式入口）
 *    assets/      → audio + demo + builtin（曲库种子与音色采样）
 *    .nojekyll    → 关闭 GitHub Pages 的 Jekyll 处理
 *
 *  用法：node tools/build-web.mjs
 *  本地预览：npx serve site  或  node tools/serve.mjs 后访问 /site/renderer/index.html
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'renderer'), { recursive: true });

/* renderer 全量复制 */
for (const f of fs.readdirSync(path.join(ROOT, 'renderer'))) {
  fs.cpSync(path.join(ROOT, 'renderer', f), path.join(OUT, 'renderer', f), { recursive: true });
}
/* 音色采样与内置/演示曲目 */
for (const a of ['audio', 'demo', 'builtin']) {
  fs.cpSync(path.join(ROOT, 'assets', a), path.join(OUT, 'assets', a), { recursive: true });
}

/* 网页版标记：CSP 禁内联脚本，故只注入 CSS（style-src 已放开 unsafe-inline） */
const indexPath = path.join(OUT, 'renderer', 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(
  '</head>',
  `<style>
  /* 网页版：演奏模式依赖 Win32 按键注入，仅桌面版提供 */
  #mode-perf, #perf-panel { display: none !important; }
  /* F8/F9 为桌面版全局热键，网页版无效 */
  .web-hide { display: none !important; }
  .web-badge {
    position: fixed; right: 14px; bottom: 10px; z-index: 9;
    font-size: 11px; letter-spacing: .04em;
    color: rgba(35,38,47,.4); pointer-events: none;
  }
</style>
</head>`,
);
html = html.replace(
  '<span class="hint-chip"><kbd>F8</kbd><em>播放/暂停</em></span>',
  '<span class="hint-chip web-hide"><kbd>F8</kbd><em>播放/暂停</em></span>',
);
html = html.replace(
  '<span class="hint-chip"><kbd>F9</kbd><em>停止</em></span>',
  '<span class="hint-chip web-hide"><kbd>F9</kbd><em>停止</em></span>',
);
html = html.replace(
  '</body>',
  '<span class="web-badge">网页版 · 仅练习模式 · b站 @林羽empty</span>\n</body>',
);
/* 版本号缓存穿透：Pages 的 js/css 有 10 分钟 CDN 缓存，带 ?v= 让每次部署即时生效 */
const VER = 'v1.1.0-' + Math.random().toString(36).slice(2, 8);
html = html.replace(/(src="(js|vendor)\/[^"]+)"/g, `$1?${VER}"`);
html = html.replace(/(href="css\/[^"]+)"/g, `$1?${VER}"`);
fs.writeFileSync(indexPath, html);

/* 教程适配：不自动弹出（首步提及演奏模式/F8/F9 为桌面专属，顶栏「?」仍可手动查看） */
const tourPath = path.join(OUT, 'renderer', 'js', 'tour.js');
let tour = fs.readFileSync(tourPath, 'utf8');
tour = tour.replace(
  `  maybeAuto(key) {
    if (this.done[key]) return false;
    this.start(key, false);
    return true;
  },`,
  `  maybeAuto(key) {
    return false; /* 网页版：教程不自动弹出，顶栏「?」可手动查看 */
  },`,
);
tour = tour.replace(
  '\\n🎮 演奏模式：把按键发给游戏窗口，在《异环》里自动弹琴（切过去会有单独的引导）。',
  '\\n（网页版仅提供练习模式。）',
);
tour = tour.replace(
  '\\n全局热键：F8 播放/暂停，F9 停止（窗口失焦也有效）；Esc 紧急静音。',
  '\\n（网页版无全局热键，请点按钮控制。）',
);
fs.writeFileSync(tourPath, tour);

/* 入口跳转页 + 关闭 Jekyll */
fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>异环乐器模拟器 · 练习模式</title>
  <meta http-equiv="refresh" content="0;url=./renderer/">
  <style>body{font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;background:#eef0f4;display:grid;place-items:center;height:100vh;margin:0;color:#2c3040}</style>
</head>
<body>
  <a href="./renderer/" style="font-size:18px">进入 异环乐器模拟器（练习模式）→</a>
</body>
</html>
`,
);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const count = (dir) => {
  let n = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    n += f.isDirectory() ? count(path.join(dir, f.name)) : 1;
  }
  return n;
};
console.log(`网页版已生成: site/（renderer ${count(path.join(OUT, 'renderer'))} 文件, assets ${count(path.join(OUT, 'assets'))} 文件）`);
