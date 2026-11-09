# 异环乐器模拟器

给《异环》(NTE) 做的乐器模拟器：一个三排 36 键的虚拟键盘，可以自己弹，也可以让 MIDI 文件替你弹。

- **练习模式**：在软件里弹琴、听 MIDI，瀑布流落音可视化，不需要开游戏。
- **演奏模式**：把 MIDI 谱面转换成真实按键发进游戏窗口，游戏里的钢琴就会自己响。

网页版（仅练习模式，无需安装）：**[emptylynn.github.io/NTE-sonata](https://emptylynn.github.io/NTE-sonata/)**

桌面版由 Electron 33 + Web Audio + koffi (Win32 FFI) 实现，离线运行。作者：b站 [@林羽empty](https://space.bilibili.com/394318685)

---

## 键位

游戏里的钢琴是三排 36 键，变化音靠 Shift / Ctrl 组合，本软件完全照搬这套规则：

| 音区 | 自然音 | 升半音 (Shift) | 降半音 (Ctrl) |
|---|---|---|---|
| 低音 | `Z X C V B N M` | `Shift+Z / V / B` | `Ctrl+C / M` |
| 中音 | `A S D F G H J` | `Shift+A / F / G` | `Ctrl+D / J` |
| 高音 | `Q W E R T Y U` | `Shift+Q / R / T` | `Ctrl+E / U` |

鼠标点击琴键也能弹，按住 Shift / Ctrl 点击对应位置可触发变化音。`Esc` 一键静音。

音域 C3 – B5（MIDI 48–83），吉他模式 36 音域（E3 – A6 映射）。

## 调性与转调对照

不移调时谱子什么调就弹什么调（36 键半音齐全，任何调都是对的）。想移调的两个常见理由：让旋律落在自然音位（简谱不带升降号，更好弹）；音域溢出 36 键时把旋律拉回范围内。

规则一句话：**大调把主音移到 C，小调把主音移到 A**。转调值 = 主音到目标的距离取负，两个方向等价（差一个八度），选绝对值小的即可。

大调（主音 → C）：

| 原调 | 转调 | 或 | 原调 | 转调 | 或 |
|---|---|---|---|---|---|
| C | 0 | — | G | −7 | +5 |
| C#/Db | −1 | +11 | Ab | −8 | +4 |
| D | −2 | +10 | A | −9 | +3 |
| Eb | −3 | +9 | Bb | −10 | +2 |
| E | −4 | +8 | B | −11 | +1 |
| F | −5 | +7 | | | |
| F#/Gb | −6 | +6 | | | |

小调（主音 → A）：

| 原调 | 转调 | 或 | 原调 | 转调 | 或 |
|---|---|---|---|---|---|
| Am | 0 | — | Em | −7 | +5 |
| Bbm | −1 | +11 | Fm | −8 | +4 |
| Bm | −2 | +10 | F#m | −9 | +3 |
| Cm | −3 | +9 | Gm | −10 | +2 |
| C#m | −4 | +8 | G#m | −11 | +1 |
| Dm | −5 | +7 | | | |
| Ebm | −6 | +6 | | | |

曲库卡片会自动标注调性（优先读 MIDI 调号，缺失时分析音级分布推断），照表查即可。转调后溢出的音符交给超域处理（fold / shift）。

## 练习模式

- 打开 `.mid / .midi / .rmi` 文件自动演奏，支持调速（0.25–3×）、转调、选轨、八度折叠/平移；
- 音色 13 套（钢琴、电钢、竖琴、马林巴、长笛等），全音域采样，超高音区用变调补偿保住音准；
- 瀑布流可视化 + 触底粒子 + 简谱标注条，回声条会把你自己弹的音也画出来；
- 曲库收藏：导入的 MIDI 自动存进曲库，支持分类标签和排序；
- 跟弹教学（实验性）：等待模式下琴键提示"现在按什么"，按对变绿。

## 演奏模式

把 MIDI 弹进游戏窗口，两种注入方式：

- **后台注入**（默认）：按键消息直接发给游戏窗口，弹琴时你可以干别的；
- **前台模拟**：真实键盘输入，兼容性兜底。

按键细节对齐了 MaaNTE 的实证方案：区分左右修饰键、带硬件扫描码、和弦按修饰键分组错开按下，避免同键冲突和跑调。演奏中可以拖进度条、调速度，暂停续弹都不断音。

> 使用步骤：窗口化打开游戏 → 切到演奏模式 → 选窗口 → 点「测试按键」确认游戏能响 → 播放。
>
> ⚠️ 游戏自动化可能违反用户协议，请自行评估风险；本工具仅供学习交流。

## 下载

到 [Releases](https://github.com/EmptyLynn/NTE-sonata/releases) 下载，两种形态：

- `YihuanInstrument-Setup-x.x.x.exe` — 安装包；
- 绿色版 zip — 解压即用。

未签名 exe 首次运行会弹 SmartScreen，点「更多信息 → 仍要运行」。游戏若以管理员运行，软件也需要提权（面板里有一键重启）。

## 本地运行

依赖 Node.js ≥ 18：

```bash
npm install
npm start          # 启动桌面版
npm run web        # 浏览器模式（仅练习模式）
```

打包：

```bash
npm run dist:dir   # 绿色版 → dist12/win-unpacked/
npm run dist       # 安装包 → dist12/
```

加新音色：把逐键采样 mp3（按 MIDI 音高命名，如 `48.mp3`）放进 `assets/audio/<音色id>/`，再写一个 `manifest.json`（`{"name":"显示名","min":21,"max":108}`），重启即出现在音色列表。

网页版部署：`node tools/build-web.mjs` 生成 `site/`，推到 gh-pages 分支即可。

## 致谢

- 音色采样：[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)（MusyngKite / FatBoy，仅供学习交流）
- MIDI 解析：[@tonejs/midi](https://github.com/Tonejs/Midi)
- 演奏模式按键方案参考：[MaaNTE](https://github.com/) 的 auto_piano
- 可视化形态参考：Synthesia 及开源同类 [Neothesia](https://github.com/PolyMeilex/Neothesia)、[SpessaSynth](https://github.com/spessasus/SpessaSynth)
