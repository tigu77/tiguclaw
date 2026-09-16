      /**
       * HTML 텍스트 이스케이프 (2026-07-31 전체검토 P0).
       *
       * ★왜: 서버 문자열을 문자열 연결로 `innerHTML` 에 넣던 자리 9곳에서 XSS 가 실증됐다
       *  (스킬·에이전트·MCP 의 name/description, 프로바이더 name/summary/status,
       *   AGENT.md 의 `이름:`). 셋 다 **비서가 스스로 쓰는 값**이라 프롬프트 인젝션 한 번이면
       *  영속 XSS 가 되고, 같은 오리진의 `/api/messages`(=비서에게 임의 지시 = 도구 실행)·
       *  `/api/restart`·`/api/open-path` 를 전부 부를 수 있었다.
       *
       * 속성 위치(`class="..."`)에도 쓰이므로 따옴표 둘 다 이스케이프한다.
       * 마크다운 본문은 이 함수가 아니라 `renderMarkdown`(sanitize 통과)이 담당한다.
       */
      const escHtml = (v) =>
        String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");

      /**
       * 첨부 크기 표시 — **공유 유틸에 있어야 하는 이유가 있다** (2026-07-31 3차 검토).
       *
       * ★사고: 이 함수가 `chat-send.js`(로드 #29)에 있는데 `history-render.js`(#18)가 썼다.
       *  클래식 스크립트의 top-level `const` 는 스크립트 간 공유되지만 **실행 전엔 TDZ** 다.
       *  그런데 `tabs.js`(#25)가 top-level 에서 `loadChatHistory()` 를 부르고, 그 fetch 가
       *  `chat-send.js` 로드보다 먼저 끝나면(라이브 실측: 이력 214ms vs 스크립트 376ms —
       *  **창이 항상 열려 있다**) 렌더 중 `ReferenceError` 가 나고 catch 가 그걸 삼켜
       *  **채팅이 통째로 백지**가 됐다. 최근 20건에 `bytes` 를 가진 첨부가 하나만 있어도 발동.
       *
       *  교훈: 부팅 async 연속이 동기 렌더를 하면 그 렌더가 쓰는 것은 **더 앞에서** 정의돼야
       *  한다. 공유 유틸을 기능 파일에 두면 로드 순서가 그대로 잠재 버그가 된다.
       */
      const fmtBytes = (b) =>
        b < 1024
          ? b + "B"
          : b < 1048576
            ? Math.round(b / 1024) + "KB"
            : (b / 1048576).toFixed(1) + "MB";

      /**
       * **서버가 말한 첨부 상한을 읽는다** (2026-09-15).
       *
       * ★`/health` 의 `limits` 를 화면이 쓰는 모양으로 옮기는 것뿐인데, 이걸 순수 함수로
       *  둔 이유는 **뒤바꿈을 검사가 잡을 수 있어야** 하기 때문이다. 세 수를 인라인으로
       *  옮기면 `fileBytes: l.attachment_total_bytes` 같은 한 글자 실수가 어떤 검사도
       *  안 지나간다 — 이름은 다 맞고 값만 틀리니 소스 대조로는 영원히 안 보인다.
       * ★셋 중 하나라도 수가 아니면 **통째로 «모른다»** 로 답한다(`null`). 반쯤 아는 상태로
       *  막으면 그게 이번 사고의 형상이다 — 서버는 받는데 화면이 거절하는 것.
       */
      const attachLimitsFrom = (health) => {
        const l = health && health.limits;
        if (!l) return null;
        const count = l.attachment_count,
          fileBytes = l.attachment_bytes,
          totalBytes = l.attachment_total_bytes;
        for (const n of [count, fileBytes, totalBytes]) {
          if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
        }
        return { count, fileBytes, totalBytes };
      };

      /**
       * **첨부를 미리 거절할까 — 판정만** (2026-09-15 정태님 신고로 생겼다).
       *
       * ★배경: 브라우저에 `10 * 1024 * 1024` 가 박혀 있어서, 서버 상한을 20MB 로 올렸는데도
       *  화면이 **보내기도 전에** 거절했다. 같은 계약이 네 곳에 살고 있었고 두 곳만 올라갔다.
       *  이제 상한은 `/health` 가 준다(`limits`) — 여기엔 숫자를 적지 않는다.
       * ★**모르면 막지 않는다**(`limits` 가 없으면 `null`). 이 검사는 «올리기 전에 알려주는»
       *  친절이고 판정자는 서버(`ingestAttachments`)다. 모를 때 막으면 그게 바로 이번 사고의
       *  형상이다 — 서버는 받는데 손잡이가 닫힌 것.
       * ★순수 함수로 둔 이유는 검사가 **실행**해서 판정할 수 있어야 하기 때문이다
       *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
       *
       * @returns `null`(통과) · `"count"` · `"size"` · `"total"`
       */
      /**
       * **전송이 명시적으로 거절됐을 때 화면이 무엇을 하나** — 순수 (2026-09-16).
       *
       * ★사고: `/messages` 는 **턴을 동기로 돌고 반환**한다. 턴이 도중에 던지면 브리지가
       *  **한참 뒤에** 비-2xx 를 준다. 그런데 종전엔 오류 표시와 작업중 해제가 **둘 다**
       *  «10초 안에 실패했을 때만» 안에 들어 있어서, 느린 거절은 **아무 말도 없이** 텍스트만
       *  입력창으로 되돌아왔다 — 사용자 눈엔 «턴은 도는 것 같은데 방금 보낸 글이 다시
       *  입력창에 있다» 가 된다(정태님 신고).
       *
       * ★**두 판단은 다르다:**
       *  - «말해주나» — 서버가 **명시적으로 거절**했으면 **언제나 말한다.** 되돌아온 글의
       *    이유를 사용자가 알아야 다시 보낼지 고칠지 정한다.
       *  - «작업중을 끄나» — 긴 턴은 답이 SSE 로 올 수 있어 **즉시 실패일 때만** 끈다.
       *    늦은 실패는 SSE(`turn_error`)가 정리하게 둔다.
       */
      const sendRejectionAction = (elapsedMs, status) => {
        // ★상수를 **안에** 둔다 — 회귀가 이 함수만 떼어 실행하므로, 바깥 이름을 참조하면
        //  «검사 자체가 던진다». 판정에 필요한 것은 전부 이 안에 있어야 한다.
        const IMMEDIATE_MS = 10000; // 이 안에 실패하면 «즉시 실패»(긴 턴이 아니다).
        return {
          tellUser: true, // 명시적 거절은 시간과 무관하게 말한다.
          clearWorking: Number(elapsedMs) < IMMEDIATE_MS,
          status: Number(status) || 0,
        };
      };

      /**
       * **전송이 실패했을 때 첨부 큐를 어떻게 되돌리나** — 순수 (2026-09-16 아스트라 P2).
       *
       * ★종전엔 이 판단이 `chat-send.js` 안에 인라인이었고, 회귀는 **소스에 `.slice(0, cap)`
       *  이 있는지**만 봤다. 그래서 «자른다» 라는 **틀린 동작을 검사가 고정**했다 — 버그와
       *  같이 쓴 검사는 그 버그를 못 잡는다. 판단을 여기 두면 검사가 **실행**한다
       *  ([[feedback_simple_composable_no_duplication]]).
       *
       * ★**자르지 않는다.** 되돌릴 것이 상한을 채우면 기다리는 동안 새로 붙인 파일이
       *  조용히 사라진다. 실패 복원은 **사용자가 넣은 것을 지우지 않는다** — 넘친 채로
       *  두고 «넘쳤다» 를 알린다. 칩마다 ×가 있어 지울 수 있고, 다음 전송은
       *  `attachRejection` 이 막는다. 즉 **보이고 되돌릴 수 있는 상태**다.
       * ★순서는 «되돌린 것 먼저, 새로 붙인 것 뒤» — 사용자가 방금 붙인 것이 더 최신이라
       *  뒤에 둔다(입력창 텍스트를 되돌리는 규칙과 같다).
       */
      const restoreAttachments = (sentAtts, pending, limits) => {
        const next = [...sentAtts, ...pending];
        const cap = limits && Number.isFinite(Number(limits.count)) ? Number(limits.count) : null;
        return { next, overCap: cap !== null && next.length > cap, cap };
      };

      const attachRejection = (queuedCount, queuedBytes, fileBytes, limits) => {
        if (!limits) return null; // 서버 상한을 모른다 — 서버가 판정한다.
        const count = Number(limits.count),
          max = Number(limits.fileBytes),
          total = Number(limits.totalBytes);
        if (Number.isFinite(count) && queuedCount >= count) return "count";
        if (Number.isFinite(max) && fileBytes > max) return "size";
        if (Number.isFinite(total) && queuedBytes + fileBytes > total) return "total";
        return null;
      };

      /**
       * 시간 표기 두 축 — **답하는 질문이 다르다.** (2026-08-21)
       *
       *  - `fmtAgo(ts)`   "언제 일어났나"  → `방금` · `3분 전` · `2시간 전` · `3일 전`
       *  - `fmtElapsed(ms)` "얼마나 걸렸나" → `12s` · `3m 40s` · `1h 20m`
       *
       * ★**정본을 여기 둔다.** 상대시간은 대시보드에 아예 없었고(grep 히트는 전부 주석이었다),
       *  경과시간은 `background-drawer.js` 안에 갇혀 있어 다른 카드가 못 썼다. 카드마다
       *  인라인으로 넣으면 곧 네 벌이 되고, 그러면 "3분 전" 의 기준이 파일마다 갈린다.
       *  순수 함수라 회귀가 **실행으로** 지킬 수 있다.
       *
       * ★미래 시각은 `방금` 으로 접는다 — 시계 어긋남(서버/브라우저)으로 음수가 나와도
       *  "-3분 전" 같은 걸 보여주지 않는다. 판정 불가를 사용자에게 떠넘기지 않는다.
       */
      const fmtAgo = (ts) => {
        const t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return "";
        const sec = Math.floor((Date.now() - t) / 1000);
        if (sec < 60) return i18n("time.justNow");
        const min = Math.floor(sec / 60);
        if (min < 60) return i18n("time.minsAgo", { n: min });
        const hr = Math.floor(min / 60);
        if (hr < 24) return i18n("time.hoursAgo", { n: hr });
        const day = Math.floor(hr / 24);
        if (day < 30) return i18n("time.daysAgo", { n: day });
        const mon = Math.floor(day / 30);
        return mon < 12
          ? i18n("time.monthsAgo", { n: mon })
          : i18n("time.yearsAgo", { n: Math.floor(mon / 12) });
      };

      /**
       * 화면 문구 — 키를 문장으로. 서버가 index.html 에 주입한 카탈로그를 본다.
       *
       * ★이름이 `t` 가 아닌 이유: 이 코드베이스에서 `t` 는 **지역 변수로 너무 흔하다**
       *  (`const t = Number(ts)`·`const t = document.createElement("div")` … 실측 13곳).
       *  그 안에서 부르면 가려져 **라이브에서 TypeError** 가 난다. 관례보다 견고함이 먼저다.
       *
       * ★폴백은 코어와 **같은 규칙**이다: 카탈로그에 없으면 **키 자체**를 낸다. 빈 문자열을
       *  내면 버튼이 사라져 화면이 깨진다 — 반쯤 번역한 파일을 넣어보는 게 가능해야 하고,
       *  그게 "사용자가 언어를 늘린다" 의 전제다.
       * ★`{name}` 자리표시자만 채운다. 값이 없으면 자리표시자를 **남긴다**(지우면 문장이
       *  조용히 이상해진다).
       */
      const i18n = (key, params) => {
        const cat = (window.__TIGU_I18N__ && window.__TIGU_I18N__.strings) || {};
        // ★빈 문자열은 「없음」으로 친다 — 서버 병합이 이미 막지만, 화면이 직접 받은
        //  카탈로그에 빈 값이 있어도 **키를 보여주는 쪽**이 빈 버튼보다 낫다(마지막 방어).
        const hit = cat[key];
        const raw = typeof hit === "string" && hit !== "" ? hit : key;
        if (!params) return raw;
        return raw.replace(/\{(\w+)\}/g, (whole, name) =>
          params[name] === undefined ? whole : String(params[name]),
        );
      };
      const currentLocale = () =>
        (window.__TIGU_I18N__ && window.__TIGU_I18N__.locale) || "ko";

      /**
       * 카탈로그 문구를 **DOM 으로** 조립한다 — `{자리표시자}` 에 문자열뿐 아니라 **엘리먼트**를
       * 넣을 수 있다. 반환은 DocumentFragment.
       *
       * ★왜 필요한가: 문구 안에 `<code>`·`<i>` 같은 태그가 섞인 자리가 있는데, 그걸 담으려고
       *  카탈로그 값을 `innerHTML` 에 넣으면 **번역 파일 하나가 대시보드 XSS 벡터**가 된다.
       *  언어 파일은 사용자가 받아서 홈에 놓는 데이터다(스킬·에이전트와 같은 신뢰 등급이
       *  아니다 — 이건 남이 만든 것을 받아 쓰라고 만든 기능이다). 같은 오리진에
       *  `/api/messages`(=비서에게 임의 지시 = 도구 실행)가 있어 대가가 크다.
       * ★그래서 **문구는 언제나 텍스트 노드**로 들어가고, 태그는 코드가 만든다. 조각으로
       *  쪼개 이어붙이는 대신 자리표시자를 쓰므로 어순이 다른 언어에서도 성립한다.
       * 값이 없는 자리표시자는 `i18n()` 과 같은 규칙으로 **그대로 남긴다**.
       */
      const i18nNodes = (key, parts) => {
        const frag = document.createDocumentFragment();
        const raw = i18n(key);
        let last = 0;
        // ★같은 자리표시자가 **두 번 나오면 사본을 넣는다.** `appendChild` 는 노드를 복사하지
        //  않고 **옮기므로**, 그냥 넣으면 두 번째가 첫 번째에서 훔쳐 가 앞자리가 조용히 빈다
        //  (콘솔 에러 0, 문장은 그럴듯하게 남는다). 값이 문자열일 땐 멀쩡하고 **엘리먼트일
        //  때만** 깨져서 더 안 보인다. 번역하는 사람이 자리표시자를 반복하는 건 흔한 일이고,
        //  그게 바로 이 기능을 쓰는 사람이다.
        const usedNodes = new Set();
        for (const m of raw.matchAll(/\{(\w+)\}/g)) {
          if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
          const v = parts ? parts[m[1]] : undefined;
          let node;
          if (v instanceof Node) {
            node = usedNodes.has(m[1]) ? v.cloneNode(true) : v;
            usedNodes.add(m[1]);
          } else {
            node = document.createTextNode(v === undefined ? m[0] : String(v));
          }
          frag.appendChild(node);
          last = m.index + m[0].length;
        }
        if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
        return frag;
      };
      /**
       * 서버가 준 표시값을 문장으로 — **언어 판정은 여기 한 곳**.
       *
       * 서버(`src/core/plugins/providers.ts` 의 `DisplayText`)는 두 모양만 보낸다:
       *  - **문자열** = 언어가 없는 값(브랜드명·`pid 51759`·런타임 에러 메시지) → 그대로
       *  - **스펙** `{ key, params }` = 화면이 카탈로그로 만들 문장 → 여기서 만든다
       * ★데몬은 하나인데 보는 사람의 언어는 브라우저마다 다를 수 있다. 그래서 문장은
       *  **서버가 아니라 화면**이 만든다(서버가 고른 언어는 애초에 맞을 수가 없다).
       */
      const resolveText = (v) => {
        if (typeof v === "string") return v;
        if (typeof v === "number") return String(v);
        if (v && typeof v === "object" && typeof v.key === "string") {
          // ★자리표시자 값도 스펙일 수 있다(재귀). 그래야 "재부팅 시 · {state}({status})" 처럼
          //  안쪽에 또 문구가 들어가는 문장을 **조합 폭발 없이** 한 키로 둘 수 있다
          //  (안 그러면 on/off × 실행/미실행 로 키가 네 배가 된다).
          const params = {};
          for (const k of Object.keys(v.params || {})) params[k] = resolveText(v.params[k]);
          return i18n(v.key, params);
        }
        return "";
      };
      /** `<code>텍스트</code>` 한 개 — i18nNodes 자리표시자에 넣는 용도. */
      const codeNode = (text) => {
        const el = document.createElement("code");
        el.textContent = text;
        return el;
      };

      /**
       * `data-i18n="key"` 를 가진 요소를 카탈로그 문구로 채운다.
       *
       * ★HTML 은 정적이라 기본 언어 문구를 **그대로 써둔다** — 그러면 카탈로그가 없거나
       *  주입이 실패해도 화면이 한국어로 멀쩡히 뜬다(빈 화면 0). 채우는 건 덮어쓰기다.
       * ★키가 카탈로그에 없으면 **손대지 않는다** — `i18n()` 처럼 키를 써넣으면 오히려
       *  HTML 에 있던 멀쩡한 문구가 `nav.settings` 로 바뀐다(더 나쁘다).
       */
      const applyI18n = (root) => {
        const cat = (window.__TIGU_I18N__ && window.__TIGU_I18N__.strings) || {};
        for (const el of (root || document).querySelectorAll("[data-i18n]")) {
          const v = cat[el.dataset.i18n];
          if (typeof v === "string" && v !== "") el.textContent = v;
        }
        // 속성도 같은 규칙으로 — `data-i18n-attrs="placeholder=key;title=key2"`.
        // 형태를 하나로 두어 속성마다 새 이름을 만들지 않는다(placeholder·title·aria-label…).
        for (const el of (root || document).querySelectorAll("[data-i18n-attrs]")) {
          for (const pair of el.dataset.i18nAttrs.split(";")) {
            const eq = pair.indexOf("=");
            if (eq < 0) continue;
            const v = cat[pair.slice(eq + 1).trim()];
            if (typeof v === "string" && v !== "") el.setAttribute(pair.slice(0, eq).trim(), v);
          }
        }
      };

      const fmtElapsed = (ms) => {
        const s = Math.max(0, Math.floor(Number(ms) / 1000));
        if (!Number.isFinite(s)) return "";
        if (s < 60) return s + "s";
        const m = Math.floor(s / 60), rs = s % 60;
        if (m < 60) return m + "m " + rs + "s";
        const h = Math.floor(m / 60), rm = m % 60;
        return h + "h " + rm + "m";
      };

      // 입력창(chat-input) 자동 포커스 = 중앙 정책 한 곳.
      //
      // 2026-07-24: 전면 비활성이었다(모바일 가상키보드 팝업 + 데스크톱 포커스 뺏기).
      //   그 판단은 **탭·뷰 전환·전송·슬래시** 에는 지금도 유효하다 — 사용자가 입력을
      //   원한 적이 없는데 커서가 끌려간다.
      // 2026-08-10: **답글·마이크만** 켠다(사용자 결정). 이 둘은 사용자가 방금
      //   "이제 입력하겠다" 는 행동을 한 자리라, 껐던 이유에 해당하지 않는다.
      //
      // ★허용 **이름 목록**을 두지 않는다 — 호출부가 늘 때 목록은 조용히 뒤처진다.
      //  대신 호출부가 *의도*를 밝히고 여기선 그 의도만 본다. 인자 없이 부르면(기존
      //  호출부 전부) 종전과 같이 아무것도 안 한다 = 회귀 0.
      const focusChatInput = (opts) => {
        if (!opts || opts.userIntendsToType !== true) return;
        // 모바일은 의도가 명시적이어도 안 켠다 — 껐던 이유의 한 축(가상키보드가 화면을
        // 절반 덮는 것)은 의도와 무관하게 그대로다.
        try {
          if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return;
        } catch { /* matchMedia 미지원 — 계속 진행 */ }
        const el = document.getElementById("chat-input");
        if (!el) return;
        // preventScroll — 포커스 때문에 채팅이 튀지 않게(가상화 스크롤과 경합 회피).
        try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* noop */ } }
      };

      // ── 채팅 입력창 안내문(placeholder) = 판정 한 곳 (2026-08-10) ──────────────
      //
      // ★종전엔 네 곳이 같은 값을 썼다: index.html(기본) · perf.js(터치면 버튼 전송 문구) ·
      //  mobile-nav.js(좁으면 짧게) · ghost-suggest.js(고스트 중엔 비움). 판정 기준도 서로
      //  달랐고(입력 장치 vs 화면 폭) **승자가 로드 순서로** 정해졌다. 실제 결과:
      //   - 폰: mobile-nav 가 나중이라 perf.js 문구는 **한 번도 안 보였다**(죽은 문자열).
      //   - 좁은 데스크톱 창: "메시지 입력…" 만 떠 Enter 전송인지 알 수 없었다.
      //   - 고스트가 떴다 사라지면 초기값으로 되돌아가 모바일 문구가 PC 것으로 바뀌었다.
      //
      // 두 축은 **다른 것을 결정**한다 — *무엇을 안내하나*(전송 방식)는 입력 장치가,
      // *얼마나 길게*는 화면 폭이 정한다. 한 함수에서 조합하면 순서 의존이 사라진다.
      // ★문구는 **부를 때** 카탈로그에서 가져온다 — 여기가 판정 한 곳이므로 마크업에
      //  `data-i18n-attrs` 를 달면 자리가 둘이 된다(달아봤고, JS 가 곧바로 덮었다).
      const CHAT_PLACEHOLDER_ENTER = () => i18n("chat.ph.enter");
      const CHAT_PLACEHOLDER_BUTTON = () => i18n("chat.ph.button");
      const CHAT_PLACEHOLDER_SHORT = () => i18n("chat.ph.short");

      // 주 포인터가 터치인가 — **전송 동작 판정과 같은 기준**이어야 한다(안내문이 그
      // 동작을 설명하므로). perf.js 의 Enter 전송 분기가 이 함수를 쓴다.
      const isTouchPrimary = () =>
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches;
      // 좁은 화면인가 — 긴 안내문이 과한 폭. 전송 동작과는 무관하다.
      const isNarrowScreen = () =>
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 900px)").matches;

      let chatGhostShowing = false;
      const computeChatPlaceholder = () => {
        // 고스트가 같은 자리를 쓴다 — 둘 다 그리면 글자가 겹쳐 못 읽는다.
        if (chatGhostShowing) return "";
        if (isNarrowScreen()) return CHAT_PLACEHOLDER_SHORT();
        return isTouchPrimary() ? CHAT_PLACEHOLDER_BUTTON() : CHAT_PLACEHOLDER_ENTER();
      };
      const refreshChatPlaceholder = () => {
        const el = document.getElementById("chat-input");
        if (el) el.setAttribute("placeholder", computeChatPlaceholder());
      };
      /** 고스트 표시 상태 전달 — 값 자체는 여기서만 정한다(호출부는 사실만 알린다). */
      const setChatGhostShowing = (on) => {
        chatGhostShowing = on === true;
        refreshChatPlaceholder();
      };
      // 회전·창 크기 변경에도 따라간다 — 종전엔 로드 시 1회라 그대로 굳었다.
      try {
        for (const q of ["(pointer: coarse)", "(max-width: 900px)"]) {
          const mq = window.matchMedia(q);
          if (typeof mq.addEventListener === "function") {
            mq.addEventListener("change", refreshChatPlaceholder);
          }
        }
      } catch { /* matchMedia 미지원 — 초기 1회로 충분 */ }

      let toastTimer = null;
      const showToast = (msg, tone) => {
        const el = document.getElementById("toast");
        if (!el) return;
        el.textContent = msg;
        el.className = "show" + (tone ? " " + tone : "");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = el.className.replace("show", "").trim(); }, 4200);
      };

      // 데몬 재시작 — POST /api/restart (bridge POST /restart, admin 토큰 server-side 주입).
      // 메시지 큐를 타지 않는 아웃오브밴드 제어라 턴이 멈춰도 동작. 오발 방지 확인 다이얼로그.
      let restartInFlight = false;
      const restartDaemon = async () => {
        if (restartInFlight) return;
        if (!window.confirm(i18n("daemon.restart.confirm"))) return;
        restartInFlight = true;
        showToast(i18n("daemon.restart.requesting"), "warn");
        try {
          const r = await fetch("/api/restart", { method: "POST" });
          if (r.ok || r.status === 202) {
            showToast(i18n("daemon.restart.running"), "good");
          } else {
            const data = await r.json().catch(() => ({}));
            showToast(i18n("daemon.restart.failed", { err: data.error || ("HTTP " + r.status) }), "bad");
          }
        } catch (err) {
          // 데몬이 즉시 종료되면 응답 전에 연결이 끊길 수 있음 — 정상 흐름으로 안내.
          showToast(i18n("daemon.restart.sent"), "warn");
        } finally {
          setTimeout(() => { restartInFlight = false; }, 6000);
        }
      };

      const formatValue = (value) => {
        if (value === null || value === undefined) return "";
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      };

      /**
       * kv 그리드를 **순서가 있는 쌍 목록**으로 그린다.
       *
       * ★표시 라벨을 데이터 키로 쓰지 않으려고 낸 입구다 (2026-08-25). 번역된 라벨을 객체 키로
       *  넣으면(`meta[i18n("경로")] = ...`) 그 값이 metadata 의 실제 키와 충돌할 수 있고,
       *  **어느 입력이 충돌하는지가 언어마다 달라진다**(`ko` 에선 "경로", `en` 에선 "Path"가
       *  덮인다). 라벨은 표시, 키는 데이터 — 섞이는 자리 자체를 없앤다.
       */
      const appendKvPairs = (root, pairs) => {
        const kv = document.createElement("div");
        kv.className = "kv";
        for (const [key, value] of pairs) {
          const k = document.createElement("div");
          k.className = "kv-key"; k.textContent = key;
          const v = document.createElement("div");
          v.className = "kv-val"; v.textContent = formatValue(value);
          kv.appendChild(k); kv.appendChild(v);
        }
        root.appendChild(kv);
      };
      const appendKv = (root, data) => {
        const entries = data && typeof data === "object" && !Array.isArray(data)
          ? Object.entries(data)
          : [["value", data]];
        appendKvPairs(root, entries);
      };

      // kind 배지 라벨. ADR 2026-07-17(모듈/능력 2축) §5 P0 — 모듈 뷰(옛 프로바이더 뷰)가
      // provider(core|plugin)와 채널 presence(kind:"channel")를 한 목록에 섞어 렌더하므로
      // "channel" 값도 여기서 라벨링한다. provider/service/trigger/observer 는 P1(3패널·type
      // 필드 도입) 이후 실제로 채워질 값 — 지금은 core|plugin|channel 만 실사용.
      const kindLabel = (kind) => {
        const map = {
          provider: i18n("common.kind.module"),
          core: i18n("common.kind.core"),
          plugin: i18n("common.cat.plugin"),
          channel: i18n("common.cat.channel"),
          service: i18n("common.kind.service"),
          trigger: i18n("common.kind.trigger"),
          observer: i18n("common.kind.observer"),
          runtime: i18n("common.kind.runtime"),
          system: i18n("common.kind.system"),
          daemon: i18n("common.kind.daemon"),
          memory: i18n("common.kind.memory"),
          schedule: i18n("common.kind.schedule"),
        };
        return map[kind] || kind || i18n("common.kind.module");
      };

      const statusLabel = (status) => {
        const map = { active: i18n("common.health.ok"), degraded: i18n("common.health.warn"), error: i18n("common.error"), inactive: i18n("common.disabled"), unknown: i18n("common.unknown") };
        return map[status] || status || i18n("common.unknown");
      };

      const dangerLabel = (danger) => {
        const map = { safe: i18n("common.risk.safe"), gray: i18n("common.risk.confirm"), danger: i18n("common.risk.danger") };
        return map[danger] || danger || i18n("common.risk.safe");
      };

      const isCoreProvider = (provider) => {
        const id = provider.id || "";
        const kind = provider.kind || "";
        return id.startsWith("core.") || kind === "core" || ["daemon", "memory", "schedule", "plugin-registry"].some((key) => id.includes(key));
      };

      /**
       * 작업판 레이아웃을 **하나만** 켠다 — 두 컬럼 뷰(모듈·능력·프로젝트·플러그인)와
       * 단일 컬럼(그 외).
       *
       * ★손목록을 없애려고 만들었다 (2026-09-02). 종전엔 뷰마다
       *  `classList.remove("show-capabilities")` 를 손으로 적었고, **이미 갈려 있었다** —
       *  여덟 자리 중 일곱이 `show-capabilities` 만 지우고 한 곳만 셋을 지웠다. 그래서
       *  모듈·프로젝트 뷰에서 다른 뷰로 갈 때 두 컬럼 레이아웃이 남을 수 있었다.
       *  이제 «지금 뷰가 무엇인가» 하나만 말하면 된다([[feedback_hand_maintained_lists]]).
       * @param {string} [name] 두 컬럼을 쓰는 뷰 이름. 없으면 단일 컬럼.
       */
      /**
       * kind 그룹 — **모듈 뷰와 플러그인 뷰가 같은 판단을 쓴다** (2026-09-02 공용으로 이관).
       *
       * ★두 화면이 같은 `kind` 값을 서로 다른 아이콘·순서로 그리면 그게 곧 두 사전이다.
       *  옮기기 전엔 모듈 뷰 안에만 있었고, 플러그인 뷰가 카테고리를 갖는 순간 복사될
       *  자리였다([[feedback_simple_composable_no_duplication]] — 같은 판단이 두 곳).
       * ★미지 kind 는 **뒤로 보내되 지우지 않는다** — 새 kind 가 생겨도 화면에서 사라지지
       *  않는다(코드 변경 0으로 새 그룹이 생긴다).
       */
      const MODULE_GROUP_ORDER = ["channel", "adapter", "llm-adapter", "trigger", "observer", "service", "core", "plugin"];
      const MODULE_GROUP_ICON = { channel: "📡", adapter: "🧠", "llm-adapter": "🧠", trigger: "⏰", observer: "👁️", service: "🖥️", core: "⚙️", plugin: "🔌" };
      const moduleGroupLabel = (kind) => (MODULE_GROUP_ICON[kind] ? MODULE_GROUP_ICON[kind] + " " : "") + kindLabel(kind);
      const groupProvidersByKind = (providers) => {
        const buckets = new Map();
        for (const p of providers) {
          const kind = p.kind || "unknown";
          if (!buckets.has(kind)) buckets.set(kind, []);
          buckets.get(kind).push(p);
        }
        const orderedKinds = Array.from(buckets.keys()).sort((a, b) => {
          const ia = MODULE_GROUP_ORDER.indexOf(a);
          const ib = MODULE_GROUP_ORDER.indexOf(b);
          if (ia === -1 && ib === -1) return 0; // 미지 kind 둘 다면 등장(Map insertion) 순서 유지
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });
        return orderedKinds.map((kind) => ({ kind, label: moduleGroupLabel(kind), items: buckets.get(kind) }));
      };

      const setWorkbenchLayout = (name) => {
        const wb = document.getElementById("workbench");
        if (!wb) return;
        // 이름을 열거하지 않는다 — 지금 붙어 있는 `show-*` 를 전부 걷고 하나만 켠다.
        for (const c of [...wb.classList]) if (c.startsWith("show-")) wb.classList.remove(c);
        if (name) wb.classList.add("show-" + name);
      };

      const renderProviderView = (view) => {
        const div = document.createElement("div");
        div.className = "view";
        const title = document.createElement("div");
        title.className = "view-title";
        title.textContent = resolveText(view.title) || view.id || i18n("tab.view");
        div.appendChild(title);
        const data = view.data || {};
        if (view.kind === "table" && Array.isArray(data.rows)) {
          const table = document.createElement("table");
          table.className = "provider-table";
          const columns = Array.isArray(data.columns) ? data.columns : [];
          const thead = document.createElement("thead");
          const hr = document.createElement("tr");
          for (const col of columns) {
            const th = document.createElement("th"); th.textContent = col;
            hr.appendChild(th);
          }
          thead.appendChild(hr); table.appendChild(thead);
          const tbody = document.createElement("tbody");
          for (const row of data.rows.slice(0, 20)) {
            const tr = document.createElement("tr");
            for (const col of columns) {
              const td = document.createElement("td");
              td.textContent = formatValue(row ? row[col] : "");
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody); div.appendChild(table);
          if (data.rows.length > 20) {
            const more = document.createElement("div");
            more.className = "more"; more.textContent = i18n("common.moreRows", { n: data.rows.length - 20 });
            div.appendChild(more);
          }
        } else if (view.kind === "action-panel" && Array.isArray(data.actions)) {
          // ★버튼이 아니라 **읽는 목록**이다. 종전엔 `<button disabled>` 였는데 실행
          //  endpoint 가 없어 언제나 비활성이었다 — 비활성 버튼은 "누를 수 있다" 고 말하고
          //  안 눌리는 거짓말이다. 실행이 붙는 날 버튼으로 되돌린다.
          for (const action of data.actions) {
            const line = document.createElement("div");
            line.className = "action";
            const name = document.createElement("span");
            name.className = "action-name";
            name.textContent = resolveText(action.label) || action.id || "";
            const danger = document.createElement("span");
            danger.className = "danger-" + (action.danger || "safe");
            danger.textContent = dangerLabel(action.danger || "safe");
            line.appendChild(name); line.appendChild(danger);
            div.appendChild(line);
          }
        } else {
          appendKv(div, data);
        }
        return div;
      };

      // ── 리스트 서브패널 공용: 검색(라이브 필터) + 접이식 카테고리(localStorage 영속) ──────────
      // 모듈 뷰·능력 뷰가 동일 마스터-디테일 패턴이라(ADR 2026-07-17 §5 마스터-디테일 통일) 한 벌만
      // 구현해 재사용한다(§5.5 선언형 — 새 뷰가 같은 패턴을 쓰면 코드변경0으로 편입).
      const isGroupCollapsed = (storagePrefix, groupKey) => {
        try { return localStorage.getItem(storagePrefix + ":" + groupKey) === "1"; } catch (e) { return false; }
      };
      const setGroupCollapsed = (storagePrefix, groupKey, collapsed) => {
        try {
          const key = storagePrefix + ":" + groupKey;
          if (collapsed) localStorage.setItem(key, "1"); else localStorage.removeItem(key);
        } catch (e) { /* storage 비활성(프라이빗 모드 등) — 접힘 상태만 비영속, 기능은 계속 동작 */ }
      };

      // 그룹(헤더+아이템 컨테이너) 한 쌍을 만들어 listEl 에 append. buildItems(itemsWrap) 이 실제
      // 항목 DOM 을 채운다(호출자가 provider-item/능력-item 렌더러를 그대로 재사용). 헤더 클릭 →
      // 접기/펴기 토글(chevron 은 CSS 로 회전, app.css .module-group-head.collapsed) + localStorage
      // 저장. ★검색 중(listEl.dataset.searching==="1", applyListSearchFilter 가 세팅)엔 클릭 무시 —
      // 강제 펼침 중 접어봤자 시각 변화 없이 localStorage 만 오염되는 걸 막는다.
      const appendCollapsibleGroup = (listEl, storagePrefix, groupKey, label, count, buildItems) => {
        const collapsed = isGroupCollapsed(storagePrefix, groupKey);
        const head = document.createElement("div");
        head.className = "module-group-head" + (collapsed ? " collapsed" : "");
        const chevron = document.createElement("span");
        chevron.className = "module-group-chevron"; chevron.textContent = "▾";
        const labelEl = document.createElement("span");
        labelEl.className = "module-group-label"; labelEl.textContent = label;
        const countEl = document.createElement("span");
        countEl.className = "module-group-count"; countEl.textContent = String(count);
        head.appendChild(chevron); head.appendChild(labelEl); head.appendChild(countEl);
        const itemsWrap = document.createElement("div");
        itemsWrap.className = "module-group-items";
        buildItems(itemsWrap);
        head.addEventListener("click", () => {
          if (listEl.dataset.searching === "1") return; // 검색 중 접기 무시
          const next = !head.classList.contains("collapsed");
          head.classList.toggle("collapsed", next);
          setGroupCollapsed(storagePrefix, groupKey, next);
        });
        listEl.appendChild(head);
        listEl.appendChild(itemsWrap);
        return itemsWrap;
      };

      // 라이브 검색 필터 — listEl 의 직계 자식 .module-group-head/.module-group-items 쌍을 순회해
      // .provider-item 을 name/kind/description 텍스트(각 렌더러가 채운 item.dataset.searchText)로
      // 매치시킨다. rebuild(list.innerHTML 재구성) 없이 클래스 토글만 하므로 30s 폴 재렌더 뒤에도
      // 각 뷰가 렌더 끝에서 다시 호출하면 검색어가 안 사라진다(호출자 책임). query 빈 문자열 = 전체
      // 복원(접힘은 appendCollapsibleGroup 이 이미 반영한 localStorage 값 그대로 — 손대지 않음).
      const applyListSearchFilter = (listEl, rawQuery) => {
        if (!listEl) return;
        const q = String(rawQuery || "").trim().toLowerCase();
        if (q) listEl.dataset.searching = "1"; else delete listEl.dataset.searching;
        let anyVisible = false;
        for (const head of listEl.querySelectorAll(":scope > .module-group-head")) {
          const itemsWrap = head.nextElementSibling;
          if (!itemsWrap || !itemsWrap.classList.contains("module-group-items")) continue;
          // ★클래스가 아니라 **계약**으로 고른다 (2026-09-02) — `data-search-text` 를 가진
          //  것이 곧 검색 대상이다. 종전엔 `.provider-item` 이라 새 뷰가 이 헬퍼를 쓰려면
          //  남의 클래스를 달아야 했다(플러그인 목록이 그 자리였다). 이름 결합을 없앤다.
          const items = itemsWrap.querySelectorAll("[data-search-text]");
          const countEl = head.querySelector(".module-group-count");
          if (!q) {
            head.classList.remove("search-hidden-group");
            itemsWrap.classList.remove("search-hidden-group", "force-expanded");
            for (const item of items) item.classList.remove("search-hidden");
            if (countEl) countEl.textContent = String(items.length);
            anyVisible = true;
            continue;
          }
          let visible = 0;
          for (const item of items) {
            const match = (item.dataset.searchText || "").includes(q);
            item.classList.toggle("search-hidden", !match);
            if (match) visible += 1;
          }
          if (countEl) countEl.textContent = String(visible);
          const groupEmpty = visible === 0;
          head.classList.toggle("search-hidden-group", groupEmpty);
          itemsWrap.classList.toggle("search-hidden-group", groupEmpty);
          itemsWrap.classList.toggle("force-expanded", !groupEmpty);
          if (!groupEmpty) anyVisible = true;
        }
        // 그룹 없는 직접 항목(플랫 리스트, 예: 프로젝트 패널)도 동일 필터.
        for (const item of listEl.querySelectorAll(":scope > [data-search-text]")) {
          if (!q) { item.classList.remove("search-hidden"); anyVisible = true; continue; }
          const match = (item.dataset.searchText || "").includes(q);
          item.classList.toggle("search-hidden", !match);
          if (match) anyVisible = true;
        }
        let emptyMsg = listEl.querySelector(".search-empty-msg");
        if (q && !anyVisible) {
          if (!emptyMsg) {
            emptyMsg = document.createElement("div");
            emptyMsg.className = "empty search-empty-msg";
            emptyMsg.style.margin = "8px";
            emptyMsg.textContent = i18n("common.search.empty");
            listEl.appendChild(emptyMsg);
          }
        } else if (emptyMsg) {
          emptyMsg.remove();
        }
      };

      let providersCache = [];
      let inventoryCache = null;
      let modelProfilesCache = null; // { profiles:[{name,isDefault,description?,pool[],fallback?}], ... } 또는 null(미로드).
      let assistantName = "tiguclaw"; // 비서 표시 이름(AGENT.md 이름 → chat-history 응답, 폴백 tiguclaw).
      let selectedProviderId = null;
      let currentView = "overview";
      // 앱 버전 — `/api/health` 가 채운다(activity.js). 헤더 부제와 홈 「상태 요약」이 **같은 값**을
      // 본다. 모바일 헤더는 폭이 없어 부제를 숨기므로(app.css @media), 홈이 유일한 노출 자리다.
      let appVersion = "";
      /** 서빙된 프런트 자산의 내용 지문 — 바뀌면 새 JS 가 나온 것이다(버전과 별개 축). */
      let appAssets = "";

      /**
       * **지금 무엇을 하는 중인가** — `llm.activity` 의 {kind,label} → 사람 말 (2026-08-21).
       *
       * ★한 곳에 둔다. 메인 진행 표시(입력창 위)와 백그라운드 잡 카드가 **같은 질문**에
       *  답하므로, 각자 문구를 만들면 같은 상태를 두 이름으로 부르게 된다. 여기가 정의점이다.
       *  (`kind` 는 어댑터가 내는 값 — "text" = 답을 쓰는 중, 그 외 = 도구.)
       */
      const doingText = (phase) => {
        if (!phase || !phase.kind) return i18n("chat.phase.thinking");
        if (phase.kind === "text") return i18n("chat.phase.writing");
        return phase.label ? i18n("chat.phase.toolNamed", { name: phase.label }) : i18n("chat.phase.tool");
      };

      // 타임스탬프 — 로컬. 기존 toISOString().slice 는 UTC(한국이면 9h 어긋남)+밀리초였다.
      const tsPad = (n) => String(n).padStart(2, "0");
      // 메시지 버블 = 시각만(HH:MM:SS). 날짜는 날짜 구분선(date-divider)이 담당.
      const fmtTime = (ms) => {
        const d = new Date(ms);
        return `${tsPad(d.getHours())}:${tsPad(d.getMinutes())}:${tsPad(d.getSeconds())}`;
      };
      // 날짜 경계 판정 키(로컬 YYYY-MM-DD) + 구분선 표시 라벨(요일 포함).
      const dateKey = (ms) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${tsPad(d.getMonth() + 1)}-${tsPad(d.getDate())}`;
      };
      const fmtDate = (ms) => {
        const d = new Date(ms);
        const w = [i18n("time.dow.sun"), i18n("time.dow.mon"), i18n("time.dow.tue"), i18n("time.dow.wed"), i18n("time.dow.thu"), i18n("time.dow.fri"), i18n("time.dow.sat")][d.getDay()];
        return `${dateKey(ms)} (${w})`;
      };


      // ── 세션 표시명 공유 지도 (2026-08-06) ──────────────────────────────────
      // threadKey → 서버가 정한 표시명. **채우는 곳은 한 군데**(tabs.js
      // refreshSessionPreviews — 서버 `/api/sessions` 의 전 세션을 이미 순회한다)이고,
      // 읽는 곳은 전체활동 배지와 백그라운드 잡 카드다.
      //
      // ★왜 공유인가: 소비처가 각자 이름을 파생하면 **같은 세션이 화면마다 다른 이름**으로
      //  보인다 — 대시보드 `세션3` vs 텔레그램 생키로 갈렸던 그 사고와 같은 뿌리다. 이름의
      //  정본은 서버이고(커스텀 > 첫 발화 > 폴백), 여기는 그 값을 나르는 자리일 뿐이다.
      // ★열린 탭에 없는 세션(닫은 세션·다른 채널)도 담긴다 — 백그라운드 잡은 대개
      //  "다른 세션에서 띄워놓고 잊은 것" 이라, 정작 이름이 필요한 순간이 안 보고 있는 세션이다.
      const sessionDisplayNames = new Map();

      /**
       * 서버가 아는 표시명. **모르면 빈 문자열** — 폴백을 쓸지는 호출부가 정한다.
       * (전체활동은 파생 폴백을 쓰고, 잡 카드는 지어내지 않고 배지를 생략한다.)
       */
      const sessionNameFor = (tk) => {
        if (!tk) return "";
        const fromServer = sessionDisplayNames.get(tk);
        if (fromServer) return fromServer;
        try {
          if (typeof openTabs !== "undefined") {
            const t = openTabs.find((o) => o.threadKey === tk);
            if (t && t.name) return t.name;
          }
        } catch {
          /* openTabs 미초기화(부팅 순간) — 이름 없음으로 취급 */
        }
        return "";
      };

      /**
       * 첨부를 **열 때** 무엇을 쓸지 정한다 — *표시*와 다른 질문이다.
       *
       * 사고 (2026-08-11 사용자 신고): 방금 보낸 파일을 채팅 카드에서 누르면 **빈 화면**.
       *  뿌리는 한 변수가 두 질문을 겸한 것이다 — 썸네일 `src` 는 낙관적 버블에서 `data:`
       *  URI 인데, 브라우저는 **`data:` 최상위 이동을 차단**한다(새 탭이 그냥 빈 화면).
       *  서빙 주소(`rel`)가 있으면 그걸 쓰고, 없으면 base64 를 blob 으로 바꿔 연다
       *  (blob 은 최상위 이동이 허용된다). 둘 다 없으면 **열지 않는다** — 빈 탭 0.
       *
       * ★순수 함수로 뽑은 이유: 이 판정이 렌더 클로저 안에 있으면 검사가 브라우저를
       *  띄워 옛 첨부를 화면에 올려야만 확인된다(실제로 그러다 막혔다). 판정만 분리하면
       *  실행해서 지킬 수 있다 — 수행(blob 생성)은 호출부 몫으로 남긴다.
       *
       * @returns {{kind:"served",url:string}|{kind:"blob"}|{kind:"none"}}
       */
      const attachmentOpenTarget = (a) => {
        if (!a || typeof a !== "object") return { kind: "none" };
        if (typeof a.rel === "string" && a.rel !== "") {
          return { kind: "served", url: "/api/attachments/" + a.rel };
        }
        if (typeof a.dataBase64 === "string" && a.dataBase64 !== "") {
          return { kind: "blob" }; // ★data: 그대로 열지 않는다 — 차단당해 빈 화면이 된다.
        }
        return { kind: "none" };
      };

      /**
       * 태그를 **글로 쓸 때의 모양** — 이름에 공백이 있으면 대괄호로 감싼다.
       *
       * 근거는 실물이다 (2026-08-11): 등록 프로젝트에 `Tigu Engine` 이 있는데 맨 태그
       *  문법(`#` + 공백 아닌 것)으로는 `#Tigu` 까지만 잡혀 **그 프로젝트를 태그로 쓸 수가
       *  없었다**. 삽입·토글·활성 표시·감지가 전부 이 함수를 쓴다 — 모양을 두 곳에서 짓지 않는다.
       */
      const formatTagToken = (name) => {
        if (typeof name !== "string" || name === "") return "";
        return /[\s\[\]]/.test(name) ? "#[" + name + "]" : "#" + name;
      };

      /**
       * **칩으로 배울 태그**를 고른다 — 이게 태그 시스템의 유일한 판정이다.
       *
       *   배운다 = `#[이름]`(명시) ∪ `#이름` 중 **아는 이름**(프로젝트·스킬·에이전트·기존 칩)
       *
       * 사고 (2026-08-11): 로그를 붙여넣으면 그 안의 `#` 이 전부 칩으로 학습됐다. 처음엔
       *  모양으로 막으려 했다 — 구두점 시작 제외, 줄 첫머리만, 붙여넣기 추적, 여러 줄 제외.
       *  ★사용자 지적: **"예외가 너무 많은 게 별로다."** 맞다. `#` 은 sh·python·yaml·toml·
       *  Makefile 의 **주석 문자**라 모양으로는 원리적으로 못 가린다. 예외가 쌓인다는 건
       *  판정 기준이 없다는 신호였다.
       *
       * 기준을 바꾸니 예외가 **전부 사라진다** — `#!/bin/sh`·`# 목표`·`#1234`·`# TODO` 는
       * 아는 이름이 아니라서 안 걸린다. 별도 규칙이 하나도 필요 없다. 새 태그는 `#[...]`
       * 로 **의도해서** 태어난다.
       *
       * ★배우는 것만 이 기준을 탄다. 본문의 `#뭐든` 은 그냥 글자다(표시·활성은 종전 그대로).
       */
      const learnableTagNames = (text, knownNames) => {
        if (typeof text !== "string" || text.indexOf("#") === -1) return [];
        const known = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
        const seen = new Set();
        const out = [];
        const add = (n) => {
          const v = String(n).trim();
          if (v !== "" && !seen.has(v)) { seen.add(v); out.push(v); }
        };
        // ①명시형 `#[이름]` — 사용자가 태그라고 말한 것. 줄바꿈은 안 넘는다(문법 경계).
        const bracket = /#\[([^\]\n]{1,60})\]/g;
        let m;
        while ((m = bracket.exec(text)) !== null) add(m[1]);
        // ②맨 태그 `#이름` — **아는 이름일 때만**. 여기가 로그 소음이 죽는 자리다.
        for (const raw of text.replace(bracket, " ").match(/#([^\s#\[\]]{1,40})/g) || []) {
          const n = raw.slice(1);
          if (known.has(n)) add(n);
        }
        return out;
      };

      /**
       * `#` 를 쳤을 때 `#[]` 스캐폴드를 깔아줄 자리인가 — **줄 첫머리에서만**.
       *
       * ★처음엔 "단어 경계(공백 뒤 포함)" 로 했는데 **거짓이었다** (2026-08-11, 헤드리스로
       *  실제 타이핑해보고 잡음): `issue #123` 도 "공백 뒤" 라 똑같이 걸린다. 즉 그 규칙은
       *  문장 중간을 전혀 못 걸러내면서 걸러낸다고 주석에 적혀 있었다.
       *
       * 기준을 바꾼 근거: **대괄호는 공백 있는 이름을 위한 것이고, 그런 태그는 의도적으로
       *  「쓰기 시작할 때」 붙인다.** 문장 끝에 툭 붙이는 태그(`… 확인해줘 #핫딜알리미`)는
       *  거의 한 단어라 대괄호가 필요 없다. 그래서 줄 첫머리에만 깔면 필요한 자리는 덮고
       *  글쓰기는 안 방해한다(`issue #123`·`C#`·`key=#1` 전부 무개입).
       */
      const shouldScaffoldTag = (textBefore) => {
        if (typeof textBefore !== "string") return false;
        return textBefore === "" || /\n$/.test(textBefore);
      };

      /**
       * 이 스텝이 **배경 작업을 띄운 스텝**인가 (2026-08-20 사용자 신고: "배지가 없어졌다").
       *
       * ★판정을 여기 한 곳에 둔다. 종전엔 같은 조건이 `virtualization.js`(라이브)에만 있었고
       *  `history-render.js`(이력)엔 없었다 — 그런데 그 함수 주석은 *"라이브 buildActivityLine
       *  과 **동형**"* 이라고 적혀 있었다. 그래서 턴이 끝나 이력으로 다시 그려지는 순간
       *  `🤖 백그라운드 ↗` 칩이 조용히 사라졌다(같은 판단이 두 곳 → 한쪽이 늙음).
       *
       * 어댑터 불문(원칙 #2): claude native `Task`/`Agent`(=jobId 동반), codex/openai 의
       * bare `spawn_agent`/`run_in_background`, 그리고 claude 가 크로스프로젝트 위임에 쓰는
       * MCP 라벨 `mcp__agents__spawn_agent` 류(접미사 매칭으로 흡수).
       */
      const isSpawnStep = (label, jobId) => {
        if (jobId) return true;
        const l = typeof label === "string" ? label : "";
        return (
          l === "Task" ||
          l === "Agent" ||
          l.endsWith("spawn_agent") ||
          l.endsWith("run_in_background")
        );
      };

      applyI18n();

      /**
       * **텍스트를 끌어 고른 뒤의 click 인가** — 그러면 접기로 치지 않는다 (2026-09-10 정태님:
       * *"텍스트 드래그는 접기로 안 치는 게 좋을 것 같아"*).
       *
       * ★증상: 활동 줄·스텝 줄은 본문이 **선택 가능한 텍스트**인데 클릭이 곧 토글이라,
       *  로그를 복사하려고 끌면 끝나는 순간 줄이 접혔다. 헤더(`user-select:none`)는 무해했고
       *  본문 줄만 그랬다.
       *
       * ★판정을 **선택 영역**으로 한다(이동 거리가 아니라). 거리로 재면 «천천히 조금 끌어
       *  고른 것» 을 놓치고, «손 떨려서 2px 움직인 클릭» 을 막는다 — 둘 다 틀린 방향이다.
       * ★**이 요소 안의 선택만** 본다. 다른 데 골라 둔 게 남아 있다고 클릭이 죽으면
       *  «왜 안 접히지» 가 된다.
       * ★never-throw — 접기가 선택 API 때문에 죽으면 안 된다.
       */
      /**
       * ★★**«선택이 있나» 가 아니라 «이 동작이 선택을 만들었나» 다** (2026-09-16 정태님 신고:
       *  *"간혹 채팅 카드 눌러도 접히거나 펴지지 않을 때가 있어, 새로고침하면 괜찮아지고"*).
       *
       * ★종전 판정은 **남아 있는 선택**도 드래그로 쳤다. 그래서:
       *   ① 카드 본문에서 텍스트를 고른다(복사하려고) → 선택이 남는다
       *   ② 카드 머리줄을 누른다 — 머리줄은 `user-select:none` 이라 **그 클릭이 선택을
       *      안 지운다**
       *   ③ 판정이 «카드 안에 선택이 있다» 로 접기를 삼킨다 → **계속 안 접힌다**
       *   ④ 새로고침하면 선택이 사라져서 다시 된다 — 신고된 증상 그대로다.
       *
       * ★그래서 **누를 때의 선택**을 기억해 두고 **클릭 때와 비교**한다. 같으면 남아 있던
       *  것이고(드래그가 아니다), 달라졌으면 이 동작이 만든 것이다(드래그다).
       *  거리로 재지 않는 이유는 종전과 같다 — 천천히 조금 끈 선택을 놓치고 손 떨린 클릭을
       *  막는다.
       */
      /**
       * **누를 때의 선택을 기억하는 자리** — 상태·읽기·판정이 전부 이 안에 있다.
       *
       * ★배선을 밖에 두면 검사가 못 본다. 실제로 «껍데기가 빈 문자열을 넘긴다» ·
       *  «누를 때 기록을 안 남긴다» 두 변이가 판정만 검사할 때 **통과했다**(2026-09-16).
       *  DOM 에 남는 것은 «리스너를 달았나» 한 줄뿐이고, 나머지는 여기서 실행된다.
       */
      const createDragGuard = () => {
        let atPress = "";
        const readSel = (win) => {
          try {
            const s = win && win.getSelection && win.getSelection();
            return s ? String(s) : "";
          } catch { return ""; }
        };
        return {
          onPress: (win) => { atPress = readSel(win); },
          isDrag: (el, win) => textDragJudge(el, win, atPress),
        };
      };
      const dragGuard = createDragGuard();
      try {
        // capture — 다른 핸들러가 막아도 우리는 본다.
        document.addEventListener("mousedown", () => dragGuard.onPress(window), true);
      } catch { /* 문서가 없으면(테스트 등) «남은 선택 없음» 으로 둔다 */ }

      /**
       * 판정 본체 — **입력이 전부 인자다**(바깥 변수를 안 본다). 그래야 검사가 실행한다.
       * ★`isTextDragClick` 은 이걸 부르는 얇은 껍데기다 — 판정은 한 곳에만 있다.
       */
      const textDragJudge = (el, win, selAtPress) => {
        try {
          const sel = win && win.getSelection && win.getSelection();
          if (!sel || sel.isCollapsed || String(sel).trim() === "") return false;
          let inEl = false;
          for (let i = 0; i < sel.rangeCount; i++) {
            const node = sel.getRangeAt(i).commonAncestorContainer;
            if (el === node || el.contains(node)) { inEl = true; break; }
          }
          if (!inEl) return false;
          // ★**남아 있던 선택은 드래그가 아니다** — 누를 때와 같으면 이 동작이 만든 게 아니다.
          return String(sel) !== String(selAtPress);
        } catch { return false; }
      };

      const isTextDragClick = (el) => dragGuard.isDrag(el, window);
      /** 접기 토글 클릭 — 텍스트 드래그면 무시한다. 판정을 한 곳에 둔다(사이트마다 쓰면 갈린다). */
      /**
       * **카드 캐럿 — 세 카드가 같은 요소를 쓴다** (2026-09-14 정태님: *"도구카드랑 같은
       * 방식으로 가야돼"*).
       *
       * ★종전엔 기제가 **둘**이었다: 도구·이력은 실제 `<span>`(한 글자 ▸ + CSS 회전)인데
       *  버블만 `::before`(글자를 ▾/▸ 로 바꿈)였다. 그래서 hover 규칙이 버블에서만 기본
       *  규칙에 **특이도로 져** 색이 안 바뀌었다 — *"도구카드는 갖다대면 색이 바뀌는데
       *  채팅카드는 그대로"*. 기제가 둘이면 한쪽만 깨지고, 그 사실이 소스에선 안 보인다.
       * ★글자는 **한 모양**만 둔다(▸) — 펼침/접힘은 CSS 가 rotate 로 말한다(도구 카드의
       *  기존 규칙과 같다). 상태의 권위는 `.is-collapsed` 한 곳이다.
       */
      const makeCardCaret = () => {
        const c = document.createElement("span");
        c.className = "card-caret";
        c.textContent = "▸";
        return c;
      };

      const onToggleClick = (el, fn) => {
        el.addEventListener("click", (e) => {
          if (isTextDragClick(el)) return;
          fn(e);
        });
      };

      /**
       * 잡 종류 아이콘 — **카탈로그에서**(`job.kind.<kind>.icon`).
       *
       * ★여기(공용)에 두는 이유: 드로어·잡 뷰·채팅이 각자 갖고 있으면 그게 세 벌이고,
       *  실제로 «드로어만 카탈로그를 보고 나머지는 🤖 를 박아 둔» 상태였다(적대 검토 B-P1).
       * ★키가 없으면(옛 배포본·미번역) 키 이름이 그대로 돌아온다 — 그때 화면 글자가
       *  «job.kind.agent.icon» 이 되면 안 되므로 폴백을 둔다.
       */
      const kindIcon = (kind) => {
        const k = "job.kind." + (kind === "agent" ? "agent" : "worker") + ".icon";
        const v = i18n(k);
        return v && v !== k ? v : (kind === "agent" ? "🤖" : "🎖️");
      };

