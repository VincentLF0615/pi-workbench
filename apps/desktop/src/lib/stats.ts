import type { SessionStats } from "./types";
export function normalizeStats(stats: SessionStats) {
  return {
    totalTokens: stats.tokens?.total ?? stats.tokens?.totalTokens,
    tokens: stats.contextUsage?.tokens ?? undefined,
    contextWindow: stats.contextUsage?.contextWindow,
    percent: stats.contextUsage?.percent,
    cost: stats.cost,
  };
}
