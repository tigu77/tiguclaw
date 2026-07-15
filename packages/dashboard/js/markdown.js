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
            return;
          } catch (e) {
            // 폴백: 평문.
          }
        }
        msgEl.classList.remove("md");
        msgEl.textContent = src;
      };

