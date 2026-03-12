"""
AutoGen integration for basedagents.

Introspects an AutoGen ConversableAgent, AssistantAgent, or GroupChat and
auto-populates capabilities and skills for registration.

Usage:
    from autogen import AssistantAgent, GroupChat
    from basedagents.integrations.autogen import register_autogen_agent

    # Single agent
    agent_id = register_autogen_agent(
        assistant,
        name="my-autogen-assistant",
        description="Writes and executes Python code.",
    )

    # GroupChat (multi-agent)
    agent_id = register_autogen_agent(
        groupchat,
        name="my-autogen-group",
        description="Research + coding multi-agent system.",
    )
"""
from __future__ import annotations

from typing import Any


# ── Known AutoGen agent class names → capabilities ────────────────────────────
_AGENT_CLASS_CAPABILITIES: dict[str, list[str]] = {
    "AssistantAgent": ["reasoning", "code"],
    "UserProxyAgent": ["code"],             # executes code by default
    "GPTAssistantAgent": ["reasoning", "code"],
    "RetrieveAssistantAgent": ["reasoning", "knowledge"],
    "RetrieveUserProxyAgent": ["knowledge"],
    "MathUserProxyAgent": ["reasoning"],
    "TeachableAgent": ["reasoning", "knowledge"],
    "CompressibleAgent": ["reasoning"],
    "TransformMessages": ["reasoning"],
    "WebSurferAgent": ["web-search", "web-scraping"],
    "MultimodalConversableAgent": ["vision", "reasoning"],
}

# ── Code execution detection ──────────────────────────────────────────────────
_CODE_EXEC_CLASSES = {"UserProxyAgent", "GPTAssistantAgent"}


def _collect_agents(agent_or_group: Any) -> list[Any]:
    """Extract agents from GroupChat, GroupChatManager, or return single agent."""
    # GroupChat has .agents
    agents = getattr(agent_or_group, "agents", None)
    if agents:
        return list(agents)
    # GroupChatManager has .groupchat.agents
    gc = getattr(agent_or_group, "groupchat", None)
    if gc:
        return list(getattr(gc, "agents", []) or [])
    # Single agent
    return [agent_or_group]


def _is_multi_agent(agent_or_group: Any) -> bool:
    return len(_collect_agents(agent_or_group)) > 1


def _agent_executes_code(agent: Any) -> bool:
    """Check if an agent is configured to execute code."""
    cls = type(agent).__name__
    if cls in _CODE_EXEC_CLASSES:
        return True
    # human_input_mode="NEVER" + code_execution_config set = code executor
    code_cfg = getattr(agent, "code_execution_config", None)
    if code_cfg and code_cfg is not False:
        return True
    return False


def _detect_llm_skill(agent: Any) -> str | None:
    """Try to detect LLM provider package from llm_config."""
    llm_config = getattr(agent, "llm_config", None) or {}
    if not isinstance(llm_config, dict):
        return None
    model = llm_config.get("model", "") or ""
    config_list = llm_config.get("config_list", [{}])
    if config_list:
        model = model or config_list[0].get("model", "")
    model = model.lower()
    if "gpt" in model or "o1" in model or "o3" in model:
        return "pyautogen"
    if "claude" in model:
        return "pyautogen"
    if "gemini" in model:
        return "pyautogen"
    return "pyautogen"  # always include base pyautogen


def extract_profile(
    agent_or_group: Any,
    extra_capabilities: list[str] | None = None,
    extra_skills: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """
    Introspect an AutoGen agent or GroupChat and return a partial profile dict
    with auto-detected capabilities and skills.
    """
    agents = _collect_agents(agent_or_group)
    capabilities: set[str] = set(extra_capabilities or [])
    skills_seen: set[str] = set()
    skills: list[dict[str, str]] = list(extra_skills or [])

    # Base skill
    skills.append({"name": "pyautogen", "registry": "pypi"})
    skills_seen.add("pyautogen")

    if _is_multi_agent(agent_or_group):
        capabilities.add("multi-agent")

    for agent in agents:
        cls_name = type(agent).__name__

        for cap in _AGENT_CLASS_CAPABILITIES.get(cls_name, []):
            capabilities.add(cap)

        if _agent_executes_code(agent):
            capabilities.add("code")

        # Detect function/tool calling
        fn_map = getattr(agent, "function_map", None) or {}
        if fn_map:
            capabilities.add("tool-use")

        # Detect retrieval augmentation
        retrieve_config = getattr(agent, "retrieve_config", None)
        if retrieve_config:
            capabilities.add("knowledge")

        # Extra skill from LLM config
        pkg = _detect_llm_skill(agent)
        if pkg and pkg not in skills_seen:
            skills.append({"name": pkg, "registry": "pypi"})
            skills_seen.add(pkg)

    # Fallback capability
    if not capabilities:
        capabilities.add("reasoning")

    return {
        "capabilities": sorted(capabilities),
        "protocols": ["https"],
        "skills": skills,
    }


def register_autogen_agent(
    agent_or_group: Any,
    name: str,
    description: str = "",
    contact_endpoint: str | None = None,
    organization: str | None = None,
    version: str | None = None,
    tags: list[str] | None = None,
    extra_capabilities: list[str] | None = None,
    extra_skills: list[dict[str, str]] | None = None,
    keypair_path: str | None = None,
    api_url: str | None = None,
    verbose: bool = True,
) -> str:
    """
    Register an AutoGen agent or GroupChat with basedagents.ai.

    Introspects the agent to auto-detect capabilities and skills.
    Idempotent — safe to call on every startup.

    Args:
        agent_or_group: AutoGen ConversableAgent, AssistantAgent, UserProxyAgent,
                        GroupChat, or GroupChatManager
        name: Unique agent name (globally unique on registry)
        description: What this agent/group does
        contact_endpoint: URL where the agent can be reached for verification
        organization: Optional org name
        version: Optional version string
        tags: Optional extra tags
        extra_capabilities: Additional capabilities beyond auto-detected ones
        extra_skills: Additional skills beyond auto-detected ones
        keypair_path: Override keypair file location
        api_url: Override API URL (defaults to BASEDAGENTS_API env or prod)
        verbose: Print progress (default True)

    Returns:
        agent_id string

    Example:
        import autogen
        from basedagents.integrations.autogen import register_autogen_agent

        assistant = autogen.AssistantAgent("assistant", llm_config={"model": "gpt-4o"})
        user_proxy = autogen.UserProxyAgent("user_proxy", code_execution_config={"work_dir": "."})

        agent_id = register_autogen_agent(
            assistant,
            name="my-autogen-assistant",
            description="Writes and debugs Python code via GPT-4o.",
        )
    """
    from ..easy import register_or_load

    profile = extract_profile(agent_or_group, extra_capabilities, extra_skills)
    merged_tags = list(set(["autogen"] + (tags or [])))

    return register_or_load(
        name=name,
        description=description,
        capabilities=profile["capabilities"],
        protocols=profile["protocols"],
        skills=profile["skills"],
        contact_endpoint=contact_endpoint,
        organization=organization,
        version=version,
        tags=merged_tags,
        keypair_path=keypair_path,
        api_url=api_url,
        verbose=verbose,
    )
