/**
 * 홈 배치 도구 — `configure_home` (2026-08-28, 위젯 플랫폼 §J.5).
 *
 * ★**이 도구가 A3 를 증명한다.** 로드맵 A3 가 못박은 판정 기준은 *"사람이 배치할 수 있나"*
 *  가 아니라 ***"비서가 배치할 수 있나"*** 다. 이걸 안 만들면 위젯을 홈에 올리는 유일한
 *  방법이 `settings.json` 직접 편집이고, 그러면 화면은 되는데 **기준은 증명 못 한 채**
 *  초록이 난다. 손 배치(드래그)는 탈출구라 나중이고, 이 길이 기본이라 지금이다.
 *
 * ★**도구는 하나다.** add/remove/reorder 로 가르지 않는다 — 도구 설명은 **매 턴** 실리고,
 *  실사용 고유 도구가 28개인 자리에서 셋과 하나는 다르다(principle-check Q8 비대화).
 *  `widgets` 를 빼고 부르면 **읽기**, 넣고 부르면 **통째 교체**다. 부분 수정(한 개만 추가)을
 *  따로 두지 않는 이유도 같다 — 읽고·고쳐서·다시 보내면 되고, 그러면 순서 변경이 공짜다.
 *
 * ★판정은 여기 없다 — `core/home-widgets.ts` 의 순수 함수가 한다. 핸들러 안에 두면 검사가
 *  문자열 grep 밖에 못 한다([[feedback_simple_composable_no_duplication]]).
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  HOME_WIDGET_MAX,
  normalizeHomeWidgets,
  readHomeWidgets,
  writeHomeWidgets,
} from "../../home-widgets.js";
import { listLivePlugins } from "../../plugins/manager.js";
import { listPluginDataRoutes } from "../../plugins/data-routes.js";

const okText = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errText = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

/** 지금 돌고 있는 플러그인 이름 — 유일한 진실 소스는 런타임이지 목록이 아니다. */
const livePluginNames = (): ReadonlySet<string> =>
  new Set(listLivePlugins().map((p) => p.name));

/**
 * 모델이 볼 현재 상태 한 덩어리.
 *
 * ★**무엇을 놓을 수 있는지 같이 준다.** 코어는 위젯 id 목록을 모르지만(등록소는 브라우저에
 *  있다) *"어떤 플러그인이 홈에 값을 낼 수 있나"* 는 안다 — 데이터 라우트가 그 신호다.
 *  없으면 모델은 이름을 지어내고, 지어낸 이름은 조용히 빈 자리가 된다.
 */
const describeState = (): string => {
  const known = livePluginNames();
  const { widgets, rejected } = readHomeWidgets(known);
  const routes = listPluginDataRoutes();
  const lines: string[] = [];
  lines.push(
    widgets.length === 0
      ? "지금 홈에 놓인 위젯: 없음."
      : `지금 홈에 놓인 위젯 ${widgets.length}개(위에서부터):\n` +
          widgets
            .map(
              (w, i) =>
                `  ${i + 1}. id=${w.id} type=${w.type} size=${w.size}` +
                (Object.keys(w.config).length > 0
                  ? ` config=${JSON.stringify(w.config)}`
                  : ""),
            )
            .join("\n"),
  );
  if (rejected.length > 0) {
    lines.push(
      "★저장된 값 중 못 쓰는 것:\n" +
        rejected.map((r) => `  ${r.at}: ${r.reason}`).join("\n"),
    );
  }
  lines.push(
    routes.length === 0
      ? "홈에 값을 낼 수 있는 플러그인: 없음(데이터 라우트를 내는 플러그인이 없습니다)."
      : `홈에 값을 낼 수 있는 플러그인 라우트: ${routes.join(", ")}`,
  );
  return lines.join("\n");
};

const WIDGET_SCHEMA = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe("이 배치 안에서만 유일하면 되는 이름. 예: 'work'"),
  type: z
    .string()
    // ★**예시로 특정 플러그인 이름을 박지 않는다** (2026-08-29). 배포본엔 없는 플러그인을
    //  예로 들면 모델이 그 이름을 지어내 쓰고, 그건 조용히 빈 자리가 된다. 실제로 무엇을
    //  놓을 수 있는지는 `describeState()` 가 **런타임에** 알려준다(라우트 목록).
    .describe("`<plugin>/<widget>` 형식. 놓을 수 있는 것은 이 도구를 인자 없이 불러 확인하세요."),
  size: z
    .enum(["small", "wide"])
    .optional()
    .describe("크기 등급(기본 small). 격자 좌표는 없다 — 화면이 알아서 배치한다."),
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "이 위젯 하나의 설정. 예: { place: '수원시' }. ★열쇠·토큰은 절대 넣지 마세요(거부됩니다).",
    ),
});

const CONFIGURE_HOME = tool(
  "configure_home",
  "대시보드 홈에 어떤 위젯을 어떤 순서로 놓을지 읽거나 바꿉니다. " +
    "`widgets` 없이 부르면 현재 배치와 놓을 수 있는 것들을 알려주고, " +
    "`widgets` 를 주면 그 배열로 **통째 교체**합니다(순서 = 화면 순서). " +
    "하나만 추가·삭제하려면 먼저 읽고, 고친 배열을 다시 보내세요.",
  {
    widgets: z
      .array(WIDGET_SCHEMA)
      .max(HOME_WIDGET_MAX)
      .optional()
      .describe(
        `홈에 놓을 위젯 전체(최대 ${HOME_WIDGET_MAX}개). 생략하면 아무것도 바꾸지 않고 현재 상태만 돌려줍니다.`,
      ),
  },
  async (args: { widgets?: unknown }) => {
    if (args.widgets === undefined) return okText(describeState());
    const known = livePluginNames();
    const { widgets, rejected } = normalizeHomeWidgets(args.widgets, known);
    if (rejected.length > 0) {
      // ★**아무것도 안 쓰고 이유를 말한다.** 반쪽만 적용하면 모델도 사용자도 지금 홈이
      //  무엇인지 모르게 된다 — 그리고 모델은 이유를 받아야 고쳐서 다시 부를 수 있다.
      return errText(
        "배치를 바꾸지 않았습니다 — 아래를 고쳐서 다시 부르세요.\n" +
          rejected.map((r) => `  ${r.at}: ${r.reason}`).join("\n") +
          `\n\n${describeState()}`,
      );
    }
    writeHomeWidgets(widgets);
    return okText(
      `홈 배치를 바꿨습니다.\n${describeState()}\n` +
        "★열려 있는 대시보드는 다음 갱신에 반영됩니다.",
    );
  },
);

export const createHomeWidgetsMcpServer = (): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "home-widgets",
    version: "1.0.0",
    tools: [CONFIGURE_HOME],
  });
