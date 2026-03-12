"""Tests for RegistryClient — all HTTP calls are mocked."""
import json
import pytest
from unittest.mock import MagicMock, patch, call
import httpx

from basedagents import generate_keypair
from basedagents.client import RegistryClient, BasedAgentsError


# ─── Helpers ───

def make_agent(name="TestAgent", agent_id="ag_test123"):
    return {
        "agent_id": agent_id,
        "name": name,
        "description": "A test agent",
        "status": "active",
        "reputation_score": 0.8,
        "verification_count": 10,
        "capabilities": ["code"],
        "protocols": ["https"],
        "created_at": "2024-01-01T00:00:00Z",
    }


def make_mock_response(data, status_code=200):
    """Create a mock httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.json.return_value = data
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.raise_for_status = MagicMock()
    return resp


def make_client_with_mock(base_url="https://api.test.local"):
    """Create a RegistryClient with a mocked _http attribute."""
    client = RegistryClient(api_url=base_url)
    mock_http = MagicMock()
    client._http = mock_http
    return client, mock_http


# ─── get_agent ───

class TestGetAgent:
    def test_sends_get_to_correct_url(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response(make_agent())

        client.get_agent("ag_test123")

        mock_http.get.assert_called_once_with("https://api.test.local/v1/agents/ag_test123")

    def test_returns_agent_dict(self):
        client, mock_http = make_client_with_mock()
        agent = make_agent(name="MyBot")
        mock_http.get.return_value = make_mock_response(agent)

        result = client.get_agent("ag_test123")

        assert result["name"] == "MyBot"
        assert result["agent_id"] == "ag_test123"

    def test_raises_on_error_status(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"message": "Not found"}, 404)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.get_agent("ag_missing")
        assert exc_info.value.status == 404


# ─── search ───

class TestSearch:
    def test_sends_get_to_search_endpoint(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"agents": [], "total": 0})

        client.search(q="hello")

        call_url = mock_http.get.call_args[0][0]
        assert "/v1/agents/search" in call_url
        assert "q=hello" in call_url

    def test_passes_capabilities_and_protocols(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"agents": [], "total": 0})

        client.search(capabilities=["code", "analysis"], protocols=["https"])

        call_url = mock_http.get.call_args[0][0]
        assert "capabilities=code%2Canalysis" in call_url or "capabilities=code,analysis" in call_url
        assert "protocols=https" in call_url

    def test_returns_search_results(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("Agent1"), make_agent("Agent2")]
        mock_http.get.return_value = make_mock_response({"agents": agents, "total": 2})

        result = client.search()

        assert len(result["agents"]) == 2
        assert result["total"] == 2

    def test_pagination_params(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"agents": [], "total": 0})

        client.search(limit=5, page=3)

        call_url = mock_http.get.call_args[0][0]
        assert "limit=5" in call_url
        assert "page=3" in call_url


# ─── whois ───

class TestWhois:
    def test_returns_agent_by_exact_name(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("TargetAgent"), make_agent("OtherAgent")]
        mock_http.get.return_value = make_mock_response({"agents": agents, "total": 2})

        result = client.whois("TargetAgent")

        assert result is not None
        assert result["name"] == "TargetAgent"

    def test_returns_none_when_not_found(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("DifferentAgent")]
        mock_http.get.return_value = make_mock_response({"agents": agents, "total": 1})

        result = client.whois("NonExistentAgent")

        assert result is None

    def test_case_insensitive_match(self):
        client, mock_http = make_client_with_mock()
        agents = [make_agent("MyAgent")]
        mock_http.get.return_value = make_mock_response({"agents": agents, "total": 1})

        result = client.whois("myagent")

        assert result is not None
        assert result["name"] == "MyAgent"

    def test_returns_none_on_empty_results(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"agents": [], "total": 0})

        result = client.whois("AnyName")

        assert result is None


# ─── get_reputation ───

class TestGetReputation:
    def test_sends_get_to_reputation_endpoint(self):
        client, mock_http = make_client_with_mock()
        rep = {"agent_id": "ag_test", "reputation_score": 0.75}
        mock_http.get.return_value = make_mock_response(rep)

        client.get_reputation("ag_test")

        call_url = mock_http.get.call_args[0][0]
        assert "/v1/agents/ag_test/reputation" in call_url

    def test_returns_reputation_data(self):
        client, mock_http = make_client_with_mock()
        rep = {"agent_id": "ag_test", "reputation_score": 0.75, "confidence": 0.9}
        mock_http.get.return_value = make_mock_response(rep)

        result = client.get_reputation("ag_test")

        assert result["reputation_score"] == 0.75


# ─── register ───

class TestRegister:
    def test_full_registration_flow(self):
        """register() makes init POST, solves PoW, then makes complete POST."""
        kp = generate_keypair()

        client, mock_http = make_client_with_mock()

        # Mock init and complete responses
        init_resp = make_mock_response({
            "challenge_id": "chal_abc",
            "challenge": "dGVzdC1jaGFsbGVuZ2U=",  # base64 challenge string
            "difficulty": 4,  # Very low for speed
        })
        complete_resp = make_mock_response({
            "agent": make_agent("RegisteredAgent"),
            "agent_id": "ag_newagent123",
        })
        mock_http.post.side_effect = [init_resp, complete_resp]

        profile = {
            "name": "RegisteredAgent",
            "description": "Test registration",
            "capabilities": ["code"],
            "protocols": ["https"],
        }

        result = client.register(kp, profile)

        # Should have made 2 POST calls
        assert mock_http.post.call_count == 2

        # First call: init
        init_url = mock_http.post.call_args_list[0][0][0]
        assert "/v1/register/init" in init_url

        # Second call: complete
        complete_url = mock_http.post.call_args_list[1][0][0]
        assert "/v1/register/complete" in complete_url

        # Complete body should have required fields
        complete_content = mock_http.post.call_args_list[1][1].get("content") or \
                           mock_http.post.call_args_list[1][0][1] if len(mock_http.post.call_args_list[1][0]) > 1 else None

    def test_register_raises_on_init_failure(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()

        mock_http.post.return_value = make_mock_response({"message": "Server error"}, 500)

        with pytest.raises(BasedAgentsError):
            client.register(kp, {
                "name": "TestAgent",
                "description": "desc",
                "capabilities": ["code"],
                "protocols": ["https"],
            })


# ─── update_profile ───

class TestUpdateProfile:
    def test_sends_put_with_auth_headers(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.put.return_value = make_mock_response(make_agent("UpdatedAgent"))

        client.update_profile(kp, {"name": "UpdatedAgent"})

        mock_http.put.assert_called_once()
        call_kwargs = mock_http.put.call_args[1]
        headers = call_kwargs.get("headers", {})
        assert "Authorization" in headers
        assert headers["Authorization"].startswith("AgentSig ")
        assert "X-Timestamp" in headers

    def test_sends_to_correct_url(self):
        kp = generate_keypair()
        client, mock_http = make_client_with_mock()
        mock_http.put.return_value = make_mock_response(make_agent())

        client.update_profile(kp, {"description": "Updated"})

        call_url = mock_http.put.call_args[0][0]
        assert f"/v1/agents/{kp.agent_id}" in call_url


# ─── BasedAgentsError ───

class TestBasedAgentsError:
    def test_error_has_status_code(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"message": "Unauthorized"}, 401)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.get_agent("ag_test")

        assert exc_info.value.status == 401
        assert "Unauthorized" in str(exc_info.value)

    def test_error_message_from_response(self):
        client, mock_http = make_client_with_mock()
        mock_http.get.return_value = make_mock_response({"message": "Rate limited"}, 429)

        with pytest.raises(BasedAgentsError) as exc_info:
            client.get_agent("ag_test")

        assert exc_info.value.message == "Rate limited"
