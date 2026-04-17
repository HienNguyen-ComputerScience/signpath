#!/usr/bin/env python3
"""
prep_reference_videos.py
========================
Re-encode one reference clip per VSL400 sign into a compact web-ready .mp4.

Source data: C:\\SignPath\\vsl400\\Part_*\\split_*\\front_view{.json, /*.mp4}
Output:      C:\\SignPath\\signpath-test\\reference_videos\\{gloss}.mp4
             plus a manifest.json alongside.

Selection is deterministic: for each gloss in model-config.json we pick the
lexicographically smallest video_id that has a front-view clip on disk. If
ffmpeg fails on that candidate, we fall back to the next smallest — a gloss
is only recorded missing if EVERY candidate fails.

Encoding: 480p H.264 main, -preset faster, crf 26 clamped at 2 Mbps max,
30 fps, audio stripped, +faststart for progressive streaming.

Run from C:\\SignPath:
    python prep_reference_videos.py

Idempotent — already-produced outputs are skipped (both file-existence and
non-zero size required). To force re-encode, delete the .mp4 first.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

# Windows' default stdout/stderr codec is cp1252, which can't encode Vietnamese
# diacritics (or ffmpeg's varied stderr bytes). Force UTF-8 with 'replace' so
# a single weird byte from ffmpeg or a gloss like "Trổ" never crashes the run.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ─── Paths ────────────────────────────────────────────────────────────

BASE = Path(r"C:\SignPath")
VSL400 = BASE / "vsl400"
MODEL_CONFIG = BASE / "models" / "model-config.json"
OUT_DIR = BASE / "signpath-test" / "reference_videos"
MANIFEST = OUT_DIR / "manifest.json"

# ─── ffmpeg discovery ─────────────────────────────────────────────────
# winget adds ffmpeg to PATH at install time, but already-running shells
# don't pick up the change. Fall back to the winget install dir if PATH
# doesn't resolve "ffmpeg". Anyone running this from a fresh shell after
# installing gets the PATH lookup; we just want this to Just Work now too.

def _find_binary(name: str) -> str | None:
    hit = shutil.which(name) or shutil.which(f"{name}.exe")
    if hit:
        return hit
    wg = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    if wg.is_dir():
        for exe in wg.glob(f"Gyan.FFmpeg*/**/bin/{name}.exe"):
            return str(exe)
    return None

FFMPEG = _find_binary("ffmpeg")
FFPROBE = _find_binary("ffprobe")

# ─── Encoding settings ────────────────────────────────────────────────

ENCODE_ARGS = [
    "-y",
    "-vf", "scale=-2:480",          # 480p; -2 = even width preserving aspect
    "-c:v", "libx264",
    "-preset", "faster",            # balance speed vs size for ~400 clips
    "-profile:v", "main",           # compatible w/ all modern browsers
    "-crf", "26",
    "-maxrate", "2M", "-bufsize", "2M",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-an",                          # VSL clips are silent; strip audio
    "-movflags", "+faststart",      # progressive streaming
]

ENCODE_TIMEOUT_SEC = 120
WORKERS = 6

# ─── Source index ─────────────────────────────────────────────────────

def load_model_classes() -> list[str]:
    with open(MODEL_CONFIG, encoding="utf-8") as f:
        return list(json.load(f)["classes"])

def build_candidate_index() -> dict[str, list[tuple[str, Path]]]:
    """
    Walk every Part_N/split_N/front_view.json sidecar, build a mapping from
    gloss → list of (video_id, mp4_path) sorted by video_id ascending.
    """
    index: dict[str, list[tuple[str, Path]]] = {}
    for sidecar in sorted(VSL400.glob("Part_*/split_*/front_view.json")):
        fv_dir = sidecar.parent / "front_view"
        try:
            with open(sidecar, encoding="utf-8") as f:
                entries = json.load(f)
        except Exception as e:
            print(f"  ! failed to read {sidecar}: {e}", file=sys.stderr)
            continue
        for entry in entries:
            vid = entry.get("video_id")
            gloss = entry.get("gloss")
            if not vid or not gloss:
                continue
            mp4 = fv_dir / f"{vid}.mp4"
            if mp4.is_file():
                index.setdefault(gloss, []).append((vid, mp4))
    for g in index:
        index[g].sort(key=lambda t: t[0])
    return index

# ─── Encoding ─────────────────────────────────────────────────────────

def probe_duration_ms(path: Path) -> int:
    if not FFPROBE:
        return -1
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error",
             "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1",
             str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return -1
        return int(round(float(r.stdout.strip()) * 1000))
    except Exception:
        return -1

def encode_one(src: Path, dst: Path) -> tuple[bool, str]:
    """
    Encode src → dst atomically via a .tmp sibling. On failure the output
    is removed; on success the tmp is renamed into place.
    Returns (success, error_message).
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.mp4")
    try: tmp.unlink(missing_ok=True)
    except Exception: pass
    cmd = [FFMPEG, "-i", str(src)] + ENCODE_ARGS + [str(tmp)]
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=ENCODE_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        tmp.unlink(missing_ok=True)
        return False, "timeout"
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return False, f"subprocess: {e}"
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        last = (r.stderr or "").splitlines()[-3:]
        return False, f"exit {r.returncode}: {' | '.join(last)[:200]}"
    if not tmp.is_file() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        return False, "zero-size output"
    try:
        tmp.replace(dst)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return False, f"rename: {e}"
    return True, ""

