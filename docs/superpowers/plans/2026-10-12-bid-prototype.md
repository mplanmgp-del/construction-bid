# 입찰공고 디자인 프로토타입 Implementation Plan

> **For agentic workers:** Use independent implementer tasks for domain and supporting views; coordinate integration and verify the complete browser flow.

**Goal:** GUI v4를 클릭해서 사용할 수 있는 로컬 디자인 테스트 시스템으로 만든다.

**Architecture:** React가 예시 공고와 업체별 상태를 표시한다. 지역판정 및 추정가격 검색은 UI와 분리하고, 브라우저 저장은 회원별로 구분한다.

**Tech Stack:** React, TypeScript, Vite, Vitest, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-12-bid-prototype-design.md`

## Global Constraints

- 목록/필터/정렬 금액은 추정가격. 누락은 미제공.
- 지역조건 일치는 전체 참가자격과 구분한다.
- 공개 배포나 실제 API/인증 연동 없이 로컬 예시 데이터로 체험한다.
- 기존 outputs 시안 파일을 보존한다.

## Review Focus

- 업체 전환 때 다른 업체의 관심공고가 섞이지 않는다.
- 지역 누락을 전국으로 판단하지 않는다.
- 가격 누락을 0원으로 정렬/범위 검색하지 않는다.
- 화면 크기를 바꿔도 필터와 상세패널을 닫거나 조작할 수 있다.
- 필터 변경/초기화로 현재 페이지가 비어 있으면 첫 페이지로 이동한다.

## Tasks

1. [x] 예시 데이터·지역판정·검색: `src/data.ts`, `src/domain.ts`, `tests/domain.test.ts`. 지역 및 금액 경계 조건 실패 테스트를 먼저 확인하고 구현한다.
2. [x] 업체정보 및 상세보기: `src/components/ProfileView.tsx`, `src/components/BidDetail.tsx`, `src/components/SupportingViews.css`. 공유 타입을 사용하며 키보드와 실제 예시 다운로드를 지원한다.
3. [x] 검색화면·반응형 CSS·회원별 저장: `src/App.tsx`, `src/styles.css`, `src/storage.ts`, `tests/storage.test.ts`. 카테고리/필터/정렬/관심공고/페이지 이동을 연결한다.
4. [x] 통합검증: typecheck, domain/storage tests, build, HTTP title 확인 및 브라우저 사용자 흐름 테스트. 독립 코드리뷰 후 발견한 결함을 수정한다.

## Execution decision

사용자는 이 디자인안으로 테스트 시스템의 개발을 직접 요청했다. 별도 단계별 승인 요청 없이 그 범위 안에서 구현한다. 빈 저장소이므로 현재 폴더에서 `codex/bid-design-prototype` 브랜치를 사용한다.

