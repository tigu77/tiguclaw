/**
 * 회귀: **작업자 알림(`notify_owner`)을 설정으로 켜고 끈다 — 기본 꺼짐** (2026-11-02 정태님 «설정으로 컨트롤 가능한가 기본은 일단 꺼놓고»).
 * 설계 docs/decisions/2026-11-02-notify-owner-setting.md. 작업자 턴 쪽 관문(노출·호출·알림 턴·거두기 깨움)은 `job-notice` ⑥·⑮ 가 잰다 —
 * 여기는 **사람이 켜고 끄는 자리**와 그 값이 런타임 관문까지 같은 값으로 닿는지다.
 *
 * 등급: **동작** — ①자식 프로세스에서 진짜 브리지 HTTP(읽기 read 토큰 · 쓰기 write 토큰)로 저장·조회·레이어 대조 + 같은 프로세스의 런타임 관문
 *  ②진짜 `view-models.js` 를 미니 DOM 에 싣고 설정 화면 줄을 누른다(한도 자동 이어가기 줄과 **상태가 섞이지 않는가** 포함). + **배선**(프록시·문구).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync } from "./_wiring.js";

const CHILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "_notify-owner-setting-child.ts");

type Hit = { status: number; body: { enabled?: unknown; ok?: unknown; error?: unknown } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChildOut = Record<string, any>;
const en = (h: Hit | undefined): string => `${h?.status ?? "?"}:${String(h?.body?.enabled)}`;

/** 설정 화면을 연다 — 두 토글 줄(한도·작업자 알림)의 조회·저장 응답은 검사가 손으로 준다. 나머지 줄의 조회는 즉시 답한다. */
const bootSettings = () => {
  const clock = makeClock();
  const gates: Array<{ url: string; init: any; open: (body: unknown, status?: number) => void; fail: () => void }> = [];
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    fetch: (url: string, init?: any) => {
      if (/^\/api\/(set-)?(notify-owner|limit-resume)/.test(url))
        return new Promise((resolve, reject) => gates.push({ url, init, open: (b, s = 200) => resolve(jsonResponse(b, s)), fail: () => reject(new TypeError("Failed to fetch")) }));
      if (url.startsWith("/api/suggestion")) return Promise.resolve(jsonResponse({ enabled: true }));
      if (url.startsWith("/api/set-suggestion")) return Promise.resolve(jsonResponse({ ok: true, enabled: false })); // 제안 토글 → 설정 화면 통째로 다시 그림
      return Promise.resolve(jsonResponse({}, 404));
    },
    stubs: "const setChatPanel = () => {};",
  });
  const root = dash.document.getElementById("detail-panel") as MElement;
  const answer = (prefix: string, body: unknown, status = 200): { url: string; init: any } | undefined => {
    const i = gates.findIndex((g) => g.url === prefix);
    if (i < 0) return undefined;
    const [g] = gates.splice(i, 1);
    g!.open(body, status);
    return { url: g!.url, init: g!.init };
  };
  /** 그 요청을 **연결 실패**로 끝낸다(fetch reject). */
  const failNet = (prefix: string): boolean => {
    const i = gates.findIndex((g) => g.url === prefix);
    if (i < 0) return false;
    const [g] = gates.splice(i, 1);
    g!.fail();
    return true;
  };
  const rowBtn = (id: string) => root.querySelector(`[data-settings-row="${id}"] .settings-toggle`) as MElement | null;
  const btn = () => rowBtn("notify-owner");
  return { clock, dash, root, answer, failNet, btn, rowBtn, gates };
};
const state = (b: MElement | null): string => (b === null ? "줄 없음" : `on=${String(b.classList.contains("on"))} disabled=${String(b.disabled)} «${b.textContent}»`);
const bodyOf = (x: { init: any } | undefined): any => { try { return JSON.parse(String(x?.init?.body)); } catch { return null; } };

