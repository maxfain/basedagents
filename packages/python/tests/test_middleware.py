"""Tests for request verification middleware."""
import base64
import hashlib
import json
import time
from unittest.mock import patch, MagicMock
import pytest

from basedagents import generate_keypair
from basedagents.auth import build_headers
from basedagents.middleware import (
    verify_request,
    VerifiedAgent,
    AttestationError,
    _verify_attestation_signature,
)


# ─── Helpers ───

def make_attestation(kp, agent_id=None, expires_in=3600, reputation=0.8):
    """Build a fake attestation dict for a given keypair."""
    now = int(time.time())
    aid = agent_id or kp.agent_id
    return {
        "agent_id": aid,
        "agent_name": "TestAgent",
        "public_key_b58": kp.public_key_b58,
        "capabilities": ["code", "analysis"],
        "protocols": ["https"],
        "reputation": reputation,
        "reputation_tier": "trusted",
        "verification_count": 5,
        "issued_at": now - 100,
        "expires_at": now + expires_in,
    }


def make_signed_request_headers(kp, method, path, body="", timestamp=None):
    """Build complete request headers including X-Agent-ID."""
    ts = timestamp or int(time.time())
    headers = build_headers(kp, method, path, body=body, timestamp=ts)
    headers["X-Agent-ID"] = kp.agent_id
    return headers


# ─── verify_request ───

class TestVerifyRequest:
    def test_valid_request_returns_verified_agent(self):
        kp = generate_keypair()
        attestation = make_attestation(kp)

        headers = make_signed_request_headers(kp, "GET", "/v1/test")

        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "GET", "/v1/test")

        assert isinstance(result, VerifiedAgent)
        assert result.agent_id == kp.agent_id
        assert result.name == "TestAgent"

    def test_valid_request_with_body(self):
        kp = generate_keypair()
        attestation = make_attestation(kp)
        body = '{"result":"pass"}'

        headers = make_signed_request_headers(kp, "POST", "/v1/verify/submit", body=body)

        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "POST", "/v1/verify/submit", body=body)

        assert isinstance(result, VerifiedAgent)

    def test_verified_agent_has_correct_fields(self):
        kp = generate_keypair()
        attestation = make_attestation(kp, reputation=0.9)

        headers = make_signed_request_headers(kp, "GET", "/v1/test")

        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "GET", "/v1/test")

        assert result.reputation == 0.9
        assert result.reputation_tier == "trusted"
        assert "code" in result.capabilities
        assert result.verification_count == 5
        assert result.public_key_b58 == kp.public_key_b58

    def test_missing_authorization_header_returns_none(self):
        kp = generate_keypair()
        headers = {
            "X-Agent-ID": kp.agent_id,
            "X-Timestamp": str(int(time.time())),
            # No Authorization
        }
        result = verify_request(headers, "GET", "/v1/test")
        assert result is None

    def test_missing_agent_id_header_returns_none(self):
        kp = generate_keypair()
        headers = build_headers(kp, "GET", "/v1/test")
        # No X-Agent-ID
        result = verify_request(headers, "GET", "/v1/test")
        assert result is None

    def test_missing_timestamp_header_returns_none(self):
        kp = generate_keypair()
        headers = {
            "X-Agent-ID": kp.agent_id,
            "Authorization": f"AgentSig {kp.public_key_b58}:invalidsig",
            # No X-Timestamp
        }
        result = verify_request(headers, "GET", "/v1/test")
        assert result is None

    def test_expired_timestamp_returns_none(self):
        """Timestamp more than 60 seconds old should be rejected."""
        kp = generate_keypair()
        old_timestamp = int(time.time()) - 120  # 2 minutes ago

        headers = make_signed_request_headers(kp, "GET", "/v1/test", timestamp=old_timestamp)

        result = verify_request(headers, "GET", "/v1/test")
        assert result is None

    def test_future_timestamp_returns_none(self):
        """Timestamp more than 60 seconds in the future should be rejected."""
        kp = generate_keypair()
        future_timestamp = int(time.time()) + 120  # 2 minutes in the future

        headers = make_signed_request_headers(kp, "GET", "/v1/test", timestamp=future_timestamp)

        result = verify_request(headers, "GET", "/v1/test")
        assert result is None

    def test_tampered_body_returns_none(self):
        """Signing with one body but verifying with different body should fail."""
        kp = generate_keypair()
        attestation = make_attestation(kp)

        original_body = '{"result":"pass"}'
        tampered_body = '{"result":"fail"}'

        # Sign with original body
        headers = make_signed_request_headers(kp, "POST", "/v1/test", body=original_body)

        # Verify with tampered body — signature won't match
        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "POST", "/v1/test", body=tampered_body)

        assert result is None

    def test_wrong_method_returns_none(self):
        """Signing GET but verifying as POST should fail (method in signed message)."""
        kp = generate_keypair()
        attestation = make_attestation(kp)

        # Sign as GET
        headers = make_signed_request_headers(kp, "GET", "/v1/test")

        # Verify as POST
        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "POST", "/v1/test")

        assert result is None

    def test_wrong_path_returns_none(self):
        """Signing /v1/test but verifying /v1/other should fail."""
        kp = generate_keypair()
        attestation = make_attestation(kp)

        headers = make_signed_request_headers(kp, "GET", "/v1/test")

        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "GET", "/v1/other")

        assert result is None

    def test_attestation_error_returns_none(self):
        """If attestation fetch fails, verification should return None."""
        kp = generate_keypair()
        headers = make_signed_request_headers(kp, "GET", "/v1/test")

        with patch("basedagents.middleware.fetch_attestation", side_effect=AttestationError("Not found")):
            result = verify_request(headers, "GET", "/v1/test")

        assert result is None

    def test_invalid_authorization_format_returns_none(self):
        kp = generate_keypair()
        headers = {
            "X-Agent-ID": kp.agent_id,
            "Authorization": "Bearer sometoken",  # Wrong format
            "X-Timestamp": str(int(time.time())),
        }
        result = verify_request(headers, "GET", "/v1/test")
        assert result is None

    def test_headers_are_case_insensitive(self):
        """verify_request should handle mixed-case header names."""
        kp = generate_keypair()
        attestation = make_attestation(kp)

        ts = int(time.time())
        base = build_headers(kp, "GET", "/v1/test", timestamp=ts)

        # Use mixed-case header names
        headers = {
            "x-agent-id": kp.agent_id,          # lowercase
            "AUTHORIZATION": base["Authorization"],  # uppercase
            "x-timestamp": base["X-Timestamp"],  # lowercase
        }

        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "GET", "/v1/test")

        assert isinstance(result, VerifiedAgent)

    def test_public_key_mismatch_returns_none(self):
        """If attested pubkey doesn't match signing key, reject the request."""
        kp = generate_keypair()
        kp_wrong = generate_keypair()

        # Attestation says public key is kp's, but request is signed with kp_wrong
        attestation = make_attestation(kp)  # attested to kp's pubkey
        attestation["agent_id"] = kp.agent_id

        # Sign the request with kp_wrong
        headers = make_signed_request_headers(kp_wrong, "GET", "/v1/test")
        # But claim to be kp's agent_id
        headers["X-Agent-ID"] = kp.agent_id

        with patch("basedagents.middleware.fetch_attestation", return_value=attestation):
            result = verify_request(headers, "GET", "/v1/test")

        # Should fail because pubkey_b58 in auth != attestation pubkey
        assert result is None
