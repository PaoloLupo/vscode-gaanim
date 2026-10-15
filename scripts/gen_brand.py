"""Write the extension's brand images from Gaanim's brand generator.

Gaanim's identity is built by tools/generate_brand.py in the Gaanim repository
(see docs/assets/brand/README.md there). This script imports that generator,
so the logo and the symbol keep its exact geometry and palette, and writes:

    images/icon.png       the app icon (Gaanim's gaanim-icon-512.png)
    images/activity.svg   the one-colour symbol for the activity bar
    images/banner.png     the README header: the dark lockup over graphite,
                          "for VS Code" and a timeline with its playhead

Run it again when Gaanim's brand changes (needs Pillow):

    python scripts/gen_brand.py [path/to/gaanim]

Without a path it looks for the Gaanim repository next to this one, in
../gaanim or ../rust/gaanim.
"""

import importlib.util
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parents[1]
IMAGES = HERE / "images"


def gaanim_repo():
    if len(sys.argv) > 1:
        return pathlib.Path(sys.argv[1]).resolve()
    for candidate in (HERE.parent / "gaanim", HERE.parent / "rust" / "gaanim"):
        if (candidate / "tools" / "generate_brand.py").is_file():
            return candidate
    sys.exit("Gaanim's repository was not found; pass its path.")


def load_generator(repo):
    spec = importlib.util.spec_from_file_location("generate_brand", repo / "tools" / "generate_brand.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def activity_svg(brand):
    """The mono symbol centred on a square canvas, as the activity bar wants it."""
    size = brand.SYMBOL_W
    y0 = (size - brand.FRAME_SIZE) // 2
    body = brand.symbol_svg(("currentColor",), 0, y0, opacities=(0.3, 0.6, 1))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="24" height="24">\n'
        f"{body}</svg>\n"
    )


def paint_lockup(brand, image, scale, ox, oy):
    """The dark lockup with its top-left corner at (ox, oy), `scale` px per unit."""
    width, height = image.size
    parts, _ = brand.wordmark(brand.SYMBOL_W + brand.SYMBOL_GAP)
    frames_y = oy + (brand.TILE_SIZE - brand.FRAME_SIZE) // 2 * scale
    for index, color in enumerate(brand.THEMES["dark"]["frames"]):
        brand.paint_pixels(image, brand.frame_pixels(index), color, scale, ox, frames_y)
    for role, color in (("text", brand.PAPER), ("dot", brand.GOLD)):
        mask = brand.vector_mask(
            [p for p in parts if p.role == role], (width, height), scale, ox / scale, frames_y / scale
        )
        image.paste(Image.new("RGBA", (width, height), brand.rgb(color) + (255,)), (0, 0), mask)


def banner(brand, font_file):
    width, height, scale = 1280, 340, 6
    image = Image.new("RGBA", (width, height), brand.rgb(brand.GRAPHITE) + (255,))
    _, text_w = brand.wordmark(brand.SYMBOL_W + brand.SYMBOL_GAP)
    lockup_w = int(brand.SYMBOL_W + brand.SYMBOL_GAP + text_w)
    ox = (width - lockup_w * scale) // 2
    oy = 56
    paint_lockup(brand, image, scale, ox, oy)

    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_file), 30)
    label = "for VS Code"
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    draw.text(((width - (right - left)) // 2 - left, 196 - top), label, font=font, fill=brand.rgb(brand.VIOLET_LIGHT))

    # The docs' reading playhead: a timeline with keyframes and a square head.
    unit = scale // 2
    y = 270
    x0, x1 = ox, ox + lockup_w * scale
    draw.rectangle([x0, y, x1 - 1, y + unit - 1], fill=brand.rgb(brand.HAZE_DARK))
    played = x0 + (x1 - x0) * 5 // 8 + 2 * unit
    draw.rectangle([x0, y, played - 1, y + unit - 1], fill=brand.rgb(brand.VIOLET))
    for fraction in (0, 2, 4, 6, 8):
        cx = x0 + (x1 - x0) * fraction // 8
        r = 3 * unit
        cy = y + unit // 2
        color = brand.VIOLET if cx <= played else brand.HAZE_DARK
        draw.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=brand.rgb(color))
    head = 5 * unit
    draw.rectangle(
        [played - head // 2, y + unit // 2 - head // 2, played + head // 2 - 1, y + unit // 2 + head // 2 - 1],
        fill=brand.rgb(brand.GOLD),
    )
    return image.convert("RGB")


def main():
    repo = gaanim_repo()
    brand = load_generator(repo)
    brand.VIOLET_LIGHT = "#A99FFF"  # links over dark, from the brand README's palette
    font_file = repo / "crates" / "gaanim_text" / "assets" / "fonts" / "JetBrainsMono-Variable.ttf"
    IMAGES.mkdir(exist_ok=True)
    (IMAGES / "icon.png").write_bytes((repo / "docs" / "assets" / "brand" / "gaanim-icon-512.png").read_bytes())
    (IMAGES / "activity.svg").write_text(activity_svg(brand), encoding="utf-8", newline="\n")
    banner(brand, font_file).save(IMAGES / "banner.png", optimize=True)
    print(f"Wrote images/ from {repo}")


if __name__ == "__main__":
    main()
