# Motion-Ratio Distribution Analysis

**Purpose:** Find an empirically-grounded value for `NONDOM_MOTION_RATIO_THRESHOLD`. The engine's current value is `0.3`, which produces zero activations against the 400-template corpus (see `SCORING_FIX_V2_REPORT.md`). This document recommends a new value based on the actual distribution and a hand-labeled validation set. **No engine code or tests were changed.**

Analysis artifacts:
- Full per-sign ratio table: [scripts/motion_ratios.json](scripts/motion_ratios.json)
- Standalone analysis script: [scripts/analyze_motion_ratios.js](scripts/analyze_motion_ratios.js)

## Distribution summary

Ratios computed for all **400 templates** using the engine's `_computeNonDomMotionRatio` formula verbatim.

| Statistic | Value | Gloss |
|---|---|---|
| Min | 0.3286 | `Thấp (đồ vật)` |
| Max | 1.1821 | `Giúp đỡ` |
| Mean | 0.7625 | — |
| Median (p50) | 0.8223 | — |

| Decile | Ratio |
|---|---|
| p10 | 0.4680 |
| p20 | 0.5300 |
| p30 | 0.5957 |
| p40 | 0.7024 |
| p50 | 0.8223 |
| p60 | 0.8926 |
| p70 | 0.9352 |
| p80 | 0.9570 |
| p90 | 0.9789 |

### Histogram

```
[0.30-0.35)    2 ██
[0.35-0.40)    8 ███████
[0.40-0.45)   20 ██████████████████
[0.45-0.50)   28 ██████████████████████████
[0.50-0.55)   30 ████████████████████████████
[0.55-0.60)   36 █████████████████████████████████   ← first peak (~0.55-0.60)
[0.60-0.65)   22 ████████████████████
[0.65-0.70)   13 ████████████
[0.70-0.75)   13 ████████████                        ← shallow valley (~0.65-0.75)
[0.75-0.80)   18 █████████████████
[0.80-0.85)   22 ████████████████████
[0.85-0.90)   33 ██████████████████████████████
[0.90-0.95)   60 ███████████████████████████████████████████████████████
[0.95-1.00)   65 ████████████████████████████████████████████████████████████  ← second peak (~0.95)
[1.00-1.05)   17 ████████████████
[1.05-1.10)    9 ████████
[1.10-1.15)    2 ██
[1.15-1.20)    2 ██
```

**The distribution is bimodal** — a first peak around 0.55-0.60 (36 signs in the single tallest bucket below 0.75) and a dominant second peak at 0.95-1.00 (65 signs in the single tallest bucket overall). Between them lies a shallow valley at 0.65-0.75 (only 13 signs per bucket).

### Largest gap in sorted order

The top 5 consecutive-pair gaps in the sorted ratio list:

| Rank | Gap size | From | To |
|---|---|---|---|
| 1 | 0.0397 | 1.1074 (`Bóng đá`) | 1.1472 (`Nông dân`) |
| 2 | 0.0260 | 1.0549 (`Bóng chuyền`) | 1.0808 (`Bánh xèo`) |
| 3 | 0.0217 | 1.1472 (`Nông dân`) | 1.1688 (`Quả đu đủ`) |
| 4 | 0.0209 | 0.3320 (`Dở`) | 0.3529 (`Lùn`) |
| 5 | 0.0182 | 0.3744 (`Tốt bụng`) | 0.3926 (`Cái áo`) |

No gap exceeds **0.04** — the distribution is gradient, not cleanly bimodal at the gap level. The bimodality visible in the histogram manifests as a density dip (valley), not a hard gap. **This means no threshold produces a clean split — we pick the threshold that minimizes mislabeling rather than one that lands in empty space.**

## Validation labels — hand-applied linguistic classification

Labels applied based on standard sign-language knowledge (not by inspecting ratios first). Signs not in the 400-template corpus are marked `(NOT IN CORPUS)`.

### Likely one-handed signs

