#!/usr/bin/env python3
"""Generate AgentZ app icons — purple rounded square with white Z."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None  # type: ignore

ROOT = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
ACCENT = (124, 106, 247, 255)
WHITE = (255, 255, 255, 255)


def render_icon(size: int) -> "Image.Image":
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = max(2, size // 8)
    radius = max(4, size // 5)
    draw.rounded_rectangle(
        [margin, margin, size - margin - 1, size - margin - 1],
        radius=radius,
        fill=ACCENT,
    )
    stroke = max(2, size // 10)
    z_left = margin + size // 5
    z_right = size - margin - size // 5
    z_top = margin + size // 6
    z_bot = size - margin - size // 6
    for w in range(stroke):
        o = w - stroke // 2
        draw.line([(z_left, z_top + o), (z_right, z_top + o)], fill=WHITE, width=1)
        draw.line([(z_right + o, z_top), (z_left + o, z_bot)], fill=WHITE, width=1)
        draw.line([(z_left, z_bot + o), (z_right, z_bot + o)], fill=WHITE, width=1)
    return img


def write_ico(path: Path, sizes: list[int]) -> None:
    images = [render_icon(s) for s in sizes]
    images[0].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=images[1:])


def write_icns(path: Path, size: int = 512) -> None:
    """Write a minimal icns with one 512x512 PNG entry (is32 / ic08)."""
    png_path = path.parent / "_icns_master.png"
    render_icon(size).save(png_path, format="PNG")
    png = png_path.read_bytes()

    def entry(type_code: bytes, data: bytes) -> bytes:
        length = 8 + len(data)
        pad = (4 - (length % 4)) % 4
        return type_code + struct.pack(">I", length + pad) + data + (b"\x00" * pad)

    icns = b"icns" + struct.pack(">I", 8)
    ic08 = entry(b"ic08", png)
    is32 = entry(b"is32", png)
    body = ic08 + is32
    icns = b"icns" + struct.pack(">I", 8 + len(body)) + body
    path.write_bytes(icns)
    png_path.unlink(missing_ok=True)


def main() -> None:
    if Image is None:
        raise SystemExit("Pillow required: pip install Pillow")

    sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
    }
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, px in sizes.items():
        render_icon(px).save(ROOT / name, format="PNG")
        print(f"wrote {name}")

    write_ico(ROOT / "icon.ico", [16, 32, 48, 64, 128, 256])
    print("wrote icon.ico")
    write_icns(ROOT / "icon.icns")
    print("wrote icon.icns")


if __name__ == "__main__":
    main()
