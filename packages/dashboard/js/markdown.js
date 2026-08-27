      // ── 마크다운 렌더(봇 답변 전용) ──────────────────────────────────────
      // 봇 출력은 신뢰경계 밖(모델이 <script>·onerror·javascript: 토해낼 수 있음).
      // marked 는 sanitize 안 함 → DOMParser 화이트리스트 재구성으로 안전 태그/속성만 통과.
      // 구멍 우려 시 DOMPurify(min) 1파일 동봉으로 승격: marked.parse→DOMPurify.sanitize 로 교체.
      const MD_ALLOWED_TAGS = new Set([
        "p","br","strong","em","b","i","code","pre","ul","ol","li",
        "blockquote","h1","h2","h3","h4","h5","h6","a","hr","del","s",
        "table","thead","tbody","tr","th","td","span",
        // 2026-08-27 추가 — 전부 **marked 가 이미 만들거나 통과시키던 것**이고, 여기서만
        // 죽고 있었다(실측). 값은 있는데 도달 경로가 0이던 부류.
        "input",              // GFM 체크박스 `- [ ]` (아래 정책이 disabled 를 강제한다)
        "details","summary",  // 접기 — 긴 답변에서 실제로 유용
        "kbd",                // 단축키 표기
      ]);
      const MD_SAFE_HREF = /^(https?:|mailto:)/i;

      /**
       * **태그별 속성 정책** — 값까지 본다 (2026-08-27).
       *
       * ★종전엔 "모든 속성 제거 후 `a.href`·`code.class` 만 if 두 개로 복원" 이었다. 태그가
       *  늘 때마다 분기가 붙는 모양이라, 그 자체가 다음 실수의 자리다. 데이터로 바꾼다.
       * ★기본은 여전히 **전부 제거**다 — 여기 적힌 것만 살아남는다(allowlist, denylist 아님).
       *  값 검사까지 하는 이유: 속성 이름만 보면 `type="image"` 같은 게 통과한다.
       */
      const MD_ATTR_POLICY = {
        a: {
          href: (v) => (MD_SAFE_HREF.test(v.trim()) ? v.trim() : null),
        },
        code: {
          // 하이라이터가 언어 판별에 쓴다.
          class: (v) => (/^language-[\w#+.\-]+$/.test(v.trim()) ? v.trim() : null),
        },
        // ★체크박스는 **읽기 전용**이어야 한다. 모델이 만든 문서일 뿐이고, 누를 수 있으면
        //  사용자가 "체크하면 뭔가 된다" 고 오해한다(아무 일도 안 난다). `disabled` 는
        //  아래에서 **무조건** 붙인다 — marked 가 빼먹어도 우리가 강제한다.
        input: {
          type: (v) => (v.trim().toLowerCase() === "checkbox" ? "checkbox" : null),
          checked: () => "",
        },
        // 표 정렬 — marked 가 `align="left|center|right"` 로 준다.
        th: { align: (v) => (/^(left|center|right)$/i.test(v.trim()) ? v.trim().toLowerCase() : null) },
        td: { align: (v) => (/^(left|center|right)$/i.test(v.trim()) ? v.trim().toLowerCase() : null) },
        details: { open: () => "" },
      };
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
              // 정책에 통과한 값만 **먼저 뜨고**, 나머지는 전부 지운 뒤 되돌린다.
              const policy = MD_ATTR_POLICY[tag] || {};
              const keep = {};
              for (const name of Object.keys(policy)) {
                const raw = child.getAttribute(name);
                if (raw === null) continue;
                const ok = policy[name](raw);
                if (ok !== null && ok !== undefined) keep[name] = ok;
              }
              for (const attr of Array.from(child.attributes)) {
                child.removeAttribute(attr.name);
              }
              for (const [name, value] of Object.entries(keep)) {
                child.setAttribute(name, value);
              }
              if (tag === "a" && child.hasAttribute("href")) {
                child.setAttribute("target", "_blank");
                child.setAttribute("rel", "noopener noreferrer");
              }
              if (tag === "input") {
                // ★타입이 안 남았으면(=checkbox 가 아니었으면) 요소 자체를 버린다. 그리고
                //  살아남았어도 **항상** 비활성 — 우리가 강제하지 marked 를 믿지 않는다.
                if (child.getAttribute("type") !== "checkbox") {
                  node.removeChild(child);
                  continue;
                }
                child.setAttribute("disabled", "");
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
      /**
       * **mermaid 다이어그램 렌더** — 나타났을 때만 3.4MB 를 받는다 (2026-08-27).
       *
       * ★사용자 요청. 종전엔 `` ```mermaid `` 가 그냥 코드 블록으로 떴다(원문이 회색 상자에).
       *
       * ★**sanitize 를 건드리지 않는다.** 입력은 이미 정화된 코드 블록의 **텍스트**이고,
       *  mermaid 가 만든 SVG 는 우리가 만든 컨테이너에 넣는다. 화이트리스트에 `svg` 를
       *  여는 쪽이 훨씬 위험하다 — 거기엔 `foreignObject`·이벤트 핸들러가 들어올 수 있고,
       *  그 자리가 지금 XSS 방어의 전부다.
       * ★`securityLevel:"strict"` — 라벨을 이스케이프하고 클릭 핸들러를 끈다. 모델 출력은
       *  신뢰 입력이 아니다. (실측: 생성된 SVG 에 `<script>` 0개.)
       * ★실패해도 **원문이 남는다** — 코드 블록을 지우고 그리는 게 아니라, 성공했을 때만
       *  바꿔치운다. 문법 오류 하나로 내용이 사라지면 안 된다.
       */
      /**
       * 배경이 밝으면 mermaid 도 밝게 — 화면에서 **읽는다**.
       *
       * ★`body` 의 `backgroundColor` 를 보면 안 된다: 실측 `rgba(0, 0, 0, 0)` 로 **투명**이다
       *  (색은 `--bg` 토큰이 칠한다). 그걸 읽고 "어둡다" 로 판정하면 밝은 테마에서 다이어그램만
       *  까맣게 뜬다 — 첫 판이 정확히 그랬다.
       * ★테마 **이름**을 열거하지 않는다(dark/light/…). 사용자가 만든 테마에서 바로 갈린다.
       *  판정은 `--bg` 의 밝기 하나다.
       */
      const mermaidTheme = () => {
        try {
          const raw = getComputedStyle(document.documentElement)
            .getPropertyValue("--bg")
            .trim();
          let r, g, b;
          const hex = /^#([0-9a-f]{6})$/i.exec(raw);
          const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
          if (hex) {
            const n = parseInt(hex[1], 16);
            r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
          } else if (rgb) {
            r = +rgb[1]; g = +rgb[2]; b = +rgb[3];
          } else {
            return "dark"; // 못 읽으면 제품 기본(어두움) 쪽.
          }
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? "default" : "dark";
        } catch {
          return "dark";
        }
      };

      /**
       * mermaid 초기화 — **매번 다시 부른다**(테마가 바뀔 수 있다).
       *
       * ★`htmlLabels:false` 가 핵심이다 (2026-08-27 적대 검토 F1). 기본값(`true`)이면 라벨을
       *  `<foreignObject>` 안 **HTML 로** 그리는데, 거기 `<img src>` 를 쓰면 렌더되는 순간
       *  **임의 호스트로 요청이 나간다** — 사용자 클릭 없이, 조용히(열람 사실·IP·UA 유출).
       *  실측: 요청 2건 → `htmlLabels:false` 로 **0건**(foreignObject 도 0).
       *  ★이 커밋이 `img[src]` 를 "정책 설계가 먼저" 라며 일부러 미뤘는데, mermaid 가 그
       *   결정을 옆문으로 우회하고 있었다. 정문만 잠근 셈이었다.
       */
      const initMermaid = (m) =>
        m.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: mermaidTheme(),
        });

      /**
       * mermaid 산출 SVG 를 **우리 정책에 한 번 더 통과**시킨다 (적대 검토 F1·F2).
       *
       * ★`htmlLabels:false` 로 정문은 닫혔지만, 그건 **설정 하나에 기댄 것**이다. 다이어그램
       *  타입이 늘거나 상류 기본값이 바뀌면 조용히 되살아난다. 그래서 **결과물을 본다.**
       * ★링크: mermaid 앵커엔 `target`·`rel` 이 **없다**(실측 속성 `xlink:href,data-look,
       *  transform`). 그대로 두면 같은 화면 안에서 링크 정책이 둘이 되고, 클릭하면 대시보드
       *  탭 자체가 남의 URL 로 이동한다. 우리 `a` 정책(스킴 검사 + 새 탭 + noopener)을 먹인다.
       */
      const hardenMermaidSvg = (root) => {
        for (const el of root.querySelectorAll("img, image, iframe, foreignObject, script")) {
          el.remove();
        }
        for (const a of root.querySelectorAll("a")) {
          const raw = a.getAttribute("xlink:href") ?? a.getAttribute("href") ?? "";
          const ok = MD_ATTR_POLICY.a.href(raw);
          a.removeAttribute("xlink:href");
          a.removeAttribute("href");
          if (ok === null) continue; // 스킴 탈락 — 링크가 아니라 그냥 글자로 남는다.
          a.setAttribute("href", ok);
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
      };

      let mermaidLoading = null;
      const loadMermaid = () => {
        if (window.mermaid) return Promise.resolve(window.mermaid);
        if (mermaidLoading) return mermaidLoading;
        mermaidLoading = new Promise((resolve, reject) => {
          const el = document.createElement("script");
          el.src = "/mermaid.min.js";
          el.onload = () => resolve(window.mermaid || null);
          el.onerror = () => reject(new Error("mermaid load failed")); // 내부 신호(catch 가 삼킨다) — 화면 문구 아님
          document.head.appendChild(el);
        }).then((m) => {
          // ★테마를 **화면에서 읽는다** — 못박으면 반대 테마에서 다이어그램만 따로 논다
          //  (헤드리스 실증에서 밝은 화면에 어두운 다이어그램이 떴다).
          //  판정은 배경색 밝기 하나 — 테마 이름을 열거하면 사용자가 만든 테마에서 갈린다
          //  ([[feedback_hand_maintained_lists]]).
          if (m) initMermaid(m);
          return m;
        });
        return mermaidLoading;
      };

      let mermaidSeq = 0;
      const renderMermaidBlocks = (root) => {
        const blocks = Array.from(root.querySelectorAll("pre > code.language-mermaid"));
        if (blocks.length === 0) return; // ★안 쓰면 로드도 안 한다.
        loadMermaid()
          .then(async (m) => {
            if (!m) return;
            for (const code of blocks) {
              const pre = code.parentElement;
              if (!pre || pre.dataset.mermaidDone === "1") continue;
              pre.dataset.mermaidDone = "1"; // 재렌더(스크롤 가상화)에서 두 번 그리지 않게.
              const rid = `md-mermaid-${++mermaidSeq}`;
              try {
                initMermaid(m); // ★테마는 매 렌더 다시 읽는다(F4 — 전환 후에도 옛 테마로 그려졌다).
                const { svg } = await m.render(rid, code.textContent || "");
                const box = document.createElement("div");
                box.className = "md-mermaid";
                box.innerHTML = svg;
                hardenMermaidSvg(box); // ★산출물을 우리 정책에 통과시킨다(F1·F2).
                pre.replaceWith(box);
              } catch {
                // 문법 오류 등 — 원문 코드 블록을 그대로 둔다(사용자가 무엇이 왔는지는 봐야 한다).
                pre.dataset.mermaidDone = "";
              } finally {
                // ★mermaid 가 렌더용 임시 노드를 body 에 남긴다 — 실패 시 특히(실측: 20회에
                //  21개, DOM +264 노드). 상시 떠 있는 화면이라 단조 증가한다. 우리가 치운다.
                for (const id of [rid, `d${rid}`]) {
                  const leaked = document.getElementById(id);
                  if (leaked && leaked.parentElement === document.body) leaked.remove();
                }
              }
            }
          })
          .catch(() => {
            /* 로드 실패(오프라인 아님 — 로컬 파일) — 코드 블록 그대로. */
          });
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
            btn.title = i18n("common.copy");
            btn.textContent = i18n("common.copy");
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
            btn.textContent = ok ? i18n("md.copied") : i18n("md.failed");
            btn.classList.toggle("ok", ok);
            setTimeout(() => { btn.textContent = i18n("common.copy"); btn.classList.remove("ok"); }, 1400);
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
            renderMermaidBlocks(msgEl); // ★비동기 — 실패해도 위 렌더는 이미 끝나 있다.
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

