# How to evaluate an agent skill

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

The exact skill directory and revision, instructions, resources and a representative task fixture.

## Expected deliverable

A dependency inventory, execution trace and accepted artifact.

## Approval boundary

Treat scripts and instructions as untrusted input until reviewed. Grant only the access required by the test.

## Acceptance criteria

Artifact quality, reproducibility, dependency clarity, permission use and failure handling.

## Failure modes

Assuming the skill name describes everything it can execute and treating a parent repository listing as an inspected skill implementation.

## Procedure

1. Read skill.md
2. Inspect referenced resources
3. Identify tools and credentials
4. Run in a bounded environment
5. Verify the artifact against the fixture.

## Candidates to investigate

- [Anthropic Skills](/projects/anthropic-skills)
- [Vercel Agent Skills](/projects/vercel-agent-skills)
- [Hugging Face Skills](/projects/hugging-face-skills)

Candidate relevance is editorial, not verified task support.
