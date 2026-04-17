"""
Build Sign Templates from VSL400 Landmarks
============================================
Reads raw landmark files, applies shoulder-based normalization (same as
the browser engine), resamples to a fixed frame count, and averages all
recordings of each sign into a single reference template.

Output: sign-templates.json (~20-30 MB) containing the mean normalized
landmark sequence for each of the 400 signs.

Usage:
    python build_templates.py
    python build_templates.py --landmarks C:\SignPath\vsl400_landmarks --output sign-templates.json --frames 60
"""

import argparse
import json
import math
import numpy as np
from pathlib import Path
from collections import defaultdict
from tqdm import tqdm

# ─── CONFIG (must match engine's _buildFrame exactly) ─────────────────────────

NUM_FEATURES = 162
POSE_INDICES = [11, 12, 13, 14, 15, 16, 0]   # shoulders, elbows, wrists, nose
FACE_INDICES = [1, 10, 152, 234, 454]          # nose tip, forehead, chin, ears
SHOULDER_VIS = 0.5
MIN_SHOULDER_W = 0.01
MIN_PALM = 0.001
DEFAULT_FRAMES = 60   # resample all sequences to this length


def pick_origin(pose, right_hand, left_hand):
    """Find normalization origin + scale. Mirrors engine's _pickOrigin."""
    # Primary: shoulders
    if pose and len(pose) > 16:
        ls = pose[11]  # [x, y, z, visibility]
        rs = pose[12]
        lv = ls[3] if len(ls) > 3 else 1.0
        rv = rs[3] if len(rs) > 3 else 1.0
        if lv > SHOULDER_VIS and rv > SHOULDER_VIS:
            ox = (ls[0] + rs[0]) / 2
            oy = (ls[1] + rs[1]) / 2
            oz = (ls[2] + rs[2]) / 2
            s = math.sqrt((ls[0]-rs[0])**2 + (ls[1]-rs[1])**2 + (ls[2]-rs[2])**2)
            if s > MIN_SHOULDER_W:
                return ox, oy, oz, s

    # Fallback: palm-based
    hand = right_hand or left_hand
    if hand and len(hand) >= 10:
        w = hand[0]
        m = hand[9]
        s = math.sqrt((m[0]-w[0])**2 + (m[1]-w[1])**2 + (m[2]-w[2])**2)
        if s > MIN_PALM:
            return w[0], w[1], w[2], s

    return None


def build_frame(frame_data):
    """Convert one raw frame into a 162-float vector. Mirrors engine's _buildFrame."""
    result = np.zeros(NUM_FEATURES, dtype=np.float32)

    right_hand = frame_data.get("right_hand")
    left_hand = frame_data.get("left_hand")
    pose = frame_data.get("pose")
    face = frame_data.get("face")

    origin = pick_origin(pose, right_hand, left_hand)
    if origin is None:
        return result

    ox, oy, oz, scale = origin

    def norm(lm):
        if lm is None:
            return None
        return [
            (lm[0] - ox) / scale,
            (lm[1] - oy) / scale,
            ((lm[2] if len(lm) > 2 else 0) - oz) / scale,
        ]

    # Dominant = right, fallback to left
    dom = right_hand
    non_dom = left_hand
    if dom is None and non_dom is not None:
        dom = non_dom
        non_dom = None

    # Dominant hand: offset 0 (21 × 3 = 63)
    if dom and len(dom) >= 21:
        for i in range(21):
            v = norm(dom[i])
            if v:
                result[i*3] = v[0]
                result[i*3+1] = v[1]
                result[i*3+2] = v[2]

    # Non-dominant: offset 63
    if non_dom and len(non_dom) >= 21:
        for i in range(21):
            v = norm(non_dom[i])
            if v:
                result[63 + i*3] = v[0]
                result[63 + i*3+1] = v[1]
                result[63 + i*3+2] = v[2]

    # Pose subset: offset 126 (7 × 3 = 21)
    if pose and len(pose) > max(POSE_INDICES):
        for i, idx in enumerate(POSE_INDICES):
            lm = pose[idx]
            v = norm(lm[:3])  # strip visibility
            if v:
                result[126 + i*3] = v[0]
                result[126 + i*3+1] = v[1]
                result[126 + i*3+2] = v[2]

    # Face subset: offset 147 (5 × 3 = 15)
    if face and len(face) > max(FACE_INDICES):
        for i, idx in enumerate(FACE_INDICES):
            lm = face[idx]
            v = norm(lm)
            if v:
                result[147 + i*3] = v[0]
                result[147 + i*3+1] = v[1]
                result[147 + i*3+2] = v[2]

    return result


def resample_sequence(seq, target_len):
    """Resample a (N, 162) sequence to (target_len, 162) using linear interpolation."""
    n = len(seq)
    if n == target_len:
        return np.array(seq)
    if n == 0:
        return np.zeros((target_len, NUM_FEATURES), dtype=np.float32)

    seq = np.array(seq, dtype=np.float32)
    indices = np.linspace(0, n - 1, target_len)
    result = np.zeros((target_len, NUM_FEATURES), dtype=np.float32)

    for i, idx in enumerate(indices):
        lo = int(idx)
        hi = min(lo + 1, n - 1)
        frac = idx - lo
        result[i] = seq[lo] * (1 - frac) + seq[hi] * frac

    return result


