import { parseBook, buildUnits, buildChunks, chunkDuration, pageAt } from './chunker.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

// ===== 設定 =====
const SETTINGS_KEY = 'flash-reader-settings';
const SAMPLE_FLAG_KEY = 'flash-reader-sample-added';
const DEFAULTS = {
  cpm: 1000,
  group: 1,
  minChars: 3,
  fontSize: 56,
  punctPause: true,
  emphHighlight: true,
  emphSlow: true,
  vertical: false,
  guide: true,
  theme: 'auto',
};
const SAMPLE_DIR = 'samples/';
const SAMPLE_INDEX_URL = SAMPLE_DIR + 'index.json';
const START_DELAY = 300; // 再生開始直後の間（ms）
const SAVE_INTERVAL = 5000; // 再生中の位置保存間隔（ms）

const settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保存できない環境（プライベートモード等）では無視
  }
}

// ===== 状態 =====
const state = {
  meta: null, // 開いている本のメタ情報
  book: null, // parseBook の結果
  units: [],
  chunks: [],
  durations: [],
  remain: new Float64Array(1), // remain[i] = i 番目以降の合計表示時間
  chapters: [], // { title, idx }
  idx: 0,
  playing: false,
  timer: 0,
  wakeLock: null,
  lastSave: 0,
};

// ===== 本棚 =====
async function showLibrary() {
  pause();
  $('reader').hidden = true;
  $('library').hidden = false;
  state.meta = null;
  await renderLibrary();
}

async function renderLibrary() {
  const books = await store.listBooks();
  books.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  const list = $('book-list');
  list.replaceChildren();
  $('empty-msg').hidden = books.length > 0;
  for (const meta of books) {
    const pct = meta.totalChars ? Math.min(100, Math.round((meta.offset / meta.totalChars) * 100)) : 0;
    const li = document.createElement('li');
    li.className = 'book-item';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'book-open';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = meta.title;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = `${fmtNum(meta.totalChars)}字 ・ ${pct}%`;
    const p = document.createElement('span');
    p.className = 'p';
    const bar = document.createElement('i');
    bar.style.width = pct + '%';
    p.append(bar);
    open.append(t, m, p);
    open.addEventListener('click', () => openBook(meta));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn book-del';
    del.setAttribute('aria-label', `「${meta.title}」を削除`);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm(`「${meta.title}」を削除しますか？\n読んだ位置も消えます。`)) return;
      await store.deleteBook(meta.id);
      await renderLibrary();
    });

    li.append(open, del);
    list.append(li);
  }
}

/**
 * 本文を解析して本棚に追加する。
 * @param {string} raw 本文
 * @param {{fallbackTitle?: string, overrideTitle?: string, source?: string}} opts
 *   source: サンプル由来ならそのファイル名（追加済み判定に使う）
 */
async function addBookFromText(raw, { fallbackTitle = '', overrideTitle = '', source = '' } = {}) {
  const book = parseBook(raw);
  if (!book.totalChars) {
    alert('本文が空です。');
    return false;
  }
  const meta = {
    id: newId(),
    title: overrideTitle || book.title || fallbackTitle || '無題',
    totalChars: book.totalChars,
    offset: 0,
    addedAt: Date.now(),
    openedAt: 0,
  };
  if (source) meta.source = source;
  await store.addBook(meta, raw);
  return true;
}

