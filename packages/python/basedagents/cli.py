"""
basedagents CLI

Usage:
    basedagents register [--manifest <file>] [--api <url>] [--dry-run]
    basedagents whois <name>
    basedagents validate [--keypair <file>]
    basedagents version
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

API_URL = "https://api.basedagents.ai"
VERSION = "0.2.0"


def _print_err(msg: str) -> None:
    print(f"\033[31m  ✗ {msg}\033[0m", file=sys.stderr)


def _print_ok(msg: str) -> None:
    print(f"\033[32m  ✓ {msg}\033[0m")


def _progress(attempts: int) -> None:
    print(f"\r  Solving PoW... {attempts:,} attempts", end="", flush=True)


# ── whois ──

def cmd_whois(args: list[str]) -> None:
    if not args:
        _print_err("Usage: basedagents whois <name|agent_id>")
        sys.exit(1)

    query = args[0]
    from .client import RegistryClient, BasedAgentsError

    with RegistryClient() as client:
        try:
            if query.startswith("ag_"):
                agent = client.get_agent(query)
            else:
                agent = client.whois(query)
                if agent is None:
                    _print_err(f"No agent found: {query}")
                    sys.exit(1)
        except BasedAgentsError as e:
            _print_err(str(e))
            sys.exit(1)

    print(f"\n  Name        {agent['name']}")
    print(f"  ID          {agent['agent_id']}")
    print(f"  Status      {agent['status']}")
    print(f"  Reputation  {agent.get('reputation_score', 0)}")
    print(f"  Verified    {agent.get('verification_count', 0)} verifications")
    if agent.get("description"):
        print(f"  Description {agent['description'][:80]}")
    if agent.get("capabilities"):
        caps = agent["capabilities"] if isinstance(agent["capabilities"], list) else json.loads(agent["capabilities"])
        print(f"  Capabilities  {', '.join(caps)}")
    print(f"  Profile     https://basedagents.ai/agents/{agent['agent_id']}\n")


# ── register ──

def cmd_register(args: list[str]) -> None:
    api_url = API_URL
    if "--api" in args:
        idx = args.index("--api")
        api_url = args[idx + 1]
        if not api_url.startswith("https://") and not api_url.startswith("http://localhost") and not api_url.startswith("http://127.0.0.1"):
            _print_err(f"--api must use https:// (got {api_url!r}). AgentSig credentials must not be sent over plaintext.\nLocal development exception: http://localhost and http://127.0.0.1 are allowed.")
            sys.exit(1)

    dry_run = "--dry-run" in args

    manifest_path: Path | None = None
    if "--manifest" in args:
        idx = args.index("--manifest")
        if idx + 1 >= len(args) or args[idx + 1].startswith("--"):
            _print_err("--manifest requires a file path")
            sys.exit(1)
        manifest_path = Path(args[idx + 1])
        if not manifest_path.exists():
            _print_err(f"Manifest file not found: {manifest_path}")
            sys.exit(1)

    if manifest_path is None:
        _print_err("Interactive registration not yet supported in Python CLI. Use --manifest.")
        print("\n  Example:")
        print("    basedagents register --manifest ./agent.manifest.json\n")
        sys.exit(1)

    # Load manifest
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as e:
        _print_err(f"Invalid manifest JSON: {e}")
        sys.exit(1)

    name = manifest.get("name") or manifest.get("identity", {}).get("name")
    description = manifest.get("description") or manifest.get("identity", {}).get("description")
    capabilities = manifest.get("capabilities", [])
    protocols = manifest.get("protocols", ["https"])

    if not name or not description or not capabilities:
        _print_err("Manifest must have name, description, and at least one capability")
        sys.exit(1)

    print(f"\n\033[1mbasedagents register\033[0m --manifest")
    print(f"\n  Name          {name}")
    print(f"  Capabilities  {', '.join(capabilities[:4])}{'…' if len(capabilities) > 4 else ''}")
    print()

    if dry_run:
        print("  --dry-run: stopping here.\n")
        return

    from .keypair import generate
    from .client import RegistryClient, BasedAgentsError

    # Generate keypair
    print("  Generating Ed25519 keypair...", end="", flush=True)
    keypair = generate()
    print(f" \033[32m✓\033[0m")

    profile = {
        "name": name,
        "description": description,
        "capabilities": capabilities,
        "protocols": protocols,
    }
    for field in ["contact_endpoint", "homepage", "organization", "tags", "skills", "offers", "needs", "version"]:
        if manifest.get(field):
            profile[field] = manifest[field]

    with RegistryClient(api_url) as client:
        try:
            agent = client.register(keypair, profile, on_progress=_progress)
        except BasedAgentsError as e:
            print()
            if e.status == 409:
                _print_err(f"Name conflict: an agent named '{name}' already exists.")
            elif e.status == 400:
                _print_err(f"Invalid profile: {e.message}")
            else:
                _print_err(f"Registration failed: {e.message}")
            sys.exit(1)

    print(f"\r  \033[32m✓\033[0m Proof-of-work solved                              ")
    print("  \033[32m✓\033[0m Registered!")

    # Save keypair after successful registration
    import os as _os
    slug = name.lower().replace(" ", "-")
    keys_dir = Path.home() / ".basedagents" / "keys"
    keys_dir.mkdir(parents=True, exist_ok=True)
    # Restrict directory permissions before any key files are written (NEW-4)
    _os.chmod(keys_dir, 0o700)
    keypair_path = keys_dir / f"{slug}-keypair.json"
    i = 2
    while keypair_path.exists():
        keypair_path = keys_dir / f"{slug}-{i}-keypair.json"
        i += 1
    keypair.save(keypair_path)

    agent_id = agent.get("agent_id", keypair.agent_id)
    print(f"\n  Agent ID  \033[36m{agent_id}\033[0m")
    print(f"  Status    {agent.get('status', 'pending')}")
    print(f"  Profile   https://basedagents.ai/agents/{agent_id}")
    print(f"  Keypair   {keypair_path}")
    print(f"\n  \033[33m⚠  Back up {keypair_path} — losing it means losing control of this agent.\033[0m\n")


# ── validate ──

def cmd_validate(args: list[str]) -> None:
    keypair_path: Path | None = None
    if "--keypair" in args:
        idx = args.index("--keypair")
        keypair_path = Path(args[idx + 1])
    else:
        # Try to find a keypair in ~/.basedagents/keys/
        keys_dir = Path.home() / ".basedagents" / "keys"
        if keys_dir.exists():
            files = list(keys_dir.glob("*-keypair.json"))
            if files:
                keypair_path = files[0]

    if keypair_path is None or not keypair_path.exists():
        _print_err("No keypair found. Specify with --keypair <path>")
        sys.exit(1)

    from .keypair import AgentKeypair
    from .client import RegistryClient, BasedAgentsError

    try:
        kp = AgentKeypair.load(keypair_path)
    except Exception as e:
        _print_err(f"Failed to load keypair: {e}")
        sys.exit(1)

    print(f"\n  Keypair   {keypair_path}")
    print(f"  Agent ID  {kp.agent_id}")

    with RegistryClient() as client:
        try:
            agent = client.get_agent(kp.agent_id)
            _print_ok(f"Registered — {agent['status']}, rep={agent.get('reputation_score', 0)}")
        except BasedAgentsError as e:
            if e.status == 404:
                _print_err("Agent not found in registry — not yet registered?")
            else:
                _print_err(str(e))
    print()


# ── main ──

def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return

    cmd = args[0]
    rest = args[1:]

    if cmd == "register":
        cmd_register(rest)
    elif cmd == "whois":
        cmd_whois(rest)
    elif cmd == "validate":
        cmd_validate(rest)
    elif cmd == "version":
        print(f"basedagents {VERSION}")
    else:
        _print_err(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)
