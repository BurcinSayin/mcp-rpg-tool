# Pathfinder 2e provider

Pathfinder 2e uses [Archives of Nethys](https://2e.aonprd.com) for live rules lookup.
Select it with `GAME_SYSTEM=pf2e` (the default). See the [main README](../../README.md)
for installation, client launch examples, shared search/pagination behavior, and development commands.
Tools are generated from the loaded game system rather than a lowest common denominator:
PF2e exposes actions and traits as first-class categories because that is how Pathfinder
is organised.

## Configuration

The following settings belong to this provider, not to other game systems:

| Variable | Default | Effect |
|---|---|---|
| `PF2E_INCLUDE_EXTENDED` | `false` | Adds eight more categories (hazards, deities, backgrounds, heritages, archetypes, class features, rituals, sources). |
| `INCLUDE_LEGACY` | `false` | Includes pre-Remaster content. See [Remaster handling](#remaster-handling). |

Set these in the MCP client's server `env` alongside `GAME_SYSTEM` as needed;
restart the server after changing configuration because the tool list is fixed at startup.

## Tools

The default eight categories expose these search and details tools:

```
pf2e_search_spell        pf2e_get_spell_details
pf2e_search_feat         pf2e_get_feat_details
pf2e_search_creature     pf2e_get_creature_details
pf2e_search_item         pf2e_get_item_details
pf2e_search_action       pf2e_get_action_details
pf2e_search_condition    pf2e_get_condition_details
pf2e_search_trait        pf2e_get_trait_details
pf2e_search_rules        pf2e_get_rules_details
```

A Pathfinder spell runs several hundred tokens and ten of them would be most of a
context window, so search returns a ranked list of summaries carrying ids and the
assistant fetches only what it needs. See the [shared tool usage](../../README.md#tools)
for pagination and details lookup. PF2e also rejects continuation when it observes
an index rotation.

## Remaster handling

This is the part most worth understanding, because getting it wrong is invisible.

Pathfinder's Remaster revised a large amount of the game, and **both versions live
in the search index at once**. Asking for Fireball matches two documents: the 2019
Core Rulebook spell and the 2023 Player Core spell. Both read as perfectly
plausible rules text.

By default this server returns **only current content**. Superseded entries are
excluded, and any entry that *is* superseded — reachable by fetching its id
directly — comes back marked `canonicity: "legacy"` with `supersededBy` naming the
current version. There is no path that returns outdated rules unlabelled.

Set `INCLUDE_LEGACY=true` if you are deliberately running a pre-Remaster campaign.

## Operational notes

**No offline mode.** Content is fetched live on every cache miss; nothing is
bundled and nothing is written to disk. A network outage makes the server
non-functional, and it will say so explicitly rather than returning empty results.

**This server is a considerate client.** Archives of Nethys is community
infrastructure with no published rate limit, so requests are throttled and identify
themselves with a contact address. Please do not remove that.

The live suite is separate and not CI-gating. Its job is detecting that the
upstream schema changed under us — the one failure mode fixtures structurally
cannot catch. Run `npm run test:live` only when deliberately checking the live API.

## Attribution and licensing

Project software is licensed under the [MIT License](../../LICENSE), copyright
2026 mcp-rpg-tools contributors. This does **not** license retrieved rules text;
the content notices below remain separate.

Pathfinder rules content retrieved by this tool is used under:

- **ORC License** — Pathfinder Remaster rules text, which is what this server
  returns by default.
- **Paizo Community Use Policy** — Paizo and Archives of Nethys names, trademarks,
  and branding.

This tool is unofficial and not endorsed by Paizo. It does not charge for access to
game content, and it does not retrieve, cache, or display artwork.

Archives of Nethys ended its commercial licensing partnership with Paizo on
2026-07-24 and now operates under the Community Use Policy. That relationship is
recent and may change again.
