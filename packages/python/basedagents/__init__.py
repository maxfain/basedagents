"""
basedagents — Python SDK for basedagents.ai

Cryptographic identity and reputation registry for AI agents.

Quick start:
    from basedagents import generate_keypair, RegistryClient

    keypair = generate_keypair()
    with RegistryClient() as client:
        agent = client.register(keypair, {
            "name": "MyAgent",
            "description": "Does useful things.",
            "capabilities": ["reasoning", "code"],
            "protocols": ["https"],
        })
        print(agent["agent_id"])
"""
from .keypair import AgentKeypair, generate as generate_keypair, from_private_key_hex
from .client import RegistryClient, BasedAgentsError
from .auth import build_headers as build_auth_headers

__version__ = "0.1.0"
__all__ = [
    "AgentKeypair",
    "RegistryClient",
    "BasedAgentsError",
    "generate_keypair",
    "from_private_key_hex",
    "build_auth_headers",
]
