"""
Assemble the captured frames into an animated GIF demo reel.

GIF is a 256-colour format and this is a dark UI with fine chart lines, so the palette
matters more than the resolution: an adaptive palette per-frame would shimmer between
frames, so one shared palette is quantised from a montage of every frame. Downscaling
uses LANCZOS, which keeps 2px chart strokes visible where a box filter would erase them.

Devpost caps gallery images at 5 MB, so the output is checked against that and the script
says what to change if it is over.
"""

import json
import pathlib
import sys

from PIL import Image

HERE = pathlib.Path(__file__).parent
FRAMES = HERE / "frames"
OUT_GIF = HERE / "nerve-demo.gif"

# Per-frame hold. The login frame is a title card and needs less; the charts and the AI
# answer are what people actually read, so they get longer.
HOLD_MS = {
    "login": 1400,
    "overview": 3200,
    "fleet": 3000,
    "incidents": 3000,
    # The longest hold in the reel. This frame carries the hypothesis, the evidence and
    # the runbook, so it is the one frame a reader needs time to actually read.
    "incident-detail": 4600,
    "device-detail": 3600,
    "rules": 3000,
    "admin": 2600,
    "ask-typed": 2000,
    "ask-answered": 4000,
}
DEFAULT_HOLD = 2800
TARGET_WIDTH = 1100
MAX_BYTES = 5 * 1024 * 1024

manifest_path = FRAMES / "manifest.json"
if not manifest_path.exists():
    sys.exit(f"No manifest at {manifest_path} — run capture.mjs first.")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
paths = [pathlib.Path(m["file"]) for m in manifest]
missing = [p for p in paths if not p.exists()]
if missing:
    sys.exit(f"Missing frames: {missing}")

print(f"{len(paths)} frames")

frames = []
durations = []
for m, p in zip(manifest, paths):
    im = Image.open(p).convert("RGB")
    w, h = im.size
    scaled = im.resize((TARGET_WIDTH, round(h * TARGET_WIDTH / w)), Image.LANCZOS)
    frames.append(scaled)
    durations.append(HOLD_MS.get(m["name"], DEFAULT_HOLD))
    print(f"  {p.name:26} {w}x{h} -> {scaled.size[0]}x{scaled.size[1]}  hold {durations[-1]}ms")

# One shared palette, quantised from every frame stacked together. Per-frame adaptive
# palettes are what make dark-UI GIFs strobe between frames.
montage = Image.new("RGB", (frames[0].width, frames[0].height * len(frames)))
for i, f in enumerate(frames):
    montage.paste(f, (0, i * frames[0].height))
palette_img = montage.quantize(colors=255, method=Image.MEDIANCUT)

quantised = [f.quantize(palette=palette_img, dither=Image.FLOYDSTEINBERG) for f in frames]

quantised[0].save(
    OUT_GIF,
    save_all=True,
    append_images=quantised[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)

size = OUT_GIF.stat().st_size
total_s = sum(durations) / 1000
print(f"\nwrote {OUT_GIF.name}  {size / 1024 / 1024:.2f} MB  {len(frames)} frames  {total_s:.1f}s loop")
if size > MAX_BYTES:
    print(
        f"OVER the {MAX_BYTES / 1024 / 1024:.0f} MB Devpost limit. "
        f"Lower TARGET_WIDTH (currently {TARGET_WIDTH}) or drop a frame."
    )
    sys.exit(1)
print(f"Within the {MAX_BYTES / 1024 / 1024:.0f} MB Devpost gallery limit.")
