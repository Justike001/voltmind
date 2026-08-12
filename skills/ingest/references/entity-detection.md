## Entity Detection on Every Message

Production agents should detect entity mentions on EVERY inbound message. This is
the signal detection loop that makes the brain compound over time.

### Protocol

1. **Scan the message** for entity mentions: people, companies, concepts, original
   thinking. Fire on every message (no exceptions unless purely operational).
2. **For each entity detected:**
   - `voltmind search "name"` -- does a page already exist?
   - **If yes:** load context with `voltmind get <slug>`. Use the compiled truth to
     inform your response. Update the page if the message contains new information.
   - **If no:** assess notability (see `skills/_brain-filing-rules.md`). If the entity
     is worth tracking, create a new page with `voltmind put <type/slug>` and populate
     with what you know.
3. **After creating or updating pages:** sync to voltmind:
   ```bash
   voltmind sync --no-pull --no-embed
   ```
4. **Don't block the conversation.** Entity detection and enrichment should happen
   alongside the response, not before it. The user shouldn't wait for brain writes
   to get an answer.

### What counts as notable

- People the user interacts with or discusses (not random mentions)
- Companies relevant to the user's work or interests
- Concepts or frameworks the user references or creates
- The user's own original thinking (ideas, theses, observations) -- highest value
- See `skills/_brain-filing-rules.md` for the full notability gate

### What to capture from the user's own thinking

Original thinking is the most valuable signal. Capture exact phrasing -- the user's
language IS the insight. Don't paraphrase.

- Novel observations or theses
- Frameworks, mental models, heuristics
- Connections between ideas that others miss
- Contrarian positions with reasoning
- Strong reactions to external stimuli (what triggered it and why)

