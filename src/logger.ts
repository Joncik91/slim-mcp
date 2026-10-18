let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function isVerbose(): boolean {
  return verbose;
}

// All output goes to stderr: stdout carries the MCP protocol stream.
export function info(msg: string): void {
  process.stderr.write(`[slim-mcp] ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`[slim-mcp] WARN: ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`[slim-mcp] ERROR: ${msg}\n`);
}

export function debug(msg: string | (() => string)): void {
  if (verbose) {
    process.stderr.write(`[slim-mcp] ${typeof msg === 'function' ? msg() : msg}\n`);
  }
}
