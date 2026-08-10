      const KNOWN_TIERS = new Set(["low", "mid", "high", "nano", "default"]);
      // 풀 원소(provider:model 또는 tier:high 등)에서 티어 힌트 색상 클래스 유추. 미지 = 무색 칩.
      const specTierClass = (spec) => {
        const s = String(spec || "").trim().toLowerCase();
        const t = s.startsWith("tier:") ? s.slice(5) : s;
        return KNOWN_TIERS.has(t) ? "tier-" + t : "";
      };
      const renderModelProfiles = (data) => {
        modelProfilesCache = data;
        const root = document.getElementById("models");
        const navCount = document.getElementById("nav-model-count");
        const profiles = (data && data.profiles) || [];
        if (navCount) navCount.textContent = String(profiles.length);
        if (!root) return;
        root.innerHTML = "";
        if (profiles.length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = "정의된 모델 프로파일이 없습니다 (settings.json 의 models.profiles 비어 있음).";
          root.appendChild(e);
          return;
        }
        for (const prof of profiles) {
          const card = document.createElement("div");
          card.className = "model-card" + (prof.isDefault ? " is-default" : "");
          const head = document.createElement("div");
          head.className = "model-card-head";
          const name = document.createElement("span");
          name.className = "model-card-name";
          name.textContent = prof.name;
          head.appendChild(name);
          if (prof.isDefault) {
            const badge = document.createElement("span");
            badge.className = "model-default-badge";
            badge.textContent = "default";
            head.appendChild(badge);
          } else {
            // 기본이 아닌 프로파일 → "기본으로 설정" 버튼(models.default 포인터 이동).
            const setBtn = document.createElement("button");
            setBtn.type = "button";
            setBtn.className = "model-set-default";
            setBtn.textContent = "기본으로 설정";
            setBtn.addEventListener("click", async () => {
              setBtn.disabled = true;
              try {
                const r = await fetch("/api/set-default-profile", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: prof.name }),
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
                showToast("기본 프로파일: " + prof.name, "good");
                await fetchModelProfiles(); // 배지 이동 반영(재렌더).
              } catch (e) {
                showToast("기본 설정 실패: " + e.message, "bad");
                setBtn.disabled = false;
              }
            });
            head.appendChild(setBtn);
          }
          card.appendChild(head);
          if (prof.description) {
            const desc = document.createElement("div");
            desc.className = "model-card-desc";
            desc.textContent = prof.description;
            card.appendChild(desc);
          }
          const pool = document.createElement("div");
          pool.className = "model-pool";
          const plabel = document.createElement("span");
          plabel.className = "model-pool-label";
          plabel.textContent = "풀";
          pool.appendChild(plabel);
          const specs = (prof.pool || []).map((s) => String(s).trim()).filter((s) => s !== "");
          if (specs.length === 0) {
            const empty = document.createElement("span");
            empty.className = "model-pool-empty";
            empty.textContent = "(빈 풀 — 어댑터 디폴트로 강등)";
            pool.appendChild(empty);
          } else {
            specs.forEach((spec, i) => {
              if (i > 0) {
                const arrow = document.createElement("span");
                arrow.className = "model-pool-arrow";
                arrow.textContent = "→";
                pool.appendChild(arrow);
              }
              const chip = document.createElement("span");
              chip.className = "model-spec " + specTierClass(spec);
              chip.textContent = spec;
              pool.appendChild(chip);
            });
          }
          card.appendChild(pool);
          if (prof.fallback) {
            const fb = document.createElement("div");
            fb.className = "model-fallback";
            fb.innerHTML = "폴백 프로파일: <code></code>";
            fb.querySelector("code").textContent = prof.fallback;
            card.appendChild(fb);
          }
          root.appendChild(card);
        }
      };

      const fetchModelProfiles = async () => {
        try {
          const r = await fetch("/api/model-profiles");
          if (!r.ok) throw new Error("HTTP " + r.status);
          renderModelProfiles(await r.json());
        } catch (e) {
          const root = document.getElementById("models");
          if (root) root.innerHTML =
            '<div class="empty" style="font-size:11px;padding:10px">모델 프로파일 불러오기 실패: ' + escHtml(e.message) + "</div>";
        }
      };

      const showModels = () => {
        setActiveNav("models");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view";
        wrap.innerHTML = '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">모델 프로파일</div><span class="detail-kind">표시</span></div><p class="developer-copy">settings.json 의 <code>models.profiles</code> 를 보여줍니다. 각 프로파일은 이름·설명·풀(provider:model, 폴백 순서 →)·폴백 프로파일로 구성됩니다. 추가·수정은 대화로 요청하세요(비서가 settings.json 을 편집).</p><div id="models" class="models-shell"><div class="empty">불러오는 중…</div></div>';
        root.appendChild(wrap);
        if (modelProfilesCache) renderModelProfiles(modelProfilesCache);
      };

      // ── 설정 뷰 (2026-08-10) ────────────────────────────────────────────────
      // 항목 **하나**로 시작한다. 미래 설정을 위한 틀을 미리 세우지 않는다 — 항목이 늘 때
      // 늘리는 게 이 레포 방식이고, 지금 프레임워크부터 만들면 그게 곧 "미래 가능성 위해
      // 만든 구조" 다. 값은 서버(settings.json)에 있고 저장 즉시 다음 턴부터 반영된다.
      const renderSettingsRow = (root, enabled) => {
        root.innerHTML = "";
        const page = document.createElement("div");
        page.className = "page-view";
        page.innerHTML =
          '<div class="detail-head"><div class="detail-accent"></div>' +
          '<div class="detail-name">설정</div></div>';
        const row = document.createElement("div");
        row.className = "settings-row";
        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = "다음 메시지 제안";
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent =
          "턴이 끝나면 이어서 보낼 만한 말을 입력창에 회색으로 제안합니다. Tab 이면 입력창에 채워집니다(전송은 직접). 매 턴 토큰을 조금 씁니다.";
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle" + (enabled ? " on" : "");
        btn.textContent = enabled ? "켜짐" : "꺼짐";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const next = !enabled;
          try {
            const r = await fetch("/api/set-suggestion", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: next }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
            showToast("다음 메시지 제안: " + (next ? "켜짐" : "꺼짐"), "good");
            renderSettingsRow(root, next); // 서버가 확인해 준 값으로 다시 그린다.
          } catch (e) {
            showToast("설정 저장 실패: " + e.message, "bad");
            btn.disabled = false;
          }
        });
        row.appendChild(meta);
        row.appendChild(btn);
        page.appendChild(row);
        root.appendChild(page);
      };

      const showSettings = async () => {
        setActiveNav("settings");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML =
          '<div class="page-view"><div class="detail-head"><div class="detail-accent"></div><div class="detail-name">설정</div></div><div class="empty">불러오는 중…</div></div>';
        let enabled = false;
        try {
          const r = await fetch("/api/suggestion");
          if (r.ok) {
            const d = await r.json();
            enabled = d && d.enabled === true;
          }
        } catch { /* 조회 실패 = 꺼짐으로 그린다(값은 서버가 정본) */ }
        renderSettingsRow(root, enabled);
      };

      // ── 에이전트 뷰(왼쪽 nav 1급 destination) ──────────────────────────────
      // 오른쪽 백그라운드 드로어와 "동일한" jobCards 데이터를 읽어 크게 렌더한다(별도 데이터
      // 모델·엔드포인트 없음). 진행 중/전체 토글·경과시간·마지막 스텝 로직 재사용. worker.*
      // lifecycle / llm.activity(worker:|agent:) 가 들어올 때마다 renderAgentsView 가 (뷰가
