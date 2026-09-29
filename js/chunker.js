// 本文テキストの解析と、フラッシュ表示用チャンクの生成
import { Parser } from '../lib/budoux/parser.js';
import { model } from '../lib/budoux/ja.js';

const parser = new Parser(model);

// 重要語の記法: 【語】 または **語**
const EMPH_RE = /【([^【】\n]+)】|\*\*([^*\n]+?)\*\*/g;
// 見出し記法: "# " "## " "### "
const HEADING_RE = /^(#{1,3})[ 　]+(.+)$/;
// 文末（ここを越えてまとめない）
const HARD_END_RE = /[。．！？!?」』]$/;
// 読点類（最小字数を満たしていればここで区切る）
const SOFT_END_RE = /[、，,；;：:]$/;
// 単独で1文節にしたくない記号（閉じ側は前へ、開き側は後ろへくっつける）
const CLOSE_ONLY_RE = /^[、。，．,.！？!?」』）)\]】…‥ー〜]+$/;
const OPEN_ONLY_RE = /^[「『（(\[【]+$/;
// 1チャンクの最大字数（まとめすぎ防止）
const MAX_CHARS = 20;

/**
 * 本文を段落単位に解析する。
 * - 1行目の "# タイトル" は書名として扱う
 * - "## 章" などは見出し段落
 * - それ以外の空でない行は1行=1段落
 * - 青空文庫形式のルビ（｜ 《》）は除去する
 * @returns {{title: string, paras: Array, totalChars: number}}
 */
export function parseBook(raw) {
  const text = raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/｜/g, '')
    .replace(/《[^》\n]*》/g, '');
  let title = '';
  const paras = [];
  let offset = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = line.match(HEADING_RE);
    if (h) {
      const body = extractEmph(h[2]).plain.trim();
      if (!body) continue;
      if (h[1].length === 1 && !title && paras.length === 0) {
        title = body;
        continue;
      }
      paras.push({ kind: 'heading', text: body, emph: [], start: offset });
      offset += body.length;
      continue;
    }
    const { plain, emph } = extractEmph(line);
    if (!plain) continue;
    paras.push({ kind: 'text', text: plain, emph, start: offset });
    offset += plain.length;
  }
  return { title, paras, totalChars: offset };
}

// 重要語の記号を外し、段落内での位置 [開始, 終了) を記録する
function extractEmph(line) {
  let plain = '';
  let last = 0;
  const emph = [];
  for (const m of line.matchAll(EMPH_RE)) {
    plain += line.slice(last, m.index);
    const term = m[1] ?? m[2];
    emph.push([plain.length, plain.length + term.length]);
    plain += term;
    last = m.index + m[0].length;
  }
  plain += line.slice(last);
  return { plain, emph };
}

/**
 * 段落を BudouX で文節（ユニット）に分割する。
 * 重要語の内部では区切らない。
 */
export function buildUnits(book) {
  const units = [];
  book.paras.forEach((p, pi) => {
    if (p.kind === 'heading') {
      units.push({ text: p.text, start: p.start, emph: [], kind: 'heading', para: pi });
      return;
    }
    const bounds = parser
      .parseBoundaries(p.text)
      .filter((b) => !p.emph.some(([s, e]) => s < b && b < e));
    bounds.push(p.text.length);

    // 記号だけの断片を前後にくっつけながら区切り位置を確定する
    const ranges = [];
    let prev = 0;
    let pendingOpen = -1;
    for (const b of bounds) {
      const s = pendingOpen >= 0 ? pendingOpen : prev;
      const piece = p.text.slice(prev, b);
      prev = b;
      if (OPEN_ONLY_RE.test(piece) && b < p.text.length) {
        pendingOpen = s;
        continue;
      }
      const hadOpen = pendingOpen >= 0;
      pendingOpen = -1;
      // 開き記号を抱えている場合は前へ寄せない（開き記号が抜け落ちるのを防ぐ）
      if (!hadOpen && CLOSE_ONLY_RE.test(piece) && ranges.length) {
        ranges[ranges.length - 1][1] = b;
        continue;
      }
      ranges.push([s, b]);
    }

    for (const [s, e] of ranges.flatMap(([s, e]) => splitLong(p.text, s, e))) {
      units.push({
        text: p.text.slice(s, e),
        start: p.start + s,
        kind: 'text',
        para: pi,
        emph: p.emph
          .filter(([es, ee]) => es < e && ee > s)
          .map(([es, ee]) => [Math.max(es, s) - s, Math.min(ee, e) - s]),
      });
    }
  });
  return units;
}

