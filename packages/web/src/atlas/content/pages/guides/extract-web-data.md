# How to evaluate agents for web data extraction

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

An allowed set of URLs, a required output schema and examples of missing or conflicting values.

## Expected deliverable

Structured rows with source URLs, observation times and explicit missing values.

## Approval boundary

Use permitted public pages or a fixture. Do not grant form submission or purchase rights for a read-only extraction task.

## Acceptance criteria

Field accuracy, source coverage, duplicate rate, missing-value handling and cost per accepted row.

## Failure modes

Guessing missing fields, mixing prices from different plans, losing provenance and treating a browser session as a completed extraction.

## Procedure

1. Define the schema
2. Run on representative pages
3. Retain source evidence
4. Validate rows
5. Inspect failures and retries.

## Candidates to investigate

- [Browser Use](/projects/browser-use)
- [Skyvern](/projects/skyvern)
- [Apify MCP Server](/projects/apify-mcp-server)
- [Browserbase](/projects/browserbase)

Candidate relevance is editorial, not verified task support.
