"""
VSL400 → SignPath Training Pipeline
Extracts MediaPipe Holistic landmarks from VSL400 front-view videos,
normalizes to body-relative coordinates, and outputs a training dataset.

Usage:
    python extract_vsl400.py --step extract --workers 4
    python extract_vsl400.py --step build
    python extract_vsl400.py --step all --workers 4

Run from C:\SignPath with dataset in C:\SignPath\vsl400\
"""

import argparse
import json
import math
import cv2
import numpy as np
from pathlib import Path
from multiprocessing import Pool, freeze_support
from datetime import datetime
from collections import Counter
from tqdm import tqdm

# ─── CONFIG ───────────────────────────────────────────────────────────────────
def _process_task(args):
    """Top-level function for multiprocessing (must be picklable)."""
    vp, meta, op = args
    return extract_one_video((Path(vp), meta, Path(op)))

BASE_DIR = Path(r"C:\SignPath")
VSL400_DIR = BASE_DIR / "vsl400"
LANDMARKS_DIR = BASE_DIR / "vsl400_landmarks"
OUTPUT_PATH = BASE_DIR / "dataset" / "vsl400-training.json"

# MediaPipe pose indices for the 162-float feature vector
# 11=L.shoulder, 12=R.shoulder, 13=L.elbow, 14=R.elbow, 15=L.wrist, 16=R.wrist, 0=nose
POSE_INDICES = [11, 12, 13, 14, 15, 16, 0]
# Face subset: 1=nose tip, 10=forehead, 152=chin, 234=L.ear, 454=R.ear
FACE_INDICES = [1, 10, 152, 234, 454]


# ─── STEP 1: EXTRACT LANDMARKS ───────────────────────────────────────────────

def find_all_splits():
    """Find all split directories and their front_view metadata."""
    splits = []
    for part_dir in sorted(VSL400_DIR.glob("Part_*")):
        for split_dir in sorted(part_dir.glob("split_*")):
            meta_path = split_dir / "front_view.json"
            video_dir = split_dir / "front_view"
            if meta_path.exists() and video_dir.exists():
                splits.append((meta_path, video_dir))

    # Also check if splits are directly in vsl400 dir (alternative extraction)
    for split_dir in sorted(VSL400_DIR.glob("split_*")):
        meta_path = split_dir / "front_view.json"
        video_dir = split_dir / "front_view"
        if meta_path.exists() and video_dir.exists():
            if (meta_path, video_dir) not in splits:
                splits.append((meta_path, video_dir))

    return splits


