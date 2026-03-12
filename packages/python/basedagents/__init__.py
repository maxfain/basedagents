"""
basedagents — Python SDK for basedagents.ai

Cryptographic identity and reputation registry for AI agents.

Quick start (idiomatic):
    from basedagents import register_or_load

    agent_id = register_or_load(
        name="MyAgent",
        description="Does useful things.",
        capabilities=["reasoning", "code"],
    )

LangChain:
    from basedagents.integrations.langchain import register_langchain_agent

    agent_id = register_langchain_agent(
        executor,           # AgentExecutor or list of BaseTool
        name="MyAgent",
        description="Researches topics and writes reports.",
    )

Low-level:
    from basedagents import generate_keypair, RegistryClient

    keypair = generate_keypair()
    with RegistryClient() as client:
        agent = client.register(keypair, {"name": "MyAgent", ...})
        print(agent["agent_id"])
"""
from .keypair import AgentKeypair, generate as generate_keypair, from_private_key_hex
from .client import RegistryClient, BasedAgentsError
from .auth import build_headers as build_auth_headers
from .easy import register_or_load
from .middleware import require_agent, verify_request, fetch_attestation, VerifiedAgent

__version__ = "0.3.0"
__all__ = [
    "register_or_load",
    "require_agent",
    "verify_request",
    "fetch_attestation",
    "VerifiedAgent",
    "AgentKeypair",
    "RegistryClient",
    "BasedAgentsError",
    "generate_keypair",
    "from_private_key_hex",
    "build_auth_headers",
]
