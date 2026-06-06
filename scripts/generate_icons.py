#!/usr/bin/env python3
"""Generate AgentZ app icons from assets/icon-source.png."""

from __future__ import annotations

import struct
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None  # type: ignore

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"
SOURCE = ROOT / "assets" / "icon-source.png"
PUBLIC_FAVICON = ROOT / "public" / "favicon.png"

# ~macOS squircle approximation for full-bleed icons
CORNER_RATIO = 0.2


def load_source() -> "Image.Image":
    img = Image.open(SOURCE).convert("RGBA")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def resize(img: "Image.Image", size: int) -> "Image.Image":
    if img.size[0] == size:
        return img.copy()
    return img.resize((size, size), Image.Resampling.LANCZOS)


def apply_rounded_corners(img: "Image.Image", radius_ratio: float = CORNER_RATIO) -> "Image.Image":
    size = img.size[0]
    radius = max(2, int(size * radius_ratio))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def render_icon(size: int, rounded: bool = True) -> "Image.Image":
    base = resize(load_source(), size)
    return apply_rounded_corners(base) if rounded else base


def render_android_foreground(size: int) -> "Image.Image":
    """Adaptive icon foreground: logo centered in safe zone on transparent bg."""
    base = resize(load_source(), size)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = int(size * 0.12)
    inner = size - inset * 2
    scaled = resize(base, inner)
    canvas.paste(scaled, (inset, inset))
    return canvas


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

    ic08 = entry(b"ic08", png)
    is32 = entry(b"is32", png)
    body = ic08 + is32
    icns = b"icns" + struct.pack(">I", 8 + len(body)) + body
    path.write_bytes(icns)
    png_path.unlink(missing_ok=True)


def main() -> None:
    if Image is None:
        raise SystemExit("Pillow required: pip install Pillow")
    if not SOURCE.exists():
        raise SystemExit(f"Source image missing: {SOURCE}")

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
        "StoreLogo.png": 150,
    }
    ICONS.mkdir(parents=True, exist_ok=True)
    for name, px in sizes.items():
        render_icon(px).save(ICONS / name, format="PNG")
        print(f"wrote {name}")

    write_ico(ICONS / "icon.ico", [16, 32, 48, 64, 128, 256])
    print("wrote icon.ico")
    write_icns(ICONS / "icon.icns")
    print("wrote icon.icns")

    ios_sizes = {
        "AppIcon-20x20@1x.png": 20,
        "AppIcon-20x20@2x.png": 40,
        "AppIcon-20x20@2x-1.png": 40,
        "AppIcon-20x20@3x.png": 60,
        "AppIcon-29x29@1x.png": 29,
        "AppIcon-29x29@2x.png": 58,
        "AppIcon-29x29@2x-1.png": 58,
        "AppIcon-29x29@3x.png": 87,
        "AppIcon-40x40@1x.png": 40,
        "AppIcon-40x40@2x.png": 80,
        "AppIcon-40x40@2x-1.png": 80,
        "AppIcon-40x40@3x.png": 120,
        "AppIcon-60x60@2x.png": 120,
        "AppIcon-60x60@3x.png": 180,
        "AppIcon-76x76@1x.png": 76,
        "AppIcon-76x76@2x.png": 152,
        "AppIcon-83.5x83.5@2x.png": 167,
        "AppIcon-512@2x.png": 1024,
    }
    ios_dir = ICONS / "ios"
    ios_dir.mkdir(parents=True, exist_ok=True)
    for name, px in ios_sizes.items():
        render_icon(px, rounded=False).save(ios_dir / name, format="PNG")
        print(f"wrote ios/{name}")

    android_launcher = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    android_foreground = {
        "mipmap-mdpi": 108,
        "mipmap-hdpi": 162,
        "mipmap-xhdpi": 216,
        "mipmap-xxhdpi": 324,
        "mipmap-xxxhdpi": 432,
    }
    for folder, px in android_launcher.items():
        d = ICONS / "android" / folder
        d.mkdir(parents=True, exist_ok=True)
        icon = render_icon(px)
        icon.save(d / "ic_launcher.png", format="PNG")
        icon.save(d / "ic_launcher_round.png", format="PNG")
        print(f"wrote android/{folder}/ic_launcher*.png")

    for folder, px in android_foreground.items():
        d = ICONS / "android" / folder
        d.mkdir(parents=True, exist_ok=True)
        render_android_foreground(px).save(d / "ic_launcher_foreground.png", format="PNG")
        print(f"wrote android/{folder}/ic_launcher_foreground.png")

    favicon = render_icon(32)
    PUBLIC_FAVICON.parent.mkdir(parents=True, exist_ok=True)
    favicon.save(PUBLIC_FAVICON, format="PNG")
    print("wrote public/favicon.png")


if __name__ == "__main__":
    main()
