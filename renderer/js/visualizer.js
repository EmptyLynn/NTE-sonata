/* ============================================================================
 * 瀑布流可视化 —— Synthesia 式落音，替代实时日志的"观赏性"面板
 *
 *  · 36 条车道按 低音｜中音｜高音 三组分列（组内顺序与琴键行一致）；
 *    自然音车道为亮色、半音车道为暗色墨条——自动演奏的半音一目了然；
 *  · 音符按轨道着色（主旋律 = 玫瑰红），velocity 影响透明度；
 *  · 音符触底瞬间：粒子迸发 + 车道闪光，对应琴键同步点亮；
 *  · 手动演奏同样触发粒子（无 MIDI 也有观赏反馈）。
 * ==========================================================================*/
const Viz = {
  canvas: null,
  ctx: null,
  dpr: 1,
  W: 0, H: 0,
  particles: [],
  flashes: [],
  presses: [], /* 回声条记录：{ midi, born, releasedAt, color }（Keyboard 漏斗写入） */
  echoColor: '#39b98c',
  lastNow: -1,
  _laneLabelY: new Map(), /* 教学标签去堆叠：车道 → 上个标签的 yBottom */
  PAL: ['#e9576e', '#4f7cf0', '#39b98c', '#f0a635', '#9b6ef3', '#38b6c9', '#e07b9a', '#7f95c9'],
  MELODY: '#e9576e',
  accentRGB: [233, 87, 110], /* 随主题色更新（ui.applyAccent） */
  particlesEnabled: true,    /* 设置面板可关：关闭后瀑布流不再迸发粒子 */
  echoRainbow: false,        /* 炫彩回声：开启时忽略 echoColor */

  accentRGBA(a) {
    const c = this.accentRGB;
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.min(1, a).toFixed(3) + ')';
  },

  /* 炫彩回声：色相随时间流转 + 音高偏移，低音暖高音冷 */
  rainbowColor(midi) {
    const hue = ((Date.now() / 28) + midi * 2.4) % 360;
    return 'hsl(' + hue.toFixed(0) + ', 80%, 62%)';
  },

  noteOn(midi, color) {
    if (this.presses.some((p) => p.midi === midi && p.releasedAt == null)) return; /* 同键去重 */
    const c = color || (this.echoRainbow ? this.rainbowColor(midi) : (this.echoColor || this.MELODY));
    this.presses.push({ midi, born: performance.now(), releasedAt: null, color: c });
  },

  SOLFEGE: ['1', '#1', '2', '♭3', '3', '4', '#4', '5', '#5', '6', '♭7', '7'],
  FONT: '"Segoe UI", "Microsoft YaHei UI", sans-serif',

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const resize = () => this._resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas.parentElement);
    window.addEventListener('resize', resize);
    this._resize();
  },

  _resize() {
    if (!this.canvas) return;
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(Math.max(320, r.width - 24));
    const h = Math.round(Math.max(120, r.height));
    /* 尺寸未变时不重置画布（重置会清空内容 → 闪烁） */
    if (w === this.W && h === this.H) return;
    this.W = w;
    this.H = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  },

  /* 车道几何：band 0/1/2 = 低/中/高，off = midi%12 */
  laneRect(midi) {
    const min = Keyboard.instrument === 'guitar' ? 52 : 48;
    const band = Math.floor((midi - min) / 12);
    const off = (midi - min) % 12;
    const labelW = 14;
    const laneW = (this.W - labelW - 8) / 36;
    const x = labelW + (band * 12 + off) * laneW;
    return { x: x + 1.5, w: laneW - 3, band, off };
  },

  trackColor(ev) {
    const P = window.VizSource || MidiPlayer;
    if (ev.tr === P.melodyTrack) return this.MELODY;
    return this.PAL[(ev.tr % this.PAL.length)];
  },

  echo: { canvas: null, ctx: null, W: 0, H: 0, dpr: 1 },

  /* 回声小框初始化：尺寸随容器，DPR 自适应 */
  initEcho(canvas) {
    this.echo.canvas = canvas;
    this.echo.ctx = canvas.getContext('2d');
    const fit = () => {
      const r = canvas.parentElement.getBoundingClientRect();
      this.echo.dpr = window.devicePixelRatio || 1;
      this.echo.W = Math.max(120, r.width);
      this.echo.H = Math.max(36, r.height);
      canvas.width = Math.round(this.echo.W * this.echo.dpr);
      canvas.height = Math.round(this.echo.H * this.echo.dpr);
    };
    fit();
    this._resizeEcho = fit; /* 供页签切换时重新适配尺寸 */
    if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas.parentElement);
    window.addEventListener('resize', fit);
  },

  /* 回声条记录：由 Keyboard.press/release 在「0→1 / 1→0」过渡时调用，
   * 覆盖手动、MIDI 播放、教学、演奏全部按键来源（noteOn 定义在对象头部，含炫彩逻辑） */
  noteOff(midi) {
    for (let i = this.presses.length - 1; i >= 0; i--) {
      if (this.presses[i].midi === midi && this.presses[i].releasedAt == null) {
        this.presses[i].releasedAt = performance.now();
        return;
      }
    }
  },

  /* 兼容别名：ui 层 onNoteOn/onNoteOff 与 Esc 紧急停止沿用旧名（noteOn 去重，双路径安全） */
  riserStart(midi, color) { this.noteOn(midi, color); },
  riserEnd(midi) { this.noteOff(midi); },
  riserEndAll() {
    const RN = performance.now();
    for (const pr of this.presses) if (pr.releasedAt == null) pr.releasedAt = RN;
  },

  /* 回声条回收（与页签无关，主循环每帧调用）：松手 1.75s 后移除 */
  recyclePresses() {
    const RN = performance.now();
    for (let i = this.presses.length - 1; i >= 0; i--) {
      const pr = this.presses[i];
      if (pr.releasedAt != null && (RN - pr.releasedAt) / 1000 >= 1.75) {
        this.presses.splice(i, 1);
      }
    }
  },

  /* 回声框渲染：与主瀑布流完全同款车道布局 + 用户音条倒流（整体上升、从框顶流出） */
  renderEcho() {
    const E = this.echo;
    if (!E.ctx) return;
    const c = E.ctx;
    c.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
    c.clearRect(0, 0, E.W, E.H);
    const hitY = E.H - 30;
    const pps = Math.max(95, (E.H - 62) / 1.7);
    const RN = performance.now();
    const isGuitar = Keyboard.instrument === 'guitar';
    const min = Keyboard.min;
    const bandW = 12;
    /* 车道底纹 */
    for (let off = 0; off < 36; off++) {
      const band = Math.floor(off / 12);
      const o = off % 12;
      const lw = (E.W - 14 - 8) / 36;
      const x = 14 + off * lw + 1.5;
      const acc = [1, 3, 6, 8, 10].includes(o) && !(isGuitar && [1,3,6,8,10].includes(o));
      const grad = c.createLinearGradient(0, 0, 0, hitY);
      grad.addColorStop(0, acc ? 'rgba(35,38,47,0.02)' : 'rgba(255,255,255,0.10)');
      grad.addColorStop(1, acc ? 'rgba(35,38,47,0.20)' : 'rgba(255,255,255,0.55)');
      c.fillStyle = grad;
      c.fillRect(x, 0, lw - 3, hitY);
    }
    /* 分组分隔线 */
    c.strokeStyle = 'rgba(35,38,47,0.14)';
    c.setLineDash([3, 4]);
    for (const b of [1, 2]) {
      const lx = 14 + b * 12 * ((E.W - 14 - 8) / 36) - 1.5;
      c.beginPath(); c.moveTo(lx, 4); c.lineTo(lx, hitY); c.stroke();
    }
    c.setLineDash([]);
    /* 用户音条 */
    const RISE = 1.75;
    for (let i = this.presses.length - 1; i >= 0; i--) {
      const pr = this.presses[i];
      const age = (RN - pr.born) / 1000;
      const held = pr.releasedAt == null ? age : (pr.releasedAt - pr.born) / 1000;
      const relAge = pr.releasedAt == null ? 0 : age - held;
      if (relAge >= RISE) { this.presses.splice(i, 1); continue; }
      const midi = pr.midi;
      const band = Math.floor((midi - min) / 12);
      const off = (midi - min) % 12;
      const lw = (E.W - 14 - 8) / 36;
      const x = 14 + (band * 12 + off) * lw + 1.5;
      const w = lw - 3;
      const bottom = hitY - relAge * pps;
      const hgt = Math.max(12, held * pps);
      const top = bottom - hgt;
      const fade = relAge > RISE - 0.45 ? Math.max(0, (RISE - relAge) / 0.45) : 1;
      c.save();
      c.globalAlpha = 0.82 * fade;
      c.shadowColor = pr.color;
      c.shadowBlur = 10;
      c.fillStyle = this._alpha(pr.color, 0.9);
      this._roundRect(c, x + 2, top, w - 4, hgt, 4);
      c.fill();
      c.shadowBlur = 0;
      c.strokeStyle = 'rgba(255,255,255,0.75)';
      c.lineWidth = 1.2;
      this._roundRect(c, x + 2.5, top + 0.5, w - 5, hgt - 1, 3.5);
      c.stroke();
      c.restore();
    }
    /* 判定线 */
    const line = c.createLinearGradient(0, 0, E.W, 0);
    line.addColorStop(0, this.accentRGBA(0.05));
    line.addColorStop(0.5, this.accentRGBA(0.75));
    line.addColorStop(1, this.accentRGBA(0.05));
    c.fillStyle = line;
    c.fillRect(0, hitY, E.W, 2);
  },

    burst(midi, color) {
    if (this.particlesEnabled === false) return; /* 设置面板：粒子反馈关闭 */
    const { x, w } = this.laneRect(midi);
    const hitY = this.H - 30;
    const c = color || this.MELODY;
    for (let i = 0; i < 10; i++) {
      const a = Math.PI * (0.15 + 0.7 * Math.random());
      const sp = 60 + Math.random() * 150;
      this.particles.push({
        x: x + w / 2 + (Math.random() - 0.5) * w,
        y: hitY - 2,
        vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1),
        vy: -Math.sin(a) * sp * (0.6 + Math.random() * 0.8),
        life: 0.55 + Math.random() * 0.3,
        age: 0,
        size: 1.2 + Math.random() * 2.2,
        color: c,
      });
    }
    this.flashes.push({ midi, age: 0, life: 0.35, color: c });
  },

  _roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  },

  render() {
    if (!this.ctx) return;
    const c = this.ctx;
    const dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);

    /* 数据源适配：练习模式用 MidiPlayer，演奏模式用 Perf（VizSource 注入） */
    const P = window.VizSource || MidiPlayer;
    const hasSong = !!P.song && P.events.length > 0;
    let now = hasSong ? P.songTimeNow() : 0;
    if (this.lastNow - now > 0.3) {
      /* 大幅回跳 = 真实 seek：允许回退并重置迸发标记 */
      for (const ev of P.events) delete ev._vz;
      this.lastNow = now;
    } else if (now < this.lastNow) {
      /* 小幅抖动（时钟校准）：钳制为单调，避免下落条闪现 */
      now = this.lastNow;
    } else {
      this.lastNow = now;
    }
    const pps = Math.max(95, (this.H - 62) / 1.7); // 落速：约 1.7 秒视窗
    this.lastPps = pps;
    const hitY = this.H - 30; // 底部留 30px 给简谱标注条

    /* ---- 车道底纹 ---- */
    for (let midi = Keyboard.min; midi <= Keyboard.max; midi++) {
      const { x, w, off } = this.laneRect(midi);
      const acc = [1, 3, 6, 8, 10].includes(off);
      const grad = c.createLinearGradient(0, 0, 0, this.H);
      if (acc) {
        grad.addColorStop(0, 'rgba(35,38,47,0.02)');
        grad.addColorStop(1, 'rgba(35,38,47,0.20)');
      } else {
        grad.addColorStop(0, 'rgba(255,255,255,0.10)');
        grad.addColorStop(1, 'rgba(255,255,255,0.55)');
      }
      c.fillStyle = grad;
      c.fillRect(x, 0, w, hitY);
    }
    /* 分组线与标签 */
    c.font = '10px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'top';
    const bands = [['低音', 0], ['中音', 1], ['高音', 2]];
    for (const [label, band] of bands) {
      const { x } = this.laneRect(band * 12 + 48);
      const xEnd = this.laneRect(band * 12 + 59).x + this.laneRect(band * 12 + 59).w;
      c.fillStyle = 'rgba(35,38,47,0.55)';
      c.save();
      c.translate(x - 3, 8);
      c.rotate(-Math.PI / 2);
      c.fillText(label, 0, 0);
      c.restore();
      if (band > 0) {
        c.strokeStyle = 'rgba(35,38,47,0.14)';
        c.setLineDash([3, 4]);
        c.beginPath(); c.moveTo(x - 1.5, 4); c.lineTo(x - 1.5, hitY); c.stroke();
        c.setLineDash([]);
      }
      void xEnd;
    }

    /* ---- 落下的音符 ---- */
    if (hasSong) {
      const horizon = now + (hitY + 20) / pps;
      const evs = P.events;
      /* 从头扫太贵时可用二分优化，目前事件数 < 数千，直接过滤即可 */
      for (const ev of evs) {
        if (ev.t > horizon) break;
        const endT = ev.t + ev.dur;
        if (endT < now - 0.8) continue; /* 穿过分界线后继续下沉一会儿 */
        const { x, w } = this.laneRect(ev.midi);
        const yBottom = hitY - (ev.t - now) * pps;
        const h = Math.max(5, ev.dur * pps);
        const y = yBottom - h;
        const teachOn = window.Teaching && Teaching.active;
        const okGreen = teachOn && ev._ok;              /* 按对：绿色 */
        const color = okGreen ? '#2fbf71' : this.trackColor(ev);
        const active = ev.t <= now && now < endT;

        /* 触底迸发（一次性） */
        if (ev.t <= now && !ev._vz) {
          ev._vz = true;
          this.burst(ev.midi, color);
        }

        /* 穿过分界线后的下沉渐隐：顶端越接近画布底部越透明 */
        const belowDepth = Math.max(0, y - hitY);
        const fade = belowDepth <= 0 ? 1 : Math.max(0, 1 - belowDepth / (this.H - hitY));

        /* 等待模式：当前驻留和弦（未完成）加强调光圈 */
        const isCur = teachOn && Teaching.mode === 'wait' && Teaching._nowChord
          && Teaching._nowChord.midis.includes(ev.midi) && !ev._ok
          && Math.abs(ev.t - Teaching._nowChord.t) < 0.01;
        c.save();
        c.globalAlpha = Math.max(0.08, fade);
        if (isCur) {
          c.shadowColor = '#f0a635';
          c.shadowBlur = 18;
        } else if (active && belowDepth <= 0) {
          c.shadowColor = color;
          c.shadowBlur = 14;
        } else if (belowDepth <= 0) {
          c.shadowColor = 'rgba(35,38,47,0.18)';
          c.shadowBlur = 4;
        }
        const g = c.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, this._alpha(color, 0.5 + 0.5 * ev.vel));
        g.addColorStop(1, this._alpha(color, active ? 1 : 0.68 + 0.32 * ev.vel));
        c.fillStyle = g;
        this._roundRect(c, x, y, w, h, Math.min(4, w / 2.5));
        c.fill();
        /* 高光边 */
        c.shadowBlur = 0;
        c.strokeStyle = 'rgba(255,255,255,' + (active ? 0.85 : 0.35) + ')';
        c.lineWidth = 1;
        this._roundRect(c, x + 0.5, y + 0.5, w - 1, h - 1, 3.5);
        c.stroke();
        if (isCur) { /* 强调描边 */
          c.shadowBlur = 0;
          c.strokeStyle = 'rgba(240,166,53,0.95)';
          c.lineWidth = 2.5;
          this._roundRect(c, x - 0.5, y - 0.5, w + 1, h + 1, 4);
          c.stroke();
        }
        /* 按键名标签（教学模式）：每车道去堆叠——与前一个已标音符条
         * 垂直间距 < 16px 时跳过（密集谱面只在簇首标注） */
        if (teachOn && !okGreen && belowDepth <= 0) {
          const lane = ev.midi;
          const lastY = this._laneLabelY.get(lane);
          if (lastY == null || lastY - yBottom >= 16) {
            this._laneLabelY.set(lane, yBottom);
            const hint = midiKeyHint(ev.midi);
            c.shadowBlur = 0;
            c.font = '700 10px "Segoe UI", "Microsoft YaHei UI", sans-serif';
            c.textAlign = 'center';
            c.textBaseline = 'bottom';
            c.lineWidth = 3;
            c.strokeStyle = 'rgba(35,38,47,0.85)';
            c.strokeText(hint, x + w / 2, Math.min(yBottom - 1, y + h - 1));
            c.fillStyle = '#fff';
            c.fillText(hint, x + w / 2, Math.min(yBottom - 1, y + h - 1));
          }
        }
        c.restore();
      }
      this._laneLabelY.clear();
    } else {
      c.fillStyle = 'rgba(35,38,47,0.35)';
      c.font = '12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      c.textAlign = 'center';
      c.fillText('选择 MIDI 文件后，音符将在这里落下 · 弹奏琴键也有粒子反馈', this.W / 2, this.H / 2 - 8);
      c.textAlign = 'left';
    }

    /* ---- 车道闪光 ---- */
    for (const f of this.flashes) {
      const { x, w } = this.laneRect(f.midi);
      const a = 1 - f.age / f.life;
      const g = c.createLinearGradient(0, hitY - 46, 0, hitY);
      g.addColorStop(0, this._alpha(f.color, 0));
      g.addColorStop(1, this._alpha(f.color, 0.55 * a));
      c.fillStyle = g;
      c.fillRect(x, hitY - 46, w, 46);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].age += 1 / 60;
      if (this.flashes[i].age >= this.flashes[i].life) this.flashes.splice(i, 1);
    }

    /* ---- 分界线下的磨砂带：音符从其下方穿过、渐隐"沉入" ---- */
    const frost = c.createLinearGradient(0, hitY - 4, 0, this.H);
    frost.addColorStop(0, 'rgba(240,241,246,0)');
    frost.addColorStop(0.45, 'rgba(240,241,246,0.62)');
    frost.addColorStop(1, 'rgba(240,241,246,0.96)');
    c.fillStyle = frost;
    c.fillRect(0, hitY - 4, this.W, this.H - hitY + 4);

    /* ---- 触底线 ---- */
    const line = c.createLinearGradient(0, 0, this.W, 0);
    line.addColorStop(0, this.accentRGBA(0.05));
    line.addColorStop(0.5, this.accentRGBA(0.75));
    line.addColorStop(1, this.accentRGBA(0.05));
    c.fillStyle = line;
    c.fillRect(0, hitY, this.W, 2);
    c.fillStyle = this.accentRGBA(0.18);
    c.fillRect(0, hitY + 2, this.W, 6);

    /* ---- 底部简谱标注条：自然音清晰、半音淡色；被弹到的音随闪光点亮 ---- */
    const flashMap = new Map();
    for (const f of this.flashes) {
      if (!flashMap.has(f.midi)) {
        flashMap.set(f.midi, { color: f.color, a: 1 - f.age / f.life });
      }
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let midi = Keyboard.min; midi <= Keyboard.max; midi++) {
      const { x, w, off } = this.laneRect(midi);
      const acc = [1, 3, 6, 8, 10].includes(off);
      const flash = flashMap.get(midi);
      if (flash) {
        c.font = `700 ${acc ? 9.5 : 10.5}px ${this.FONT}`;
        c.fillStyle = this._alpha(flash.color, 0.35 + 0.65 * flash.a);
      } else {
        c.font = `${acc ? '' : '600 '}${acc ? 9 : 10}px ${this.FONT}`;
        c.fillStyle = acc ? 'rgba(35,38,47,0.26)' : 'rgba(35,38,47,0.48)';
      }
      c.fillText(this.SOLFEGE[off], x + w / 2, hitY + 16);
    }
    /* 每组起始（低/中/高的"1"）加一个细分隔点，强化三组视觉分段 */
    for (const bandMidi of [48, 60, 72]) {
      const { x } = this.laneRect(bandMidi);
      if (bandMidi > 48) {
        c.strokeStyle = 'rgba(35,38,47,0.10)';
        c.setLineDash([2, 3]);
        c.beginPath(); c.moveTo(x - 1.5, hitY + 8); c.lineTo(x - 1.5, this.H - 4); c.stroke();
        c.setLineDash([]);
      }
    }

    /* ---- 粒子 ---- */
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += 1 / 60;
      if (p.age >= p.life) { this.particles.splice(i, 1); continue; }
      p.vy += 460 / 60;
      p.x += p.vx / 60;
      p.y += p.vy / 60;
      const a = 1 - p.age / p.life;
      c.globalAlpha = a;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    }
  },

  _alpha(hex, a) {
    if (typeof hex !== 'string' || hex[0] !== '#') return hex; /* hsl() 等原样返回（透明度由 globalAlpha 控制） */
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.min(1, a).toFixed(3)})`;
  },
};
window.Viz = Viz;
