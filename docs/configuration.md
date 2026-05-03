# 설정 / Configuration

## 설정 파일 위치 / Config file locations

| 경로 | 역할 |
|------|------|
| `~/.config/openclineclicode/opencode/opencode.json` | opencode 자체 설정 + 프로바이더 등록 |
| `~/.config/openclineclicode/opencode/AGENTS.md` | 시스템 프롬프트 / 에이전트 지침 |
| `~/.config/openclineclicode/opencode/{commands,agents,skills}/` | opencode 가 자동 발견하는 슬래시 커맨드/서브에이전트/스킬 (oh-my-clinecli 가 채움) |
| `~/.cline/data/globalState.json` | cline의 LLM endpoint, model 설정 (cline이 관리) |
| `~/.cline/data/secrets.json` | cline의 API key (cline이 관리) |

CLI 가 opencode 를 spawn 할 때 `XDG_CONFIG_HOME=$HOME/.config/openclineclicode` 를 자동 주입하므로
opencode 는 위 경로를 표준 XDG 위치로 인식합니다. 사용자가 `XDG_CONFIG_HOME` 을 직접 export 해
두었다면 그 값이 우선합니다.

## opencode.json 레퍼런스

기본값:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cline": {
      "npm": "@openclineclicode/provider-cline-cli",
      "name": "Cline (cline CLI)",
      "models": {
        "default": {
          "name": "Cline default (auto-detect from cline config)",
          "limit": { "context": 128000, "output": 8192 }
        }
      },
      "options": {
        "mode": "subprocess"
      }
    }
  },
  "model": "cline/default",
  "small_model": "cline/default"
}
```

### `provider.cline.options` 필드

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `mode` | `"subprocess" \| "passthrough"` | `"subprocess"` | passthrough는 미구현 — error throw |
| `command` | `string` | `"cline"` | cline 바이너리 경로 |
| `extraArgs` | `string[]` | `[]` | `--json --yolo --act` 뒤에 추가될 인자 |
| `cwd` | `string` | (opencode가 결정) | cline 의 working directory override |
| `timeoutMs` | `number` | `600000` (10분) | subprocess 타임아웃 |
| `env` | `Record<string,string>` | `{}` | cline 에 주입할 환경변수 |

### 모델 등록

`provider.cline.models` 에 키를 추가하면 opencode 모델 셀렉터에 노출됩니다. 단, **subprocess 모드에서 모델 ID는 라벨일 뿐**이며 실제 호출되는 모델은 cline 자체 설정이 결정합니다.

```json
"models": {
  "default":  { "name": "Auto-detect", "limit": { "context": 128000, "output": 8192 } },
  "custom-model":  { "name": "Custom model", "limit": { "context": 200000, "output": 8192 } },
  "fast":     { "name": "Fast small model",   "limit": { "context": 32000,  "output": 4096 } }
}
```

## 환경변수 / Environment variables

| 변수 | 설명 |
|------|------|
| `OPENCLINECLICODE_CLINE_BIN` | `cline` 바이너리 경로 override (`options.command` 보다 우선) |
| `OPENCLINECLICODE_CONFIG` | `opencode.json` 경로 override (기본 `~/.config/openclineclicode/opencode/opencode.json`) |
| `OPENCODE_CONFIG` | opencode 표준 변수. CLI가 자동으로 위 값을 여기에 매핑 |
| `DEBUG` | `1` 로 설정하면 NDJSON 이벤트가 stderr로 흘러나옴 |

## CLI 플래그 / CLI flags

```
openclineclicode [--config <path>] [--init] [--doctor] [--version] [--help] [...opencode args]
```

| 플래그 | 설명 |
|--------|------|
| `--config <path>` | 다른 `opencode.json` 사용 |
| `--init` | `~/.config/openclineclicode/opencode/opencode.json` 을 (재)생성 |
| `--doctor` | `doctor.sh` 를 실행하고 종료 |
| `--version` | 버전 출력 |
| `--help` | 도움말 출력 |
| 그 외 | 모두 opencode로 그대로 전달 |
