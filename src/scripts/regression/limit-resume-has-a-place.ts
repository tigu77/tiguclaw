/**
 * 회귀: **한도 자동 이어가기를 사람이 켜고 끌 자리가 있다** (2026-10-23 사용자 «대시보드 설정에 빠졌다고»).
 *
 * ★사고 모양은 `memory-cap-has-a-place` 와 같다: `limitResume.enabled` 를 옵션으로 내놨는데 `settings.json` 을 손으로 고쳐야만
 *  켜졌다(대시보드·브리지 참조 0건). 설계 docs/decisions/2026-10-23-limit-resume-dashboard-toggle.md.
 *
 * 등급: **동작** — ①자식 프로세스에서 진짜 브리지 HTTP(읽기 read 토큰 · 쓰기 write 토큰)로 저장·조회·레이어 대조
 *  ②진짜 `view-models.js` 를 미니 DOM 에 싣고 설정 화면 줄을 누른다. + **배선**(대시보드 프록시가 두 경로를 넘기나).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootDashboard, jsonResponse, makeClock, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync } from "./_wiring.js";

const CHILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "_limit-resume-setting-child.ts");

type Hit = { status: number; body: { enabled?: unknown; ok?: unknown; error?: unknown } | null };
type ChildOut = Record<string, unknown> & {
  missingGet?: Hit; missingUntouched?: boolean; badBody?: Hit; badBodyUntouched?: boolean;
  on?: Hit; afterOnFile?: Record<string, any>; afterOnGet?: Hit; off?: Hit; afterOffFile?: Record<string, any>; afterOffGet?: Hit;
  blockKeep?: Hit; blockKeepFile?: Record<string, any>; broken?: Hit; brokenUntouched?: boolean;
  layerPost?: Hit; layerGet?: Hit; layerHomeFile?: Record<string, any>; layerProjUntouched?: boolean;
  legacyGet?: Hit; legacyPost?: Hit; legacyHomeFile?: Record<string, any>;
};
const en = (h: Hit | undefined): string => `${h?.status ?? "?"}:${String(h?.body?.enabled)}`;

/** 설정 화면을 연다 — `/api/limit-resume` 응답은 검사가 손으로 준다. 나머지 줄의 조회는 즉시 답한다. */
const bootSettings = () => {
  const clock = makeClock();
  const gates: Array<{ url: string; init: any; open: (body: unknown, status?: number) => void }> = [];
  const dash = bootDashboard({
    clock,
    i18n: i18nForContext,
    fetch: (url: string, init?: any) => {
      if (url.startsWith("/api/limit-resume") || url.startsWith("/api/set-limit-resume"))
        return new Promise((resolve) => gates.push({ url, init, open: (b, s = 200) => resolve(jsonResponse(b, s)) }));
      if (url.startsWith("/api/suggestion")) return Promise.resolve(jsonResponse({ enabled: true }));
      if (url.startsWith("/api/set-suggestion")) return Promise.resolve(jsonResponse({ ok: true, enabled: false }));
      return Promise.resolve(jsonResponse({}, 404));
    },
    stubs: "const setChatPanel = () => {};",
  });
  const root = dash.document.getElementById("detail-panel") as MElement;
  const answer = (prefix: string, body: unknown, status = 200): { url: string; init: any } | undefined => {
    const i = gates.findIndex((g) => g.url.startsWith(prefix));
    if (i < 0) return undefined;
    const [g] = gates.splice(i, 1);
    g!.open(body, status);
    return { url: g!.url, init: g!.init };
  };
  const btn = () => root.querySelector('[data-settings-row="limit-resume"] .settings-toggle') as MElement | null;
  return { clock, dash, root, answer, btn, gates };
};
const state = (b: MElement | null): string => (b === null ? "줄 없음" : `on=${String(b.classList.contains("on"))} disabled=${String(b.disabled)} «${b.textContent}»`);

