# 프로바이더 모드 / Provider modes

`provider-cline-cli`는 두 가지 모드를 지원합니다 (현재 MVP는 subprocess만 구현).

## 비교 / Comparison

| 항목 | subprocess (default) | passthrough (TODO) |
|------|----------------------|--------------------|
| **속도** | 느림 (수 초 ~ 수 분) | 빠름 (LLM 직접 호출) |
| **에이전트 깊이** | 두 겹 (opencode → cline) | 한 겹 (opencode만) |
| **cline 도구 사용** | ✅ 모두 사용 가능 | ❌ 없음 |
| **opencode 도구 사용** | ✅ (cline이 결과를 만든 후) | ✅ |
| **토큰 카운팅** | cline이 노출하는 만큼만 | 정확 |
| **cline 버전 의존성** | NDJSON 이벤트 형식만 | 설정 파일 스키마 + secrets 포맷 |
| **검토 난이도** | 낮음 (외부 코드 import 없음) | 중간 (cline 내부 파일 읽음) |
| **현재 구현 상태** | ✅ MVP에 구현 | ⏳ TODO |

## 언제 어떤 모드 / When to use which

### subprocess

- **대부분의 경우**. opencode TUI를 그냥 잘 쓰고 싶을 때.
- cline이 가진 도구(파일 편집, 명령 실행, MCP 도구 등)를 그대로 활용하고 싶을 때.
- cline 버전이 자주 업데이트되어도 깨지지 않기를 원할 때.

### passthrough (구현 후)

- 빠른 응답이 필요한 짧은 채팅/요약 작업.
- 토큰 사용량을 정확히 추적해야 할 때.
- opencode의 onboard 도구만으로 충분하고, cline의 도구는 필요 없을 때.

## 설정 / Configuration

`~/.config/openclineclicode/opencode/opencode.json`:

```json
{
  "provider": {
    "cline": {
      "options": {
        "mode": "subprocess"
      }
    }
  }
}
```

`mode`를 `"passthrough"` 로 바꾸면 (현재) 다음 에러가 throw 됩니다:

```
Error: Passthrough mode not yet implemented — see docs/provider-modes.md
```

## passthrough 모드 설계 (참고) / Design notes for passthrough

구현 시 흐름:

1. `~/.cline/data/globalState.json` 에서 다음 필드 읽기:
   - `actModeApiProvider` (예: `"openai-compatible"`, `"anthropic"`, `"openrouter"`, ...)
   - `actModeApiModelId` (예: `"custom-model"`)
   - 기타 base URL, organization 등 provider별 필드
2. `~/.cline/data/secrets.json` 에서 API key 읽기 (key 이름은 provider에 따라 다름).
3. 위 정보로 `@ai-sdk/openai-compatible` (또는 매칭되는 ai-sdk provider) 인스턴스를 생성.
4. opencode가 호출한 `doGenerate` / `doStream` 을 그대로 위임.

주의:
- secrets.json 포맷은 cline 버전마다 다를 수 있음. 첫 구현 시 `cline 2.18.0` 기준.
- 일부 환경에서 cline은 OS keychain (macOS Keychain, Linux secret-service)을 사용 — 이 경우 secrets.json 에 키가 없으므로 다른 fallback이 필요.
- cline의 `actModeApiProvider` 가 custom provider일 경우 별도 매핑 테이블 필요.

PR 환영합니다.
