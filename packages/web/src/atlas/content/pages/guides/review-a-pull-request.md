# How to evaluate AI pull-request review

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

A fixture pull request with known defects, acceptable changes and repository conventions.

## Expected deliverable

A set of findings with file references, severity, rationale and proposed remedies.

## Approval boundary

Keep review comments separate from automatic code changes and merges.

## Acceptance criteria

Measure defect recall, actionable precision, false positives, latency and reviewer time.

## Failure modes

Counting every comment as useful, treating style opinions as defects and measuring only the number of findings.

## Procedure

1. Seed known bugs
2. Include benign changes
3. Run the review without revealing the answer key
4. Adjudicate each finding
5. Repeat on a second change.

## Candidates to investigate

- [CodeRabbit](/projects/coderabbit)
- [Qodo](/projects/qodo)
- [Devin](/projects/devin)

Candidate relevance is editorial, not verified task support.
