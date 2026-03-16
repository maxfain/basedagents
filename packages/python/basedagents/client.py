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

def canonical_json(obj: Any) -> str:
    """Canonical JSON serialization for signature payloads.
    Uses sort_keys=True and compact separators for deterministic output."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


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
        # MAX_DIFFICULTY caps proof-of-work at 28 leading zero bits.
        # At difficulty 28, expected attempts = 2^28 = ~268M hashes.
        # The nonce is 32-bit (4 bytes), giving 2^32 = ~4B possible values.
        # Difficulty >= 32 would exhaust the nonce space deterministically.
        # We cap at 28 to leave comfortable headroom.
        MAX_DIFFICULTY = 28
        if difficulty > MAX_DIFFICULTY:
            raise BasedAgentsError(0, f"Server requested PoW difficulty {difficulty} which exceeds client cap ({MAX_DIFFICULTY}). Aborting.")
        # Challenge-bound PoW: includes challenge in hash to prevent nonce reuse (L3)
        nonce = solve(keypair.public_key_bytes, difficulty, on_progress=on_progress, challenge=challenge)

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

        report_data = canonical_json(signed_fields)
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

    # ── Scanner ──

    def scan_trigger(
        self,
        package: str,
        source: str = "npm",
        version: str | None = None,
        ref: str | None = None,
    ) -> dict[str, Any]:
        """Trigger a server-side package scan."""
        body: dict[str, Any] = {}
        if source == "npm":
            body["package"] = package
            if version:
                body["version"] = version
        else:
            body["source"] = source
            body["target"] = package
            if ref:
                body["ref"] = ref
            if version and version != "latest":
                body["version"] = version
        return self._post("/v1/scan/trigger", body)

    def get_scan_report(self, identifier: str, version: str | None = None) -> dict[str, Any]:
        """Get a scan report by package identifier (e.g., 'lodash', 'github:owner/repo', 'pypi:requests')."""
        qs = f"?version={version}" if version else ""
        return self._get(f"/v1/scan/{identifier}{qs}")

    def list_scan_reports(
        self,
        limit: int = 20,
        offset: int = 0,
        sort: str = "recent",
        source: str | None = None,
    ) -> dict[str, Any]:
        """List scan reports."""
        params = f"?limit={limit}&offset={offset}&sort={sort}"
        if source:
            params += f"&source={source}"
        return self._get(f"/v1/scan{params}")

    # ── Tasks ──

    def create_task(
        self,
        keypair: AgentKeypair,
        title: str,
        description: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Create a task."""
        body = {"title": title, "description": description, **kwargs}
        return self._signed_post(keypair, "/v1/tasks", body)

    def get_task(self, task_id: str) -> dict[str, Any]:
        """Get task details."""
        return self._get(f"/v1/tasks/{task_id}")

    def list_tasks(
        self,
        status: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """List tasks."""
        params = f"?limit={limit}&offset={offset}"
        if status:
            params += f"&status={status}"
        return self._get(f"/v1/tasks{params}")

    def claim_task(self, keypair: AgentKeypair, task_id: str) -> dict[str, Any]:
        """Claim a task."""
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/claim", {})

    def submit_task(
        self,
        keypair: AgentKeypair,
        task_id: str,
        content: str,
        summary: str,
        submission_type: str = "json",
    ) -> dict[str, Any]:
        """Submit task deliverable."""
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/submit", {
            "content": content,
            "summary": summary,
            "submission_type": submission_type,
        })

    def verify_task(self, keypair: AgentKeypair, task_id: str) -> dict[str, Any]:
        """Verify/accept a task deliverable."""
        return self._signed_post(keypair, f"/v1/tasks/{task_id}/verify", {})

    # ── Probe (MCP Playground) ──

    def probe_agent(
        self,
        agent_id: str,
        method: str = "tools/list",
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Probe an agent's MCP endpoint."""
        return self._post(f"/v1/agents/{agent_id}/probe", {
            "method": method,
            "params": params or {},
        })

    # ── Skills ──

    def get_agent_skills(self, agent_id: str) -> dict[str, Any]:
        """Get resolved skills for an agent."""
        return self._get(f"/v1/skills/agent/{agent_id}")

    def get_skill(self, registry: str, name: str) -> dict[str, Any]:
        """Look up a skill by registry and name."""
        return self._get(f"/v1/skills/{registry}/{name}")
