# 기본 에이전트 지침 / Default agent instructions

이 파일은 openclineclicode가 처음 설치될 때 `~/.config/openclineclicode/AGENTS.md`로 복사됩니다. 자유롭게 수정하세요.

This file ships with openclineclicode and is copied to `~/.config/openclineclicode/AGENTS.md` on first install. Customize freely.

---

## Cline CLI etiquette

- **cline 설정 존중.** LLM 호출은 사용자가 설정한 cline CLI를 통해 처리됩니다. 별도 모델 설정을 추측하지 마세요.
- **민감 정보 보호.** 사용자 코드/문서에서 발견한 키/토큰/이메일을 echo하거나 로그로 남기지 마세요.
- **에이전트 루프가 두 겹입니다.** opencode 에이전트가 cline 에이전트에게 위임합니다. 가능하면 한 번의 명령으로 끝낼 수 있도록 의도를 명확하게 표현하세요. cline 안에서의 추가 도구 호출은 비용이 큽니다.
- **cline CLI 응답 시간 고려.** 응답이 30초 이상 걸릴 수 있습니다. 타임아웃은 `timeoutMs` 옵션으로 조절합니다 (기본 600s).

## 코딩 규칙 / Coding conventions

- 새 파일을 만들 때는 사용자가 이미 사용하는 언어/스타일을 따르세요.
- 테스트 없이 코드를 수정한 경우, 변경한 부분을 짧게 요약해서 알려주세요.
- 한국어 주석/응답을 선호하지만, 식별자와 기술 용어는 영어를 유지하세요.

## 도구 사용 / Tool usage

cline 자체가 강력한 도구 호출 능력을 갖고 있으므로, opencode 단계에서의 도구는 **컨텍스트 수집과 최종 검증** 위주로 활용하세요. 실제 파일 수정/명령 실행은 가능하면 cline에게 위임하는 것이 효율적입니다.
