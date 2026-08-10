      // ── 🎤 음성 입력(2026-07-18) — 텔레그램식 press-and-hold. 길게 눌러 녹음 → 떼면 전사 →
      //    #chat-input 에 텍스트 채움(사용자가 편집 후 기존 Enter 전송). 클로드코드 웹앱의
      //    "🎤 녹음→전사→입력창" 흐름 + 텔레그램의 누르고-있기·슬라이드-투-캔슬 인터랙션.
      //    전사는 config-driven 인프라 재사용(POST /api/transcribe → bridge /transcribe →
      //    resolveTranscriptionProvider, dev 는 로컬 whisper). 라이브러리 0(브라우저 MediaRecorder).
      //
      //    ★보안 컨텍스트: navigator.mediaDevices.getUserMedia 는 secure context 에서만 —
      //    localhost/127.0.0.1(현 대시보드)은 예외적으로 허용됨(OK). 비-localhost(LAN IP 등)로
      //    열면 HTTPS 가 필요하고 mediaDevices 가 undefined → graceful 토스트로 안내(크래시 0).
      //
      //    상태머신: idle → arming(권한 대기) → recording → transcribing → idle. 재진입/누수 0
      //    (매 사이클 teardown 이 stream track·recorder·타이머·리스너 상태를 확실히 정리).
      (() => {
        const micBtn = document.getElementById("chat-mic-btn");
        const timerEl = document.getElementById("chat-mic-timer");
        const input = document.getElementById("chat-input");
        if (!micBtn || !input) return; // 마크업 부재 = 조용히 비활성(회귀 0).

        const CANCEL_DIST = 40;   // px — 누른 채 이만큼 벗어나면 슬라이드-투-캔슬.
        const MIN_MS = 300;       // 이보다 짧은 녹음 = 우발 클릭 → 무시.
        const MAX_MS = 5 * 60 * 1000; // 안전 상한(무한 녹음 방지) — 도달 시 자동 정지·전사.

        let state = "idle";       // idle | arming | recording | transcribing
        let stream = null;        // MediaStream (getUserMedia)
        let recorder = null;      // MediaRecorder
        let chunks = [];          // 수집된 오디오 조각
        let startAt = 0;          // 녹음 시작 ts
        let startX = 0, startY = 0; // pointerdown 좌표(슬라이드-투-캔슬 기준)
        let cancelPending = false;  // 임계 초과 = 떼면 취소
        let armPointerDown = false; // 권한 대기 중 pointer 가 아직 눌려있나(중간에 떼면 취소)
        let timerInt = null;
        let maxTimer = null;
        let pointerId = null;

        const toast = (msg, tone) => {
          try { if (typeof showToast === "function") showToast(msg, tone); } catch { /* noop */ }
        };

        const fmtElapsed = (ms) => {
          const s = Math.floor(ms / 1000);
          return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
        };

        const setRecordingUI = (on) => {
          micBtn.classList.toggle("recording", on);
          if (timerEl) {
            timerEl.hidden = !on;
            timerEl.textContent = on ? "0:00" : "";
          }
          micBtn.title = on
            ? "떼면 전송 · 밖으로 밀면 취소"
            : "길게 눌러 음성 입력 (텔레그램식)";
        };

        const startTimer = () => {
          stopTimer();
          timerInt = setInterval(() => {
            const el = Date.now() - startAt;
            if (timerEl) timerEl.textContent = fmtElapsed(el);
          }, 250);
        };
        const stopTimer = () => {
          if (timerInt !== null) { clearInterval(timerInt); timerInt = null; }
        };

        // 완전 정리 — 어느 실패 경로에서도 호출해 상태를 idle 로 되돌린다(track 해제 필수).
        const teardownStream = () => {
          if (stream) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
          }
          stream = null;
          recorder = null;
          chunks = [];
        };
        const resetUi = () => {
          stopTimer();
          if (maxTimer !== null) { clearTimeout(maxTimer); maxTimer = null; }
          setRecordingUI(false);
          micBtn.classList.remove("cancel-armed");
          if (pointerId !== null) {
            try { micBtn.releasePointerCapture(pointerId); } catch { /* noop */ }
          }
          pointerId = null;
          cancelPending = false;
          armPointerDown = false;
        };

        const blobToBase64 = (blob) => new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const s = String(r.result);
            const c = s.indexOf(",");
            resolve(c >= 0 ? s.slice(c + 1) : s);
          };
          r.onerror = () => reject(r.error || new Error("read failed"));
          r.readAsDataURL(blob);
        });

        // 전사된 텍스트를 입력창에 삽입(기존 텍스트 뒤 append) + autoGrow·커서 갱신.
        const insertText = (text) => {
          const t = (text || "").trim();
          if (t === "") { toast("전사 결과가 비어 있습니다.", "warn"); return; }
          const cur = input.value;
          const sep = cur.length > 0 && !/\s$/.test(cur) ? " " : "";
          input.value = cur + sep + t;
          // grow-wrap ::after 복제 갱신(레이아웃 읽기 없는 autoGrow) + input 이벤트로 슬래시 등 동기.
          try {
            if (input.parentElement && input.parentElement.dataset) {
              input.parentElement.dataset.replicatedValue = input.value;
            }
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } catch { /* noop */ }
          try {
            // 전사 텍스트를 막 채운 직후 — 사용자가 이어서 손볼 자리다.
            focusChatInput({ userIntendsToType: true });
            input.setSelectionRange(input.value.length, input.value.length);
          } catch { /* noop */ }
        };

        // 녹음 stop 이 만든 Blob → base64 → /api/transcribe → 입력창 채움. never-throw.
        const transcribe = async (blob, mimeType) => {
          state = "transcribing";
          micBtn.classList.add("transcribing");
          try {
            const dataBase64 = await blobToBase64(blob);
            const r = await fetch("/api/transcribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dataBase64, mimeType }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              toast((data && data.error) || `전사 요청 실패 (${r.status})`, "bad");
            } else if (data && data.error) {
              // 전사 미설정·provider 실패 등 — 서버가 200+{error} 로 graceful 반환.
              toast(data.error, "warn");
            } else if (data && typeof data.text === "string") {
              insertText(data.text);
            } else {
              toast("전사 응답이 비어 있습니다.", "warn");
            }
          } catch (e) {
            toast("전사 네트워크 오류 — 다시 시도해 주세요.", "bad");
          } finally {
            micBtn.classList.remove("transcribing");
            state = "idle";
          }
        };

        // recorder.onstop 핸들러 — 취소/짧은녹음 가드 후 통과분만 전사로.
        const handleStop = (opts) => {
          const canceled = opts && opts.canceled;
          const durMs = Date.now() - startAt;
          const mimeType = (recorder && recorder.mimeType) || "audio/webm";
          const collected = chunks.slice();
          teardownStream();
          resetUi();
          if (canceled) { state = "idle"; return; } // 슬라이드-투-캔슬 — 조용히 폐기.
          if (durMs < MIN_MS) { state = "idle"; return; } // 우발 클릭 — 무시(토스트 생략, 잦음).
          const blob = new Blob(collected, { type: mimeType });
          if (blob.size === 0) { state = "idle"; return; } // 0바이트 — 무시.
          void transcribe(blob, mimeType);
        };

        // pointerdown → 권한 요청 + 녹음 시작(권한 승인·pointer 유지 시에만 실제 시작).
        const onPointerDown = (ev) => {
          if (state !== "idle") return; // 재진입 차단(전사 중 등).
          ev.preventDefault(); // 텍스트선택·롱프레스 컨텍스트메뉴·스크롤 억제.
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast("이 브라우저/컨텍스트에서 마이크를 쓸 수 없습니다 (HTTPS 또는 localhost 필요).", "warn");
            return;
          }
          state = "arming";
          armPointerDown = true;
          cancelPending = false;
          startX = ev.clientX; startY = ev.clientY;
          pointerId = ev.pointerId;
          try { micBtn.setPointerCapture(pointerId); } catch { /* noop */ }

          navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
            // 권한 대기 중 사용자가 이미 손을 뗐으면(arming 취소) 녹음 시작 안 함 — track 즉시 해제.
            if (!armPointerDown || state !== "arming") {
              try { s.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
              state = "idle";
              resetUi();
              return;
            }
            stream = s;
            chunks = [];
            let rec;
            try {
              rec = new MediaRecorder(s);
            } catch (e) {
              try { s.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
              toast("이 브라우저가 녹음(MediaRecorder)을 지원하지 않습니다.", "bad");
              state = "idle"; resetUi(); return;
            }
            recorder = rec;
            rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
            rec.onstop = () => handleStop({ canceled: cancelPending });
            startAt = Date.now();
            state = "recording";
            setRecordingUI(true);
            startTimer();
            // 안전 상한 — 너무 길면 자동 정지(전사로). 사용자가 계속 누르고 있어도 종료.
            maxTimer = setTimeout(() => { if (state === "recording") stopRecording(false); }, MAX_MS);
            try { rec.start(); } catch (e) {
              toast("녹음을 시작하지 못했습니다.", "bad");
              teardownStream(); resetUi(); state = "idle";
            }
          }).catch((err) => {
            // 권한 거부(NotAllowedError)·장치 없음(NotFoundError) 등 — graceful.
            const name = err && err.name ? err.name : "";
            if (name === "NotAllowedError" || name === "SecurityError") {
              toast("마이크 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.", "warn");
            } else if (name === "NotFoundError" || name === "NotReadableError") {
              toast("사용 가능한 마이크를 찾지 못했습니다.", "warn");
            } else {
              toast("마이크를 열 수 없습니다.", "bad");
            }
            state = "idle";
            resetUi();
          });
        };

        // 녹음 정지 요청 — canceled=true 면 전사 없이 폐기. arming(권한 대기) 단계면 시작을 취소.
        const stopRecording = (canceled) => {
          if (state === "arming") {
            // 아직 recorder 미생성 — getUserMedia resolve 시 armPointerDown=false 로 취소되게 함.
            armPointerDown = false;
            // 즉시 UI 정리(권한 팝업이 떠 있을 수도 — resolve 콜백이 track 해제).
            if (state === "arming" && !stream) { state = "idle"; resetUi(); }
            return;
          }
          if (state !== "recording" || !recorder) return;
          cancelPending = !!canceled;
          // ★재진입 차단 — recorder.stop() 은 비동기(onstop). 같은 pointerup 이벤트가 버튼 핸들러와
          // 전역 window 폴백 양쪽에서 도달하면 state 가 아직 "recording" 이라 중복 stop→중복 전사가
          // 난다. 여기서 즉시 "stopping" 으로 넘겨 그 사이 재호출을 모두 무시(중복 제출 0).
          state = "stopping";
          const rec = recorder;
          try { rec.stop(); } catch { handleStop({ canceled: cancelPending }); }
        };

        const onPointerMove = (ev) => {
          if (state !== "recording" && state !== "arming") return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          const dist = Math.hypot(dx, dy);
          const armed = dist > CANCEL_DIST;
          if (armed !== cancelPending) {
            cancelPending = armed;
            micBtn.classList.toggle("cancel-armed", armed);
            if (timerEl) timerEl.textContent = armed
              ? "← 놓으면 취소"
              : fmtElapsed(Date.now() - startAt);
          }
        };

        const onPointerUp = () => {
          if (state === "arming") { stopRecording(true); return; } // 권한 전 릴리즈 = 취소.
          if (state === "recording") stopRecording(cancelPending);
        };
        const onPointerCancel = () => {
          if (state === "arming" || state === "recording") stopRecording(true);
        };

        micBtn.addEventListener("pointerdown", onPointerDown);
        micBtn.addEventListener("pointermove", onPointerMove);
        micBtn.addEventListener("pointerup", onPointerUp);
        micBtn.addEventListener("pointercancel", onPointerCancel);
        // 전역 안전망 — 포인터 캡처가 어떤 이유로 빠졌을 때(캡처 미지원 등) 버튼 밖에서 떼도 정지.
        window.addEventListener("pointerup", () => {
          if (state === "recording" || state === "arming") onPointerUp();
        });
        // 컨텍스트 메뉴(모바일 롱프레스) 억제 — 녹음 중 방해 팝업 방지.
        micBtn.addEventListener("contextmenu", (e) => e.preventDefault());
      })();
