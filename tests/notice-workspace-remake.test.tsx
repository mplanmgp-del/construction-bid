import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoticeList } from '../src/components/NoticeList';
import { BidDetail } from '../src/components/BidDetail';
import { DEMO_PROFILES, NOTICES } from '../src/data';
import type { BidNotice } from '../src/types';

const now = Date.parse('2026-10-15T10:30:00+09:00');
const bid: BidNotice = { ...NOTICES[0], source: 'live', status: '접수중',
  title: '제출 일정을 확인할 철거공사', number: 'R26BK01359594', revision: '002',
  deadline: '2026-10-15T01:00:00Z', openingAt: '2026-10-15T02:00:00Z',
  biddingStartAt: '2026-10-10T10:00:00+09:00', demandAgency: '테스트 수요기관' };
const renderList = (notice: BidNotice) => renderToStaticMarkup(<NoticeList bids={[notice]} now={now}
  keyword="" profile={DEMO_PROFILES[0]} bookmarks={[]} selected={[]}
  onSelect={() => {}} onOpen={() => {}} onBookmark={() => {}} fetchPublicResults={false} />);
const renderDetail = (notice: BidNotice) => renderToStaticMarkup(<BidDetail bid={notice} now={now}
  profile={DEMO_PROFILES[0]} assessment={{ status: 'review', reason: '지역조건 확인 필요' }}
  isBookmarked={false} onClose={() => {}} onToggleBookmark={() => {}} />);

describe('deadline-first notice workspace', () => {
  it('shows the exact submission deadline in Korean time with its year', () => {
    const html = renderList(bid);
    expect(html).toContain('제출 마감');
    expect(html).toContain('한국시간');
    expect(html).toContain('2026.10.15 10:00');
    expect(html).toMatch(/datetime="2026-10-15T01:00:00Z"/i);
  });

  it('makes submission closure visible while the schedule status still says in progress', () => {
    const html = renderList(bid);
    expect(html).toContain('>진행중</span>');
    expect(html).toContain('제출 마감 · 개찰 대기');
    expect(renderDetail(bid)).toContain('제출 마감 · 개찰 대기');
  });

  it('identifies cancelled notices even though the shared status filter leaves them unclassified', () => {
    const cancelled = { ...bid, status: '취소' as const, noticeKind: '취소공고' };
    expect(renderList(cancelled)).toContain('>취소된 공고</');
    expect(renderDetail(cancelled)).toContain('>취소된 공고</');
  });

  it('does not invent a deadline when none was provided', () => {
    const html = renderList({ ...bid, deadline: '' });
    expect(html).toContain('제출 마감일 확인 필요');
    expect(html).not.toMatch(/datetime=""/i);
    expect(html).not.toContain('Invalid Date');
  });

  it('keeps public results reachable without replacing deadline space with unloaded company columns', () => {
    const html = renderList(bid);
    expect(html).toContain('notice-detail.html?number=R26BK01359594&amp;revision=002&amp;type=%EA%B3%B5%EC%82%AC#results');
    expect(html).toContain('개찰·낙찰 결과');
    expect(html).not.toContain('<th class="nl-company">');
    expect(html).not.toContain('공개 결과 조회 중');
  });

  it('offers one notice task plus separate public-results and preparation tasks in live detail', () => {
    const html = renderDetail(bid);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('>공고</button>');
    expect(html).toContain('>공개 결과</button>');
    expect(html).toContain('>투찰 준비</button>');
    expect(html).not.toMatch(/role="tab"[^>]*>참가조건/);
    expect(html).not.toMatch(/role="tab"[^>]*>첨부서류/);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it('keeps known qualifications and original attachments reachable before full detail is available', () => {
    const html = renderDetail({ ...bid, licenses: ['구조물해체·비계공사업'],
      requirements: ['현장설명 참가등록 필요'], documents: [
        { name: '공고문.pdf', size: '100KB', url: 'https://www.g2b.go.kr/file/notice.pdf' },
        { name: '별도 확인 서류', size: '', url: 'javascript:alert(1)' },
      ] });
    expect(html).toContain('현재 확인된 참가조건·첨부');
    expect(html).toContain('구조물해체·비계공사업');
    expect(html).toContain('현장설명 참가등록 필요');
    expect(html).toContain('href="https://www.g2b.go.kr/file/notice.pdf"');
    expect(html).toContain('공고문.pdf');
    expect(html).toContain('별도 확인 서류');
    expect(html).not.toContain('href="javascript:');
  });

  it('keeps sample qualification and attachment actions available in demo detail', () => {
    const html = renderDetail({ ...bid, source: 'demo' });
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('>참가조건</button>');
    expect(html).toContain('>첨부서류<span>');
    expect(html).toContain('화면 시안 · 예시 공고입니다.');
  });
});