function newId() {
  // randomUUID は https / localhost でしか使えないため代替を用意
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// UTF-8 で読めなければ Shift_JIS として読む
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

// サンプル一覧（samples/index.json）を取得する。新しい順に並べる
async function fetchSampleIndex() {
  const res = await fetch(SAMPLE_INDEX_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('サンプル一覧を読み込めませんでした');
  const data = await res.json();
  return [...(data.samples ?? [])].sort((a, b) => String(b.added).localeCompare(String(a.added)));
}

async function addSample(entry) {
  const res = await fetch(SAMPLE_DIR + entry.file, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`「${entry.title}」を読み込めませんでした`);
  return addBookFromText(await res.text(), { fallbackTitle: entry.title, source: entry.file });
}

// サンプル一覧シートを開く。本棚にあるものは「追加済み」と表示する
async function openSampleList() {
  const list = $('sample-list');
  const msg = $('sample-msg');
  list.replaceChildren();
  msg.textContent = '読み込み中…';
  openSheet('sample-sheet');
  let samples;
  let books;
  try {
    [samples, books] = await Promise.all([fetchSampleIndex(), store.listBooks()]);
  } catch (err) {
    msg.textContent = err.message + '（ネットにつながっているか確認してください）';
    return;
  }
  msg.textContent = samples.length ? '' : 'サンプルはまだありません。';
  // source を持たない古いデータは書名で判定する
  const owned = new Set(books.flatMap((b) => [b.source, b.title]).filter(Boolean));
  for (const entry of samples) {
    const added = owned.has(entry.file) || owned.has(entry.title);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sample-item';
    const t = document.createElement('span');
    t.textContent = entry.title;
    const m = document.createElement('span');
    m.className = 'sample-meta';
    m.textContent = `${entry.chars ? fmtNum(entry.chars) + '字' : ''}${added ? ' ・ 追加済み' : ''}`;
    b.append(t, m);
    b.addEventListener('click', async () => {
      if (added && !confirm(`「${entry.title}」はすでに本棚にあります。もう1冊追加しますか？`)) return;
      try {
        if (await addSample(entry)) {
          closeSheets();
          await renderLibrary();
        }
      } catch (err) {
        alert(err.message);
      }
    });
    li.append(b);
    list.append(li);
  }
}

// ===== リーダー =====
async function openBook(meta) {
  const raw = await store.getText(meta.id);
  if (raw == null) {
    alert('本文データが見つかりません。');
    return;
  }
  state.meta = meta;
  state.book = parseBook(raw);
  state.units = buildUnits(state.book);
  rebuildChunks(meta.offset || 0);
  $('book-title').textContent = meta.title;
  $('library').hidden = true;
  $('reader').hidden = false;
  applyDisplaySettings();
  render();
  meta.openedAt = Date.now();
  store.updateBook(meta).catch(console.error);
}

// 設定（まとめ方）に合わせてチャンクを作り直し、同じ字位置に戻す
function rebuildChunks(offset) {
  state.chunks = buildChunks(state.units, settings);
  state.chapters = [];
  state.chunks.forEach((c, i) => {
    if (c.kind === 'heading') state.chapters.push({ title: c.text, idx: i, level: c.level });
  });
  recomputeDurations();
  state.idx = indexForOffset(offset);
  $('seek').max = Math.max(0, state.chunks.length - 1);
}

function recomputeDurations() {
  const n = state.chunks.length;
  state.durations = state.chunks.map((c) => chunkDuration(c, settings));
  state.remain = new Float64Array(n + 1);
  for (let i = n - 1; i >= 0; i--) state.remain[i] = state.remain[i + 1] + state.durations[i];
}

// offset（字位置）を含むチャンクの番号
function indexForOffset(offset) {
  const cs = state.chunks;
  let lo = 0;
  let hi = cs.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].start <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function currentChapter() {
  let cur = null;
  for (const ch of state.chapters) {
    if (ch.idx > state.idx) break;
    cur = ch;
  }
  return cur;
}

function render() {
  const c = state.chunks[state.idx];
  const word = $('word');
  if (!c) {
    word.textContent = '';
    return;
  }
  word.className = c.kind === 'heading' ? 'heading' : '';
  word.replaceChildren(...renderText(c.text, settings.emphHighlight ? c.emph : []));
  fitWord(c.kind === 'heading');

  $('seek').value = state.idx;
  const atEnd = state.idx === state.chunks.length - 1;
  const pos = atEnd ? state.book.totalChars : c.start;
  const page = pageAt(state.book.pages, c.start);
  $('pos-text').textContent =
    (page ? `p.${page} ・ ` : '') + `${fmtNum(pos)} / ${fmtNum(state.book.totalChars)}字`;
  $('remain-text').textContent = `残り 約${fmtTime(state.remain[state.idx])}`;
  $('chapter-title').textContent = currentChapter()?.title ?? '';
}

// 重要語を <mark> で囲んだノード列を作る
function renderText(text, emph) {
  const nodes = [];
  let last = 0;
  for (const [s, e] of emph) {
    if (s > last) nodes.push(document.createTextNode(text.slice(last, s)));
    const mk = document.createElement('mark');
    mk.textContent = text.slice(s, e);
    nodes.push(mk);
    last = e;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

// 画面からはみ出す長さの文節は文字を縮めて収める
function fitWord(isHeading) {
  const word = $('word');
  const stage = $('stage');
  const base = settings.fontSize * (isHeading ? 0.6 : 1);
  word.style.fontSize = base + 'px';
  if (isHeading) return;
  const vertical = settings.vertical;
  const avail = vertical ? stage.clientHeight - 100 : stage.clientWidth - 32;
  const size = vertical ? word.scrollHeight : word.scrollWidth;
  if (avail > 0 && size > avail) {
    word.style.fontSize = Math.max(14, Math.floor((base * avail) / size)) + 'px';
  }
}

// ===== 再生制御 =====
function play() {
  if (state.playing || !state.chunks.length) return;
  if (state.idx >= state.chunks.length - 1) {
    state.idx = 0;
    render();
  }
  state.playing = true;
  $('reader').classList.add('playing');
  $('play').setAttribute('aria-label', '停止');
  requestWakeLock();
  schedule(START_DELAY);
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  clearTimeout(state.timer);
  $('reader').classList.remove('playing');
  $('play').setAttribute('aria-label', '再生');
  releaseWakeLock();
  saveProgress();
}

function togglePlay() {
  if (state.playing) pause();
  else play();
}

function schedule(extra = 0) {
  clearTimeout(state.timer);
  state.timer = setTimeout(tick, state.durations[state.idx] + extra);
}

function tick() {
  if (!state.playing) return;
  if (state.idx >= state.chunks.length - 1) {
    pause();
    return;
  }
  state.idx++;
  render();
  schedule();
  if (Date.now() - state.lastSave > SAVE_INTERVAL) saveProgress();
}

function goTo(i) {
  if (!state.chunks.length) return;
  state.idx = Math.max(0, Math.min(state.chunks.length - 1, i));
  render();
  saveProgress();
}

function step(d) {
  pause();
  goTo(state.idx + d);
}

// 段落単位の移動。戻るときは、段落の途中なら先頭へ、先頭なら前の段落へ
function paraStep(d) {
  pause();
  const cs = state.chunks;
  const para = cs[state.idx]?.para;
  if (para == null) return;
  let i = state.idx;
  if (d > 0) {
    while (i < cs.length - 1 && cs[i].para === para) i++;
  } else {
    while (i > 0 && cs[i - 1].para === para) i--;
    if (i === state.idx && i > 0) {
      const prevPara = cs[i - 1].para;
      i--;
      while (i > 0 && cs[i - 1].para === prevPara) i--;
    }
  }
  goTo(i);
}

function changeSpeed(delta) {
  settings.cpm = Math.max(200, Math.min(4000, settings.cpm + delta));
  $('speed').value = settings.cpm;
  onSettingChanged('cpm');
  saveSettings();
}

async function saveProgress() {
  state.lastSave = Date.now();
  const c = state.chunks[state.idx];
  if (!state.meta || !c) return;
  const atEnd = state.idx === state.chunks.length - 1;
  state.meta.offset = atEnd ? state.book.totalChars : c.start;
  try {
    await store.updateBook(state.meta);
  } catch (e) {
    console.error(e);
  }
}

// 再生中は画面を消灯させない（対応端末のみ）
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (state.playing) state.wakeLock = lock;
    else lock.release().catch(() => {});
  } catch {
    // 取得できなくても再生は続ける
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

// ===== 設定の反映 =====
function bindSettings() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.dataset.type === 'string') v = el.value;
      else v = Number(el.value);
      settings[key] = v;
      // 同じ設定を持つ他の入力欄（速度など）も揃える
      for (const other of document.querySelectorAll(`[data-setting="${key}"]`)) {
        if (other !== el && other.type !== 'checkbox') other.value = v;
      }
      saveSettings();
      onSettingChanged(key);
    });
  }
  updateOutputs();
}

