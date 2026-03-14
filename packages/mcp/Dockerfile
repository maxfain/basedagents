FROM node:22-slim

WORKDIR /app

# Install the MCP server from npm
RUN npm install -g @basedagents/mcp@latest

# Environment variables for authenticated operations (optional)
# BASEDAGENTS_KEYPAIR_PATH - path to keypair JSON file
# BASEDAGENTS_API_URL - API endpoint (default: https://api.basedagents.ai)

# Run via stdio transport (MCP standard)
ENTRYPOINT ["basedagents-mcp"]
