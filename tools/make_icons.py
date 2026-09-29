"""アプリアイコン（PNG）を生成する。  python tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
FONT = "C:/Windows/Fonts/yumindb.ttf"  # 游明朝 Demibold
BG = (176, 57, 43)
FG = (243, 241, 236)


def make(size: int, radius_ratio: float) -> Image.Image:
    s = 4  # 4倍で描いて縮小（アンチエイリアス）
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * radius_ratio), fill=BG)
    # 注視点ガイド（上下の縦線）
    w, h = n * 0.02, n * 0.12
    cx = n / 2
    d.rounded_rectangle([cx - w / 2, n * 0.14, cx + w / 2, n * 0.14 + h], radius=w / 2, fill=FG)
    d.rounded_rectangle([cx - w / 2, n * 0.86 - h, cx + w / 2, n * 0.86], radius=w / 2, fill=FG)
    # 「速」
    font = ImageFont.truetype(FONT, int(n * 0.42))
    d.text((cx, n / 2), "速", font=font, fill=FG, anchor="mm")
    return img.resize((size, size), Image.LANCZOS)


# iOS は角丸を自動でかけるので 180 は角丸なし（全面塗り）
make(180, 0).convert("RGB").save(OUT / "icon-180.png")
make(192, 0.22).save(OUT / "icon-192.png")
make(512, 0.22).save(OUT / "icon-512.png")
print("ok")
