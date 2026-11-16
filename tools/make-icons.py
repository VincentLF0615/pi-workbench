"""Export Pi's official full-color artwork to desktop icon formats.

Run: python tools/make-icons.py (requires Pillow).
Source: https://pi.dev/logo.svg (see docs/pi-branding.md).
The SVG is kept unchanged. Raster exports only adjust transparent padding.
"""
from functools import lru_cache
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps/desktop/src-tauri/icons"
ASSETS = ROOT / "apps/desktop/src/assets"
SHORTCUT_ICON = "pi-workbench-official-v3.ico"
SIZES = [
    (32, "32x32.png"), (128, "128x128.png"),
    (256, "128x128@2x.png"), (512, "icon.png"),
]
STORE_SIZES = [(size, f"Square{size}x{size}Logo.png") for size in
               [30, 44, 71, 89, 107, 142, 150, 284, 310]] + [(50, "StoreLogo.png")]


@lru_cache(maxsize=1)
def artwork() -> list[tuple[str, list[tuple[float, float]]]]:
    """Read the official mark's straight paths from the bundled source SVG."""
    shapes = []
    for element in ET.parse(ASSETS / "pi-mark.svg").getroot():
        if element.tag.rsplit("}", 1)[-1] != "path":
            continue
        tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", element.attrib["d"])
        points = []
        x = y = 0.0
        index = 0
        while index < len(tokens):
            command = tokens[index]
            index += 1
            if command in ("M", "L"):
                x, y = float(tokens[index]), float(tokens[index + 1])
                index += 2
            elif command == "H":
                x = float(tokens[index])
                index += 1
            elif command == "V":
                y = float(tokens[index])
                index += 1
            elif command == "Z":
                continue
            else:
                raise ValueError(f"Unsupported official SVG command: {command}")
            points.append((x, y))
        shapes.append((element.attrib["fill"], points))
    if not shapes:
        raise ValueError("The official SVG contains no paths")
    return shapes


def make_icon(size: int) -> Image.Image:
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big))
    draw = ImageDraw.Draw(image)
    shapes = artwork()
    xs = [x for _, points in shapes for x, _ in points]
    ys = [y for _, points in shapes for _, y in points]
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    factor = big * 0.78 / max(width, height)
    offset_x = (big - width * factor) / 2 - min(xs) * factor
    offset_y = (big - height * factor) / 2 - min(ys) * factor
    for colour, points in shapes:
        draw.polygon([(x * factor + offset_x, y * factor + offset_y) for x, y in points], fill=colour)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, filename in SIZES + STORE_SIZES:
        make_icon(size).save(OUT / filename)
    ico_sizes = [(size, size) for size in [16, 24, 32, 48, 64, 128, 256]]
    frames = [make_icon(size) for size, _ in ico_sizes]
    # Pillow requires the largest frame as the base to retain every size.
    frames[-1].save(OUT / "icon.ico", format="ICO", sizes=ico_sizes, append_images=frames[:-1])
    (OUT / SHORTCUT_ICON).write_bytes((OUT / "icon.ico").read_bytes())
    make_icon(512).save(OUT / "icon.icns", format="ICNS")
    print(f"Exported official SVG to platform icons and {SHORTCUT_ICON} (7 sizes)")


if __name__ == "__main__":
    main()
