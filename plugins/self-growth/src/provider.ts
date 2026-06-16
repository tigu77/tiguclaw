import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Provider, ProviderStatus } from "../../../src/core/plugins/providers.js";
import { listMemories } from "../../../src/store/memory.js";

const toIso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

const latestUpdatedAt = (rows: Array<{ updatedAt: number }>): string | null => {
  const first = rows[0];
  return first === undefined ? null : new Date(first.updatedAt).toISOString();
};

const parseMemoryBody = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

export const collectProvider = (): Provider => {
  const feedback = listMemories({ type: "feedback", limit: 10000, orderBy: "updated" });
  const reflections = feedback.filter((m) => m.name.startsWith("feedback_growth_reflection_"));
  const drift = feedback.filter((m) => m.name.startsWith("feedback_growth_drift_"));
  const weeklyReviews = feedback.filter((m) => m.name.startsWith("feedback_growth_weekly_review_"));
  const recentGrowth = feedback
    .filter((m) => m.name.startsWith("feedback_growth_"))
    .slice(0, 10);

  const runtimeManifest = join(process.cwd(), "tiguclaw-dev", "plugins", "self-growth", "plugin.json");
  const repoPackage = join(process.cwd(), "plugins", "self-growth", "package.json");
  const runtimeManifestExists = existsSync(runtimeManifest);
  const repoPackageExists = existsSync(repoPackage);
  const status: ProviderStatus = runtimeManifestExists || repoPackageExists ? "active" : "missing";

  return {
    id: "plugin.self-growth",
    kind: "plugin",
    name: "Self Growth",
    status,
    summary: `${reflections.length} reflections, ${weeklyReviews.length} weekly reviews`,
    capabilities: [
      "memory.feedback.observe",
      "growth.reflection.suggest",
      "growth.weekly-review.read",
      "growth.drift-monitor.read",
    ],
    views: [
      {
        id: "plugin.self-growth.summary",
        title: "자가 성장",
        kind: "summary-card",
        data: {
          reflections: reflections.length,
          driftSignals: drift.length,
          weeklyReviews: weeklyReviews.length,
          recentGrowthEntries: recentGrowth.length,
          latestGrowthUpdatedAt: latestUpdatedAt(recentGrowth),
          runtimeManifestExists,
          repoPackageExists,
        },
        order: 40,
      },
      {
        id: "plugin.self-growth.recent",
        title: "최근 자가 성장 메모리",
        kind: "table",
        data: {
          columns: ["name", "description", "updatedAt"],
          rows: recentGrowth.map((m) => ({
            name: m.name,
            description: m.description,
            updatedAt: toIso(m.updatedAt),
          })),
        },
        order: 41,
      },
      {
        id: "plugin.self-growth.latest-review",
        title: "최근 주간 회고",
        kind: "summary-card",
        data: weeklyReviews[0]
          ? {
              name: weeklyReviews[0].name,
              description: weeklyReviews[0].description,
              updatedAt: toIso(weeklyReviews[0].updatedAt),
              body: parseMemoryBody(weeklyReviews[0].body),
            }
          : { message: "주간 회고 메모리가 아직 없습니다." },
        order: 42,
      },
      {
        id: "plugin.self-growth.actions",
        title: "자가 성장 액션",
        kind: "action-panel",
        data: {
          note: "action 실행 endpoint는 아직 연결하지 않았습니다. v0.1은 읽기 전용 provider입니다.",
          actions: ["run-weekly-review"],
        },
        order: 43,
      },
    ],
    actions: [
      {
        id: "run-weekly-review",
        label: "주간 회고 실행",
        description: "self-growth 스킬/플러그인 회고를 수동 실행합니다. 현재는 metadata만 노출합니다.",
        danger: "gray",
        requiresConfirmation: true,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};
