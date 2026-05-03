# 설치 가이드 / Installation

로컬에 설치된 `opencode`와 `cline`을 함께 사용하는 설치 절차입니다.

## 사전 요구사항 / Prerequisites

| 항목 | 최소 버전 | 비고 |
|------|-----------|------|
| Node.js | 20.x | `node --version` 으로 확인 |
| `opencode` | 최신 | `npm i -g opencode-ai` 또는 binary tarball |
| `cline` | 2.18 | `npm i -g cline`. 첫 실행 후 사용할 모델/인증 설정 |
| (선택) Bun | 1.x | 있으면 빌드가 더 빠름. 없어도 npm으로 동작 |

## 빠른 설치 / Quick install

```bash
git clone https://example.invalid/openclineclicode.git
cd openclineclicode
./install.sh
```

`install.sh` 가 하는 일:

1. OS / Node 버전 확인 (Node 20+ 필수)
2. `opencode`, `cline` 바이너리 PATH 확인 (없으면 안내 후 종료)
3. 워크스페이스 빌드 (`bun install + build` 우선, 없으면 `npm install --workspaces && npm run build`)
4. `templates/opencode.json` → `~/.config/openclineclicode/opencode/opencode.json` 복사 (기존 파일은 `.bak.<timestamp>`로 백업)
5. `packages/cli/bin/openclineclicode` → `/usr/local/bin/openclineclicode` 심볼릭 링크
   - 권한이 없으면 `--user`로 `~/.local/bin`에 링크

옵션:

| 플래그 | 설명 |
|--------|------|
| `--user` | `~/.local/bin`에 심볼릭 링크 (sudo 불필요) |
| `--sudo` | `/usr/local/bin` 링크 시 sudo 사용 |
| `--skip-build` | 이미 빌드된 dist/를 사용 (오프라인 재설치 시 유용) |

## XDG 격리 / XDG isolation

`openclineclicode` CLI 는 opencode 를 실행할 때 `XDG_CONFIG_HOME=$HOME/.config/openclineclicode` 환경
변수를 자동으로 설정합니다. 그 결과 opencode 는 `~/.config/openclineclicode/opencode/` 아래의
`opencode.json` · `commands/` · `agents/` · `skills/` 만 보게 되며, 사용자가 이미 가지고 있을 수
있는 `~/.config/opencode/` (다른 도구의 설정) 와 완전히 분리됩니다. 사용자가 직접 `XDG_CONFIG_HOME`
을 export 해 두었다면 그 값이 우선합니다.

## 네트워크 트러블슈팅 / Network troubleshooting

### `npm install` 이 hang하거나 ETIMEDOUT

별도 패키지 레지스트리를 사용한다면 `.npmrc` 의 `registry=` 를 변경하세요:

```bash
echo "registry=https://registry.example/" > ~/.npmrc
```

또는 환경변수:

```bash
export NPM_CONFIG_REGISTRY=https://registry.example/
```

이미 다운받은 tarball이 있다면 `--offline` 플래그로 시도:

```bash
npm install --offline --workspaces
```

### `opencode` / `cline` 글로벌 설치가 실패함

옵션 1: 별도 패키지 레지스트리에서 설치
```bash
npm install -g opencode-ai --registry=https://registry.example/
```

옵션 2: GitHub Release tarball을 직접 다운로드해서 PATH가 잡히는 디렉터리에 풀기
- opencode: <https://github.com/sst/opencode/releases>
- cline: <https://github.com/cline/cline/releases>

옵션 3: `npm link` 로 로컬 체크아웃을 글로벌로 노출
```bash
git clone https://github.com/sst/opencode.git
cd opencode && npm install && npm run build && npm link
```

### `cline` 첫 실행 설정

cline을 **한 번 직접 실행**해서 모델과 인증 정보를 설정해야 `~/.cline/data/globalState.json` 이 생성됩니다.

```bash
cline   # TUI가 뜸 → "OpenAI Compatible" 같은 옵션 선택 → URL/API key 입력
```

설정 후 `openclineclicode --doctor` 로 검증하세요.

### 빌드 산출물로 재설치 / Re-install from built artifacts

한 번 빌드한 후 `packages/*/dist/` 와 `node_modules/`를 압축해서 옮기면 빌드 없이 재설치할 수 있습니다:

```bash
tar czf openclineclicode-bundle.tgz openclineclicode/
# 옮긴 후
tar xzf openclineclicode-bundle.tgz
cd openclineclicode
./install.sh --skip-build --user
```
