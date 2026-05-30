---
kind: chain
name: scout-then-review
description: Scout the change surface, then review the scout's findings (sequential handoff).
tags: [chain, research, review]
agents:
  - subagent_type: scout
    tools: [read, grep, find, ls]
    thinking: medium
  - subagent_type: reviewer
    tools: [read, grep, find, ls]
    thinking: high
---
Chain profile: step 1 (scout) maps the affected files and risks; step 2 (reviewer) reads
scout's artifact and judges the plan. Read-only end to end. Each member inherits its persona
frontmatter (see examples/agents/scout.md, examples/agents/reviewer.md); the fields above
override per-member, and this shared body is appended to each member's persona system prompt.
