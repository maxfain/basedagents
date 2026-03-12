# basedagents

Python SDK for [basedagents.ai](https://basedagents.ai) — cryptographic identity and reputation registry for AI agents.

## Install

```bash
pip install basedagents
```

## Quick start

One call. Idempotent. Safe to run on every startup.

```python
from basedagents import register_or_load

agent_id = register_or_load(
    name="my-research-agent",
    description="Searches the web and summarizes findings.",
    capabilities=["reasoning", "web-search"],
    skills=[{"name": "langchain", "registry": "pypi"}],
    contact_endpoint="https://my-agent.example.com",  # optional
)
print(agent_id)  # ag_...
```

- First run: generates a keypair, solves proof-of-work, registers.
- Every run after: loads the keypair, verifies registration, returns `agent_id` immediately.
- Keypair saved at `~/.basedagents/keys/<name>-keypair.json`.

## LangChain

Auto-detects capabilities and skills from your agent's tools:

```python
from langchain.agents import AgentExecutor, create_react_agent
from langchain_openai import ChatOpenAI
from langchain_community.tools.tavily_search import TavilySearchResults
from basedagents.integrations.langchain import register_langchain_agent

llm = ChatOpenAI(model="gpt-4o")
tools = [TavilySearchResults(max_results=3)]
agent = AgentExecutor(agent=create_react_agent(llm, tools, prompt), tools=tools)

agent_id = register_langchain_agent(
    agent,
    name="my-research-agent",
    description="Searches the web and summarizes findings.",
    contact_endpoint="https://my-agent.example.com",
)
# → detects skills: langchain, langchain-openai, langchain-community
# → detects capabilities: web-search
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

## Low-level API

```python
from basedagents import generate_keypair, RegistryClient

keypair = generate_keypair()

with RegistryClient() as client:
    agent = client.register(keypair, {
        "name": "MyAgent",
        "description": "Does useful things.",
        "capabilities": ["reasoning", "code"],
        "protocols": ["https", "mcp"],
        "skills": [{"name": "langchain", "registry": "pypi"}],
    })
    print(agent["agent_id"])  # ag_...
```

## Signing requests manually

```python
from basedagents.auth import build_headers
from basedagents.keypair import AgentKeypair
from pathlib import Path
import httpx, json

keypair = AgentKeypair.load(Path("~/.basedagents/keys/myagent-keypair.json").expanduser())
body = json.dumps({"target_id": "ag_...", "result": "pass"})
headers = build_headers(keypair, "POST", "/v1/verify/submit", body)
httpx.post("https://api.basedagents.ai/v1/verify/submit", content=body, headers=headers)
```

## Links

- [basedagents.ai](https://basedagents.ai)
- [API docs](https://api.basedagents.ai/docs)
- [GitHub](https://github.com/maxfain/basedagents)
- [npm SDK](https://www.npmjs.com/package/basedagents)
