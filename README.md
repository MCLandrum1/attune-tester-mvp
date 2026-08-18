# Attune — tester MVP

A standalone prototype focused on one problem: **can we get honest, low-burden, objective daily data from a tired parent** — real-time moment capture instead of end-of-day reconstruction, and counts/times instead of 1–5 opinion ratings.

This is not wired into your production Attune codebase (learning loop, working theory engine, Child Playbook, etc.). It's a clean, self-contained app built to test the *logging experience* itself with real families before investing more in the full architecture.

The app is local-first: every action saves immediately in the browser. When deployed with its Supabase and Vercel configuration, a parent can sign in by email magic link and privately sync that state across devices. Row Level Security restricts each account to its own tester state.

## What it does

- **Rough Moment button** — one tap, timestamped instantly. An optional one-word tag (tired / hungry / transition / overwhelm / sensory / not sure) can be added, or skipped entirely. A soft follow-up later asks "how's it going now?" (recovered quickly / still settling / not sure) without forcing it.
- **Sick Today button** — one tap records illness as important context. Sick days remain visible in the log and export but are excluded from ordinary pattern comparisons so illness does not distort everyday learning.
- **Morning check-in** — bedtime, wake time, night wakings (a counter, not a rating), whether they fell asleep alone. Meant to be done right after waking, while it's still accurate.
- **Evening check-in** — meals eaten, snack/sugar presence, outdoor time bucket, structured activity, focused 1:1 time bucket, screen time bucket, and one optional free-text notes field for anything the structured fields missed. Every structured field is a count, a bucket, or a yes/no/not-sure — never an opinion scale. "Not sure" is a real, first-class answer everywhere.
- **Log tab** — full chronological history of everything captured, for review/trust-building.
- **Understanding tab** — a deterministic (non-AI) pattern engine that:
  - Refuses to say anything until there are at least 7 days of data.
  - Never compares two groups with fewer than 5 days of evidence each (hard floor — this number is the `MIN_N` constant in `app.js`).
  - Labels findings `weak early signal` / `emerging pattern` / `strong pattern` based on sample size and effect size — never based on how confident the wording sounds.
  - Always shows one working explanation, one small thing to try, and one observable sign of whether it worked — never a wall of charts.
- **Export** — one button downloads all logged data as JSON, so testers aren't locked in and you can pull real data out to analyze centrally.

## Hosting it from your GitHub (GitHub Pages, no build step)

1. Create a new repo (or a folder in an existing one) and add `index.html` and `app.js` from this folder.
2. Push to GitHub.
3. In the repo: **Settings → Pages → Source → Deploy from a branch → main → / (root)**.
4. GitHub gives you a URL like `https://yourname.github.io/repo-name/` within a minute or two. Share that link with testers — works on phone and desktop, no install.

That's the entire hosting step. No npm install, no build pipeline, no server.

## Known limitations (by design, for a fast test — not oversights)

- **Single-device only.** Data is per-browser, per-device. If a tester logs on their phone and later opens it on a laptop, that's a second, empty instance. Fine for a logging-experience test; not fine for the multi-parent-household disagreement tracking discussed in earlier design passes — that needs a real backend (Supabase, per your existing production stack) to merge entries by child + caregiver.
- **No recency decay or holdout verification in the stats engine.** The full design called for weighting recent days more heavily and checking that a pattern holds on held-out recent data before trusting it. This MVP skips both to keep it inspectable in one file — it only enforces the minimum-n floor and a minimum effect-size gap. Do not treat its "strong pattern" label as production-grade; treat it as a proof-of-concept of the *shape* of honest, gated reasoning.
- **No AI narration layer.** The plain-language explanations are template strings filled in from the computed stats, not an LLM. This was deliberate for a tester build (no API key management, fully offline-capable, and it makes the "never overclaim" rule trivially auditable — there's no model behavior to constrain). When you're ready to add warmer, more varied language, keep the boundary from the earlier design: the stats engine computes the numbers, and only those structured numbers get handed to an LLM for wording — the LLM never sees raw logs.
- **Single-child only**, no multi-child household support yet.
- **Data loss risk**: clearing browser data/cache deletes everything. Point testers at the Export button periodically, or treat this explicitly as a short-lived experience-test rather than a place to build up months of trusted history.

## Suggested next steps if the logging experience tests well

1. Swap `localStorage` for Supabase (you already have this in production) so data survives device changes and multiple caregivers can log against the same child.
2. Add the recency-decay + holdout-verification logic from the full stats engine spec.
3. Add the LLM narration layer on top of the existing stats output, with the overclaim-detection check described in the original build prompt.
4. Wire in multi-parent disagreement tracking once there's a backend to merge entries.