def process_gloss(gloss: str, candidates: list[tuple[str, Path]]) -> dict:
    """
    Try candidates in order until one encodes successfully. Returns a dict
    suitable for inclusion in manifest or reporting.
    """
    out_path = OUT_DIR / f"{gloss}.mp4"

    # Idempotent: don't re-encode what's already good on disk.
    if out_path.is_file() and out_path.stat().st_size > 0:
        # For skipped files we don't know which candidate produced it (the
        # encode happened in a prior run). By selection policy that's the
        # lex-smallest video_id. This is approximate — if the first candidate
        # failed on that run and a fallback was used, this will be wrong.
        # Delete the .mp4 to force a fresh encode with accurate sourceClip.
        vid, src = candidates[0] if candidates else (None, None)
        try: rel = str(src.relative_to(VSL400)).replace("\\", "/") if src else None
        except ValueError: rel = str(src) if src else None
        return {
            "status": "skipped",
            "gloss": gloss,
            "file": out_path.name,
            "bytes": out_path.stat().st_size,
            "durationMs": probe_duration_ms(out_path),
            "sourceClip": rel,
            "tried": 0,
        }

    errors: list[str] = []
    for i, (vid, src) in enumerate(candidates):
        ok, err = encode_one(src, out_path)
        if ok:
            try: rel = str(src.relative_to(VSL400)).replace("\\", "/")
            except ValueError: rel = str(src)
            return {
                "status": "ok",
                "gloss": gloss,
                "file": out_path.name,
                "bytes": out_path.stat().st_size,
                "durationMs": probe_duration_ms(out_path),
                "sourceClip": rel,
                "tried": i + 1,
            }
        errors.append(f"{vid}: {err}")
    return {
        "status": "failed",
        "gloss": gloss,
        "tried": len(candidates),
        "errors": errors[:3],
    }

# ─── Driver ───────────────────────────────────────────────────────────

def main() -> int:
    if not FFMPEG:
        print("ERROR: ffmpeg not found on PATH or in winget install dir.", file=sys.stderr)
        print("Fix: `winget install Gyan.FFmpeg` and re-open your shell.", file=sys.stderr)
        return 1
    print(f"ffmpeg:  {FFMPEG}")
    print(f"ffprobe: {FFPROBE or 'NOT FOUND — durations will be -1'}")
    print()

    start = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    classes = load_model_classes()
    print(f"Loaded {len(classes)} classes from {MODEL_CONFIG.name}")

    index = build_candidate_index()
    print(f"Indexed candidates for {len(index)} glosses across the VSL400 sidecars")

    coverage = sum(1 for g in classes if g in index)
    print(f"Model classes with at least one candidate: {coverage}/{len(classes)}")
    print()

    results: dict[str, dict] = {}
    processed = 0
    total = len(classes)

    # Short-circuit: any class with zero candidates goes straight to missing.
    missing_upfront = [g for g in classes if g not in index]
    for g in missing_upfront:
        results[g] = {"status": "missing", "gloss": g, "reason": "no_front_view_clip"}

    work = [(g, index[g]) for g in classes if g in index]

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_gloss, g, cands): g for g, cands in work}
        for fut in as_completed(futures):
            gloss = futures[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"status": "failed", "gloss": gloss, "tried": 0, "errors": [f"worker crash: {e}"]}
            results[gloss] = res
            processed += 1
            total_reported = processed + len(missing_upfront)
            if res["status"] in ("ok", "skipped"):
                kb = res["bytes"] / 1024
                note = "" if res["status"] == "ok" else " (cached)"
                print(f"[{total_reported}/{total}] {gloss} -> {kb:.0f} KB{note}", flush=True)
            else:
                print(f"[{total_reported}/{total}] {gloss} FAILED after {res.get('tried',0)} candidates", flush=True)

    # Build manifest keyed by class order
    manifest: dict = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": total,
        "produced": 0,
        "signs": {},
        "missing": [],
    }
    ok_count = 0
    missing_count = 0
    failed_count = 0
    total_bytes = 0
    for gloss in classes:
        r = results.get(gloss, {"status": "failed"})
        if r["status"] in ("ok", "skipped"):
            manifest["signs"][gloss] = {
                "file": r["file"],
                "bytes": r["bytes"],
                "durationMs": r["durationMs"],
                "sourceClip": r.get("sourceClip"),
            }
            ok_count += 1
            total_bytes += r["bytes"]
        elif r["status"] == "missing":
            manifest["missing"].append(f"{gloss} (no front view)")
            missing_count += 1
        else:
            manifest["missing"].append(f"{gloss} (all {r.get('tried',0)} candidates failed)")
            failed_count += 1

    manifest["produced"] = ok_count

    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start
    print()
    print("=" * 64)
    print(f"Done in {elapsed:.1f}s ({elapsed/60:.1f} min)")
    print(f"Produced:          {ok_count}/{total}")
    print(f"Missing (no clip): {missing_count}")
    print(f"Failed (ffmpeg):   {failed_count}")
    print(f"Total size:        {total_bytes/1e6:.1f} MB")
    if ok_count:
        print(f"Average size:      {total_bytes/ok_count/1024:.0f} KB/clip")
    print(f"Manifest:          {MANIFEST}")
    print("=" * 64)

    # Non-zero exit if we fell short of the 380/400 bar — lets CI catch bad runs.
    return 0 if ok_count >= 380 else 2

if __name__ == "__main__":
    sys.exit(main())