| Sign | Measured ratio | Dom motion | Non-dom motion | Consistent with label? |
|---|---|---|---|---|
| `Mẹ` | 0.6814 | 1.760 | 1.199 | ✓ (below 0.75) |
| `Bố` | 0.6130 | 1.766 | 1.082 | ✓ |
| `Anh` | 0.5593 | 1.962 | 1.097 | ✓ |
| `Em` | 0.5276 | 1.734 | 0.915 | ✓ |
| `Cô` | 0.5221 | 2.014 | 1.052 | ✓ |
| `Dì` | 0.7116 | 1.987 | 1.414 | ✓ (borderline) |
| `Chú` | 0.5861 | 1.875 | 1.099 | ✓ |
| `Cậu` | 0.4667 | 1.851 | 0.864 | ✓ |
| `Ông nội` | 0.4525 | 2.148 | 0.972 | ✓ |
| `Bà nội` | 0.4699 | 2.023 | 0.951 | ✓ |
| `Con` | — | — | — | (not in corpus) |
| `Cháu` | **0.9984** | 1.910 | 1.906 | ❌ **HIGH** — see edge cases |
| `Ăn` | 0.6447 | 1.900 | 1.225 | ✓ |
| `Uống` | 0.5210 | 1.890 | 0.985 | ✓ |
| `Ngủ` | 0.5300 | 2.148 | 1.138 | ✓ |
| `Đau` | 0.5186 | 1.855 | 0.962 | ✓ |
| `Đi` | 0.4343 | 1.789 | 0.777 | ✓ |
| `Chạy` | **1.0822** | 1.320 | 1.429 | ❌ **HIGH** — see edge cases |
| `Cao (người)` | 0.3932 | 2.925 | 1.150 | ✓ |
| `Thấp (đồ vật)` | 0.3286 | 2.047 | 0.673 | ✓ |
| `Vui` | — | — | — | (not in corpus) |
| `Buồn` | — | — | — | (not in corpus) |
| `Năm` | **0.8924** | 1.648 | 1.470 | ❌ **HIGH** — see edge cases |
| `Bia` | 0.4864 | 2.103 | 1.023 | ✓ |
| `Cà phê` | **1.0081** | 1.535 | 1.547 | ❌ **HIGH** — see edge cases |
| `Trứng` | 0.4840 | 2.349 | 1.137 | ✓ |
| `Tôi` | — | — | — | (not in corpus) |
| `Muối` | — | — | — | (not in corpus) |
| `Đường` | — | — | — | (not in corpus) |

**Surviving one-handed sample: 23 signs.** 19 of them have ratio < 0.75 (consistent). 4 have high ratios and are flagged below in the Edge Cases section.

### Likely two-handed signs

| Sign | Measured ratio | Dom motion | Non-dom motion | Consistent with label? |
|---|---|---|---|---|
| `Cảm ơn` | 0.9642 | 2.152 | 2.075 | ✓ |
| `Xin lỗi` | 0.9905 | 1.616 | 1.601 | ✓ |
| `Tháng` | 0.9051 | 1.870 | 1.693 | ✓ |
| `Tháng một` | 0.8174 | 1.866 | 1.525 | ✓ |
| `Tháng hai` | 0.7728 | 1.991 | 1.539 | ✓ (borderline) |
| `Chủ nhật` | 0.9607 | 1.576 | 1.514 | ✓ |
| `Bánh mì` | — | — | — | (not in corpus) |
| `Áo đầm` | 0.8034 | 1.576 | 1.266 | ✓ |
| `Đồng hồ (đeo tay)` | — | — | — | (not exact gloss; `Đồng hồ đeo tay` at 0.7638 ✓) |
| `Bánh tét` | 0.8870 | 1.896 | 1.682 | ✓ |
| `Cầu lông` | 0.8795 | 2.750 | 2.419 | ✓ |
| `Ô tô` | 0.9253 | 1.785 | 1.652 | ✓ |
| `Xe máy` | 0.9224 | 1.548 | 1.428 | ✓ |
| `Bàn phím` | 0.9748 | 1.584 | 1.544 | ✓ |
| `Máy giặt` | 0.9269 | 1.597 | 1.480 | ✓ |
| `Điện thoại` | **0.6295** | 1.902 | 1.198 | ❌ **LOW** — see edge cases |
| `Gia đình` | — | — | — | (not in corpus) |
| `Trường học` | 0.9213 | 2.049 | 1.888 | ✓ |
| `Bệnh viện` | 0.9382 | 2.576 | 2.416 | ✓ |
| `Sân bay` | — | — | — | (not in corpus) |

**Surviving two-handed sample: 16 signs.** 15 of them have ratio ≥ 0.75 (consistent). 1 flagged below.

## Threshold sensitivity on the labeled set

Accuracy under each candidate threshold (39 labeled signs: 23 one-handed + 16 two-handed):

