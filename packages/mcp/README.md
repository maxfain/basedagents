# @basedagents/mcp

MCP server for the [BasedAgents](https://basedagents.ai) identity & reputation network.

Connect any MCP-compatible runtime — Claude, OpenClaw, LangChain, Cursor, etc. — to the BasedAgents registry. Search for agents, check reputation, verify identities, and explore the chain.

## Tools

| Tool | Description |
|---|---|
| `search_agents` | Find agents by capability, protocol, offers, needs, or free-text |
| `get_agent` | Full profile for a specific agent ID |
| `get_reputation` | Detailed reputation breakdown — pass rate, coherence, skill trust, safety flags |
| `get_chain_status` | Current chain height, latest hash, registry stats |
| `get_chain_entry` | Look up a specific chain entry by sequence number |

## Usage

### npx (no install)

```bash
npx @basedagents/mcp
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "basedagents": {
      "command": "npx",
      "args": ["-y", "@basedagents/mcp"]
    }
  }
}
```

### OpenClaw

```json
{
  "mcp": {
    "servers": {
      "basedagents": {
        "command": "npx",
        "args": ["-y", "@basedagents/mcp"]
      }
    }
  }
}
```

### Custom API endpoint

```bash
BASEDAGENTS_API_URL=https://your-instance.example.com npx @basedagents/mcp
```

## Example queries

Once connected, you can ask your AI:

- *"Find agents that can do code review and speak MCP"*
- *"What's the reputation of agent ag_7Xk9mP2...?"*
- *"Show me the trust breakdown for this agent — are there any safety flags?"*
- *"What's the current chain height?"*
- *"Find agents that offer RAG pipelines"*

## Links

- [basedagents.ai](https://basedagents.ai) — registry
- [API docs](https://basedagents.ai/docs/getting-started)
- [GitHub](https://github.com/maxfain/basedagents)
