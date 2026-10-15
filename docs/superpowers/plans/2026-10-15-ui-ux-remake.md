# UI/UX Remake Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 하나의 검색과 일관된 업무 화면으로 기존 입찰 과업을 간결하게 만든다.
**Architecture:** 기존 검색 엔진/권한/저장을 유지하고 UI 조합과 토큰을 변경한다. 독립 파일 소유권으로 병렬 구현한다.
**Tech Stack:** React 19, TypeScript, Vite, Vitest, CSS, lucide-react.
**Spec:** docs/ui-ux-remake.md

## Global Constraints
- 최신 검색 50건·페이지·누락 안내 및 용량제한 유지.
- 공고번호 결과에 진행/기간/지역 필터를 적용하지 않음.
- 운영배포·권한변경·데이터삭제·새 유료기능 없음.
- 390/768/1440px, 한국어, KST, KRW.
- 주요 텍스트 14px, 보조 12px을 초기값으로 확인.

## Review Focus
- 영어 제목이 번호로 오인되지 않는가.
- 조회 중 메뉴/계정 변경이 이전 결과를 노출하지 않는가.
- 공고명·기간 변경이 지역·면허·금액을 지우지 않는가.
- 취소/제출마감/개찰대기/누락 안내가 정확한가.
- 모바일 긴 제목과 고정 탐색/서랍 포커스가 깨지지 않는가.

## Task 1 Unified search
Files: src/live/UnifiedNoticeSearch.tsx, src/live/unified-notice-search.ts, tests/unified-notice-search.test.tsx.
- [x] 분기·검증 테스트 실패를 먼저 확인.
- [x] 입력 하나와 기존 두 엔진 통합; onResultModeChange(kind) 제공.
- [x] 번호 로그인/날짜 제외/늦은응답/기존 차수결과 보존 검증.
- [x] Root App에 연결.

## Task 2 Workspace and filters
Files: src/App.tsx, src/components/FilterPanel.tsx, src/ui/workspace.css, src/main.tsx.
- [x] 중복 업무·상태 조작 제거, 명시적 초기화, 검색시 조건 유지 검증.
- [x] 공통 탐색 레일/표면/글자/반응형 적용.
- [x] 목록 복귀 맥락과 키보드/모바일 필터 확인.

## Task 3 Notice list and detail
Files: src/components/NoticeList.tsx/.css, src/components/BidDetail.tsx, src/live/NoticeDetailPage.tsx 및 해당 스타일.
- [x] 실제 마감 표시와 취소/개찰대기 보조 설명 테스트.
- [x] 중첩 자격/첨부 탐색 정리와 원문 동작 보존.
- [x] 기존 상세·차수·결과·인쇄 테스트 실행.

## Task 4 Supporting screens
Files: 기능별 CSS 및 src/ui/supporting-workspaces.css.
- [x] 업체·알림·프로필·계정·관리자·인쇄 화면의 공통 토큰/글자/모바일 구조 적용.
- [x] 권한과 데이터 처리는 그대로 사용.

## Task 5 Acceptance and integration
- [x] 전체 Vitest --maxWorkers=4, npm run build, git diff --check.
- [x] 실제 브라우저 390/768/1440px, 검색/번호/오류/필터/상세·계정·알림 확인.
- [x] 코드 검토 및 관찰된 문제 수정, 증거 문서.
- [x] 원래 폴더에 안전하게 통합, 운영배포 없음.
- [x] 자동작업 PAUSED와 결과 안내.