| Threshold | Correct-1H | Correct-2H | Missed-1H | False-2H | Accuracy |
|---|---|---|---|---|---|
| 0.30 | 0 | 16 | 23 | 0 | 41.0% |
| 0.40 | 2 | 16 | 21 | 0 | 46.2% |
| 0.50 | 8 | 16 | 15 | 0 | 61.5% |
| 0.55 | 13 | 16 | 10 | 0 | 74.4% |
| 0.60 | 15 | 16 | 8 | 0 | 79.5% |
| 0.65 | 17 | 15 | 6 | 1 | 82.1% |
| 0.70 | 18 | 15 | 5 | 1 | 84.6% |
| **0.75** | **19** | **15** | **4** | **1** | **87.2%** |
| 0.80 | 19 | 14 | 4 | 2 | 84.6% |

**Accuracy peaks at T=0.75 (87.2%)**, declines beyond. The exact peak value isn't very sensitive in the 0.70-0.75 band — both produce 85-87%. The sweet spot aligns with the histogram's shallow valley at 0.65-0.75.

## Recommendation

**Recommended threshold: `0.75`.**

### Rationale

1. **Highest accuracy on the hand-labeled validation set (87.2%).** Chosen specifically because it outperforms adjacent values at ±0.05.
2. **Aligns with the empirical valley at 0.65-0.75** — the histogram's sparsest band between the two density modes. No hard gap exists, but 0.75 sits near the density minimum.
3. **Splits the 400-template corpus meaningfully**: under T=0.75, **172 templates classify as one-handed** and **228 as two-handed** (43/57 split), which is a reasonable distribution for a sign language where many signs are body-referential with a resting second hand.

Under this threshold:
- The min ratio in the "two-handed" bucket is 0.7535 (`Cay`).
- The max ratio in the "one-handed" bucket is 0.7400 (`Tháng mười một`).

### Confidence: **medium**

**Why medium, not high:**

