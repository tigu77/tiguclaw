/**
 * 배경 스폰: **중복은 안 띄우고, 누구를 띄웠는지는 보인다** (2026-08-20 사용자 신고)
 *
 * 신고 둘이 같은 화면에서 나왔다:
 *  ① "spawn_agent 가 무조건 두 번 불려 · 매니저도 마찬가지" — 모델이 한 응답에 **글자
 *    그대로 같은 인자**로 두 번 발행했고, 어댑터는 충실히 둘 다 실행해 에이전트가 둘 떴다
 *    (각 20만 토큰급 = 비용 2배). 전역 배지가 2 였던 게 증거다.
 *  ③ "누구를 소환했다 정보가 없어졌다" — 요약이 `path=…, prompt=…` 로 나와 **`name` 이
 *    안 보였다.** 원인은 규칙 둘이 겹친 것: 우선순위가 **손으로 관리되는 목록**인데
 *    `name` 이 `path`·`prompt` 뒤였고, 요약이 **2개에서 끊었다** → 조용히 접혔다.
 *    (이 레포가 이미 두 번 적어둔 규칙이다: 손 목록 = 드리프트 신호 / 캡 있는 자리에
 *     반드시 도달해야 할 것을 두지 마라.)
 *
 * ★둘 다 **배경 서브에이전트(2026-08-19) 이후 생긴 행동**이다. 그전엔 spawn 이 항상
 *  기다리는 호출이라 두 번 부를 이유가 없었고, 인자 조합도 달랐다. 기능이 바뀌면 그
 *  기능을 지나는 옛 판정도 다시 봐야 한다는 사례다.
 *
 * 등급: **동작 검사**. 순수 함수를 실행한다(모델 0, 네트워크 0, 데몬 0).
 */
import { buildActivityDetail } from "../../core/llm-runtime/adapters/_activity-detail.js";
import {
  __resetSpawnDedupeForTest,
  findDuplicateSpawn,
  rememberSpawn,
  spawnKey,
} from "../../core/spawn-dedupe.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const LONG_PROMPT =
  '사용자 요청: "제대로 된 마리오를 만들어달라고 했을 때 목표에 맞추려면 어떻게 가면 좋을지 ' +
  '검토해봐". 구현/파일수정은 하지 말고 설계 검토만 하세요.';

export const check: RegressionCheck = {
  name: "spawn-dedupe-and-detail",
  guards:
    "한 응답 안에서 같은 인자로 배경 스폰이 두 번 실행돼 비용이 두 배 나던 것 + 도구 요약이 2개 캡에 걸려 '누구를 소환했는지'(name)를 조용히 떨어뜨리던 것 (2026-08-20 사용자 신고)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 같은 인자 재발행은 새로 안 띄운다 ─────────────────────────────────────
    __resetSpawnDedupeForTest();
    {
      const tk = "dashboard:s1";
      const k = spawnKey({ tool: "spawn_agent", name: "voxel-architect", prompt: LONG_PROMPT, path: "E:/vb" });
      const t0 = 1_700_000_000_000;
      out.push(
        assert("첫 소환은 중복이 아니다", findDuplicateSpawn(tk, k, t0) === undefined, "통과"),
      );
      rememberSpawn(tk, k, "job-1", t0);
      out.push(
        assert(
          "★같은 배치의 동일 인자 재발행은 **첫 jobId 로 흡수**된다 — 안 그러면 같은 일을 두 번 한다",
          findDuplicateSpawn(tk, k, t0 + 50) === "job-1",
          String(findDuplicateSpawn(tk, k, t0 + 50)),
        ),
        assert(
          "★프롬프트가 다르면 **막지 않는다** — 병렬 팬아웃은 이 기능의 목적이다",
          findDuplicateSpawn(
            tk,
            spawnKey({ tool: "spawn_agent", name: "voxel-architect", prompt: "다른 일", path: "E:/vb" }),
            t0 + 50,
          ) === undefined,
          "막지 않음",
        ),
        assert(
          "다른 대화의 같은 소환은 막지 않는다(창은 대화별)",
          findDuplicateSpawn("dashboard:s2", k, t0 + 50) === undefined,
          "막지 않음",
        ),
        assert(
          "창이 지나면 다시 띄울 수 있다(영구 차단 아님)",
          findDuplicateSpawn(tk, k, t0 + 60_000) === undefined,
          "해제됨",
        ),
        assert(
          "매니저(run_in_background)도 같은 판정을 받는다 — 신고가 둘 다였다",
          spawnKey({ tool: "run_in_background", name: "a", prompt: "b" }) !==
            spawnKey({ tool: "spawn_agent", name: "a", prompt: "b" }),
          "도구가 다르면 다른 키",
        ),
      );
    }

    // ── ③ 요약이 "누구를" 을 떨어뜨리지 않는다 ──────────────────────────────────
    {
      const spawn = buildActivityDetail({
        name: "voxel-architect",
        path: "E:\\work\\test\\VoxelBuilder",
        prompt: LONG_PROMPT,
      });
      out.push(
        assert(
          "★spawn_agent 요약에 **누구를 소환했는지**(name)가 있다 — 이게 그 줄의 답이다",
          (spawn ?? "").includes("voxel-architect"),
          spawn ?? "(없음)",
        ),
        assert(
          "식별자가 **맨 앞**이다 — 잘려도 살아남는 자리",
          (spawn ?? "").startsWith("name=voxel-architect"),
          (spawn ?? "").slice(0, 40),
        ),
        assert(
          "★본문(prompt)이 자리를 다 먹지 않는다 — 잘린 프롬프트 조각은 정보가 거의 없다",
          !(spawn ?? "").includes("마리오"),
          spawn ?? "",
        ),
      );

      // 다른 도구들의 답이 바뀌지 않았는지 — 순서를 고치며 옆을 깨는 게 이 부류의 2차결함.
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["Read", { path: "/a/b.ts", limit: 100 }, "path=/a/b.ts"],
        ["Bash", { command: "npm run build" }, "command=npm run build"],
        ["Grep", { pattern: "foo", path: "/src" }, "pattern=foo"],
        ["Task(claude)", { description: "코드 검토", prompt: LONG_PROMPT }, "description=코드 검토"],
        ["run_in_background", { label: "정산", task: "매출", path: "/tmp" }, "label=정산"],
      ];
      for (const [name, input, must] of cases) {
        const got = buildActivityDetail(input) ?? "";
        out.push(
          assert(`${name} 요약이 여전히 답을 담는다 (${must})`, got.includes(must), got || "(없음)"),
        );
      }

      out.push(
        assert(
          "할일 요약은 그대로다(별도 규칙 — 순서 변경에 안 휩쓸린다)",
          (buildActivityDetail({
            todos: [
              { content: "a", status: "completed" },
              { content: "b", status: "in_progress", activeForm: "b 하는 중" },
            ],
          }) ?? "").startsWith("할일 1/2"),
          buildActivityDetail({
            todos: [{ content: "a", status: "completed" }],
          }) ?? "(없음)",
        ),
      );
    }

    __resetSpawnDedupeForTest();
    return out;
  },
};
