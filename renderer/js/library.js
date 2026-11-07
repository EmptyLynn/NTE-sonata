/* ============================================================================
 * 曲库（MIDI 收藏夹）
 *
 *  · 导入即复制一份源文件到应用管理的存储（Electron: userData/library/，
 *    浏览器调试: IndexedDB），源文件删除/移动不影响曲库；
 *  · 排序（最近导入/名称/时长/音符数）、分类标签（自由命名 + 筛选）、
 *    删除（卡片内联确认）、网格/列表两种布局；
 *  · 卡片点击 = 载入该曲（自动演奏）。
 * ==========================================================================*/
const Library = {
  entries: [],
  sort: 'recent',       // recent | name | duration | notes
  view: 'grid',         // grid | list
  filterCat: '全部',

  els: {},

  _initPromise: null,

  init() {
    /* 防重入：主初始化与延迟初始化各调一次，重复绑定事件/并发播种会导致曲库重复 */
    if (this._initPromise) return this._initPromise;
    this.els = {
      modal: document.getElementById('lib-modal'),
      grid: document.getElementById('lib-grid'),
      empty: document.getElementById('lib-empty'),
      count: document.getElementById('lib-count'),
      badge: document.getElementById('lib-badge'),
      sort: document.getElementById('lib-sort'),
      chips: document.getElementById('lib-chips'),
      viewGrid: document.getElementById('lib-view-grid'),
      viewList: document.getElementById('lib-view-list'),
      pop: document.getElementById('lib-cat-pop'),
      popInput: this.popInput = null,
    };
    const ui = this.loadUiPrefs();
    this.sort = ui.sort || 'recent';
    this.view = ui.view || 'grid';
    this.els.sort.value = this.sort;

    document.getElementById('btn-library').addEventListener('click', () => this.open());
    document.getElementById('lib-close').addEventListener('click', () => this.close());
    this.els.modal.querySelector('.lib-backdrop').addEventListener('click', () => this.close());
    document.getElementById('lib-import').addEventListener('click', () => UI.pickFile());
    this.els.sort.addEventListener('change', () => { this.sort = this.els.sort.value; this.saveUiPrefs(); this.render(); });
    this.els.viewGrid.addEventListener('click', () => this.setView('grid'));
    this.els.viewList.addEventListener('click', () => this.setView('list'));

    /* 分类编辑弹层 */
    this.popInput = this.els.pop.querySelector('input');
    this.els.pop.querySelector('.lib-pop-ok').addEventListener('click', () => this.applyCatEdit());
    this.popInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyCatEdit();
      if (e.key === 'Escape') this.hideCatPop();
    });
    this.els.pop.querySelector('.lib-pop-cancel').addEventListener('click', () => this.hideCatPop());

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.els.modal.classList.contains('hidden')) this.close();
    });

    /* ---------------- 批量操作 ---------------- */
    this.batch = false;
    this.selected = new Set();
    this._delArm = 0; /* 删除按钮双击确认计时 */
    const $ = (id) => document.getElementById(id);
    this.els.batchBtn = $('lib-batch');
    this.els.batchBar = $('lib-batchbar');
    this.els.batchCount = $('lib-batchcount');
    this.els.batchModal = document.getElementById('lib-modal');
    this.els.selAll = $('lib-selall');
    this.els.catAdd = $('lib-cat-add');
    this.els.catRm = $('lib-cat-rm');
    this.els.clearParams = $('lib-clearparams');
    this.els.delBtn = $('lib-del');
    this.els.batchExit = $('lib-batchexit');
    this.els.catPop = $('lib-catpop');

    this.els.batchBtn.addEventListener('click', () => this.toggleBatch());
    this.els.batchExit.addEventListener('click', () => this.toggleBatch(false));
    this.els.selAll.addEventListener('click', () => {
      const list = this.visibleEntries();
      if (this.selected.size >= list.length) this.selected.clear();
      else list.forEach((en) => this.selected.add(en.id));
      this.render();
      this.updateBatchBar();
    });
    this.els.delBtn.addEventListener('click', () => {
      if (!this.selected.size) return;
      if (!this._delArm) { /* 双击确认：第一次只变红警告 */
        this._delArm = Date.now();
        this.els.delBtn.textContent = `确认删除 ${this.selected.size} 首`;
        this.els.delBtn.classList.add('confirming');
        setTimeout(() => { this._delArm = 0; this.els.delBtn.textContent = '删除'; this.els.delBtn.classList.remove('confirming'); }, 2600);
        return;
      }
      this.removeSelected();
    });
    this.els.clearParams.addEventListener('click', () => this.clearParams());
    this.els.catAdd.addEventListener('click', (e) => { e.stopPropagation(); this.showBatchCatPop('add'); });
    this.els.catRm.addEventListener('click', (e) => { e.stopPropagation(); this.showBatchCatPop('remove'); });
    this.els.catPop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => this.els.catPop.classList.add('hidden'));

    this._initPromise = this.refresh().then(() => this.seedBuiltins());
    return this._initPromise;
  },

  /* 首次启动把内置曲目（assets/builtin）入库，打「内置」标签；
   * 播种仅一次（标记持久化），用户删除后不会重生。
   * v2 增量批次（lastkiss/绿色）：老用户只补新歌，已删除的旧歌不重生。 */
  async seedBuiltins() {
    const FLAG = 'yihuan.piano.library.seeded';
    const FLAG2 = 'yihuan.piano.library.seeded.v2';
    try {
      const done1 = !!localStorage.getItem(FLAG);
      const done2 = !!localStorage.getItem(FLAG2);
      if (done1 && done2) return;
      const resp = await fetch('../assets/builtin/manifest.json');
      if (!resp.ok) return;
      let songs = await resp.json();
      if (done1 && !done2) {
        songs = songs.filter((s) => s.file === 'lastkiss.mid' || s.file === '绿色.mid');
        /* v2 迁移：旧版主初始化/延迟初始化各跑一次播种的竞态可能重复入库过同名曲目，顺手清理（保留最早一条） */
        const seen = new Set();
        let removed = 0;
        for (const e of [...this.entries]) {
          const k = String(e.title).trim().toLowerCase();
          if (seen.has(k)) { await this.remove(e.id); removed++; }
          else seen.add(k);
        }
        if (removed) await this.refresh();
      }
      const have = new Set(this.entries.map((e) => e.title));
      const todo = songs.filter((s) => !have.has(s.title));
      for (const s of todo) {
        const r = await fetch(`../assets/builtin/${encodeURIComponent(s.file)}`);
        if (!r.ok) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        let meta = {};
        try {
          const song = MidiSource.parse(bytes);
          meta = { duration: song.duration, notes: song.totalNotes, tracks: song.trackCount, bpm: song.tempo, key: song.key || "" };
        } catch { /* 元数据解析失败仍可入库 */ }
        if (window.yihuan && window.yihuan.isElectron) {
          await window.yihuan.libraryAddData(bytes, s.title, meta, ['内置']);
        } else {
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const db = await this.idb();
          await this.req(this.idbTx(db, 'readwrite').put({
            id, title: s.title, addedAt: Date.now(), categories: ['内置'], meta, data: bytes,
          }));
        }
      }
      localStorage.setItem(FLAG, '1');
      localStorage.setItem(FLAG2, '1');
      await this.refresh();
      if (todo.length && UI && UI.log) UI.log(`内置曲目已加入曲库：${todo.map((s) => s.title).join('、')}`, 'info');
    } catch { /* 内置曲目缺失不致命 */ }
  },

  /* ---------------- 存储（Electron IPC / IndexedDB 双后端） ---------------- */
  async idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('yihuan-lib', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('midis', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  idbTx(db, mode) { return db.transaction('midis', mode).objectStore('midis'); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },

  async refresh() {
    if (window.yihuan && window.yihuan.isElectron) {
      const res = await window.yihuan.libraryList();
      this.entries = res.ok ? res.entries : [];
    } else {
      try {
        const db = await this.idb();
        const all = await this.req(this.idbTx(db, 'readonly').getAll());
        this.entries = all.sort((a, b) => b.addedAt - a.addedAt);
      } catch { this.entries = []; }
    }
    this.updateBadge();
    this.render();
  },

  /* 导入：data 用于浏览器模式入库；srcPath 用于 Electron 复制。返回新条目（含 id） */
  async add({ srcPath, data, title, meta }) {
    try {
      let entry = null;
      if (window.yihuan && window.yihuan.isElectron && srcPath) {
        const res = await window.yihuan.libraryAdd(srcPath, title, meta, []);
        if (!res.ok) throw new Error(res.error);
        entry = res.entry;
      } else if (data) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const db = await this.idb();
        entry = { id, title, addedAt: Date.now(), categories: [], meta: meta || {}, data };
        await this.req(this.idbTx(db, 'readwrite').put(entry));
      } else {
        return null;
      }
      await this.refresh();
      if (UI && UI.log) UI.log(`已加入曲库：「${title}」`, 'info');
      return entry;
    } catch (err) {
      if (UI && UI.log) UI.log('加入曲库失败：' + (err.message || err), 'err');
      return null;
    }
  },

  async update(id, categories) {
    if (window.yihuan && window.yihuan.isElectron) {
      const res = await window.yihuan.libraryUpdate(id, null, categories);
      if (res.ok) this.entries = res.entries;
    } else {
      const db = await this.idb();
      const entry = await this.req(this.idbTx(db, 'readonly').get(id));
      if (entry) {
        entry.categories = categories;
        await this.req(this.idbTx(db, 'readwrite').put(entry));
      }
    }
    await this.refresh();
  },

  async remove(id) {
    if (window.yihuan && window.yihuan.isElectron) {
      const res = await window.yihuan.libraryRemove(id);
      if (res.ok) this.entries = res.entries;
    } else {
      const db = await this.idb();
      await this.req(this.idbTx(db, 'readwrite').delete(id));
    }
    await this.refresh();
  },

  async loadEntry(entry) {
    let data;
    if (window.yihuan && window.yihuan.isElectron) {
      const res = await window.yihuan.readMidiFile(entry.path);
      if (!res.ok) { UI.log('读取曲库文件失败：' + res.error, 'err'); return; }
      data = res.data;
    } else {
      const db = await this.idb();
      const full = await this.req(this.idbTx(db, 'readonly').get(entry.id));
      if (!full) { UI.log('曲库条目数据缺失', 'err'); return; }
      data = full.data;
    }
    this.close();
    UI.loadSong(data, entry.title, entry.id);
  },

  /* ---------------- 批量操作 ---------------- */
  toggleBatch(force) {
    this.batch = typeof force === 'boolean' ? force : !this.batch;
    if (!this.batch) this.selected.clear();
    this.els.batchModal.classList.toggle('batching', this.batch);
    this.els.batchBtn.textContent = this.batch ? '✓ 多选中' : '☐ 多选';
    this.els.batchBtn.classList.toggle('active', this.batch);
    this._delArm = 0;
    this.els.delBtn.textContent = '删除';
    this.els.delBtn.classList.remove('confirming');
    this.els.catPop.classList.add('hidden');
    this.render();
    this.updateBatchBar();
  },

  updateBatchBar() {
    this.els.batchCount.textContent = `已选 ${this.selected.size} 首`;
  },

  toggleSelect(id) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.updateBatchBar();
  },

  /* 批量分类弹层：mode = 'add' | 'remove' */
  showBatchCatPop(mode) {
    const pop = this.els.catPop;
    pop.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'cat-head';
    head.textContent = (mode === 'add' ? '添加到分类' : '移出分类') + `（已选 ${this.selected.size} 首）`;
    pop.appendChild(head);

    /* 收集全部曲库出现过的分类 */
    const counts = new Map();
    for (const en of this.entries) {
      for (const c of en.categories || []) counts.set(c, (counts.get(c) || 0) + 1);
    }
    const cats = [...counts.keys()];
    if (!cats.length) {
      const none = document.createElement('div');
      none.className = 'cat-none';
      none.textContent = '还没有分类，在下方新建一个';
      pop.appendChild(none);
    }
    for (const c of cats) {
      const b = document.createElement('button');
      b.className = 'cat-item';
      b.innerHTML = `<span>${c}</span><span class="cnt">${counts.get(c)} 首</span>`;
      b.addEventListener('click', () => { this.applyBatchCategories(mode, c); pop.classList.add('hidden'); });
      pop.appendChild(b);
    }
    /* 新建分类（仅添加模式） */
    if (mode === 'add') {
      const row = document.createElement('div');
      row.className = 'cat-new';
      const input = document.createElement('input');
      input.placeholder = '新分类名称（≤12 字）';
      input.maxLength = 12;
      const ok = document.createElement('button');
      ok.className = 'btn btn-primary';
      ok.style.fontSize = '12px';
      ok.style.padding = '5px 10px';
      ok.textContent = '创建';
      const submit = () => {
        const name = input.value.trim();
        if (!name) return;
        this.applyBatchCategories('add', name);
        pop.classList.add('hidden');
      };
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      row.appendChild(input);
      row.appendChild(ok);
      pop.appendChild(row);
      setTimeout(() => input.focus(), 50);
    }
    pop.classList.remove('hidden');
  },

  /* 对选中条目批量加/移分类；force = 覆盖为新列表（单分类模式用） */
  async applyBatchCategories(mode, cat) {
    if (!this.selected.size) return;
    const ids = [...this.selected];
    for (const id of ids) {
      const en = this.entries.find((e) => e.id === id);
      if (!en) continue;
      const cats = new Set(en.categories || []);
      if (mode === 'add') cats.add(cat);
      else cats.delete(cat);
      en.categories = [...cats];
      if (window.yihuan && window.yihuan.isElectron) {
        await window.yihuan.libraryUpdate(id, undefined, en.categories);
      } else {
        const db = await this.idb();
        const full = await this.req(this.idbTx(db, 'readonly').get(id));
        if (full) { full.categories = en.categories; await this.req(this.idbTx(db, 'readwrite').put(full)); }
      }
    }
    await this.refresh();
    this.render();
    const name = mode === 'add' ? '已添加到分类' : '已移出分类';
    UI.log(`${name}「${cat}」：${ids.length} 首`, 'info');
  },

  async removeSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    for (const id of ids) {
      const en = this.entries.find((e) => e.id === id);
      if (en && MidiPlayer.currentEntryId === id) MidiPlayer.currentEntryId = null; /* 载入中的曲目被删：断开参数关联 */
      await this.remove(id);
    }
    /* 同步清掉这些曲目的独立参数 */
    try {
      const all = JSON.parse(localStorage.getItem(UI.SONG_PARAMS_KEY)) || {};
      for (const id of ids) delete all[id];
      localStorage.setItem(UI.SONG_PARAMS_KEY, JSON.stringify(all));
    } catch { /* 忽略 */ }
    this.selected.clear();
    this._delArm = 0;
    this.els.delBtn.textContent = '删除';
    this.els.delBtn.classList.remove('confirming');
    this.render();
    this.updateBatchBar();
    UI.log(`已删除 ${ids.length} 首乐曲`, 'info');
  },

  async clearParams() {
    const ids = [...this.selected];
    if (!ids.length) return;
    try {
      const all = JSON.parse(localStorage.getItem(UI.SONG_PARAMS_KEY)) || {};
      for (const id of ids) delete all[id];
      localStorage.setItem(UI.SONG_PARAMS_KEY, JSON.stringify(all));
    } catch { /* 忽略 */ }
    UI.log(`已清除 ${ids.length} 首乐曲的独立参数（速度/移调/轨道/超域）`, 'info');
  },

  /* ---------------- UI ---------------- */
  updateBadge() {
    this.els.badge.textContent = String(this.entries.length);
    this.els.badge.classList.toggle('hidden', !this.entries.length);
  },

  open() { this.els.modal.classList.remove('hidden'); this.render(); },
  close() {
    this.els.modal.classList.add('hidden');
    this.hideCatPop();
    if (this.batch) this.toggleBatch(false); /* 关闭弹窗退出批量态 */
  },

  setView(v) {
    this.view = v;
    this.saveUiPrefs();
    this.render();
  },

  allCategories() {
    const set = new Set();
    for (const e of this.entries) e.categories.forEach((c) => set.add(c));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  },

  visibleEntries() {
    let list = this.entries.filter((e) => this.filterCat === '全部' || (e.categories || []).includes(this.filterCat));
    const by = {
      recent: (a, b) => b.addedAt - a.addedAt,
      name: (a, b) => a.title.localeCompare(b.title, 'zh'),
      duration: (a, b) => ((b.meta || {}).duration || 0) - ((a.meta || {}).duration || 0),
      notes: (a, b) => ((b.meta || {}).notes || 0) - ((a.meta || {}).notes || 0),
    }[this.sort] || ((a, b) => b.addedAt - a.addedAt);
    return list.sort(by);
  },

  render() {
    /* 筛选 chips */
    const cats = ['全部', ...this.allCategories()];
    this.els.chips.innerHTML = '';
    for (const cat of cats) {
      const b = document.createElement('button');
      b.className = 'chip' + (cat === this.filterCat ? ' active' : '');
      b.textContent = cat;
      b.addEventListener('click', () => { this.filterCat = cat; this.render(); });
      this.els.chips.appendChild(b);
    }
    this.els.viewGrid.classList.toggle('active', this.view === 'grid');
    this.els.viewList.classList.toggle('active', this.view === 'list');

    const list = this.visibleEntries();
    this.els.count.textContent = `${list.length} 首`;
    this.els.empty.classList.toggle('hidden', list.length > 0);
    const grid = this.els.grid;
    grid.innerHTML = '';
    grid.className = this.view === 'grid' ? 'lib-grid' : 'lib-list';

    for (const entry of list) grid.appendChild(this.buildCard(entry));
  },

  buildCard(entry) {
    const card = document.createElement('div');
    card.className = 'lib-card' + (this.view === 'list' ? ' row' : '');
    const cats = entry.categories || [];
    const meta = entry.meta || {};
    const dur = UI.fmtTime(meta.duration || 0);
    /* 调性：入库 meta 优先，旧条目回退到每曲参数表（首次播放时回填） */
    const songKey = meta.key
      || (entry.id && UI.loadSongParams ? (UI.loadSongParams(entry.id) || {}).key : '')
      || '';
    const metaText = `${dur} · ${meta.notes || 0}音 · ${meta.tracks || 0}轨${meta.bpm ? ' · ' + meta.bpm + 'BPM' : ''}${songKey ? ' · ' + songKey : ''}`;

    const title = document.createElement('div');
    title.className = 'lib-title';
    title.textContent = entry.title;
    const sub = document.createElement('div');
    sub.className = 'lib-sub';
    sub.textContent = metaText;
    const tags = document.createElement('div');
    tags.className = 'lib-tags';
    const catBtn = document.createElement('button');
    catBtn.className = 'lib-cat' + (cats.length ? ' has' : '');
    catBtn.textContent = cats.length ? cats.join(' · ') : '＋ 分类';
    catBtn.title = '设置分类';
    catBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showCatPop(entry, catBtn);
    });
    tags.appendChild(catBtn);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    const play = document.createElement('button');
    play.className = 'lib-act play';
    play.title = '载入';
    play.innerHTML = '▶';
    play.addEventListener('click', (e) => { e.stopPropagation(); this.loadEntry(entry); });
    const del = document.createElement('button');
    del.className = 'lib-act del';
    del.title = '删除';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('confirming');
      const confirmBox = card.querySelector('.lib-confirm');
      confirmBox.classList.remove('hidden');
    });
    actions.append(play, del);

    const confirm = document.createElement('div');
    confirm.className = 'lib-confirm hidden';
    confirm.innerHTML = `<span>删除这首？</span>`;
    const yes = document.createElement('button');
    yes.className = 'lib-act del';
    yes.textContent = '删除';
    yes.addEventListener('click', (e) => { e.stopPropagation(); this.remove(entry.id); });
    const no = document.createElement('button');
    no.className = 'lib-act';
    no.textContent = '取消';
    no.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.remove('confirming');
      confirm.classList.add('hidden');
    });
    confirm.append(yes, no);

    card.append(title, sub, tags, actions, confirm);
    /* 多选圈（仅批量模式显示） */
    const check = document.createElement('span');
    check.className = 'lib-check';
    card.appendChild(check);
    if (this.selected.has(entry.id)) card.classList.add('selected');
    card.addEventListener('click', () => {
      if (this.batch) {
        card.classList.toggle('selected');
        this.toggleSelect(entry.id);
        return;
      }
      this.loadEntry(entry);
    });
    return card;
  },

  /* 分类编辑弹层（跟随按钮定位） */
  catEditTarget: null,
  showCatPop(entry, anchor) {
    this.catEditTarget = entry;
    const pop = this.els.pop;
    this.popInput.value = (entry.categories || []).join(',');
    /* 快捷分类候选 */
    const quick = this.els.pop.querySelector('.lib-pop-quick');
    quick.innerHTML = '';
    for (const c of ['收藏', '练习', '演出', ...this.allCategories()]) {
      if ((entry.categories || []).includes(c)) continue;
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = c;
      b.addEventListener('click', () => {
        const set = new Set(this.popInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
        set.add(c);
        this.popInput.value = [...set].join(',');
      });
      quick.appendChild(b);
    }
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(12, Math.min(r.left - 8, window.innerWidth - pr.width - 12)) + 'px';
    pop.style.top = Math.max(12, r.top - pr.height - 8) + 'px';
    this.popInput.focus();
  },
  hideCatPop() { this.els.pop.classList.add('hidden'); },
  async applyCatEdit() {
    if (!this.catEditTarget) return;
    const cats = [...new Set(this.popInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))].slice(0, 3);
    const entry = this.catEditTarget;
    this.hideCatPop();
    await this.update(entry.id, cats);
    if (this.filterCat !== '全部' && !cats.includes(this.filterCat)) this.filterCat = '全部';
    this.render();
  },

  loadUiPrefs() {
    try { return JSON.parse(localStorage.getItem('yihuan.piano.library.ui')) || {}; } catch { return {}; }
  },
  saveUiPrefs() {
    try { localStorage.setItem('yihuan.piano.library.ui', JSON.stringify({ sort: this.sort, view: this.view })); } catch { /* 忽略 */ }
  },
};
window.Library = Library;
