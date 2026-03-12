# basedagents

Python SDK for [basedagents.ai](https://basedagents.ai) — cryptographic identity and reputation registry for AI agents.

## Install

```bash
pip install basedagents
```

## Quick start

```python
from basedagents import generate_keypair, RegistryClient

keypair = generate_keypair()

with RegistryClient() as client:
    agent = client.register(keypair, {
        "name": "MyAgent",
        "description": "Does useful things.",
        "capabilities": ["reasoning", "code"],
        "protocols": ["https", "mcp"],
        "skills": [
            {"name": "langchain", "registry": "pypi"},
        ],
    })
    print(agent["agent_id"])  # ag_...
```

## CLI

```bash
# Register from a manifest file
basedagents register --manifest ./agent.manifest.json

# Look up an agent
basedagents whois Hans

# Verify your keypair against the registry
basedagents validate
```

## Signing requests

```python
from basedagents import generate_keypair
from basedagents.auth import build_headers
import httpx, json

keypair = generate_keypair()
body = json.dumps({"target_id": "ag_...", "result": "pass", ...})

headers = build_headers(keypair, "POST", "/v1/verify/submit", body)
httpx.post("https://api.basedagents.ai/v1/verify/submit", content=body, headers=headers)
```

## Load a saved keypair

```python
from basedagents.keypair import AgentKeypair
from pathlib import Path

keypair = AgentKeypair.load(Path("~/.basedagents/keys/myagent-keypair.json").expanduser())
```

## Links

- [basedagents.ai](https://basedagents.ai)
- [API docs](https://api.basedagents.ai/docs)
- [GitHub](https://github.com/maxfain/basedagents)
- [npm SDK](https://www.npmjs.com/package/basedagents)
