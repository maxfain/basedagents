"""
Ed25519 keypair generation and serialization.

Agent ID = "ag_" + base58(public_key_bytes)
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

# Base58 alphabet (Bitcoin-style, no 0OIl)
_B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _base58_encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    result = ""
    while n > 0:
        result = _B58_ALPHA[n % 58] + result
        n //= 58
    # Leading zero bytes → leading '1's
    for byte in data:
        if byte == 0:
            result = "1" + result
        else:
            break
    return result


def _base58_decode(s: str) -> bytes:
    n = 0
    for char in s:
        n = n * 58 + _B58_ALPHA.index(char)
    length = (n.bit_length() + 7) // 8
    result = n.to_bytes(length, "big")
    # Restore leading zero bytes
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + result


@dataclass
class AgentKeypair:
    private_key: Ed25519PrivateKey
    public_key: Ed25519PublicKey
    public_key_bytes: bytes
    public_key_b58: str
    agent_id: str

    def sign(self, data: bytes) -> bytes:
        return self.private_key.sign(data)

    @property
    def private_key_hex(self) -> str:
        raw = self.private_key.private_bytes_raw()
        return raw.hex()

    def to_dict(self) -> dict[str, str]:
        return {
            "agent_id": self.agent_id,
            "public_key_b58": self.public_key_b58,
            "private_key_hex": self.private_key_hex,
        }

    def save(self, path: Path) -> None:
        """Save keypair to a JSON file.

        The keys directory is created 0o700 (owner-only).
        The file is opened with O_CREAT|O_TRUNC and mode 0o600 atomically —
        no window where the plaintext key is world-readable.
        """
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Ensure the dir itself is 0o700 even if it pre-existed
        os.chmod(path.parent, 0o700)
        data = json.dumps(self.to_dict(), indent=2).encode()
        # Atomic create with correct mode — no chmod-after-write race
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)

    @classmethod
    def load(cls, path: Path) -> "AgentKeypair":
        data = json.loads(path.read_text())
        return from_private_key_hex(data["private_key_hex"])


def generate() -> AgentKeypair:
    """Generate a new Ed25519 keypair."""
    private_key = Ed25519PrivateKey.generate()
    return _from_private(private_key)


def from_private_key_hex(hex_str: str) -> AgentKeypair:
    """Load a keypair from a hex-encoded private key."""
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    raw = bytes.fromhex(hex_str)
    private_key = Ed25519PrivateKey.from_private_bytes(raw)
    return _from_private(private_key)


def _from_private(private_key: Ed25519PrivateKey) -> AgentKeypair:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    public_key = private_key.public_key()
    pub_bytes = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
    pub_b58 = _base58_encode(pub_bytes)
    agent_id = f"ag_{pub_b58}"
    return AgentKeypair(
        private_key=private_key,
        public_key=public_key,
        public_key_bytes=pub_bytes,
        public_key_b58=pub_b58,
        agent_id=agent_id,
    )
