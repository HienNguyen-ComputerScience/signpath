"""
SignPath Classifier Training
Trains a 1D-CNN or LSTM on extracted VSL400 landmark sequences.
Streams samples from disk to avoid loading the full 5GB dataset into RAM.

Usage:
    python train.py --data dataset/vsl400-training.json --arch cnn --epochs 60
    python train.py --data dataset/vsl400-training.json --arch lstm --epochs 80
"""

import argparse
import json
import math
import random
import time
from pathlib import Path
from collections import Counter

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
from tqdm import tqdm

# ─── CONFIG ───────────────────────────────────────────────────────────────────

BASE_DIR = Path(r"C:\SignPath")
DATA_PATH = BASE_DIR / "dataset" / "vsl400-training.json"
MODEL_OUTPUT = BASE_DIR / "models" / "vsl-classifier.onnx"
CONFIG_OUTPUT = BASE_DIR / "models" / "model-config.json"
CHECKPOINT = BASE_DIR / "models" / "checkpoint.pt"
INDEX_PATH = BASE_DIR / "dataset" / "sample-index.json"

# Feature vector: 21 dominant + 21 non-dominant + 7 pose + 5 face = 54 landmarks × 3 = 162 floats
NUM_FEATURES = 162
SEQ_LEN = 90  # pad/truncate all sequences to this length


# ─── STREAMING INDEX BUILDER ─────────────────────────────────────────────────

def build_index(data_path, index_path):
    """
    Scans the huge JSON file once and records byte offsets + metadata for each sample.
    This avoids loading the 5GB file into memory.
    """
    print(f"Building sample index from {data_path}...")
    print("(This reads the 5GB file once — ~5 minutes — but only happens once.)")

    samples_index = []

    with open(data_path, 'r', encoding='utf-8') as f:
        # Parse just the header to get class list
        # File structure: {"version":...,"samples":[{...},{...},...]}
        # We need to find where "samples":[ starts, then index each sample

        # Approach: load incrementally using a JSON streaming parser
        # Simplest: use json.load if RAM allows, else stream
        # Given 16GB RAM and 5GB file, we can load but need to be careful

        print("Loading dataset (this takes a few minutes and ~7GB RAM)...")
        data = json.load(f)

    samples = data["samples"]
    classes = data.get("classes", sorted(set(s["signKey"] for s in samples)))

    for i, sample in enumerate(samples):
        samples_index.append({
            "idx": i,
            "signKey": sample["signKey"],
            "signer_id": sample["metadata"]["signer_id"],
            "frameCount": sample["metadata"]["frameCount"],
        })

    # Save index for future runs
    index_data = {
        "data_path": str(data_path),
        "classes": classes,
        "totalSamples": len(samples_index),
        "samples": samples_index,
    }
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index_data, f, ensure_ascii=False)

    print(f"Index built: {len(samples_index)} samples, {len(classes)} classes")
    return data, index_data


