"""Tests for keypair generation and serialization."""
import pytest
from basedagents import generate_keypair, from_private_key_hex
from basedagents.keypair import AgentKeypair


def test_generate_keypair_returns_agent_keypair():
    kp = generate_keypair()
    assert isinstance(kp, AgentKeypair)


def test_generate_keypair_public_key_is_32_bytes():
    kp = generate_keypair()
    assert len(kp.public_key_bytes) == 32


def test_generate_keypair_agent_id_starts_with_ag():
    kp = generate_keypair()
    assert kp.agent_id.startswith("ag_")


def test_generate_keypair_agent_id_contains_base58_pubkey():
    kp = generate_keypair()
    # agent_id = "ag_" + base58(pubkey)
    assert kp.agent_id == f"ag_{kp.public_key_b58}"


def test_generate_keypair_is_unique():
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    assert kp1.public_key_bytes != kp2.public_key_bytes
    assert kp1.agent_id != kp2.agent_id


def test_private_key_hex_is_64_chars():
    """Ed25519 private key is 32 bytes = 64 hex characters."""
    kp = generate_keypair()
    assert len(kp.private_key_hex) == 64


def test_sign_returns_64_byte_signature():
    """Ed25519 signature is always 64 bytes."""
    kp = generate_keypair()
    sig = kp.sign(b"test message")
    assert isinstance(sig, bytes)
    assert len(sig) == 64


def test_sign_is_deterministic_for_same_message():
    """Ed25519 (using deterministic variant) should produce same sig for same key+msg."""
    kp = generate_keypair()
    msg = b"deterministic test"
    sig1 = kp.sign(msg)
    sig2 = kp.sign(msg)
    assert sig1 == sig2


def test_serialize_round_trip_via_from_private_key_hex():
    """to_dict() + from_private_key_hex() should recover the same keys."""
    kp = generate_keypair()
    d = kp.to_dict()
    kp2 = from_private_key_hex(d["private_key_hex"])
    assert kp.public_key_bytes == kp2.public_key_bytes
    assert kp.agent_id == kp2.agent_id


def test_to_dict_contains_required_keys():
    kp = generate_keypair()
    d = kp.to_dict()
    assert "agent_id" in d
    assert "public_key_b58" in d
    assert "private_key_hex" in d


def test_to_dict_values_match_keypair():
    kp = generate_keypair()
    d = kp.to_dict()
    assert d["agent_id"] == kp.agent_id
    assert d["public_key_b58"] == kp.public_key_b58
    assert d["private_key_hex"] == kp.private_key_hex


def test_from_private_key_hex_restores_signing_ability():
    """Restored keypair should produce same signatures as original."""
    kp = generate_keypair()
    kp2 = from_private_key_hex(kp.private_key_hex)
    msg = b"verify signing works"
    sig1 = kp.sign(msg)
    sig2 = kp2.sign(msg)
    assert sig1 == sig2


def test_signature_verifies_with_cryptography():
    """Verify signature using the cryptography library directly."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    kp = generate_keypair()
    msg = b"hello basedagents"
    sig = kp.sign(msg)
    # Should not raise
    kp.public_key.verify(sig, msg)
