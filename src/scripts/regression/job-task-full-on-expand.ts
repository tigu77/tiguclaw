/**
 * 회귀: **잘린 작업 지시문이 펼침에서 원문으로 채워진다** (2026-09-04).
 *
 * 사용자 신고: *"매니저랑 서브에이전트랑 카드 펼쳤을 때 설명 길이가 다른가?"* — 달랐다.
 * 그런데 원인은 `kind` 가 아니라 **어느 길로 왔나** 였다:
 *
 * ```text
 *   메모리(원문)  ├─ SSE 이벤트 → 500자 컷
 *                 └─ GET /api/worker-jobs → 컷 없음
 * ```
 * 렌더는 한 경로(`kind` 분기 0)라, **같은 카드가 새로고침 전후로 길이가 달라졌다.**
 * 게다가 화면 코드는 그 값을 «펼침 영역 전문» 이라 부르며 뿌리고 있었다 — 사용자가 보는
 * 것이 원문인지 잘린 것인지 **구분할 방법이 0** 이었다.
 *
 * ★고침은 «컷을 없앤다» 가 아니다(정태님 선택). `task` 는 사용자가 쓴 글이라 상한이 없고
 *  이 값은 이벤트 버스·SSE 리플레이 버퍼에 실린다 — 핫 경로는 바운드로 둔다
 *  ([[project_hotpath_bound_preserve_record]]). 대신 **화면이 펼칠 때 원문을 받아 간다.**
 *
 * ★이 기능의 실패는 **조용하다** — 안 채워져도 «짧은 지시문» 처럼 보인다. 그래서 그물이
 *  필요하고, 소스 grep 이 아니라 **판정을 실행**해서 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { TASK_EVENT_CAP } from "../../core/worker-jobs.js";
import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "job-task-full-on-expand",
  guards:
    "잡 카드의 작업 지시문이 SSE 경로에서만 500자로 잘려, 같은 카드가 새로고침 전후로 다른 내용을 보이던 것 + 잘린 줄 모르고 원문처럼 읽히던 것 (등급: 동작+배선)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ─── ① 서버 — **실행해서** 본다 (소스 grep 아님) ─────────────────────
    //  잡을 실제로 등록하고 버스에 실린 `worker.started` 를 잡아 판정한다. 소스 검사는
    //  «그렇게 적혀 있다» 만 보고 «그렇게 나간다» 는 못 본다(이 레포가 그걸로 데였다).
    const { getEventBus } = await import("../../core/eventbus.js");
    const { registerJob, markDone } = await import("../../core/worker-jobs.js");
    const seen: Array<{ task?: string; taskTruncated?: boolean }> = [];
    const unsub = getEventBus().subscribe((ev) => {
      if (ev.type !== "worker.started") return;
      const p = ev.payload as { task?: string; taskTruncated?: boolean };
      seen.push({ task: p.task, taskTruncated: p.taskTruncated });
    });
    const base = {
      label: "회귀", threadKey: "regr:task-cap", channel: "cli" as const,
      channelUserId: "regr",
    };
    // ★**앞과 뒤가 다른** 픽스처다 — `"가"` 반복이면 `slice(0,CAP)` 든 `slice(-CAP)` 든
    //  결과가 같아 방향 변이를 원리적으로 못 잡는다(3R 에서 실제로 못 잡았다).
    const longTask = `머리표식${"가".repeat(TASK_EVENT_CAP + 700)}꼬리표식`;
    const shortTask = "짧은 지시";
    const idLong = registerJob({ ...base, task: longTask });
    const idShort = registerJob({ ...base, task: shortTask });
    unsub();
    markDone(idLong, "done"); markDone(idShort, "done");

    const evLong = seen[0], evShort = seen[1];
    out.push(
      assert(
        "이벤트가 실제로 잡혔다(전제 — 없으면 아래가 전부 공허하다)",
        evLong !== undefined && evShort !== undefined,
        `worker.started ${seen.length}건`,
      ),
    );
    if (evLong !== undefined && evShort !== undefined) {
      out.push(
        assert(
          `★긴 지시문이 ${TASK_EVENT_CAP}자로 잘려 나간다(핫 경로 바운드)`,
          (evLong.task ?? "").length === TASK_EVENT_CAP,
          `${(evLong.task ?? "").length}자 (원문 ${longTask.length}자)`,
        ),
      );
      out.push(
        assert(
          "★잘렸으면 taskTruncated 를 같이 싣는다 — 화면이 «채워야 하나» 를 이걸로 판단한다",
          evLong.taskTruncated === true,
          String(evLong.taskTruncated),
        ),
      );
      out.push(
        assert(
          "★짧은 지시문엔 taskTruncated 를 안 붙인다(거짓 표시 금지 — 불필요한 fetch 를 부른다)",
          evShort.taskTruncated === undefined && evShort.task === shortTask,
          `truncated=${String(evShort.taskTruncated)} · ${(evShort.task ?? "").length}자`,
        ),
      );
    }

    // ─── ①-b 자르는 **방향** — 값은 끝이 아니라 앞에 있다 ────────────────
    //  `slice(0, CAP)` 를 `slice(-CAP)` 로 뒤집어도 위 셋은 전부 초록이었다(3R). 길이만
    //  재고 **무엇이 남았는지**를 안 봤기 때문이다. 요약 한 줄은 지시문의 **첫머리**여야
    //  «무슨 작업인지» 가 보인다.
    if (evLong !== undefined) {
      const head = "머리표식";
      out.push(
        assert(
          "★잘린 요약은 지시문의 **앞**이다(뒤를 남기면 카드가 «…해줘» 만 보여준다)",
          (evLong.task ?? "").startsWith(head),
          `앞 6자=${JSON.stringify((evLong.task ?? "").slice(0, 6))}`,
        ),
      );
    }

    // ─── ② 단건 라우트를 **실행해서** 본다 — 값이 실려 오나 ─────────────────
    //  ★종전엔 소스 한 줄을 정규식으로 봤고, 그 정규식이 잡던 줄은 **목록 매퍼**였다.
    //   그래서 3R 이 단건 핸들러를 `writeJson(res, 200, { jobId })` 로 비워도(=펼치면
    //   **항상** «원문이 사라졌습니다») 2,791건이 전부 초록이었다. 이 릴리스의 간판 기능이
    //   통째로 죽는 변이를 그물이 못 봤다 — 게이트가 **옆 줄**을 보고 있었다.
    //  ★그리고 2R 이 고친 P-3(`listJobs({limit:500})` → `getJob`)도 무보호였다. 임계값만
    //   옮긴 그 판으로 되돌려도 초록이었다. 그래서 **잡을 상한보다 많이** 만들어 놓고 잰다:
    //   목록 훑기로 돌아가면 여기서 즉시 운다.
    //  ★`plugins/` 를 리터럴로 import 하면 `npm run build` 가 TS6059 로 죽는다 — 계산된
    //   지정자(`loadPluginModule`)가 그래서 있다([[src-stays-inside-src]]).
    const { handleWorkerJobs } = await loadPluginModule<{
      handleWorkerJobs: (ctx: unknown) => Promise<void>;
    }>("../../../plugins/http-bridge/routes-work.js");

    /** 라우트를 부르고 응답 본문을 돌려준다. `res` 는 `writeJson` 이 쓰는 두 메서드만 있으면 된다. */
    const callRoute = async (qs: string): Promise<Record<string, unknown>> => {
      let body = "";
      await handleWorkerJobs({
        req: {},
        res: { writeHead: () => {}, end: (p: string) => { body = p; } },
        url: new URL(`http://x/worker-jobs${qs}`),
        pathname: "/worker-jobs",
        channelName: "regr",
        bus: null,
        sseClients: new Set(),
        channelHandler: null,
      });
      return JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>;
    };

    // 상한(2R 의 500)보다 많이 — 목록 훑기로 되돌아가면 `idLong` 이 창 밖으로 밀린다.
    const filler: string[] = [];
    for (let i = 0; i < 620; i += 1) filler.push(registerJob({ ...base, task: `채움 ${i}` }));
    const one = await callRoute(`?jobId=${idLong}`);
    for (const id of filler) markDone(id, "done");
    out.push(
      assert(
        "★단건 라우트가 **원문 전체**를 실어 준다 — 펼침이 여기서 받는다(비면 «사라졌습니다»)",
        typeof one["task"] === "string" && (one["task"] as string).length === longTask.length,
        `${typeof one["task"] === "string" ? `${(one["task"] as string).length}자` : "★task 없음"} (원문 ${longTask.length}자 · 잡 ${filler.length + 2}건)`,
      ),
    );
    out.push(
      assert(
        "★모르는 jobId 면 `{jobId}` 만 — 목록으로 떨어지면 화면이 원문을 못 찾는다",
        (await callRoute("?jobId=없는-잡")).jobs === undefined,
        JSON.stringify(await callRoute("?jobId=없는-잡")).slice(0, 60),
      ),
    );

    // ─── ③ 화면 — **실행해서** 본다 (2026-09-04 적대 검토가 여기를 뚫었다) ───────
    //  ★종전엔 이 구획이 전부 소스 grep 이었다. 검토자가 fetch URL 을 없는 경로로 바꾸고,
    //   승격 비교를 뒤집고, 화면 갱신 줄을 지웠는데 **셋 다 초록**이었다. 이 회귀의 머리말이
    //   *"소스 grep 이 아니라 판정을 실행해서 본다"* 고 적어놓고 서버 절반만 그랬다.
    //  ★그래서 **제품 소스의 hydrate 블록을 그대로 떼어 stub 위에서 돌린다**(재구현 아님 —
    //   재구현하면 그건 내 코드를 검사하는 것이지 제품을 검사하는 게 아니다).
    const bd = read("packages/dashboard/js/background-drawer.js");
    const blockStart = bd.indexOf("const hydrateFullTask = (jobId, entry) => {");
    const blockEnd = bd.indexOf("registerBuiltinHandler(\"job.toggleDetail\"");
    const block = blockStart >= 0 && blockEnd > blockStart ? bd.slice(blockStart, blockEnd) : "";
    out.push(
      assert(
        "hydrate 블록을 소스에서 떼어냈다(검사 전제 — 못 떼면 아래가 공허하다)",
        block.includes("fetch(") && block.includes("taskHydrateTried"),
        `${block.length}자`,
      ),
    );

    /** 제품 블록이 실제로 두드린 URL — ⑤가 소스가 아니라 **이 값**을 판정한다. */
    let lastUrl = "";
    /** 제품 블록을 주입 stub 위에서 실행한다. `fetch`·`i18n` 만 우리가 준다. */
    const runHydrate = async (opts: {
      entry: Record<string, unknown>;
      reply: { ok: boolean; status?: number; body?: unknown } | "reject";
    }): Promise<Record<string, unknown>> => {
      const fetchStub = (u: string): Promise<unknown> => (
        (lastUrl = String(u)),
        opts.reply === "reject"
          ? Promise.reject(new Error("net"))
          : Promise.resolve({
              ok: opts.reply.ok,
              status: opts.reply.status ?? 200,
              json: () => Promise.resolve(opts.reply === "reject" ? {} : opts.reply.body),
            }));
      const i18nStub = (k: string, p?: { v?: string }): string =>
        k === "bg.task.truncated" ? "[TRUNC]" : `작업 · ${p?.v ?? ""}`;
      // eslint-disable-next-line no-new-func
      const make = new Function(
        "fetch", "i18n", `${block} return hydrateFullTask;`,
      ) as (f: unknown, i: unknown) => (id: string, e: unknown) => void;
      make(fetchStub, i18nStub)("J1", opts.entry);
      await new Promise((r) => setTimeout(r, 5));
      return opts.entry;
    };

    const mkEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      task: "가".repeat(TASK_EVENT_CAP), taskTruncated: true, taskHydrateTried: false,
      taskEl: { textContent: "" }, ...over,
    });

    if (block !== "") {
      // ★① 원문이 오면 채운다 — 이 기능의 본체.
      const full = "가".repeat(1800);
      const e1 = await runHydrate({
        entry: mkEntry(), reply: { ok: true, body: { jobId: "J1", task: full } },
      });
      out.push(
        assert(
          "★원문이 오면 펼침 영역이 전문으로 바뀐다",
          String((e1.taskEl as { textContent: string }).textContent).includes(full) &&
            e1.taskTruncated === false,
          `${String((e1.taskEl as { textContent: string }).textContent).length}자 · truncated=${String(e1.taskTruncated)}`,
        ),
      );
      // ★② 502(브리지 미도달) — «사라졌다» 로 둔갑하면 안 되고, 재시도가 열려 있어야 한다.
      const e2 = await runHydrate({ entry: mkEntry(), reply: { ok: false, status: 502, body: {} } });
      out.push(
        assert(
          "★502 를 «원문이 사라졌다» 로 읽지 않는다(데몬 재시작 중이 거짓 문구가 되던 것)",
          !String((e2.taskEl as { textContent: string }).textContent).includes("[TRUNC]") &&
            e2.taskHydrateTried === false,
          `문구=${String((e2.taskEl as { textContent: string }).textContent).includes("[TRUNC]") ? "★붙음" : "안 붙음"} · 재시도가능=${String(e2.taskHydrateTried === false)}`,
        ),
      );
      // ★③ 서버가 정말 안 들고 있을 때만 «여기까지» 를 붙인다.
      const e3 = await runHydrate({ entry: mkEntry(), reply: { ok: true, body: { jobId: "J1" } } });
      out.push(
        assert(
          "서버가 task 를 안 주면 «여기까지만 남아 있습니다» 를 붙인다",
          String((e3.taskEl as { textContent: string }).textContent).includes("[TRUNC]"),
          String((e3.taskEl as { textContent: string }).textContent).slice(-12),
        ),
      );
      // ★④ 이미 전문을 들고 있으면(스냅샷 승격 뒤) 아무 말도 덧붙이지 않는다.
      const e4 = await runHydrate({
        entry: mkEntry({ task: full, taskTruncated: false }),
        reply: { ok: true, body: { jobId: "J1", task: full } },
      });
      out.push(
        assert(
          "★완전한 글에 «사라졌습니다» 를 덧붙이지 않는다(스냅샷이 먼저 승격한 경우)",
          !String((e4.taskEl as { textContent: string }).textContent).includes("[TRUNC]"),
          String((e4.taskEl as { textContent: string }).textContent).includes("[TRUNC]") ? "★붙었다" : "안 붙음",
        ),
      );
      // ★⑤ 단건으로 묻는다 — 목록으로 물으면 끝난 잡은 거의 항상 «사라졌다» 가 된다.
      //  ★**stub 이 받은 URL 을 단언한다**(3R G-2). 종전엔 바로 위에서 블록을 *실행*해 놓고
      //   URL 만 소스 정규식으로 봤다 — 실행 검사 옆에 붙은 grep 이 가장 약한 고리였고,
      //   검토자가 `fetch("/api/worker-jobs")` 위에 «계약: …?jobId=…» 주석 한 줄을 얹자
      //   통과했다(그러면 모든 잘린 카드가 펼칠 때 «사라졌습니다» 가 된다).
      //   실행이 재는 값에는 주석을 못 얹는다.
      out.push(
        assert(
          "★단건(jobId=)으로 묻는다 — 목록은 runningOnly 라 끝난 잡을 안 준다",
          lastUrl.includes("jobId=") && lastUrl.includes("J1"),
          `요청 URL=${lastUrl || "★fetch 안 함"}`,
        ),
      );
    }

    // ★⑤-b **setJobOpen → hydrate 이음매를 실행해서** 본다 (2026-09-04 2R G-5·G-4).
    //  ⑥은 토글이 «어디 있는지» 만 세고, 위 runHydrate 는 `hydrateFullTask` 를 **직접** 부른다.
    //  그래서 그 둘을 잇는 한 줄(`if (nowOpen) hydrateFullTask(...)`)이 빠져도 조용했다 —
    //  1라운드가 «이음매를 하나로 모았다» 고 한 바로 그 지점이 그물 밖이었다.
    //  ★`want` 인자도 여기서 잰다: 뒤집히면 `focusBgJob`(프로젝트 상세 → 잡 점프) 이
    //   **영영 안 펼쳐진다**. 1라운드가 새로 만든 인자인데 지나는 단언이 0이었다.
    const setterStart = bd.indexOf("const setJobOpen = (jobId, entry, want) => {");
    const setterBlock =
      setterStart >= 0 && blockStart >= 0
        ? bd.slice(Math.min(blockStart, setterStart), blockEnd)
        : "";
    out.push(
      assert(
        "setJobOpen+hydrate 블록을 소스에서 떼어냈다(검사 전제)",
        setterBlock.includes("const setJobOpen") && setterBlock.includes("hydrateFullTask"),
        `${setterBlock.length}자`,
      ),
    );
    if (setterBlock !== "") {
      const runOpen = async (
        want: boolean | undefined,
        taskTruncated: boolean,
      ): Promise<{ opened: unknown; fetched: number; open: boolean }> => {
        let fetched = 0;
        const cls = new Set<string>();
        const entry = {
          task: "가".repeat(TASK_EVENT_CAP), taskTruncated, taskHydrateTried: false,
          taskEl: { textContent: "" }, stepsEl: null,
          el: { classList: {
            contains: (c: string) => c === "has-detail" || cls.has(c),
            toggle: (c: string, force?: boolean) => {
              const on = force === undefined ? !cls.has(c) : force;
              if (on) cls.add(c); else cls.delete(c);
              return on;
            },
          } },
        };
        const fetchStub = () => { fetched += 1; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ jobId: "J", task: "가".repeat(2000) }) }); };
        // eslint-disable-next-line no-new-func
        const make = new Function(
          "fetch", "i18n", "updateChev", "requestAnimationFrame",
          `${setterBlock} return setJobOpen;`,
        );
        const fn = make(
          fetchStub,
          (k: string, p?: { v?: string }) => (k === "bg.task.truncated" ? "[T]" : `작업 · ${p?.v ?? ""}`),
          () => {},
          (f: () => void) => f(),
        ) as (id: string, e: unknown, w?: boolean) => unknown;
        const opened = fn("J", entry, want);
        await new Promise((r) => setTimeout(r, 5));
        return { opened, fetched, open: cls.has("open") };
      };
      const a = await runOpen(undefined, true);
      out.push(
        assert(
          "★펼치면 원문 채우기가 실제로 돈다(이 한 줄이 빠지면 원 신고 상태로 복귀)",
          a.opened === true && a.fetched === 1,
          `opened=${String(a.opened)} fetch=${a.fetched}회`,
        ),
      );
      const b = await runOpen(true, true);
      out.push(
        assert(
          "★want=true 면 실제로 열린다(뒤집히면 프로젝트 상세에서 카드가 영영 안 펼쳐진다)",
          b.open === true && b.opened === true && b.fetched === 1,
          `open=${String(b.open)} opened=${String(b.opened)}`,
        ),
      );
      const c = await runOpen(false, true);
      out.push(
        assert(
          "want=false 면 안 열리고 받아 오지도 않는다(접는 길에 헛 요청 금지)",
          c.open === false && c.fetched === 0,
          `open=${String(c.open)} fetch=${c.fetched}회`,
        ),
      );
      const d = await runOpen(undefined, false);
      out.push(
        assert(
          "안 잘린 카드는 펼쳐도 안 받아 온다(불필요한 요청 금지)",
          d.opened === true && d.fetched === 0,
          `fetch=${d.fetched}회`,
        ),
      );
    }

    // ★⑥ 펼치는 길이 **하나**여야 한다 — 셋이었고 채우기는 하나에만 걸려 있었다.
    //  ★**주석은 세지 않는다** — 첫 판이 그걸 세서 거짓 빨강을 냈다. 검사 대상은 코드이지
    //   그것을 설명하는 글이 아니다([[feedback_gate_must_actually_run]] 의 그 함정).
    //  ★줄마다 **파일 안 오프셋**을 같이 들고 다닌다 — `indexOf(줄)` 로 되찾으면 같은
    //   글자가 두 번 있을 때 첫 번째를 집는다(그리고 이 변이는 정확히 «같은 줄을 밖에
    //   하나 더 놓는» 모양이다). 되찾지 말고 **처음부터 안 잃어버린다.**
    let at = 0;
    const codeLines: Array<{ text: string; at: number }> = [];
    for (const text of bd.split("\n")) {
      if (!/^\s*(\/\/|\*|\/\*)/.test(text)) codeLines.push({ text, at });
      at += text.length + 1;
    }
    const openLines = codeLines.filter((l) => /classList\.(toggle|add)\("open"/.test(l.text));
    //  ★**위치로 판정한다**(3R G-1). 종전엔 `setterBody.includes(l.trim())` 였는데,
    //   `setJobOpen` 안에 `entry.el.classList.toggle("open")` 이 삼항의 한 가지로 들어 있어
    //   **파일 어디에든** 그 문자열만으로 된 줄을 놓으면 «안에 있다» 로 읽혔다. 검토자가
    //   `focusBgJob` 에서 그렇게 두 번째 펼침 길을 되살렸고(그 길만 채우기를 안 탄다)
    //   19건이 전부 초록이었다. **같은 글자가 어디 있느냐**를 텍스트로는 못 가른다.
    const inSetter = bd.indexOf("const setJobOpen");
    const setterEnd = inSetter < 0 ? -1 : bd.indexOf("\n      };", inSetter);
    const outside = openLines.filter((l) => l.at < inSetter || l.at > setterEnd);
    out.push(
      assert(
        "★카드를 펼치는 자리가 setJobOpen 하나다(호출부를 늘리는 대신 이음매를 없앴다)",
        inSetter >= 0 && openLines.length > 0 && outside.length === 0,
        `open 토글 ${openLines.length}줄 · setJobOpen 밖 ${outside.length}줄${outside.length ? " → " + outside[0]!.text.trim().slice(0, 50) : ""}`,
      ),
    );

    // ★⑥-b **입구**도 본다 — 이음매가 하나여도 아무도 안 부르면 카드가 안 펼쳐진다.
    //  ⑥은 *"토글이 `setJobOpen` 밖에 있으면 안 된다"* 만 센다 — **호출부가 0개여도 참**이다.
    //  3R 이 카드 헤더의 클릭 리스너를 통째로 지웠는데(=사용자가 카드를 여는 **주 경로**가
    //  죽는다) 2,791건이 전부 초록이었다. 1라운드가 «이음매를 하나로 모았다» 고 한 그
    //  지점의 출구만 지키고 입구는 아무도 안 보고 있었다.
    //  등급: **배선**(소스 대조) — 리스너를 실제로 누르려면 DOM 이 필요하고, 그 비용은
    //  이 한 줄이 지키는 것에 비해 크다. 여기가 잡는 것은 «클릭이 setJobOpen 에 닿는 배선이
    //  있는가» 하나다.
    const opener = codeLines.filter(
      (l) => /addEventListener\("click"/.test(l.text) && /setJobOpen\(jobId/.test(l.text),
    );
    out.push(
      assert(
        "★카드 헤더 클릭이 setJobOpen 에 닿는다(이 배선이 없으면 카드가 안 펼쳐진다)",
        opener.length >= 1,
        opener.length >= 1 ? opener[0]!.text.trim().slice(0, 62) : "★클릭 → setJobOpen 배선 0개",
      ),
    );

    // ─── ④ 문구가 두 언어에 다 있다 ──────────────────────────────────────
    for (const loc of ["ko", "en"]) {
      const cat = JSON.parse(read(`locales/${loc}.json`)) as Record<string, string>;
      out.push(
        assert(
          `${loc} 카탈로그에 bg.task.truncated 가 있다(서버는 언어를 만들지 않는다)`,
          typeof cat["bg.task.truncated"] === "string" &&
            cat["bg.task.truncated"].length > 0,
          cat["bg.task.truncated"] ?? "★없음",
        ),
      );
    }

    return out;
  },
};
