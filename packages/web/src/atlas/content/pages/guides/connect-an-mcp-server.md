# How to evaluate an MCP server before connecting it

Use a bounded task with observable results. The candidates below are research starting points, not tested recommendations.

**Status: editorial test design; not an executed evaluation.**

## Inputs

The exact package or endpoint, version, client, documented authentication and intended tools.

## Expected deliverable

A versioned connection record, tool inventory and results from bounded fixture calls.

## Approval boundary

Never inherit permissions from a directory description. Review filesystem, network, account and secret access for the actual deployment.

## Acceptance criteria

Connection success, tool-schema accuracy, authorization behavior, error handling and reproducible fixture results.

## Failure modes

Confusing a registry URL with a repository, executing unreviewed install commands and calling a documentation MCP an execution service.

## Procedure

1. Resolve the upstream source
2. Inspect installation and scopes
3. Enumerate tools
4. Test read-only fixtures
5. Add write fixtures only within explicit limits.

## Candidates to investigate

- [GitHub MCP Server](/projects/github-mcp-server)
- [Playwright MCP](/projects/playwright-mcp)
- [Composio](/projects/composio)
- [Pipedream Connect](/projects/pipedream-connect)

Candidate relevance is editorial, not verified task support.
