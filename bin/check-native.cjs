// 네이티브 SQLite 가 **실제로 열리는지** — 설치·업데이트 다섯 경로(install.sh·install.ps1·bin/tiguclaw.mjs·
//  bin/daemon.mjs·self-update)가 같이 부르는 한 판정 (2026-10-16, 아스트라 «초보자 설치 검토» 1번).
//
// ★`require('better-sqlite3')` 만으로는 모른다 — JS 생성자만 가져오고 네이티브 바인딩은 **DB 를 만들 때** 붙는다.
//  바인딩이 없어도 require 는 통과해 자동 rebuild 가 안 돌았다(격리 재현: require 통과 · `new DB(':memory:')` 는
//  `Could not locate the bindings file`). 그래서 메모리 DB 를 열고 닫는다.
// ★의존성 없는 CommonJS — 이 파일이 도는 때는 node_modules 가 깨졌을 수 있는 때다. 종료코드 0 = 쓸 수 있음.
const Database = require("better-sqlite3");
new Database(":memory:").close();
