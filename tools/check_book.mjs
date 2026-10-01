// 参考書の文字起こしファイル（books/*.txt）を検査する。
//
//   node tools/check_book.mjs books/xxx.txt          … 検査のみ
//   node tools/check_book.mjs books/xxx.txt --fix    … 機械的に直せるもの（，→、 など）を直してから検査
//
// NG が1件でもあれば終了コード 1。WARN は目視確認を促すもの。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseBook } = await import(pathToFileURL(join(ROOT, 'js', 'chunker.js')).href);
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

const [arg, flag] = process.argv.slice(2);
if (!arg) {
  console.error('使い方: node tools/check_book.mjs books/xxx.txt [--fix]');
  process.exit(1);
}
const path = resolve(arg);
let raw = readFileSync(path, 'utf8');
const ng = [];
const warn = [];

// ---- 機械的な整形（--fix） ----
if (flag === '--fix') {
  const before = raw;
  raw = raw
    .replace(/\r\n?/g, '\n')
    .replace(/，/g, '、')
    .replace(/^・(\d+)[．.。](?!\d)\s*/gm, '・$1 ') // 番号付き箇条書き「・1．」→「・1 」（句点にしない）
    .replace(/．/g, '。')
    .replace(/[ 　]+$/gm, ''); // 行末の空白
  if (raw !== before) {
    writeFileSync(path, raw, 'utf8');
    console.log('FIX: 「，」→「、」「．」→「。」、「・1．」→「・1 」、行末の空白を整形しました');
  }
}

// ---- GitHub に上がらない場所か ----
try {
  execFileSync(GIT, ['check-ignore', '-q', relative(ROOT, path)], { cwd: ROOT });
} catch {
  ng.push('このファイルは .gitignore の対象外です（GitHub に公開されてしまう）。books/ に置いてください');
}

const lines = raw.replace(/\r\n?/g, '\n').split('\n');

// ---- 行ごとの検査 ----
if (!/^# \S/.test(lines[0] ?? '')) ng.push('1行目が「# 書名」になっていません');
let prevLevel = 1;
let prevPage = null;
lines.forEach((line, i) => {
  const n = i + 1;
  const s = line.trim();
  if (!s) return;
  if (/[，．]/.test(s)) warn.push(`${n}行: 「，」「．」が残っています（--fix で変換できます）`);
  if (/[©®π⑩�]/.test(s)) warn.push(`${n}行: OCR の文字化けらしき記号があります: ${s.slice(0, 30)}`);
  if (/^\d{1,4}$/.test(s)) warn.push(`${n}行: 数字だけの行（ページ番号の消し忘れ？）`);
  const open = (s.match(/【/g) ?? []).length;
  const close = (s.match(/】/g) ?? []).length;
  if (open !== close) ng.push(`${n}行: 【 と 】 の数が合いません`);

  const pg = s.match(/^%p[ 　]*(\S+)$/);
  if (s.startsWith('%p') && !pg) ng.push(`${n}行: ページ行の書式が違います（例: %p 12）`);
  if (pg) {
    const num = Number(pg[1]);
    if (Number.isFinite(num) && prevPage !== null && num <= prevPage) ng.push(`${n}行: ページ番号が増えていません（${prevPage} → ${num}）`);
    if (Number.isFinite(num)) prevPage = num;
  }

  const h = s.match(/^(#{1,6})[ 　]+(.+)$/);
  if (h && i > 0) {
    const level = h[1].length;
    if (level > prevLevel + 1) warn.push(`${n}行: 見出しの階層が ${prevLevel} → ${level} に飛んでいます: ${h[2].slice(0, 20)}`);
    prevLevel = level;
  } else if (/^#/.test(s) && i > 0) {
    ng.push(`${n}行: # の後に空白がありません（見出しとして認識されない）`);
  }
});

// ---- 集計 ----
const book = parseBook(raw);
const emphCount = book.paras.reduce((a, p) => a + p.emph.length, 0);
const headings = book.paras.filter((p) => p.kind === 'heading').length;
if (!book.pages.length) warn.push('ページ行（%p）が1つもありません');
const mins = (cpm) => Math.round(book.totalChars / cpm);

console.log(`書名: ${book.title}`);
console.log(`字数 ${book.totalChars} / 段落 ${book.paras.length} / 見出し ${headings} / 重要語 ${emphCount} / ページ ${book.pages.map((p) => p.label).join(',')}`);
console.log(`所要時間の目安: 500字/分で約${mins(500)}分、800字/分で約${mins(800)}分`);
for (const w of warn) console.log('WARN: ' + w);
for (const e of ng) console.log('NG: ' + e);
if (ng.length) process.exit(1);
console.log(warn.length ? `OK（WARN ${warn.length} 件は目視で確認）` : 'OK');
