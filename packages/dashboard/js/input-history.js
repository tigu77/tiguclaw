      // ── 입력 히스토리(↑/↓) — 셸 동작 ────────────────────────────────────────
      // Claude Code CLI 는 되는데 대시보드는 안 되던 갭(원칙 1: 슈퍼셋).
      //
      // ★새 저장소를 두지 않는다. "이 세션에서 내가 보낸 말" 은 **이미 로드돼 있다**
      //  (chat_log → /chat-history → vtItems). 별도 localStorage 배열을 만들면 같은 판단이
      //  두 곳이 되고 둘이 어긋난다. 여기서 새로 갖는 상태는 **커서 하나**뿐이고,
      //  그래서 세션 분리가 공짜다(vtItems 가 이미 탭별이라) + 새로고침 후에도 산다.

      /**
       * 히스토리 이동 판정 — **순수 함수**(DOM·전역 안 봄. 그래서 검사 가능하다).
       *
       * @param entries 오래된→최신 순의 내 입력들
       * @param cursor  null=히스토리 밖(입력 중), 아니면 entries 인덱스
       * @param dir     -1 위(과거로) / +1 아래(최근으로)
       * @param draft   히스토리에 들어가기 전 쓰고 있던 텍스트
       * @returns { cursor, text } — text=null 이면 입력창을 건드리지 않는다(no-op).
       */
      const historyStep = (entries, cursor, dir, draft) => {
        const n = entries.length;
        if (n === 0) return { cursor, text: null }; // 기록 없음 — 아무 일도 안 한다.
        if (dir < 0) {
          // 위: 밖에 있었으면 가장 최근부터. 이미 안이면 더 과거로(맨 끝에서 멈춘다).
          const next = cursor === null ? n - 1 : Math.max(0, cursor - 1);
          return { cursor: next, text: entries[next] };
        }
        // 아래: 밖에 있으면 할 일 없음. 안이면 최근 쪽으로, 끝을 넘으면 **쓰던 draft 로 복귀**.
        if (cursor === null) return { cursor: null, text: null };
        const next = cursor + 1;
        if (next >= n) return { cursor: null, text: draft };
        return { cursor: next, text: entries[next] };
      };

      // 이 세션(활성 탭)에서 내가 보낸 입력 — 오래된→최신. vtItems 가 진실 소스라
      // 가상화로 DOM 이 빠져도 정확하고, 탭을 바꾸면 저절로 그 탭 것이 된다.
      // ★원문은 버블 생성 시 dataset.raw 에 실어 둔다(본문 DOM 을 긁으면 첨부 칩·시각 같은
      //  주변 텍스트가 섞인다 — 표시와 원문은 다른 것이다).
      const sessionInputs = () => {
        const out = [];
        for (const it of vtItems) {
          const n = it && it.node;
          if (!n || n.dataset.type !== "channel.message.in") continue;
          const raw = n.dataset.raw;
          if (typeof raw === "string" && raw !== "") out.push(raw);
        }
        return out;
      };

      let histCursor = null;   // null = 히스토리 밖
      let histDraft = "";      // 히스토리 진입 시 쓰고 있던 텍스트
      let histThread = null;   // 커서가 속한 탭 — 바뀌면 리셋(탭마다 독립)

      // 커서를 놓는다 — 사용자가 직접 입력하거나 전송하면 히스토리 밖으로.
      const histReset = () => { histCursor = null; histDraft = ""; };
      window.histReset = histReset; // 전송 후 chat-send 가 호출.

      /**
       * ↑/↓ 처리. 가로챘으면 true(호출부가 그대로 return).
       *
       * ★개입하지 않는 경우 — 여기가 이 기능의 절반이다:
       *  - IME 조합 중(한글): 조합을 깨면 안 된다.
       *  - 선택 영역이 있을 때: 사용자가 고르는 중이다.
       *  - 여러 줄 편집 중 커서가 첫 줄(↑)·마지막 줄(↓)이 아닐 때: 커서 이동이 우선이다.
       *    이걸 안 지키면 여러 줄 입력을 아예 편집할 수 없게 된다.
       *  (슬래시 팝업이 ↑/↓ 를 쓰는 경우는 호출부가 먼저 가로챈다 — perf.js 참조.)
       */
      const historyKeydown = (e, input) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
        if (e.isComposing) return false;
        if (input.selectionStart !== input.selectionEnd) return false;
        const pos = input.selectionStart;
        const val = input.value;
        const up = e.key === "ArrowUp";
        if (up && val.slice(0, pos).includes("\n")) return false;   // 첫 줄이 아니다.
        if (!up && val.slice(pos).includes("\n")) return false;     // 마지막 줄이 아니다.

        if (histThread !== activeThreadKey) { histReset(); histThread = activeThreadKey; }
        if (histCursor === null) histDraft = val; // 진입 순간의 입력을 보관(돌아올 자리).

        const r = historyStep(sessionInputs(), histCursor, up ? -1 : 1, histDraft);
        if (r.text === null) {
          histCursor = r.cursor;
          return r.cursor !== null || !up; // 기록 0 인데 ↑ 면 기본 동작 유지(커서 이동).
        }
        e.preventDefault();
        histCursor = r.cursor;
        input.value = r.text;
        // 커서를 끝으로 — 셸과 같다(바로 이어 쓰거나 지울 수 있게).
        input.selectionStart = input.selectionEnd = r.text.length;
        // 높이 재계산 + 슬래시 등 동기 — mic-input 의 삽입 경로와 **같은 방식**을 쓴다
        //  (grow-wrap ::after 복제 갱신, 레이아웃 읽기 없음). 두 곳이 다르면 한쪽만 어긋난다.
        try {
          if (input.parentElement && input.parentElement.dataset) {
            input.parentElement.dataset.replicatedValue = input.value;
          }
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } catch { /* noop */ }
        return true;
      };
