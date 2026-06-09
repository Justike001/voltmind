---
name: query
version: 2.0.0
description: |
  Answer questions using VoltMind MVP retrieval: keyword search, hybrid query,
  page reads, backlinks, tags, timeline, and graph traversal.
triggers:
  - "what do we know about"
  - "tell me about"
  - "who is"
  - "what happened"
  - "search for"
  - "look up"
  - "background on"
  - "notes on"
  - "who knows who"
  - "relationship between"
  - "connections"
  - "backlinks"
  - "timeline"
  - "tags"
tools:
  - search
  - query
  - get_page
  - list_pages
  - get_backlinks
  - traverse_graph
  - get_timeline
mutating: false
---

# Query Skill — VoltMind MVP

Answer from VoltMind's local knowledge base. The MVP retrieval path is keyword
search, hybrid query, full page reads, and basic graph context.

## Contract

This skill guarantees:

- Every answer is grounded in VoltMind content or explicitly marked as a gap.
- Claims cite page slugs/source ids when available.
- Conflicts are reported instead of silently resolved.
- Relationship questions use MVP graph commands, not frozen inherited
  `graph-query` or expert/salience flows.

## Search Plan

1. Decompose the question into keyword, semantic, page, and graph needs.
2. Run `voltmind search "<keywords>"` for direct matches.
3. Run `voltmind query "<natural question>"` when semantics matter.
4. Read top pages with `voltmind get <slug>` only when snippets are not enough.
5. For relationships, use `voltmind backlinks`, `voltmind timeline`,
   `voltmind tags`, or `voltmind graph`. Use MCP `get_links` through
   `voltmind call` only when outgoing edges are specifically required.

If query reveals that a freshly curated page is missing obvious edges, switch to
`skills/brain-ops/SKILL.md` and add MVP-safe explicit links with
`voltmind link`; do not use frozen batch extraction.

## Relationship Examples

```bash
voltmind backlinks people/alice
voltmind timeline projects/voltmind
voltmind graph people/alice --depth 2
```

Do not use inherited commands such as `gbrain graph-query`, `find_experts`,
trajectory/founder scorecards, anomaly detection, or search-mode evaluation.

## Source Precedence

1. User's direct statements.
2. Compiled page truth.
3. Timeline entries.
4. Imported or captured source excerpts.
5. External sources, only when the user asks for current research.

## Output Format

Answer directly, cite pages inline, and include gap statements such as:

> VoltMind does not currently have a page or indexed note for X.

## Anti-Patterns

- Hallucinating facts not present in VoltMind.
- Loading many full pages before using snippets.
- Treating frozen advanced analysis as available.
- Citing old GBrain command names in user-facing instructions.
