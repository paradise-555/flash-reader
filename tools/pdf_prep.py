"""参考書 PDF を文字起こし用に下ごしらえする。

  python tools/pdf_prep.py <作業名> <スキャンPDF> [OCR済みPDF] [--dpi 200]

出力先: ocr_work/<作業名>/ （.gitignore 済み。GitHub には上がらない）
  page_001.png …  各ページの画像（Claude が読み取る）
  ocr_001.txt  …  OCR 済み PDF の文字データ（突き合わせ用。無い場合は作らない）
  info.txt        ページ数などの情報

依存: pypdfium2（pip install --user pypdfium2）
"""
import argparse
import sys
from pathlib import Path

import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "ocr_work"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("name", help="作業名（半角英数字・_-。例: bm_part1）")
    ap.add_argument("scan", help="スキャン PDF")
    ap.add_argument("ocr", nargs="?", help="OCR 済み PDF（任意）")
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    out = WORK / args.name
    out.mkdir(parents=True, exist_ok=True)

    scan = pdfium.PdfDocument(args.scan)
    n = len(scan)
    scale = args.dpi / 72
    for i in range(n):
        img = scan[i].render(scale=scale).to_pil()
        img.save(out / f"page_{i + 1:03d}.png")

    ocr_n = 0
    if args.ocr:
        ocr = pdfium.PdfDocument(args.ocr)
        ocr_n = len(ocr)
        if ocr_n != n:
            print(f"注意: ページ数が違います（スキャン {n} / OCR {ocr_n}）", file=sys.stderr)
        for i in range(ocr_n):
            text = ocr[i].get_textpage().get_text_range()
            (out / f"ocr_{i + 1:03d}.txt").write_text(text, encoding="utf-8")

    (out / "info.txt").write_text(
        f"scan={Path(args.scan).name}\nocr={Path(args.ocr).name if args.ocr else ''}\n"
        f"pages={n}\nocr_pages={ocr_n}\ndpi={args.dpi}\n",
        encoding="utf-8",
    )
    print(f"OK: {out}  ページ {n}  OCR {ocr_n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