export const check: RegressionCheck = {
  name: "limit-resume-has-a-place",
  guards:
    "한도 자동 이어가기(limitResume.enabled)를 옵션으로 내놓고 대시보드엔 켜고 끌 자리가 없어 settings.json 을 손으로 고쳐야만 켜지던 것 — 그리고 그 자리가 생기며 생길 수 있는 것(유효값 대신 요청값 표시·조회 실패를 «꺼짐» 으로 표시·다른 설정 덮어쓰기·깨진 파일 위 쓰기) (2026-10-23 사용자 신고)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 저장·조회 사슬 — 자식 프로세스의 진짜 브리지 ─────────────────────────
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
        "★★키 없는 기존 홈 — 조회(read 토큰)는 200 «꺼짐» 이고 **파일을 바꾸지 않는다**(누를 때까지 그대로)",
        c.missingGet?.status === 200 && c.missingGet.body?.enabled === false && c.missingUntouched === true,
        `GET ${en(c.missingGet)} · 파일 불변=${String(c.missingUntouched)} ${c.missingGet === undefined ? tail : ""}`,
      ),
      assert(
        "불리언이 아닌 본문은 400 · 파일 불변",
        c.badBody?.status === 400 && c.badBodyUntouched === true,
        `POST {enabled:"yes"} → ${c.badBody?.status ?? "?"} · 파일 불변=${String(c.badBodyUntouched)}`,
      ),
      assert(
        "★★켜기 → `limitResume.enabled: true` 만 더해지고 다른 설정은 그대로 · 조회도 켜짐 · 끄기 → false",
        en(c.on) === "200:true" && c.afterOnFile?.limitResume?.enabled === true && c.afterOnFile?.theme === "regr-keep" &&
          c.afterOnFile?.models?.default === "keep" && en(c.afterOnGet) === "200:true" &&
          en(c.off) === "200:false" && c.afterOffFile?.limitResume?.enabled === false && c.afterOffFile?.theme === "regr-keep" && en(c.afterOffGet) === "200:false",
        `켜기 ${en(c.on)} 파일=${JSON.stringify(c.afterOnFile)} GET ${en(c.afterOnGet)} · 끄기 ${en(c.off)} GET ${en(c.afterOffGet)}`,
      ),
      assert(
        "같은 블록의 다른 키는 보존된다(블록 통째 교체 금지)",
        en(c.blockKeep) === "200:true" && c.blockKeepFile?.limitResume?.regrExtra === 7 && c.blockKeepFile?.limitResume?.enabled === true,
        `파일=${JSON.stringify(c.blockKeepFile)}`,
      ),
      assert(
        "★깨진 settings.json 위에 덮어쓰지 않는다 — 500 · 파일 그대로",
        c.broken?.status === 500 && c.brokenUntouched === true,
        `POST → ${c.broken?.status ?? "?"} · 파일 불변=${String(c.brokenUntouched)}`,
      ),
      assert(
        "★★레이어 대조 — 프로젝트(.tiguclaw)가 켜 두면 홈에 «끄기» 를 써도 응답·조회는 **유효값 true** · 홈 파일은 false · 프로젝트 파일 불변",
        en(c.layerPost) === "200:true" && en(c.layerGet) === "200:true" && c.layerHomeFile?.limitResume?.enabled === false && c.layerProjUntouched === true,
        `POST false → ${en(c.layerPost)} · GET ${en(c.layerGet)} · 홈=${JSON.stringify(c.layerHomeFile?.limitResume)} · 프로젝트 불변=${String(c.layerProjUntouched)}`,
      ),
      assert(
        "레거시 `<cwd>/settings.json` 이 `.tiguclaw` 를 덮는다 — 조회·쓰기 응답 모두 그 유효값",
        en(c.legacyGet) === "200:false" && en(c.legacyPost) === "200:false" && c.legacyHomeFile?.limitResume?.enabled === true,
        `GET ${en(c.legacyGet)} · POST true → ${en(c.legacyPost)} · 홈=${JSON.stringify(c.legacyHomeFile?.limitResume)}`,
      ),
    );

    // ── ② 설정 화면 줄 — 진짜 view-models.js ────────────────────────────────
    {
      const { clock, dash, answer, btn } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      const loading = btn();
      const loadingState = state(loading);
      const loadingOk = loading !== null && loading.disabled === true && !loading.classList.contains("on");
      const got = answer("/api/limit-resume", { enabled: false });
      await clock.advance(5);
      const offState = state(btn());
      const offOk = btn() !== null && btn()!.disabled === false && !btn()!.classList.contains("on");
      btn()?.click();
      await clock.advance(5);
      const saving = btn()?.disabled === true;
      const sent = answer("/api/set-limit-resume", { ok: true, enabled: true });
      await clock.advance(5);
      const sentBody = (() => { try { return JSON.parse(String(sent?.init?.body)); } catch { return null; } })();
      const onState = state(btn());
      out.push(
        assert(
          "★★설정 화면에 줄이 **실제로 붙어 있고**, 조회 응답 전엔 잠겨 있다(모르는 값을 «꺼짐» 으로 그리지 않는다)",
          loadingOk && got !== undefined,
          `응답 전 ${loadingState}`,
        ),
        assert(
          "조회 «꺼짐» → 꺼짐으로 그림 → 누르면 POST /api/set-limit-resume {enabled:true} · 저장 중 잠금 → 응답값(true)으로 다시 그림",
          offOk && saving && sent?.init?.method === "POST" && sentBody?.enabled === true && btn()?.classList.contains("on") === true && btn()?.disabled === false,
          `꺼짐 ${offState} · 저장 중 잠금=${String(saving)} · 본문 ${JSON.stringify(sentBody)} · 뒤 ${onState}`,
        ),
      );
    }
    {
      // 조회 «켜짐» · 저장 응답이 요청과 다른 유효값(프로젝트가 덮음)이면 그 값을 그린다 · 실패면 원래 값 유지.
      const { clock, dash, answer, btn } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: true });
      await clock.advance(5);
      const onFirst = btn()?.classList.contains("on") === true;
      btn()?.click();
      await clock.advance(5);
      answer("/api/set-limit-resume", { ok: true, enabled: true }); // 끄기를 눌렀지만 유효값은 여전히 켜짐
      await clock.advance(5);
      const stillOn = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      btn()?.click();
      await clock.advance(5);
      answer("/api/set-limit-resume", { error: "boom" }, 500);
      await clock.advance(5);
      const keptAfterFail = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      out.push(
        assert(
          "★★다시 그릴 땐 **서버가 돌려준 유효값**을 쓴다(끄기를 눌렀어도 유효값이 켜짐이면 켜짐) · 저장 실패면 원래 값·다시 누를 수 있음",
          onFirst && stillOn && keptAfterFail,
          `처음 켜짐=${String(onFirst)} · 유효값 유지=${String(stillOn)} · 실패 뒤 ${state(btn())}`,
        ),
      );
    }
    {
      // 켜짐 → 끄기 정상 경로(GPT 코드 R1 검사 부족) — 본문 false · 응답 false → 꺼짐 · 다시 누를 수 있음.
      const { clock, dash, answer, btn } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: true });
      await clock.advance(5);
      btn()?.click();
      await clock.advance(5);
      const sent = answer("/api/set-limit-resume", { ok: true, enabled: false });
      await clock.advance(5);
      const body = (() => { try { return JSON.parse(String(sent?.init?.body)); } catch { return null; } })();
      out.push(
        assert(
          "★★켜짐에서 누르면 POST {enabled:false} · 응답 false → 꺼짐으로 그리고 다시 누를 수 있다",
          body?.enabled === false && btn()?.classList.contains("on") === false && btn()?.disabled === false,
          `본문 ${JSON.stringify(body)} · 뒤 ${state(btn())}`,
        ),
      );
    }
    {
      // ★저장 대기 중 설정 화면이 통째로 다시 그려진다(제안 토글 저장 → renderSettingsRow) — GPT 코드 R1 재현 순서 그대로.
      //  새 줄의 조회는 저장 전 값(false)을 늦게 받는다. 저장 성공(true)은 **지금 화면의 줄**에 그려지고, 늦은 옛 조회는 버려져야 한다.
      const { clock, dash, root, answer, btn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: false });
      await clock.advance(5);
      const oldBtn = btn();
      oldBtn?.click(); // 한도 켜기 — 저장 대기
      await clock.advance(5);
      (root.querySelector(".settings-row .settings-toggle") as MElement | null)?.click(); // 제안 토글 → 화면 통째로 다시 그림
      await clock.advance(5);
      const replaced = btn() !== null && btn() !== oldBtn;
      answer("/api/set-limit-resume", { ok: true, enabled: true }); // 저장 성공
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: false }); // 새 줄의 조회 — 저장 전에 나가 낡은 값
      await clock.advance(5);
      const afterState = state(btn());
      const onNow = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      btn()?.click();
      await clock.advance(5);
      const next = gates.find((g) => g.url.startsWith("/api/set-limit-resume"));
      const nextBody = (() => { try { return JSON.parse(String(next?.init?.body)); } catch { return null; } })();
      out.push(
        assert(
          "★★저장 대기 중 설정 화면이 다시 그려져도 저장 결과(켜짐)가 **지금 줄**에 그려지고 늦은 옛 조회(꺼짐)가 덮지 않는다 · 다음 클릭은 끄기",
          replaced && onNow && nextBody?.enabled === false,
          `다시 그려짐=${String(replaced)} · 지금 줄 ${afterState} · 다음 클릭 본문 ${JSON.stringify(nextBody)}`,
        ),
      );
    }
    {
      // ★저장 응답 역전(GPT 코드 R2 재현 순서) — 켜기 A 가 서버에 반영됐는데 응답이 늦는 사이 화면이 다시 그려지고, 새 줄의 조회가 true 를
      //  받는다. 새 줄에서 끄기 B 를 보낼 수 있으면 B(false) 뒤에 늦은 A(true) 가 화면을 «켜짐» 으로 되돌린다(서버는 false).
      //  저장 중 잠금은 **줄 수명 밖**이라 다시 그려진 줄·재진입한 줄도 저장이 끝날 때까지 누를 수 없고, 조회가 그 잠금을 풀지 않는다.
      const { clock, dash, root, answer, btn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: false });
      await clock.advance(5);
      const oldBtn = btn();
      oldBtn?.click(); // A — 켜기 저장 대기
      await clock.advance(5);
      (root.querySelector(".settings-row .settings-toggle") as MElement | null)?.click(); // 제안 토글 → 다시 그림
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: true }); // 새 줄 조회 — A 가 이미 반영된 서버 값
      await clock.advance(5);
      const lockedState = state(btn());
      const lockedAfterLoad = btn() !== null && btn() !== oldBtn && btn()!.disabled === true;
      btn()?.click(); // B 시도 — 나가면 안 된다
      await clock.advance(5);
      const posts = gates.filter((g) => g.url.startsWith("/api/set-limit-resume")).length;
      answer("/api/set-limit-resume", { ok: true, enabled: true }); // 늦은 A
      await clock.advance(5);
      const afterA = state(btn());
      const onUnlocked = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      btn()?.click();
      await clock.advance(5);
      const nextBody = (() => { try { return JSON.parse(String(gates.find((g) => g.url.startsWith("/api/set-limit-resume"))?.init?.body)); } catch { return null; } })();
      out.push(
        assert(
          "★★저장 대기 중 다시 그려진 줄은 조회가 끝나도 **잠겨 있어** 두 번째 저장을 못 보낸다 · 늦은 응답 뒤 그 값(켜짐)으로 풀리고 다음 클릭은 끄기",
          lockedAfterLoad && posts === 1 && onUnlocked && nextBody?.enabled === false,
          `조회 뒤 ${lockedState} · 저장 대기 수=${posts} · A 뒤 ${afterA} · 다음 본문 ${JSON.stringify(nextBody)}`,
        ),
      );
    }
    {
      // 같은 잠금의 실패 경로 + 이탈·재진입 — 저장 중 모델 화면으로 갔다가 설정으로 돌아온 줄도 잠겨 있고, 저장이 **실패**해도 지금 줄은 풀린다.
      const { clock, dash, answer, btn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: true });
      await clock.advance(5);
      btn()?.click(); // 끄기 저장 대기
      await clock.advance(5);
      dash.run("showModels()");
      await clock.advance(5);
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { enabled: true });
      await clock.advance(5);
      const reentryState = state(btn());
      const lockedOnReentry = btn() !== null && btn()!.disabled === true;
      answer("/api/set-limit-resume", { error: "boom" }, 500); // 저장 실패
      await clock.advance(5);
      const afterFail = state(btn());
      const releasedOnFail = btn()?.classList.contains("on") === true && btn()?.disabled === false;
      btn()?.click();
      await clock.advance(5);
      const retried = gates.some((g) => g.url.startsWith("/api/set-limit-resume"));
      out.push(
        assert(
          "★저장 중 이탈 뒤 재진입한 줄도 잠겨 있고, 저장이 실패하면 지금 줄이 풀려 다시 누를 수 있다(잠금이 남지 않는다)",
          lockedOnReentry && releasedOnFail && retried,
          `재진입 ${reentryState} · 실패 뒤 ${afterFail} · 재시도 나감=${String(retried)}`,
        ),
      );
    }
    {
      // 조회 실패 — «꺼짐» 으로 추정하지 않는다(잠금 · 눌러도 아무것도 안 보냄).
      const { clock, dash, answer, btn, gates } = bootSettings();
      dash.run("showSettings()");
      await clock.advance(5);
      answer("/api/limit-resume", { error: "down" }, 502);
      await clock.advance(5);
      const b = btn();
      const failState = state(b);
      b?.click();
      await clock.advance(5);
      const posted = gates.some((g) => g.url.startsWith("/api/set-limit-resume"));
      out.push(
        assert(
          "★★조회 실패면 잠그고 «꺼짐» 으로 그리지 않는다 — 눌러도 저장 요청이 나가지 않는다",
          b !== null && b.disabled === true && !b.classList.contains("on") && b.textContent !== i18nForContext("common.off") && !posted,
          `${failState} · 저장 요청=${String(posted)}`,
        ),
      );
    }

    // ── ③ 배선 — 대시보드 프록시가 두 경로를 브리지로 넘긴다 · 문구 두 언어 ───────────
    const proxy = readSourceSync("packages/dashboard/index.ts");
    const ko = readSourceSync("locales/ko.json");
    const enCat = readSourceSync("locales/en.json");
    const keys = ["settings.limitResume.head", "settings.limitResume.hint", "settings.limitResume.toggled", "settings.limitResume.unknown"];
    out.push(
      assert(
        "★대시보드 프록시가 /api/limit-resume·/api/set-limit-resume 를 브리지 /limit-resume·/set-limit-resume 로 넘긴다",
        /"\/api\/set-limit-resume" && method === "POST"[\s\S]{0,200}?proxyJson\(res, "\/set-limit-resume"/.test(proxy) &&
          /"\/api\/limit-resume" && method === "GET"[\s\S]{0,80}?proxyJson\(res, "\/limit-resume"/.test(proxy),
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
