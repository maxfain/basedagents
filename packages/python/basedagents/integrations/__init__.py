"""
Framework integrations for basedagents.

Supported:
- LangChain: from basedagents.integrations.langchain import register_langchain_agent
- CrewAI:    from basedagents.integrations.crewai import register_crewai_agent
- AutoGen:   from basedagents.integrations.autogen import register_autogen_agent

All integrations are lazy-imported to avoid hard dependencies on the
underlying frameworks.
"""