- **Soft bimodality.** The distribution has two density peaks but the valley between them is shallow. No strong gap means borderline signs near 0.70-0.80 will be sensitive to small shifts in the input data and the exact threshold. A future re-run of the templates with a slightly different corpus could move a dozen signs across the boundary.
- **Small validation set.** 39 labeled signs is a useful sanity check but not a rigorous benchmark. A linguist-audited sample of 100+ signs would provide a stronger signal.
- **Metric limitations.** Known one-handed family signs (`Ông nội`, `Bà nội`) score 0.45+ — well above the intuitive "stationary non-dom" baseline. This reflects real non-dom motion in VSL400 (signers don't hold their second hand perfectly still during recording), not a bug. The metric measures what it measures, but the threshold is a compromise between signal and noise.
- **A few signs that should land one side fall on the other** (4 false-1H + 1 false-2H at T=0.75). Discussed in edge cases below.

**Why not low:** the threshold does cleanly classify the bulk of well-known cases. 34 of 39 labeled signs end up on the correct side. That's significantly better than the engine's current `0.3` (which gets 16/39 right — only the trivially-two-handed cases).

## Edge cases — signs where the metric disagrees with linguistic intuition

### Signs labeled one-handed but scoring HIGH (≥ 0.75)

#### `Cháu` — ratio 0.9984 (dom=1.910, non-dom=1.906)

Both hands show nearly identical motion extents. Two plausible explanations:
- **Signer variance during VSL400 recording.** Some signers may have performed `Cháu` (grandchild/niece) as a two-handed sign by convention, and the template averages them all. If ~40% of signers used two hands, their motion would significantly bulk up the non-dom mean.
- **Sympathetic body motion.** `Cháu` involves a specific gesture at chin-height that may cause the non-dom arm to swing slightly in sympathy with the dom hand. Averaging across signers smooths this into coherent "motion."

**Verdict:** probably legitimate two-handed variance in the corpus. Relabeling `Cháu` as two-handed in our validation set would keep T=0.75 correct.

#### `Chạy` — ratio 1.0822 (dom=1.320, non-dom=1.429)

"Run" — intuitively one-handed but the signer's natural arm-swing when miming running produces symmetric motion in both arms. The non-dom hand actually moves MORE than the dom (hence ratio > 1.0). This is a case where the sign is linguistically one-handed but kinesthetically two-handed.

**Verdict:** the metric is correct in labeling this two-handed; our linguistic label was too strict.

#### `Cà phê` — ratio 1.0081 (dom=1.535, non-dom=1.547)

In VSL, `Cà phê` (coffee) is often signed as mimed stirring — one hand holds the cup while the other stirs. Both hands are active. The "linguistically one-handed" label I applied was wrong.

**Verdict:** genuine two-handed sign; mislabel on our side.

#### `Năm` — ratio 0.8924 (dom=1.648, non-dom=1.470)

`Năm` means both "five" (the number) and "year." If signers in VSL400 performed it as "year" (a temporal sign that often uses a rotating hand), the rotation of both hands produces meaningful non-dom motion. If they performed it as "five" (finger-counting), it's one-handed.

**Verdict:** ambiguous gloss. Probably reflects the "year" interpretation dominating the averaged template.

### Signs labeled two-handed but scoring LOW (< 0.75)

#### `Điện thoại` — ratio 0.6295 (dom=1.902, non-dom=1.198)

"Phone" — I labeled as two-handed based on the idea of miming both holding a phone and pressing buttons. In VSL, however, `Điện thoại` is commonly signed with a single hand as a "phone-to-ear" gesture (the "hang-loose" handshape near the ear). The non-dom plays a very minor role.

**Verdict:** genuine one-handed sign; mislabel on our side.

### Miscellaneous borderline observations

Month signs cluster tightly around the threshold:
- `Tháng mười một` → 0.7400 (just BELOW T=0.75 → one-handed)
- `Tháng sáu` → 0.7642 (just ABOVE → two-handed)
- `Tháng mười hai` → 0.7685 (just ABOVE → two-handed)

All 12 month signs use the same root gesture and differ only in the appended number. They should classify identically but ratio differences push them across the boundary. This is a **metric instability** issue — no threshold avoids it because the month signs happen to cluster exactly where the density valley sits.

## Summary of the recommendation

| Question | Answer |
|---|---|
| Recommended threshold | **0.75** |
| Templates that activate (one-handed) under this threshold | 172 of 400 (43%) |
| Templates that do NOT activate (two-handed) | 228 of 400 (57%) |
| Accuracy on labeled validation set | 87.2% (34/39) |
| Confidence | Medium |
| Does a cleaner threshold exist? | No. The distribution is gradient; the valley at 0.65-0.75 is the best available split. |
| Should the metric itself change? | **Flagged but not explored in this report** — four labeled-one-handed signs and one labeled-two-handed sign misclassify, and several look like genuine metric corner-cases (body-sympathetic motion, ambiguous glosses, natural two-hand artefacts). If the raw pass rate of 87% isn't acceptable, an alternative metric should be investigated (see out-of-scope discussion in `SCORING_FIX_V2_REPORT.md` — absolute non-dom motion, or per-frame landmark dispersion). |

## What happens if Phuong adopts 0.75

Under T=0.75, the engine would activate skip-non-dom for 172 of 400 signs — including the known-one-handed family signs (`Mẹ`, `Bố`, `Anh`, `Em`, `Cô`, `Dì`, `Chú`, `Cậu`, `Ông nội`, `Bà nội`) that motivated Fix 1 in the first place. These signs would score substantially higher for a user signing one-handed (correctly) because the template's residual non-dom energy would no longer drag the whole-frame cosine.

A few two-handed signs near the boundary (`Tháng hai` at 0.7728, `Áo đầm` at 0.8034) would remain correctly classified as two-handed. A few signs that really ARE one-handed (`Điện thoại` at 0.6295) already were below 0.75 and would activate.

The main tradeoff: 4 signs from the labeled-one-handed list (`Cháu`, `Chạy`, `Cà phê`, `Năm`) would stay classified as two-handed. Of these, three are probably genuinely two-handed in VSL convention, and one is ambiguous (`Năm`). So the tradeoff is small.

**Net recommendation:** change `NONDOM_MOTION_RATIO_THRESHOLD` from `0.3` to `0.75`. That's a single-constant edit with no test changes required beyond those that assert the threshold value directly (none of our existing tests do — they stub the ratio via `opts.nonDomMotionRatio`, so they're threshold-agnostic).

## Applied

Threshold changed to 0.75 on 2026-04-18. All 139 tests pass (128 signpath + 11 coach-proxy). Classification summary on real `sign-templates.json`: **172/400 one-handed, 228/400 two-handed, 0/400 static-dom.** Verified via `scripts/verify_threshold.js`. Known family signs (`Mẹ` 0.681, `Bố` 0.613, `Anh` 0.559, `Em` 0.528) now correctly classify as one-handed; known two-handed signs (`Cảm ơn` 0.964, `Xin lỗi` 0.991) stay two-handed.
