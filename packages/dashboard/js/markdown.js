      // ── 마크다운 렌더(봇 답변 전용) ──────────────────────────────────────
      // 봇 출력은 신뢰경계 밖(모델이 <script>·onerror·javascript: 토해낼 수 있음).
      // marked 는 sanitize 안 함 → DOMParser 화이트리스트 재구성으로 안전 태그/속성만 통과.
      // 구멍 우려 시 DOMPurify(min) 1파일 동봉으로 승격: marked.parse→DOMPurify.sanitize 로 교체.
      const MD_ALLOWED_TAGS = new Set([
        "p","br","strong","em","b","i","code","pre","ul","ol","li",
        "blockquote","h1","h2","h3","h4","h5","h6","a","hr","del","s",
        "table","thead","tbody","tr","th","td","span",
      ]);
      const MD_SAFE_HREF = /^(https?:|mailto:)/i;
      // 미닫힌 코드펜스(``` 홀수) 봉합 — 답변에 ``` 하나만 있어도 깨진 HTML 방지(렌더용 복사본만).
      const sealFences = (src) => {
        const fences = (src.match(/^```/gm) || []).length;
        return fences % 2 === 1 ? src + "\n```" : src;
      };
      const sanitizeMarkdownHtml = (html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const walk = (node) => {
          // 자식 스냅샷(순회 중 교체로 인한 라이브 컬렉션 변동 방지).
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 1) {
              const tag = child.tagName.toLowerCase();
              if (!MD_ALLOWED_TAGS.has(tag)) {
                // 미허용 태그 = unwrap(자식 텍스트/노드는 보존, 통째 drop 아님).
                walk(child);
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                node.removeChild(child);
                continue;
              }
              // 모든 속성 제거 후, a.href·code 의 language 클래스만 화이트리스트로 복원.
              const href = tag === "a" ? child.getAttribute("href") : null;
              // 코드블록 언어 클래스(예: language-csharp) 보존 → 하이라이터가 언어 판별에 사용.
              const codeLang =
                tag === "code" ? child.getAttribute("class") : null;
              for (const attr of Array.from(child.attributes)) {
                child.removeAttribute(attr.name);
              }
              if (tag === "a") {
                if (href && MD_SAFE_HREF.test(href.trim())) {
                  child.setAttribute("href", href.trim());
                  child.setAttribute("target", "_blank");
                  child.setAttribute("rel", "noopener noreferrer");
                }
              }
              if (tag === "code" && codeLang && /^language-[\w#+.\-]+$/.test(codeLang.trim())) {
                child.setAttribute("class", codeLang.trim());
              }
              walk(child);
            } else if (child.nodeType !== 3) {
              // 텍스트(3) 외 코멘트/기타 노드 제거.
              node.removeChild(child);
            }
          }
        };
        walk(doc.body);
        return doc.body.innerHTML;
      };
      // 코드블록 하이라이팅 — vendored highlight.js(window.hljs). sanitize 후 DOM 의 pre code 를
      // 언어(language-* 클래스, 없으면 자동감지)로 하이라이트. hljs 미로드 시 무해 스킵.
      const highlightCodeBlocks = (root) => {
        if (typeof window.hljs === "undefined") return;
        try {
          root.querySelectorAll("pre code").forEach((el) => {
            try { window.hljs.highlightElement(el); } catch {}
          });
        } catch {}
      };

      // ★코드블록 복사 버튼 (2026-08-06 사용자 요청) — 명령어를 손으로 긁어 옮기던 것.
      //  클릭 핸들러는 **위임 하나**로 끝낸다(아래 installCodeCopy). 블록마다 리스너를 달면
      //  채팅 가상화가 DOM 을 끊임없이 만들고 지우므로 그만큼 누수한다.
      //  대상은 `pre > code` 뿐 — 인라인 `code` 에는 안 붙인다(문장 중간에 버튼이 뜬다).
      const decorateCodeBlocks = (root) => {
        try {
          root.querySelectorAll("pre").forEach((pre) => {
            if (!pre.querySelector("code")) return;
            if (pre.querySelector(":scope > .code-copy")) return; // 멱등(재렌더 안전).
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "code-copy";
            btn.title = "복사";
            btn.textContent = "복사";
            pre.appendChild(btn);
            pre.classList.add("has-copy");
          });
        } catch {}
      };
      // 위임 클릭 — 문서에 1회만 설치. 클립보드 API 는 보안 컨텍스트에서만 있으므로
      // (127.0.0.1·https 는 OK, 평문 LAN IP 접속은 아님) 실패 시 textarea 폴백으로 내려간다.
      // ★조용히 실패하지 않는다 — 못 하면 버튼이 "실패" 를 말한다.
      let codeCopyInstalled = false;
      const installCodeCopy = () => {
        if (codeCopyInstalled) return;
        codeCopyInstalled = true;
        document.addEventListener("click", (e) => {
          const btn = e.target && e.target.closest && e.target.closest(".code-copy");
          if (!btn) return;
          e.preventDefault();
          e.stopPropagation();
          const pre = btn.closest("pre");
          const code = pre && pre.querySelector("code");
          if (!code) return;
          const text = code.textContent || "";
          const done = (ok) => {
            btn.textContent = ok ? "복사됨" : "실패";
            btn.classList.toggle("ok", ok);
            setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("ok"); }, 1400);
          };
          const fallback = () => {
            try {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.setAttribute("readonly", "");
              ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
              document.body.appendChild(ta);
              ta.select();
              const ok = document.execCommand("copy");
              document.body.removeChild(ta);
              done(ok);
            } catch { done(false); }
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => done(true), fallback);
          } else {
            fallback();
          }
        });
      };

      /**
       * 마크다운 **기호를 걷어낸 평문** — 한 줄 프리뷰용(렌더가 아니다).
       *
       * ★쓰는 자리: 검색 결과 카드, 전체 활동의 접힌 한 줄. 둘 다 **한 줄로 눌린 조각**이라
       *  렌더할 블록이 없고, 조각에서 `**` 짝을 맞히려 들면 여는 기호가 잘려 **엉뚱한 구간이
       *  굵어진다**(2026-08-23 실측 2회). 틀린 강조는 안 한 것보다 나쁘다.
       * ★한 곳에 둔다 — 종전엔 검색 쪽에만 있었고, 전체 활동은 `**` 를 그대로 노출했다.
       *  같은 질문("한 줄에 어떻게 보일까")에 화면마다 다른 답을 주던 자리다.
       * 파서를 안 쓴다(정규식만) — 200라인 일괄 렌더에서도 비용이 없다.
       */
      const stripMarkdownText = (raw) => {
        // ★센티널로 NUL 을 쓰므로 **입력의 NUL 을 먼저 없앤다** (2026-08-24 6라운드).
        //  안 없애면 사용자 입력이 센티널을 위조해 다른 코드스팬 내용이 복제되거나
        //  (`\u00000\u0000` → 앞의 코드스팬 내용) 그 자리가 조용히 삭제된다.
        //  실측 도달 0줄(289,645줄)이지만 도구 출력 경유는 원리적으로 가능하다.
        let t = String(raw ?? "").replace(/\u0000/g, "");
        t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");   // [글자](url) → 글자
        t = t.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");         // 제목 — **줄머리만**
        t = t.replace(/(^|\n)\s*>\s+/g, "$1");              // 인용부호 — 줄머리만
        t = t.replace(/```[a-zA-Z0-9_+-]*\n?/g, "");         // 펜스(+언어 토큰까지)
        // ★코드스팬 안은 **강조 규칙이 닿지 않는다** (2026-08-24 라이브 실측).
        //  종전엔 백틱을 먼저 벗기고 그 안의 글로브가 강조로 먹혔다:
        //  `` `*핫딜*웹*` `` → `핫딜웹*`. 백틱은 "여긴 글자 그대로" 라는 표시인데
        //  그걸 벗긴 뒤 해석하면 표시를 무시한 셈이다. 잠깐 들어냈다가 되돌린다.
        const held = [];
        t = t.replace(/`([^`\n]+)`/g, (_m, inner) => {
          held.push(inner);
          return `\u0000${held.length - 1}\u0000`;
        });
        // ★굵게·취소선·코드는 **짝이 맞을 때만** 벗긴다. 종전엔 `split().join()` 으로
        //  무조건 지워서 마크다운이 아닌 글자를 먹었다 (2026-08-23 적대 검토 D2 실측):
        //    `2**10 은 1024` → `210 은 1024`     (수치가 바뀐다)
        //    `5 > 3 이다`     → `5 3 이다`        (부등호 소실)
        //    `echo a > b.txt` → `echo a b.txt`   (셸 리다이렉션 소실)
        //  쓰이는 자리가 **전체 활동 한 줄 프리뷰**라 오는 것은 로그·셸 출력·사용자 문장이
        //  대부분이다 — 거기서 문자가 조용히 사라지면 진단면이 거짓이 된다.
        //  ★그리고 강조 구간은 **공백으로 시작하거나 끝날 수 없다** (2026-08-23 2라운드 D2).
        //   이 줄이 없었을 때 `ls *.md *.ts` 가 `ls .md .ts` 가 됐다 — 여는 `*` 가 공백을
        //   건너 다음 `*` 까지 삼켰다. 셸 글로브 16개 중 12개 파손(`rm -f *.log *.tmp`,
        //   `git add *.ts *.js`, `*.env 와 *.key`…). 마크다운 자신의 규칙이기도 하다.
        //   여는 `**` 도 낱말 안에선 안 연다 — `%h**%s`·`{a**2}` 를 지킨다.
        // ★여는 문맥을 **화이트리스트로 열거하지 않는다** (2026-08-23 3라운드). 종전엔
        //  `(^|[\s(])` 였는데 그 목록에 이 제품이 상시 쓰는 `★`·`·` 도, CJK 구두점도,
        //  `「`·`[`·`▸` 도 없었다 — 실측: docs 4,399줄 중 `**` 가 화면에 그대로 남는 줄이
        //  **커밋 전 251 → 후 316(+26%)**, 전체 활동 뷰에선 147/147 이 raw 였다. 막으려던 건
        //  **낱말 안에서 여는 것**(`%h**%s`·`{a**2}`)뿐이니 그것만 말한다 — 열거 대신 판정.
        // ★여는 문맥 판정 — **4판이 너무 넓었다** (2026-08-23 4라운드, 111,833줄 코퍼스 실측).
        //  `(?<![\p{L}\p{N}_])` 로 넓히니 `/ = ' [ .` 뒤에서도 `_` 가 강조를 열어
        //  **`_` 소실 361줄**(3판 4줄) — `_workspace/phase4_canUseTool_spike.md` →
        //  `workspace/phase4_canUseToolspike.md`, `cp *.log /tmp/_bk_/` → `cp .log /tmp/_bk/`.
        //  이득(남던 `**` 가 사라진 줄) 311줄보다 **손실이 컸다.** 넓힌 판정이 좁은 열거보다
        //  안전해 보였지만, 이 함수는 로그·경로·셸이 오는 자리라 반대였다.
        //  고친 축 셋:
        //   ①구분자(`*`·`~`) 뒤에선 안 연다 — `③**굵게**` 의 안쪽 `*` 가 반쪽만 벗겨
        //     `③*굵게*` 가 되던 것(확정 51줄, 46줄이 `①②③` 표기)을 막는다
        //   ②숫자는 **십진수만** 막는다(`\p{Nd}`) — `2**10` 은 지키고 `③**굵게**` 는 연다
        //     (`③` 은 `\p{No}` 라 종전엔 통째로 막혀 raw 로 남았다)
        //   ③`_` 는 **닫는 쪽 문맥을 요구**한다(CommonMark 도 낱말 안 `_` 강조를 금한다).
        //     `*` 만 조사 밀착(`*중요*한`)을 허용한다 — 한국어 때문에 필요한 건 `*` 뿐이다.
        //  ★7판: 따옴표·`=`·`/`·`.` 뒤에서도 안 연다 (2026-08-24, 라이브 실측).
        //   6판까지는 이 넷이 열려 있어 **한 줄의 두 번째 글로브까지 삼켰다** —
        //     `--include="*.ts" --include="*.mjs"` → `--include=".ts" --include="*.mjs"`
        //     `["node_modules/**", "dist/**"]`      → `["node_modules/", "dist/"]`
        //     `s/(TOKEN=.{4}).*/\1…/;s/(KEY=.{4}).*/\1…/` → 정규식 의미가 바뀐다
        //   라이브 코퍼스 17,408항목에서 `*` 파손 3판 3건 → 6판 **28건**. 즉 내가
        //   "현재 판이 이전 판을 엄격히 지배한다" 고 적은 것은 **거짓이었다** — 손으로
        //   고른 케이스 표에서만 참이었다. 줄 문맥 결함은 단일 토큰 표에 안 나타난다.
        const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{Nd}_*~\"'=/.])";
        //  ★한때 "강조 구간은 따옴표를 건너뛰지 않는다"(NO_QUOTE)를 넣었다가 **뺐다**
        //   (2026-08-24 6라운드). 근거로 "진짜 강조 안에 따옴표가 오는 일은 드물다" 고
        //   적었는데 라이브 실측이 정반대였다 — **1,120줄**이 그 형태였고
        //   (`**1. 앱 내 "구매(Buy)" 기능**`), 화면에 `**` 가 그대로 남는 줄이
        //   3판 322 → 1,564 로 **4.9배** 늘었다. 프리뷰의 본업을 후퇴시킨 것이다.
        //   그리고 그건 **필요도 없었다**: 인용된 글로브 사례는 전부 여는 판정
        //   (`"'=/.`)이 이미 막는다 — 따옴표 **뒤에서 안 열리므로** 건너뛸 일이 없다.
        //   ★교훈: "드물다" 를 재지 않고 적었다. 이 파일에서 그 실수만 두 번째다.
        const CLOSE_CTX = "(?=[\\s).,!?]|$)"; // `_` 전용 — 낱말 안에서 닫지 않는다.
        const EDGE_B = "[^*\\s\\n]";   // 굵게 양끝 — `_` 허용(`**_중첩_**`)
        const EDGE_I = "[^*_\\s\\n]";  // 기울임 양끝
        // ★안쪽 문자 클래스는 **그 구분자를 배제**해야 한다 (2026-08-23 5차 검토).
        //  하나로 공유하니 `_` 규칙의 안쪽이 `_` 를 허용해 한 줄에 기울임이 둘이면
        //  **병합**됐다: `run _foo_ then _bar_` → `run foo_ then _bar`(3판은 정상).
        //  리팩터가 계약을 조용히 넓힌 것이고, 커밋 메시지에도 주석에도 없었다.
        const span = (e, inner) => `(${e}|${e}[^${inner}\\n]*${e})`;
        // `***굵은기울임***` 은 안쪽이 `*` 로 시작해 아래 둘로는 못 잡는다 — 먼저 접는다.
        t = t.replace(
          new RegExp(`${NOT_WORD_BEFORE}\\*\\*\\*${span(EDGE_I, "*")}\\*\\*\\*`, "gu"),
          "$1",
        );
        t = t.replace(
          new RegExp(`${NOT_WORD_BEFORE}\\*\\*${span(EDGE_B, "*")}\\*\\*`, "gu"),
          "$1",
        );
        t = t.replace(
          new RegExp(`${NOT_WORD_BEFORE}~~([^~\\s\\n]|[^~\\s\\n][^~\\n]*[^~\\s\\n])~~`, "gu"),
          "$1",
        );
        // (코드스팬은 위에서 이미 들어냈다 — 여기선 할 일이 없다.)
        t = t.replace(
          new RegExp(`${NOT_WORD_BEFORE}\\*${span(EDGE_I, "*")}\\*`, "gu"),
          "$1",
        ); // *기울임* — 조사 밀착 허용(한국어)
        t = t.replace(
          new RegExp(`${NOT_WORD_BEFORE}_${span(EDGE_I, "*_")}_${CLOSE_CTX}`, "gu"),
          "$1",
        ); // _기울임_ — 낱말 안에서 닫지 않는다(경로·식별자 보호)
        t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[Number(i)] ?? "");
        return t.replace(/\s+/g, " ").trim();
      };

      const renderMarkdown = (src) => {
        // marked·sanitize 실패 시 평문 폴백(happy-path 금지).
        return sanitizeMarkdownHtml(
          window.marked.parse(sealFences(src), { gfm: true, breaks: true }),
        );
      };
      // 봇 답변=마크다운(innerHTML, sanitize 후), 사용자/오류=평문(textContent).
      const setChatBody = (msgEl, text, asMarkdown) => {
        const src = String(text || "");
        if (asMarkdown && typeof window.marked !== "undefined") {
          try {
            msgEl.innerHTML = renderMarkdown(src);
            msgEl.classList.add("md");
            // ★복사는 **마크다운 원문**으로 (2026-08-23 사용자 제안). 렌더된 글을 복사하면
            //  `**`·제목·코드펜스가 사라져 다른 데 붙였을 때 서식이 통째로 날아간다.
            //  원문을 여기 걸어 두면 복사 핸들러가 그걸 집는다(재조립·역변환 없음 —
            //  렌더된 HTML 을 마크다운으로 되돌리는 건 원리적으로 손실이다).
            msgEl.dataset.mdSrc = src;
            highlightCodeBlocks(msgEl); // 코드블록 언어별 하이라이팅.
            // ★하이라이팅 **뒤에** 붙인다 — hljs.highlightElement 는 code 안만 건드리지만,
            //  버튼을 code 밖(pre 직속)에 두므로 순서가 뒤바뀌어도 안전하게 하려는 것도 겸한다.
            decorateCodeBlocks(msgEl);
            installCodeCopy();
            return;
          } catch (e) {
            // 폴백: 평문.
          }
        }
        msgEl.classList.remove("md");
        // 평문으로 되돌 때 옛 원문이 남으면 복사가 엉뚱한 걸 집는다.
        delete msgEl.dataset.mdSrc;
        msgEl.textContent = src;
      };