def extract_one_video(args):
    """Process a single video file through MediaPipe Holistic."""
    import mediapipe as mp  # Import inside worker to avoid multiprocessing issues

    video_path, metadata, output_path = args

    if output_path.exists():
        return {"status": "skipped", "video_id": metadata["video_id"]}

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return {"status": "error", "video_id": metadata["video_id"], "reason": "cannot open"}

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames = []
    hand_count = 0
    both_hands_count = 0
    pose_count = 0

    mp_holistic = mp.solutions.holistic

    with mp_holistic.Holistic(
            static_image_mode=False,
            model_complexity=1,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
    ) as holistic:

        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = holistic.process(rgb)

            left_hand = None
            right_hand = None
            pose = None
            face = None

            if results.left_hand_landmarks:
                left_hand = [[lm.x, lm.y, lm.z] for lm in results.left_hand_landmarks.landmark]
            if results.right_hand_landmarks:
                right_hand = [[lm.x, lm.y, lm.z] for lm in results.right_hand_landmarks.landmark]
            if results.pose_landmarks:
                pose = [[lm.x, lm.y, lm.z, lm.visibility] for lm in results.pose_landmarks.landmark]
                pose_count += 1
            if results.face_landmarks:
                face = [[lm.x, lm.y, lm.z] for lm in results.face_landmarks.landmark]

            has_left = left_hand is not None
            has_right = right_hand is not None
            if has_left or has_right:
                hand_count += 1
            if has_left and has_right:
                both_hands_count += 1

            frames.append({
                "frame_idx": frame_idx,
                "timestamp_ms": round(frame_idx / fps * 1000),
                "left_hand": left_hand,
                "right_hand": right_hand,
                "pose": pose,
                "face": face,
                "hands_detected": int(has_left) + int(has_right),
            })
            frame_idx += 1

    cap.release()

    if not frames:
        return {"status": "error", "video_id": metadata["video_id"], "reason": "no frames"}

    # Find active segment (where hands are visible)
    active = [i for i, f in enumerate(frames) if f["hands_detected"] > 0]
    if not active:
        return {"status": "error", "video_id": metadata["video_id"], "reason": "no hands"}

    start = max(0, active[0] - 3)
    end = min(len(frames) - 1, active[-1] + 3)
    active_frames = frames[start:end + 1]

    # Cap at 150 frames
    if len(active_frames) > 150:
        indices = np.linspace(0, len(active_frames) - 1, 150, dtype=int)
        active_frames = [active_frames[i] for i in indices]

    result = {
        "source": "vsl400",
        "video_id": metadata["video_id"],
        "signer_id": metadata.get("signer_id", "unknown"),
        "gloss": metadata["gloss"],
        "video_fps": fps,
        "video_resolution": [width, height],
        "total_frames": total_frames,
        "active_start_frame": start,
        "active_end_frame": end,
        "extracted_frames": len(active_frames),
        "frames": active_frames,
        "quality_metrics": {
            "hand_detection_rate": round(hand_count / max(1, total_frames), 3),
            "both_hands_rate": round(both_hands_count / max(1, total_frames), 3),
            "pose_detection_rate": round(pose_count / max(1, total_frames), 3),
        }
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(result, f)

    return {
        "status": "ok",
        "video_id": metadata["video_id"],
        "gloss": metadata["gloss"],
        "frames": len(active_frames),
        "hand_rate": result["quality_metrics"]["hand_detection_rate"],
    }


def run_extraction(workers=4):
    """Extract landmarks from all front-view videos."""
    LANDMARKS_DIR.mkdir(parents=True, exist_ok=True)

    splits = find_all_splits()
    if not splits:
        print("ERROR: No splits found. Expected folders like:")
        print("  C:\\SignPath\\vsl400\\Part_1\\split_1\\front_view.json")
        print("  C:\\SignPath\\vsl400\\Part_1\\split_1\\front_view\\000000.mp4")
        return

    print(f"Found {len(splits)} splits")

    # Build task list
    tasks = []
    for meta_path, video_dir in splits:
        with open(meta_path, encoding='utf-8') as f:
            metadata_list = json.load(f)

        for meta in metadata_list:
            video_path = video_dir / f"{meta['video_id']}.mp4"
            if not video_path.exists():
                continue
            out_path = LANDMARKS_DIR / f"{meta['video_id']}.json"
            tasks.append((str(video_path), meta, str(out_path)))

    # Convert paths back to Path objects for the worker (strings for pickling)
    task_tuples = [(Path(t[0]), t[1], Path(t[2])) for t in tasks]
    # Actually, multiprocessing needs picklable args — use strings
    task_tuples = tasks  # keep as strings

    print(f"Processing {len(tasks)} front-view videos with {workers} worker(s)")

    results = Counter()
    gloss_counts = Counter()

    if workers <= 1:
        for task in tqdm(tasks, desc="Extracting"):
            vp, meta, op = task
            r = extract_one_video((Path(vp), meta, Path(op)))
            results[r["status"]] += 1
            if r["status"] == "ok":
                gloss_counts[r["gloss"]] += 1
    else:
        with Pool(workers) as pool:
            for r in tqdm(pool.imap_unordered(_process_task, tasks), total=len(tasks), desc="Extracting"):
                results[r["status"]] += 1
                if r["status"] == "ok":
                    gloss_counts[r["gloss"]] += 1

    print(f"\nDone: {results['ok']} extracted, {results['skipped']} skipped, {results['error']} errors")
    print(f"Glosses with landmarks: {len(gloss_counts)}")

    # Save manifest
    manifest = {
        "total_extracted": results["ok"],
        "total_skipped": results["skipped"],
        "total_errors": results["error"],
        "glosses": dict(sorted(gloss_counts.items(), key=lambda x: x[0])),
    }
    with open(LANDMARKS_DIR / "manifest.json", "w", encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"Manifest saved to {LANDMARKS_DIR / 'manifest.json'}")


# ─── STEP 2: BUILD TRAINING DATASET ──────────────────────────────────────────

def normalize_to_body(frame):
    """Normalize landmarks relative to shoulder midpoint and width."""
    pose = frame.get("pose")
    origin = None
    scale = None
    ref_type = "none"

    # Primary: shoulders
    if pose and len(pose) > 16:
        ls = pose[11]
        rs = pose[12]
        if ls[3] > 0.5 and rs[3] > 0.5:
            origin = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2]
            scale = math.sqrt((ls[0] - rs[0]) ** 2 + (ls[1] - rs[1]) ** 2 + (ls[2] - rs[2]) ** 2)
            if scale > 0.01:
                ref_type = "body"

    # Fallback: wrist-based
    if ref_type == "none":
        rh = frame.get("right_hand") or frame.get("left_hand")
        if rh and len(rh) >= 10:
            origin = rh[0]
            scale = math.sqrt((rh[9][0] - rh[0][0]) ** 2 + (rh[9][1] - rh[0][1]) ** 2 + (rh[9][2] - rh[0][2]) ** 2)
            if scale > 0.001:
                ref_type = "palm"

    if not origin or not scale or scale < 0.001:
        return None, "none"

    def norm(lm):
        return [(lm[0] - origin[0]) / scale, (lm[1] - origin[1]) / scale, (lm[2] - origin[2]) / scale]

    rh = frame.get("right_hand")
    lh = frame.get("left_hand")

    dominant = [norm(lm) for lm in rh] if rh else None
    non_dominant = [norm(lm) for lm in lh] if lh else None

    # If only left hand, treat it as dominant
    if dominant is None and non_dominant is not None:
        dominant = non_dominant
        non_dominant = None

    norm_pose = None
    if pose and len(pose) > max(POSE_INDICES):
        norm_pose = [norm(pose[i][:3]) for i in POSE_INDICES]

    norm_face = None
    face = frame.get("face")
    if face and len(face) > max(FACE_INDICES):
        norm_face = [norm(face[i]) for i in FACE_INDICES]

    return {
        "dominant": dominant,
        "nonDominant": non_dominant,
        "pose": norm_pose,
        "faceSubset": norm_face,
    }, ref_type


