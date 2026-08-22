# Acceptance Scenarios

The acceptance gate for the tool surface. Automated tests prove the provider fetches
and parses correctly; they cannot tell you whether a model can actually *use* these
tools — whether it picks the right one, gets something it can act on, and is not
drowned in tokens. That is what this checklist is for, and it is executed by hand.

**How to run.** Start the server in an MCP client (see README), then ask each
question in a single session. Record the result below.

**What to record for each scenario**, because a scenario that only records "passed"
cannot be audited later:

| Field | Why |
|---|---|
| Tool(s) invoked | The routing measurement. A right answer from the wrong tool is a latent failure. |
| Returned id(s) | Proves *which* entry answered — the whole point of P-1 and P-10. |
| Transcript excerpt | Evidence the answer was actually correct, not merely present. |
| Commit SHA | Ties the result to a build. |

A scenario passes only if the answer is correct **and** the tool chosen was the
right one. Note wrong-tool-right-answer as a partial: it means a description needs
work, and it is invisible unless recorded.

---

## Pathfinder 2e — `GAME_SYSTEM=pf2e`

### P-1 — Remaster correctness (the highest-value scenario here)
> "What does Fireball do?"

**Must return the Player Core version (`spell-1530`), not Core Rulebook (`spell-119`).**
Both documents are live in the index simultaneously and read as equally plausible,
so a wrong answer here is undetectable by the reader. If `spell-119` comes back
unlabelled, that is a **hard failure** regardless of how good the text looks.

- Expected tool: `pf2e_search_spell`
- Expected id: `spell-1530`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-2 — Filtered search
> "What are the 1st-level Fighter class feats?"

- Expected tool: `pf2e_search_feat` (with a level filter)
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-3 — Small closed set
> "What does the Grabbed condition do?"

56 conditions exist — just above `MAX_LIMIT` (50), so this category is deliberately
*not* marked as a small closed set. An empty query returns a page with `nextCursor`
when more matches remain, rather than claiming to be exhaustive. Check that the
description does not promise a single-call list-all it cannot deliver.

- Expected tool: `pf2e_search_condition`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-3b — Continue a search
> "Show me two spells, then two more, and fetch the first spell's full rules."

- Expected tools: `pf2e_search_spell` with `limit: 2`, then the same tool with
  identical inputs plus the returned `nextCursor` as `cursor`, then
  `pf2e_get_spell_details` with a returned id.
- Expect disjoint page ids on unchanged data. Do not treat a short page as finished
  while `nextCursor` remains. A stale cursor requires restarting without it.
- Result: pass / fail — tools: ______ ids: ______ commit: ______

### P-4 — Level + trait filtering
> "Show me 3rd-rank fire spells."

- Expected tool: `pf2e_search_spell`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-5 — Keyword lookup
> "What does the Flourish trait mean?"

- Expected tool: `pf2e_search_trait`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-6 — Statblock retrieval
> "What are a Goblin Warrior's stats?"

Exercises search → details, since a statblock needs the full entry.

- Expected tools: `pf2e_search_creature` then `pf2e_get_creature_details`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-7 — Routing probe (deliberately ambiguous)
> "How does the Demoralize action work?"

Demoralize is an **action**, but a caller without the system's ontology may reach
for feats or rules. This is the sharpest routing test in the set — its whole
purpose is to catch a description that fails to disambiguate.

- Expected tool: `pf2e_search_action` — **record what was actually called**
- Result: ☐ pass ☐ fail ☐ wrong-tool-right-answer — tools: ______ commit: ______

### P-8 — Mundane gear
> "What's the price and bulk of a longsword?"

- Expected tool: `pf2e_search_item`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-9 — General rules, the fallback category
> "How do critical hits work?"

- Expected tool: `pf2e_search_rules`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

### P-10 — Remaster renaming
> "Compare Magic Missile and Force Barrage."

Force Barrage is the Remaster name for Magic Missile. Under the default filter the
legacy entry is excluded, so the honest answer explains the rename rather than
presenting two live spells. Catches a filter that works while the *explanation* is
wrong.

- Expected tool: `pf2e_search_spell`
- Result: ☐ pass ☐ fail — tools: ______ ids: ______ commit: ______

---

## Cross-cutting

### X-1 — Configuration failure
Start with `$env:GAME_SYSTEM='pathfinder3e'; node dist/index.js`