/**
 * MAX_CHARS を超える区間（英文など BudouX が区切らない部分）を分割する。
 * 空白の位置で SPLIT_TARGET 字程度ずつ区切り、空白のない長い語は機械的に切る。
 */
const SPLIT_TARGET = 12;
function splitLong(text, s, e) {
  if (e - s <= MAX_CHARS) return [[s, e]];
  const out = [];
  let cs = s; // 未確定区間の開始
  let cur = s;
  for (const tok of text.slice(s, e).match(/\S+\s*|\s+/g)) {
    let ts = cur;
    const te = cur + tok.length;
    cur = te;
    while (te - ts > MAX_CHARS) {
      if (ts > cs) out.push([cs, ts]);
      out.push([ts, ts + SPLIT_TARGET]);
      ts += SPLIT_TARGET;
      cs = ts;
    }
    if (te - cs > SPLIT_TARGET && ts > cs) {
      out.push([cs, ts]);
      cs = ts;
    }
  }
  if (cs < e) out.push([cs, e]);
  return out;
}

/**
 * 文節を表示単位（チャンク）にまとめる。
 * @param {Array} units buildUnits の結果
 * @param {{group: number, minChars: number}} opts
 *   group: 何文節ずつまとめるか / minChars: 1チャンクの最小字数
 */
export function buildChunks(units, { group = 1, minChars = 0 }) {
  const groups = [];
  let cur = null;
  let curLen = 0;

  for (const u of units) {
    if (u.kind === 'heading') {
      if (cur) groups.push(cur);
      groups.push([u]);
      cur = null;
      continue;
    }
    if (cur) {
      const last = cur[cur.length - 1];
      const need = cur.length < group || curLen < minChars;
      const canJoin =
        last.para === u.para &&
        !HARD_END_RE.test(last.text) &&
        !(SOFT_END_RE.test(last.text) && curLen >= minChars) &&
        curLen + u.text.length <= MAX_CHARS;
      if (need && canJoin) {
        cur.push(u);
        curLen += u.text.length;
        continue;
      }
      groups.push(cur);
    }
    cur = [u];
    curLen = u.text.length;
  }
  if (cur) groups.push(cur);

  // 最小字数に届かない末尾（例:「た。」）は、同じ文の直前チャンクに寄せる
  const merged = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    const len = textLen(g);
    if (
      prev &&
      len < minChars &&
      g[0].kind === 'text' &&
      prev[0].kind === 'text' &&
      prev[0].para === g[0].para &&
      !HARD_END_RE.test(prev[prev.length - 1].text) &&
      textLen(prev) + len <= MAX_CHARS
    ) {
      prev.push(...g);
    } else {
      merged.push(g);
    }
  }

  return merged.map((g, i) => toChunk(g, merged[i + 1]));
}

function textLen(g) {
  return g.reduce((n, u) => n + u.text.length, 0);
}

// ユニット列を1つのチャンクオブジェクトにする
function toChunk(g, next) {
  const first = g[0];
  let text = '';
  const emph = [];
  for (const u of g) {
    for (const [s, e] of u.emph) emph.push([text.length + s, text.length + e]);
    text += u.text;
  }
  // pause: 0=なし 1=読点 2=文末 3=段落末
  let pause = 0;
  if (first.kind === 'text') {
    if (!next || next[0].para !== first.para) pause = 3;
    else if (HARD_END_RE.test(text)) pause = 2;
    else if (SOFT_END_RE.test(text)) pause = 1;
  }
  return {
    text,
    start: first.start,
    end: first.start + text.length,
    emph,
    kind: first.kind,
    para: first.para,
    pause,
  };
}

/**
 * チャンクの表示時間（ミリ秒）。
 * @param {{cpm: number, punctPause: boolean, emphSlow: boolean}} s
 *   cpm: 1分あたりの字数
 */
export function chunkDuration(c, s) {
  const msPerChar = 60000 / s.cpm;
  let chars = Math.max(c.text.replace(/\s/g, '').length, 2);
  if (c.kind === 'heading') chars += 8;
  else if (s.punctPause) chars += [0, 1.5, 3, 5][c.pause];
  let ms = chars * msPerChar;
  if (s.emphSlow && c.emph.length) ms *= 1.5;
  return Math.max(ms, 60);
}
