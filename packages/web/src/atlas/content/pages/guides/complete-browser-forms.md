# How to test agents that complete browser workflows

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

A sandbox form, test account, permitted values and a clear final state.

## Expected deliverable

Completed fixture records plus screenshots or event logs showing the resulting state.

## Approval boundary

Require a separate approval before sending external messages, submitting production records or committing purchases.

## Acceptance criteria

Correct final state, duplicate avoidance, recovery from validation errors and intervention count.

## Failure modes

Trusting the agent narrative, accepting a clicked button as success and retrying a submission that may already have succeeded.

## Procedure

1. Map the workflow
2. Mark irreversible steps
3. Run the agent
4. Verify the backend or confirmation state
5. Repeat with a validation error.

## Candidates to investigate

- [Skyvern](/projects/skyvern)
- [Browser Use](/projects/browser-use)
- [Simular](/projects/simular)

Candidate relevance is editorial, not verified task support.
