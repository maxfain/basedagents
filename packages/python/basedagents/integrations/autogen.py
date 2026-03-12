"""
AutoGen integration for basedagents.

Supports both AutoGen 0.2.x (pyautogen) and 0.4.x (autogen-agentchat).
Introspects an AssistantAgent, ConversableAgent, or GroupChat and
auto-populates capabilities and skills for registration.

Usage (AutoGen 0.4.x):
    from autogen_agentchat.agents import AssistantAgent
    from basedagents.integrations.autogen import register_autogen_agent

    agent = AssistantAgent(
        name="assistant",
        model_client=OpenAIChatCompletionClient(model="gpt-4o"),
        tools=[get_weather, search_web],
    )

    agent_id = register_autogen_agent(
        agent,
        name="my-assistant",
        description="Answers questions using web search and weather tools.",
    )

Usage (AutoGen 0.2.x):
    from autogen import AssistantAgent
    from basedagents.integrations.autogen import register_autogen_agent

    assistant = AssistantAgent(
        name="assistant",
        llm_config={"model": "gpt-4"},
    )

    agent_id = register_autogen_agent(
        assistant,
        name="my-assistant",
        description="Coding assistant.",
    )
"""
from __future__ import annotations

from typing import Any


# ── Model → PyPI package mapping ─────────────────────────────────────────────
_MODEL_TO_PYPI: dict[str, str] = {
    "gpt": "autogen-ext[openai]",
    "o1": "autogen-ext[openai]",
    "o3": "autogen-ext[openai]",
    "claude": "autogen-ext[anthropic]",
    "gemini": "autogen-ext[google]",
    "mistral": "autogen-ext[mistral]",
    "llama": "autogen-ext[ollama]",
    "groq": "autogen-ext[groq]",
}

# ── Tool/function name → capabilities ─────────────────────────────────────────
_TOOL_NAME_CAPABILITIES: dict[str, list[str]] = {
    "search": ["web-search"],
    "web": ["web-search"],
    "browse": ["web-search"],
    "weather": ["web-search"],
    "code": ["code"],
    "execute": ["code"],
    "run": ["code"],
    "python": ["code"],
    "shell": ["code", "system"],
    "bash": ["code", "system"],
    "file": ["file-access"],
    "read": ["file-access"],
    "write": ["file-access"],
    "sql": ["sql"],
    "database": ["sql"],
    "db": ["sql"],
    "data": ["data-analysis"],
    "analyze": ["data-analysis"],
    "chart": ["data-analysis"],
    "plot": ["data-analysis"],
    "image": ["vision"],
    "vision": ["vision"],
    "ocr": ["vision"],
    "email": ["http"],
    "http": ["http"],
    "api": ["http"],
    "fetch": ["http"],
}

# ── System message keywords → capabilities ────────────────────────────────────
_SYSTEM_MSG_CAPABILITIES: dict[str, list[str]] = {
    "code": ["code"],
    "program": ["code"],
    "python": ["code"],
    "sql": ["sql"],
    "database": ["sql"],
    "search": ["web-search"],
    "research": ["web-search", "reasoning"],
    "analyze": ["data-analysis"],
    "data": ["data-analysis"],
    "write": ["reasoning"],
    "summarize": ["reasoning"],
    "plan": ["reasoning"],
    "reason": ["reasoning"],
}


def _detect_autogen_version(agent: Any) -> str:
    """Detect whether this is 0.2.x or 0.4.x AutoGen."""
    module = type(agent).__module__ or ""
    if "autogen_agentchat" in module or "autogen_core" in module:
        return "0.4"
    return "0.2"


def _extract_tools_04(agent: Any) -> list[Any]:
    """Extract tools from AutoGen 0.4.x agent."""
    # AssistantAgent stores tools in _tools or tools attribute
    tools = getattr(agent, "_tools", None) or getattr(agent, "tools", None) or []
    if callable(tools):
        try:
            tools = tools()
        except Exception:
            tools = []
    return list(tools)


def _extract_tools_02(agent: Any) -> list[str]:
    """Extract registered function names from AutoGen 0.2.x agent."""
    # function_map is a dict of name → callable
    function_map = getattr(agent, "function_map", {}) or {}
    return list(function_map.keys())


def _capabilities_from_tool_names(names: list[str]) -> set[str]:
    caps: set[str] = set()
    for name in names:
        name_lower = name.lower()
        for keyword, tool_caps in _TOOL_NAME_CAPABILITIES.items():
            if keyword in name_lower:
                caps.update(tool_caps)
    return caps