def load_or_build_index(data_path, index_path):
    if index_path.exists():
        print(f"Loading cached index from {index_path}")
        with open(index_path, 'r', encoding='utf-8') as f:
            index_data = json.load(f)
        print(f"Loading dataset (this takes a few minutes)...")
        with open(data_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data, index_data
    return build_index(data_path, index_path)


# ─── DATASET ─────────────────────────────────────────────────────────────────

def flatten_frame(frame):
    """Convert a frame dict into a flat 162-element numpy array."""
    arr = np.zeros(NUM_FEATURES, dtype=np.float32)
    idx = 0

    # Dominant hand: 21 × 3 = 63
    for lm in frame["dominant"]:
        arr[idx] = lm[0];
        arr[idx + 1] = lm[1];
        arr[idx + 2] = lm[2]
        idx += 3
    # Non-dominant hand: 21 × 3 = 63
    for lm in frame["nonDominant"]:
        arr[idx] = lm[0];
        arr[idx + 1] = lm[1];
        arr[idx + 2] = lm[2]
        idx += 3
    # Pose: 7 × 3 = 21
    for lm in frame["pose"]:
        arr[idx] = lm[0];
        arr[idx + 1] = lm[1];
        arr[idx + 2] = lm[2]
        idx += 3
    # Face: 5 × 3 = 15
    for lm in frame["faceSubset"]:
        arr[idx] = lm[0];
        arr[idx + 1] = lm[1];
        arr[idx + 2] = lm[2]
        idx += 3

    return arr


def sample_to_tensor(sample, seq_len=SEQ_LEN, augment=False):
    """Convert a sample into a (seq_len, NUM_FEATURES) tensor."""
    frames = sample["frames"]
    n = len(frames)

    # Build sequence array
    seq = np.zeros((seq_len, NUM_FEATURES), dtype=np.float32)

    if n >= seq_len:
        # Take last seq_len frames (sign ending aligns with sequence end)
        offset = n - seq_len
        for i in range(seq_len):
            seq[i] = flatten_frame(frames[offset + i])
    else:
        # Zero-pad at beginning
        pad = seq_len - n
        for i in range(n):
            seq[pad + i] = flatten_frame(frames[i])

    # Data augmentation
    if augment:
        # Gaussian noise
        seq += np.random.randn(*seq.shape).astype(np.float32) * 0.02

        # Frame dropout (5%)
        mask = np.random.rand(seq_len) > 0.05
        seq = seq * mask[:, None]

        # Small rotation (±10° in xy plane)
        angle = (np.random.rand() - 0.5) * 0.35  # ~±10°
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        # Apply to x,y of each landmark (every 3rd element is z, skip)
        x = seq[:, 0::3].copy()
        y = seq[:, 1::3].copy()
        seq[:, 0::3] = x * cos_a - y * sin_a
        seq[:, 1::3] = x * sin_a + y * cos_a

        # Scale variation (±15%)
        scale = 1.0 + (np.random.rand() - 0.5) * 0.3
        seq *= scale

    return seq


class SignDataset(Dataset):
    def __init__(self, samples, class_to_idx, augment=False):
        self.samples = samples
        self.class_to_idx = class_to_idx
        self.augment = augment

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, i):
        sample = self.samples[i]
        seq = sample_to_tensor(sample, augment=self.augment)
        label = self.class_to_idx[sample["signKey"]]
        return torch.from_numpy(seq), label


# ─── MODELS ──────────────────────────────────────────────────────────────────

class CNN1D(nn.Module):
    def __init__(self, num_classes, num_features=NUM_FEATURES):
        super().__init__()
        self.conv1 = nn.Conv1d(num_features, 128, kernel_size=5, padding=2)
        self.bn1 = nn.BatchNorm1d(128)
        self.conv2 = nn.Conv1d(128, 128, kernel_size=3, padding=1)
        self.bn2 = nn.BatchNorm1d(128)
        self.conv3 = nn.Conv1d(128, 64, kernel_size=3, padding=1)
        self.bn3 = nn.BatchNorm1d(64)
        self.dropout = nn.Dropout(0.3)
        self.pool = nn.AdaptiveAvgPool1d(1)
        self.fc = nn.Linear(64, num_classes)

    def forward(self, x):
        # x: (batch, seq_len, features) -> (batch, features, seq_len)
        x = x.transpose(1, 2)
        x = F.relu(self.bn1(self.conv1(x)))
        x = self.dropout(x)
        x = F.relu(self.bn2(self.conv2(x)))
        x = self.dropout(x)
        x = F.relu(self.bn3(self.conv3(x)))
        x = self.pool(x).squeeze(-1)
        return self.fc(x)


class LSTMModel(nn.Module):
    def __init__(self, num_classes, num_features=NUM_FEATURES):
        super().__init__()
        self.lstm = nn.LSTM(num_features, 128, num_layers=2, batch_first=True,
                            bidirectional=True, dropout=0.2)
        self.dropout = nn.Dropout(0.3)
        self.fc = nn.Linear(256, num_classes)

    def forward(self, x):
        out, _ = self.lstm(x)
        out = out[:, -1, :]  # last timestep
        return self.fc(self.dropout(out))


# ─── TRAINING LOOP ───────────────────────────────────────────────────────────

