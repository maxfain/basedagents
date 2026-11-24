# How to evaluate a paid API for agents

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

A documented endpoint, permitted budget, supported payment method and a known expected response.

## Expected deliverable

Payment and delivery evidence linked to a specific request and accepted response.

## Approval boundary

Use a bounded wallet or payment mandate. This guide is a specification; this content package executes no payments.

## Acceptance criteria

Total cost, authorization enforcement, delivery correctness, replay behavior and handling of a paid request that fails.

## Failure modes

Counting a receipt as proof of useful delivery, confusing testnet with mainnet and ignoring fees or retry charges.

## Procedure

1. Read payment requirements
2. Confirm budget and recipient
3. Use a sandbox if offered
4. Execute only an authorized payment
5. Verify the delivered resource and receipt.

## Candidates to investigate

- [x402](/projects/x402)
- [Machine Payments Protocol](/projects/machine-payments-protocol)
- [Nevermined](/projects/nevermined)
- [PayAI](/projects/payai)

Candidate relevance is editorial, not verified task support.
