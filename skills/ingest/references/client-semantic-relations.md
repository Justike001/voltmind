### Client semantic relationship write

Use this reference for every client-authored semantic page produced by ingest.
Selecting the correct page type is necessary but not sufficient: confirmed
relationships must be authored on the client, not guessed later from prose by
Host extraction.

Before the local `voltmind put`:

1. Read the active schema pack and the existing target pages. Classify each
   relationship as confirmed or ambiguous from cited evidence.
2. For every confirmed relationship that has a matching
   `frontmatter_links` rule for the page type, write the canonical target slug
   into that frontmatter field. Use a scalar or array exactly as required by
   the canonical page template. Do not write a display name and rely on Host
   fuzzy resolution.
3. Keep `source_refs` populated on semantic pages derived from raw ingest
   evidence so the evidence relationship is durable in local Markdown.
4. If the active pack declares the required link type but provides no matching
   frontmatter field, keep a cited wikilink to the target in the appropriate
   local body section, then create the edge explicitly with:

   ```bash
   voltmind link <from-slug> <to-slug> --type <declared-link-type>
   ```

   Run the explicit link only after both endpoint pages have completed their
   normal local-first `voltmind put` synchronization. The command is an
   explicit materialization of the client-confirmed relation, not permission
   for Host to infer a verb.
5. If the relationship or target identity is ambiguous, preserve the evidence
   and append it to `state/indexes/ingest-clarification-review`. Do not invent a
   relationship merely to make a field non-empty.

A generic body mention, co-occurrence, auto-link result, or DB-only inferred
edge does not satisfy this contract. An ingest semantic write is complete only
when each confirmed relationship is represented by typed frontmatter or by the
cited local wikilink plus explicit typed-link command, and every unresolved
notable relationship has a durable review candidate.
