"""
Ergonomic one-call registration for agents that don't want the ceremony.

Usage:
    from basedagents import register_or_load

    agent_id = register_or_load(
        name="my-trading-agent",
        description="Analyzes stock trends.",
        capabilities=["reasoning", "data-analysis"],
        skills=[{"name": "langchain", "registry": "pypi"}],
        contact_endpoint="https://my-agent.example.com",
    )
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

from .client import RegistryClient, BasedAgentsError
from .keypair import AgentKeypair, generate as generate_keypair

_DEFAULT_KEYS_DIR = Path.home() / ".basedagents" / "keys"


def _slug(name: str) -> str:
    """Convert agent name to a safe filename slug."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def register_or_load(
    name: str,
    description: str = "",
    capabilities: list[str] | None = None,
    protocols: list[str] | None = None,
    skills: list[dict[str, str]] | None = None,
    contact_endpoint: str | None = None,
    organization: str | None = None,
    version: str | None = None,
    tags: list[str] | None = None,
    keypair_path: Path | str | None = None,
    api_url: str | None = None,
    verbose: bool = True,
) -> str:
    """
    Idempotent agent registration. Safe to call on every startup.

    - If the keypair file already exists AND the agent is registered: returns agent_id immediately.
    - If keypair exists but agent is not registered (e.g. first run after keypair creation): registers.
    - If no keypair file: generates one, registers, saves it.

    Args:
        name: Unique agent name (globally unique on basedagents.ai)
        description: What the agent does
        capabilities: List of capability strings (e.g. ["reasoning", "code"])
        protocols: Supported protocols (e.g. ["https", "mcp"]). Defaults to ["https"]
        skills: Declared tool dependencies e.g. [{"name": "langchain", "registry": "pypi"}]
        contact_endpoint: HTTP(S) URL where this agent can be reached for verification probes
        organization: Optional org name
        version: Optional version string
        tags: Optional tags for discovery
        keypair_path: Override path for the keypair JSON file.
                      Defaults to ~/.basedagents/keys/<name-slug>-keypair.json
        api_url: Override API base URL. Defaults to BASEDAGENTS_API env var or api.basedagents.ai
        verbose: Print progress to stderr (default True)

    Returns:
        agent_id string (e.g. "ag_...")
    """
    def _log(msg: str) -> None:
        if verbose:
            print(f"[basedagents] {msg}", file=sys.stderr)

    slug = _slug(name)
    path = Path(keypair_path).expanduser() if keypair_path else _DEFAULT_KEYS_DIR / f"{slug}-keypair.json"

    from .client import DEFAULT_API_URL
    base_url = api_url or DEFAULT_API_URL

    with RegistryClient(api_url=base_url) as client:
        # Load or generate keypair
        if path.exists():
            keypair = AgentKeypair.load(path)
            _log(f"Loaded keypair from {path}")

            # Check if already registered
            if keypair.agent_id:
                try:
                    agent = client.get_agent(keypair.agent_id)
                    _log(f"Already registered: {agent['name']} ({keypair.agent_id})")
                    return keypair.agent_id
                except BasedAgentsError as e:
                    if e.status == 404:
                        _log("Keypair found but agent not in registry — registering...")
                    else:
                        raise
        else:
            _log("No keypair found — generating...")
            keypair = generate_keypair()
            _log(f"Generated keypair (public key: {keypair.public_key_b58[:16]}...)")

        # Build profile
        profile: dict[str, Any] = {
            "name": name,
            "description": description,
            "capabilities": capabilities or [],
            "protocols": protocols or ["https"],
        }
        if skills:
            profile["skills"] = skills
        if contact_endpoint:
            profile["contact_endpoint"] = contact_endpoint
        if organization:
            profile["organization"] = organization
        if version:
            profile["version"] = version
        if tags:
            profile["tags"] = tags

        # Register with progress reporting
        _log("Solving proof-of-work...")
        last_reported = [0]

        def on_progress(attempts: int) -> None:
            if attempts - last_reported[0] >= 500_000:
                _log(f"  {attempts:,} attempts...")
                last_reported[0] = attempts

        result = client.register(keypair, profile, on_progress=on_progress)
        agent_id: str = result["agent_id"]

        # Persist keypair with agent_id stamped in
        from .keypair import from_private_key_hex as _from_hex
        import dataclasses
        keypair = dataclasses.replace(keypair, agent_id=agent_id)
        keypair.save(path)
        _log(f"Registered! agent_id={agent_id}")
        _log(f"Keypair saved to {path}")

        return agent_id
