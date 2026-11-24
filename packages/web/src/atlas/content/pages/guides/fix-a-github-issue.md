# How to evaluate an agent for fixing a GitHub issue

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

An issue, a fixture repository, setup instructions and acceptance tests.

## Expected deliverable

A reviewable patch or pull request, test output and an explanation of remaining limitations.

## Approval boundary

Require approval for merging, release, production credentials and changes outside the fixture.

## Acceptance criteria

Tests pass; the reported issue is addressed; unrelated behavior is preserved; a reviewer can reproduce the result.

## Failure modes

Passing tests with a weakened assertion, unrelated refactors, hidden manual edits and a PR that does not address the issue.

## Procedure

1. Reproduce the issue
2. Agree on allowed files and dependencies
3. Implement the smallest relevant change
4. Run the acceptance tests
5. Return the diff and evidence.

## Candidates to investigate

- [Cognition](/projects/cognition)
- [Devin](/projects/devin)
- [Factory](/projects/factory)
- [OpenHands](/projects/openhands)
- [Cursor](/projects/cursor)

Candidate relevance is editorial, not verified task support.
