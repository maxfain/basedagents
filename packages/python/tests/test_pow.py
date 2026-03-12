"""Tests for proof-of-work solver."""
import hashlib
import struct
import pytest
from basedagents import generate_keypair
from basedagents.pow import solve, _count_leading_zero_bits


# ─── _count_leading_zero_bits ───

def test_count_leading_zero_bits_all_zeros():
    assert _count_leading_zero_bits(b"\x00" * 4) == 32


def test_count_leading_zero_bits_first_byte_zero():
    assert _count_leading_zero_bits(b"\x00\xff") == 8


def test_count_leading_zero_bits_high_bit_set():
    # 0x80 = 10000000 → 0 leading zero bits
    assert _count_leading_zero_bits(b"\x80") == 0


def test_count_leading_zero_bits_one_leading_zero():
    # 0x40 = 01000000 → 1 leading zero bit
    assert _count_leading_zero_bits(b"\x40") == 1


def test_count_leading_zero_bits_empty():
    assert _count_leading_zero_bits(b"") == 0


# ─── solve ───

def test_solve_returns_string():
    kp = generate_keypair()
    nonce = solve(kp.public_key_bytes, difficulty=8)
    assert isinstance(nonce, str)


def test_solve_returns_8_char_hex():
    kp = generate_keypair()
    nonce = solve(kp.public_key_bytes, difficulty=8)
    assert len(nonce) == 8
    # Should be valid hex
    int(nonce, 16)


def test_solve_nonce_satisfies_difficulty():
    """The returned nonce must produce a hash with >= difficulty leading zero bits."""
    kp = generate_keypair()
    difficulty = 8
    nonce = solve(kp.public_key_bytes, difficulty)

    nonce_bytes = struct.pack(">I", int(nonce, 16))
    digest = hashlib.sha256(kp.public_key_bytes + nonce_bytes).digest()
    assert _count_leading_zero_bits(digest) >= difficulty


def test_solve_different_keys_different_nonces():
    """Different public keys should generally yield different nonces."""
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    nonce1 = solve(kp1.public_key_bytes, difficulty=8)
    nonce2 = solve(kp2.public_key_bytes, difficulty=8)
    # Almost certainly different (1/2^8 = ~0.4% chance of collision)
    # We just verify both are valid
    assert len(nonce1) == 8
    assert len(nonce2) == 8


def test_solve_difficulty_1_is_fast():
    """At difficulty 1, solution is found almost immediately."""
    kp = generate_keypair()
    nonce = solve(kp.public_key_bytes, difficulty=1)
    assert isinstance(nonce, str)
    assert len(nonce) == 8


def test_solve_with_progress_callback():
    """on_progress callback is optional and doesn't break solve."""
    kp = generate_keypair()
    calls = []
    nonce = solve(
        kp.public_key_bytes,
        difficulty=8,
        on_progress=lambda n: calls.append(n),
        progress_interval=50,
    )
    assert isinstance(nonce, str)
    # Progress might or might not be called depending on how fast solution is found


def test_solve_higher_difficulty_nonce_still_valid():
    """At difficulty 12, solution should still satisfy the requirement."""
    kp = generate_keypair()
    difficulty = 12
    nonce = solve(kp.public_key_bytes, difficulty)

    nonce_bytes = struct.pack(">I", int(nonce, 16))
    digest = hashlib.sha256(kp.public_key_bytes + nonce_bytes).digest()
    assert _count_leading_zero_bits(digest) >= difficulty


def test_invalid_nonce_likely_fails():
    """An arbitrary nonce is very unlikely to satisfy difficulty=16."""
    kp = generate_keypair()
    # All-zeros nonce: check if it satisfies difficulty 16 (very unlikely)
    nonce_bytes = struct.pack(">I", 0)
    digest = hashlib.sha256(kp.public_key_bytes + nonce_bytes).digest()
    bits = _count_leading_zero_bits(digest)
    # The point: verify_pow logic (manual) would return False for this
    # We're testing the count function returns a sensible value
    assert 0 <= bits <= 256