def _capabilities_from_system_message(agent: Any) -> set[str]:
    caps: set[str] = set()
    msg = (
        getattr(agent, "system_message", "")
        or getattr(agent, "_system_messages", "")
        or ""
    )
    if isinstance(msg, list):
        msg = " ".join(str(m) for m in msg)
    msg_lower = str(msg).lower()
    for keyword, kw_caps in _SYSTEM_MSG_CAPABILITIES.items():
        if keyword in msg_lower:
            caps.update(kw_caps)
    return caps


def _model_skill(agent: Any) -> str | None:
    """Detect the model package from llm_config or model_client."""
    # 0.4.x: model_client attribute
    model_client = getattr(agent, "_model_client", None) or getattr(agent, "model_client", None)
    if model_client:
        cls_name = type(model_client).__name__.lower()
        for keyword, pkg in _MODEL_TO_PYPI.items():
            if keyword in cls_name:
                return pkg
        return "autogen-ext"

    # 0.2.x: llm_config dict
    llm_config = getattr(agent, "llm_config", {}) or {}
    if isinstance(llm_config, dict):
        model = llm_config.get("model", "") or ""
        for keyword, pkg in _MODEL_TO_PYPI.items():
            if model.lower().startswith(keyword):
                return pkg

    return None


def _is_groupchat(agent: Any) -> bool:
    cls_name = type(agent).__name__
    return "GroupChat" in cls_name or "GroupChatManager" in cls_name


def extract_profile(
    agent: Any,
    extra_capabilities: list[str] | None = None,
    extra_skills: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """
    Introspect an AutoGen agent or GroupChat and return a partial profile dict
    with auto-detected capabilities and skills.
    """
    version = _detect_autogen_version(agent)
    capabilities: set[str] = set(extra_capabilities or [])
    capabilities.add("reasoning")  # all LLM agents reason

    skills_seen: set[str] = set()
    skills: list[dict[str, str]] = list(extra_skills or [])

    # Base package
    base_pkg = "autogen-agentchat" if version == "0.4" else "pyautogen"
    skills.append({"name": base_pkg, "registry": "pypi"})
    skills_seen.add(base_pkg)

    # GroupChat: aggregate tools/capabilities across all agents
    if _is_groupchat(agent):
        inner_agents = getattr(agent, "agents", []) or []
        for a in inner_agents:
            sub = extract_profile(a)
            capabilities.update(sub["capabilities"])
            for s in sub["skills"]:
                if s["name"] not in skills_seen:
                    skills.append(s)
                    skills_seen.add(s["name"])
        return {
            "capabilities": sorted(capabilities),
            "protocols": ["https"],
            "skills": skills,
        }

    # Tools
    if version == "0.4":
        tools = _extract_tools_04(agent)
        tool_names = []
        for t in tools:
            n = getattr(t, "name", None) or getattr(t, "__name__", None) or type(t).__name__
            tool_names.append(n)
        capabilities.update(_capabilities_from_tool_names(tool_names))
    else:
        func_names = _extract_tools_02(agent)
        capabilities.update(_capabilities_from_tool_names(func_names))

    # System message heuristics
    capabilities.update(_capabilities_from_system_message(agent))

    # Model skill
    model_pkg = _model_skill(agent)
    if model_pkg and model_pkg not in skills_seen:
        skills.append({"name": model_pkg, "registry": "pypi"})
        skills_seen.add(model_pkg)

    return {
        "capabilities": sorted(capabilities),
        "protocols": ["https"],
        "skills": skills,
    }


def register_autogen_agent(
    agent: Any,
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
    Register an AutoGen agent with basedagents.ai.

    Supports AutoGen 0.2.x (pyautogen) and 0.4.x (autogen-agentchat).
    Introspects the agent to auto-detect capabilities and skills.
    Idempotent — safe to call on every startup.

    Args:
        agent: AutoGen AssistantAgent, ConversableAgent, or GroupChat
        name: Unique agent name
        description: What the agent does
        contact_endpoint: URL where the agent can be reached
        organization: Optional org name
        version: Optional version string
        tags: Optional tags (e.g. ["autogen", "coding"])
        extra_capabilities: Additional capabilities beyond auto-detected
        extra_skills: Additional skills beyond auto-detected
        keypair_path: Override keypair file location
        api_url: Override API URL (defaults to BASEDAGENTS_API env or prod)
        verbose: Print progress (default True)

    Returns:
        agent_id string
    """
    from ..easy import register_or_load

    profile = extract_profile(agent, extra_capabilities, extra_skills)
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
