---
kind: chain
name: analyze-then-review
description: Analyze a change, then review the analysis output (sequential handoff).
tags: [chain, analysis, review]
agents:
  - subagent_type: codebase-analyzer
    model: anthropic/claude-sonnet-4-5
    tools: [read, grep]
    thinking: medium
  - subagent_type: coding_reviewer
    model: openai/gpt-5.5
    tools: [read, grep]
    thinking: high
---
Chain profile: step 1 analyzes, step 2 reviews step 1's artifact.
Each member also inherits its persona's frontmatter defaults; the fields above
override them. This shared body is appended to each member's persona system prompt.