export const check: RegressionCheck = {
  name: "notify-owner-setting",
  guards:
    "작업자 알림(notify_owner)을 기본 꺼짐으로 두고 설정 화면에서 켜고 끄게 하면서 생길 수 있는 것 — 키 없는 기존 설치가 켜짐으로 읽힘·화면 값과 작업자 턴이 읽는 값이 갈림·진행 알림(jobs.progressNotice) 등 다른 설정 덮어쓰기·깨진 파일 위 쓰기·read 토큰 쓰기·조회 실패를 «꺼짐» 으로 표시·한도 줄과 저장 상태가 섞임 (2026-11-02 사용자 요청)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 저장·조회 사슬 + 런타임 관문 — 자식 프로세스의 진짜 브리지 ─────────────────────
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], { encoding: "utf8", timeout: 60_000, env: process.env });
    let c: ChildOut = {};
    try {
      c = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as ChildOut;
    } catch {
      c = {};
    }
    const tail = `stderr ${(r.stderr ?? "").slice(-300)}`;
    out.push(
      assert(
        "★★키 없는 기존 홈 — 조회(read 토큰) 200 «꺼짐» · **작업자 턴에도 도구 없음** · 파일 불변(같은 `jobs` 블록의 진행 알림 설정이 있어도)",
        en(c.missingGet) === "200:false" && c.missingRuntime === false && c.missingUntouched === true,
        `GET ${en(c.missingGet)} · 런타임=${String(c.missingRuntime)} · 파일 불변=${String(c.missingUntouched)} ${c.missingGet === undefined ? tail : ""}`,
      ),
      assert(
        "불리언이 아닌 본문 400 · read 토큰 쓰기 403 — 파일 불변",
        c.badBody?.status === 400 && c.readTokenPost?.status === 403 && c.rejectUntouched === true,
        `본문 → ${c.badBody?.status ?? "?"} · read 쓰기 → ${c.readTokenPost?.status ?? "?"} · 파일 불변=${String(c.rejectUntouched)}`,
      ),
      assert(
        "★★켜기 → `jobs.notifyOwner.enabled: true` 만 더해지고 `jobs.progressNotice`·`limitResume`·다른 설정은 **그 값 그대로**(켜기·끄기 둘 다 그 한 값 말고는 파일이 같다) · 조회·**작업자 턴 도구** 켜짐(재시작 없이) · 끄기 → 둘 다 꺼짐",
        en(c.on) === "200:true" && c.afterOnOthersSame === true && c.afterOffOthersSame === true && c.afterOnFile?.jobs?.notifyOwner?.enabled === true && c.afterOnFile?.jobs?.progressNotice?.intervalMinutes === 30 &&
          c.afterOnFile?.jobs?.progressNotice?.enabled === true && c.afterOnFile?.theme === "regr-keep" && en(c.afterOnGet) === "200:true" && c.afterOnRuntime === true &&
          en(c.off) === "200:false" && c.afterOffFile?.jobs?.notifyOwner?.enabled === false && c.afterOffFile?.jobs?.progressNotice?.intervalMinutes === 30 &&
          en(c.afterOffGet) === "200:false" && c.afterOffRuntime === false,
        `나머지 불변 켜기=${String(c.afterOnOthersSame)} 끄기=${String(c.afterOffOthersSame)} · 켜기 ${en(c.on)} 파일=${JSON.stringify(c.afterOnFile)} GET ${en(c.afterOnGet)} 런타임=${String(c.afterOnRuntime)} · 끄기 ${en(c.off)} GET ${en(c.afterOffGet)} 런타임=${String(c.afterOffRuntime)}`,
      ),
      assert(
        "불리언이 아닌 값(`\"true\"`)은 꺼짐으로 읽는다(조회·런타임) · 켜기·끄기 모두 같은 블록의 다른 키는 보존된다",
        en(c.nonBoolGet) === "200:false" && c.nonBoolRuntime === false && en(c.blockKeep) === "200:true" &&
          c.blockKeepFile?.jobs?.notifyOwner?.regrExtra === 7 && c.blockKeepFile?.jobs?.notifyOwner?.enabled === true &&
          en(c.blockKeepOff) === "200:false" && c.blockKeepOffFile?.jobs?.notifyOwner?.regrExtra === 7 && c.blockKeepOffFile?.jobs?.notifyOwner?.enabled === false,
        `GET ${en(c.nonBoolGet)} 런타임=${String(c.nonBoolRuntime)} · 켜기 파일=${JSON.stringify(c.blockKeepFile)} · 끄기 파일=${JSON.stringify(c.blockKeepOffFile)}`,
      ),
      assert(
        "★깨진 settings.json(JSON 아님·최상위 배열) 위에 덮어쓰지 않는다 — 500 · 파일 그대로",
        c.broken?.status === 500 && c.brokenUntouched === true && c.arrayRoot?.status === 500 && c.arrayRootUntouched === true,
        `깨진 JSON → ${c.broken?.status ?? "?"} 불변=${String(c.brokenUntouched)} · 배열 → ${c.arrayRoot?.status ?? "?"} 불변=${String(c.arrayRootUntouched)}`,
      ),
      assert(
        "★★레이어 대조 — 프로젝트(.tiguclaw)가 켜 두면 홈에 «끄기» 를 써도 응답·조회·**런타임** 모두 유효값 true · 홈 파일 false · 프로젝트 파일 불변",
        en(c.layerPost) === "200:true" && en(c.layerGet) === "200:true" && c.layerRuntime === true &&
          c.layerHomeFile?.jobs?.notifyOwner?.enabled === false && c.layerProjUntouched === true,
        `POST false → ${en(c.layerPost)} · GET ${en(c.layerGet)} · 런타임=${String(c.layerRuntime)} · 홈=${JSON.stringify(c.layerHomeFile?.jobs)} · 프로젝트 불변=${String(c.layerProjUntouched)}`,
      ),
      assert(
        "★레이어 반대 방향 — 홈이 켜 두고 프로젝트가 명시적으로 끄면 조회·런타임 모두 꺼짐(뒤 레이어가 이긴다)",
        en(c.layerOffGet) === "200:false" && c.layerOffRuntime === false,
        `GET ${en(c.layerOffGet)} · 런타임=${String(c.layerOffRuntime)}`,
      ),
    );

    // ── ② 설정 화면 줄 — 진짜 view-models.js ────────────────────────────────
    {
      const { clock, dash, root, answer, btn } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      const rows = [...root.querySelectorAll("[data-settings-row]")].map((x) => (x as MElement).getAttribute("data-settings-row"));
      const at = rows.indexOf("notify-owner");
      const loadingState = state(btn());
      const loadingOk = btn() !== null && btn()!.disabled === true && !btn()!.classList.contains("on");
      const got = answer("/api/notify-owner", { enabled: false });
      await clock.advance(5);
      const offState = state(btn());
      const offOk = btn() !== null && btn()!.disabled === false && !btn()!.classList.contains("on");
      btn()?.click();
      await clock.advance(5);
      const saving = btn()?.disabled === true;
      const sent = answer("/api/set-notify-owner", { ok: true, enabled: true });
      await clock.advance(5);
      const onState = state(btn());
      out.push(
        assert(
          "★★설정 화면에 «작업자 알림» 줄이 **실제로 붙어 있고**(한도 자동 이어가기 바로 아래), 조회 응답 전엔 잠겨 있다(모르는 값을 «꺼짐» 으로 그리지 않는다)",
          at > 0 && rows[at - 1] === "limit-resume" && loadingOk && got !== undefined,
          `줄 순서 ${JSON.stringify(rows)} · 응답 전 ${loadingState}`,
        ),
        assert(
          "조회 «꺼짐» → 꺼짐으로 그림 → 누르면 POST /api/set-notify-owner {enabled:true} · 저장 중 잠금 → 응답값(true)으로 다시 그림",
          offOk && saving && sent?.init?.method === "POST" && bodyOf(sent)?.enabled === true && btn()?.classList.contains("on") === true && btn()?.disabled === false,
          `꺼짐 ${offState} · 저장 중 잠금=${String(saving)} · 본문 ${JSON.stringify(bodyOf(sent))} · 뒤 ${onState}`,
        ),
      );
    }
    {
      // 켜짐 → 끄기 · 응답 유효값이 요청과 다르면 그 값 · 저장 실패면 원래 값 유지.
      const { clock, dash, answer, btn } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/notify-owner", { enabled: true });
      await clock.advance(5);
      btn()?.click();
      await clock.advance(5);
      const offSent = answer("/api/set-notify-owner", { ok: true, enabled: false });
      await clock.advance(5);
      const offNow = btn()?.classList.contains("on") === false && btn()?.disabled === false;
      btn()?.click();
      await clock.advance(5);
      answer("/api/set-notify-owner", { ok: true, enabled: false }); // 켜기를 눌렀지만 유효값은 여전히 꺼짐(프로젝트가 덮음)
      await clock.advance(5);
      const stillOff = btn()?.classList.contains("on") === false && btn()?.disabled === false;
      btn()?.click();
      await clock.advance(5);
      answer("/api/set-notify-owner", { error: "boom" }, 500);
      await clock.advance(5);
      const keptAfterFail = btn()?.classList.contains("on") === false && btn()?.disabled === false;
      out.push(
        assert(
          "★★켜짐에서 누르면 POST {enabled:false} → 꺼짐 · 다시 그릴 땐 **서버가 돌려준 유효값** · 저장 실패면 원래 값·다시 누를 수 있음",
          bodyOf(offSent)?.enabled === false && offNow && stillOff && keptAfterFail,
          `끄기 본문 ${JSON.stringify(bodyOf(offSent))} · 꺼짐=${String(offNow)} · 유효값 유지=${String(stillOff)} · 실패 뒤 ${state(btn())}`,
        ),
      );
    }
    {
      // ★두 토글 줄의 저장 상태가 섞이지 않는다 — 공용 줄 함수(`makeServerToggleRow`)가 토글마다 자기 잠금·세대를 갖는가.
      const { clock, dash, answer, btn, rowBtn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: false });
      answer("/api/notify-owner", { enabled: false });
      await clock.advance(5);
      rowBtn("limit-resume")?.click(); // 한도 저장 대기
      await clock.advance(5);
      const limitLocked = rowBtn("limit-resume")?.disabled === true;
      const notifyFree = btn()?.disabled === false;
      btn()?.click(); // 작업자 알림 저장 — 한도 저장 중에도 나가야 한다
      await clock.advance(5);
      const notifyPosted = gates.some((g) => g.url === "/api/set-notify-owner");
      answer("/api/set-notify-owner", { ok: true, enabled: true });
      await clock.advance(5);
      const limitStillLocked = rowBtn("limit-resume")?.disabled === true; // 작업자 알림 저장이 끝나도 한도 잠금은 그대로
      const notifyOn = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      answer("/api/set-limit-resume", { ok: true, enabled: true });
      await clock.advance(5);
      const limitOn = rowBtn("limit-resume")?.classList.contains("on") === true && rowBtn("limit-resume")?.disabled === false;
      const notifyUntouched = btn()?.classList.contains("on") === true; // 한도 응답이 작업자 알림 줄을 다시 그리지 않는다
      out.push(
        assert(
          "★두 토글 줄의 저장 잠금·결과가 섞이지 않는다 — 한도 저장 중에도 작업자 알림을 저장할 수 있고, 각 응답은 제 줄만 그린다",
          limitLocked && notifyFree && notifyPosted && limitStillLocked && notifyOn && limitOn && notifyUntouched,
          `한도 잠금=${String(limitLocked)} · 알림 누를 수 있음=${String(notifyFree)} · 알림 저장 나감=${String(notifyPosted)} · 한도 잠금 유지=${String(limitStillLocked)} · 알림 ${state(btn())} · 한도 ${state(rowBtn("limit-resume"))}`,
        ),
      );
    }
    for (const [why, body, status] of [
      ["오류 응답", { error: "down" }, 502], ["값 없는 성공 응답", { ok: true }, 200], ["불리언이 아닌 값", { enabled: "false" }, 200], ["연결 실패", null, 0],
    ] as const) {
      // 조회 실패·값 없는 응답·문자열 값·연결 실패 — «꺼짐»/«켜짐» 으로 추정하지 않는다(잠금 · 눌러도 아무것도 안 보냄). 독립 변이 사냥 B4 · 재사냥 B·D.
      const { clock, dash, answer, failNet, btn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      if (body === null) failNet("/api/notify-owner");
      else answer("/api/notify-owner", body, status);
      await clock.advance(5);
      const b = btn();
      const failState = state(b);
      b?.click();
      await clock.advance(5);
      const posted = gates.some((g) => g.url === "/api/set-notify-owner");
      out.push(
        assert(
          `★★조회 결과가 «${why}» 일 때 잠그고 값을 추정해 그리지 않는다 — 눌러도 저장 요청이 나가지 않는다`,
          b !== null && b.disabled === true && !b.classList.contains("on") && b.textContent !== i18nForContext("common.off") && !posted,
          `${failState} · 저장 요청=${String(posted)}`,
        ),
      );
    }
    {
      // 저장 응답에 유효값이 없으면(200 {ok:true}) 저장 실패로 보고 원래 값 유지 · 다시 누를 수 있음(재사냥 C — 조회가 아니라 저장 경로).
      const { clock, dash, answer, btn } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/notify-owner", { enabled: false });
      await clock.advance(5);
      btn()?.click();
      await clock.advance(5);
      answer("/api/set-notify-owner", { ok: true });
      await clock.advance(5);
      out.push(
        assert(
          "★저장 응답에 유효값이 없으면 실패로 본다 — 꺼짐 그대로·다시 누를 수 있음(요청값으로 «켜짐» 을 지어내지 않는다)",
          btn()?.classList.contains("on") === false && btn()?.disabled === false && btn()?.textContent === i18nForContext("common.off"),
          state(btn()),
        ),
      );
    }
    {
      // ★저장 대기 중 설정 화면이 다시 그려져도 «작업자 알림» 줄은 잠긴 채다 — 조회가 끝나도 두 번째 저장을 못 보낸다(재사냥 I · 한도 줄 GPT R2 와 같은 규칙).
      const { clock, dash, root, answer, btn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/notify-owner", { enabled: false });
      await clock.advance(5);
      const oldBtn = btn();
      oldBtn?.click(); // 켜기 저장 대기
      await clock.advance(5);
      (root.querySelector(".settings-row .settings-toggle") as MElement | null)?.click(); // 제안 토글 → 화면 통째로 다시 그림
      await clock.advance(5);
      answer("/api/notify-owner", { enabled: true }); // 새 줄 조회 — 저장이 이미 반영된 서버 값
      await clock.advance(5);
      const redrawn = btn() !== null && btn() !== oldBtn;
      const lockedState = state(btn());
      const locked = btn()?.disabled === true;
      btn()?.click(); // 두 번째 저장 시도 — 나가면 안 된다
      await clock.advance(5);
      const posts = gates.filter((g) => g.url === "/api/set-notify-owner").length;
      answer("/api/set-notify-owner", { ok: true, enabled: true });
      await clock.advance(5);
      const released = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      out.push(
        assert(
          "★★저장 대기 중 다시 그려진 «작업자 알림» 줄은 조회가 끝나도 잠겨 있어 두 번째 저장을 못 보낸다 · 저장이 끝나면 그 값으로 풀린다",
          redrawn && locked && posts === 1 && released,
          `다시 그려짐=${String(redrawn)} · 조회 뒤 ${lockedState} · 저장 대기 수=${posts} · 끝난 뒤 ${state(btn())}`,
        ),
      );
    }

    // ── ③ 배선 — 대시보드 프록시가 두 경로를 브리지로 넘긴다 · 문구 두 언어 ───────────
    const proxy = readSourceSync("packages/dashboard/index.ts");
    const ko = readSourceSync("locales/ko.json");
    const enCat = readSourceSync("locales/en.json");
    const keys = ["settings.notifyOwner.head", "settings.notifyOwner.hint", "settings.notifyOwner.toggled", "settings.notifyOwner.unknown"];
    out.push(
      assert(
        "★대시보드 프록시가 /api/notify-owner·/api/set-notify-owner 를 브리지 /notify-owner·/set-notify-owner 로 넘긴다",
        /"\/api\/set-notify-owner" && method === "POST"[\s\S]{0,200}?proxyJson\(res, "\/set-notify-owner"/.test(proxy) &&
          /"\/api\/notify-owner" && method === "GET"[\s\S]{0,80}?proxyJson\(res, "\/notify-owner"/.test(proxy),
        "프록시 두 경로",
      ),
      assert(
        "문구가 두 언어 다 있다",
        keys.every((k) => ko.includes(`"${k}"`) && enCat.includes(`"${k}"`)),
        `ko ${keys.filter((k) => ko.includes(`"${k}"`)).length}/4 · en ${keys.filter((k) => enCat.includes(`"${k}"`)).length}/4`,
      ),
    );
    return out;
  },
};