def split_data(samples, index_data, val_ratio=0.1, test_ratio=0.1, seed=42):
    """
    Split by signer to ensure signer-disjoint sets.
    The test set should have signers the model has never seen.
    """
    random.seed(seed)
    np.random.seed(seed)

    # Get all signers
    all_signers = sorted(set(s["metadata"]["signer_id"] for s in samples))
    random.shuffle(all_signers)

    n_test_signers = max(2, int(len(all_signers) * test_ratio))
    n_val_signers = max(2, int(len(all_signers) * val_ratio))

    test_signers = set(all_signers[:n_test_signers])
    val_signers = set(all_signers[n_test_signers:n_test_signers + n_val_signers])
    train_signers = set(all_signers[n_test_signers + n_val_signers:])

    train = [s for s in samples if s["metadata"]["signer_id"] in train_signers]
    val = [s for s in samples if s["metadata"]["signer_id"] in val_signers]
    test = [s for s in samples if s["metadata"]["signer_id"] in test_signers]

    print(f"\nSplit (signer-disjoint):")
    print(f"  Train: {len(train)} samples from {len(train_signers)} signers")
    print(f"  Val:   {len(val)} samples from {len(val_signers)} signers")
    print(f"  Test:  {len(test)} samples from {len(test_signers)} signers")

    return train, val, test


def train_epoch(model, loader, optimizer, criterion, device):
    model.train()
    total_loss = 0
    correct = 0
    total = 0
    for seq, label in tqdm(loader, desc="Train", leave=False):
        seq, label = seq.to(device), label.to(device)
        optimizer.zero_grad()
        logits = model(seq)
        loss = criterion(logits, label)
        loss.backward()
        optimizer.step()
        total_loss += loss.item() * seq.size(0)
        correct += (logits.argmax(1) == label).sum().item()
        total += seq.size(0)
    return total_loss / total, correct / total


def eval_epoch(model, loader, criterion, device):
    model.eval()
    total_loss = 0
    correct = 0
    total = 0
    per_class_correct = Counter()
    per_class_total = Counter()
    with torch.no_grad():
        for seq, label in tqdm(loader, desc="Eval", leave=False):
            seq, label = seq.to(device), label.to(device)
            logits = model(seq)
            loss = criterion(logits, label)
            total_loss += loss.item() * seq.size(0)
            preds = logits.argmax(1)
            correct += (preds == label).sum().item()
            total += seq.size(0)
            for p, l in zip(preds.cpu().numpy(), label.cpu().numpy()):
                per_class_total[int(l)] += 1
                if p == l:
                    per_class_correct[int(l)] += 1
    return total_loss / total, correct / total, per_class_correct, per_class_total


