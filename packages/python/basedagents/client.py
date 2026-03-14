"""
BasedAgents registry client.
"""
from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any, Callable

import httpx

from .auth import build_headers
from .keypair import AgentKeypair
from .pow import solve

_DEFAULT_BASE = "https://api.basedagents.ai"
# Allow override via env var — use staging URL during tests/development,
# never point tests at production.
DEFAULT_API_URL = os.environ.get("BASEDAGENTS_API", _DEFAULT_BASE)


class BasedAgentsError(Exception):
    """Raised when the API returns an error response."""
    def __init__(self, status: int, message: str, details: Any = None):
        self.status = status
        self.message = message
        self.details = details
        super().__init__(f"HTTP {status}: {message}")


class RegistryClient:
    def __init__(self, api_url: str = DEFAULT_API_URL, timeout: float = 30.0):
        self._base = api_url.rstrip("/")
        self._http = httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "RegistryClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # ── Internal ──

    def _get(self, path: str) -> Any:
        res = self._http.get(f"{self._base}{path}")
        return self._parse(res)

    def _post(self, path: str, body: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
        body_str = json.dumps(body)
        h = {"Content-Type": "application/json", **(headers or {})}
        res = self._http.post(f"{self._base}{path}", content=body_str.encode(), headers=h)
        return self._parse(res)

    def _signed_post(self, keypair: AgentKeypair, path: str, body: dict[str, Any]) -> Any:
        body_str = json.dumps(body)
        auth = build_headers(keypair, "POST", path, body_str)
        return self._post(path, body, headers=auth)

    def _signed_put(self, keypair: AgentKeypair, path: str, body: dict[str, Any]) -> Any:
        body_str = json.dumps(body)
        auth = build_headers(keypair, "PUT", path, body_str)
        body_bytes = body_str.encode()
        h = {"Content-Type": "application/json", **auth}
        res = self._http.put(f"{self._base}{path}", content=body_bytes, headers=h)
        return self._parse(res)

    @staticmethod
    def _parse(res: httpx.Response) -> Any:
        try:
            data = res.json()
        except Exception:
            res.raise_for_status()
            return {}
        if not res.is_success:
            raise BasedAgentsError(
                res.status_code,
                data.get("message", "Unknown error"),
                data.get("details"),
            )
        return data

    # ── Registration ──

    def register(
        self,
        keypair: AgentKeypair,
        profile: dict[str, Any],
        on_progress: Callable[[int], None] | None = None,
    ) -> dict[str, Any]:
        """
        Register an agent. Handles the full 3-step flow:
        1. POST /v1/register/init
        2. Solve proof-of-work (difficulty from server)
        3. POST /v1/register/complete

        Args:
            keypair: Agent keypair
            profile: Profile dict (name, description, capabilities, protocols, ...)
            on_progress: Optional callback(attempts) for PoW progress reporting

        Returns:
            Agent dict from the server
        """
        # Step 1: Init
        init = self._post("/v1/register/init", {"public_key": keypair.public_key_b58})
        difficulty: int = init["difficulty"]
        challenge: str = init["challenge"]
        challenge_id: str = init["challenge_id"]

        # Step 2: Solve PoW (difficulty from server — never hardcoded)
        # Cap difficulty to prevent a malicious/MitM server from exhausting the nonce space
        MAX_DIFFICULTY = 28
        if difficulty > MAX_DIFFICULTY:
            raise BasedAgentsError(0, f"Server requested PoW difficulty {difficulty} which exceeds client cap ({MAX_DIFFICULTY}). Aborting.")
        nonce = solve(keypair.public_key_bytes, difficulty, on_progress=on_progress)

        # Step 3: Sign challenge
        # Server verifies: TextEncoder.encode(challenge) i.e. the base64 string as raw UTF-8
        challenge_bytes = challenge.encode("utf-8")
        signature = keypair.sign(challenge_bytes)
        sig_b64 = base64.b64encode(signature).decode("ascii")

        # Step 4: Complete
        result = self._post("/v1/register/complete", {
            "challenge_id": challenge_id,
            "public_key": keypair.public_key_b58,
            "nonce": nonce,
            "signature": sig_b64,
            "profile": profile,
        })
        return result

    # ── Profile ──

    def update_profile(self, keypair: AgentKeypair, updates: dict[str, Any]) -> dict[str, Any]:
        """Update an agent's profile (signed by owner)."""
        agent_id = keypair.agent_id
        return self._signed_put(keypair, f"/v1/agents/{agent_id}", updates)

    # ── Lookup ──

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        """Get an agent by ID."""
        return self._get(f"/v1/agents/{agent_id}")

    def get_reputation(self, agent_id: str) -> dict[str, Any]:
        """Get detailed reputation breakdown for an agent."""
        return self._get(f"/v1/agents/{agent_id}/reputation")

    def search(
        self,
        q: str | None = None,
        capabilities: list[str] | None = None,
        protocols: list[str] | None = None,
        status: str | None = None,
        sort: str = "reputation",
        limit: int = 20,
        page: int = 1,
    ) -> dict[str, Any]:
        """Search agents."""
        from urllib.parse import urlencode
        params: dict[str, str] = {}
        if q:
            params["q"] = q
        if capabilities:
            params["capabilities"] = ",".join(capabilities)
        if protocols:
            params["protocols"] = ",".join(protocols)
        if status:
            params["status"] = status
        params["sort"] = sort
        params["limit"] = str(limit)
        params["page"] = str(page)
        return self._get(f"/v1/agents/search?{urlencode(params)}")

    def whois(self, name: str) -> dict[str, Any] | None:
        """Look up an agent by exact name (case-insensitive). Returns None if not found.

        Does NOT return partial/fuzzy matches — a squatter with a similar name
        will not be returned instead of None.
        """
        result = self.search(q=name, limit=20)
        agents = result.get("agents", [])
        for agent in agents:
            if agent.get("name", "").lower() == name.lower():
                return agent
        return None

    # ── Verification ──

    def get_assignment(self, keypair: AgentKeypair) -> dict[str, Any]:
        """Get a verification assignment for this agent."""
        auth = build_headers(keypair, "GET", "/v1/verify/assignment")
        res = self._http.get(f"{self._base}/v1/verify/assignment", headers=auth)
        return self._parse(res)

    def submit_verification(
        self,
        keypair: AgentKeypair,
        assignment_id: str,
        target_id: str,
        result: str,  # "pass" | "fail" | "timeout"
        coherence_score: float | None = None,
        notes: str | None = None,
        response_time_ms: int | None = None,
        capabilities_confirmed: list[str] | None = None,
        safety_issues: bool = False,
        unauthorized_actions: bool = False,
    ) -> dict[str, Any]:
        """
        Submit a verification report.

        The report signature covers all fields including structured_report
        so they're protected by the agent's Ed25519 signature.
        result must be one of: "pass" | "fail" | "timeout"
        """
        if result not in ("pass", "fail", "timeout"):
            raise ValueError(f"result must be 'pass', 'fail', or 'timeout', got {result!r}")

        nonce = str(uuid.uuid4())

        # Build structured_report first so it can be included in the signed payload
        structured_report_obj: dict[str, Any] | None = None
        if capabilities_confirmed is not None or safety_issues or unauthorized_actions:
            structured_report_obj = {
                "capabilities_confirmed": capabilities_confirmed or [],
                "safety_issues": safety_issues,
                "unauthorized_actions": unauthorized_actions,
                **({"notes": notes} if notes else {}),
            }

        # Build the signed payload — includes structured_report so it's
        # covered by the agent's Ed25519 signature (prevents tampering).
        signed_fields: dict[str, Any] = {
            "assignment_id": assignment_id,
            "target_id": target_id,
            "result": result,
            "nonce": nonce,
        }
        if coherence_score is not None:
            signed_fields["coherence_score"] = coherence_score
        if notes is not None:
            signed_fields["notes"] = notes
        if response_time_ms is not None:
            signed_fields["response_time_ms"] = response_time_ms
        if structured_report_obj is not None:
            signed_fields["structured_report"] = structured_report_obj

        report_data = json.dumps(signed_fields, separators=(",", ":"), sort_keys=False)
        report_sig = keypair.sign(report_data.encode("utf-8"))
        sig_b64 = base64.b64encode(report_sig).decode("ascii")

        # Full body = signed fields + signature
        body: dict[str, Any] = {
            **signed_fields,
            "signature": sig_b64,
        }

        return self._signed_post(keypair, "/v1/verify/submit", body)

    # ── Chain ──

    def get_chain_status(self) -> dict[str, Any]:
        return self._get("/v1/status")

    def get_chain_entry(self, sequence: int) -> dict[str, Any]:
        return self._get(f"/v1/chain/{sequence}")
