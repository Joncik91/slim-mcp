#!/bin/bash
# slim-mcp Manual Smoke Test — Setup & Revert
#
# Sets up Claude Code to use slim-mcp as its MCP proxy for manual testing.
# Backs up everything, reverts cleanly on --revert.
#
# Usage:
#   bash scripts/smoke-test.sh            # Setup
#   bash scripts/smoke-test.sh --revert   # Revert to original config
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SLIM_CONFIG="$HOME/.slim-mcp-smoke-test.json"
CLAUDE_CONFIG="$HOME/.claude.json"
BACKUP="$HOME/.claude.json.bak.slim-mcp"

# ── Revert mode ──────────────────────────────────────────────────────────

if [ "$1" = "--revert" ]; then
  echo "Reverting Claude Code config..."
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$CLAUDE_CONFIG"
    echo "Restored from $BACKUP"
    rm -f "$SLIM_CONFIG"
    echo "Cleaned up smoke test config"
    echo "Restart Claude Code to apply."
  else
    echo "ERROR: No backup found at $BACKUP"
    exit 1
  fi
  exit 0
fi

# ── Setup mode ───────────────────────────────────────────────────────────

echo "=== slim-mcp Smoke Test ==="
echo ""

# Step 0: Build
echo "[1/7] Building slim-mcp..."
cd "$REPO_DIR"
npm run build

# Step 1: Read current Claude Code MCP config
echo "[2/7] Reading current Claude Code MCP config..."
if [ ! -f "$CLAUDE_CONFIG" ]; then
  echo "ERROR: $CLAUDE_CONFIG not found. Is Claude Code configured?"
  exit 1
fi

node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CLAUDE_CONFIG', 'utf8'));
const servers = config.mcpServers || {};
console.log('Current MCP servers:');
Object.keys(servers).forEach(name => {
  const s = servers[name];
  if (s.command) console.log('  ' + name + ' (stdio: ' + s.command + ')');
  else if (s.url) console.log('  ' + name + ' (http: ' + s.url + ')');
  else console.log('  ' + name + ' (unknown)');
});
console.log('Total: ' + Object.keys(servers).length + ' servers');
"

# Step 2: Generate .slim-mcp.json from current config
echo "[3/7] Generating slim-mcp config..."
node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CLAUDE_CONFIG', 'utf8'));
const mcpServers = config.mcpServers || {};
const slimConfig = { servers: {}, compression: 'standard' };

for (const [name, server] of Object.entries(mcpServers)) {
  if (server.command) {
    slimConfig.servers[name] = {
      command: server.command,
      ...(server.args && { args: server.args }),
      ...(server.env && Object.keys(server.env).length > 0 && { env: server.env })
    };
  } else if (server.url) {
    slimConfig.servers[name] = {
      url: server.url,
      ...(server.type && { type: server.type }),
      ...(server.headers && { headers: server.headers })
    };
  }
}

fs.writeFileSync('$SLIM_CONFIG', JSON.stringify(slimConfig, null, 2));
console.log('Written to $SLIM_CONFIG');
console.log(JSON.stringify(slimConfig, null, 2));
"

# Step 3: Backup current Claude config
echo "[4/7] Backing up Claude config..."
cp "$CLAUDE_CONFIG" "$BACKUP"
echo "Backed up to $BACKUP"

# Step 4: Swap Claude Code to use slim-mcp
echo "[5/7] Configuring Claude Code to use slim-mcp..."
node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CLAUDE_CONFIG', 'utf8'));

// Store original servers for restoration
config._mcpServers_backup = config.mcpServers;

// Replace with single slim-mcp entry
config.mcpServers = {
  'slim-mcp': {
    command: 'node',
    args: ['$REPO_DIR/dist/index.js', '--config', '$SLIM_CONFIG', '--verbose']
  }
};

fs.writeFileSync('$CLAUDE_CONFIG', JSON.stringify(config, null, 2));
console.log('Claude Code now configured to use slim-mcp');
console.log('Restart Claude Code to apply.');
"

SERVERS=$(node -e "const c=JSON.parse(require('fs').readFileSync('$SLIM_CONFIG','utf8'));console.log(Object.keys(c.servers).join(', '))")

echo ""
echo "[6/7] SMOKE TEST READY"
echo ""
echo "Claude Code is now configured to use slim-mcp as its MCP proxy."
echo "slim-mcp will proxy these servers: $SERVERS"
echo ""
echo "To test:"
echo "  1. Start a new Claude Code session"
echo "  2. Try using tools that go through your MCP servers"
echo "  3. Check slim-mcp output (it logs to stderr via Claude Code)"
echo "  4. When done, run: $0 --revert"
echo ""
echo "To revert immediately:"
echo "  $0 --revert"