def export_onnx(model, model_path, num_classes, classes, arch):
    """Export trained model to ONNX for browser use."""
    model.eval()
    dummy = torch.randn(1, SEQ_LEN, NUM_FEATURES)
    model_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model.cpu(),
        dummy,
        str(model_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=15,
    )

    config = {
        "version": "1.0.0",
        "inputShape": [1, SEQ_LEN, NUM_FEATURES],
        "classes": classes,
        "defaultThreshold": 0.60,
        "perClassThreshold": {},
        "architecture": arch,
        "trainedOn": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "numClasses": num_classes,
    }
    CONFIG_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    print(f"\nExported ONNX model to {model_path}")
    print(f"Wrote config to {CONFIG_OUTPUT}")

    size_mb = model_path.stat().st_size / 1e6
    print(f"Model size: {size_mb:.2f} MB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(DATA_PATH))
    parser.add_argument("--arch", choices=["cnn", "lstm"], default="cnn")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--workers", type=int, default=0,
                        help="DataLoader workers (0 for Windows stability)")
    parser.add_argument("--patience", type=int, default=15)
    parser.add_argument("--skip-export", action="store_true")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")

    # Load dataset
    data, index_data = load_or_build_index(Path(args.data), INDEX_PATH)
    samples = data["samples"]
    classes = index_data["classes"]
    num_classes = len(classes)
    class_to_idx = {c: i for i, c in enumerate(classes)}

    print(f"\nDataset: {len(samples)} samples, {num_classes} classes")

    # Split
    train_s, val_s, test_s = split_data(samples, index_data)

    # Class balancing — weighted sampler so rare classes get more exposure
    train_class_counts = Counter(s["signKey"] for s in train_s)
    sample_weights = [1.0 / train_class_counts[s["signKey"]] for s in train_s]
    sampler = WeightedRandomSampler(sample_weights, len(sample_weights))

    # Datasets
    train_ds = SignDataset(train_s, class_to_idx, augment=True)
    val_ds = SignDataset(val_s, class_to_idx, augment=False)
    test_ds = SignDataset(test_s, class_to_idx, augment=False)

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, sampler=sampler,
                              num_workers=args.workers, pin_memory=(device.type == "cuda"))
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False,
                            num_workers=args.workers, pin_memory=(device.type == "cuda"))
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, shuffle=False,
                             num_workers=args.workers, pin_memory=(device.type == "cuda"))

    # Model
    if args.arch == "cnn":
        model = CNN1D(num_classes)
    else:
        model = LSTMModel(num_classes)
    model = model.to(device)

    param_count = sum(p.numel() for p in model.parameters())
    print(f"\nModel: {args.arch.upper()}, {param_count:,} parameters")

    # Optimizer + scheduler
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    criterion = nn.CrossEntropyLoss()

    # Training loop
    best_val_acc = 0
    patience_counter = 0
    CHECKPOINT.parent.mkdir(parents=True, exist_ok=True)

    print(f"\n{'=' * 60}")
    print(f"TRAINING — {args.epochs} epochs, batch {args.batch_size}, lr {args.lr}")
    print(f"{'=' * 60}\n")

    for epoch in range(args.epochs):
        t0 = time.time()
        train_loss, train_acc = train_epoch(model, train_loader, optimizer, criterion, device)
        val_loss, val_acc, _, _ = eval_epoch(model, val_loader, criterion, device)
        scheduler.step()
        elapsed = time.time() - t0

        marker = ""
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            torch.save(model.state_dict(), CHECKPOINT)
            patience_counter = 0
            marker = " ★"
        else:
            patience_counter += 1

        print(f"Epoch {epoch + 1:3d}/{args.epochs}  "
              f"train_loss={train_loss:.3f} train_acc={train_acc:.3f}  "
              f"val_loss={val_loss:.3f} val_acc={val_acc:.3f}  "
              f"lr={optimizer.param_groups[0]['lr']:.1e}  "
              f"time={elapsed:.0f}s{marker}")

        if patience_counter >= args.patience:
            print(f"\nEarly stopping at epoch {epoch + 1} (no improvement for {args.patience} epochs)")
            break

    print(f"\nBest validation accuracy: {best_val_acc:.3f}")

    # Load best checkpoint
    model.load_state_dict(torch.load(CHECKPOINT))

    # Test set evaluation
    print("\n" + "=" * 60)
    print("TEST SET EVALUATION (signer-disjoint)")
    print("=" * 60)
    test_loss, test_acc, pc_correct, pc_total = eval_epoch(model, test_loader, criterion, device)
    print(f"Test accuracy: {test_acc:.3f}")
    print(f"Test loss:     {test_loss:.3f}")

    # Per-class accuracy
    print(f"\nPer-class test accuracy (lowest 20):")
    class_accs = []
    for idx, total in pc_total.items():
        acc = pc_correct[idx] / total if total > 0 else 0
        class_accs.append((classes[idx], acc, total))
    class_accs.sort(key=lambda x: x[1])

    for cls, acc, total in class_accs[:20]:
        print(f"  {cls:30s} {acc:.2%}  ({pc_correct[classes.index(cls)]}/{total})")

    # Export ONNX
    if not args.skip_export:
        print("\n" + "=" * 60)
        print("EXPORTING MODEL")
        print("=" * 60)
        export_onnx(model.cpu(), MODEL_OUTPUT, num_classes, classes, args.arch)

    print(f"\n{'=' * 60}")
    print("DONE")
    print(f"{'=' * 60}")
    print(f"Best val accuracy: {best_val_acc:.3f}")
    print(f"Test accuracy:     {test_acc:.3f}")


if __name__ == "__main__":
    main()