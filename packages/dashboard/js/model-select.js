      // model-select.js — 채팅 컴포저 모델 프로파일 빠른선택 드롭다운(탭별 sticky).
      // ADR _workspace/model-dropdown_architect_contract.md §3. 이 대시보드 탭(세션)에만
      // 적용되는 모델 프로파일을 고른다 — 전역 models.default·다른 탭·텔레그램 무영향.
      //
      // 제약(principle-check):
      //  (1) 대시보드는 프로파일 *이름*만 relay — 모델 해석 로직 없음(코어 router 몫).
      //  (3) 드롭다운·payload 전부 프로파일 이름만. raw model id/pool 은 절대 표시·전송 X.
      //      → GET /api/model-profiles 의 name(+description)만 렌더, pool/fallback 미참조.
      //
      // 목록 = 기존 GET /api/model-profiles(신규 read 엔드포인트 0). 선택 시 신규
      // POST /api/set-session-profile{threadKey:활성탭, profile:이름|""}. "" = 기본(상속)으로
      // 되돌림(bridge 가 clearSessionModelProfile). 상태 복원(탭 전환/새로고침)은 tabs.js 가
      // 소유하는 per-tab modelProfile(/api/sessions.modelProfile hydrate) → window.hydrateModelSelect.
      (() => {
        const sel = document.getElementById("chat-model-select");
        if (!sel) return;

        let profileNames = []; // 알려진 프로파일 이름(hydrate 검증·댕글링 방어).
        let defaultName = "default"; // 전역 default 프로파일 이름(상속 옵션 라벨).
        let loaded = false;

        // 활성 탭의 현재 프로파일 — tabs.js(공유 스코프)가 소유하는 openTabs/activeThreadKey.
        // 방어적 접근(로드 순서·미정의 대비). null = 상속(기본).
        const activeProfile = () => {
          try {
            if (
              typeof openTabs === "undefined" ||
              typeof activeThreadKey === "undefined"
            )
              return null;
            const t = openTabs.find((x) => x.threadKey === activeThreadKey);
            return t && typeof t.modelProfile === "string" ? t.modelProfile : null;
          } catch {
            return null;
          }
        };

        const activeThread = () => {
          try {
            return typeof activeThreadKey !== "undefined" ? activeThreadKey : null;
          } catch {
            return null;
          }
        };

        // 드롭다운 옵션 렌더 — 이름만(constraint 3). 첫 옵션 = "기본 (<default>)" = 상속(값 "").
        const renderOptions = (profiles) => {
          sel.innerHTML = "";
          const optDefault = document.createElement("option");
          optDefault.value = ""; // "" = 상속(clearSessionModelProfile).
          optDefault.textContent = "기본 (" + defaultName + ")";
          optDefault.title = "전역 기본 프로파일을 상속 (이 세션 전용 선택 없음)";
          sel.appendChild(optDefault);
          for (const p of profiles) {
            if (p.isDefault) continue; // 기본은 위 상속 옵션이 대표(중복 방지).
            const o = document.createElement("option");
            o.value = p.name; // 이름만 전송(constraint 1·3).
            o.textContent = p.name; // 드롭다운엔 이름만(설명은 hover title 로만).
            o.title = p.description || p.name;
            sel.appendChild(o);
          }
        };

        const loadProfiles = async () => {
          try {
            const r = await fetch("/api/model-profiles");
            if (!r.ok) return;
            const data = await r.json().catch(() => ({}));
            const profiles = Array.isArray(data.profiles) ? data.profiles : [];
            profileNames = profiles.map((p) => p.name);
            const dflt = profiles.find((p) => p.isDefault);
            if (dflt && typeof dflt.name === "string") defaultName = dflt.name;
            renderOptions(profiles);
            loaded = true;
            hydrate();
          } catch {
            /* 프로파일 0개/설정 부재 = graceful(빈 목록 → 기본만). */
          }
        };

        // 활성 탭 상태 → 드롭다운 현재선택 반영. 미지 이름(설정에서 사라진 프로파일)은 기본으로.
        const hydrate = () => {
          if (!loaded) return;
          const p = activeProfile();
          const val = p && profileNames.includes(p) ? p : "";
          if (sel.value !== val) sel.value = val;
        };
        // tabs.js 훅 — 탭 전환/새탭/세션 프리뷰 갱신 시 호출(로드 순서-안전한 window 게시).
        window.hydrateModelSelect = hydrate;

        sel.addEventListener("change", async () => {
          const profile = sel.value; // "" = 상속(기본).
          const tk = activeThread();
          if (!tk) return;
          // 낙관적 로컬 반영(탭 전환 정합) — in-memory 만(localStorage 직렬화 shape 불변,
          // 새로고침 시 /api/sessions.modelProfile 로 재hydrate).
          try {
            if (typeof openTabs !== "undefined") {
              const t = openTabs.find((x) => x.threadKey === tk);
              if (t) t.modelProfile = profile === "" ? null : profile;
            }
          } catch {}
          try {
            const r = await fetch("/api/set-session-profile", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ threadKey: tk, profile }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              if (typeof showToast === "function")
                showToast(
                  "프로파일 설정 실패: " + (data.error || "HTTP " + r.status),
                  "bad",
                );
              return;
            }
            if (typeof showToast === "function")
              showToast(
                profile === "" ? "모델 프로파일: 기본" : "모델 프로파일: " + profile,
                "good",
              );
          } catch (err) {
            if (typeof showToast === "function")
              showToast("프로파일 설정 실패(연결)", "bad");
          }
        });

        void loadProfiles();
      })();
