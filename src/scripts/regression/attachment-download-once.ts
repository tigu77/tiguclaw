/**
 * 회귀: **첨부 받기(⬇) 한 번 = 다운로드 한 번** (2026-11-02 사용자 신고 «ZIP 받기 한 번에 두 개 받아짐»).
 *
 * 원인(실제 Chrome 재현 — 개발돌쇠 홈 `workspace/_scratch/attachment-double-download/run-3s1bCJ/result.json`): 파일 칩(`.att-chip`)에 «열기»
 *  (`window.open`) 클릭 핸들러가 있고, 받기 버튼은 그 칩 **안**의 `a[download]` 다. 받기를 누르면 `a` 의 기본 다운로드 + 부모로 번진 클릭의 새 탭 열기
 *  (ZIP 은 표시할 수 없어 또 다운로드) — 2건. 고침 = 받기의 클릭 전파만 끊는다(기본 다운로드·파일명은 그대로 — `preventDefault` 금지).
 * 이 검사가 지키는 것(제품 `buildAttachmentsPreview` 그대로 — 미니 DOM):
 *  ① 받기 클릭 → 칩 «열기» 0회 · 기본 동작이 살아 있다(`defaultPrevented` 아님) · 받기 주소·저장 이름 그대로(서빙 rel: `?download=1&name=`)
 *  ② 칩 본문 클릭 → «열기» 1회(서빙 rel 은 `?name=` 붙은 주소) — 열기 기능 보존
 *  ③ 낙관적 버블(base64)도 같다 · 인바운드(받기 버튼 없음)는 칩 열기만
 * 등급: 동작(진짜 소스 · 클릭 버블링을 흉내 내는 미니 DOM). 실제 브라우저 다운로드 건수는 이 검사가 아니라 격리 실흐름이 잰다.
 */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

export const check: RegressionCheck = {
  name: "attachment-download-once",
  guards: "첨부 받기(⬇)를 한 번 눌렀는데 파일이 두 번 받아지던 것(받기 클릭이 부모 칩의 새 탭 열기로 번짐) — 고치며 생길 것: 받기 자체가 죽음 · 파일명 유실 · 칩 열기 상실",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);
    const dash = bootDashboard({ clock: makeClock(), i18n: i18nForContext, allIds: true, upTo: "axis1-options.js", fetch: async () => jsonResponse({}, 404) });
    dash.run(`globalThis.__opens = []; window.open = (...a) => { __opens.push(String(a[0])); return null; };`);
    // 낙관적 버블(base64)의 열기 주소는 blob URL 이다 — 미니 DOM 에 없는 브라우저 API 만 대역(있으면 그대로).
    dash.run(`if (typeof atob !== "function") globalThis.atob = () => "x"; if (typeof Blob !== "function") globalThis.Blob = class {}; if (typeof URL === "undefined") globalThis.URL = {}; if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:test";`);
    // 칩 하나를 그려 받기·본문을 누른다 — 클릭은 버블링하는 이벤트(브라우저와 같은 경로)로, 기본 동작 취소 여부를 돌려받는다.
    const probe = (att: R, download: boolean): R => dash.run(`(() => {
      __opens.length = 0;
      const wrap = buildAttachmentsPreview([${JSON.stringify(att)}], { download: ${download} });
      document.body.appendChild(wrap);
      const find = (n, cls) => { if ((" " + (n.className || "") + " ").includes(" " + cls + " ")) return n; for (const c of (n.children || [])) { const r = find(c, cls); if (r) return r; } return null; };
      const click = (el) => { const ev = { type: "click", bubbles: true, cancelable: true, defaultPrevented: false, _stopped: false, detail: 1,
        stopPropagation() { this._stopped = true; }, stopImmediatePropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
        el.dispatchEvent(ev); return { prevented: ev.defaultPrevented }; };
      const dl = find(wrap, "att-dl");
      const r = { hasDl: !!dl, href: dl ? (dl.getAttribute("href") || dl.href || null) : null, name: dl ? dl.getAttribute("download") : null };
      if (dl) { const c = click(dl); r.dlOpens = __opens.slice(); r.dlPrevented = c.prevented; }
      __opens.length = 0;
      const body = find(wrap, "att-fname") || find(wrap, "att-chip");
      click(body); r.bodyOpens = __opens.slice();
      wrap.remove();
      return r;
    })()`) as R;

    const served = probe({ rel: "http-bridge/20261102/abc123.zip", name: "proof.zip", mime: "application/zip", kind: "file" }, true);
    out.push(assert(
      "★① 서빙 첨부 받기(⬇) 클릭 — 칩 «열기» 0회(한 번 = 한 번) · 기본 다운로드 살아 있음(취소 안 함) · 받기 주소 `?download=1&name=` · 저장 이름 그대로",
      served.hasDl && Array.isArray(served.dlOpens) && served.dlOpens.length === 0 && served.dlPrevented === false &&
        served.href === "/api/attachments/http-bridge/20261102/abc123.zip?download=1&name=proof.zip" && served.name === "proof.zip",
      show(served),
    ));
    out.push(assert(
      "★② 칩 본문 클릭 — «열기» 1회(서빙 주소에 원래 이름 `?name=`) · 열기 기능 보존",
      served.bodyOpens.length === 1 && served.bodyOpens[0] === "/api/attachments/http-bridge/20261102/abc123.zip?name=proof.zip",
      show(served.bodyOpens),
    ));
    const optimistic = probe({ dataBase64: Buffer.from("synthetic").toString("base64"), name: "proof.zip", mime: "application/zip" }, true);
    const inbound = probe({ rel: "http-bridge/20261102/def456.zip", name: "in.zip", mime: "application/zip", kind: "file" }, false);
    out.push(assert(
      "③ 낙관적 버블(base64) 받기도 열기 0회·기본 동작 살아 있음 · 본문은 열기 1회 / 인바운드(받기 버튼 없음)는 칩 열기만 1회",
      optimistic.hasDl && optimistic.dlOpens.length === 0 && optimistic.dlPrevented === false && optimistic.name === "proof.zip" &&
        optimistic.bodyOpens.length === 1 && !inbound.hasDl && inbound.bodyOpens.length === 1,
      show({ optimistic, inbound }),
    ));
    // ★파일명 보존 — 공백·`&`·`#`·한글이 든 이름이 받기 주소에서 원래 이름 그대로 되살아난다(인코딩이 빠지면 `&` 에서 잘리고 `#` 뒤가 조각이 된다 — 독립 변이 M25)
    const odd = "영수증 & 요약#최종.zip";
    const special = probe({ rel: "http-bridge/20261102/ghi789.zip", name: odd, mime: "application/zip", kind: "file" }, true);
    const parsed = ((): R => { try { const u = new URL(String(special.href), "http://x"); return { name: u.searchParams.get("name"), dl: u.searchParams.get("download"), hash: u.hash }; } catch (e) { return { err: String(e) }; } })();
    const openParsed = ((): R => { try { const u = new URL(String(special.bodyOpens[0]), "http://x"); return { name: u.searchParams.get("name"), hash: u.hash }; } catch (e) { return { err: String(e) }; } })();
    out.push(assert(
      "★④ 특수문자 파일명(공백·&·#·한글) — 받기 주소의 `name` 이 원래 이름 그대로(조각 없음) · `download=1` · 저장 이름 속성 그대로 · 칩 열기 주소의 `name` 도 그대로",
      parsed.name === odd && parsed.dl === "1" && parsed.hash === "" && special.name === odd && openParsed.name === odd && openParsed.hash === "" && special.dlOpens.length === 0,
      show({ special, parsed, openParsed }),
    ));
    return out;
  },
};
