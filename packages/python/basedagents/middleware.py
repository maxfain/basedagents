"""
basedagents auth middleware.

Drop-in reputation-gated authentication for FastAPI and WSGI (Flask/Starlette) apps.
Agents prove identity via AgentSig header; the middleware verifies the attestation
offline using the basedagents registry public key.

Usage (FastAPI):
    from basedagents.middleware import require_agent, VerifiedAgent

    @app.post("/execute")
    async def execute(request: Request, agent: VerifiedAgent = Depends(require_agent(
        min_reputation=0.5,
        capabilities=["code"],
    ))):
        print(f"Request from {agent.name} (rep={agent.reputation})")
        ...

Usage (manual):
    from basedagents.middleware import verify_request

    agent = await verify_request(request_headers, method, path, body)
    if agent is None:
        raise HTTPException(status_code=403)
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx

logger = logging.getLogger(__name__)

from .keypair import _base58_decode as b58decode_key

# ── Registry public key (Ed25519, hex) ──────────────────────────────────────
# Published at https://api.basedagents.ai/v1/attestation/public-key
# Hardcoded here for offline verification — no API call needed at auth time.
REGISTRY_PUBLIC_KEY_HEX = "9827a77ffa3bbddff01444277707271838098f3e8f2d29a200054cc0bca308d0"

_DEFAULT_BASE = "https://api.basedagents.ai"
API_BASE = os.environ.get("BASEDAGENTS_API", _DEFAULT_BASE)

# Attestation TTL tolerance (seconds beyond stated expiry)
CLOCK_SKEW_TOLERANCE = 30


@dataclass
class VerifiedAgent:
    """A fully verified, reputation-checked agent identity."""
    agent_id: str
    name: str
    public_key_b58: str
    capabilities: list[str]
    protocols: list[str]
    reputation: float
    reputation_tier: str
    verification_count: int
    issued_at: int
    expires_at: int


class AttestationError(Exception):
    """Raised when attestation verification fails."""
    pass


# ── In-process attestation cache (thread-safe) ────────────────────────────
_cache: dict[str, tuple[dict[str, Any], float]] = {}  # agent_id → (attestation, fetched_at)
_cache_lock = threading.Lock()


def _cache_get(agent_id: str) -> dict[str, Any] | None:
    with _cache_lock:
        entry = _cache.get(agent_id)
        if entry is None:
            return None
        attestation, _ = entry
        # Use until expires_at minus skew tolerance
        if time.time() > attestation["expires_at"] - CLOCK_SKEW_TOLERANCE:
            del _cache[agent_id]
            return None
        return attestation


def _cache_set(agent_id: str, attestation: dict[str, Any]) -> None:
    with _cache_lock:
        _cache[agent_id] = (attestation, time.time())


# ── Attestation fetch & verify ───────────────────────────────────────────────

def _verify_attestation_signature(attestation: dict[str, Any]) -> bool:
    """
    Verify the registry's Ed25519 signature on the attestation document.
    Uses the hardcoded REGISTRY_PUBLIC_KEY_HEX for offline verification.
    """
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.exceptions import InvalidSignature

        sig_b64 = attestation.get("signature", "")
        sig_bytes = base64.b64decode(sig_b64)

        # Reconstruct the payload that was signed (all fields except signature, sorted keys)
        payload = {k: v for k, v in attestation.items() if k not in ("signature", "_verify")}
        sorted_keys = sorted(payload.keys())
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
        # Match server: JSON.stringify(payload, sortedKeys) — compact, no spaces
        msg_bytes = canonical.encode("utf-8")

        pub_key_bytes = bytes.fromhex(REGISTRY_PUBLIC_KEY_HEX)
        pub_key = Ed25519PublicKey.from_public_bytes(pub_key_bytes)
        pub_key.verify(sig_bytes, msg_bytes)
        return True
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return False
    except Exception:
        logger.exception("Unexpected error verifying attestation signature")
        return False


def fetch_attestation(agent_id: str, base_url: str = API_BASE) -> dict[str, Any]:
    """
    Fetch a fresh attestation from the registry and verify its signature.
    Raises AttestationError on failure.
    """
    cached = _cache_get(agent_id)
    if cached is not None:
        return cached

    url = f"{base_url}/v1/agents/{agent_id}/attestation"
    with httpx.Client(timeout=10.0) as client:
        res = client.get(url)

    if res.status_code == 404:
        raise AttestationError(f"Agent {agent_id} not found in registry")
    if res.status_code == 403:
        raise AttestationError(f"Agent {agent_id} is suspended or revoked")
    if not res.is_success:
        raise AttestationError(f"Registry returned {res.status_code} for {agent_id}")

    attestation = res.json()

    # Verify registry signature
    if not _verify_attestation_signature(attestation):
        raise AttestationError("Attestation signature verification failed — possible tampering")

    # Check expiry
    now = int(time.time())
    if now > attestation["expires_at"] + CLOCK_SKEW_TOLERANCE:
        raise AttestationError("Attestation has expired")

    _cache_set(agent_id, attestation)
    return attestation


def verify_request(
    headers: dict[str, str],
    method: str,
    path: str,
    body: str | bytes = "",
    base_url: str = API_BASE,
) -> VerifiedAgent | None:
    """
    Verify an inbound agent request:
    1. Parse X-Agent-ID and Authorization: AgentSig headers
    2. Verify the request signature (agent signed this request)
    3. Fetch + verify the registry attestation (registry signed the agent's identity)
    4. Confirm the signing key matches the attested public key
    Returns VerifiedAgent or None if verification fails.
    """
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.exceptions import InvalidSignature

    # Parse headers (case-insensitive)
    headers_lower = {k.lower(): v for k, v in headers.items()}

    agent_id = headers_lower.get("x-agent-id", "").strip()
    auth_header = headers_lower.get("authorization", "")
    timestamp_str = headers_lower.get("x-timestamp", "")

    if not agent_id or not auth_header or not timestamp_str:
        return None

    if not auth_header.startswith("AgentSig "):
        return None

    try:
        sig_part = auth_header[len("AgentSig "):]
        pubkey_b58, sig_b64 = sig_part.rsplit(":", 1)
        timestamp = int(timestamp_str)
    except (ValueError, IndexError):
        return None

    # Check clock skew (±60 seconds)
    now = int(time.time())
    if abs(now - timestamp) > 60:
        return None

    # Verify request signature
    # New format: "<METHOD>:<path>:<timestamp>:<sha256_hex_of_body>:<nonce>"
    # Legacy (no X-Nonce header): "<METHOD>:<path>:<timestamp>:<sha256_hex_of_body>"
    body_bytes = body.encode() if isinstance(body, str) else body
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    req_nonce = headers_lower.get("x-nonce", "").strip()
    message = (
        f"{method.upper()}:{path}:{timestamp}:{body_hash}:{req_nonce}"
        if req_nonce
        else f"{method.upper()}:{path}:{timestamp}:{body_hash}"
    )

    try:
        pub_key_bytes = b58decode_key(pubkey_b58)
        sig_bytes = base64.b64decode(sig_b64)
        pub_key = Ed25519PublicKey.from_public_bytes(pub_key_bytes)
        pub_key.verify(sig_bytes, message.encode("utf-8"))
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return None
    except Exception:
        logger.exception("Unexpected error verifying request signature")
        return None

    # Fetch attestation and verify registry signature
    try:
        attestation = fetch_attestation(agent_id, base_url)
    except AttestationError:
        return None

    # Confirm agent_id matches
    if attestation["agent_id"] != agent_id:
        return None

    # Confirm signing key matches attested public key
    if attestation["public_key_b58"] != pubkey_b58:
        return None

    return VerifiedAgent(
        agent_id=attestation["agent_id"],
        name=attestation["agent_name"],
        public_key_b58=attestation["public_key_b58"],
        capabilities=attestation["capabilities"],
        protocols=attestation["protocols"],
        reputation=attestation["reputation"],
        reputation_tier=attestation["reputation_tier"],
        verification_count=attestation["verification_count"],
        issued_at=attestation["issued_at"],
        expires_at=attestation["expires_at"],
    )


# ── FastAPI dependency ────────────────────────────────────────────────────────

def require_agent(
    min_reputation: float = 0.0,
    capabilities: list[str] | None = None,
    base_url: str = API_BASE,
) -> Callable:
    """
    FastAPI dependency factory for reputation-gated agent authentication.

    Args:
        min_reputation: Minimum reputation score (0–1). Default 0 (any registered agent).
        capabilities: Required capabilities. Agent must have ALL of them verified.
        base_url: Override API base URL (useful for testing with staging).

    Returns:
        FastAPI Depends-compatible callable that returns VerifiedAgent.

    Raises:
        HTTPException(401) if agent identity cannot be verified.
        HTTPException(403) if agent doesn't meet reputation/capability requirements.

    Example:
        @app.post("/run")
        async def run(request: Request, agent: VerifiedAgent = Depends(require_agent(
            min_reputation=0.5,
            capabilities=["code"],
        ))):
            ...
    """
    async def _dependency(request: Any) -> VerifiedAgent:
        # Import here to avoid hard dep on fastapi
        try:
            from fastapi import HTTPException
            from fastapi import Request as FastAPIRequest
        except ImportError:
            raise ImportError("fastapi is required for require_agent(). pip install fastapi")

        # Read body
        body = b""
        try:
            body = await request.body()
        except Exception:
            pass

        headers = dict(request.headers)
        path = request.url.path
        method = request.method

        agent = verify_request(headers, method, path, body, base_url)

        if agent is None:
            raise HTTPException(
                status_code=401,
                detail="Agent identity verification failed. Include X-Agent-ID and Authorization: AgentSig headers.",
            )

        if agent.reputation < min_reputation:
            raise HTTPException(
                status_code=403,
                detail=f"Agent reputation {agent.reputation:.3f} below required {min_reputation}. "
                       f"Current tier: {agent.reputation_tier}.",
            )

        if capabilities:
            missing = [c for c in capabilities if c not in agent.capabilities]
            if missing:
                raise HTTPException(
                    status_code=403,
                    detail=f"Agent missing required capabilities: {missing}. "
                           f"Attested capabilities: {agent.capabilities}.",
                )

        return agent

    return _dependency
