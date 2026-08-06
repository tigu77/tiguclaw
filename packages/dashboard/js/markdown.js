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
        msgEl.textContent = src;
      };

