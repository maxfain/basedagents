"""
LangChain integration for basedagents.

Introspects a LangChain AgentExecutor (or tool list) and auto-populates
the capabilities and skills fields for registration.

Usage:
    from langchain.agents import AgentExecutor
    from basedagents.integrations.langchain import register_langchain_agent

    agent_id = register_langchain_agent(
        executor,
        name="my-research-agent",
        description="Searches the web and summarizes findings.",
        contact_endpoint="https://my-agent.example.com",
    )
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Avoid hard dep on langchain at import time
    try:
        from langchain.agents import AgentExecutor
        from langchain_core.tools import BaseTool
    except ImportError:
        AgentExecutor = Any  # type: ignore
        BaseTool = Any  # type: ignore


# ── Tool name → PyPI package mapping ──────────────────────────────────────────
# Maps LangChain tool class names and common tool names to their PyPI packages.
_TOOL_TO_PYPI: dict[str, str] = {
    # LangChain core
    "langchain": "langchain",
    "langchainhub": "langchainhub",
    # LLM providers
    "ChatOpenAI": "langchain-openai",
    "OpenAI": "langchain-openai",
    "ChatAnthropic": "langchain-anthropic",
    "ChatGoogleGenerativeAI": "langchain-google-genai",
    "ChatMistralAI": "langchain-mistralai",
    "ChatGroq": "langchain-groq",
    "ChatOllama": "langchain-ollama",
    "ChatCohere": "langchain-cohere",
    # Search tools
    "TavilySearchResults": "langchain-community",
    "DuckDuckGoSearchRun": "langchain-community",
    "GoogleSearchAPIWrapper": "langchain-community",
    "SerpAPIWrapper": "langchain-community",
    "BingSearchAPIWrapper": "langchain-community",
    "BraveSearch": "langchain-community",
    # Code tools
    "PythonREPLTool": "langchain-experimental",
    "ShellTool": "langchain-community",
    # Data / DB
    "SQLDatabaseToolkit": "langchain-community",
    "PandasDataFrameAgent": "langchain-experimental",
    "SparkDataFrameAgent": "langchain-experimental",
    # File tools
    "ReadFileTool": "langchain-community",
    "WriteFileTool": "langchain-community",
    # Vector stores
    "Chroma": "langchain-chroma",
    "FAISS": "langchain-community",
    "Pinecone": "langchain-pinecone",
    "Weaviate": "langchain-weaviate",
    # Memory
    "ConversationBufferMemory": "langchain",
    "ConversationSummaryMemory": "langchain",
    # Agents SDK
    "create_react_agent": "langchain",
    "create_openai_tools_agent": "langchain",
    "AgentExecutor": "langchain",
}

# ── Tool name → capabilities mapping ─────────────────────────────────────────
_TOOL_TO_CAPABILITIES: dict[str, list[str]] = {
    "TavilySearchResults": ["web-search"],
    "DuckDuckGoSearchRun": ["web-search"],
    "GoogleSearchAPIWrapper": ["web-search"],
    "SerpAPIWrapper": ["web-search"],
    "BingSearchAPIWrapper": ["web-search"],
    "BraveSearch": ["web-search"],
    "PythonREPLTool": ["code"],
    "ShellTool": ["code", "system"],
    "SQLDatabaseToolkit": ["data-analysis", "sql"],
    "PandasDataFrameAgent": ["data-analysis"],
    "ReadFileTool": ["file-access"],
    "WriteFileTool": ["file-access"],
    "WikipediaQueryRun": ["web-search", "knowledge"],
    "ArxivQueryRun": ["web-search", "knowledge"],
    "HumanInputRun": ["human-in-the-loop"],
    "RequestsGetTool": ["http"],
    "RequestsPostTool": ["http"],
}


def _extract_tools(agent_or_tools: Any) -> list[Any]:
    """Extract tool list from AgentExecutor or raw list."""
    if isinstance(agent_or_tools, list):
        return agent_or_tools
    # AgentExecutor has .tools attribute
    tools = getattr(agent_or_tools, "tools", None)
    if tools is not None:
        return list(tools)
    return []


def extract_profile(
    agent_or_tools: Any,
    extra_capabilities: list[str] | None = None,
    extra_skills: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """
    Introspect a LangChain AgentExecutor or tool list and return a partial
    profile dict with auto-detected capabilities and skills.

    You can merge this with your own fields:
        profile = extract_profile(agent, extra_capabilities=["reasoning"])
        profile.update({"name": "MyAgent", "description": "..."})
    """
    tools = _extract_tools(agent_or_tools)
    capabilities: set[str] = set(extra_capabilities or [])
    skills_seen: set[str] = set()
    skills: list[dict[str, str]] = list(extra_skills or [])

    # Always include base langchain skill
    if tools and "langchain" not in skills_seen:
        skills.append({"name": "langchain", "registry": "pypi"})
        skills_seen.add("langchain")

    for tool in tools:
        cls_name = type(tool).__name__
        tool_name = getattr(tool, "name", cls_name)

        # Capabilities
        for key in (cls_name, tool_name):
            for cap in _TOOL_TO_CAPABILITIES.get(key, []):
                capabilities.add(cap)

        # Skills — prefer class name lookup, fall back to tool name
        pkg = _TOOL_TO_PYPI.get(cls_name) or _TOOL_TO_PYPI.get(tool_name)
        if pkg and pkg not in skills_seen:
            skills.append({"name": pkg, "registry": "pypi"})
            skills_seen.add(pkg)

    # Detect LLM package from agent if available
    llm = getattr(agent_or_tools, "agent", None)
    if llm:
        llm_obj = getattr(llm, "llm", None) or getattr(llm, "llm_chain", None)
        if llm_obj:
            llm_cls = type(llm_obj).__name__
            pkg = _TOOL_TO_PYPI.get(llm_cls)
            if pkg and pkg not in skills_seen:
                skills.append({"name": pkg, "registry": "pypi"})
                skills_seen.add(pkg)

    return {
        "capabilities": sorted(capabilities),
        "protocols": ["https"],
        "skills": skills,
    }


def register_langchain_agent(
    agent_or_tools: Any,
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
    Register a LangChain agent with basedagents.ai.

    Introspects the agent's tools to auto-detect capabilities and skills.
    Idempotent — safe to call on every startup.

    Args:
        agent_or_tools: LangChain AgentExecutor or list of BaseTool
        name: Unique agent name
        description: What the agent does
        contact_endpoint: URL where the agent can be reached for verification
        organization: Optional org name
        version: Optional version string
        tags: Optional tags (e.g. ["langchain", "research"])
        extra_capabilities: Additional capabilities beyond auto-detected ones
        extra_skills: Additional skills beyond auto-detected ones
        keypair_path: Override keypair file location
        api_url: Override API URL (defaults to BASEDAGENTS_API env or prod)
        verbose: Print progress (default True)

    Returns:
        agent_id string
    """
    from ..easy import register_or_load

    profile = extract_profile(agent_or_tools, extra_capabilities, extra_skills)

    # Add "langchain" tag automatically
    merged_tags = list(set(["langchain"] + (tags or [])))

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
