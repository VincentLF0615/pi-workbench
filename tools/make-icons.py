"""Build Pi Workbench's icon set from the hand-tuned reference artwork.

Run: python tools/make-icons.py (requires Pillow).

The icon is original artwork for this project: the pi glyph as folded
ribbons — a rainbow roof band (magenta -> purple -> blue -> peach ->
yellow) over a violet left leg and a blue-to-mint right leg. The
design was hand-tuned on a reference board (see docs/pi-branding.md);
this script crops the master tile from that board, keys the dark
background out to transparency so the glyph floats on whatever the
OS puts behind it, recentres it with even padding, and resamples it
to every size Tauri and the Windows Store need. The palette nods to
pi's public branding; the composition is original and does not
reproduce any official mark.
"""
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps/desktop/src-tauri/icons"
ASSETS = ROOT / "apps/desktop/src/assets"
SOURCE = ROOT / "docs" / "icon-reference" / "pi-workbench-icon-board.png"
SHORTCUT_ICON = "pi-workbench-iso-v3.ico"
SIZES = [
    (32, "32x32.png"), (128, "128x128.png"),
    (256, "128x128@2x.png"), (512, "icon.png"),
]
STORE_SIZES = [(size, f"Square{size}x{size}Logo.png") for size in
               [30, 44, 71, 89, 107, 142, 150, 284, 310]] + [(50, "StoreLogo.png")]

# The master tile's bounding box on the reference board, measured by
# scanning for the dark squircle against the lighter board background.
TILE_BOX = (79, 165, 775, 865)

# Background keying: the tile's backdrop (and the cavity between the
# legs) are flat dark purples, while the artwork's least saturated
# pixel still differs from them by ~98 in max-channel distance. A
# flood fill from the tile's border with this tolerance removes the
# backdrop but preserves the cavity, whose only border is artwork.
KEY_TOLERANCE = 68
# Transparent padding around the keyed glyph, as a share of the
# glyph's larger dimension.
PADDING = 0.06


def _key_background(tile: Image.Image) -> Image.Image:
    """Flood-fill the tile's flat dark backdrop to transparency.

    Seeds are every border pixel; a neighbour joins the background if
    its max-channel distance to the seed colour stays within the
    tolerance. The cavity between the legs is enclosed by artwork, so
    it is never reached by the flood and stays opaque.
    """
    width, height = tile.size
    px = tile.load()
    visited = bytearray(width * height)
    alpha = bytearray(b"\xff" * (width * height))
    stack = []
    for x in range(width):
        stack.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        stack.extend(((0, y), (width - 1, y)))
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        i = y * width + x
        if visited[i]:
            continue
        r, g, b = px[x, y][:3]
        if max(r, g, b) > KEY_TOLERANCE:
            continue  # artwork or shadow; not background
        visited[i] = 1
        alpha[i] = 0
        stack.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    tile.putalpha(Image.frombytes("L", (width, height), bytes(alpha)))
    return tile


def _tighten_and_pad(image: Image.Image, padding: float = PADDING) -> Image.Image:
    """Crop to the glyph's bounding box, then pad evenly on all sides."""
    bbox = image.getbbox()
    if bbox is None:
        return image
    glyph = image.crop(bbox)
    gw, gh = glyph.size
    pad = round(max(gw, gh) * padding)
    canvas = Image.new("RGBA", (gw + 2 * pad, gh + 2 * pad), (0, 0, 0, 0))
    canvas.paste(glyph, (pad, pad))
    return canvas


@lru_cache(maxsize=1)
def master() -> Image.Image:
    """The 512x512 transparent master, keyed and centred from the board."""
    if not SOURCE.is_file():
        raise SystemExit(
            f"reference board not found: {SOURCE}\n"
            "Re-download it or re-run the drawing-based generator."
        )
    board = Image.open(SOURCE).convert("RGBA")
    tile = board.crop(TILE_BOX)
    keyed = _key_background(tile)
    centred = _tighten_and_pad(keyed)
    return centred.resize((512, 512), Image.Resampling.LANCZOS)


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
    (OUT / "pi-workbench-iso-v2.ico").write_bytes((OUT / "icon.ico").read_bytes())
    make_icon(512).save(OUT / "icon.icns", format="ICNS")
    # Also export the in-app mark used by the sidebar and About panel.
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_icon(512).save(ASSETS / "pi-mark.png")
    print(f"Exported folded-ribbon pi icon to platform icons and {SHORTCUT_ICON} (7 sizes)")


if __name__ == "__main__":
    main()
