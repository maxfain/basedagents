"""
CrewAI integration for basedagents.

Introspects a CrewAI Crew or Agent and auto-populates capabilities and skills
for registration.

Usage:
    from crewai import Crew, Agent
    from basedagents.integrations.crewai import register_crewai_agent

    # Register from a Crew (uses all agents' tools)
    agent_id = register_crewai_agent(
        crew,
        name="my-research-crew",
        description="Multi-agent crew for research and analysis.",
    )

    # Or register a single CrewAI Agent
    agent_id = register_crewai_agent(
        agent,
        name="my-researcher",
        description="Searches and summarises the web.",
    )
"""
from __future__ import annotations

from typing import Any


# ── Tool name → capabilities mapping ─────────────────────────────────────────
_TOOL_TO_CAPABILITIES: dict[str, list[str]] = {
    # Search
    "SerperDevTool": ["web-search"],
    "TavilySearchTool": ["web-search"],
    "EXASearchTool": ["web-search"],
    "BraveSearchTool": ["web-search"],
    "DuckDuckGoSearchTool": ["web-search"],
    "GoogleSearchTool": ["web-search"],
    "ScrapeWebsiteTool": ["web-scraping"],
    "SeleniumScrapingTool": ["web-scraping"],
    "ScrapeElementFromWebsiteTool": ["web-scraping"],
    "WebsiteSearchTool": ["web-search", "web-scraping"],
    # Code
    "CodeDocsSearchTool": ["code", "knowledge"],
    "CodeInterpreterTool": ["code"],
    "GithubSearchTool": ["code", "web-search"],
    # Files
    "FileReadTool": ["file-access"],
    "FileWriterTool": ["file-access"],
    "DirectoryReadTool": ["file-access"],
    "DirectorySearchTool": ["file-access"],
    "PDFSearchTool": ["file-access", "knowledge"],
    "DOCXSearchTool": ["file-access", "knowledge"],
    "CSVSearchTool": ["file-access", "data-analysis"],
    "JSONSearchTool": ["file-access"],
    "TXTSearchTool": ["file-access"],
    "XMLSearchTool": ["file-access"],
    "SpreadsheetSearchTool": ["file-access", "data-analysis"],
    # Data
    "PGSearchTool": ["data-analysis", "sql"],
    "MySQLSearchTool": ["data-analysis", "sql"],
    "NL2SQLTool": ["data-analysis", "sql"],
    # Knowledge / RAG
    "RagTool": ["knowledge"],
    "YoutubeVideoSearchTool": ["knowledge"],
    "YoutubeChannelSearchTool": ["knowledge"],
    "MDXSearchTool": ["knowledge"],
    # Comms
    "BrowserbaseTool": ["web-scraping"],
    "MultiOnTool": ["web-scraping"],
    # Vision
    "VisionTool": ["vision"],
}

# ── Tool name → PyPI package ──────────────────────────────────────────────────
_TOOL_TO_PYPI: dict[str, str] = {
    "SerperDevTool": "crewai-tools",
    "TavilySearchTool": "crewai-tools",
    "EXASearchTool": "crewai-tools",
    "BraveSearchTool": "crewai-tools",
    "DuckDuckGoSearchTool": "crewai-tools",
    "ScrapeWebsiteTool": "crewai-tools",
    "SeleniumScrapingTool": "crewai-tools",
    "WebsiteSearchTool": "crewai-tools",
    "CodeDocsSearchTool": "crewai-tools",
    "CodeInterpreterTool": "crewai-tools",
    "GithubSearchTool": "crewai-tools",
    "FileReadTool": "crewai-tools",
    "FileWriterTool": "crewai-tools",
    "DirectoryReadTool": "crewai-tools",
    "PDFSearchTool": "crewai-tools",
    "DOCXSearchTool": "crewai-tools",
    "CSVSearchTool": "crewai-tools",
    "PGSearchTool": "crewai-tools",
    "NL2SQLTool": "crewai-tools",
    "RagTool": "crewai-tools",
    "YoutubeVideoSearchTool": "crewai-tools",
    "VisionTool": "crewai-tools",
}


