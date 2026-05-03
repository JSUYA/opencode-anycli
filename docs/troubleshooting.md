# 트러블슈팅 / Troubleshooting

먼저 진단을 돌려보세요:

```bash
openclineclicode --doctor
# 또는
./doctor.sh
```

## 자주 발생하는 문제 / Common issues

### 1. `cline returns nothing` / cline이 아무것도 반환 안 함

**증상**: opencode 화면이 멈춰 있고 응답이 없음. doctor smoke test가 timeout.

**확인**:
```bash
DEBUG=1 openclineclicode
```
Provider가 NDJSON 이벤트를 stderr로 출력합니다. `task_started` 만 보이고 `say.text` / `completion_result` 가 안 오면:

- cline 자체 설정 문제일 수 있습니다. 따로 실행해 보세요:
  ```bash
  cline --json --yolo --act "say hi"
  ```
- 출력이 없으면 cline 설정 문제. `cline` 단독으로 TUI를 띄워서 endpoint 재설정.

### 2. `Permission denied` / 권한 거부

**증상**: cline이 파일을 수정하려다가 권한 prompt에서 멈춤.

**해결**: subprocess 모드는 `--yolo` 플래그(전부 자동승인)로 cline을 실행합니다. 그래도 권한 prompt가 뜨면 cline 버전이 다른 것일 수 있습니다 — cline 버전을 2.18+ 로 업데이트하세요:

```bash
npm install -g cline@latest
```

### 3. `opencode not found` / opencode 바이너리 없음

```
✗ opencode not on PATH
  ↳ Install: npm install -g opencode-ai
```

PATH 확인:
```bash
echo $PATH
which opencode
```

`npm config get prefix` 이 가리키는 `bin` 디렉터리가 PATH에 있는지 확인. `nvm` / `volta` 사용자는 shell 재시작 필요.

### 4. `Node version too old`

```
✗ node v18.17.0 (need >= 20)
```

opencode와 일부 의존성이 Node 20+의 API를 사용합니다. nvm으로 업그레이드:

```bash
nvm install 20
nvm use 20
nvm alias default 20
```

### 5. `cannot find module '@openclineclicode/provider-cline-cli'`

**증상**: opencode 실행 시 위 에러.

**원인**: 워크스페이스 빌드가 안 됐거나, opencode가 다른 node_modules를 보고 있음.

**해결**:
```bash
cd openclineclicode
npm install --workspaces
npm run build --workspaces
```

여전히 문제가 있다면 `~/.config/openclineclicode/opencode/opencode.json` 의 `provider.cline.npm` 값을 절대경로로 바꿔보세요:

```json
"npm": "/path/to/openclineclicode/packages/provider-cline-cli"
```

### 6. `Passthrough mode not yet implemented`

설계상 의도된 동작입니다. `provider.cline.options.mode` 를 `"subprocess"` (기본) 로 두세요. passthrough 구현 일정은 [provider-modes.md](./provider-modes.md) 참고.

### 7. 응답이 너무 느림 / Slow responses

cline이 자체적으로 여러 LLM 호출을 하기 때문에 응답이 30초~수분 걸릴 수 있습니다 (agent-on-agent). 단축하려면:

- 짧고 명확한 prompt 작성. 한 번에 한 가지만 부탁.
- `~/.config/openclineclicode/opencode/AGENTS.md` 에서 cline에게 도구 호출을 줄이도록 가이드.
- (구현되면) passthrough 모드 사용.

### 8. NDJSON 파싱 에러 / NDJSON parse errors

**증상**: `DEBUG=1` 로그에 `[ndjson] failed to parse line: ...` 가 보임.

**원인**: cline이 새 이벤트 타입을 추가했거나, 출력에 NDJSON 외 텍스트(banner, warning 등)가 섞여 있음.

**해결**: provider는 알 수 없는 라인을 안전하게 무시하므로 동작 자체는 계속됩니다. 새 이벤트 타입이라면 `packages/provider-cline-cli/src/ndjson-parser.ts` 에 케이스를 추가하세요.

## 더 깊이 디버깅 / Deeper debugging

cline의 raw 출력을 직접 보기:
```bash
cline --json --yolo --act "list files in cwd" 2>&1 | tee cline-debug.log
```

opencode + provider 통합 동작 보기:
```bash
DEBUG=1 OPENCODE_DEBUG=1 openclineclicode
```

여전히 막히면 `doctor.sh` 의 출력을 함께 첨부해서 이슈를 만들어 주세요.
