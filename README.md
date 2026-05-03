# openclineclicode

> **opencode를 cline CLI로 실행하자.** [opencode](https://github.com/sst/opencode) AI 에이전트의 LLM 호출을 로컬 [cline CLI](https://github.com/cline/cline) 프로세스로 전달하는 번들입니다.
>
> *A bundle that runs the [opencode](https://github.com/sst/opencode) AI coding agent through your locally installed [cline](https://github.com/cline/cline) CLI.*

---

## 왜 필요한가 / Why this exists

- **opencode**는 좋은 TUI와 멀티-에이전트 워크플로를 제공합니다.
- **cline CLI**는 사용자가 이미 설정한 모델과 인증 정보를 사용합니다.
- 이 번들은 opencode의 LLM 호출을 cline CLI 서브프로세스로 전달합니다.

The adapter spawns `cline --json --yolo --act "<prompt>"` as a subprocess, parses its NDJSON event stream, and returns the final assistant text to opencode.

## 3-line 설치 / Install in 3 commands

```bash
git clone https://example.invalid/openclineclicode.git
cd openclineclicode
./install.sh
```

설치 후:

```bash
openclineclicode      # opencode TUI가 cline 백엔드로 실행됩니다
```

## 아키텍처 / Architecture

```
   ┌──────────────┐    LanguageModelV3    ┌──────────────────────┐    spawn       ┌────────────┐    HTTP    ┌──────────────┐
   │   opencode   │ ───────────────────►  │ provider-cline-cli   │ ─────────────► │   cline    │ ─────────► │ configured LLM │
   │  (TUI/Agent) │ ◄───────────────────  │ (this package)       │ ◄───── NDJSON  │  CLI 2.18  │ ◄───────── │  via cline     │
   └──────────────┘                       └──────────────────────┘                └────────────┘            └──────────────┘
```

자세한 내용은 [`docs/architecture.md`](./docs/architecture.md)를 참고하세요.

## 모드 / Modes

- **subprocess** (기본): cline을 매번 띄워서 에이전트 루프를 그대로 사용합니다. 안정적이지만 느립니다 (agent-on-agent).
- **passthrough** (실험): cline의 설정 파일에서 LLM endpoint를 읽어서 opencode가 직접 호출합니다. 빠르지만 cline의 도구는 사용하지 않습니다. **MVP에서는 미구현 — TODO**.

비교는 [`docs/provider-modes.md`](./docs/provider-modes.md) 참고.

## 진단 / Diagnose

```bash
./doctor.sh   # 또는: openclineclicode --doctor
```

Node 버전, `opencode`/`cline` PATH, cline 설정 파일 유효성, 그리고 짧은 end-to-end smoke test를 실행합니다.

## 자매 프로젝트 / Companion project

[**oh-my-clinecli**](https://example.invalid/oh-my-clinecli) — openclineclicode 위에 얹는
스킬·커맨드·서브에이전트 모음. `/review`, `/test`, `/audit-deps`, `/dockerfile-review`,
`/standup`, `/weekly` 등 팀 표준 워크플로를 추가합니다.

```bash
git clone https://example.invalid/oh-my-clinecli.git ~/.oh-my-clinecli
~/.oh-my-clinecli/install.sh
```

설치하지 않아도 openclineclicode 단독으로 동작합니다. 팀 표준화가 필요할 때 추가로 도입하세요.

## 알려진 한계 / Known limitations

- **Agent-on-agent 비용**: subprocess 모드는 cline 자체 agent 루프를 거치므로 컨텍스트와 토큰
  비용이 직접 호출 대비 1.5~2배. 자세한 trade-off는 [`docs/architecture.md`](./docs/architecture.md).
- **Passthrough 모드 미구현**: `mode: "passthrough"` 설정 시 명시적 에러를 던집니다. v0.2 로드맵.
- **응답 시간**: cline CLI 응답 + cline agent 루프 합산으로 30초~수 분이 정상. 타임아웃은
  `provider.cline.options.timeoutMs` (기본 600초) 로 조정.
- **토큰 사용량 보고 정확도**: cline의 `api_req_finished` 이벤트가 노출하는 만큼만 보입니다.
  일부 cline 설정 조합에서는 0으로 표시 — 의도된 "fabricate 안 함" 동작.
- **macOS / Linux**: Windows 미지원 (subprocess와 install.sh 모두 POSIX 가정).

## 문서 / Documentation

- [`docs/installation.md`](./docs/installation.md) — 설치 가이드
- [`docs/architecture.md`](./docs/architecture.md) — 설계 결정과 trade-off
- [`docs/configuration.md`](./docs/configuration.md) — `opencode.json` 레퍼런스, 환경변수
- [`docs/provider-modes.md`](./docs/provider-modes.md) — subprocess vs passthrough
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — 자주 발생하는 오류 해결법

## 라이선스 / License

MIT. opencode는 MIT, cline은 Apache-2.0 — 두 프로젝트 모두 별도로 설치되어 있어야 합니다.