def _collect_tools(crew_or_agent: Any) -> list[Any]:
    """Extract all tools from a Crew or single Agent."""
    tools: list[Any] = []

    # Single Agent: has .tools
    if hasattr(crew_or_agent, "tools") and not hasattr(crew_or_agent, "agents"):
        return list(getattr(crew_or_agent, "tools", []) or [])

    # Crew: has .agents, each with .tools
    agents = getattr(crew_or_agent, "agents", []) or []
    for agent in agents:
        tools.extend(list(getattr(agent, "tools", []) or []))

    return tools


def _is_multi_agent(crew_or_agent: Any) -> bool:
    agents = getattr(crew_or_agent, "agents", None)
    return bool(agents and len(agents) > 1)


def extract_profile(
    crew_or_agent: Any,
    extra_capabilities: list[str] | None = None,
    extra_skills: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """
    Introspect a CrewAI Crew or Agent and return a partial profile dict
    with auto-detected capabilities and skills.
    """
    tools = _collect_tools(crew_or_agent)
    capabilities: set[str] = set(extra_capabilities or [])
    skills_seen: set[str] = set()
    skills: list[dict[str, str]] = list(extra_skills or [])

    # Always add crewai base skill
    skills.append({"name": "crewai", "registry": "pypi"})
    skills_seen.add("crewai")

    # Multi-agent crews get the orchestration capability
    if _is_multi_agent(crew_or_agent):
        capabilities.add("multi-agent")

    for tool in tools:
        cls_name = type(tool).__name__
        tool_name = getattr(tool, "name", cls_name)

        for key in (cls_name, tool_name):
            for cap in _TOOL_TO_CAPABILITIES.get(key, []):
                capabilities.add(cap)

        pkg = _TOOL_TO_PYPI.get(cls_name) or _TOOL_TO_PYPI.get(tool_name)
        if pkg and pkg not in skills_seen:
            skills.append({"name": pkg, "registry": "pypi"})
            skills_seen.add(pkg)

    # Detect LLM provider
    llm = getattr(crew_or_agent, "llm", None)
    if llm is None:
        # Try first agent's LLM
        agents = getattr(crew_or_agent, "agents", []) or []
        if agents:
            llm = getattr(agents[0], "llm", None)
    if llm:
        cls_name = type(llm).__name__
        _LLM_TO_PYPI = {
            "ChatOpenAI": "langchain-openai",
            "ChatAnthropic": "langchain-anthropic",
            "ChatGoogleGenerativeAI": "langchain-google-genai",
            "ChatGroq": "langchain-groq",
        }
        pkg = _LLM_TO_PYPI.get(cls_name)
        if pkg and pkg not in skills_seen:
            skills.append({"name": pkg, "registry": "pypi"})
            skills_seen.add(pkg)

    return {
        "capabilities": sorted(capabilities) if capabilities else ["reasoning"],
        "protocols": ["https"],
        "skills": skills,
    }


def register_crewai_agent(
    crew_or_agent: Any,
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
    Register a CrewAI Crew or Agent with basedagents.ai.

    Introspects tools to auto-detect capabilities and skills.
    Idempotent — safe to call on every startup.

    Args:
        crew_or_agent: CrewAI Crew or Agent instance
        name: Unique agent name (globally unique on registry)
        description: What this crew/agent does
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
        from crewai import Crew
        from basedagents.integrations.crewai import register_crewai_agent

        crew = Crew(agents=[researcher, writer], tasks=[...])
        agent_id = register_crewai_agent(
            crew,
            name="my-research-crew",
            description="Research and write blog posts.",
        )
    """
    from ..easy import register_or_load

    profile = extract_profile(crew_or_agent, extra_capabilities, extra_skills)
    merged_tags = list(set(["crewai"] + (tags or [])))

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
