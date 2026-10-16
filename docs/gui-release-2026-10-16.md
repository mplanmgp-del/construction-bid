# GUI 복구 운영 배포 · 2026-10-16 KST

- 사용자 요청: 복구한 프로젝트의 운영 배포.
- 운영 URL: https://construction-bid-nine.vercel.app/
- 대상: mplanmgp-2490 / construction-bid (`prj_BoPg3tmZOslLbTn20nZPwe2soOzH`).
- 배포 소스: `5bd5e98` (GUI 복구). 이 문서 자체는 배포 뒤 작성한 기록이다.
- 이전 운영 배포: `dpl_8dyqChDmWxL8NB5ypDzJDY63FsUf`.
- 새 운영 배포: `dpl_H3PoCP9ufsPBQj7rGbbVrEtMp7k2`.
- 고유 URL: https://construction-hoqrxanyb-mplanmgp-2490.vercel.app/

## 배포와 검증
- 직전 전체 테스트 110개 파일·1,214개 통과. Vercel의 타입 검사·Vite 빌드와 12개 API 함수 변환 완료, READY 확인.
- 운영 환경으로 먼저 빌드하고 새 배포 화면을 확인한 뒤 promote했다. 운영 URL을 다시 inspect하여 새 배포 ID로 연결됐음을 확인했다.
- 운영 배포 전에는 공유 CSS 뒤에 구형 main CSS가 로드됐다. 배포 후 메인·독립 상세 모두 `application-DwoPzJVc.css` 하나를 사용하며 로컬 검증 산출물과 일치한다.
- 실제 운영 브라우저 1440×900: 고정 탐색 레일, 본문 왼쪽 여백 216px, 필터 overflow auto, 실제 검색 결과 표시 확인.
- 운영 결과에서 상세를 열고 공고/공개결과/투찰준비 탭과 닫기 버튼을 확인했다. 닫은 뒤 원래 공고 제목으로 포커스가 복원됐다.
- 실제 운영 브라우저 390×844: 필터 내부 333px 스크롤, 배경 위치 유지, 하단 버튼 노출, 결과 보기 후 배경 스크롤·열기 버튼 포커스 복원 확인.
- 운영 독립 상세의 실제 공고에서 63px 헤더, 화면 안의 하단 원문/목록 버튼, 문서 가로 넘침 없음(문서/사용 가능 폭 모두 375px) 확인.
- 배포 후 오류 로그 조회: 2026-10-16 11:16:28~11:26:28 KST, 새 배포 production `level:error` 결과 0건. 이 조회 구간의 결과이며 이후 무오류를 보장하는 표현으로 사용하지 않는다.
- 증거: `outputs/gui-release-20261016/`의 운영 배포 전후 PC, 모바일 필터, 독립 상세 JPEG.

## 보존 범위와 한계
- 운영 DB 마이그레이션, 권한·환경변수 변경, 회원 데이터 쓰기·삭제, 테스트 푸시 발송을 하지 않았다.
- `.vercelignore`의 환경파일·로컬 산출물·사용자 이미지 제외를 유지했다. Git 원격 push는 하지 않았으며 Vercel CLI로 배포했다.
- 실제 휴대폰 터치, 스크린리더, 실제 인쇄, 모든 회원별 저장 동작은 이번 운영 배포 검증 범위 밖이다. 해당 컴포넌트의 로컬 검증은 `gui-recovery-2026-10-16.md`와 구분한다.
