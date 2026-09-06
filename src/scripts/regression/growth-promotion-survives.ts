/**
 * 회귀: **사용자가 올린 것을 데몬이 다시 내리지 않는다** + **«미열람» 신호가 살아 있다**
 * (2026-09-05 적대 검토).
 *
 * 배경: 이번 릴리스에서 자가성장 제안을 **인덱스에서 내리기로** 했다(매 턴 실리는 자리를
 * 안 먹게). 그러면 도달은 두 가지에 기댄다 — 사용자가 `archive_memory(restore:true)` 로
 * 되올리는 것, 그리고 `/status` 의 «미열람» 카운트.
 *
 * ★그런데 **둘 다 끊겨 있었다**:
 *  ① `upsertReflection` 이 **갱신할 때도** 무조건 `archiveMemory` 를 불렀다. 주석엔
 *    *"사용자가 되돌려 올렸다면 그건 승격이고 그때는 이 문을 안 지난다"* 고 적혀 있었는데
 *    코드가 안 그랬다 — 재발이 한 번만 나도 승격이 조용히 취소됐다.
 *  ② 백필 스윕은 이름이 `…Once` 인데 **매 부팅** 돌았다(생성자 호출). 재시작마다 승격 취소.
 *  ③ «미열람» 은 `access_count = 0` 으로 세는데, 옛 산출물의 카운터가 **같은 날 고친 다른
 *    버그**(자가성장이 자기 것을 `getMemory` 로 읽던 것)로 이미 부풀어 있었다. 실측:
 *    성장 산출물 46건 중 **45건이 «읽음»** 으로 잡혀 `/status` 가 «미열람 1» 이라고 답했다.
 *    인덱스에서 내리면서 도달을 그 카운트에 맡겼는데 그 카운트가 이미 망가져 있었다.
 *
 * ★이 검사는 **동작**이다 — 격리 홈에서 실제 순서(업그레이드 부팅 → 승격 → 재발 → 재부팅)
 *  를 돌린다. 소스 문자열로는 ①②를 못 본다(주석이 맞는 말을 적고 있었으니까).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "growth-promotion-survives",
  guards:
    "제안을 인덱스에서 내린 뒤 도달이 «사용자 승격»과 «미열람 카운트» 둘에 걸렸는데, 재발·재부팅이 승격을 조용히 취소하고 카운트는 옛 버그로 부풀어 죽어 있던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const prevHome = process.env.TIGUCLAW_HOME;
    const home = mkdtempSync(path.join(tmpdir(), "growth-promo-"));
    process.env.TIGUCLAW_HOME = home;
    try {
      const { __resetPathsCache } = await import("../../core/paths.js");
      __resetPathsCache?.();
      const { initStore } = await import("../../store/sessions.js");
      initStore();
      // ★`loadPluginModule` 로 간다 — 리터럴 `plugins/` import 는 `npm run build`
      //  (rootDir=src)를 TS6059 로 깨뜨린다(`src-stays-inside-src` 가 잡아줬다).
      const { upsertReflection } = await loadPluginModule<{
        upsertReflection: (i: { name: string; description: string; body: string }) => void;
      }>("../../../plugins/self-growth/src/analysis.ts");
      const { archiveGrowthOutputsOnce, resetGrowthAccessOnce } = await loadPluginModule<{
        archiveGrowthOutputsOnce: () => number;
        resetGrowthAccessOnce: () => number;
      }>("../../../plugins/self-growth/src/efficiency.ts");
      const { listMemories, unarchiveMemory, archiveMemory, getMemory, countArchivedMemories } = await import(
        "../../store/memory.js"
      );

      const N = "feedback_growth_promo_probe";
      const inIndex = (): boolean => listMemories({ limit: 500 }).some((m) => m.name === N);

      // 옛 세계 재현 — 인덱스에 올라와 있고, 카운터가 부풀어 있다.
      upsertReflection({ name: N, description: "옛 산출물", body: "{}" });
      unarchiveMemory(N);
      getMemory(N);
      getMemory(N);
      getMemory(N);

      // ★★그리고 **이미 아카이브된** 산출물도 하나 둔다 (2026-09-06 라이브에서 드러난 갈래).
      //  첫 판은 `listMemories` 기본(`archived_at IS NULL`)만 봐서 **이것들을 아예 못 봤다**.
      //  그런데 복구가 필요한 카운터는 정확히 이쪽이다 — 실측: 라이브 46건이 **전부
      //  아카이브** 상태였고 미열람 1건뿐이었다. 내 격리 테스트는 직접 unarchive 해서
      //  만든 상황만 봐서 이 갈래가 통째로 빠져 있었다.
      const ARCHIVED = "feedback_growth_already_archived";
      upsertReflection({ name: ARCHIVED, description: "이미 내려간 옛 산출물", body: "{}" });
      unarchiveMemory(ARCHIVED);
      getMemory(ARCHIVED);
      getMemory(ARCHIVED);
      archiveMemory(ARCHIVED); // 스윕 전부터 아카이브 상태 + 카운터 부풀어 있음

      // ① 첫 부팅(백필) — 내려가고, 부푼 카운터가 복구된다.
      archiveGrowthOutputsOnce();
      resetGrowthAccessOnce();
      const afterSweep = countArchivedMemories();
      out.push(
        assert(
          "백필 스윕이 성장 산출물을 인덱스에서 내린다",
          !inIndex(),
          inIndex() ? "★아직 인덱스에 있다" : `인덱스에서 내려감 · 아카이브 ${afterSweep.total}건`,
        ),
      );
      out.push(
        assert(
          "★★부풀어 있던 접근 카운터가 복구돼 «미열람» 이 산다 — 안 그러면 도달 신호가 죽은 채로 남는다",
          afterSweep.unread >= 1,
          `미열람 ${afterSweep.unread} / 아카이브 ${afterSweep.total} (읽은 척 3회를 만들어 넣었다)`,
        ),
      );
      out.push(
        assert(
          "★★**이미 아카이브된** 산출물의 카운터도 복구된다 — 라이브에서 복구 대상 46건이 전부 이 상태였고, 첫 판은 그걸 아예 못 봤다",
          afterSweep.unread === afterSweep.total,
          `미열람 ${afterSweep.unread} / 아카이브 ${afterSweep.total}${afterSweep.unread === afterSweep.total ? "" : " ★아카이브분이 복구에서 빠졌다"}`,
        ),
      );

      // ② 사용자 승격
      unarchiveMemory(N);
      out.push(assert("사용자가 되올리면 인덱스에 뜬다", inIndex(), `인덱스=${inIndex()}`));

      // ③ 재발 갱신이 승격을 취소하지 않는다
      upsertReflection({ name: N, description: "재발", body: "{}" });
      const afterRecur = inIndex();
      out.push(
        assert(
          "★★재발 갱신이 사용자 승격을 취소하지 않는다",
          afterRecur,
          afterRecur ? "승격 유지" : "★갱신이 다시 내렸다 — 사용자가 올린 것을 데몬이 되돌린다",
        ),
      );

      // ④ 재부팅이 승격을 취소하지 않는다(스윕이 진짜 1회다)
      archiveGrowthOutputsOnce();
      archiveGrowthOutputsOnce();
      resetGrowthAccessOnce();
      const afterReboot = inIndex();
      out.push(
        assert(
          "★★재부팅이 사용자 승격을 취소하지 않는다(`…Once` 가 이름값을 한다)",
          afterReboot,
          afterReboot ? "재부팅 2회에도 승격 유지" : "★스윕이 매번 돌아 승격을 되돌린다",
        ),
      );

      // ④' ★★**«한 일이 다시 도는» 갈래** (2026-09-06 적대 검토 P1).
      //  카운터 복구를 뒤늦게 붙이면서 마커 판을 올렸더니(`outputs-archived` → `-v2`),
      //  **옛 홈이 올라올 때 아카이브 백필까지 다시 돌아** 사용자가 되올린 제안이
      //  되돌려지고 사람이 읽은 기록까지 0으로 지워졌다. 어제 고친 그 동작을 오늘
      //  «판 올림» 이라는 탈출구로 내가 되살린 것이다(실행으로 확인: 인덱스 true → false).
      //  ★고침은 **일마다 마커를 따로 두는 것** — 두 일을 한 마커로 묶으면 «하나 때문에
      //   판을 올리는 순간 나머지도 다시 돈다».
      //  이 검사는 그 상황을 그대로 만든다: 옛 마커만 있는 홈에서 부팅한다.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { getPaths } = await import("../../core/paths.js");
      const dir = path.join(getPaths().commonPlugins, "self-growth");
      mkdirSync(dir, { recursive: true });
      // 마커를 **전부** 지우고 옛 이름 하나만 남긴다 = 옛 판에서 올라온 홈.
      const { rmSync: rmOne, readdirSync } = await import("node:fs");
      for (const f of readdirSync(dir)) if (/^(outputs-archived|access-reset)/.test(f)) rmOne(path.join(dir, f));
      writeFileSync(path.join(dir, "outputs-archived"), String(Date.now()), "utf8");
      archiveGrowthOutputsOnce();
      resetGrowthAccessOnce();
      const afterUpgrade = inIndex();
      out.push(
        assert(
          "★★판을 올려도(옛 마커만 있는 홈) 승격이 되돌려지지 않는다 — 마커를 하나로 묶으면 «하나 때문에 판을 올리는 순간 나머지도 다시 돈다»",
          afterUpgrade,
          afterUpgrade ? "옛 마커 홈에서 부팅해도 승격 유지" : "★백필이 다시 돌아 승격을 되돌렸다(읽은 기록도 0이 된다)",
        ),
      );

      // ⑤ 신규 제안은 여전히 인덱스를 안 먹는다(고치다가 원래 목적을 잃지 않았나)
      const N2 = "feedback_growth_promo_new";
      upsertReflection({ name: N2, description: "새 제안", body: "{}" });
      const newInIndex = listMemories({ limit: 500 }).some((m) => m.name === N2);
      out.push(
        assert(
          "새 제안은 여전히 인덱스에 안 실린다(승격을 지키려다 원래 목적을 잃지 않았다)",
          !newInIndex,
          newInIndex ? "★새 제안이 인덱스를 먹는다" : "새 제안 미노출",
        ),
      );
    } finally {
      if (prevHome === undefined) delete process.env.TIGUCLAW_HOME;
      else process.env.TIGUCLAW_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
    return out;
  },
};
export default check;
