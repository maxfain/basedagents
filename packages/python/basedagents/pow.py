"""
Proof-of-work solver.

Find a 4-byte nonce N such that:
  SHA256(pubkey_bytes || challenge_bytes || N_big_endian) has >= difficulty leading zero bits

The challenge binds the PoW to a specific registration attempt,
preventing nonce reuse across attempts (L3).

Nonce is submitted as an 8-character zero-padded hex string.
"""
from __future__ import annotations

import hashlib
import struct
from typing import Callable


def _count_leading_zero_bits(data: bytes) -> int:
    bits = 0
    for byte in data:
        if byte == 0:
            bits += 8
        else:
            for i in range(7, -1, -1):
                if byte & (1 << i):
                    return bits
                bits += 1
            break
    return bits


def solve(
    public_key_bytes: bytes,
    difficulty: int,
    on_progress: Callable[[int], None] | None = None,
    progress_interval: int = 100_000,
    challenge: str | None = None,
) -> str:
    """
    Solve proof-of-work. Returns nonce as 8-char zero-padded hex string.

    Args:
        public_key_bytes: Raw 32-byte Ed25519 public key
        difficulty: Required leading zero bits
        on_progress: Optional callback(attempts) called every progress_interval iterations
        progress_interval: How often to call on_progress
        challenge: Server challenge string (binds PoW to registration attempt)
    """
    # PY-NEW-LOW-2: Validate public key size
    if len(public_key_bytes) != 32:
        raise ValueError(f"Invalid Ed25519 public key: expected 32 bytes, got {len(public_key_bytes)}")

    # PY-NEW-LOW-1: Validate challenge length bounds
    if challenge is not None:
        if len(challenge) > 1024:
            raise ValueError("Challenge too large — possible attack")
        if len(challenge) < 16:
            raise ValueError("Challenge too small — possible attack")

    challenge_bytes = challenge.encode("utf-8") if challenge else b""
    prefix = public_key_bytes + challenge_bytes
    nonce = 0
    while True:
        nonce_bytes = struct.pack(">I", nonce)  # 4-byte big-endian
        digest = hashlib.sha256(prefix + nonce_bytes).digest()
        if _count_leading_zero_bits(digest) >= difficulty:
            return format(nonce, "08x")
        nonce += 1
        if on_progress and nonce % progress_interval == 0:
            on_progress(nonce)
        if nonce > 0xFFFF_FFFF:
            raise RuntimeError("PoW exhausted 32-bit nonce space — this should not happen")
