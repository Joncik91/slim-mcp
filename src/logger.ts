let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function info(msg: string): void {
  process.stderr.write(`[slim-mcp] ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`[slim-mcp] ERROR: ${msg}\n`);
}

export function debug(msg: string): void {
  if (verbose) {
    process.stderr.write(`[slim-mcp] ${msg}\n`);
  }
}