Must exit **non-zero**, list valid systems **on stderr**, produce **empty stdout**,
and never complete an MCP handshake. Empty stdout matters specifically: stdout is
the protocol channel, and a diagnostic written there would corrupt it.

- Result: ☐ pass ☐ fail — exit code: ______ commit: ______

### X-2 — Error path (cannot be unit-tested)
Disconnect the network mid-session, then ask any lookup question.

The model must report an **explicit failure** — "the rules service is unreachable"
— and must **not** say the rule does not exist. How a model narrates a failed tool
call is precisely what the explicit-error design is for, and no unit test can
observe it.

- Result: ☐ pass ☐ fail — commit: ______

### X-3 — Undeclared capability
> "Find me a 5e spell by Pathfinder trait."

Ask for a filter the provider does not declare. The model should decline or ask,
**not** hallucinate the capability. Tests the model-facing half of the rule that a
parameter exists only if it was declared.

- Result: ☐ pass ☐ fail — commit: ______

### X-4 — Extended tier (optional)
Start with `$env:PF2E_INCLUDE_EXTENDED='true'`, then: "Tell me about the deity Sarenrae."

Tool count must visibly grow and `pf2e_search_deity` must appear.

- Result: ☐ pass ☐ fail — commit: ______

### X-5 — Two systems at once (optional)
Run a `pf2e` instance and a `toy` instance in the same client simultaneously.

Tool names must not collide — this is what the system-prefixed naming buys, and it
is the only way to observe it with one real provider shipping.

- Result: ☐ pass ☐ fail — commit: ______

---

## Record

### 2026-08-22 — automated data-correctness pass

Run directly against the live API through the built server. This covers **half**
of each scenario: that the right tool returns the right entry. It does **not**
cover the other half — whether an assistant *chooses* the right tool unprompted —
because that needs a real client session with a model deciding for itself. The
tool was named explicitly in each call below, so P-7's routing question in
particular is still open.

| Scenario | Tool called | Top result | Verdict |
|---|---|---|---|
| P-1 | `pf2e_search_spell` | Fireball `spell-1530` (Player Core) | ✅ legacy `spell-119` excluded |
| P-2 | `pf2e_search_feat` | **Vicious Swing** | ✅ searching the legacy name "Power Attack" returns its Remaster replacement |
| P-3 | `pf2e_search_condition` | Grabbed | ✅ |
| P-4 | `pf2e_search_spell` | Pyrotechnics | ✅ `level=3` + `trait=Fire` compose |
| P-5 | `pf2e_search_trait` | Flourish | ✅ |
| P-6 | `pf2e_search_creature` | Goblin Warrior | ✅ |
| P-7 | `pf2e_search_action` | Demoralize | ✅ data correct; **routing untested** |
| P-8 | `pf2e_search_item` | Longsword | ✅ |
| P-9 | `pf2e_search_rules` | Critical Hits | ✅ |
| P-10 | `pf2e_search_spell` | Force Barrage | ✅ |

**Zero non-current entries across all ten.** The canonicity filter held throughout.

Details path checked separately: `pf2e_get_spell_details("spell-119")` returns the
entry marked `canonicity: "legacy"` with `supersededBy: "spell-1530"` — labelled,
not hidden, and not silently current.

Nonsense query (`"asdfghjkl"`) returned **0 entries**, confirming the
`minimum_should_match` guard end to end.

**One defect found and fixed by this run.** `pf2e_search_condition` with no query
returned 50 of 56 conditions while its description promised to "list every entry".
`SMALL_CATEGORY_THRESHOLD` had been set above `MAX_LIMIT`, so a category could be
marked listable that the result ceiling could not deliver. The threshold is now
tied to `MAX_LIMIT` and a test pins the relationship. No PF2e category currently
qualifies as a small closed set; the toy provider still exercises the behaviour.

### Still requiring a human, in a real client session

| Scenario | Why it cannot be automated here |
|---|---|
| P-7 routing | Needs a model choosing between `action`, `feat` and `rules` unprompted |
| X-2 error path | Needs a model *narrating* a failed tool call to a person |
| X-3 undeclared capability | Needs a model deciding whether to hallucinate a filter |

| Date | Commit | Passed | Failed | Notes |
|---|---|---|---|---|
| 2026-08-22 | (see git log) | 10 data + 3 infra | 0 | Routing and model-behaviour halves outstanding |
