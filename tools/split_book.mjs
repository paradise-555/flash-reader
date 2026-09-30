// 部ごとの文字起こし（books/<名前>.txt）を、章ごとのファイルに分ける。
//
//   node tools/split_book.mjs books/bm_part2.txt --folder ビジネスマネジャー --part 2 --out bm_p2
//
// - "## 第N章 …" の見出しで区切り、books/<out>_chNN.txt に書き出す（章がない部は books/<out>.txt 1つ）
// - 各ファイルの先頭に書名「# 第N部 第N章 章題」と、アプリ用の "%folder" "%order"（部×100＋章）を入れる
// - 章の途中から始まらないよう、章の直前にあるページ行（%p）は章の側へ移し、無ければ直前のページを補う
// - 書き出したファイルは tools/check_book.mjs で検査する
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const src = process.argv[2];
const folder = arg('--folder');
const part = Number(arg('--part'));
const out = arg('--out');
if (!src || !folder || !part || !out) {
  console.error('使い方: node tools/split_book.mjs books/<部>.txt --folder <フォルダ名> --part <部番号> --out <出力名>');
  process.exit(1);
}

const lines = readFileSync(resolve(src), 'utf8').replace(/\r\n?/g, '\n').split('\n');
const titleLine = lines.findIndex((l) => /^# \S/.test(l));
if (titleLine < 0) {
  console.error('NG: 1行目に「# 書名」がありません');
  process.exit(1);
}
// 部の題（「第N部 」より後ろ）
const partTitle = (lines[titleLine].match(/第\d+部\s+(.+)$/) ?? [])[1] ?? '';
const body = lines.slice(titleLine + 1).filter((l) => !/^%(folder|order)\b/.test(l.trim()));

// 章の開始位置
const starts = [];
body.forEach((l, i) => {
  const m = l.match(/^## 第(\d+)章[ 　]+(.+)$/);
  if (m) starts.push({ i, no: Number(m[1]), title: m[2].trim() });
});

const PAGE = /^%p[ 　]*(\S+)$/;
const written = [];

function write(file, header, bodyLines) {
  const text = [...header, '', ...bodyLines].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const path = join(ROOT, 'books', file);
  writeFileSync(path, text, 'utf8');
  written.push(path);
}

if (!starts.length) {
  // 章がない部（例: 第1部）は1ファイル
  write(`${out}.txt`, [`# 第${part}部 ${partTitle}`, `%folder ${folder}`, `%order ${part * 100}`], body);
} else {
  let lastPage = null;
  // 章の直前に並んでいるページ行は、次の章の頭へ移す
  const cut = starts.map(({ i }) => {
    let j = i;
    while (j > 0 && (PAGE.test(body[j - 1].trim()) || !body[j - 1].trim())) j--;
    return j;
  });
  cut.forEach((from, k) => {
    const to = k + 1 < cut.length ? cut[k + 1] : body.length;
    // 章より前の部分（部の概要など）は第1章に含める
    const chunk = body.slice(k === 0 ? 0 : from, to);
    // この章より前で最後に出てきたページ
    for (let x = 0; x < (k === 0 ? 0 : from); x++) {
      const m = body[x].trim().match(PAGE);
      if (m) lastPage = m[1];
    }
    const firstContent = chunk.find((l) => l.trim());
    if (lastPage && firstContent && !PAGE.test(firstContent.trim())) chunk.unshift(`%p ${lastPage}`);
    const { no, title } = starts[k];
    const header = [`# 第${part}部 第${no}章 ${title}`, `%folder ${folder}`, `%order ${part * 100 + no}`];
    write(`${out}_ch${String(no).padStart(2, '0')}.txt`, header, chunk);
    lastPage = null;
  });
}

// 検査（NG があれば止める）
let ng = 0;
for (const p of written) {
  try {
    const res = execFileSync(process.execPath, [join(ROOT, 'tools', 'check_book.mjs'), p], { encoding: 'utf8' });
    const head = res.split('\n').slice(0, 2).join(' / ');
    console.log(`OK: ${p.split(/[\\/]/).pop()}  ${head}`);
  } catch (e) {
    ng++;
    console.log(`NG: ${p.split(/[\\/]/).pop()}\n${e.stdout}`);
  }
}
process.exit(ng ? 1 : 0);
