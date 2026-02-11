# Stack Queue

GitHub Actions + PR comment convention만으로 동작하는 stacked PR merge queue.
Graphite 없이, CLI 설치 없이, 워크플로우 파일 하나로 stacked PR을 관리한다.

## Why

Graphite는 좋은 도구지만 몇 가지 제약이 있다:

- CLI를 모든 개발자 머신에 설치해야 한다
- Graphite 서버에 의존한다 (SaaS)
- 팀 전체가 Graphite workflow에 lock-in된다

**Stack Queue는 GitHub만 있으면 동작한다.** 워크플로우 파일 하나, PR body에 HTML comment 하나. 그게 전부다.

## 핵심 원리

모든 동작은 이 명령 하나로 귀결된다:

```
git rebase --onto <new_base> <old_parent_tip_sha> <child_branch>
```

`old_parent_tip_sha`만 알면 squash / rebase / merge commit 전략에 **무관하게** 동작한다.

```
before (feat-1이 main에 squash merge됨):

main:     A───B───CD'          (C+D가 squash된 새 커밋)
feat-2:       C───D───E───F    (아직 원본 C,D를 포함)

after:
git rebase --onto main <D의SHA> feat-2

main:     A───B───CD'
                    \
feat-2:              E'───F'   (C,D 제거되고 E,F만 리베이스)
```

**왜 SHA를 별도 저장하지 않는가?**
GitHub PR API는 머지 후에도 `head.sha`(머지 전 브랜치 마지막 커밋)를 보존한다.
별도 DB나 파일 없이, API 응답에서 바로 skip SHA를 가져올 수 있다.

## 설계 결정과 그 이유

### 1. PR body의 HTML comment로 메타데이터를 관리한다

```html
<!-- stack-rebase:{"children":[{"branch":"feat-2","pr":2}]} -->
```

**왜 이 방식인가:**
- `.graphite_info` 같은 파일이 필요 없다 → 코드베이스를 오염시키지 않는다
- GitHub API로 읽고 쓸 수 있다 → 별도 저장소가 필요 없다
- HTML comment라 PR 본문에 보이지 않는다 → 리뷰어에게 노이즈가 없다

**왜 PR body인가 (comment가 아니라):**
- body는 PR당 하나 → 메타데이터 위치가 확정적이다
- comment에도 넣을 수 있지만, body를 먼저 탐색한다 (fallback으로 comment도 확인)

### 2. children 배열은 직속 자식(siblings)만 포함한다

```
PR #1 (feat-1 → main):
  children: [{"branch":"feat-2","pr":2}]     ← 직속 자식만

PR #2 (feat-2 → feat-1):
  children: [{"branch":"feat-3","pr":3}]     ← 직속 자식만
```

**왜 모든 후손을 나열하지 않는가:**
- 트리 형태의 스택을 지원하기 위해서다
- 하나의 부모에서 여러 자식이 분기하는 경우, children 배열의 모든 항목은 **siblings**로 취급된다
- 각 sibling은 같은 부모 위에 독립적으로 rebase된다 (체이닝 없음)
- merge-all은 재귀적으로 각 자식의 메타데이터를 탐색하여 DFS 순서로 처리한다

```
트리 구조 예시:

PR #10 (base → main):
  children: [child-a, child-b]    ← 둘 다 base의 직속 자식

      base
     /    \
child-a  child-b     ← siblings, 서로 독립
```

### 3. restack과 merge에서 onto 대상이 다르다

| 상황 | onto 대상 | 이유 |
|------|-----------|------|
| `stack restack` (머지 전) | `origin/<부모 브랜치>` | 부모 브랜치의 새 커밋을 포함해야 함 |
| `stack merge` (머지 후) | `origin/main` | 부모가 이미 main에 머지됨 |
| `stack merge-all` | `origin/main` | 각 PR이 순차적으로 main에 머지됨 |

**초기 설계에서 실수했던 것:**
restack을 항상 `origin/main`으로 했더니, 머지 전 restack에서 부모 브랜치의 커밋이 유실됐다.
부모가 아직 살아있으면 부모 브랜치 위로, 부모가 머지됐으면 main 위로 rebase해야 한다.

### 4. `--force-with-lease`를 사용한다 (`--force`가 아니라)

restack은 필연적으로 force push를 수반한다. 하지만 `--force`는 위험하다:
- 다른 사람이 그 사이에 push한 커밋을 덮어쓸 수 있다

`--force-with-lease`는:
- 로컬이 알고 있는 remote ref와 실제 remote ref가 다르면 push를 거부한다
- "내가 아는 상태에서만 덮어쓰겠다"는 의미다

### 5. merge API 응답 자체를 재시도한다 (별도 check API 폴링 없음)

```
merge-all에서 CI 대기:

GitHub merge API 호출
  ├─ 성공                        → 다음 PR로
  ├─ "required status pending"   → 30초 후 재시도 (최대 20회 ≈ 10분)
  └─ 기타 에러                   → 즉시 중단
```

