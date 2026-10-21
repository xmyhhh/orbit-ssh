# Generates build/darwin/menubar.png, the monochrome menu bar (tray) glyph for
# macOS. The glyph is extracted from build/appicon.png, so the menu bar entry
# always wears the same logo as the application icon: the background square is
# dropped and the strokes are slightly thickened for the ~18 pt the menu bar
# draws them at. macOS renders the result as a template image that follows the
# light and dark menu bars.
#
# Usage: python scripts/generate-mac-tray-icon.py
# Requires Pillow.

from pathlib import Path

from PIL import Image, ImageFilter

SOURCE = Path("build/appicon.png")
OUTPUT = Path("build/darwin/menubar.png")
VIEW = 64

# Colors from orbit.svg: the background square and the two artwork tints.
BACKGROUND = (0x17, 0x6B, 0x53)  # #176b53, the rounded square
GLYPH = (0xBA, 0xFF, 0xDF)  # #baffdf, ring and orbit strokes
# The moon dot is even lighter, so it still lands past the last stop and comes
# out fully opaque.


def main():
    icon = Image.open(SOURCE).convert("RGB")
    # Project every pixel onto the line between the background and the glyph
    # tint: background maps to alpha 0, any artwork tint to alpha 1. The
    # anti aliased edges land in between and keep their softness.
    pixels = icon.tobytes()
    axis = [g - b for g, b in zip(GLYPH, BACKGROUND)]
    axis_norm = sum(a * a for a in axis)
    coverage = bytearray(len(pixels) // 3)
    for index in range(len(coverage)):
        base = index * 3
        pixel = pixels[base:base + 3]
        offset = [p - b for p, b in zip(pixel, BACKGROUND)]
        position = sum(o * a for o, a in zip(offset, axis)) / axis_norm
        position = max(0.0, min(1.0, position))
        coverage[index] = int(position * 255)
    glyph = Image.frombytes("L", icon.size, bytes(coverage))

    # The artwork stroke of 3/64 shrinks below one pixel at menu bar size, so
    # broaden the glyph a touch before it is scaled down.
    glyph = glyph.filter(ImageFilter.MaxFilter(25))

    # Template images only consume the alpha channel; keep the color black. A
    # single 64 px copy suffices, the menu bar scales it down.
    glyph = glyph.resize((VIEW, VIEW), Image.LANCZOS)
    result = Image.merge("RGBA", (glyph, glyph, glyph, glyph))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    result.save(OUTPUT)
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
