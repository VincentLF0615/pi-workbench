"""Build Pi Workbench's icon set from the hand-tuned reference artwork.

Run: python tools/make-icons.py (requires Pillow).

The icon is original artwork for this project: the pi glyph as folded
ribbons — a rainbow roof band (magenta -> purple -> blue -> peach ->
yellow) over a violet left leg and a blue-to-mint right leg, with a
dark cavity between them. The design was hand-tuned on a reference
board (see docs/pi-branding.md); this script crops the master tile from
that board and resamples it to every size Tauri and the Windows Store
need, so the shipped icons match the reference pixel-for-pixel. The
palette nods to pi's public branding; the composition is original and
does not reproduce any official mark.
"""
from functools import lru_cache
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps/desktop/src-tauri/icons"
ASSETS = ROOT / "apps/desktop/src/assets"
SOURCE = ROOT / "docs" / "icon-reference" / "pi-workbench-icon-board.png"
SHORTCUT_ICON = "pi-workbench-iso-v2.ico"
SIZES = [
    (32, "32x32.png"), (128, "128x128.png"),
    (256, "128x128@2x.png"), (512, "icon.png"),
]
STORE_SIZES = [(size, f"Square{size}x{size}Logo.png") for size in
               [30, 44, 71, 89, 107, 142, 150, 284, 310]] + [(50, "StoreLogo.png")]

# The master tile's bounding box on the reference board, measured by
# scanning for the dark squircle against the lighter board background.
TILE_BOX = (79, 165, 775, 865)


@lru_cache(maxsize=1)
def master() -> Image.Image:
    """The 512x512 master tile cropped from the reference board."""
    if not SOURCE.is_file():
        raise SystemExit(
            f"reference board not found: {SOURCE}\n"
            "Re-download it or re-run the drawing-based generator."
        )
    board = Image.open(SOURCE).convert("RGBA")
    tile = board.crop(TILE_BOX)
    return tile.resize((512, 512), Image.Resampling.LANCZOS)


def make_icon(size: int) -> Image.Image:
    return master().resize((size, size), Image.Resampling.LANCZOS)


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
    # Also export the in-app mark used by the sidebar and About panel.
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_icon(512).save(ASSETS / "pi-mark.png")
    print(f"Exported folded-ribbon pi icon to platform icons and {SHORTCUT_ICON} (7 sizes)")


if __name__ == "__main__":
    main()
