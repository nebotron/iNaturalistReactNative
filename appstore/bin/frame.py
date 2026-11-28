#!/usr/bin/env python3
"""Turns raw simulator screenshots into App Store images: a caption over a
gradient, with the screenshot scaled down beneath it in rounded corners. The
output is the same size as the raw screenshot, which config.json's
screenshot_size pins to what App Store Connect accepts.

    frame.py appstore/config.json RAW_DIR OUT_DIR
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def gradient(size: tuple[int, int], top: str, bottom: str) -> Image.Image:
    width, height = size
    a, b = hex_rgb(top), hex_rgb(bottom)
    column = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / (height - 1)
        column.putpixel((0, y), tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    return column.resize((width, height))


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for word in text.split():
        trial = f"{lines[-1]} {word}" if lines else word
        if lines and draw.textlength(trial, font=font) <= max_width:
            lines[-1] = trial
        else:
            lines.append(word)
    return lines


def frame(config: dict, raw: Path, caption: str) -> Image.Image:
    style = config["frame"]
    size = tuple(config["screenshot_size"])
    width, height = size
    shot = Image.open(raw).convert("RGB")
    if shot.size != size:
        sys.exit(f"{raw}: {shot.size}, expected {size}")
    canvas = gradient(size, style["background_top"], style["background_bottom"])
    draw = ImageDraw.Draw(canvas)

    font = ImageFont.truetype(str(REPO / style["font"]), style["caption_size"])
    lines = wrap(draw, caption, font, int(width * 0.86))
    line_height = int(style["caption_size"] * 1.2)
    y = style["caption_top"]
    for line in lines:
        draw.text((width / 2, y), line, font=font, fill=style["caption_color"], anchor="ma")
        y += line_height

    scale = style["screen_scale"]
    screen = shot.resize((round(width * scale), round(height * scale)), Image.LANCZOS)
    mask = Image.new("L", screen.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, screen.width - 1, screen.height - 1),
        radius=style["screen_corner_radius"],
        fill=255,
    )
    top = y + int(style["caption_size"] * 0.6)
    canvas.paste(screen, ((width - screen.width) // 2, top), mask)
    return canvas


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text())
    raw_dir, out_dir = Path(sys.argv[2]), Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    missing = []
    for scene in config["scenes"]:
        raw = raw_dir / f"{scene['id']}.png"
        if not raw.exists():
            missing.append(scene["id"])
            continue
        frame(config, raw, scene["caption"]).save(out_dir / f"{scene['id']}.png", optimize=True)
        print(out_dir / f"{scene['id']}.png")
    if missing:
        sys.exit(f"No raw screenshot for: {', '.join(missing)}")


if __name__ == "__main__":
    main()
