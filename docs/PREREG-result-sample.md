# Pre-registration: result-sample effect on the result-keep question

Status: **DRAFT — not run.** This registers a check to be run *later*, through
paid-run-preflight, against the TypeSafe Jev API. Nothing in this file
authorizes that run. It exists so the questions, metric and pass bar are
locked before anyone sees results, per the project's practice of pre-declaring
what would count as a win before spending on a paid model call.

## Background

Before this patch, the `result_*` question asked Jev to judge whether a tool
result's full output should stay in the history using only a tool name, an
input, and a byte count — no content. The dry-run history in this repo (see
`project_mcs_jev_dry_run` in the operator's memory) found this question
answered with a median keep-probability around **0.15**, i.e. Jev almost
always voted to drop, largely because it had nothing to judge from and the
old prompt actively told it dropping was reversible ("the assistant can
always re-run a tool or re-read a file").

This patch changes two things at once, and this pre-registration covers their
combined effect:

1. **Sample** — for `Read` calls only (Drew, 2026-09-26), the question now
   carries a bounded head+tail sample of the actual result content (`peekHeadChars` / `peekTailChars`), instead of a
   bare byte count.
2. **Neutral wording** — the state's framing sentence and the result-keep
   proposition no longer tell Jev that dropping is free ("re-running would
   not do"). They now say re-running costs time and tokens and may return
   different output, and that a result the assistant already used to reach a
   conclusion is evidence for that conclusion.

## Hypothesis

With the sample and the neutral wording, the result-keep question's answered
probabilities (`keepResult`) will be measurably higher than the old
drop-biased baseline:

- The **median** `keepResult` across replayed questions rises above the old
  baseline median of **0.15**.
- **At least some** replayed questions cross the **0.5** keep threshold
  (`keepThreshold` default), i.e. the new wording+sample is not just "less
  low" but actually flips some results from drop to keep.

This is a directional hypothesis about the probabilities Jev returns, not yet
a claim about downstream compaction quality — that is the metric below.

## Metric (exact)

**Replay recorded compactions.** Using transcripts already captured from real
fast-jev-compaction runs (not a fresh live run), re-derive the `result_*`
questions under each condition (baseline wording/no-sample vs. this patch's
wording+sample) and re-ask Jev, then measure:

> **needed outputs kept per 1,000 tokens kept**

Where:

- **"kept"** = the result's `keepResult` answer reached `keepThreshold` (kept
  verbatim), counted per condition.
- **"needed"** = a result is counted as needed only if, later in the *same*
  recorded session (after the point compaction would have run), one of the
  following actually happened:
  - the assistant re-read the same file path, or
  - the assistant re-ran the same command (same tool + same normalized
    input), or
  - the assistant's subsequent text quoted a substring of that result's
    output (e.g. an error string, a file excerpt, an identifier salvage
    would also have found).
- **"tokens kept"** = the estimated token cost (via this repo's
  `estimateTokens`) of every result actually kept verbatim under that
  condition, summed across the replay set.
- The ratio is reported per condition as (needed outputs kept) / (tokens kept
  / 1000), so a wording change that keeps more needed results *without*
  proportionally inflating the token bill scores better.

This metric answers the question the sample is meant to fix: not "does Jev
say yes more" but "does Jev say yes to the results that turned out to matter,
without also saying yes to everything."

## Baseline

**Upstream LonosCurse/fast-jev-compaction v0.3.0 behaviour** (the fork's
current `plugin.json`/`marketplace.json` version as of this patch's base
commit, `fork/main` at `9441f27`) on the *same* replay set: old
`STATE_CONTEXT` wording, old `result_*` proposition wording (with the
"re-running the tool would not do" conjunct), and no `peekHeadChars` /
`peekTailChars` sample (equivalent to this patch with both set to `0`, which
removes the sample but does **not** revert the wording — see the caveat
below and the PR description).

## Pass bar (PROPOSED — Drew to lock before any run)

> **PROPOSED:** ≥ 20% more needed outputs kept, at ≤ 10% more tokens kept,
> versus the v0.3.0 baseline on the same replay set.

This bar is not locked. It is a starting proposal for Drew to accept, adjust,
or replace before the check is run. Whatever bar is locked must be recorded
here (or in a re-registration, see below) before the paid run that evaluates
it.

## Budget note

Running this check calls the Jev API and therefore **must pass
paid-run-preflight first**, including the TypeSafe Jev under-US-$1 packet
exemption eligibility check if that exemption is claimed. This file does not
authorize spend. No run may start against this pre-registration without a
separate, current preflight pass immediately before that run.

## Re-registration requirement

Any change to the question wording, the `keepThreshold`, the `peekHeadChars`
/ `peekTailChars` sample sizes, the metric definition, the baseline, or the
pass bar, made **after this file is committed**, requires re-registering
(editing this file and noting the change and reason) **before** the next run
that would be evaluated against it. A run against a stale registration is not
evidence for or against the hypothesis as stated here.

## Known caveat for whoever writes the PR description

Setting `peekHeadChars` and `peekTailChars` to `0` disables the sample
mechanism exactly (`peeksFor` returns no peeks, so `questionsFor` never
appends a sample block) — that part of "restores old behaviour" is true.
It does **not** revert the neutral wording in `STATE_CONTEXT` or the
`result_*` proposition, both of which apply unconditionally regardless of
peek size, because reverting them would undo the actual fix. It also does not
revert the `a99570a` salvage commit's own unconditional wording change (the
dropped-result note now says "dropped" rather than upstream's original
"truncated", and `truncateHeadChars` defaults to 150 rather than 300) — that
was already true before this patch and is unrelated to peek size. The PR text
should say "setting the peek sizes to 0 disables the sample" rather than
"restores old behaviour," or spell out these two carve-outs.
