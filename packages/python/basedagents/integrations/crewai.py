"""
CrewAI integration for basedagents.

Introspects a CrewAI Agent or Crew and auto-populates capabilities and skills
for registration.

Usage (single agent):
    from crewai import Agent
    from basedagents.integrations.crewai import register_crewai_agent

    researcher = Agent(
        role="Researcher",
        goal="Find and summarize information",
        tools=[TavilySearchResults()],
    )

    agent_id = register_crewai_agent(
        researcher,
        name="my-researcher",
        description="Searches the web and summarizes findings.",
    )

Usage (whole crew):
    from crewai import Crew
    from basedagents.integrations.crewai import register_crewai_agent

    crew = Crew(agents=[researcher, writer], tasks=[...])
    agent_id = register_crewai_agent(crew, name="my-crew", description="...")
"""
from __future__ import annotations

from typing import Any


# ── Tool → capability mapping ─────────────────────────────────────────────────
_TOOL_TO_CAPABILITIES: dict[str, list[str]] = {
    # Search
    "TavilySearchResults": ["web-search"],
    "DuckDuckGoSearchRun": ["web-search"],
    "SerperDevTool": ["web-search"],
    "SerpAPIWrapper": ["web-search"],
    "BraveSearch": ["web-search"],
    "WebsiteSearchTool": ["web-search"],
    "ScrapeWebsiteTool": ["web-search"],
    # Code
    "CodeInterpreterTool": ["code"],
    "PythonREPLTool": ["code"],
    "ShellTool": ["code", "system"],
    "CodeDocsSearchTool": ["code"],
    # Files
    "FileReadTool": ["file-access"],
    "FileWriterTool": ["file-access"],
    "DirectoryReadTool": ["file-access"],
    "DirectorySearchTool": ["file-access"],
    # Data
    "CSVSearchTool": ["data-analysis"],
    "JSONSearchTool": ["data-analysis"],
    "XMLSearchTool": ["data-analysis"],
    "PDFSearchTool": ["data-analysis"],
    # Database
    "PGSearchTool": ["sql"],
    "MySQLSearchTool": ["sql"],
    # Knowledge / docs
    "YoutubeVideoSearchTool": ["knowledge"],
    "YoutubeChannelSearchTool": ["knowledge"],
    "GithubSearchTool": ["knowledge"],
    "MDXSearchTool": ["knowledge"],
    "DOCXSearchTool": ["knowledge"],
    # Reasoning (always present with LLM-powered agents)
    "Agent": ["reasoning"],
}

# ── Tool → PyPI package mapping ───────────────────────────────────────────────
_TOOL_TO_PYPI: dict[str, str] = {
    "TavilySearchResults": "langchain-community",
    "DuckDuckGoSearchRun": "langchain-community",
    "SerperDevTool": "crewai-tools",
    "ScrapeWebsiteTool": "crewai-tools",
    "WebsiteSearchTool": "crewai-tools",
    "FileReadTool": "crewai-tools",
    "FileWriterTool": "crewai-tools",
    "DirectoryReadTool": "crewai-tools",
    "DirectorySearchTool": "crewai-tools",
    "CodeInterpreterTool": "crewai-tools",
    "CSVSearchTool": "crewai-tools",
    "JSONSearchTool": "crewai-tools",
    "PDFSearchTool": "crewai-tools",
    "GithubSearchTool": "crewai-tools",
    "PythonREPLTool": "langchain-experimental",
    "ShellTool": "langchain-community",
}

# Role keywords → capabilities
_ROLE_TO_CAPABILITIES: dict[str, list[str]] = {
    "research": ["web-search", "reasoning"],
    "researcher": ["web-search", "reasoning"],
    "writer": ["reasoning"],
    "analyst": ["data-analysis", "reasoning"],
    "coder": ["code", "reasoning"],
    "developer": ["code", "reasoning"],
    "engineer": ["code", "reasoning"],
    "data": ["data-analysis"],
    "sql": ["sql"],
    "search": ["web-search"],
}


def _collect_tools(agent_or_crew: Any) -> list[Any]:
    """Extract all tools from an Agent or Crew."""
    tools: list[Any] = []

    # Crew: aggregate tools from all agents
    agents = getattr(agent_or_crew, "agents", None)
    if agents:
        for agent in agents:
            tools.extend(getattr(agent, "tools", []) or [])
        return tools

    # Single Agent
    return list(getattr(agent_or_crew, "tools", []) or [])


def _role_capabilities(agent_or_crew: Any) -> list[str]:
    """Infer capabilities from agent role string."""
    caps: set[str] = set()

    agents = getattr(agent_or_crew, "agents", None)
    roles = []
    if agents:
        for a in agents:
            role = getattr(a, "role", "") or ""
            roles.append(role.lower())
    else:
        role = getattr(agent_or_crew, "role", "") or ""
        roles.append(role.lower())

    for role in roles:
        for keyword, role_caps in _ROLE_TO_CAPABILITIES.items():
            if keyword in role:
                caps.update(role_caps)

    return list(caps)


def extract_profile(
    agent_or_crew: Any,
    extra_capabilities: list[str] | None = None,
    extra_skills: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """
    Introspect a CrewAI Agent or Crew and return a partial profile dict
    with auto-detected capabilities and skills.
    """
    tools = _collect_tools(agent_or_crew)
    capabilities: set[str] = set(extra_capabilities or [])
    capabilities.update(_role_capabilities(agent_or_crew))
    capabilities.add("reasoning")  # all LLM agents reason

    skills_seen: set[str] = set()
    skills: list[dict[str, str]] = list(extra_skills or [])

    # Always include crewai base skill
    skills.append({"name": "crewai", "registry": "pypi"})
    skills_seen.add("crewai")

    for tool in tools:
        cls_name = type(tool).__name__
        tool_name = getattr(tool, "name", cls_name)

        for key in (cls_name, tool_name):
            for cap in _TOOL_TO_CAPABILITIES.get(key, []):
                capabilities.add(cap)
            pkg = _TOOL_TO_PYPI.get(key)
            if pkg and pkg not in skills_seen:
                skills.append({"name": pkg, "registry": "pypi"})
                skills_seen.add(pkg)

    return {
        "capabilities": sorted(capabilities),
        "protocols": ["https"],
        "skills": skills,
    }


def register_crewai_agent(
    agent_or_crew: Any,
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
    Register a CrewAI Agent or Crew with basedagents.ai.

    Introspects the agent/crew to auto-detect capabilities and skills.
    Idempotent — safe to call on every startup.

    Args:
        agent_or_crew: CrewAI Agent or Crew instance
        name: Unique agent name
        description: What the agent does
        contact_endpoint: URL where the agent can be reached
        organization: Optional org name
        version: Optional version string
        tags: Optional tags (e.g. ["crewai", "research"])
        extra_capabilities: Additional capabilities beyond auto-detected
        extra_skills: Additional skills beyond auto-detected
        keypair_path: Override keypair file location
        api_url: Override API URL (defaults to BASEDAGENTS_API env or prod)
        verbose: Print progress (default True)

    Returns:
        agent_id string
    """
    from ..easy import register_or_load

    profile = extract_profile(agent_or_crew, extra_capabilities, extra_skills)
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
