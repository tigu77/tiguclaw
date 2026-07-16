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
            '<div class="empty" style="font-size:11px;padding:10px">모델 프로파일 불러오기 실패: ' + e.message + "</div>";
        }
      };

      const showModels = () => {
        setActiveNav("models");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view";
        wrap.innerHTML = '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">모델 프로파일</div><span class="detail-kind">표시</span></div><p class="developer-copy">settings.json 의 <code>models.profiles</code> 를 보여줍니다. 각 프로파일은 이름·설명·풀(provider:model, 폴백 순서 →)·폴백 프로파일로 구성됩니다. 추가·수정은 대화로 요청하세요(돌쇠가 settings.json 을 편집).</p><div id="models" class="models-shell"><div class="empty">불러오는 중…</div></div>';
        root.appendChild(wrap);
        if (modelProfilesCache) renderModelProfiles(modelProfilesCache);
      };

      const showSettings = () => {
        setActiveNav("settings");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        const root = document.getElementById("detail-panel");
        root.innerHTML = '<div class="page-view"><div class="detail-head"><div class="detail-accent"></div><div class="detail-name">설정</div><span class="detail-kind">준비 중</span></div><div class="empty">설정 화면은 다음 단계에서 연결합니다.</div></div>';
      };

      // ── 에이전트 뷰(왼쪽 nav 1급 destination) ──────────────────────────────
      // 오른쪽 백그라운드 드로어와 "동일한" jobCards 데이터를 읽어 크게 렌더한다(별도 데이터
      // 모델·엔드포인트 없음). 진행 중/전체 토글·경과시간·마지막 스텝 로직 재사용. worker.*
      // lifecycle / llm.activity(worker:|agent:) 가 들어올 때마다 renderAgentsView 가 (뷰가
