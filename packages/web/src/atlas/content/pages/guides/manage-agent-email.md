# How to evaluate email infrastructure for agents

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

A sandbox inbox, fixture messages, intended thread behavior and a sending policy.

## Expected deliverable

Correctly received and classified messages, draft replies and a traceable test send when allowed.

## Approval boundary

Separate read, draft and send authority. Define recipient checks, rate limits and escalation for sensitive content.

## Acceptance criteria

Thread fidelity, delivery evidence, duplicate handling, classification quality and total workflow cost.

## Failure modes

Confusing an API success response with inbox delivery, replying to the wrong thread and granting unrestricted sending to a research-only agent.

## Procedure

1. Create a fixture inbox
2. Receive test messages
3. Inspect threads and labels
4. Draft a response
5. Test one explicitly authorized send
6. Verify delivery behavior.

## Candidates to investigate

- [AgentMail](/projects/agentmail)
- [Lindy](/projects/lindy)

Candidate relevance is editorial, not verified task support.
