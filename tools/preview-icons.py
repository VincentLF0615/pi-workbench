"""Preview the icon at the sizes Windows actually uses for shortcuts.

    python tools/preview-icons.py
"""

from pathlib import Path
import importlib.util
import sys

from PIL import Image, ImageDraw

# The sibling script is named with a hyphen, so it cannot be imported by name;
# load it from its path instead.
_here = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("make_icons", _here / "make-icons.py")
make_icons = importlib.util.module_from_spec(_spec)
sys.modules["make_icons"] = make_icons
_spec.loader.exec_module(make_icons)

OUT = Path(__file__).resolve().parent.parent / "apps" / "desktop" / "src-tauri" / "icons"
SIZES = [16, 20, 24, 32, 48, 64, 128]

# One row per size, magnified 3x so the pixels are visible.
CELL = 3
PAD = 6
LABEL = 22

width = 40 + max(SIZES) * CELL + PAD * 2
height = LABEL + len(SIZES) * (max(SIZES) * CELL + PAD) + PAD
sheet = Image.new("RGB", (width, height), (240, 240, 242))

for row, size in enumerate(SIZES):
    icon = make_icons.make_icon(size)
    top = LABEL + row * (max(SIZES) * CELL + PAD)
    sheet.paste(icon.resize((size * CELL, size * CELL), Image.NEAREST), (40, top))

    # Label and a 1:1 reference next to it.
    draw = ImageDraw.Draw(sheet)
    draw.text((4, top + size * CELL // 2 - 6), f"{size}px", fill=(60, 60, 70))
    sheet.paste(icon, (40 + size * CELL + 10, top))

path = OUT / "preview-sizes.png"
sheet.save(path)
print(f"wrote {path} ({sheet.width}x{sheet.height})")