function updateOutputs() {
  for (const out of document.querySelectorAll('[data-out]')) {
    out.textContent = settings[out.dataset.out];
  }
}

function onSettingChanged(key) {
  updateOutputs();
  const hasBook = state.chunks.length > 0;
  if (key === 'group' || key === 'minChars') {
    if (hasBook) {
      rebuildChunks(state.chunks[state.idx].start);
      render();
    }
  } else if (key === 'cpm' || key === 'punctPause' || key === 'emphSlow') {
    recomputeDurations();
    if (hasBook) render();
  } else {
    applyDisplaySettings();
    if (hasBook) render();
  }
}

function applyDisplaySettings() {
  const stage = $('stage');
  stage.classList.toggle('vertical', settings.vertical);
  stage.classList.toggle('no-guide', !settings.guide);
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#1b1a18' : '#f3f1ec';
}

// ===== シート =====
let sheetOpenedAt = 0;

function openSheet(id) {
  closeSheets();
  $('backdrop').hidden = false;
  $(id).hidden = false;
  sheetOpenedAt = Date.now();
}

function closeSheets() {
  $('backdrop').hidden = true;
  for (const s of document.querySelectorAll('.sheet')) s.hidden = true;
}

function isSheetOpen() {
  return !$('backdrop').hidden;
}

