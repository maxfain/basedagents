"""
basedagents attestation POC — agent-to-agent gated access

Demonstrates:
- Agent A (Albert) sends a signed request to Agent B's (Hans's) API endpoint
- The endpoint verifies Albert's identity and reputation using basedagents attestations
- A rogue agent (no registered identity) gets 401
- A low-rep agent gets 403

Run:
    python examples/attestation_demo.py

Requirements:
    pip install basedagents fastapi uvicorn httpx
"""
import asyncio
import json
import threading
import time
import hashlib
import base64

import httpx
import uvicorn
from fastapi import Depends, FastAPI, Request

from basedagents import RegistryClient
from basedagents.keypair import AgentKeypair, _base58_encode
from basedagents.middleware import VerifiedAgent, require_agent
from basedagents.auth import build_headers

# ── Config ───────────────────────────────────────────────────────────────────
ALBERT_KEYPAIR_PATH = "~/.albert_agent_key.json"
SERVER_PORT = 18765
SERVER_URL = f"http://localhost:{SERVER_PORT}"

# ── The "Agent B" server (Hans's endpoint) ──────────────────────────────────
app = FastAPI(title="Hans's Gated API")


@app.post("/v1/execute")
async def execute_code(
    request: Request,
    agent: VerifiedAgent = Depends(require_agent(
        min_reputation=0.1,          # Any verified agent with some reputation
        capabilities=["code"],        # Must have code capability confirmed
        base_url="https://api.basedagents.ai",
    ))
):
    """Endpoint that only verified agents with 'code' capability can call."""
    body = await request.body()
    task = json.loads(body).get("task", "")
    return {
        "accepted": True,
        "from_agent": agent.name,
        "agent_id": agent.agent_id,
        "reputation": agent.reputation,
        "task": task,
        "result": f"[simulated] Executed task for {agent.name} (rep={agent.reputation:.3f})",
    }


@app.get("/health")
async def health():
    return {"ok": True}


# ── Demo client ──────────────────────────────────────────────────────────────

def make_signed_request(keypair: AgentKeypair, method: str, path: str, body: dict) -> dict:
    """Make a signed agent request and return the response."""
    body_str = json.dumps(body)
    auth_headers = build_headers(keypair, method, path, body_str)
    auth_headers["X-Agent-ID"] = keypair.agent_id
    auth_headers["Content-Type"] = "application/json"

    with httpx.Client() as client:
        res = client.request(
            method,
            f"{SERVER_URL}{path}",
            content=body_str.encode(),
            headers=auth_headers,
        )
    return {"status": res.status_code, "body": res.json()}


def run_demo():
    # Give server time to start
    time.sleep(1.5)

    from pathlib import Path
    keypair_path = Path(ALBERT_KEYPAIR_PATH).expanduser()

    print("\n" + "═" * 60)
    print("  basedagents Attestation POC")
    print("  Agent-to-agent gated access demo")
    print("═" * 60)

    # ── Test 1: Legitimate agent (Albert, has 'code' capability) ──
    print("\n[1] Albert (verified, code capability) → Hans's endpoint")
    if keypair_path.exists():
        albert = AgentKeypair.load(keypair_path)
        result = make_signed_request(albert, "POST", "/v1/execute", {
            "task": "Write a function to sort a list of agents by reputation"
        })
        status = result["status"]
        body = result["body"]
        if status == 200:
            print(f"    ✅ Accepted (HTTP {status})")
            print(f"    Agent: {body.get('from_agent')} | Rep: {body.get('reputation'):.3f}")
            print(f"    Result: {body.get('result')}")
        else:
            print(f"    ❌ Rejected (HTTP {status}): {body}")
    else:
        print(f"    ⚠️  Albert keypair not found at {keypair_path}")
        print("    (Run the Albert registration script first)")

    # ── Test 2: Rogue agent (no keypair, random key) ──
    print("\n[2] Rogue agent (unregistered, random keypair) → Hans's endpoint")
    from basedagents import generate_keypair
    rogue = generate_keypair()
    # Manually set a fake agent_id so the header is sent
    import dataclasses
    rogue = dataclasses.replace(rogue, agent_id="ag_FAKE_NOT_REGISTERED_XYZ")
    result = make_signed_request(rogue, "POST", "/v1/execute", {"task": "hack the planet"})
    status = result["status"]
    print(f"    {'✅' if status == 401 else '❌'} Got HTTP {status} (expected 401)")
    if status != 200:
        print(f"    Detail: {result['body'].get('detail', '')[:80]}")

    # ── Test 3: No auth headers at all ──
    print("\n[3] Request with no auth headers")
    with httpx.Client() as client:
        res = client.post(f"{SERVER_URL}/v1/execute", json={"task": "sneak in"})
    print(f"    {'✅' if res.status_code == 401 else '❌'} Got HTTP {res.status_code} (expected 401)")

    print("\n" + "═" * 60)
    print("  Done. The attestation flow:")
    print("  1. Agent signs request with private key (AgentSig)")
    print("  2. Endpoint fetches basedagents attestation (cached 1h)")
    print("  3. Verifies registry signature offline (no extra API call)")
    print("  4. Checks reputation + capabilities")
    print("  5. Passes or rejects")
    print()
    print("  Attestation: GET https://api.basedagents.ai/v1/agents/{id}/attestation")
    print("  Public key:  GET https://api.basedagents.ai/v1/attestation/public-key")
    print("═" * 60 + "\n")


if __name__ == "__main__":
    # Run demo in background thread, server in main thread
    demo_thread = threading.Thread(target=run_demo, daemon=True)
    demo_thread.start()

    config = uvicorn.Config(app, host="127.0.0.1", port=SERVER_PORT, log_level="error")
    server = uvicorn.Server(config)

    # Run until demo completes
    loop = asyncio.get_event_loop()
    loop.run_until_complete(asyncio.sleep(0))  # init

    import signal
    def stop(*_):
        server.should_exit = True
    threading.Timer(8.0, stop).start()

    server.run()