**왜 checks API를 폴링하지 않는가:**
- check suite name이 repo마다 다르다 → 설정이 필요해진다
- merge API가 이미 "아직 CI 안 끝남" 여부를 에러로 알려준다
- 불필요한 복잡도를 줄인다

### 6. concurrency group으로 직렬화한다

```yaml
concurrency:
  group: stack-queue
  cancel-in-progress: false
```

**왜 직렬화인가:**
- 두 사람이 동시에 `stack merge`를 실행하면 race condition이 발생한다
- force push가 겹치면 커밋이 유실될 수 있다
- `cancel-in-progress: false`로 대기열 방식을 사용한다 (먼저 온 것 우선)

### 7. GitHub App / PAT는 선택사항이다

| 방식 | CI 자동 트리거 | 설정 복잡도 |
|------|---------------|-------------|
| GitHub App | O | 중간 |
| PAT | O | 낮음 |
| 없음 (GITHUB_TOKEN) | X | 없음 |

**왜 기본값이 GITHUB_TOKEN인가:**
- 설정 없이 바로 쓸 수 있어야 한다 → 진입 장벽을 낮춘다
- CI 자동 트리거가 안 되는 건 GitHub 보안 정책이지 Stack Queue의 제약이 아니다
- 필요한 팀만 App/PAT를 설정하면 된다

## Quick Start

1. `.github/workflows/stack-queue.yaml`을 repo에 복사
2. 부모 PR body에 메타데이터 추가
3. PR comment로 커맨드 실행

## Safety

- 동시 실행 방지: `concurrency: stack-queue`로 직렬화
- Force push 보호: `--force-with-lease` 사용
- Conflict 감지: rebase 실패 시 자동 abort + 수동 명령어 제공

## Commands

| Command | 동작 |
|---------|------|
| `stack merge` | 이 PR을 머지하고 자식 브랜치를 restack |
| `stack merge-all` | 스택 전체를 순차 머지 (모든 PR approve 필요) |
| `stack merge-all --force` | 스택 전체를 순차 머지 (approve 체크 생략) |
| `stack restack` | 머지 없이 자식 브랜치만 restack |
| `stack help` | 사용법 표시 |

## 메타데이터 설정

각 PR의 **body**에 직속 자식만 기록한다:

```
일렬 스택 (A → B → C):

PR #1 (A → main):
<!-- stack-rebase:{"children":[{"branch":"B","pr":2}]} -->

PR #2 (B → A):
<!-- stack-rebase:{"children":[{"branch":"C","pr":3}]} -->

PR #3 (C → B):
(메타데이터 불필요)
```

```
트리 스택 (base에서 X, Y가 분기):

PR #10 (base → main):
<!-- stack-rebase:{"children":[
  {"branch":"X","pr":11},
  {"branch":"Y","pr":12}
]} -->

PR #11 (X → base):  (메타데이터 불필요)
PR #12 (Y → base):  (메타데이터 불필요)
```

## Token 설정 (선택)

push 후 CI 자동 트리거가 필요할 때만:

**GitHub App (권장):**
1. https://github.com/settings/apps → New GitHub App
2. Permissions: Contents(Write), Pull requests(Write), Issues(Write)
3. App ID → repo Variables `STACK_APP_ID`
4. Private key → repo Secrets `STACK_APP_PRIVATE_KEY`
5. Install App → 해당 repo에 설치

**PAT:**
- `secrets.STACK_BOT_TOKEN`에 저장

## Graphite와 다른 점

| | Stack Queue | Graphite |
|---|---|---|
| 설치 | 없음 (워크플로우 파일만) | CLI + 계정 |
| 스택 정보 저장 | PR body HTML comment | `.graphite_info` 파일 + 서버 |
| restack 트리거 | PR comment (수동) | `gt restack` CLI (자동 감지) |
| conflict 해결 | 비동기 (Actions 실패 → 로컬 해결 → push) | 동기 (터미널에서 즉시 해결) |
| 트리 구조 | 지원 (siblings 방식) | 지원 (DAG 방식) |
| merge queue | comment 기반 | 전용 UI |

**Stack Queue가 나은 점:**
- 설정이 없다. 파일 하나 복사하면 끝
- GitHub 외 의존성이 없다
- 코드베이스에 메타 파일을 추가하지 않는다

**Graphite가 나은 점:**
- conflict 해결이 동기적이다 (터미널에서 바로)
- 자동 restack (push하면 알아서)
- 전용 UI로 스택 시각화
- `gt log`로 로컬에서 스택 상태 확인 가능

## Troubleshooting

**push 후 CI가 안 돌아요:**
`GITHUB_TOKEN`으로 push하면 다른 workflow가 트리거되지 않는다. GitHub App 또는 PAT를 설정해야 한다.

**merge-all에서 CI timeout:**
기본 대기 ~10분 (30초 x 20회). CI가 오래 걸리면 `tryMerge`의 retry 횟수를 늘린다.

**restack 후 PR diff가 이상해요:**
PR의 base branch가 업데이트되지 않았을 수 있다. `stack restack`이 자동 업데이트하지만, 수동으로 PR settings에서 base를 변경할 수도 있다.
