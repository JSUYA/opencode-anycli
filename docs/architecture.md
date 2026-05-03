# 아키텍처 / Architecture

## 한 줄 요약 / TL;DR

opencode 안에 살고 있는 Vercel AI SDK v3 `LanguageModelV3` 프로바이더가, LLM API 호출 대신 로컬 `cline` CLI 프로세스를 띄워 그 결과를 돌려줍니다.

A Vercel AI SDK v3 `LanguageModelV3` provider that lives inside opencode and, instead of calling an LLM API, spawns the local `cline` CLI process and returns its result.

## 다이어그램 / Diagram

```
   ┌──────────────┐
   │   opencode   │   사용자가 입력 → opencode가 LLM 호출이 필요하다고 판단
   │  (TUI/Agent) │
   └──────┬───────┘
          │  doGenerate({ prompt, tools, ... })   AI SDK v3 LanguageModelV3 contract
          ▼
   ┌──────────────────────────┐
   │ provider-cline-cli       │   ① messages → 단일 텍스트로 평탄화
   │ (this package)           │   ② child_process.spawn("cline", ...)
   │                          │   ③ stdout NDJSON 파싱
   └──────┬───────────────────┘   ④ { text, finishReason, usage } 반환
          │
          │  spawn cline --json --yolo --act "<prompt>"
          ▼
   ┌──────────────┐    HTTP    ┌──────────────┐
   │ cline 2.18   │ ─────────► │ configured   │
   │ (Apache-2.0) │ ◄───────── │ LLM via cline│
   └──────────────┘            └──────────────┘
```

## 두 가지 모드 / Two modes

### Subprocess (default, MVP에 구현됨)

opencode가 doGenerate를 호출할 때마다:

1. AI SDK 메시지 배열을 평탄화하여 단일 prompt 문자열을 만든다.
   - 시스템 메시지 → `[SYSTEM]\n...\n\n` 접두
   - 사용자/어시스턴트 메시지는 role marker와 함께 보존
2. `cline --json --yolo --act "<prompt>"` 서브프로세스를 띄운다 (`spawn`, **not** `exec`).
3. stdout으로 흘러나오는 NDJSON 라인을 파싱한다. 각 라인은 cline 내부 이벤트:
   - `task_started` → 무시
   - `say.text` (final, partial:false) → 최종 어시스턴트 텍스트
   - `say.completion_result` → 완료 신호
   - `say.reasoning` → 폐기 (cline 내부 사고)
   - `say.api_req_started` → 무시 (cline이 자기 LLM에 보낸 prompt 포함)
   - `say.api_req_finished` (tokensIn/tokensOut 있는 경우) → 토큰 사용량 수집
4. `{ text, finishReason: "stop", usage }` 반환.

**장점**: cline의 모든 도구(파일 편집, 명령 실행 등)를 그대로 활용. cline이 사용자의 기존 설정으로 모델 호출을 처리합니다.

**단점**:
- **에이전트가 두 겹** — opencode 에이전트가 cline 에이전트에게 위임. 토큰/시간 비용 증가.
- 응답이 느림 (수십 초 ~ 수 분).
- 토큰 사용량은 cline이 노출하는 만큼만 보인다.

### Passthrough (opt-in, MVP 미구현 — TODO)

opencode가 cline의 **설정 파일**(`~/.cline/data/globalState.json`, `~/.cline/data/secrets.json`)을 읽어 LLM endpoint와 키를 추출, `@ai-sdk/openai-compatible` 프로바이더로 직접 호출.

**장점**: 빠르고 깔끔. 토큰 카운트 정확. opencode 에이전트가 onboard 도구를 그대로 사용.

**단점**:
- cline의 도구를 사용하지 않음 — 그것은 opencode 자체 도구로 대체됨.
- cline 설정 스키마에 의존 — cline 버전 업그레이드 시 깨질 수 있음.
- `secrets.json` 포맷이 운영체제별로 다를 수 있음 (cline이 keychain을 쓰는 환경이 있음).

## 왜 이 디자인인가 / Why this design (Option A vs C trade-off)

설계 후보:

- **Option A (subprocess wrapper)**: 빠른 MVP, 견고. cline을 블랙박스 취급. **선택**.
- **Option B (cline 코드 임베드)**: cline의 내부 모듈을 import. cline이 라이브러리로 디자인되지 않아 깨지기 쉽고 라이선스 경계 흐려짐. **버림**.
- **Option C (passthrough only)**: 빠르지만 cline의 도구를 잃음. **future work**으로 남김.

Option A는 가장 보수적이고 cline 업그레이드에 강합니다. 외부 코드 import 없이 단순 subprocess로 연결하므로 구조도 단순합니다.

## Agent-on-agent 주의사항 / Caveat

opencode와 cline 모두 "에이전트"입니다. 둘 다 다음을 합니다: 컨텍스트 수집 → 도구 호출 계획 → LLM 호출 → 결과 해석 → 반복. opencode가 cline에게 한 번 위임할 때, cline 안에서 수십 번의 LLM 호출이 일어날 수 있습니다.

이를 완화하려면:
- opencode 측 시스템 프롬프트(`AGENTS.md`)에서 가능한 한 한 번에 의도를 명확하게 표현하도록 가이드.
- 짧고 결정론적인 작업(예: 단일 파일 수정)에는 passthrough 모드(향후) 사용.
- 진단 가능하도록 `DEBUG=1 openclineclicode`로 NDJSON 이벤트를 stderr에 흘려볼 수 있게 함.
