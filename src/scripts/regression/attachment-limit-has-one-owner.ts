/**
 * 회귀: **첨부 상한의 주인은 하나다 — 서버** (2026-09-15 정태님 신고로 생겼다).
 *
 * ★사고: v0.54.0 이 *"20MB per file … A file that Telegram accepted but the dashboard
 *  rejected now works in both"* 이라고 내보냈는데 **대시보드에선 여전히 10MB 에서 막혔다.**
 *  같은 계약이 **네 곳**에 살고 있었고 서버 둘만 올라갔다:
 *
 *      attachments.ts 20MB ✅ · telegram-channel 20MB ✅
 *      chat-send.js   10MB ❌ · locales 문구 "10MB"  ❌
 *
 *  그래서 화면이 **보내기도 전에** 거절했다 — 서버는 받을 수 있는데 손잡이가 닫혀 있었다.
 *
 * ★**왜 그날의 그물이 못 잡았나**가 이 검사의 설계를 정한다. 있던 단정은 «서버 두 상수가
 *  같다» 와 «유도식이 성립한다» 였고, 그 «둘» 에 브라우저가 **애초에 안 들어 있었다.**
 *  상수를 비교하는 검사는 자리를 하나 빼먹으면 조용하다. 그래서 여기서는 **실행**한다 —
 *  서버 핸들러를 진짜 부르고(①), 화면의 판정 함수를 진짜 돌린다(②).
 *
 * ★②의 15MB 단정이 **이 사고 자체**다. 서버가 20MB 라고 말할 때 15MB 파일이 거절되면
 *  빨개진다 — 숫자를 어디에 적든 이 단정은 계약을 본다.
 *
 * ★③은 **이름이 갈리는 것**을 잡는다. 서버가 `attachment_bytes` 로 내고 화면이
 *  `attachmentBytes` 를 읽으면 둘 다 «상한을 다룬다» 인데 값은 영원히 `undefined` 고,
 *  그러면 화면은 «모른다» 로 떨어져 **미리 막지 않는다** — 조용히 종전으로 돌아간다.
 *  기대 키는 손으로 적지 않고 **서버 응답에서 가져온다**([[feedback_hand_maintained_lists]]).
 *
 * ★④는 **문구에 박힌 수**를 잡는다. 이번 사고의 네 번째 자리가 거기였다 — 코드가 20MB 로
 *  돌아도 문장이 "10MB 초과" 라고 말하면 사용자에게는 여전히 거짓이다.
 *
 * ★⑤는 숫자가 **돌아오는 것**을 잡는다. 주석은 지운 뒤 센다 — 주석 안의 글자를 코드로
 *  세는 검사가 이 레포에서 두 번 오작동했다([[feedback_gate_must_actually_run]], 그리고
 *  2026-09-15 레드팀이 같은 기제로 첨부 상한 단정을 미끼 주석으로 뚫었다).
 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  assert,
  loadPluginModule,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

const readRel = (rel: string): Promise<string> =>
  readFile(new URL(rel, import.meta.url), "utf8");

/** `const <name> = (` 부터 그 함수를 닫는 `};` 까지. */
const grabFn = (src: string, name: string): string => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`${name} 을 못 찾음`);
  const end = src.indexOf("\n      };", start);
  if (end < 0) throw new Error(`${name} 의 끝을 못 찾음`);
  return src.slice(start, end + "\n      };".length);
};

/** 줄·블록 주석을 지운다 — 주석 안의 글자를 코드로 세지 않으려고. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MiB = 1024 * 1024;

/**
 * `chat-send.js` 의 **실패 복원 분기**만 떼어낸다 (2026-09-17).
 *
 * ★O4 의 성질(«보낸 방으로 되돌린다»)은 그 분기 안에서만 말이 된다. 파일 전체를 보면
 *  `activeThreadKey` 를 쓰는 **정당한** 자리(떠날 때 저장·탭 전환)까지 걸려 옳은 코드를
 *  막는다 — 실제로 그랬다([[feedback_gate_must_actually_run]] 의 반대편: 오탐 게이트는
 *  아무도 안 돌리게 되거나, 맞는 수정을 되돌리게 만든다).
 */
const restoreBlock = (src: string): string => {
  const at = src.indexOf("if (sent && sent.restore === true) {");
  if (at < 0) return "";
  const end = src.indexOf("\n      });", at);
  return end < 0 ? src.slice(at) : src.slice(at, end);
};