def build_dataset():
    """Convert extracted landmarks into SignPath training format, streaming to disk."""
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    landmark_files = sorted(LANDMARKS_DIR.glob("*.json"))
    landmark_files = [f for f in landmark_files if f.name != "manifest.json"]

    if not landmark_files:
        print(f"ERROR: No landmark files found in {LANDMARKS_DIR}")
        return

    print(f"Building dataset from {len(landmark_files)} landmark files")

    skipped_quality = 0
    skipped_short = 0
    skipped_no_ref = 0
    skipped_corrupt = 0
    class_counts = Counter()
    signer_per_class = {}
    ref_type_counts = Counter()
    total_written = 0

    zeros_21 = [[0, 0, 0]] * 21
    zeros_pose = [[0, 0, 0]] * len(POSE_INDICES)
    zeros_face = [[0, 0, 0]] * len(FACE_INDICES)

    # Write samples one at a time to avoid holding everything in memory
    temp_path = OUTPUT_PATH.parent / "vsl400-training.tmp.jsonl"

    with open(temp_path, 'w', encoding='utf-8') as out_f:
        for lf in tqdm(landmark_files, desc="Building"):
            try:
                with open(lf, encoding='utf-8') as f:
                    data = json.load(f)
            except (json.JSONDecodeError, Exception):
                skipped_corrupt += 1
                continue

            gloss = data.get("gloss", "")
            if not gloss:
                continue

            quality = data.get("quality_metrics", {})
            if quality.get("hand_detection_rate", 0) < 0.4:
                skipped_quality += 1
                continue
            if data.get("extracted_frames", 0) < 15:
                skipped_short += 1
                continue

            normalized_frames = []
            frame_ref_types = Counter()

            for frame in data["frames"]:
                nf, rt = normalize_to_body(frame)
                frame_ref_types[rt] += 1

                if nf is None:
                    normalized_frames.append({
                        "dominant": zeros_21, "nonDominant": zeros_21,
                        "pose": zeros_pose, "faceSubset": zeros_face,
                    })
                else:
                    normalized_frames.append({
                        "dominant": nf["dominant"] or zeros_21,
                        "nonDominant": nf["nonDominant"] or zeros_21,
                        "pose": nf["pose"] or zeros_pose,
                        "faceSubset": nf["faceSubset"] or zeros_face,
                    })

            primary_ref = frame_ref_types.most_common(1)[0][0] if frame_ref_types else "none"
            if primary_ref == "none":
                skipped_no_ref += 1
                continue

            ref_type_counts[primary_ref] += 1
            signer_id = data.get("signer_id", "unknown")

            sample = {
                "signKey": gloss,
                "frames": normalized_frames,
                "metadata": {
                    "source": "vsl400",
                    "video_id": data["video_id"],
                    "signer_id": signer_id,
                    "gloss_original": gloss,
                    "referenceType": primary_ref,
                    "frameCount": len(normalized_frames),
                    "duration": round(len(normalized_frames) / max(1, data.get("video_fps", 25)) * 1000),
                    "handDetectionRate": quality.get("hand_detection_rate", 0),
                    "bothHandsRate": quality.get("both_hands_rate", 0),
                    "timestamp": int(datetime.now().timestamp() * 1000),
                }
            }

            # Write one line per sample
            out_f.write(json.dumps(sample, ensure_ascii=False) + '\n')
            total_written += 1
            class_counts[gloss] += 1
            if gloss not in signer_per_class:
                signer_per_class[gloss] = set()
            signer_per_class[gloss].add(signer_id)

    # Now assemble final JSON from the temp file
    print(f"\nAssembling final dataset ({total_written} samples)...")

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as out_f:
        out_f.write('{"version":"1.0","source":"vsl400","exportDate":"')
        out_f.write(datetime.now().isoformat())
        out_f.write('","totalSamples":')
        out_f.write(str(total_written))
        out_f.write(',"totalClasses":')
        out_f.write(str(len(class_counts)))
        out_f.write(',"classes":')
        out_f.write(json.dumps(sorted(class_counts.keys()), ensure_ascii=False))
        out_f.write(',"samples":[')

        first = True
        with open(temp_path, 'r', encoding='utf-8') as tmp_f:
            for line in tmp_f:
                if not first:
                    out_f.write(',')
                out_f.write(line.strip())
                first = False

        out_f.write(']}')

    # Cleanup temp file
    temp_path.unlink(missing_ok=True)

    # Print report
    print(f"\n{'=' * 60}")
    print(f"DATASET REPORT")
    print(f"{'=' * 60}")
    print(f"Total samples:       {total_written}")
    print(f"Total classes:       {len(class_counts)}")
    print(f"Total signers:       {len(set(s for signers in signer_per_class.values() for s in signers))}")
    print(f"Skipped (quality):   {skipped_quality}")
    print(f"Skipped (too short): {skipped_short}")
    print(f"Skipped (no ref):    {skipped_no_ref}")
    print(f"Skipped (corrupt):   {skipped_corrupt}")
    print(f"Normalization:       {dict(ref_type_counts)}")

    print(f"\nSAMPLES PER CLASS:")
    for cls, count in class_counts.most_common():
        signers = len(signer_per_class.get(cls, set()))
        print(f"  {cls:30s} {count:4d} samples  ({signers} signers)")

    low_classes = [c for c, n in class_counts.items() if n < 20]
    if low_classes:
        print(f"\n⚠ {len(low_classes)} classes with < 20 samples:")
        for c in low_classes:
            print(f"  {c}: {class_counts[c]}")

    size_mb = OUTPUT_PATH.stat().st_size / 1e6
    print(f"\nSaved to {OUTPUT_PATH} ({size_mb:.1f} MB)")

    # Save stats
    stats_path = OUTPUT_PATH.parent / "dataset-stats.json"
    stats = {
        "totalSamples": total_written,
        "totalClasses": len(class_counts),
        "samplesPerClass": dict(class_counts.most_common()),
        "signersPerClass": {cls: len(signers) for cls, signers in signer_per_class.items()},
    }
    with open(stats_path, "w", encoding='utf-8') as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    print(f"Stats saved to {stats_path}")

# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="VSL400 → SignPath Training Pipeline")
    parser.add_argument("--step", choices=["extract", "build", "all"], required=True,
                        help="extract = run MediaPipe on videos, build = create training JSON, all = both")
    parser.add_argument("--workers", type=int, default=4,
                        help="Parallel workers for extraction (default 4)")
    args = parser.parse_args()

    if args.step in ("extract", "all"):
        print("=" * 60)
        print("STEP 1: EXTRACTING LANDMARKS")
        print("=" * 60)
        run_extraction(workers=args.workers)

    if args.step in ("build", "all"):
        print("\n" + "=" * 60)
        print("STEP 2: BUILDING TRAINING DATASET")
        print("=" * 60)
        build_dataset()


if __name__ == "__main__":
    freeze_support()  # Required for multiprocessing on Windows
    main()