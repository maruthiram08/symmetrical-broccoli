#!/bin/zsh
# npm run mcp:install : prints how to add the Daily brief MCP server to Claude Desktop and Claude Code.
# It only prints. It never edits a config file; copy what you need.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NPM="$(command -v npm || true)"
if [[ -z "$NPM" ]]; then
  echo "npm not found on PATH. Install Node.js first." >&2
  exit 1
fi
NODE_BIN="$(dirname "$(command -v node)")"
DATA="${DAILY_BRIEF_DIR:-$HOME/Daily Brief}"

json_str() { # JSON-escape a string (backslash and double quote)
  local s="${1//\\/\\\\}"
  print -r -- "\"${s//\"/\\\"}\""
}

ENV_LINES="        \"PATH\": $(json_str "$NODE_BIN:/usr/bin:/bin")"
if [[ -n "$DAILY_BRIEF_DIR" ]]; then
  ENV_LINES="$ENV_LINES,
        \"DAILY_BRIEF_DIR\": $(json_str "$DAILY_BRIEF_DIR")"
fi

cat <<EOF
Daily brief MCP server
  repo: $DIR
  data: $DATA/.daily-brief/state.json

1) Claude Desktop
   Open ~/Library/Application Support/Claude/claude_desktop_config.json
   (Claude > Settings > Developer > Edit Config) and add this under "mcpServers"
   (merge with any servers already there), then restart Claude Desktop:

{
  "mcpServers": {
    "daily-brief": {
      "command": $(json_str "$NPM"),
      "args": ["--prefix", $(json_str "$DIR"), "run", "-s", "mcp"],
      "env": {
$ENV_LINES
      }
    }
  }
}

2) Claude Code
   Run:

claude mcp add daily-brief${DAILY_BRIEF_DIR:+ -e DAILY_BRIEF_DIR=${(q)DAILY_BRIEF_DIR}} -- npm --prefix ${(q)DIR} run -s mcp

   Add --scope user (before the --) to have it in every project.

Then ask: "what do I owe Tarun?", "what did we decide about the dividend banner?", "mark that done".
Nothing was changed on this Mac.
EOF