function openChapters() {
  pause();
  const list = $('chapter-list');
  list.replaceChildren();
  const cur = currentChapter();
  // いちばん浅い見出しを字下げ 0 にする
  const minLevel = Math.min(...state.chapters.map((ch) => ch.level), 99);
  const top = { title: '（最初から）', idx: 0, level: minLevel };
  for (const ch of [top, ...state.chapters]) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ch.title;
    b.style.paddingLeft = `${4 + Math.max(0, ch.level - minLevel) * 16}px`;
    b.classList.toggle('sub', ch.level > minLevel);
    const page = pageAt(state.book.pages, state.chunks[ch.idx]?.start ?? 0);
    if (page && ch !== top) {
      const pg = document.createElement('span');
      pg.className = 'toc-page';
      pg.textContent = `p.${page}`;
      b.append(pg);
    }
    if (cur ? ch === cur : ch === top) b.classList.add('current');
    b.addEventListener('click', () => {
      closeSheets();
      goTo(ch.idx);
    });
    li.append(b);
    list.append(li);
  }
  openSheet('chapter-sheet');
}

// 本文全体を読みやすく組んで表示し、今の位置までスクロールする
function openContext() {
  pause();
  const c = state.chunks[state.idx];
  if (!c) return;
  const body = $('context-body');
  body.replaceChildren();
  // ページの始まり（字位置 → ページ番号）。段落の先頭で一致したら区切りを出す
  const pageStarts = new Map(state.book.pages.map((p) => [p.offset, p.label]));
  let curEl = null;

  state.book.paras.forEach((p, pi) => {
    const label = pageStarts.get(p.start);
    if (label) {
      const pg = document.createElement('div');
      pg.className = 'ctx-page';
      pg.textContent = `p.${label}`;
      body.append(pg);
    }
    const el = document.createElement(p.kind === 'heading' ? 'h3' : 'p');
    el.className = paraClass(p);
    el.dataset.para = pi;
    // 今のチャンクがこの段落にあれば、その範囲を色付けする
    const cur = pi === c.para ? [c.start - p.start, c.end - p.start] : null;
    el.append(...renderRich(p.text, settings.emphHighlight ? p.emph : [], cur));
    if (cur) curEl = el.querySelector('.current') ?? el;
    body.append(el);
  });

  openSheet('context-sheet');
  // 描画が終わってからスクロールする
  requestAnimationFrame(() => curEl?.scrollIntoView({ block: 'center' }));
}

// 段落の種類ごとの見た目（見出しの階層・箇条書き・図表の案内）
function paraClass(p) {
  if (p.kind === 'heading') {
    const t = p.text;
    if (/^(POINT|コラム|COLUMN)/.test(t)) return 'ctx-h ctx-box';
    return `ctx-h lv${Math.min(p.level, 6)}`;
  }
  if (p.text.startsWith('・')) return 'ctx-li';
  if (/^（図表/.test(p.text)) return 'ctx-fig';
  return 'ctx-p';
}

// 重要語（mark）と現在位置（span.current）を重ねて描画する
function renderRich(text, emph, cur) {
  const cuts = new Set([0, text.length]);
  for (const [s, e] of emph) cuts.add(s).add(e);
  if (cur) cuts.add(Math.max(0, cur[0])).add(Math.min(text.length, cur[1]));
  const points = [...cuts].sort((a, b) => a - b);
  const nodes = [];
  let curSpan = null;
  for (let k = 0; k < points.length - 1; k++) {
    const s = points[k];
    const e = points[k + 1];
    if (s >= e) continue;
    const piece = text.slice(s, e);
    const inEmph = emph.some(([es, ee]) => es <= s && e <= ee);
    const node = inEmph ? Object.assign(document.createElement('mark'), { textContent: piece }) : document.createTextNode(piece);
    if (cur && cur[0] <= s && e <= cur[1]) {
      if (!curSpan) {
        curSpan = document.createElement('span');
        curSpan.className = 'current';
        nodes.push(curSpan);
      }
      curSpan.append(node);
    } else {
      nodes.push(node);
    }
  }
  return nodes;
}

// タップした文字の位置（段落内の字数）を求める
function caretOffsetInPara(el, x, y) {
  let node;
  let offset;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return 0;
    node = pos.offsetNode;
    offset = pos.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return 0;
    node = r.startContainer;
    offset = r.startOffset;
  } else {
    return 0;
  }
  if (!el.contains(node)) return 0;
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

