/**
 * auth-provider 등록 배선 (side-effect 모듈).
 *
 * ★이 파일이 sync-business 매니페스트의 EXCLUDE 단위다(계약 §5·§8). Business/OSS 빌드에서
 * 이 파일을 제외하면 → 부팅 시 codex auth 등록이 일어나지 않음 → 레지스트리에 "codex" 없음
 * → codex 백엔드가 graceful self-disable(AuthProviderMissingError → 폴백). 백엔드는
 * auth-registry(항상 코어)만 참조하므로 댕글링 참조 0 = 깨끗이 컴파일된다(§2 린치핀).
 *
 * 부팅은 이 모듈을 optional dynamic import 로 로드한다(src/index.ts). 파일 부재(EXCLUDE) 시
 * import 실패 → catch 로 graceful(레지스트리 빈 채 진행). 신규 관용 로직 아님 —
 * loader 의 부재-dir 관용과 동형.
 *
 * kind:"auth-provider" 동적 플러그인은 미도입(defer, 계약 §3). codex 는 kind:core 어댑터라
 * 코어 self-register 가 자연 정합.
 */
import { registerAuthProvider } from "./auth-registry.js";
import { codexAuthProvider } from "./adapters/openai-codex-oauth-auth.js";

registerAuthProvider(codexAuthProvider);
