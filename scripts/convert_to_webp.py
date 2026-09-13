#!/usr/bin/env python3
"""Replace the JPEG artwork under images/ with WebP, in place.

Every *.jpg / *.jpeg below the target directory is re-encoded as a sibling
<stem>.webp at the requested quality. Any EXIF rotation is baked into the pixels
and the source ICC profile is carried over, so colour and framing are exactly
what the JPEG showed.

The JPEG is deleted only once the written WebP has been reopened and confirmed
to decode at the same pixel dimensions. A failure at any stage — the source will
not open, the write raises, the file reads back at the wrong size — leaves the
JPEG in place, reports the reason, and moves on, so an interrupted run never
leaves a page pointing at artwork that is not there.

Front matter (hero: / cover:), the inline <img> tags in index.html and
plugins.html and the catalogue grids built by ibl-catalog.js all reference the
.webp extension, so this is an in-place format swap rather than a migration: art
added later just needs the same pass.

    python scripts/convert_to_webp.py --dry-run    # report the planned work, write nothing
    python scripts/convert_to_webp.py              # convert everything under images/
    python scripts/convert_to_webp.py --quality 75 --force images/instruments
"""

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIRECTORY = "images"
DEFAULT_QUALITY = 82

# method 6 is WebP's slowest encoder setting and its smallest output; the extra
# seconds per file are irrelevant for a pass that runs once per artwork change
WEBP_METHOD = 6


def die(message: str) -> None:
    # prints a fatal message to stderr and exits non-zero
    print(f"fatal: {message}", file=sys.stderr)
    raise SystemExit(1)


def label(path: Path) -> str:
    # a path relative to the repo root, for readable output
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def existing_size(target: Path):
    # (width, height) of a .webp that is already on disk, or None if it will not open
    if not target.exists():
        return None
    try:
        with Image.open(target) as image:
            return image.size
    except OSError:
        return None


def load_frame(source: Path):
    # decodes a JPEG to (RGB frame with EXIF rotation applied, icc profile bytes)
    with Image.open(source) as image:
        icc_profile = image.info.get("icc_profile")
        frame = ImageOps.exif_transpose(image).convert("RGB")
    return frame, icc_profile


def encode(frame: Image.Image, icc_profile, quality: int) -> bytes:
    # encodes a frame to WebP in memory and returns the bytes
    buffer = io.BytesIO()
    frame.save(buffer, format="WEBP", quality=quality, method=WEBP_METHOD, icc_profile=icc_profile)
    return buffer.getvalue()


def convert(source: Path, target: Path, frame: Image.Image, icc_profile, quality: int) -> str:
    # writes the WebP beside the JPEG and deletes the JPEG once the WebP verifies
    target.write_bytes(encode(frame, icc_profile, quality))

    with Image.open(target) as written:
        written.load()
        if written.size != frame.size:
            target.unlink()
            return f"{target.name} decoded at {written.size[0]}x{written.size[1]}, expected {frame.size[0]}x{frame.size[1]}"

    source.unlink()
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert the JPEG artwork under images/ to WebP.")
    parser.add_argument("directory", nargs="?", default=DEFAULT_DIRECTORY, help="directory to walk (default: images)")
    parser.add_argument("--dry-run", action="store_true", help="list the planned conversions without writing anything")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY, help="WebP quality, 1-100 (default: 82)")
    parser.add_argument("--force", action="store_true", help="re-encode even when a matching .webp already exists")
    args = parser.parse_args()

    if not 1 <= args.quality <= 100:
        die(f"--quality must be between 1 and 100, got {args.quality}")

    root = Path(args.directory)
    if not root.is_absolute():
        root = ROOT / root
    if not root.is_dir():
        die(f"{root} is not a directory")

    sources = sorted(set(root.rglob("*.jpg")) | set(root.rglob("*.jpeg")))
    print(f"{len(sources)} JPEG file(s) under {label(root)}{' — dry run, nothing will be written' if args.dry_run else ''}")
    if not sources:
        return 0

    converted = 0
    skipped = 0
    failed = 0
    beforeBytes = 0
    afterBytes = 0

    for source in sources:
        target = source.with_suffix(".webp")
        before = source.stat().st_size
        beforeBytes += before

        try:
            frame, icc_profile = load_frame(source)
        except OSError as error:
            print(f"failed    {label(source)}: cannot be read ({error})", file=sys.stderr)
            failed += 1
            continue

        if not args.force and existing_size(target) == frame.size:
            skipped += 1
            afterBytes += target.stat().st_size
            print(f"skipped   {label(source)}: {target.name} already matches {frame.size[0]}x{frame.size[1]}")
            continue

        try:
            if args.dry_run:
                projected = len(encode(frame, icc_profile, args.quality))
                afterBytes += projected
                converted += 1
                print(f"planned   {label(source)} -> {target.name}: {frame.size[0]}x{frame.size[1]}, {before} -> {projected} bytes")
                continue
            reason = convert(source, target, frame, icc_profile, args.quality)
        except OSError as error:
            print(f"failed    {label(source)}: cannot be written as WebP ({error})", file=sys.stderr)
            failed += 1
            continue

        if reason:
            print(f"failed    {label(source)}: {reason}", file=sys.stderr)
            failed += 1
            continue

        after = target.stat().st_size
        afterBytes += after
        converted += 1
        print(f"converted {label(source)} -> {target.name}: {frame.size[0]}x{frame.size[1]}, {before} -> {after} bytes")

    saved = 100 * (1 - afterBytes / beforeBytes) if beforeBytes else 0
    print(f"summary: {converted} converted, {skipped} skipped, {failed} failed")
    print(f"         {beforeBytes} -> {afterBytes} bytes ({saved:.1f}% smaller)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