export const check: RegressionCheck = {
  name: "attachment-limit-has-one-owner",
  guards:
    "서버 상한을 20MB 로 올렸는데 브라우저에 박힌 10MB 와 문구의 «10MB» 가 안 따라와, 대시보드가 보내기도 전에 거절한 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 서버가 실제로 무엇을 내는가 — 진짜 핸들러를 부른다 ────────────────────
    const caps = await loadPluginModule<{
      ATTACH_MAX_FILE_BYTES: number;
      ATTACH_MAX_TOTAL_BYTES: number;
      ATTACH_MAX_COUNT: number;
    }>("../../../plugins/http-bridge/attachments.js");
    const ops = await loadPluginModule<{
      handleHealth: (ctx: unknown) => Promise<void>;
    }>("../../../plugins/http-bridge/routes-ops.js");

    let status = 0;
    let payload = "";
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
      },
      end(body?: string) {
        if (typeof body === "string") payload += body;
        this.writableEnded = true;
      },
      write(body: string) {
        payload += body;
      },
    };
    await ops.handleHealth({
      res,
      bus: null,
      sseClients: new Set(),
      channelHandler: null,
    });
    const health = JSON.parse(payload || "{}") as {
      limits?: Record<string, unknown>;
    };
    const limits = health.limits ?? {};

    out.push(
      assert(
        "★/health 가 실제로 응답하고 첨부 상한을 싣는다(이 자리가 없으면 화면은 영원히 모른다)",
        status === 200 && Object.keys(limits).length > 0,
        `status=${status} limits=${JSON.stringify(limits)}`,
      ),
      assert(
        "그 값이 서버가 집행하는 상수와 같다 — 화면이 받는 수와 거절하는 수가 갈리지 않는다",
        limits["attachment_bytes"] === caps.ATTACH_MAX_FILE_BYTES &&
          limits["attachment_total_bytes"] === caps.ATTACH_MAX_TOTAL_BYTES &&
          limits["attachment_count"] === caps.ATTACH_MAX_COUNT,
        `실린 값 ${JSON.stringify(limits)} vs 집행 ${caps.ATTACH_MAX_FILE_BYTES}/${caps.ATTACH_MAX_TOTAL_BYTES}/${caps.ATTACH_MAX_COUNT}`,
      ),
    );

    // ── ② 화면의 판정을 **돌린다** ───────────────────────────────────────────────
    const util = await readRel("../../../packages/dashboard/js/util.js");
    const ctx: Record<string, unknown> = {};
    vm.createContext(ctx);
    vm.runInContext(
      [
        grabFn(util, "attachLimitsFrom"),
        grabFn(util, "attachRejection"),
        grabFn(util, "restoreAttachments"),
        grabFn(util, "sendRejectionAction"),
        grabFn(util, "arrivalOutcome"),
        "this.__read = attachLimitsFrom; this.__judge = attachRejection; this.__restore = restoreAttachments; this.__reject = sendRejectionAction; this.__arrival = arrivalOutcome;",
      ].join("\n"),
      ctx,
    );
    const restore = ctx.__restore as (
      sentAtts: readonly string[],
      pending: readonly string[],
      limits: { count: number } | null,
    ) => { next: string[]; overCap: boolean; cap: number | null };
    const replyCode = await readRel("../../../packages/dashboard/js/reply.js");
    const chatRouteSrc = await readRel("../../../plugins/http-bridge/routes-chat.ts");
    const rejectAction = ctx.__reject as (
      elapsedMs: number,
      status: number,
      body?: unknown,
    ) => {
      restore: boolean;
      tellUser: boolean;
      stillRunning: boolean;
      clearWorking: boolean;
      status: number;
    };
    const arrival = ctx.__arrival as (arrived: unknown) => {
      normal: boolean;
      restore: boolean;
      tellUser: boolean;
      clearWorking: boolean;
    };
    const readLimits = ctx.__read as (health: unknown) => {
      count: number;
      fileBytes: number;
      totalBytes: number;
    } | null;
    const judge = ctx.__judge as (
      count: number,
      queuedBytes: number,
      fileBytes: number,
      limits: unknown,
    ) => string | null;

    // ★**화면 코드가 서버 응답을 직접 읽는다** — 여기서 기대값을 손으로 옮기면 그 순간
    //  «두 벌» 이 되고, 화면이 세 수를 뒤바꿔 읽어도(`fileBytes: …total_bytes`) 전부
    //  초록이 된다. 이름은 다 맞고 값만 틀린 부류는 소스 대조로 영원히 안 보인다.
    const asClient = readLimits(health);
    out.push(
      assert(
        "★화면이 /health 응답을 읽어 서버와 **같은 수**를 얻는다(뒤바꿔 읽으면 여기서 빨개진다)",
        asClient !== null &&
          asClient.fileBytes === caps.ATTACH_MAX_FILE_BYTES &&
          asClient.totalBytes === caps.ATTACH_MAX_TOTAL_BYTES &&
          asClient.count === caps.ATTACH_MAX_COUNT,
        `화면이 읽은 값 ${JSON.stringify(asClient)} vs 집행 ${caps.ATTACH_MAX_FILE_BYTES}/${caps.ATTACH_MAX_TOTAL_BYTES}/${caps.ATTACH_MAX_COUNT}`,
      ),
      assert(
        "★서버가 안 알려주거나 수가 아니면 통째로 «모른다» 로 답한다(반쯤 아는 상태로 막지 않는다)",
        readLimits({}) === null &&
          readLimits(null) === null &&
          readLimits({ limits: { attachment_bytes: 20, attachment_count: 3 } }) === null,
        `빈 응답 → ${JSON.stringify(readLimits({}))} · 일부만 → ${JSON.stringify(readLimits({ limits: { attachment_bytes: 20, attachment_count: 3 } }))}`,
      ),
    );

    out.push(
      assert(
        "★서버가 20MB 라고 말할 때 15MB 파일을 미리 거절하지 않는다 — **이 사고 자체**",
        judge(0, 0, 15 * MiB, asClient) === null,
        `판정 ${String(judge(0, 0, 15 * MiB, asClient))} · 화면이 읽은 상한 ${JSON.stringify(asClient)}`,
      ),
      assert(
        "파일당 상한을 정확히 넘으면 미리 알려준다",
        judge(0, 0, caps.ATTACH_MAX_FILE_BYTES + 1, asClient) === "size" &&
          judge(0, 0, caps.ATTACH_MAX_FILE_BYTES, asClient) === null,
        `+1 → ${String(judge(0, 0, caps.ATTACH_MAX_FILE_BYTES + 1, asClient))} · 정확히 → ${String(judge(0, 0, caps.ATTACH_MAX_FILE_BYTES, asClient))}`,
      ),
      assert(
        "합계 상한도 본다 — 서버가 거절할 것을 올린 뒤에 알게 되지 않는다",
        judge(2, caps.ATTACH_MAX_TOTAL_BYTES, 1, asClient) === "total" &&
          judge(2, caps.ATTACH_MAX_TOTAL_BYTES - 10, 10, asClient) === null,
        `초과 → ${String(judge(2, caps.ATTACH_MAX_TOTAL_BYTES, 1, asClient))} · 딱 맞음 → ${String(judge(2, caps.ATTACH_MAX_TOTAL_BYTES - 10, 10, asClient))}`,
      ),
      assert(
        "개수 상한도 본다",
        judge(caps.ATTACH_MAX_COUNT, 0, 1, asClient) === "count" &&
          judge(caps.ATTACH_MAX_COUNT - 1, 0, 1, asClient) === null,
        `가득 → ${String(judge(caps.ATTACH_MAX_COUNT, 0, 1, asClient))} · 하나 남음 → ${String(judge(caps.ATTACH_MAX_COUNT - 1, 0, 1, asClient))}`,
      ),
      assert(
        "★상한을 **모르면 미리 막지 않는다**(서버가 판정한다) — 모를 때 막는 것이 이 사고의 형상이었다",
        judge(0, 0, 999 * MiB, null) === null &&
          judge(0, 0, 999 * MiB, undefined) === null,
        `null → ${String(judge(0, 0, 999 * MiB, null))} · undefined → ${String(judge(0, 0, 999 * MiB, undefined))}`,
      ),
    );

    // ── ③ 이름이 갈리지 않는다 — 기대 키는 **서버 응답에서** 가져온다 ────────────
    const send = await readRel("../../../packages/dashboard/js/chat-send.js");
    const sendCode = stripComments(send);
    // ★**시작값을 실행해서** 본다 — 소스에 `1024 * 1024` 가 없어도 `10485760` 을 적으면
    //  같은 사고가 그대로 돌아온다. 리터럴 목록을 넓히는 대신 «모른 채 시작하는가» 를
    //  묻는다(수를 어떻게 적든 상관없다).
    const initMatch = /let attachLimits = ([^;]+);/.exec(sendCode);
    let initValue: unknown = "미발견";
    if (initMatch) {
      const c: Record<string, unknown> = {};
      vm.createContext(c);
      vm.runInContext(`this.__v = (${initMatch[1]!});`, c);
      initValue = c.__v;
    }
    out.push(
      assert(
        "★화면은 상한을 **모른 채 시작한다** — 자기 수를 들고 시작하면 서버에서 올려도 안 따라온다(이번 사고)",
        initMatch !== null && (initValue === null || initValue === undefined),
        `시작값 = ${JSON.stringify(initValue) ?? String(initValue)}`,
      ),
      assert(
        "그 시작값이 실제로 서버 응답으로 채워진다(배선이 있다)",
        /attachLimits = attachLimitsFrom\(/.test(sendCode),
        `배선 ${/attachLimits = attachLimitsFrom\(/.test(sendCode) ? "있음" : "없음"}`,
      ),
    );

    // ── ④ 문구가 수를 스스로 적지 않는다 ─────────────────────────────────────────
    const ko = JSON.parse(
      await readRel("../../../locales/ko.json"),
    ) as Record<string, string>;
    const en = JSON.parse(
      await readRel("../../../locales/en.json"),
    ) as Record<string, string>;
    const sizeKeys = ["chat.attach.tooBig", "chat.attach.totalTooBig"];
    const bakedIn = sizeKeys.flatMap((k) =>
      [
        ["ko", ko[k]],
        ["en", en[k]],
      ]
        .filter(([, v]) => typeof v !== "string" || !v.includes("{limit}") || /\d+\s*[MG]i?B/.test(v))
        .map(([loc, v]) => `${loc}:${k}="${String(v)}"`),
    );
    out.push(
      assert(
        "★상한 문구가 수를 스스로 적지 않고 `{limit}` 로 받는다 — 코드가 올라도 문장이 «10MB» 라고 말하면 사용자에겐 여전히 거짓이다",
        bakedIn.length === 0,
        bakedIn.length === 0 ? `${sizeKeys.length}개 문구 양문 모두 자리표시자` : bakedIn.join(" · "),
      ),
    );

    // ── ⑤ 숫자가 브라우저로 돌아오지 않는다 (주석 제외) ──────────────────────────
    const relapse = [
      ...sendCode.matchAll(/\b\d+\s*\*\s*1024\s*\*\s*1024\b|\bATT_MAX(?:_BYTES)?\b/g),
    ].map((m) => m[0]);
    out.push(
      assert(
        "★chat-send.js 코드에 첨부 바이트 상한이 다시 박히지 않았다(주석은 세지 않는다)",
        relapse.length === 0,
        relapse.length === 0 ? "리터럴 상한 없음" : `발견: ${relapse.join("·")}`,
      ),
      assert(
        "★주석 제거가 코드를 통째로 날리지 않았다(그러면 위 두 검사가 공허하다)",
        sendCode.includes("attachRejection") && sendCode.length > send.length / 3,
        `코드 ${sendCode.length}B / 원본 ${send.length}B`,
      ),
    );

    // ── ⑥ 모를 때 **다시 묻고**, 못 보냈으면 **되돌린다** (2026-09-15 아스트라 지적) ──
    //  둘 다 «조용한 손실» 부류다: 부팅 때 상한을 못 받으면 페이지가 사는 내내 안내가 죽고,
    //  서버가 거절하면 붙인 파일이 그냥 사라진다(사용자는 다시 끌어다 놔야 하는 줄도 모른다).
    const reply = stripComments(
      await readRel("../../../packages/dashboard/js/reply.js"),
    );
    out.push(
      assert(
        "★상한을 모르면 **다시 묻는다** — 부팅 한 번 실패로 안내가 영영 죽지 않는다(중복 요청은 안 만든다)",
        /const ensureAttachLimits = \(\)/.test(sendCode) &&
          /attachLimitsInFlight/.test(sendCode) &&
          /await ensureAttachLimits\(\)/.test(sendCode),
        `재조회 함수 ${/const ensureAttachLimits = \(\)/.test(sendCode)} · 중복방지 ${/attachLimitsInFlight/.test(sendCode)} · 첨부 시점 재시도 ${/await ensureAttachLimits\(\)/.test(sendCode)}`,
      ),
      assert(
        // ★경과 시간이 «수락 여부» 를 뒤집으면 안 된다 (회사 아스트라 P2). 느린 업로드 뒤
        //  도착한 413 이 10초를 넘겼다고 성공이 되면, 컴포저가 쓴 글과 첨부를 지운다.
        //  «작업 중 표시» 와 «서버가 받았나» 는 다른 판단이다.
        "★**명시적 HTTP 거절은 시간과 무관하게 실패**다 — 10초를 넘겨도 성공으로 바뀌지 않는다",
        (() => {
          // ★창을 **블록 경계에서 끊는다** — 처음엔 600자를 봤는데 그 창이 `catch` 까지
          //  넘어가 거기 있는 실패 반환을 읽었고, 그래서 변이가 통과했다(자기 변이에서 적발).
          const at = reply.indexOf("if (!r.ok) {");
          if (at < 0) return false;
          const endsAt = reply.indexOf("} else if (data && data.steered)", at);
          if (endsAt < 0) return false;
          const block = reply.slice(at, endsAt); // `!r.ok` 블록 **안쪽만**
          // ★**모양이 아니라 성질을 잰다** (2026-09-16 정정). 종전엔 «시간 분기 블록» 을
          //  정규식으로 찾고 그 뒤에 실패 반환이 있는지 봤는데, 시간 분기를 **없애자**
          //  패턴이 안 맞아 빨개졌다 — 코드가 나아졌는데 검사가 막은 것이다.
          //  지키려는 성질은 «실패 반환이 **어떤 조건 안에도 없다**» 이다.
          const lines = block.split("\n");
          const idx = lines.findIndex((l) => /return \{ ok: false[,}]/.test(l));
          if (idx < 0) return false;
          // ★조건 안이 아니어야 한다 — **두 가지 모양**을 다 본다.
          //  ① 블록 조건: 그 줄까지의 중괄호 균형이 `!r.ok` 자신(1)을 넘으면 안쪽이다.
          //  ② **중괄호 없는 한 줄 조건**(`if (x) return …;`) — 깊이가 안 변해서 ①이 못 본다.
          //    (자기 변이에서 적발: 이 줄이 없을 때 M3 가 통과했다.)
          const depth = lines
            .slice(0, idx)
            .join("\n")
            .split("")
            .reduce((d, c) => (c === "{" ? d + 1 : c === "}" ? d - 1 : d), 0);
          const sameLine = lines[idx] ?? "";
          const guardedOnSameLine =
            /\b(if|else|\?|&&|\|\|)\b|[?&|]/.test(
              sameLine.slice(0, sameLine.indexOf("return")),
            );
          return depth === 1 && !guardedOnSameLine;
        })(),
        `!r.ok 블록의 실패반환 중괄호 깊이 ${(() => {
          const at = reply.indexOf("if (!r.ok) {");
          const endsAt = reply.indexOf("} else if (data && data.steered)", at);
          const block = at < 0 || endsAt < 0 ? "" : reply.slice(at, endsAt);
          const lines = block.split("\n");
          const idx = lines.findIndex((l) => /return \{ ok: false[,}]/.test(l));
          if (idx < 0) return "실패반환 없음";
          return lines
            .slice(0, idx)
            .join("\n")
            .split("")
            .reduce((d, c) => (c === "{" ? d + 1 : c === "}" ? d - 1 : d), 0);
        })()}`,
      ),
      assert(
        // ★단절 경로는 **실패를 안 돌려준다** — 서버가 받았는지 모르므로 되돌리면 중복
        //  전송이 된다. 즉 `catch` 안에서 실패 반환은 **10초 분기 안에만** 있어야 한다.
        "★네트워크 단절은 **모르는 것**이라 실패로 안 바꾼다(되돌리면 중복 전송이 된다)",
        (() => {
          const at = reply.indexOf("} catch (err) {");
          if (at < 0) return false;
          const block = reply.slice(at, at + 700);
          const m = /if \(Date\.now\(\) - t0 < 10000\) \{[\s\S]*?\n\s{10}\}/.exec(block);
          if (m === null) return false;
          const tail = block.slice(m.index + m[0].length, m.index + m[0].length + 300);
          return (
            /return \{ ok: false[,}]/.test(m[0]) && // 즉시 실패는 알린다
            !/return \{ ok: false[,}]/.test(tail) // 오래 걸린 단절은 안 알린다
          );
        })(),
        `단절: 즉시=실패보고 · 지연=보고안함 ${(() => {
          const at = reply.indexOf("} catch (err) {");
          const block = at < 0 ? "" : reply.slice(at, at + 700);
          const m = /if \(Date\.now\(\) - t0 < 10000\) \{[\s\S]*?\n\s{10}\}/.exec(block);
          const tail = m === null ? "" : block.slice(m.index + m[0].length, m.index + m[0].length + 300);
          return `(즉시 ${m !== null && /return \{ ok: false[,}]/.test(m[0])} / 지연 ${/return \{ ok: false[,}]/.test(tail)})`;
        })()}`,
      ),
      assert(
        "★전송이 **실패를 알려준다** — 종전엔 언제나 undefined 라 호출부가 되돌릴 방법이 없었다",
        /return \{ ok: false[,}]/.test(reply) && /return \{ ok: true \}/.test(reply),
        `실패 보고 ${/return \{ ok: false[,}]/.test(reply)} · 성공 보고 ${/return \{ ok: true \}/.test(reply)}`,
      ),
      assert(
        // ★첫 판은 **첨부만** 되돌렸다 — 413 을 맞으면 **쓴 글이 그대로 사라졌다**(아스트라
        //  2차 지적). 되돌릴 것은 «이 전송에 실린 것» 전부다. 그리고 기다리는 동안 새로
        //  친 글을 **덮으면 안 된다** — 사용자가 친 것이 더 최신이므로 뒤에 둔다.
        "★못 보냈으면 **텍스트도** 되돌리고, 기다리는 동안 새로 친 글을 덮지 않는다",
        /if \(text !== ""\)/.test(sendCode) &&
          /const typedSince = input\.value/.test(sendCode) &&
          /typedSince === "" \? text : `\$\{text\}\\n\$\{typedSince\}`/.test(sendCode),
        `텍스트 복구 ${/if \(text !== ""\)/.test(sendCode)} · 새 입력 보존 ${/const typedSince = input\.value/.test(sendCode)}`,
      ),
      assert(
        // ★O4(레드팀): 복원 분기가 `activeThreadKey` 를 «그때» 다시 읽었다. 컴포저는 탭이
        //  공유하고 draft 는 스레드별이라, 보내는 사이 방을 옮기면 **A 의 글이 B 의 입력창에
        //  꽂히고 B 의 draft 로 저장된다** — 그대로 B 에 보낼 수도 있다. 사용자가 직접 겪는다.
        "★실패 복원이 **보낸 방**으로 간다 — 그 사이 탭을 옮겼으면 지금 방의 입력창을 안 건드린다",
        /const sentFrom = activeThreadKey;/.test(sendCode) &&
          /sentFrom === activeThreadKey/.test(sendCode) &&
          /window\.stashChatDraft\(sentFrom/.test(sendCode) &&
          // ★«직접 쓰지 않는다» 는 **복원 분기 안에서만** 참이어야 한다 (2026-09-17 정정).
          //  종전엔 파일 전체를 봤고, 그래서 «떠날 때 지금 방을 저장한다» 는 **정당한** 훅이
          //  이 검사를 빨갛게 만들었다. 그 훅은 O4 와 무관하다 — O4 는 «보내는 사이 방을
          //  옮겼을 때 지금 방에 남의 글을 꽂지 마라» 이고, 떠날 때 저장은 «지금 방의 지금
          //  입력창» 이라 정의상 남의 글이 아니다. 검사를 넓게 두면 옳은 코드를 막는다.
          !new RegExp("window\\.saveChatDraft\\(activeThreadKey\\)").test(restoreBlock(sendCode)),
        `제출시점 캡처 ${/const sentFrom = activeThreadKey;/.test(sendCode)} · 같은방 판정 ${/sentFrom === activeThreadKey/.test(sendCode)} · 다른방 보관 ${/window\.stashChatDraft\(sentFrom/.test(sendCode)}`,
      ),
      assert(
        "★명시적 거절은 **언제나** 사용자에게 말한다 — 느린 거절이 조용히 글만 되돌리지 않는다",
        // ★사고(2026-09-16): `/messages` 는 턴을 동기로 돌므로 턴이 던지면 한참 뒤에 비-2xx 가
        //  온다. 종전엔 오류 표시가 «10초 안» 조건에 묶여 있어, 느린 거절이 아무 말 없이
        //  텍스트만 입력창에 되돌렸다 — «턴은 도는 것 같은데 보낸 글이 다시 있다».
        rejectAction(30_000, 500).tellUser === true &&
          rejectAction(500, 413).tellUser === true,
        `30초=${JSON.stringify(rejectAction(30_000, 500))} · 0.5초=${JSON.stringify(rejectAction(500, 413))}`,
      ),
      assert(
        "작업중 해제는 **즉시 실패일 때만** — 긴 턴은 답이 SSE 로 올 수 있다",
        rejectAction(500, 500).clearWorking === true &&
          rejectAction(30_000, 500).clearWorking === false,
        `0.5초=${rejectAction(500, 500).clearWorking} · 30초=${rejectAction(30_000, 500).clearWorking}`,
      ),
      assert(
        "화면이 그 판정을 **쓴다**(인라인 조건으로 다시 짜지 않는다)",
        /sendRejectionAction\(Date\.now\(\) - t0, r\.status, data\)/.test(replyCode) &&
          /act\.tellUser/.test(replyCode) &&
          // ★상태 코드를 화면에서 **다시** 해석하지 않는다 — 판정은 순수 함수 한 곳이다.
          //  여기에 `r.status === 504` 같은 게 생기면 권위가 둘이 되어 갈린다.
          !/r\.status\s*[=!]==?\s*\d/.test(replyCode),
        `호출 ${/sendRejectionAction\(Date\.now\(\) - t0, r\.status, data\)/.test(replyCode)} · 사용 ${/act\.tellUser/.test(replyCode)} · 재해석 ${/r\.status\s*[=!]==?\s*\d/.test(replyCode)}`,
      ),
      assert(
        "★**서버가 «받았다» 고 말한 것만 안 되돌린다** — 등급으로 추측하지 않는다 (P-1)",
        // ★적대 검토 P-1(4점·자초): «5xx=모름» 으로 추측했더니, 데몬 정지·재시작 창의
        //  `502 bridge unreachable` 과 부팅·종료 창의 `503 channel not started` 가 그 칸에
        //  들어가 **쓴 글이 영구 소실**됐다(컴포저는 전송 직전에 비워진다). 둘 다 «확실히
        //  안 받은 것» 이다. 배포가 커밋마다라 그 창은 자주 열린다.
        rejectAction(60_000, 502, { error: "bridge unreachable: fetch failed" }).restore ===
          true &&
          rejectAction(200, 503, { error: "channel not started" }).restore === true &&
          rejectAction(60_000, 504, { error: "timeout", accepted: true, running: true })
            .restore === false,
        `502=${rejectAction(60_000, 502, { error: "x" }).restore} · 503=${rejectAction(200, 503, { error: "x" }).restore} · 504(accepted)=${rejectAction(60_000, 504, { accepted: true, running: true }).restore}`,
      ),
      assert(
        "★**«아직 돈다» 도 서버가 말한 것만** — 즉시 실패가 «처리 중» 으로 보이지 않는다",
        // 같은 발견의 나머지 절반: 6ms 만에 돌아온 502 가 «순서대로 실행됩니다» 를 띄웠다.
        rejectAction(6, 502, { error: "bridge unreachable" }).stillRunning === false &&
          rejectAction(200, 500, { error: "boom", accepted: true }).stillRunning === false &&
          rejectAction(60_000, 504, { accepted: true, running: true }).stillRunning === true,
        `502(6ms)=${rejectAction(6, 502, {}).stillRunning} · 500(accepted)=${rejectAction(200, 500, { accepted: true }).stillRunning} · 504=${rejectAction(60_000, 504, { accepted: true, running: true }).stillRunning}`,
      ),
      assert(
        "★본문이 없거나 이상해도 **글을 지키는 쪽**으로 떨어진다 — 틀리는 방향을 고른다",
        rejectAction(100, 502, undefined).restore === true &&
          rejectAction(100, 500, null).restore === true &&
          rejectAction(100, 500, "문자열").restore === true &&
          rejectAction(100, 500, { accepted: "true" }).restore === true,
        `없음=${rejectAction(100, 502, undefined).restore} · null=${rejectAction(100, 500, null).restore} · 문자열=${rejectAction(100, 500, "문자열").restore} · 문자열true=${rejectAction(100, 500, { accepted: "true" }).restore}`,
      ),
      assert(
        "★브리지가 **실제로 그 필드를 싣는다** — 화면의 규칙이 서버와 짝이 맞는다",
        (() => {
          const src = chatRouteSrc;
          return (
            /writeJson\(res, 504, \{ error: "timeout", accepted: true, running: true \}\)/.test(src) &&
            /writeJson\(res, 500, \{ error: reason, accepted: true \}\)/.test(src) &&
            // 안 받은 자리엔 안 단다 — 달면 그게 다시 P-1 이다.
            !/writeJson\(res, 503, \{ error: "channel not started", accepted/.test(src)
          );
        })(),
        `504 ${/504, \{ error: "timeout", accepted: true/.test(chatRouteSrc)} · 500 ${/500, \{ error: reason, accepted: true/.test(chatRouteSrc)} · 503 미표기 ${!/503, \{ error: "channel not started", accepted/.test(chatRouteSrc)}`,
      ),
      assert(
        "★(옛) 504 는 여전히 안 되돌린다 — 정태님 신고 2회의 원래 증상",
        // ★사슬: 턴 진행중 전송 → enqueueThreadTurn 직렬 큐 → POST 가 그 promise 를 await
        //  → 60초(HANDLER_TIMEOUT_MS) → Promise.race 가 504. 그런데 channelHandler 는
        //  **계속 돈다** = 그 메시지는 실행된다. 되돌리면 사용자가 다시 보내 중복 전송이다.
        //  실측: 대시보드 턴 최대 35분 — 긴 턴 중 전송은 거의 항상 이 길로 온다.
        rejectAction(60_000, 504, { error: "timeout", accepted: true, running: true })
          .restore === false &&
          rejectAction(60_000, 504, { error: "timeout", accepted: true, running: true })
            .stillRunning === true,
        `504=${JSON.stringify(rejectAction(60_000, 504, { error: "timeout", accepted: true, running: true }))}`,
      ),
      // ── ★**잘 처리된 건 말하지 않는다** (2026-09-22 정태님: *"에러는 확실히 나오면
      //  괜찮은데 잘 처리된 건 소음이지"*) ─────────────────────────────────────────
      //  실사례: 창을 닫으려다 만 것만으로 *"연결이 끊겼지만 메시지는 서버에 도착했습니다"*
      //  가 떴다(09:11:16). 그 턴은 7초 뒤 정상 종료했고 중복도 없었다 — 아무 일도 없었는데
      //  말을 건 것이다.
      assert(
        "★★도착했으면 **평범한 전송과 같다** — 알리지도, 되돌리지도, 작업중을 끄지도 않는다",
        arrival(true).normal === true &&
          arrival(true).tellUser === false &&
          arrival(true).restore === false &&
          arrival(true).clearWorking === false,
        `도착=${JSON.stringify(arrival(true))}`,
      ),
      assert(
        "★★**반대 방향** — 못 갔거나 확인 자체가 실패하면 되돌리고 말한다(조용한 소실 금지)",
        // ★한 방향만 지키는 그물이 이 레포의 반복 결함이다. 「조용해진다」를 넣었으면
        //  「시끄러워야 할 때 시끄러운가」를 같은 함수로 재야 한다.
        arrival(false).normal === false &&
          arrival(false).tellUser === true &&
          arrival(false).restore === true &&
          arrival(undefined).normal === false &&
          arrival(null).normal === false &&
          // 확인이 문자열·객체 같은 쓰레기를 내도 «도착» 으로 읽지 않는다.
          arrival("true").normal === false &&
          arrival(1).normal === false,
        `실패=${JSON.stringify(arrival(false))} · undefined=${arrival(undefined).normal} · "true"=${arrival("true").normal} · 1=${arrival(1).normal}`,
      ),
      assert(
        "★**두 호출부가 같은 판정을 지난다** — 연결 끊김·5xx 가 서로 다르게 굴던 것을 합쳤다",
        // ★종전엔 5xx 가지만 `act.clearWorking` 을 따라 작업중을 껐다. 같은 «도착했다» 에
        //  판정이 둘이면 한쪽만 고쳐진다. 그리고 **안내 문구는 완전히 사라져야 한다** —
        //  남아 있으면 i18n 고아 키 검사가 따로 잡지만, 여기서도 못을 박는다.
        (replyCode.match(/arrivalOutcome\(/g) ?? []).length === 2 &&
          !/deliveredNoReply/.test(replyCode) &&
          !/renderLocalChat\("info"[^)]*deliveredNoReply/.test(replyCode),
        `arrivalOutcome 호출 ${(replyCode.match(/arrivalOutcome\(/g) ?? []).length}곳 · 옛 문구 잔존 ${/deliveredNoReply/.test(replyCode)}`,
      ),
      assert(
        "★판정이 **상태 코드와 무관**하다 — 어떤 코드든 말 안 하면 «안 받음»(2026-09-17 P-1)",
        // ★첫 판은 «5xx=모름 / 4xx=안 받음» 이라는 **부류** 판정이었다. 그게 P-1 이다:
        //  5xx 를 내는 자리가 셋인데 둘은 «확실히 안 받음» 이라 한 칸에 못 들어간다.
        //  이제 코드 등급은 판정에 안 쓴다 — 받은 쪽이 `accepted` 로 말한 것만 본다.
        [400, 413, 500, 502, 503, 504, 599, 0].every(
          (c) => rejectAction(60_000, c, { error: "x" }).restore === true,
        ) &&
          [500, 504].every(
            (c) => rejectAction(60_000, c, { accepted: true }).restore === false,
          ),
        `말 안 함=${[400, 413, 500, 502, 503, 504, 599, 0].map((c) => rejectAction(60_000, c, {}).restore).join()} · accepted=${[500, 504].map((c) => rejectAction(60_000, c, { accepted: true }).restore).join()}`,
      ),
      assert(
        "★4xx 는 **여전히 되돌린다** — 413 을 맞고 쓴 글이 사라지던 것을 되살리지 않는다",
        rejectAction(30_000, 413, { error: "too large" }).restore === true &&
          rejectAction(500, 400, { error: "빈 본문" }).restore === true &&
          // ★상태 불명(0)도 **되돌리는** 쪽이다 — 받았다는 말이 없으면 글을 지킨다.
          //  첫 판은 여기서 «모름 → 안 되돌림» 이었고, 그게 소실 방향이었다.
          rejectAction(500, 0, undefined).restore === true,
        `413=${rejectAction(30_000, 413, {}).restore} · 400=${rejectAction(500, 400, {}).restore} · 불명=${rejectAction(500, 0, undefined).restore}`,
      ),
      assert(
        "★컴포저가 되돌릴지는 `restore` 로 정한다 — `ok` 를 다시 해석하지 않는다",
        // ★이게 이번 결함의 형상이다: «전송 성공이 아니다»(ok:false)와 «서버가 안 받았다»
        //  가 한 조건에 묶여 있어 504 에도 입력창이 채워졌다.
        /sent\.restore === true/.test(sendCode) &&
          !/sent\.ok === false/.test(sendCode) &&
          /restore: act\.restore/.test(replyCode),
        `컴포저 ${/sent\.restore === true/.test(sendCode)} · ok재해석 ${/sent\.ok === false/.test(sendCode)} · 운반 ${/restore: act\.restore/.test(replyCode)}`,
      ),
      assert(
        "★실패 복원이 **기다리는 동안 붙인 첨부를 지우지 않는다**(아스트라 P2 재현: 상한 1 · 되돌릴 것 1 · 새 것 1)",
        // ★종전엔 이 자리가 소스에 `.slice(0, cap)` 이 있는지만 봤다 — **틀린 동작을 검사가
        //  고정**했고, 버그와 같이 쓴 검사라 버그를 못 잡았다(외부 검토가 잡았다).
        //  이제 **판단을 실행**한다.
        (() => {
          const r = restore(["failed-A"], ["new-B"], { count: 1 });
          return (
            r.next.length === 2 &&
            r.next.includes("failed-A") &&
            r.next.includes("new-B") &&
            r.overCap === true
          );
        })(),
        JSON.stringify(restore(["failed-A"], ["new-B"], { count: 1 })),
      ),
      assert(
        "복원 순서는 «되돌린 것 먼저, 방금 붙인 것 뒤»(더 최신이 뒤)",
        restore(["old"], ["new"], { count: 9 }).next.join(",") === "old,new",
        restore(["old"], ["new"], { count: 9 }).next.join(","),
      ),
      assert(
        "상한 안이면 «넘쳤다» 를 말하지 않는다(정상 경로에 잡음 0)",
        restore(["a"], ["b"], { count: 5 }).overCap === false,
        String(restore(["a"], ["b"], { count: 5 }).overCap),
      ),
      assert(
        "서버 상한을 모르면 넘쳤다고 단정하지 않는다(상한은 서버가 정한다)",
        restore(["a"], ["b"], null).overCap === false &&
          restore(["a"], ["b"], null).next.length === 2,
        JSON.stringify(restore(["a"], ["b"], null)),
      ),
      assert(
        "화면이 그 판정을 **쓴다**(인라인으로 다시 짜지 않는다)",
        /restoreAttachments\(atts, pendingAttachments, attachLimits\)/.test(sendCode) &&
          !/\.slice\(0, cap\)/.test(sendCode),
        `호출 ${/restoreAttachments\(/.test(sendCode)} · 옛 자르기 남음 ${/\.slice\(0, cap\)/.test(sendCode)}`,
      ),
    );

    return out;
  },
};
