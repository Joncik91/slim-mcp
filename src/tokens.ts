/**
 * Estimate token count for a JSON-serializable value.
 * Uses JSON string length / 4 as a rough approximation.
 */
export function estimateTokens(value: unknown): number {
  const json = JSON.stringify(value);
  return Math.ceil(json.length / 4);
}

export interface CompressionStats {
  toolCount: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Format a human-readable compression report line.
 */
export function formatCompressionReport(stats: CompressionStats): string {
  const reduction = stats.beforeTokens > 0
    ? Math.round((1 - stats.afterTokens / stats.beforeTokens) * 100)
    : 0;
  return `Compressed ${stats.toolCount} tools: ${stats.beforeTokens} → ${stats.afterTokens} tokens (${reduction}% reduction)`;
}
