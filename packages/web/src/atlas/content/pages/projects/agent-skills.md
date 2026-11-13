# Agent Skills

Portable skill directory format built around SKILL.md.

Type: protocol · Evidence checked: 2026-11-13

**Evidence:** Published-source research; no runtime test, security audit or payment test was performed for this profile.

[Official/source URL](https://agentskills.io/specification)

## What it does

A portable skill package groups instructions and optional resources around SKILL.md. Record the skill directory, revision and dependencies separately from the agent that loads it.

## What this does not establish

A skill file does not establish that a host can execute every referenced script or access every required service.

## Implementation checklist

- Check the exact skill path
- inspect instructions and executable resources
- identify required credentials
- test one bounded task.

## Information still to establish

- Approval policy
- Runtime compatibility
- Independent task results
- People and current roles
- Funding
- Pricing
- Stated mission or roadmap

## Related research

- [Anthropic Skills](/projects/anthropic-skills)
- [Hugging Face Skills](/projects/hugging-face-skills)
- [Anthropic docx](/projects/anthropic-docx)
- [Anthropic pdf](/projects/anthropic-pdf)
- [Anthropic pptx](/projects/anthropic-pptx)

These are topic links, not tested alternatives or compatibility claims.

## Sources

- [https://agentskills.io/specification](https://agentskills.io/specification) — observed 2026-11-13
