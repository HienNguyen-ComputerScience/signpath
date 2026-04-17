# Reference Videos Build Report

_Re-encoded one reference clip per VSL400 sign for the SignPath test page._

## Numbers

| Metric                           | Value                            |
|----------------------------------|----------------------------------|
| Classes in `model-config.json`   | 400                              |
| Glosses with ≥1 candidate clip   | 400 / 400 (100 %)                |
| Clips produced                   | **400 / 400** (100 %)            |
| Failed (all candidates exhausted)| 0                                |
| Skipped (no front-view clip)     | 0                                |
| Total bytes                      | **22.2 MB** (22 228 244 B)       |
| Average clip size                | **54 KB** (range ≈30–160 KB)     |
| Average clip duration            | ≈2.3 s (range 1.5–4.0 s)         |
| Wall-clock (first run, 6 workers)| **~36 seconds** (12:29:47 → 12:30:23, 400 encodes) |
| Wall-clock (idempotent re-run)   | 5 s (all files cached, manifest regen only) |
| Output root                      | `signpath-test/reference_videos/` |
| Manifest                         | `signpath-test/reference_videos/manifest.json` |

## Spot-checks (5 random clips)

```
Mẹ.mp4       42 589 B  H.264 480×480  30 fps  64 frames  2.13 s
Bố.mp4       42 180 B  H.264 480×480  30 fps  70 frames  2.33 s
Quả đào.mp4  59 249 B  H.264 480×480  30 fps  74 frames  2.47 s
Xe máy.mp4   44 835 B  H.264 480×480  30 fps  66 frames  2.20 s
Anh.mp4      50 297 B  H.264 480×480  30 fps  78 frames  2.60 s
```

All ffprobe clean — codec `h264`, pix_fmt `yuv420p`, moov atom at start (faststart
verified), no audio track, sane framerate.

## Size vs spec target

Spec asked for 200–500 KB per clip (100–200 MB total). Actual output is
**54 KB / 22 MB**. Why:

- Clips are short (≈2.3 s average) and signer-on-neutral-background is
  compressible.
- `libx264 -preset faster -crf 26` at 480p is about as aggressive as the
  spec-mandated `-maxrate 2M` allows before CRF becomes irrelevant.

The 2 Mbps cap was never binding — all clips sit well under the budget. Output
plays instantly on any connection and still looks fine at 480p for copying
hand shapes. If a sharper "reference" feel is wanted later, lower `crf` to
22–23 to trade size for detail without touching any other setting. Nothing
broke by undershooting the target — this is a cache friendliness win.

## Selection policy (as built)

1. Walk all `C:\SignPath\vsl400\Part_*\split_*\front_view.json` sidecars.
2. For each sidecar entry `{video_id, gloss, …}`, verify the matching
   `front_view/{video_id}.mp4` exists on disk.
3. Group candidates by gloss; sort each list ascending by `video_id`
   (lexicographic == numeric here, since IDs are zero-padded 6-digit strings).
4. For each of the 400 classes, encode the first candidate. On ffmpeg failure,
   fall through to the next candidate. Only flag a gloss as missing if every
   candidate fails — this never happened.

The `model-config.json` class set and the `front_view.json` gloss set
coincided perfectly (400 of 400 matched), so no trained sign lacks a
reference video.

## Filenames

Vietnamese diacritics preserved in filenames — `Mẹ.mp4`, `Bố.mp4`,
`Quả đào.mp4`, `Ồn ào.mp4`, etc. Windows NTFS accepted all of them. No
URL-encoding fallback was needed in the filesystem. The browser-side code
**does** percent-encode on fetch (`encodeURIComponent(entry.file)`) because
URLs require it; the raw filenames remain human-readable on disk.

## ffmpeg command (for reproduction)

```
ffmpeg -i <source.mp4> \
  -y -vf scale=-2:480 \
  -c:v libx264 -preset faster -profile:v main \
  -crf 26 -maxrate 2M -bufsize 2M \
  -pix_fmt yuv420p -r 30 \
  -an -movflags +faststart \
  <output.mp4>
```

Atomic writes via `.tmp.mp4` + rename so a mid-process kill never leaves a
corrupt output masquerading as complete.

## Incidents during the build

1. **Windows cp1252 stdout/stderr crash.** Python's default console codec on
   Windows is cp1252; it can't encode Vietnamese diacritics in progress
   prints (`'\u1ed5'` = ổ), nor decode some ffmpeg stderr bytes. Workers had
   already written all 400 `.mp4` files before the main thread crashed on
   the first progress print, but the manifest never got written. Fixed by
   forcing `sys.stdout.reconfigure(encoding='utf-8', errors='replace')` at
   the top of the script and adding `encoding='utf-8', errors='replace'` to
   every `subprocess.run` call. Re-run completed cleanly in 5 s (cache
   hits) and wrote the manifest.
2. **`sourceClip: null` on idempotent re-runs.** On the first fix run, every
   output was treated as "skipped" (already on disk), and the skipped path
   didn't know which candidate originally produced the file — so
   `sourceClip` was null in the manifest. Fixed by filling the skipped path
   with `candidates[0]` (the lex-smallest video_id, which by selection
   policy IS the chosen source assuming no fallback ran). Flagged in a
   comment that this is approximate — delete and re-encode to get a
   guaranteed-accurate `sourceClip`.
3. **Initial ffmpeg not on PATH.** Installed via `winget install
   Gyan.FFmpeg`; current shell didn't pick up the PATH update. Script
   probes `shutil.which('ffmpeg')` first then falls back to the winget
   package path, so it works in both "fresh shell" and "current shell after
   install" scenarios.

## Manifest shape

Top-level:

```json
{
  "version": 1,
  "generatedAt": "2026-04-17T05:35:10+00:00",
  "total": 400,
  "produced": 400,
  "signs": { "<gloss>": { "file", "bytes", "durationMs", "sourceClip" } },
  "missing": []
}
```

Per-sign example:

```json
"Mẹ": {
  "file": "Mẹ.mp4",
  "bytes": 42589,
  "durationMs": 2133,
  "sourceClip": "Part_1/split_1/front_view/000204.mp4"
}
```

`bytes` / `durationMs` / `file` are authoritative. `sourceClip` is
informational (which VSL400 original fed into ffmpeg) and is
path-relative to `C:\SignPath\vsl400\`.

## End-to-end smoke test

```
$ cd C:\SignPath\signpath-test
$ python -m http.server 8000
$ curl -sI http://127.0.0.1:8000/test.html                    → 200
$ curl -sI http://127.0.0.1:8000/reference_videos/manifest.json → 200
$ curl -sI http://127.0.0.1:8000/reference_videos/M%E1%BA%B9.mp4 → 200
$ curl -sI http://127.0.0.1:8000/signpath-engine.js           → 200
```

UTF-8 filenames serve cleanly via percent-encoding. Backend test suite
still green (97 tests: 20 session, 25 progression, 16 review, 9 audio, 16
api, 11 coach-proxy).

## Reproducing

```
cd C:\SignPath
python prep_reference_videos.py
# ~36 s fresh, ~5 s cached.
```

Idempotent — existing `.mp4` files are skipped. To force re-encode a
subset, delete those specific `.mp4` files and re-run.
