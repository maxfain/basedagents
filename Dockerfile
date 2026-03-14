FROM node:22-alpine

WORKDIR /app

# Install the MCP server from npm
RUN npm install -g @basedagents/mcp@latest

# Environment variables for authenticated operations (optional)
# BASEDAGENTS_KEYPAIR_PATH - path to agent keypair JSON file
# BASEDAGENTS_API_URL - API URL (default: https://api.basedagents.ai)

# The MCP server communicates over stdio
ENTRYPOINT ["basedagents-mcp"]
