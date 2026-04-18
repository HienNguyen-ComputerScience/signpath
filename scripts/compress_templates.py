"""
Gzip-compress sign-templates.json for Netlify deploy.

The raw templates file is ~77 MB. Netlify serves small assets faster and charges
by bandwidth, so we precompress once and serve the .gz with Content-Encoding:gzip
(the browser decodes transparently and gets a parsed JSON object).

Usage:
    python scripts/compress_templates.py
    python scripts/compress_templates.py --src path/to/sign-templates.json

Safe to re-run. Overwrites the .gz in place.
"""
import argparse
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

DEFAULT_SRC = Path("signpath-test/models/sign-templates.json")
DEFAULT_DST = Path("signpath-test/models/sign-templates.json.gz")


def compress(src: Path, dst: Path) -> None:
    if not src.exists():
        sys.exit(f"error: source not found: {src}\n"
                 f"hint: run `python build_templates.py` first to generate it.")

    src_size = src.stat().st_size
    print(f"source:     {src}  ({src_size / 1024 / 1024:.1f} MB)")

    with open(src, "rb") as f_in, gzip.open(dst, "wb", compresslevel=9) as f_out:
        shutil.copyfileobj(f_in, f_out, length=1024 * 1024)

    dst_size = dst.stat().st_size
    print(f"compressed: {dst}  ({dst_size / 1024 / 1024:.1f} MB)")
    print(f"ratio:      {dst_size / src_size:.1%} of original")

    # Round-trip verify: decompress and compare content hash to the source.
    h_src = hashlib.sha256()
    with open(src, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h_src.update(chunk)

    h_decompressed = hashlib.sha256()
    with gzip.open(dst, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h_decompressed.update(chunk)

    if h_src.hexdigest() != h_decompressed.hexdigest():
        sys.exit("error: round-trip hash mismatch \u2014 compressed file is corrupt")
    print("verified:   round-trip sha256 matches")

    # Parse-check: ensure it's still valid JSON after decompression.
    with gzip.open(dst, "rb") as f:
        data = json.load(f)
    n = len(data.get("templates", {}))
    print(f"valid JSON: {n} templates, frameCount={data.get('frameCount')}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC,
                    help=f"source JSON (default: {DEFAULT_SRC})")
    ap.add_argument("--dst", type=Path, default=None,
                    help="output .gz (default: <src>.gz)")
    args = ap.parse_args()
    dst = args.dst if args.dst else args.src.with_suffix(args.src.suffix + ".gz")
    compress(args.src, dst)


if __name__ == "__main__":
    main()
