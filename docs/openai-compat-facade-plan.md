# OpenAI-Compatible Façade 전환 계획 (검증 + 재작성 프롬프트)

> 2026-07-06 작성. 원본 프롬프트(cline provider → OpenAI-compatible façade 전환)를
> 코드베이스와 대조 검증한 결과와, 그 결과를 반영해 재작성한 실행 프롬프트.

## 검증 결과

방향은 맞음. 핵심 설계 판단 4개 전부 타당. 그러나 8곳 디테일 부족 — 그대로
실행하면 기능 손실/루프 발생.

### 타당한 판단들

- passthrough 금지 — 맞음. `language-model.ts:178` TODO만 있는 미구현 경로.
- cline = tool runner 유지 — 맞음.
- cline-native tool을 OpenAI tool_calls로 변환 안 함 — 맞음.
  `providerExecuted: true` (`language-model.ts:623-629`)는 OpenAI API에 등가물 없음.
  변환하면 opencode가 재실행 → 무한루프.
- `skill`/`task`만 tool_calls — 맞음.

### 원래 프롬프트의 갭

1. **바이패스 로직 누락 (최대 문제).** skill slash bypass, NL skill bypass,
   subagent bypass, max-turns guard, duplicate tool-call 필터 — 전부 runner가
   아니라 `language-model.ts:221-246, 406-430`에 있음. "runner 재사용"만 하면
   façade 경로에서 이 기능들 전부 사라짐. 공유 core 추출 범위를 runner가 아니라
   **turn engine**(handoff 조립 + bypass + parser + loop guard 포함)으로 잡아야 함.

2. **History round-trip 미명시.** opencode가 skill/task 실행 후 `role:"tool"`
   메시지 + assistant `tool_calls`로 재진입. 이걸 handoff의
   `<tool-call name="skill">{"name":"X"}</tool-call>` 형태로 정확히 렌더해야
   `isSkillAlreadyDispatchedInHandoff` (`opencode-call-parser.ts:413-426`)
   루프가드가 동작. 안 하면 **skill 무한 재디스패치**.

3. **provider id 모순.** "기존 `cline` provider를 materialize" vs
   "`cline-compat/...`로 보이게" — 상충. 새 id 쓰면 `model`, `small_model`,
   agent 8개의 `cline/GaussO4.1-CLI` 참조 전부 재작성 필요
   (`templates/opencode.json:125-153`). 같은 id `cline` 유지 + npm 필드만
   스왑이 훨씬 안전.

4. **서버 lifecycle 과설계.** 별도 child process 불필요 — `packages/cli`의
   wrapper 프로세스가 opencode 종료까지 상주함 (`index.ts:572-583`).
   in-process HTTP 서버가 맞음.

5. **`tools` 처리 절반만 명시.** opencode는 bash/read/edit 등 전체 tool 목록을
   보냄. skill/task 추출뿐 아니라 나머지를 cline에 forward하지 않는다는 것,
   그리고 tool 목록이 `buildProtocolSection` 입력이 된다는 것 명시 필요.

6. **SSE 침묵 구간.** cline prefill이 수 분 무출력 가능 (ACP watchdog 300s
   설계 이유). SSE keep-alive comment 없으면 클라이언트/프록시 타임아웃.

7. **`--acp` 강제의 위험.** cline-sr 0.6.0은 `--acp` 제거됨
   (`docs/provider-modes.md:29`). 무조건 강제하면 0.6.0에서 즉사.
   `auto` 기본 + env 강제 옵션이 맞음.

8. **모드 전달 경로 소실.** façade에선 opencode가 `options.cli/mode`를 안 넘김 —
   서버 자체 설정 필요.

---

## 재작성 실행 프롬프트

