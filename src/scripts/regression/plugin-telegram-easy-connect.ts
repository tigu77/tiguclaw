/**
 * 회귀: **텔레그램을 대시보드에서 쉽게 연결한다** (2026-10-16, 정태님 «텔레그램 채널 플러그인에서 쉽게 연결»).
 *
 * 사고: 비서에게 «텔레그램 연결하고 싶어» 라고 하면 Claude 는 `.env` 를 직접 고치고 터미널에서 재시작하라 했고(소유자 ID 는 외부 봇으로),
 *  Codex 는 «온보딩 설정에 입력» 이라고만 했다 — 정해진 길이 없어 즉흥이었다. 플러그인 설정 화면은 secret·`.env` 칸을 «있다/없다» 만
 *  보이고 쓰기를 거절했다. 꺼 둔 플러그인의 스킬·에이전트·커맨드가 목록에 그대로 남았다(네 벌의 폴더 훑기가 켜짐을 안 봤다).
 *
 * 본다:
 *  ① secret·`.env` 칸 저장 = 홈 `.env` 로(원자 쓰기 공용 함수) · 즉시 process.env · 재시작 필요 표시 · 값은 응답에 없음
 *  ② 쓸 수 있는 칸·이름을 좁힌다 — 명시(editable) 안 한 .env 칸(포트)·readOnly 거절 · 직접 설치한 플러그인이 코어 키를 가리키면 거절, 자기
 *     이름공간은 허용 · 줄바꿈·따옴표·# 거절 · 파일 칸은 손대지 않음
 *  ③ «내 ID 찾기» — 막힌 보낸 사람 기억(상한·최근 순) · getUpdates 는 **부르지 않는다**(같은 토큰의 다른 인스턴스 폴링을 끊는다) ·
 *     폴링 전이면 «먼저 재시작» · 소유자 목록은 메시지마다 다시 읽는다(고르면 재시작 없이 통한다)
 *  ④ 꺼 둔 플러그인의 자산은 안 실린다(매니페스트 이름 기준) · 텔레그램 플러그인이 자기 연결 스킬을 낸다
 *  ⑤ 배선 — 라우트가 `.env` 칸을 코어 판정으로 · 화면이 비밀 입력·`.env` 입력·«찾기»·재시작 막대 · 미들웨어가 막힌 사람을 기억
 *
 * 등급: **실행**(격리 홈) + 배선(소스).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "plugin-telegram-easy-connect",
  guards: "텔레그램 연결이 `.env` 직접 편집·외부 봇 ID 조회에 기대고 어댑터마다 안내가 갈리던 것 + 꺼 둔 플러그인의 스킬이 목록에 남던 것",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];
    const { getPaths } = await import("../../core/paths.js");
    const settings = await import("../../core/plugins/settings.js");
    // 쓰는 쪽(`upsertHomeEnvVars`)과 **같은 경로 함수**로 잡는다 — 다른 길로 계산하면 스위트 안에서 갈린다.
    const { homeEnvPath } = await import("../../core/load-env.js");
    const envFile = homeEnvPath();
    writeFileSync(envFile, "# kept comment\nHTTP_BRIDGE_TOKEN=keep-me\n", "utf8");
    const tgSpecs = [
      { key: "botToken", type: "secret" as const, env: "TELEGRAM_BOT_TOKEN" },
      { key: "allowedUserIds", type: "string" as const, env: "TELEGRAM_ALLOWED_USER_IDS", editable: true, live: true },
      { key: "units", type: "string" as const },
      { key: "port", type: "number" as const, env: "HTTP_BRIDGE_PORT" },
      { key: "locked", type: "secret" as const, env: "TIGUCLAW_PLUGIN_TELEGRAM_CHANNEL_LOCKED", readOnly: true },
    ];
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    const prevIds = process.env.TELEGRAM_ALLOWED_USER_IDS;
    try {
      // ①
      const r1 = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "botToken", "  123:ABC-probe  ", "bundled");
      const r2 = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "allowedUserIds", "42", "bundled");
      const body = readFileSync(envFile, "utf8");
      out.push(assert("① secret·.env 칸 저장 = 홈 .env(기존 줄 보존) · 즉시 process.env · 재시작 필요 표시 · 응답에 값 없음",
        // 토큰(부팅 때 읽음)은 재시작 필요 · 소유자 ID(`live` — 메시지마다 읽음)는 바로 적용(«재시작 필요» 막대를 안 띄운다, 레드팀 A)
        r1?.ok === true && r1.restartNeeded === true && r2?.ok === true && r2.restartNeeded !== true &&
          body.includes("TELEGRAM_BOT_TOKEN=123:ABC-probe\n") && body.includes("TELEGRAM_ALLOWED_USER_IDS=42") &&
          body.includes("# kept comment") && body.includes("HTTP_BRIDGE_TOKEN=keep-me") &&
          process.env.TELEGRAM_BOT_TOKEN === "123:ABC-probe" && !JSON.stringify(r1).includes("ABC-probe"),
        { r1, r2, lines: body.split("\n").map((l) => l.replace(/=.*/, "=…")) }));

      // ②
      const homeCore = await settings.writePluginEnvSetting("evil", [{ key: "t", type: "secret", env: "CLAUDE_CODE_OAUTH_TOKEN" }], "t", "x", "home");
      const homeOwn = await settings.writePluginEnvSetting("my-plugin", [{ key: "apiKey", type: "secret" }], "apiKey", "k1", "home");
      const multi = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "allowedUserIds", "42\nANTHROPIC_API_KEY=x", "bundled");
      const fileKey = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "units", "metric", "bundled");
      // ★포트처럼 명시 안 한 .env 칸은 읽기 전용 그대로 — 비우거나 잘못 넣으면 재시작 뒤 대시보드가 죽는다(적대 검토 P1 실측)
      const port = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "port", "", "bundled");
      const locked = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "locked", "x", "bundled");
      // ★따옴표로 시작하면 파서가 다음 줄까지 읽어 뒤 키를 삼키고, # 뒤는 잘린다(적대 검토 P2 실측)
      const quote = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "allowedUserIds", "'42", "bundled");
      const hash = await settings.writePluginEnvSetting("telegram-channel", tgSpecs, "botToken", "pa#ss", "bundled");
      const after = readFileSync(envFile, "utf8");
      out.push(assert("② 직접 설치한 플러그인이 코어 키를 가리키면 거절 · 자기 이름공간은 허용 · 줄바꿈 값 거절(다른 키 심기 차단) · 파일 칸은 .env 가 아님",
        homeCore?.ok === false && homeCore.errorKey === "plugins.reason.envNameNotOwn" && !after.includes("CLAUDE_CODE_OAUTH_TOKEN") &&
          homeOwn?.ok === true && after.includes("TIGUCLAW_PLUGIN_MY_PLUGIN_APIKEY=k1") &&
          multi?.ok === false && !after.includes("ANTHROPIC_API_KEY") && fileKey === undefined &&
          port?.ok === false && port.errorKey === "plugins.reason.settingComesFromEnv" && !after.includes("HTTP_BRIDGE_PORT") &&
          locked?.ok === false && locked.errorKey === "plugins.reason.settingReadOnly" &&
          quote?.errorKey === "plugins.reason.envValueUnsafe" && hash?.errorKey === "plugins.reason.envValueUnsafe" && !after.includes("pa#ss") && !after.includes("'42"),
        { homeCore, homeOwn: homeOwn?.ok, multi, fileKey, port: port?.errorKey, locked: locked?.errorKey, quote: quote?.errorKey, hash: hash?.errorKey }));
    } finally {
      if (prevTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevTok;
      if (prevIds === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS; else process.env.TELEGRAM_ALLOWED_USER_IDS = prevIds;
    }

    // ③ «내 ID 찾기»
    {
      // plugins/ 는 URL 로 부른다 — src 가 리터럴로 짚으면 `npm run build`(rootDir=src)가 죽는다(src-stays-inside-src).
      type Sender = { id: string; name: string; username?: string; at: number };
      type Route = { handler: (q: Record<string, string>, host: never) => Promise<unknown> };
      const oc = (await import(new URL("../../../plugins/telegram-channel/owner-candidates.js", import.meta.url).href)) as {
        sendersFromUpdates: (json: unknown) => Sender[];
        recordBlockedSender: (from: Record<string, unknown>, now?: number) => void;
        toItems: (s: readonly Sender[]) => Array<{ value: string; label: string }>;
        ownerCandidateRoutes: (polling: () => boolean) => Record<string, Route>;
      };
      const parsed = oc.sendersFromUpdates({ ok: true, result: [
        { message: { date: 100, from: { id: 1, first_name: "Old", is_bot: false } } },
        { message: { date: 300, from: { id: 2, first_name: "Jeong", last_name: "Tae", username: "jt", is_bot: false } } },
        { message: { date: 200, from: { id: 9, first_name: "SomeBot", is_bot: true } } },
        { message: { date: 400, from: { id: 1, first_name: "Old", is_bot: false } } },
      ] });
      for (let i = 0; i < 12; i++) oc.recordBlockedSender({ id: 1000 + i, first_name: `u${i}` }, i);
      const items = oc.toItems(parsed);
      let fetched = 0;
      const mkHost = (token: string | undefined) =>
        ({ settings: token === undefined ? {} : { botToken: token }, fetch: async () => { fetched += 1; return new Response("{}"); } }) as never;
      const routes = (polling: boolean) => oc.ownerCandidateRoutes(() => polling)["owner-candidates"]!;
      const pollingR = (await routes(true).handler({}, mkHost("t"))) as { items: { value: string }[] };
      const beforeRestart = (await routes(false).handler({}, mkHost("t"))) as { items: unknown[]; note?: string };
      const noTok = (await routes(false).handler({}, mkHost(undefined))) as { note?: string };
      const tgSrc = stripComments(readSourceSync("plugins/telegram-channel/index.ts"));
      const liveAllow = /isAllowedSender\(ctx\.from\?\.id, parseAllowedTelegramIds\(\)\)/.test(tgSrc);
      const downloadUsesBotToken = /const token = bot\.token;/.test(tgSrc) && !/const token = process\.env\.TELEGRAM_BOT_TOKEN \?\? "";/.test(tgSrc);
      out.push(assert("③ 내 ID 찾기 — 막힌 보낸 사람 최근 10명 · getUpdates 를 부르지 않는다(다른 인스턴스 폴링을 끊지 않게) · 폴링 전이면 «먼저 재시작» · 소유자 목록은 메시지마다 · 첨부는 폴링 중인 봇 토큰으로",
        parsed.map((x) => x.id).join() === "1,2" && items[1]!.label.includes("@jt") &&
          pollingR.items.length === 10 && pollingR.items[0]!.value === "1011" && fetched === 0 &&
          beforeRestart.items.length === 0 && beforeRestart.note === "restart-first" && noTok.note === "token-missing" && liveAllow && downloadUsesBotToken,
        { polling: pollingR.items.length, fetched, beforeRestart: beforeRestart.note, noTok: noTok.note, liveAllow, downloadUsesBotToken }));
    }

    // ③' 실행 — 잠긴 채 시작한 봇에, 소유자를 고르면(= process.env 갱신) **재시작 없이** 그 다음 메시지부터 통한다
    {
      const tg = await import("./_fake-telegram.js");
      const mod = await tg.loadTelegram();
      const { channel, bot } = tg.fakeChannel(mod);
      const seen: string[] = [];
      const prevIds = process.env.TELEGRAM_ALLOWED_USER_IDS;
      try {
        await tg.startWithOwners(channel, "", async (msg) => { seen.push(msg.channelUserId); });
        await bot.handleUpdate(tg.textUpdate(777, "잠긴 동안"));
        await tg.settle();
        const lockedReached = seen.length;
        process.env.TELEGRAM_ALLOWED_USER_IDS = "777"; // 설정 화면에서 골랐다(writePluginEnvSetting 이 process.env 를 즉시 바꾼다)
        await bot.handleUpdate(tg.textUpdate(777, "고른 뒤"));
        await tg.settle();
        out.push(assert("③' 잠긴 채 시작한 봇도 소유자를 고르면 재시작 없이 다음 메시지부터 통한다(그 전 메시지는 막혔다)",
          lockedReached === 0 && seen.includes("777"), { lockedReached, seen }));
      } finally {
        await (channel as { stop?: () => Promise<void> }).stop?.();
        if (prevIds === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS; else process.env.TELEGRAM_ALLOWED_USER_IDS = prevIds;
      }
    }

    // ④ 꺼 둔 플러그인의 자산 · 텔레그램 연결 스킬
    {
      const { activePluginDirs } = await import("../../core/plugins/active-dirs.js");
      const root = mkdtempSync(path.join(os.tmpdir(), "active-dirs-"));
      for (const [dir, name] of [["alpha", "alpha"], ["beta-folder", "beta"]] as const) {
        mkdirSync(path.join(root, dir));
        writeFileSync(path.join(root, dir, "package.json"), JSON.stringify({ tiguclaw: { name } }));
      }
      const settingsFile = getPaths().settings;
      let prevSettings: string | undefined;
      try { prevSettings = readFileSync(settingsFile, "utf8"); } catch { prevSettings = undefined; }
      writeFileSync(settingsFile, JSON.stringify({ modules: { disabled: ["beta"] } }));
      let ids: string[] = [];
      try {
        ids = (await activePluginDirs(root)).map((d) => d.id);
      } finally {
        if (prevSettings === undefined) writeFileSync(settingsFile, "{}"); else writeFileSync(settingsFile, prevSettings);
      }
      const { discoverSkills } = await import("../../core/llm-runtime/capabilities/skill-registry.js");
      const skills = await discoverSkills(process.cwd());
      const tg = skills.find((s) => s.name === "telegram-connect");
      const skillBody = tg === undefined ? "" : readFileSync(tg.filePath, "utf8");
      out.push(assert("④ 꺼 둔 플러그인(매니페스트 이름 기준)의 자산은 안 실린다 · 텔레그램 플러그인이 연결 스킬을 낸다(토큰은 채팅에 안 받음 · 대시보드 설정으로)",
        ids.join() === "alpha" && tg?.source === "plugin" && tg.pluginId === "telegram-channel" &&
          /채팅으로 받지 않는다/.test(skillBody) && /내 ID 찾기/.test(skillBody) && /플러그인/.test(skillBody),
        { ids, tg: tg === undefined ? null : { source: tg.source, pluginId: tg.pluginId } }));
    }

    // ⑤ 배선
    {
      const route = stripComments(readSourceSync("plugins/http-bridge/routes-inventory.ts"));
      const view = stripComments(readSourceSync("packages/dashboard/js/view-plugins.js"));
      const tg = stripComments(readSourceSync("plugins/telegram-channel/index.ts"));
      const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/telegram-channel/package.json"), "utf8")) as { tiguclaw: { settings: { key: string; suggest?: string }[] } };
      const w = {
        routeUsesCoreEnvWriter: /writePluginEnvSetting\(/.test(route) && /envR \?\? writePluginSetting\(/.test(route) && /bundledFound !== undefined \? "bundled" : "home"/.test(route),
        secretInput: /sec\.type = "password"/.test(view) && /pluginAction\("set-setting", p\.name, \{ key: spec\.key, value: raw \}\)/.test(view),
        envInput: /if \(spec\.env && spec\.editable === true && !spec\.readOnly\)/.test(view),
        suggestFetch: /"\/api\/plugin-data\/" \+ encodeURIComponent\(pluginName\) \+ "\/" \+ encodeURIComponent\(spec\.suggest\)/.test(view),
        // 데이터 라우트 응답은 `{ data, cached }` 로 감싸 온다 — 화면이 안을 본다(겉을 읽어 늘 «없음» 이던 것, 띄워서 확인)
        suggestUnwraps: /outer\.data !== undefined \? outer\.data : outer/.test(view) && /JSON\.stringify\(\{ data: r\.value, cached: r\.cached \}\)/.test(route),
        restartBar: /pluginsState\.restartPending === true/.test(view) && /if \(\(await restartDaemon\(\)\) === true\)/.test(view),
        middlewareRecords: /recordBlockedSender\(ctx\.from\)/.test(tg) && /getDataRoutes\(\)/.test(tg),
        manifestSuggest: manifest.tiguclaw.settings.find((x) => x.key === "allowedUserIds")?.suggest === "owner-candidates" &&
          (manifest.tiguclaw.settings.find((x) => x.key === "allowedUserIds") as { editable?: boolean; live?: boolean } | undefined)?.editable === true &&
          (manifest.tiguclaw.settings.find((x) => x.key === "allowedUserIds") as { live?: boolean } | undefined)?.live === true,
      };
      out.push(assert("⑤ 라우트는 .env 칸을 코어 판정으로 · 화면은 비밀 입력·.env 입력·«찾기»·재시작 막대 · 미들웨어가 막힌 사람을 기억 · 매니페스트 suggest·editable",
        Object.values(w).every(Boolean), w));
    }
    return out;
  },
};
