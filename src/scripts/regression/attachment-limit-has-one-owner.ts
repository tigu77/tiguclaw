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
        "this.__read = attachLimitsFrom; this.__judge = attachRejection; this.__restore = restoreAttachments;",
      ].join("\n"),
      ctx,
    );
    const restore = ctx.__restore as (
      sentAtts: readonly string[],
      pending: readonly string[],
      limits: { count: number } | null,
    ) => { next: string[]; overCap: boolean; cap: number | null };
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
          const m = /if \(Date\.now\(\) - t0 < 10000\) \{[\s\S]*?\n\s{12}\}/.exec(block);
          if (m === null) return false;
          const afterTimeBranch = block.slice(m.index + m[0].length);
          return /return \{ ok: false \}/.test(afterTimeBranch);
        })(),
        `!r.ok 블록의 시간분기 밖 실패반환 ${(() => {
          const at = reply.indexOf("if (!r.ok) {");
          const endsAt = reply.indexOf("} else if (data && data.steered)", at);
          const block = at < 0 || endsAt < 0 ? "" : reply.slice(at, endsAt);
          const m = /if \(Date\.now\(\) - t0 < 10000\) \{[\s\S]*?\n\s{12}\}/.exec(block);
          const tail = m === null ? "" : block.slice(m.index + m[0].length);
          return /return \{ ok: false \}/.test(tail);
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
            /return \{ ok: false \}/.test(m[0]) && // 즉시 실패는 알린다
            !/return \{ ok: false \}/.test(tail) // 오래 걸린 단절은 안 알린다
          );
        })(),
        `단절: 즉시=실패보고 · 지연=보고안함 ${(() => {
          const at = reply.indexOf("} catch (err) {");
          const block = at < 0 ? "" : reply.slice(at, at + 700);
          const m = /if \(Date\.now\(\) - t0 < 10000\) \{[\s\S]*?\n\s{10}\}/.exec(block);
          const tail = m === null ? "" : block.slice(m.index + m[0].length, m.index + m[0].length + 300);
          return `(즉시 ${m !== null && /return \{ ok: false \}/.test(m[0])} / 지연 ${/return \{ ok: false \}/.test(tail)})`;
        })()}`,
      ),
      assert(
        "★전송이 **실패를 알려준다** — 종전엔 언제나 undefined 라 호출부가 되돌릴 방법이 없었다",
        /return \{ ok: false \}/.test(reply) && /return \{ ok: true \}/.test(reply),
        `실패 보고 ${/return \{ ok: false \}/.test(reply)} · 성공 보고 ${/return \{ ok: true \}/.test(reply)}`,
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
          // 복원 분기가 `activeThreadKey` 를 **직접** 쓰지 않는다(그게 O4 다)
          !/window\.saveChatDraft\(activeThreadKey\)/.test(sendCode),
        `제출시점 캡처 ${/const sentFrom = activeThreadKey;/.test(sendCode)} · 같은방 판정 ${/sentFrom === activeThreadKey/.test(sendCode)} · 다른방 보관 ${/window\.stashChatDraft\(sentFrom/.test(sendCode)}`,
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
