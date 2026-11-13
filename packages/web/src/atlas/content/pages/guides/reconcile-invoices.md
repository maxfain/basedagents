# How to evaluate agents for invoice reconciliation

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

Synthetic invoices, purchase orders, payment records and a reconciliation policy.

## Expected deliverable

Matched records, explicit exceptions and an evidence trail for each proposed adjustment.

## Approval boundary

Keep ledger posting and money movement outside the initial fixture test.

## Acceptance criteria

Match accuracy, exception recall, duplicate detection and traceability to source documents.

## Failure modes

Silently changing amounts, matching similar vendor names without identifiers and treating a recommendation as an approved accounting entry.

## Procedure

1. Normalize fixture records
2. Match identifiers and amounts
3. Detect duplicates
4. Flag exceptions
5. Return proposed adjustments for review.

## Candidates to investigate

- [Basis](/projects/basis)
- [Sema4.ai](/projects/sema4-ai)
- [Billow AI Labs](/projects/billow-ai-labs)

Candidate relevance is editorial, not verified task support.
