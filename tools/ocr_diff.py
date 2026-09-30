"""文字起こし（books/*.txt）と OCR 結果（ocr_work/<作業名>/ocr_NNN.txt）を突き合わせる。

  python tools/ocr_diff.py <文字起こし.txt> <作業名> <開始ページ> <終了ページ> [--context 8]

記号・空白・読点の違い（，と、）、見出し記号、【】、%p 行は無視して、
本文の文字が食い違う箇所だけを一覧にする。食い違いごとに画像で確認して、
OCR 側の誤りか、文字起こし側の誤りかを判断する。

出力の見方:
  [OCRのみ] … OCR にあって文字起こしにない（柱・ページ番号なら正常。本文なら書き漏れ）
  [起こしのみ] … 文字起こしにあって OCR にない（OCR の読み落とし、または書き足しすぎ）
  [相違] … 両方にあるが文字が違う（誤字の候補）
"""
import argparse
import difflib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 比較から外す文字（空白・句読点・括弧・記号類）
IGNORE_RE = re.compile(r"[\s，、,。．.・:：;；「」『』（）()\[\]【】〔〕｛｝{}<>＜＞〈〉《》\"'‘’“”!！?？\-−―ー～〜~/／|｜*＊#＃%％@＠^＾_＿…‥]")


def normalize(text: str) -> str:
    text = text.translate(str.maketrans(
        "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ",
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"))
    return IGNORE_RE.sub("", text)


def load_transcript(path: Path) -> str:
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("%p"):
            continue
        if s.startswith("# ") and not lines:
            continue  # 書名行は原本にないので除く
        lines.append(re.sub(r"^#{1,6}\s+", "", s))
    return normalize("".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("name")
    ap.add_argument("start", type=int)
    ap.add_argument("end", type=int)
    ap.add_argument("--context", type=int, default=8)
    args = ap.parse_args()

    ocr_dir = ROOT / "ocr_work" / args.name
    ocr = normalize("".join(
        (ocr_dir / f"ocr_{p:03d}.txt").read_text(encoding="utf-8")
        for p in range(args.start, args.end + 1)
    ))
    mine = load_transcript(Path(args.transcript))

    sm = difflib.SequenceMatcher(None, ocr, mine, autojunk=False)
    c = args.context
    count = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        count += 1
        label = {"delete": "OCRのみ", "insert": "起こしのみ", "replace": "相違"}[tag]
        before = mine[max(0, j1 - c):j1]
        after = mine[j2:j2 + c]
        print(f"[{label}] …{before}〔OCR:{ocr[i1:i2]} ／ 起こし:{mine[j1:j2]}〕{after}…")
    print(f"一致率 {sm.ratio():.4f}  食い違い {count} 件（OCR {len(ocr)}字 / 起こし {len(mine)}字）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
