# HEARTBEAT.md

## 컨텍스트 관리 (매 하트비트)
- 이번 대화에서 중요한 결정/작업 있었으면 → memory_store로 기록
- 작업 완료한 게 있으면 → 정태님한테 요약 보고

## 프로젝트 상태 체크 (하루 4회)
- **핫딜 알리미 봇** 상태 확인 — 프로세스 살아있는지, 에러 없는지
- **tiguclaw 에이전트** 상태 확인 — launchctl 서비스 정상 동작 중인지
- memory/ 일일 메모 → MEMORY.md 반영할 것 있으면 반영

## 봇 상태 체크
```
launchctl list | grep coupang
launchctl list | grep tiguclaw
```

## 에이전트 상태 체크
```
launchctl list | grep tiguclaw
tail -20 ~/Library/Logs/tiguclaw/tiguclaw.log
```

## 메모리 유지보수 (하루 1회)
- 오래된/중복 정보 MEMORY.md에서 정리
- 완료된 프로젝트 항목 아카이브

## 조용한 시간
- 23:00 ~ 08:00: 긴급 상황 아니면 정태님한테 먼저 연락하지 않기
