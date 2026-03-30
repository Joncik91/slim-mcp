import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { estimateTokens } from './tokens.js';

// --- Types ---

export interface LazyToolStats {
  total: number;
  loaded: number;
  slim: number;
}

export interface LazyLoadingReport {
  stats: LazyToolStats;
  fullTokens: number;
  slimTokens: number;
  withoutLazyTokens: number;
}

export interface LazyToolManager {
  getToolList(allTools: Tool[]): Tool[];
  promoteTools(toolNames: string[]): void;
  isSlim(toolName: string): boolean;
  getFullTool(toolName: string): Tool | undefined;
  getStats(): LazyToolStats;
  getReport(): LazyLoadingReport | null;
}

// --- Constants ---

export const HIGH_PRIORITY_PATTERNS = /^(search|list|read|get|find|describe|info)/i;

// --- Helpers ---

function slimTool(tool: Tool): Tool {
  const slim: Tool = {
    name: tool.name,
    inputSchema: { type: 'object' as const },
  };
  if (tool.description) {
    slim.description = tool.description;
  }
  return slim;
}

// --- Factory ---

export function createLazyToolManager(options: {
  maxToolsLoaded: number;
  alwaysLoad: Set<string>;
}): LazyToolManager {
  const { maxToolsLoaded = 8, alwaysLoad } = options;

  const promoted = new Set<string>();
  const toolStore = new Map<string, Tool>();
  const slimSet = new Set<string>();

  let lastStats: LazyToolStats | null = null;
  let lastFullTools: Tool[] = [];
  let lastSlimTools: Tool[] = [];

  function getToolList(allTools: Tool[]): Tool[] {
    toolStore.clear();
    slimSet.clear();
    lastFullTools = [];
    lastSlimTools = [];

    for (const tool of allTools) {
      toolStore.set(tool.name, tool);
    }

    // Determine which tools get full schemas
    const fullNames = new Set<string>();

    // 1. alwaysLoad tools
    for (const name of alwaysLoad) {
      if (toolStore.has(name)) {
        fullNames.add(name);
      }
    }

    // 2. Previously promoted tools
    for (const name of promoted) {
      if (toolStore.has(name)) {
        fullNames.add(name);
      }
    }

    // 3. Fill remaining budget with high-priority pattern matches
    const remaining = maxToolsLoaded - fullNames.size;
    if (remaining > 0) {
      let filled = 0;
      for (const tool of allTools) {
        if (filled >= remaining) break;
        if (fullNames.has(tool.name)) continue;
        if (HIGH_PRIORITY_PATTERNS.test(tool.name)) {
          fullNames.add(tool.name);
          filled++;
        }
      }
    }

    // Build result list in original order
    const result: Tool[] = [];
    for (const tool of allTools) {
      if (fullNames.has(tool.name)) {
        result.push(tool);
        lastFullTools.push(tool);
      } else {
        const slim = slimTool(tool);
        result.push(slim);
        slimSet.add(tool.name);
        lastSlimTools.push(tool);
      }
    }

    lastStats = {
      total: allTools.length,
      loaded: fullNames.size,
      slim: slimSet.size,
    };

    return result;
  }

  function promoteTools(toolNames: string[]): void {
    for (const name of toolNames) {
      promoted.add(name);
      slimSet.delete(name);
    }
  }

  function isSlim(toolName: string): boolean {
    return slimSet.has(toolName);
  }

  function getFullTool(toolName: string): Tool | undefined {
    return toolStore.get(toolName);
  }

  function getStats(): LazyToolStats {
    return lastStats ?? { total: 0, loaded: 0, slim: 0 };
  }

  function getReport(): LazyLoadingReport | null {
    if (!lastStats) return null;

    let fullTokens = 0;
    for (const tool of lastFullTools) {
      fullTokens += estimateTokens(tool);
    }

    let slimTokens = 0;
    for (const tool of lastSlimTools) {
      slimTokens += estimateTokens(slimTool(tool));
    }

    let withoutLazyTokens = 0;
    for (const tool of toolStore.values()) {
      withoutLazyTokens += estimateTokens(tool);
    }

    return {
      stats: { ...lastStats },
      fullTokens,
      slimTokens,
      withoutLazyTokens,
    };
  }

  return { getToolList, promoteTools, isSlim, getFullTool, getStats, getReport };
}

// --- Formatting ---

export function formatLazyReport(report: LazyLoadingReport): string {
  const { stats, fullTokens, slimTokens, withoutLazyTokens } = report;
  const saved = withoutLazyTokens - (fullTokens + slimTokens);
  const reduction = withoutLazyTokens > 0
    ? Math.round((1 - (fullTokens + slimTokens) / withoutLazyTokens) * 100)
    : 0;

  return [
    `Lazy loading: ${stats.loaded} full + ${stats.slim} slim (${stats.total} total)`,
    `Full schemas: ${fullTokens} tokens | Slim index: ${slimTokens} tokens | Without lazy: ${withoutLazyTokens} tokens`,
    `Lazy loading saved: ${saved} tokens (${reduction}% reduction)`,
  ].join('\n');
}
