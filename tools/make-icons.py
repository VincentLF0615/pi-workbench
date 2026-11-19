"""Draw Pi Workbench's original icon: a tri-colour progress ring around pi.

Run: python tools/make-icons.py (requires Pillow).

The design is original artwork for this project: an open ring split into
three colour segments (salmon / sky blue / gold, echoing the palette of
pi's public branding) surrounds a white pi glyph whose crossbar overlaps
its legs. The ring's opening at the bottom stands for sessions that can
always continue. See docs/pi-branding.md.
"""
from functools import lru_cache
from math import cos, sin, pi as PI
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps/desktop/src-tauri/icons"
ASSETS = ROOT / "apps/desktop/src/assets"
SHORTCUT_ICON = "pi-workbench-ring-v1.ico"
SIZES = [
    (32, "32x32.png"), (128, "128x128.png"),
    (256, "128x128@2x.png"), (512, "icon.png"),
]
STORE_SIZES = [(size, f"Square{size}x{size}Logo.png") for size in
               [30, 44, 71, 89, 107, 142, 150, 284, 310]] + [(50, "StoreLogo.png")]

# Palette sampled from pi's public press-kit artwork; the composition here
# (ring + glyph) is original and does not reproduce any official mark.
BG = (21, 23, 27, 255)          # #15171b, matches the app's dark surface
SALMON = (240, 144, 130, 255)   # #f09082
SKY = (77, 154, 191, 255)       # #4d9abf, also the app's --brand colour
GOLD = (241, 190, 88, 255)      # #f1be58
INK = (0, 0, 0, 255)           # segment outlines, official-style separation
WHITE = (255, 255, 255, 255)    # the pi glyph

# Ring geometry on a 512-unit design grid.
GRID = 512
RING_R = 178
RING_W = 46
RING_OUTLINE = 62
GAP_DEG = 78  # opening centred at the bottom
SEGMENTS = [0.38, 0.34, 0.28]  # salmon / sky / gold share of the ring

# Pi glyph geometry (crossbar drawn last so it overlaps the legs).
BAR = (168, 200, 344, 200)
LEG_L = (208, 200, 208, 330)
LEG_R = (304, 200, 304, 330)
GLYPH_W = 34
GLYPH_OUTLINE = 50


def _draw_steps(draw: ImageDraw.ImageDraw, unit: float) -> None:
    """Paint the design onto `draw`, where 1 design unit = `unit` pixels."""
    cx = cy = GRID / 2
    start = 90 + GAP_DEG / 2
    sweep = 360 - GAP_DEG
    spans = []
    angle = start
    for share in SEGMENTS:
        spans.append((angle, angle + sweep * share))
        angle += sweep * share

    def ring_box(r: float) -> tuple[float, float, float, float]:
        return ((cx - r) * unit, (cy - r) * unit, (cx + r) * unit, (cy + r) * unit)

    # Outline pass for all three segments first, then the colour pass, so
    # neighbouring segments are separated by an ink gap.
    for a0, a1 in spans:
        draw.arc(ring_box(RING_OUTLINE / 2), start=a0, end=a1,
                 fill=INK, width=max(1, int(RING_OUTLINE * unit)))
    for idx, (a0, a1) in enumerate(spans):
        colour = (SALMON, SKY, GOLD)[idx]
        draw.arc(ring_box(RING_R), start=a0, end=a1,
                 fill=colour, width=max(1, int(RING_W * unit)))

    def line(box: tuple[float, float, float, float], width_units: float, colour) -> None:
        x0, y0, x1, y1 = box
        draw.line((x0 * unit, y0 * unit, x1 * unit, y1 * unit),
                  fill=colour, width=max(1, int(width_units * unit)))

    # Glyph: legs first, crossbar last so it sits on top of them.
    for box in (LEG_L, LEG_R, BAR):
        line(box, GLYPH_OUTLINE, INK)
    for box in (LEG_L, LEG_R, BAR):
        line(box, GLYPH_W, WHITE)


def make_icon(size: int) -> Image.Image:
    """Render the design at `size` with 4x supersampling."""
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # Rounded-square backdrop, radius 104/512 of the grid.
    radius = int(104 / GRID * big)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=BG)
    _draw_steps(draw, big / GRID)
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
    # Also export the in-app mark used by the sidebar and About panel.
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_icon(512).save(ASSETS / "pi-mark.png")
    print(f"Exported ring icon to platform icons and {SHORTCUT_ICON} (7 sizes)")


if __name__ == "__main__":
    main()
