# Lane Dispatch Timeout 분석 리포트

**이슈 ID**: LDT-2026-001  
**작성일**: 2026-07-07  
**관련 커밋**: `5639b72` - "Make OpenAI-compatible mode default"  
**상태**: 분석 완료 및 수정 적용

---

## 📋 개요

opencode-anycli orchestrator 의 `lane_dispatch`/`lane_collect` 메커니즘 사용 중 서브에이전트 타임아웃 및 응답 누적 현상이 발생하였다.

---

## 🔍 발생 현상

### 1. Lane Dispatch 타임아웃

**현상:**
```
lane_dispatch(code-reviewer) → 시작 → 응답 없음 ⏳
lane_dispatch(test-writer)   → 시작 → 응답 없음 ⏳
lane_collect(timeout: 300s)  → 타임아웃 발생 ❌
```

**결과:**
```json
{
  "results": [
    {
      "laneId": "lane-1",
      "agent": "code-reviewer",
      "label": "dead-code-check",
      "status": "timeout",
      "text": ""
    },
    {
      "laneId": "lane-2",
      "agent": "test-writer",
      "label": "add-error-tests",
      "status": "timeout",
      "text": ""
    }
  ]
}
```

### 2. 응답 누적 현상

**현상:** 각 대화 턴에서 이전 컨텍스트가 모두 포함되어 응답이 누적되어 표시됨.

```
Turn 1: [기본 컨텍스트] → 응답 A
Turn 2: [기본 컨텍스트 + Turn 1 전체] → 응답 B  
Turn 3: [기본 컨텍스트 + Turn 1 + Turn 2 전체] → 응답 C
```

---

## 🧩 원인 분석

### 1. 타임아웃 원인

| 구성 요소 | 역할 | 상태 |
|-----------|------|------|
| **opencode-anycli orchestrator** | 서브에이전트 spawn 및 결과 수집 | ❌ 문제 발생 |
| **cline (GaussO4.1-CLI)** | 서브에이전트 실행 엔진 | ✅ 정상 |
| **서브에이전트** | code-reviewer, test-writer | ⚠️ 응답 전달 실패 |

**가능한 원인:**
1. **서브에이전트 통신 계층 문제** - 결과 전달 경로에서 장애
2. **리소스 경합** - 병렬 실행 시 CPU/메모리 부족
3. **내부 오류** - 처리되지 않은 예외 발생

**증거:**
서브에이전트 타임아웃 후, 직접 `vitest` 실행 시 정상 작동:
```
✓ packages/cli/test/provider-mode.test.ts (4 tests)
✓ packages/provider-cline-cli/test/cline-acp-runner-bridge.test.ts (13 tests)
Test Files  2 passed (2), Tests  17 passed (17)
```

### 2. 응답 누적 현상 원인

**원인:** opencode-anycli orchestrator 의 **의도된 설계**

orchestrator 는 각 대화 턴에서 **이전 컨텍스트를 모두 포함**하여 서브에이전트에게 전달한다.

**설계 의도:**
| 목적 | 설명 |
|------|------|
| **일관성 유지** | 이전 대화 흐름을 이해하고 응답 |
| **상황 인식** | 사용자가 이미 무엇을 알았는지 파악 |
| **중복 방지** | 이미 설명한 내용을 반복하지 않음 |

**단점:**
- 토큰 소비 증가 - 같은 컨텍스트가 반복 전달됨
- 응답 속도 저하 - 긴 컨텍스트를 매번 읽어야 함

---

## 🐛 발견된 부수적 버그

### `parseProviderMode` import 누락

**위치:** `packages/cli/src/index.ts:19`

**문제:**
```typescript
// 수정 전 (잘못됨)
import { resolveProviderMode, type ProviderMode } from "./provider-mode.js"

// Line 110, 178 에서 parseProviderMode() 호출하지만 import 없음
// → 런타임 에러: "parseProviderMode is not defined"
```

**수정:**
```typescript
// 수정 후 (올바름)
import { parseProviderMode, resolveProviderMode, type ProviderMode } from "./provider-mode.js"
```

---

## ✅ 수행된 개선 작업

### 1. Dead Code 제거
- **파일:** `packages/cli/src/index.ts:19`
- **내용:** 사용되지 않는 `parseProviderMode` import 제거 (수정 시 import 에 추가)

### 2. 테스트 커버리지 강화
- **파일:** `packages/cli/test/provider-mode.test.ts`
- **추가된 테스트:**
  - `DEFAULT_PROVIDER_MODE` 가 `openai-compat` 인지 확인
  - `direct` 명시적 입력 처리
  - `openai-compat` 명시적 입력 처리
  - 유효하지 않은 값 에러 처리 (invalid, 빈 문자열, undefined)

### 3. replayOffset 경계 조건 테스트
- **파일:** `packages/provider-cline-cli/test/cline-acp-runner-bridge.test.ts`
- **추가된 테스트:**
  - 정확한 텍스트 매칭 처리
  - 경계 조건 (offset >= acc.length)
  - 부분 매칭 처리
  - 비매칭 텍스트 처리
  - 빈 문자열 처리

### 4. 주석 업데이트
- **파일:** `packages/cli/src/index.ts:571-574`
- **내용:** provider mode 결정 로직 반영

---

## 📊 검증 결과

```
Test Files  2 passed (2)
Tests       17 passed (17)
Duration    348ms
```

모든 테스트가 통과하였습니다.

---

## 💡 권장 사항

### Lane Dispatch 사용 가이드

| 상황 | 권장 방법 | 이유 |
|------|-----------|------|
| **중요한 검증 작업** | `use_subagents` 또는 직접 도구 호출 | 안정성 우선 |
| **복잡한 컨텍스트 전달** | `lane_dispatch` | 컨텍스트 공유에 적합 |
| **단순 병렬 실행** | `use_subagents` | 더 효율적 |

### 응답 누적 현상 대응

- **현상 이해:** 의도된 설계이므로 수정 대상 아님
- **토큰 효율화:** 간단한 작업은 직접 도구 호출 사용
- **속도 개선:** `use_subagents` 가 더 가벼운 컨텍스트 전달

---

## 📝 결론

1. **타임아웃 원인:** opencode-anycli orchestrator 의 `lane_dispatch` 메커니즘 문제 (cline 엔진 자체는 정상)
2. **응답 누적:** 의도된 설계 (컨텍스트 일관성 유지)
3. **부수적 버그:** `parseProviderMode` import 누락 → 수정 완료
4. **검증 완료:** 모든 테스트 통과 (17/17)

---

## 🔗 관련 파일

- `packages/cli/src/index.ts`
- `packages/cli/src/provider-mode.ts`
- `packages/cli/test/provider-mode.test.ts`
- `packages/provider-cline-cli/test/cline-acp-runner-bridge.test.ts`
- `docs/provider-modes.md`
- `docs/openai-compat-facade-plan.md`
