"""
AgentSig authentication headers.

Authorization: AgentSig <base58_pubkey>:<base64_signature>
X-Timestamp: <unix_seconds>
X-Nonce: <random_string>

Signed message (UTF-8 encoded, then Ed25519-signed):
  "<METHOD>:<path>:<timestamp_sec>:<sha256_hex_of_body>:<nonce>"

The random nonce makes signatures non-deterministic even within the same
second, preventing replay of deterministic GET tokens (L1).
"""
from __future__ import annotations

import base64
import hashlib
import time
import uuid

from .keypair import AgentKeypair


def build_headers(
    keypair: AgentKeypair,
    method: str,
    path: str,
    body: bytes | str | None = None,
    timestamp: int | None = None,
) -> dict[str, str]:
    """
    Build AgentSig auth headers for a signed request.

    Args:
        keypair: Agent keypair
        method: HTTP method (GET, POST, PUT, PATCH, DELETE)
        path: URL path including leading slash (e.g. '/v1/verify/submit')
        body: Request body bytes or string (empty string / None for GET)
        timestamp: Unix timestamp in seconds (defaults to now)

    Returns:
        Dict with 'Authorization', 'X-Timestamp', and 'X-Nonce' headers.
    """
    ts = timestamp if timestamp is not None else int(time.time())
    nonce = str(uuid.uuid4())

    if body is None:
        body_bytes = b""
    elif isinstance(body, str):
        body_bytes = body.encode("utf-8")
    else:
        body_bytes = body

    body_hash = hashlib.sha256(body_bytes).hexdigest()
    message = f"{method.upper()}:{path}:{ts}:{body_hash}:{nonce}".encode("utf-8")
    signature = keypair.sign(message)
    sig_b64 = base64.b64encode(signature).decode("ascii")

    return {
        "Authorization": f"AgentSig {keypair.public_key_b58}:{sig_b64}",
        "X-Timestamp": str(ts),
        "X-Nonce": nonce,
    }
