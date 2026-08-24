# LLM 게이트웨이

내가 만든 앱이 tiguclaw 의 프로바이더 풀을 **OpenAI 호환 API** 로 빌려 씁니다 — 프로바이더마다 SDK 하나씩 대신 엔드포인트 하나로.

내가 만든 앱이 tiguclaw 의 프로바이더 풀을 **OpenAI 호환 API** 로 빌려 씁니다 — 프로바이더마다 SDK 하나씩 대신 엔드포인트 하나로, 비서가 쓰는 크로스-프로바이더 폴백을 그대로요.

**토큰을 주기 전엔 꺼져 있습니다.** `<home>/.env` 에 하나 넣으세요:

```bash
LLM_GATEWAY_TOKEN=<충분히 긴 랜덤 문자열>
```

그다음 OpenAI 클라이언트를 http-bridge 포트(기본 `7011`, `127.0.0.1` 바인드)로 향하게 하세요:

```bash
curl http://127.0.0.1:7011/v1/chat/completions \
  -H "Authorization: Bearer $LLM_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tier:high",
    "messages": [
      { "role": "system",  "content": "너는 내 앱의 어시스턴트다." },
      { "role": "user",    "content": "이걸 한 줄로 요약해줘: …" }
    ]
  }'
```

| 경로 | 되는 것 |
|---|---|
| `POST /v1/chat/completions` | `"stream": true` 스트리밍(SSE 청크), `image_url` 이미지 입력, 내가 정의한 `tools` 를 모델에 그대로 통과. |
| `GET /v1/models` | `model` 에 넣을 수 있는 id 목록 — 명명 프로파일은 `tier:<이름>`, 그리고 설정된 `provider:model` 들. |

`model` 에는 `provider:model`(`anthropic:claude-sonnet-5`), 명명 풀을 쓰는 `tier:<프로파일>`, 또는 그 외 아무 값(= 게이트웨이 기본 풀로 폴백)을 넣습니다.

`<home>/settings.json` 에서 돌아가는 중에 조절하세요 — 매 요청 새로 읽으므로 재시작이 필요 없습니다:

```jsonc
{
  "gateway": {
    "enabled": true,        // 킬 스위치 — 토큰은 둔 채로 끕니다
    "models": ["tier:high", "anthropic:claude-sonnet-5"],
    "maxConcurrency": 4     // 넘으면 429 — 앱이 폭주해도 비서가 굶지 않습니다
  }
}
```

알아두실 것:

- ⚠️ **구독 토큰은 여기에 물리지 마세요.** 게이트웨이는 내 앱이 이 풀을 백엔드로 쓰게 하는
  자리입니다. 뒤에 구독(Claude Pro/Max · ChatGPT Plus/Pro) 토큰이 있으면 **개인 구독이 임의
  앱의 API 백엔드**가 되는데, 그건 대화형 개인 사용과 성격이 다르고 제공사 약관이 허용하지
  않을 수 있습니다. 게이트웨이가 쓸 프로파일은 **API 키 프로바이더**(또는 로컬 Ollama)로
  따로 두세요 — `gateway.models` 로 지정합니다. 자세한 배경은
  [설치와 운영 · 구독 토큰을 쓰기 전에](setup.md#구독-토큰을-쓰기-전에).

- **비서가 아니라 내 앱으로 답합니다.** `system` 메시지가 그대로 쓰이고 tiguclaw 인격·도구·스킬·기억은 실리지 않습니다. 격리된 자리에서 도니 `system` 을 안 보내도 비서 컨텍스트가 새지 않아요. (백엔드 로그인 계정 정보처럼 LLM 제공사가 직접 싣는 건 tiguclaw 가 제어하지 못합니다.)
- **호출 기록은 남고, 내용은 안 남습니다.** 게이트웨이 호출이 내 대화에 섞이진 않지만, 대시보드 **외부 호출 기록**에 호출 사실은 남습니다 — 주고받은 내용 말고 어떤 모델로 몇 건을 처리했고 토큰·소요·성공 여부가 어땠는지만, 내 컴퓨터 안에.
- **함수 호출은 구독만으로도 됩니다.** `tools` 를 실으면 어느 어댑터로 돌든 모델이 실행하지 않고 `tool_calls` 를 돌려줍니다 — API 키 없이 구독 로그인만으로. `tool_choice` 의 `"none"`·`"required"`·특정 함수 지정도 그대로 지켜집니다.
- **응답은 반드시 셋 중 하나입니다** — 함수 호출 · 텍스트 · 명확한 에러. 빈 응답을 성공으로 돌려주지 않습니다.
- **브라우저 말고 앱 *서버* 에서 호출하세요.** 토큰은 공유 비밀이고, 포트는 로컬호스트만 듣습니다.
- **비서와 다른 백엔드를 권합니다.** 앱이 비서가 얹혀 사는 구독을 두들기면 양쪽에서 체감됩니다.

---

[← README](../README.md) · [English](gateway.en.md)