```markdown
너는 /home/jun/dev/os/opencode-anycli 저장소에서 작업하는 senior TypeScript/Node engineer다.

# 목표

opencode-anycli의 cline provider를 실험적으로 OpenAI-compatible façade 방식으로 전환한다.

현재 구조:
  opencode → AI SDK v3 custom provider (file://provider-cline-cli/dist/index.js)
    → language-model.ts (handoff 조립 + bypass + <opencode-call> 파싱 + loop guard)
    → cline-runner.ts (subprocess) 또는 cline-acp-runner.ts (--acp JSON-RPC)

목표 구조 (default):
  opencode → @ai-sdk/openai-compatible (baseURL: http://127.0.0.1:<port>/v1)
    → 로컬 façade HTTP 서버 (wrapper 프로세스 in-process)
    → 기존과 동일한 turn engine → 기존 runner (auto: ACP 우선, subprocess fallback)

새 OpenAI-compatible façade 방식은 기본값으로 사용한다. 기존 direct provider
방식은 OPENCODE_ANYCLI_PROVIDER=direct (또는 wrapper flag --provider direct)로
선택할 수 있는 fallback이다.

# 확정된 설계 판단 (변경 금지)

- cline 설정/credential을 읽어 모델 API를 직접 호출하는 passthrough는 구현하지 않는다.
- cline-cli를 계속 모델 caller / tool runner로 둔다.
- cline-native tool activity(read/bash/edit/write/grep 등)는 OpenAI tool_calls로
  변환하지 않는다. OpenAI API에는 provider-executed tool call 개념이 없어서,
  tool_calls로 내보내면 opencode가 재실행한다. v1에서는 이 활동을
  `[cline:<tool>] <한 줄 요약>` 형태의 text로 보존하거나 (기본),
  OPENCODE_ANYCLI_COMPAT_TOOL_ECHO=0이면 생략한다.
- opencode host-side tool 중 `skill`, `task`(+ `use_subagents` 확장, `lane_dispatch`,
  `lane_collect`)만 OpenAI `tool_calls`로 반환한다. 판별 기준은 기존
  SUPPORTED_OPENCODE_CALL_TOOLS (opencode-call-parser.ts) 그대로.
- ACP 사용: façade 서버의 transport 기본값은 기존과 동일한 "auto"
  (detectAcpSupport로 --acp 지원 감지 → ACP, 아니면 subprocess).
  OPENCODE_ANYCLI_MODE=acp|subprocess 로 강제 가능. 무조건 ACP 강제는 금지
  (cline-sr 0.6.0은 --acp가 제거되어 TUI로 빠져 즉사한다 — docs/provider-modes.md 참고).

# 먼저 읽을 파일

- packages/provider-cline-cli/src/language-model.ts   (bypass/parser/loop-guard 로직의 원본)
- packages/provider-cline-cli/src/cline-handoff.ts    (composeClineHandoff, <tool-call>/<tool-result> 렌더 형식)
- packages/provider-cline-cli/src/opencode-call-parser.ts (SUPPORTED_OPENCODE_CALL_TOOLS,
  bypass 디텍터, isSkillAlreadyDispatchedInHandoff, wasSubagentDispatchedInHandoff)
- packages/provider-cline-cli/src/cline-runner.ts     (RunInput, StreamEvent, runStream/runOnce)
- packages/provider-cline-cli/src/cline-acp-runner.ts (runStreamAcp/runOnceAcp)
- packages/provider-cline-cli/src/cline-capabilities.ts (detectAcpSupport)
- packages/provider-cline-cli/src/types.ts
- packages/cli/src/index.ts, config.ts, temp-config.ts
- templates/opencode.json
- docs/provider-modes.md, docs/architecture.md

# Phase 0 — 스파이크 (본 구현 전 30분 검증)

opencode가 `npm: "@ai-sdk/openai-compatible"` + `options.baseURL` provider를 실제로
로드하는지 먼저 확인한다. 고정 응답만 반환하는 20줄짜리 임시 node:http 서버를 띄우고,
임시 opencode.json으로 opencode를 붙여 (a) /models에 모델이 보이는지,
(b) 한 turn이 왕복되는지, (c) streaming chunk가 UI에 표시되는지 확인.
실패하면 여기서 멈추고 원인(패키지 로딩 방식, options 스키마)을 보고한다.
이 스파이크 결과에 따라 아래 config 스키마를 조정한다.

# Phase 1 — 공유 turn engine 추출

language-model.ts의 doGenerate/doStream에는 runner 호출 외에 다음 로직이 있고,
façade에서도 전부 동일하게 동작해야 한다:

  1. composeClineHandoff 호출 (prompt → 단일 handoff text + commandInstructions)
  2. max-turns guard (countTurnsInPrompt)
  3. skill slash-command bypass (detectSkillSlashCommand + isSkillAlreadyDispatchedInHandoff)
  4. skill natural-language bypass (detectSkillNaturalLanguageInHandoff)
  5. subagent bypass (detectSubagentDispatchesInHandoff)
  6. mode 해석 (resolveMode: acp/subprocess/auto)
  7. runner 실행 + OpencodeCallParser로 <opencode-call> 추출
  8. use_subagents 확장 (expandOpencodeCall) + 미등록 tool text 복원
  9. duplicate tool-call 필터 (previousToolCalls)

이걸 `packages/provider-cline-cli/src/cline-turn-engine.ts`로 추출한다:

  interface TurnRequest {
    handoffText: string
    commandInstructions: readonly string[]
    tools: readonly ProtocolToolDescriptor[]
    modelId: string
    signal?: AbortSignal
    config: { command, timeoutMs, extraArgs?, cwd?, env?, mode }
  }
  type TurnEvent =
    | { type: "reasoning-delta"; delta: string }
    | { type: "text-delta"; delta: string }
    | { type: "cline-tool"; toolName: string; summary: string }   // native tool 활동 (정보성)
    | { type: "opencode-call"; toolName: string; input: unknown } // skill/task/lane_* 만
    | { type: "finish"; usage: ClineUsage; finishReason: "stop" | "tool-calls"; raw?: string }
    | { type: "error"; error: Error }
  function runClineTurn(req: TurnRequest): AsyncIterable<TurnEvent>

제약:
- 추출은 기계적으로. direct provider의 관찰 가능한 동작(이벤트 순서, finishReason,
  providerMetadata 값)은 변하지 않아야 하고, 기존 테스트는 수정 없이 통과해야 한다.
  (V3 스트림 파트 조립 — text-start/end, reasoning block, providerExecuted 마킹 —
  은 language-model.ts에 남긴다. engine은 중립 이벤트만 낸다.)
- duplicate tool-call 추적은 엔진 인스턴스가 아니라 호출자가 Set을 소유하고 주입한다
  (direct provider는 모델 인스턴스 수명, façade는 요청 단위 + history 기반 loop guard).
- claude/codex flavor (doGenerateCli/doStreamCli)는 이번 작업 범위 밖 — 건드리지 않는다.

# Phase 2 — OpenAI request 정규화

packages/provider-cline-cli/src/openai-compat/ 아래 새 모듈.
의존성 추가 없이 node:http 로 구현한다 (Node 20 ESM).

`translate-request.ts`:
- OpenAI `messages[]` → composeClineHandoff가 받는 정규화 메시지 배열로 변환.
  - system/user/assistant: content string 또는 content parts 배열 (text만) 모두 수용.
  - assistant.tool_calls → { type: "tool-call", toolCallId, toolName, input(JSON 파싱) }
    파트로 변환. ★ 중요: 이 형태가 cline-handoff.ts에서
    `<tool-call name="skill">{"name":"X"}</tool-call>` 로 렌더되어야
    isSkillAlreadyDispatchedInHandoff / wasSubagentDispatchedInHandoff 루프가드와
    countTurnsInPrompt가 façade 경로에서도 동작한다. 이게 어긋나면 skill이
    turn마다 무한 재디스패치된다. 렌더 결과를 단위 테스트로 고정할 것.
  - role:"tool" → { type: "tool-result", toolCallId, toolName, output } 파트로 변환
    (tool_call_id로 직전 assistant tool_calls에서 toolName 역참조).
- OpenAI `tools[]` → ProtocolToolDescriptor[] (function.name만 추출).
  skill/task/lane_* 이외의 이름(bash/read/edit/...)도 목록에는 넣되,
  cline에 forward하는 것은 buildProtocolSection이 whitelist로 거른다 — 기존과 동일.
  `tool_choice`는 무시한다 ("none"이면 protocol section 생략 정도만 허용).
- `model` → modelId 그대로 (GaussO4.1-CLI 등). `n`, `temperature` 등 미지원 파라미터는
  무시하고 warning 로그만.

# Phase 3 — façade HTTP 서버

`openai-compat/server.ts`:
- `startOpenAiCompatServer(opts): Promise<{ port, token, close() }>`
  127.0.0.1 바인드, port 0 (자동 선택).
- 보안: 시작 시 random token 생성. `Authorization: Bearer <token>` 불일치 요청은 401.
  (같은 머신의 다른 프로세스가 임의로 cline을 구동하는 것 방지.)
- `GET /healthz` → 200 {"status":"ok"}
- `GET /v1/models` → 서버 시작 시 주입받은 model id 목록 (config에서 전달).
- `POST /v1/chat/completions`:
  - non-stream: runClineTurn 완주 후
    - text만 → choices[0].message.content, finish_reason "stop"
    - opencode-call 있음 → message.tool_calls[]
      ({id, type:"function", function:{name, arguments(JSON string)}}), content는
      호출 전 text가 있으면 함께, finish_reason "tool_calls"
    - usage: prompt_tokens = input+cacheRead+cacheWrite, completion_tokens = output,
      total_tokens, prompt_tokens_details.cached_tokens = cacheRead
      (@ai-sdk/openai-compatible이 cached_tokens를 읽는다)
  - stream (SSE):
    - `data: {chat.completion.chunk}` 형식, 마지막 `data: [DONE]`
    - text-delta → choices[0].delta.content
    - reasoning-delta → choices[0].delta.reasoning_content
      (@ai-sdk/openai-compatible의 DeepSeek 스타일 필드. opencode 쪽에서
      무시되더라도 무해 — Phase 0에서 표시 여부 확인)
    - cline-tool → delta.content로 `[cline:<tool>] <summary>\n` 한 줄
      (OPENCODE_ANYCLI_COMPAT_TOOL_ECHO=0이면 생략)
    - opencode-call → tool_calls delta (index, id, function.name, function.arguments
      전체를 한 chunk로 — 우리는 완성된 call만 파싱하므로 인자 분할 스트리밍 불필요)
    - finish chunk: finish_reason "stop" | "tool_calls"
    - stream_options.include_usage 요청 시: [DONE] 직전에 choices:[] + usage chunk
    - keep-alive: 이벤트 없이 15초 경과마다 SSE comment (`: keep-alive\n\n`) 전송.
      cline prefill은 수 분 무출력이 정상이다 (ACP watchdog가 300s인 이유).
  - abort: req 'close'/'aborted' 시 내부 AbortController abort → cline 프로세스 종료.
    runClineTurn의 signal에 연결.
  - 동시 요청 허용 (직렬화 금지). opencode는 title/summary를 본 turn과 동시에 쏜다.
- transport: OPENCODE_ANYCLI_MODE(acp|subprocess|auto, 기본 auto)를 서버 config로 읽어
  TurnRequest.config.mode에 전달. cline binary는 OPENCODE_ANYCLI_CLINE_BIN 존중.

package.json: tsup entry에 openai-compat 추가하고 subpath export
`"./openai-compat"` 노출 (packages/cli가 import).

# Phase 4 — CLI lifecycle + config materialization

packages/cli:
- 새 flag `--provider <direct|openai-compat>` (wrapper가 소비, opencode로 passthrough
  금지) + env OPENCODE_ANYCLI_PROVIDER. 기본 direct.
- openai-compat 모드일 때: opencode spawn 전에
  `startOpenAiCompatServer()`를 **같은 프로세스에서** 시작한다 (별도 child 불필요 —
  wrapper는 어차피 opencode 종료까지 상주). opencode 종료 시 server.close().
  packages/cli → provider-cline-cli workspace 의존성 추가.
- temp-config.ts 확장: materializeTempConfig에 providerMode 옵션 추가.
  openai-compat일 때 resolved config의 `provider.cline`을 다음으로 치환:

    "cline": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cline (OpenAI-compat façade)",
      "options": {
        "baseURL": "http://127.0.0.1:<port>/v1",
        "apiKey": "<token>"
      },
      "models": { ...기존 cline.models 그대로 복사... }
    }

  ★ provider id는 `cline` 그대로 유지한다. 새 id(cline-compat)를 만들면
  templates/opencode.json의 model/small_model + agent 8개의 "cline/GaussO4.1-CLI"
  참조를 전부 재작성해야 하고 rollback도 복잡해진다. picker 구분은 name 필드
  ("OpenAI-compat façade")로 충분하다.
  - claude/codex provider는 그대로 (file:// direct 유지).
  - templates/opencode.json은 수정하지 않는다 — 치환은 temp config에서만.
  - 주의: 현재 materializeTempConfig는 autoApprove가 아니면 null 반환 —
    providerMode만으로도 temp config가 만들어지도록 조건 수정.
  - port/token은 서버 시작 후 결정되므로 순서: 서버 시작 → temp config 작성 →
    opencode spawn.

# Phase 5 — 테스트

provider-cline-cli (vitest, 기존 컨벤션 따름):
- translate-request: messages 정규화, tool_calls/tool 메시지 round-trip이
  handoff의 <tool-call>/<tool-result> 렌더와 일치하는지 (루프가드 회귀 테스트 —
  같은 skill 재진입 시 bypass가 발화하지 않는 것까지)
- turn-engine: fake runner 주입으로 bypass 3종 + max-turns + duplicate 필터가
  기존 language-model 테스트와 동일 결과인지
- server non-stream: text-only / tool_calls / usage 매핑
- server stream: chunk 시퀀스, tool_calls delta, include_usage, [DONE], keep-alive
- abort: 클라이언트 disconnect → runner signal abort 확인 (fake runner)
- auth: token 불일치 401
packages/cli:
- temp-config: providerMode 치환 결과 (cline만 변경, claude/codex 불변,
  기존 사용자 permission/deny 보존)
기존 테스트 전부 무수정 통과 = Phase 1 추출이 무해하다는 증거.

# 검증 명령 (AGENTS.md에 따라 rtk prefix)

- rtk npm run typecheck
- rtk npm run test
- rtk npm run build
- 패키지 단위: cd packages/provider-cline-cli && rtk npm run test / cd packages/cli && rtk npm run test

# 완료 기준

- 아무 플래그 없이 opencode-anycli 실행 시 opencode가 로컬 façade에 붙고,
  OPENCODE_ANYCLI_PROVIDER=direct 실행 시 direct 모드가 기존 그대로 동작.
- /models에서 cline/GaussO4.1-CLI, cline/GaussO3.3-CLI가 보인다.
- GaussO4.1-CLI 일반 prompt가 cline-cli(ACP 가능 시 ACP transport)로 처리되고
  streaming이 opencode UI에 표시된다.
- /<skill> slash command와 "X 스킬로 분석해줘" prose가 façade 경로에서도
  skill tool_call로 나가고, 재진입 turn에서 재디스패치되지 않는다 (루프가드).
- task/use_subagents 디스패치가 실제 opencode 자식 세션을 만든다.
- cline 내부 tool 실행은 text 한 줄 마커로 보이거나 (기본) env로 끌 수 있다.
- typecheck/test/build 통과, 기존 테스트 무수정 통과.

# 금지 사항

- unrelated refactor 금지. Phase 1 추출도 이동 최소화 — 로직 개선/이름 정리 금지.
- templates/opencode.json의 기존 provider/agent 구조 변경 금지 (치환은 temp config만).
- 사용자 설정 파일 덮어쓰기 금지.
- cline credential/globalState 스키마 의존 금지.
- OpenAI-compatible 표준에 없는 필드를 핵심 동작 전제로 삼지 말 것
  (reasoning_content는 무시돼도 동작에 지장 없는 부가 정보로만).
- --acp 무조건 강제 금지 — auto 감지 유지.
```

---

## 원본 대비 핵심 차이 요약

1. **Phase 0 스파이크 추가** — opencode가 `@ai-sdk/openai-compatible` + baseURL을
   실제로 로드하는지 20줄 서버로 먼저 확인. 실패 시 전체 계획 무효.
2. **추출 단위를 runner가 아닌 turn engine으로** — bypass/루프가드 보존.
3. **history→handoff 렌더 일치를 명시적 회귀 테스트로** — 없으면 skill 무한루프.
4. **provider id `cline` 유지 결정** — agent 8개 model 참조 재작성 회피, rollback 단순.
5. **서버 in-process** — wrapper가 상주 프로세스이므로 child 관리 불필요.
6. **SSE keep-alive + auth token** — cline 수 분 무출력 대비, 로컬 포트 보호.
7. **`--acp`는 auto 유지, env로만 강제** — cline-sr 0.6.0 호환.
