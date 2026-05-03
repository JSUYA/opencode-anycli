# Changelog

All notable changes to **openclineclicode** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-03 — initial release

opencode 위에 cline CLI 를 연결해 동작하도록 만든
번들의 첫 공개 버전.

### Added — provider 패키지

- **`@openclineclicode/provider-cline-cli`** — Vercel AI SDK v3 `LanguageModelV3`
  구현. `child_process.spawn("cline", ["--json", "--yolo", "--act", prompt])` 으로
  cline 서브프로세스를 띄우고 NDJSON 이벤트 스트림을 파싱.
- 두 가지 호출 경로: `doGenerate` (버퍼 모드) + `doStream` (텍스트 델타 스트리밍).
- `usage` 토큰 카운트는 cline 의 `api_req_finished` 이벤트에서만 수집.
  값이 없으면 0 반환 — 임의로 만들지 않음.
- 타임아웃 (기본 600s) / `AbortSignal` 두 경로 모두 명시적 에러로 surface
  (`timed out after Xms`, `aborted by caller`, `terminated by signal SIG`).
- NDJSON 파서: 부분 chunk 버퍼링, 라인별 defensive parsing, unknown 이벤트
  타입은 `DEBUG=1` 시에만 stderr 로 로그.
- `passthrough` 모드는 명시적 에러 (v0.2 로드맵).

### Added — CLI 진입점

- **`openclineclicode`** 바이너리. 인자(`--config`/`--init`/`--doctor`/`--version`/
  `--help`) 외에는 모두 opencode 로 패스스루.
- 첫 실행 시 `~/.config/openclineclicode/opencode/opencode.json` 자동 생성.
  템플릿의 `__OPENCLINECLICODE_PROVIDER_DIST__` placeholder 를 빌드된 provider
  의 절대 경로로 치환 (npm publish 없이도 즉시 사용 가능).
- opencode 호출 시 `XDG_CONFIG_HOME=$HOME/.config/openclineclicode` 설정으로
  사용자 기본 opencode 설정 (`~/.config/opencode/`) 과 격리.
- pre-flight 검사: opencode/cline 바이너리 존재 + 친절한 설치 안내.

### Added — 설치 / 진단

- **`install.sh`** — 환경 감지(macOS/Linux), Node 20+ 검증, opencode/cline
  바이너리 검증, workspace 빌드, 기본 config 배치, `omc` 심볼릭 링크 생성.
  `--user`/`--system`/`--sudo`/`--skip-build` 플래그 지원. 멱등.
- **`doctor.sh`** — 6 섹션 컬러 진단 (Node/opencode/cline/cline-config/
  openclineclicode-config/smoke-test). 실패 항목별 exit code 반영.
- **`scripts/verify-cline.sh`, `scripts/verify-opencode.sh`** — CI 용 단발 검증.

### Added — 테스트

- vitest 기반: provider 42 테스트 (NDJSON 파서 15, prompt-flatten 10,
  language-model 17), CLI 10 테스트 (config 해석/template substitution).
- E2E smoke 스크립트: 실제 cline 서브프로세스 호출 후 응답 파싱 확인.

### Added — 문서 (한국어 primary)

`docs/architecture.md`, `docs/installation.md`, `docs/configuration.md`,
`docs/provider-modes.md`, `docs/troubleshooting.md`. README 에 자매 프로젝트
[oh-my-clinecli](https://example.invalid/oh-my-clinecli) 안내 + 알려진
한계 (agent-on-agent, passthrough 미구현, 응답 시간 등) 명시.

### 알려진 한계

- **passthrough 모드 미구현** — 현재 모든 호출은 cline subprocess 경유 (agent-on-agent).
- **macOS / Linux 만 지원** — Windows 미지원.
- **토큰 카운트** — cline 의 provider 조합에 따라 0 으로 보일 수 있음 (의도된 동작).
- **응답 시간** — cline CLI + cline agent 루프 합산으로 30초~수 분이 걸릴 수 있음.

### 의존성 핀

- `@ai-sdk/provider@^3.0.8` (Vercel AI SDK v3 `LanguageModelV3` contract).
- Node 20+ 필수.
