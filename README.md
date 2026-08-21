# Attune — tester MVP

A standalone prototype focused on one problem: **can we get honest, low-burden, objective daily data from a tired parent** — real-time moment capture instead of end-of-day reconstruction, and counts/times instead of 1–5 opinion ratings.

This is not wired into your production Attune codebase (learning loop, working theory engine, Child Playbook, etc.). It's a clean, self-contained app built to test the *logging experience* itself with real families before investing more in the full architecture.

The app is local-first: every action saves immediately in the browser. When deployed with its Supabase and Vercel configuration, a parent can sign in by email magic link and privately sync that state across devices. Row Level Security restricts each account to its own tester state.

## What it does

- **Rough Moment button** — one tap, timestamped instantly. An optional context tag can be added or skipped. A soft follow-up later asks "how's it going now?" without forcing it.
- **Calm moment review** — after the evening check-in, or from “Look back,” Attune asks about at most two recent moments: what was tried and whether it helped. This stays separate from the day-level pattern engine so a single lucky result never becomes a recommendation.
- **Sick Today button** — one tap records illness as important context. Sick days remain visible in the log and export but are excluded from ordinary pattern comparisons so illness does not distort everyday learning.
- **Morning check-in** — bedtime, wake time, night wakings (a counter, not a rating), whether they fell asleep alone. Meant to be done right after waking, while it's still accurate.
- **Evening check-in** — meals eaten, snack/sugar presence, outdoor time bucket, structured activity, focused 1:1 time bucket, screen time bucket, and one optional free-text notes field for anything the structured fields missed. Every structured field is a count, a bucket, or a yes/no/not-sure — never an opinion scale. "Not sure" is a real, first-class answer everywhere.
- **Log tab** — full chronological history of everything captured, for review/trust-building.
- **Understanding tab** — a deterministic (non-AI) pattern engine that:
  - Refuses to say anything until there are at least 7 days of data.
  - Never compares two groups with fewer than 5 days of evidence each (hard floor — this number is the `MIN_N` constant in `app.js`).
  - Labels findings `weak early signal` / `emerging pattern` / `strong pattern` based on sample size and effect size — never based on how confident the wording sounds.
  - Uses the most recent third of the data as a lightweight holdout after 10+ days, downgrading findings that do not continue in the recent slice.
  - Separately summarizes support effectiveness, recovery patterns by context, and logging consistency.
  - Always shows one working explanation, one small thing to try, and one observable sign of whether it worked — never a wall of charts.
- **Parent simulation** — a built-in synthetic family story that can be advanced through 7, 14, 21, and 32 days. It demonstrates evidence thresholds, support effectiveness, recovery context, and a pattern being downgraded when the recent holdout reverses. Real device data is backed up and cloud writes pause until the simulation is exited.
- **Export** — one button downloads all logged data as JSON, so testers aren't locked in and you can pull real data out to analyze centrally.

## Hosting

The tester is deployed on Vercel. `/api/config` exposes only the Supabase URL and publishable client key; authentication and Row Level Security protect each user's cloud state.

## Testing the learning loop

Open **Understanding → Start simulation**. At 7 days Attune should remain cautious. At 14 and 21 days evidence begins to shape the output. At 32 days the deliberately reversed recent sleep data should prevent the older relationship from being treated as freshly confirmed. Support-effectiveness and recovery-context cards develop independently. Exiting restores the parent's original device data.

## Known limitations (by design, for a fast test — not oversights)

- **Lightweight holdout, not full recency decay.** The engine checks the latest third of observations after 10+ days, but it does not yet use a decay curve or formal statistical significance testing.
- **No AI narration layer.** The plain-language explanations are template strings filled in from the computed stats, not an LLM. This was deliberate for a tester build (no API key management, fully offline-capable, and it makes the "never overclaim" rule trivially auditable — there's no model behavior to constrain). When you're ready to add warmer, more varied language, keep the boundary from the earlier design: the stats engine computes the numbers, and only those structured numbers get handed to an LLM for wording — the LLM never sees raw logs.
- **Single-child only**, no multi-child household support yet.
- **Signed-out data is device-local.** Clearing browser data can remove entries that have not synced. Signed-in data is stored in Supabase.

## Suggested next steps if the logging experience tests well

1. Add full recency weighting and stronger validation beyond the lightweight holdout.
2. Add the LLM narration layer on top of structured engine output, with overclaim checks.
3. Add a curated tool library, but surface tools only when the relevant support or pattern has enough evidence.
4. Model children and caregiver memberships for multi-parent households.