def process_one_file(landmark_path, target_frames):
    """Read one landmark JSON and return (gloss, normalized_sequence) or (None, None)."""
    try:
        with open(landmark_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (json.JSONDecodeError, Exception):
        return None, None

    gloss = data.get("gloss", "")
    if not gloss:
        return None, None

    frames = data.get("frames", [])
    if len(frames) < 10:
        return None, None

    # Quality gate
    quality = data.get("quality_metrics", {})
    if quality.get("hand_detection_rate", 0) < 0.4:
        return None, None

    # Normalize each frame to 162-float vector
    normalized = []
    for frame in frames:
        vec = build_frame(frame)
        # Skip zero frames (no usable landmarks)
        if np.any(vec[:63] != 0):  # at least dominant hand has data
            normalized.append(vec)

    if len(normalized) < 10:
        return None, None

    # Resample to target frame count
    resampled = resample_sequence(normalized, target_frames)
    return gloss, resampled


def main():
    parser = argparse.ArgumentParser(description="Build sign templates from VSL400 landmarks")
    parser.add_argument("--landmarks", default=r"C:\SignPath\vsl400_landmarks",
                        help="Directory of extracted landmark JSONs")
    parser.add_argument("--output", default="sign-templates.json",
                        help="Output template file")
    parser.add_argument("--frames", type=int, default=DEFAULT_FRAMES,
                        help=f"Frames per template (default {DEFAULT_FRAMES})")
    parser.add_argument("--min-samples", type=int, default=10,
                        help="Minimum recordings per sign to include")
    args = parser.parse_args()

    landmarks_dir = Path(args.landmarks)
    target_frames = args.frames

    # Find all landmark files
    files = sorted(landmarks_dir.glob("*.json"))
    files = [f for f in files if f.name not in ("manifest.json", "extraction_manifest.json")]
    print(f"Found {len(files)} landmark files")
    print(f"Target frames per template: {target_frames}")

    # Process all files and group by gloss
    gloss_sequences = defaultdict(list)
    skipped = 0

    for fpath in tqdm(files, desc="Processing"):
        gloss, seq = process_one_file(fpath, target_frames)
        if gloss is not None:
            gloss_sequences[gloss].append(seq)
        else:
            skipped += 1

    print(f"\nProcessed: {len(files) - skipped} usable, {skipped} skipped")
    print(f"Unique glosses: {len(gloss_sequences)}")

    # Build templates by averaging
    templates = {}
    low_sample_glosses = []

    for gloss, sequences in sorted(gloss_sequences.items()):
        n = len(sequences)
        if n < args.min_samples:
            low_sample_glosses.append((gloss, n))
            continue

        # Stack all sequences: (n_samples, target_frames, 162)
        stacked = np.stack(sequences)

        # Compute mean template
        mean_template = np.mean(stacked, axis=0)  # (target_frames, 162)

        # Compute consistency score (lower std = more consistent across signers)
        std_template = np.std(stacked, axis=0)
        consistency = 1.0 - float(np.mean(std_template))
        consistency = max(0.0, min(1.0, consistency))

        # Round to 3 decimal places to reduce file size
        mean_rounded = np.round(mean_template, 3).tolist()

        templates[gloss] = {
            "mean": mean_rounded,
            "sampleCount": n,
            "consistency": round(consistency, 3),
        }

    print(f"\nTemplates built: {len(templates)}")
    if low_sample_glosses:
        print(f"Excluded (< {args.min_samples} samples): {len(low_sample_glosses)}")
        for g, n in low_sample_glosses:
            print(f"  {g}: {n} samples")

    # Summary stats
    sample_counts = [t["sampleCount"] for t in templates.values()]
    print(f"\nSamples per template: min={min(sample_counts)}, max={max(sample_counts)}, "
          f"mean={sum(sample_counts)/len(sample_counts):.0f}")

    consistencies = [t["consistency"] for t in templates.values()]
    print(f"Consistency scores: min={min(consistencies):.3f}, max={max(consistencies):.3f}, "
          f"mean={sum(consistencies)/len(consistencies):.3f}")

    # Save
    output = {
        "version": "1.0",
        "frameCount": target_frames,
        "featureCount": NUM_FEATURES,
        "templateCount": len(templates),
        "poseIndices": POSE_INDICES,
        "faceIndices": FACE_INDICES,
        "templates": templates,
    }

    output_path = Path(args.output)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False)

    size_mb = output_path.stat().st_size / 1e6
    print(f"\nSaved to {output_path} ({size_mb:.1f} MB)")

    # Suggest gzip for serving
    print(f"\nTip: Enable gzip in your web server to reduce download to ~{size_mb/5:.0f}-{size_mb/4:.0f} MB")
    print(f"Or pre-compress: python -c \"import gzip; open('{output_path}.gz','wb').write(gzip.compress(open('{output_path}','rb').read()))\"")


if __name__ == "__main__":
    main()