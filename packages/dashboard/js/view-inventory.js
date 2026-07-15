      const renderInventory = (inv) => {
        inventoryCache = inv;
        renderContextTags(); // 스킬·에이전트 로드됨 → 태그 해석/미해석 구분 갱신.
        const root = document.getElementById("inventory");
        if (!root) return;
        // ★30s 폴 재렌더가 펼친 카드·연 카테고리·스크롤을 초기화하던 버그 픽스 —
        // 데이터가 이전과 동일하면 DOM 재구성을 스킵(무변 시 화면 그대로 유지).
        // 실제 변경(새 스킬/MCP 등) 시에만 재구성. 뷰 재진입은 새 #inventory 라 sig 부재→재구성.
        // ★sig 는 *렌더 대상 카테고리 데이터만*으로 계산 — inv.generatedAt(매 호출 변하는
        // 타임스탬프)를 포함하면 매번 불일치해 스킵이 안 됨(이 버그의 실원인).
        const sig = JSON.stringify(CATEGORIES.map((c) => inv[c] || []));
        if (root.dataset.sig === sig && root.childElementCount > 0) return;
        root.dataset.sig = sig;
        root.innerHTML = "";
        for (const cat of CATEGORIES) {
          const items = inv[cat] || [];
          const wrap = document.createElement("div");
          wrap.className = "cat";
          if (items.length > 0 && cat === "channel") wrap.classList.add("open");
          const head = document.createElement("div");
          head.className = "cat-head";
          const icon = document.createElement("span");
          icon.className = "icon"; icon.textContent = CATEGORY_ICON[cat] || "·";
          const label = document.createElement("span");
          label.className = "label"; label.textContent = CATEGORY_LABEL[cat] || cat;
          const count = document.createElement("span");
          count.className = "count"; count.textContent = items.length;
          const caret = document.createElement("span");
          caret.className = "caret"; caret.textContent = "▶";
          head.appendChild(icon); head.appendChild(label); head.appendChild(count); head.appendChild(caret);
          const body = document.createElement("div");
          body.className = "cat-body";
          // layer 별 정렬.
          const sorted = items.slice().sort((a, b) => {
            const la = LAYERS.indexOf(a.layer); const lb = LAYERS.indexOf(b.layer);
            return (la === -1 ? 99 : la) - (lb === -1 ? 99 : lb);
          });
          if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "cat-item"; empty.textContent = "(없음)";
            empty.style.color = "var(--text-dim)";
            body.appendChild(empty);
          } else {
            const list = document.createElement("div");
            list.className = "inv-list";
            for (const it of sorted) {
              const md = it.metadata || {};
              // 설명 — description(frontmatter/manifest). MCP 는 없으면 command/url.
              let desc = it.description || "";
              if (!desc && it.category === "mcp") {
                desc = md.url || (md.command ? md.command + (Array.isArray(md.args) && md.args.length ? " " + md.args.join(" ") : "") : "");
              }
              const card = document.createElement("div");
              card.className = "inv-card" + (it.enabled === false ? " disabled" : "");
              // ── 접힘 행: 이름 + (mcp)태그 + layer 칩 + caret 만(화면 안 넘침) ──
              const top = document.createElement("div"); top.className = "inv-card-top";
              const name = document.createElement("span");
              name.className = "inv-card-name";
              name.textContent = it.name || "?"; name.title = it.name || "";
              top.appendChild(name);
              if (it.category === "mcp") {
                const external = md.inProcess === false;
                const tag = document.createElement("span");
                tag.className = "inv-tag";
                tag.textContent = external ? "🔌 외부" : "in-process";
                if (external) { tag.style.color = "var(--accent)"; tag.style.borderColor = "rgba(52,211,153,.32)"; }
                top.appendChild(tag);
              }
              // 에이전트 모델 티어 — 접힘 행에 뱃지로 노출(명세 가시화). 없으면 생략.
              if (it.category === "agent" && md.model) {
                const mt = document.createElement("span");
                mt.className = "inv-tag inv-model-tag";
                mt.textContent = String(md.model);
                top.appendChild(mt);
              }
              const chip = document.createElement("span");
              chip.className = "inv-chip " + (it.layer || "");
              chip.textContent = (it.layer || "").replace("_", "·");
              top.appendChild(chip);
              const caret = document.createElement("span");
              caret.className = "inv-card-caret"; caret.textContent = "▶";
              top.appendChild(caret);
              card.appendChild(top);
              // ── 펼침 상세: 전체 설명 + 경로 + 메타 ──
              const detail = document.createElement("div");
              detail.className = "inv-card-detail";
              if (desc) {
                const dd = document.createElement("div");
                dd.className = "inv-detail-desc"; dd.textContent = desc;
                detail.appendChild(dd);
              }
              const lines = [];
              if (it.source) lines.push("경로: " + it.source);
              for (const k of Object.keys(md).filter((k) => k !== "inProcess" && k !== "model")) {
                const v = md[k];
                lines.push(k + ": " + (typeof v === "object" ? JSON.stringify(v) : String(v)));
              }
              const src = document.createElement("div");
              src.className = "inv-detail-src"; src.textContent = lines.join("\n");
              detail.appendChild(src);
              card.appendChild(detail);
              card.addEventListener("click", () => card.classList.toggle("open"));
              list.appendChild(card);
            }
            body.appendChild(list);
          }
          head.addEventListener("click", () => {
            wrap.classList.toggle("open");
          });
          wrap.appendChild(head); wrap.appendChild(body);
          root.appendChild(wrap);
        }
      };

      const fetchInventory = async () => {
        try {
          const r = await fetch("/api/inventory");
          if (!r.ok) throw new Error("HTTP " + r.status);
          renderInventory(await r.json());
        } catch (e) {
          const root = document.getElementById("inventory");
          if (root) root.innerHTML =
            '<div class="empty" style="font-size:11px;padding:10px">인벤토리 불러오기 실패: ' + e.message + "</div>";
        }
      };

