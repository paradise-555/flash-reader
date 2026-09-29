// サンプル短編を samples/index.json に登録する。
//
//   node tools/add_sample.mjs samples/xxx.txt   … 登録（既にあれば題名と字数を更新）
//   node tools/add_sample.mjs --check           … 一覧と実ファイルの整合チェックのみ
//
// 字数はアプリと同じ parseBook で数えるので、アプリの表示と一致する。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'samples');
const INDEX = join(SAMPLES, 'index.json');
const FILE_RE = /^[a-z0-9][a-z0-9_-]*\.txt$/;

const { parseBook } = await import(pathToFileURL(join(ROOT, 'js', 'chunker.js')).href);

function fail(msg) {
  console.error('NG: ' + msg);
  process.exit(1);
}

function loadIndex() {
  const data = JSON.parse(readFileSync(INDEX, 'utf8'));
  if (!Array.isArray(data.samples)) fail('index.json に samples 配列がありません');
  return data;
}

// 本文を検査して { title, chars } を返す
function inspect(file) {
  const path = join(SAMPLES, file);
  if (!existsSync(path)) fail(`${file} が samples/ にありません`);
  const raw = readFileSync(path, 'utf8');
  const book = parseBook(raw);
  if (!book.title) fail(`${file} の1行目に「# 題名」がありません`);
  if (!book.totalChars) fail(`${file} の本文が空です`);
  return { title: book.title, chars: book.totalChars };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function check(data) {
  let bad = 0;
  const seen = new Set();
  for (const s of data.samples) {
    if (seen.has(s.file)) {
      console.error(`NG: ${s.file} が重複しています`);
      bad++;
    }
    seen.add(s.file);
    const { title, chars } = inspect(s.file);
    if (s.title !== title || s.chars !== chars) {
      console.error(`NG: ${s.file} 一覧=${s.title}/${s.chars}字  実際=${title}/${chars}字`);
      bad++;
    } else {
      console.log(`OK: ${s.file}  ${title}（${chars}字）`);
    }
  }
  return bad;
}

const arg = process.argv[2];
if (!arg) fail('使い方: node tools/add_sample.mjs samples/xxx.txt  または  --check');

const data = loadIndex();

if (arg !== '--check') {
  const file = basename(arg);
  if (!FILE_RE.test(file)) fail(`ファイル名は半角英小文字・数字・_- の .txt にしてください: ${file}`);
  const { title, chars } = inspect(file);
  const dup = data.samples.find((s) => s.title === title && s.file !== file);
  if (dup) fail(`同じ題名の作品が既にあります: ${dup.file}`);
  const entry = data.samples.find((s) => s.file === file);
  if (entry) {
    entry.title = title;
    entry.chars = chars;
    console.log(`更新: ${file}  ${title}（${chars}字）`);
  } else {
    data.samples.push({ file, title, chars, added: today() });
    console.log(`追加: ${file}  ${title}（${chars}字）`);
  }
  writeFileSync(INDEX, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const bad = check(data);
if (bad) fail(`${bad} 件の不整合があります`);
console.log(`一覧 ${data.samples.length} 作品、すべて整合しています`);
