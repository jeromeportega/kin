# Multi-user customization — Phase 3+ design sketch

Status: **design sketch**. Nothing in this document is implemented. Captured so we can pick it up cleanly when we get to Phase 4-5 (after Phase 3 SQLite persistence).

## The question

Phase 2 calibrated kin to one user's preferences by editing the base prompt directly. That doesn't scale: another household member may legitimately want "all daycare emails are actionable" *off* (they don't care), or want `RocketMoney → finance` *off* (they treat it as marketing), or want different priority thresholds entirely. We need a way to personalize without polluting other users' preferences and without running heavyweight per-user training loops.

## Recommendation: a settings overlay on a shared prompt

**Don't** run a separate model per user. **Don't** rely on a long open-ended feedback loop. **Do** layer per-user preferences on top of a shared base prompt and base config, and measure each user's accuracy against their own eval set.

### What's shared vs. per-user

| Shared (base prompt, applies to anyone) | Per-user (overlay layer) |
| --- | --- |
| JSON schema and contract | "Daycare = always actionable" |
| Category definitions | "Medical portal new-message = high priority" |
| Generic rules ("deadlines <7 days = high") | "Forwards keep `personal` category" |
| Date-resolution semantics | Sender-to-category overrides (`@rocketmoney.com → finance`) |
| Prompt-injection guard | Pre-filter (already in `kin.toml`) |
| "`other` is last resort" framing | Custom action_required overrides |

Every rule from the current `app/prompts/classify.txt` falls into one of these two columns. The split is the design.

### What user-facing settings look like

`kin.toml` gains a `[preferences]` block alongside the existing `[filters]`:

```toml
[preferences]
# Categories whose emails are always action_required: true,
# regardless of priority.
always_actionable_categories = ["daycare"]

# Categories where "new message" / portal alerts default to high priority.
portal_high_priority_categories = ["medical"]

# When true, Fwd: emails keep the wrapper category (`personal`)
# instead of the inner email's topic.
forwards_keep_wrapper_category = true

[preferences.sender_category_overrides]
# Specific senders that should be forced to a category, regardless
# of content. Supports the same `@domain` / `@*.domain` semantics
# as `sender_allowlist`.
"@rocketmoney.com" = "finance"
```

A new `app/prompt_builder.py` reads `[preferences]` and appends a `USER PREFERENCES` block to the base prompt at runtime. Same model (qwen3:14b), same schema, just a few extra lines of context tailored to this user.

### Onboarding flow for a non-Jerome user

The flow we executed manually in Phase 2, now driven by a wizard CLI (`kin init` or similar):

1. **App password setup.** Walk the user through enabling 2FA + generating an app password. Fill `.env`.
2. **Audit phase.** Run `app.audit` against INBOX + Trash. Present the top senders as a swipe-style list: "looks important / looks like noise / skip." Each tap writes to `sender_allowlist` or `sender_blocklist`.
3. **Calibration phase.** System picks ~15-20 category-diverse emails (the same algorithm we used in `/tmp/build_eval_candidates.py`), presents each one with a *proposed* classification (from the shared base prompt), user accepts or corrects each field. Each correction generates a `<id>.expected.json`. This is the user's golden dataset.
4. **Preference inference.** Light heuristic: if the user flipped `action_required` on every daycare email, propose adding `daycare` to `always_actionable_categories` and ask "make this a rule?". This grows the overlay without the user editing TOML.
5. **Test triage run.** Run `app.triage` with the assembled config and show results. User iterates as needed.

The user is in the loop, but it's a bounded ~30-minute one-time flow, not perpetual. A handful of corrections later (real-mail eval + tweaks) and they're done.

### Per-user evals

Each user owns their own `eval/real/` set. The runner is already per-set; we just extend it to be per-user too. This is what lets us know whether a preference change actually improved *that user's* accuracy and not the median user's. It's also the durable artifact: if the base model changes, the base prompt changes, or the user switches mail providers, the per-user golden set is the regression check.

## Architecture impact

Most seams are already there from Phase 2:

- `load_config(path)` is path-parameterized.
- `IMAPSource(...)` takes credentials and folders in its constructor.
- `EmailSource` Protocol allows per-user backends.
- Pre-filter already has allowlist/blocklist with subdomain semantics.

The shape we'd grow into:

```
kin/
├── config/
│   └── base_prompt.txt              # shared
├── users/
│   ├── jerome/
│   │   ├── kin.toml                 # filters + preferences
│   │   ├── .env                     # IMAP creds
│   │   └── eval/
│   │       ├── real/*.txt
│   │       └── real/*.expected.json
│   └── partner/
│       ├── kin.toml
│       ├── .env
│       └── eval/
│           └── real/...
└── app/
    ├── prompt_builder.py            # base + user-overlay assembler
    ├── triage.py                    # gains --user flag
    ├── audit.py                     # gains --user flag
    ├── eval.py                      # gains --user flag
    └── init.py                      # the onboarding wizard
```

What's actually new in code: `prompt_builder.py`, `init.py`, and a `--user` flag on the existing commands. The migration from "single user in root" to "users/jerome" is a directory move plus an argparse default.

## Why not separate models per user

A fine-tune per user is the technically maximal answer and the wrong one for personal AI:

- **Cost.** Each fine-tune is hours of compute. On a Mac mini you'd starve everything else.
- **Cold-start.** New users need a usable system on day one, before any data exists to train on.
- **Inspectability.** "Why did kin classify this as `other`?" is answerable when the rules are in a TOML file. It is *not* answerable for a fine-tune.
- **Iteration speed.** Prompts change in a text editor. Fine-tunes change in a multi-hour pipeline.
- **Maintenance.** N users → N model artifacts to keep in sync with base model upgrades.

Prompt overlays get ~80% of the personalization value at ~1% of the cost, with full inspectability. Revisit fine-tuning only if/when overlays demonstrably hit a ceiling — and even then, LoRA / adapter approaches are likely the right shape.

## Why not a long open-ended feedback loop

The pattern "user thumbs-up/thumbs-down each classification, system learns over time" is appealing but:

- You can't inspect what the system "learned."
- You can't disable a single rule once it goes wrong.
- You can't share preferences across devices.
- You can't reason about why behavior shifted between two runs.

The settings overlay is the same idea — accumulated user preferences inform the system — except the accumulation is *explicit, named, and editable*. The feedback loop becomes "user makes corrections during onboarding (and occasionally after) → system proposes a rule → user accepts → rule lives in TOML." This is the same shape as the implicit version, but legible.

If, somewhere down the road, we want a feedback channel for ongoing corrections, it should generate *proposed rules*, not silently update model weights.

## Tradeoffs we accept

- **The overlay can drift from the base prompt.** Mitigation: keep base prompt rules minimal and overlay rules limited. Re-run per-user evals when the base prompt changes (`PROMPT_VERSION` already gives us the signal).
- **Cold-start users get the base prompt only.** That's fine — they iterate during onboarding.
- **Two users sharing one inbox is undefined.** Out of scope for now; revisit if a real use case emerges.

## When to do this

After Phase 3 (SQLite persistence). Reasons:

1. Multi-user gets harder without per-user state. Phase 3's DB schema should already key by `user_id` even when there's only one user.
2. Phase 4 (digest) reads from the DB. If the DB is per-user, the digest is per-user "for free."
3. The onboarding wizard wants to *write* state (user-level config + eval cases). Easier when there's already a persistence layer.

## Related memories

- `feedback-no-ai-attribution` — applies to docs and PRs for this work too.
- `feedback-python-uv` — same env conventions when we add `prompt_builder.py` etc.
- `project-kin` — locked principles and current preferences live there; some will migrate into `users/jerome/kin.toml` when the overlay arrives.
