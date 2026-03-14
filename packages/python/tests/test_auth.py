"""Tests for AgentSig authentication header generation."""
import base64
import hashlib
import time
import pytest
from basedagents import generate_keypair
from basedagents.auth import build_headers
from basedagents.keypair import _base58_decode as b58decode


def test_build_headers_returns_dict():
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/agents/search")
    assert isinstance(headers, dict)


def test_build_headers_has_authorization():
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/agents/search")
    assert "Authorization" in headers


def test_build_headers_has_timestamp():
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/agents/search")
    assert "X-Timestamp" in headers


def test_authorization_starts_with_agent_sig():
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/test")
    assert headers["Authorization"].startswith("AgentSig ")


def test_timestamp_is_recent():
    before = int(time.time())
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/test")
    after = int(time.time())
    ts = int(headers["X-Timestamp"])
    assert before <= ts <= after + 1


def test_custom_timestamp_is_used():
    kp = generate_keypair()
    ts = 1700000000
    headers = build_headers(kp, "GET", "/v1/test", timestamp=ts)
    assert int(headers["X-Timestamp"]) == ts


def test_authorization_format_pubkey_colon_sig():
    """Authorization should be 'AgentSig <pubkey_b58>:<base64_sig>'."""
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/test")
    auth = headers["Authorization"]
    payload = auth[len("AgentSig "):]
    assert ":" in payload
    parts = payload.rsplit(":", 1)
    assert len(parts) == 2
    pubkey_b58, sig_b64 = parts
    assert len(pubkey_b58) > 0
    assert len(sig_b64) > 0


def test_pubkey_in_header_matches_keypair():
    kp = generate_keypair()
    headers = build_headers(kp, "GET", "/v1/test")
    auth = headers["Authorization"]
    payload = auth[len("AgentSig "):]
    pubkey_b58 = payload.rsplit(":", 1)[0]
    assert pubkey_b58 == kp.public_key_b58


def test_signature_is_64_bytes():
    """Ed25519 signatures are always 64 bytes."""
    kp = generate_keypair()
    headers = build_headers(kp, "POST", "/v1/verify/submit", body='{"result":"pass"}')
    auth = headers["Authorization"]
    sig_b64 = auth[len("AgentSig "):].rsplit(":", 1)[1]
    sig_bytes = base64.b64decode(sig_b64)
    assert len(sig_bytes) == 64


def test_signature_verifies_correctly():
    """The signature should verify against the constructed message (including nonce)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    kp = generate_keypair()
    method = "POST"
    path = "/v1/verify/submit"
    body = '{"result":"pass","notes":"looks good"}'
    ts = 1700000000

    headers = build_headers(kp, method, path, body=body, timestamp=ts)

    auth = headers["Authorization"]
    sig_b64 = auth[len("AgentSig "):].rsplit(":", 1)[1]
    sig_bytes = base64.b64decode(sig_b64)
    nonce = headers["X-Nonce"]

    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    message = f"{method.upper()}:{path}:{ts}:{body_hash}:{nonce}".encode("utf-8")

    # Should not raise InvalidSignature
    kp.public_key.verify(sig_bytes, message)


def test_different_methods_produce_different_sigs():
    """Different HTTP methods should produce different signatures."""
    kp = generate_keypair()
    ts = 1700000000
    headers_get = build_headers(kp, "GET", "/v1/test", timestamp=ts)
    headers_post = build_headers(kp, "POST", "/v1/test", timestamp=ts)
    assert headers_get["Authorization"] != headers_post["Authorization"]


def test_different_paths_produce_different_sigs():
    kp = generate_keypair()
    ts = 1700000000
    h1 = build_headers(kp, "GET", "/v1/path/one", timestamp=ts)
    h2 = build_headers(kp, "GET", "/v1/path/two", timestamp=ts)
    assert h1["Authorization"] != h2["Authorization"]


def test_body_as_bytes():
    kp = generate_keypair()
    headers = build_headers(kp, "POST", "/v1/test", body=b'{"key":"value"}')
    assert "Authorization" in headers
    assert headers["Authorization"].startswith("AgentSig ")


def test_none_body_same_as_empty_string():
    """None body and empty string body should produce the same body hash in the signed message."""
    kp = generate_keypair()
    # Both should hash the same empty body — verify by checking the signature
    # verifies correctly for both cases. The nonce differs per call so we can't
    # compare Authorization headers directly.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    ts = 1700000000

    for body in [None, "", b""]:
        headers = build_headers(kp, "GET", "/v1/test", body=body, timestamp=ts)
        auth = headers["Authorization"]
        sig_b64 = auth[len("AgentSig "):].rsplit(":", 1)[1]
        sig_bytes = base64.b64decode(sig_b64)
        nonce = headers["X-Nonce"]
        body_hash = hashlib.sha256(b"").hexdigest()
        message = f"GET:/v1/test:{ts}:{body_hash}:{nonce}".encode("utf-8")
        # Should not raise — proves the body was hashed as empty
        kp.public_key.verify(sig_bytes, message)