// ===== 操作 =====
function bindStageGestures() {
  const stage = $('stage');
  let sx = 0;
  let sy = 0;
  let active = false;
  let longTimer = 0;
  let longFired = false;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    active = true;
    sx = e.clientX;
    sy = e.clientY;
    longFired = false;
    clearTimeout(longTimer);
    longTimer = setTimeout(() => {
      longFired = true;
      openContext();
    }, 550);
  });
  stage.addEventListener('pointermove', (e) => {
    if (active && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(longTimer);
  });
  stage.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    clearTimeout(longTimer);
    if (longFired) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (Math.hypot(dx, dy) < 10) togglePlay();
  });
  stage.addEventListener('pointercancel', () => {
    active = false;
    clearTimeout(longTimer);
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSheets();
      return;
    }
    if ($('reader').hidden || isSheetOpen()) return;
    if (e.target instanceof Element && e.target.matches('input[type="text"], textarea, select')) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) paraStep(1);
        else step(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) paraStep(-1);
        else step(-1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        changeSpeed(100);
        break;
      case 'ArrowDown':
        e.preventDefault();
        changeSpeed(-100);
        break;
      case 'v':
      case 'V':
        settings.vertical = !settings.vertical;
        for (const el of document.querySelectorAll('[data-setting="vertical"]')) el.checked = settings.vertical;
        saveSettings();
        onSettingChanged('vertical');
        break;
    }
  });
  // フォーカス中のボタンが Space で押されて二重に切り替わるのを防ぐ
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && e.target instanceof HTMLButtonElement && !$('reader').hidden && !isSheetOpen()) {
      e.preventDefault();
    }
  });
}

function bindUi() {
  $('back-btn').addEventListener('click', showLibrary);
  $('title-btn').addEventListener('click', openChapters);
  $('settings-btn').addEventListener('click', () => {
    pause();
    openSheet('settings-sheet');
  });
  $('play').addEventListener('click', togglePlay);
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('prev-para').addEventListener('click', () => paraStep(-1));
  $('next-para').addEventListener('click', () => paraStep(1));

  const seek = $('seek');
  seek.addEventListener('input', () => {
    pause();
    state.idx = Number(seek.value);
    render();
  });
  seek.addEventListener('change', saveProgress);

  // 長押しで開いた直後、指を離したタップで閉じてしまわないようにする
  $('backdrop').addEventListener('click', () => {
    if (Date.now() - sheetOpenedAt > 400) closeSheets();
  });
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeSheets);

  // 本文のタップした文字の位置から再開する
  $('context-body').addEventListener('click', (e) => {
    const el = e.target.closest('[data-para]');
    if (!el) return;
    const p = state.book.paras[Number(el.dataset.para)];
    const local = p.kind === 'heading' ? 0 : caretOffsetInPara(el, e.clientX, e.clientY);
    closeSheets();
    goTo(indexForOffset(p.start + Math.min(local, p.text.length - 1)));
  });

  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = await readTextFile(file);
      if (await addBookFromText(raw, { fallbackTitle: file.name.replace(/\.[^.]+$/, '') })) await renderLibrary();
    } catch (err) {
      alert('読み込みに失敗しました: ' + err.message);
    }
  });

  $('paste-btn').addEventListener('click', () => {
    $('paste-title').value = '';
    $('paste-text').value = '';
    openSheet('paste-sheet');
  });
  $('paste-save').addEventListener('click', async () => {
    const raw = $('paste-text').value;
    if (await addBookFromText(raw, { overrideTitle: $('paste-title').value.trim() })) {
      closeSheets();
      await renderLibrary();
    }
  });

  $('sample-btn').addEventListener('click', openSampleList);

  // アプリを離れたら停止して位置を保存
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  // 画面回転・サイズ変更で文字の収まりを再計算
  window.addEventListener('resize', () => {
    if (!$('reader').hidden) render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyDisplaySettings);
}

// ===== 表示用フォーマット =====
function fmtNum(n) {
  return n.toLocaleString('ja-JP');
}

function fmtTime(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ===== 起動 =====
async function init() {
  bindSettings();
  bindUi();
  bindStageGestures();
  bindKeys();
  applyDisplaySettings();

  // iOS でホーム画面に追加されていなければ案内を出す
  if (navigator.standalone === false && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    $('install-note').hidden = false;
  }
  // データを自動削除しないよう要求（対応ブラウザのみ）
  navigator.storage?.persist?.().catch(() => {});

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }

  // 初回だけ、一覧のいちばん古いサンプルを入れておく
  try {
    const books = await store.listBooks();
    if (!books.length && !localStorage.getItem(SAMPLE_FLAG_KEY)) {
      const samples = await fetchSampleIndex();
      if (samples.length) await addSample(samples[samples.length - 1]);
      localStorage.setItem(SAMPLE_FLAG_KEY, '1');
    }
  } catch (err) {
    console.error(err);
  }
  await renderLibrary();
}

init();
