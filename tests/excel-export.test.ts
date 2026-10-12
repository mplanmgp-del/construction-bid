import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildBidWorkbook, getExcelFilename } from '../src/excel-export';
import type { BidNotice, CompanyProfile } from '../src/types';

const company: CompanyProfile = {
  id: 'seoul', companyName: '예시철거', province: '서울특별시', district: '마포구',
  address: '서울특별시 마포구 월드컵로 00', licenses: ['구조물해체·비계공사업'],
  contactName: '예시 담당자', email: 'demo@example.com',
};

const generatedAt = new Date('2026-10-12T05:04:00Z');
const notice = (patch: Partial<BidNotice> = {}): BidNotice => ({
  id: 'base', number: 'D202610120001', revision: '00', title: '별관 철거공사',
  agency: '예시시청', type: '공사', category: '철거·해체', province: '경기도',
  district: '고양시', allowedRegions: ['서울', '경기'], estimatedPrice: 109_090_909,
  contractMethod: '제한경쟁', status: '접수중', postedAt: '2026-10-08T09:00:00+09:00',
  deadline: '2026-10-20T14:00:00+09:00', openingAt: '2026-10-20T15:00:00+09:00',
  registrationDeadline: '2026-10-19T18:00:00+09:00', licenses: ['구조물해체·비계공사업'],
  duration: '착공일로부터 30일', description: '예시 자료', requirements: [],
  documents: [], revised: false, ...patch,
});

describe('입찰공고 Excel 내보내기', () => {
  it('원본 양식의 제목·메타정보·회색 머리글과 인쇄 가능한 표를 만든다', () => {
    const workbook = buildBidWorkbook([notice()], company, generatedAt);
    expect(workbook.worksheets).toHaveLength(1);
    const sheet = workbook.worksheets[0];
    expect(sheet.getCell('A1').value).toBe('입찰공고목록');
    expect(sheet.getCell('A1').font).toMatchObject({ name: '맑은 고딕', size: 14, bold: true });
    expect(sheet.getCell('A2').value).toEqual(expect.stringContaining('예시철거'));
    expect(sheet.getCell('A2').value).toEqual(expect.stringContaining('서울특별시 마포구'));
    expect(sheet.getCell('A3').value).toEqual(expect.stringContaining('2026/10/12 14:04'));
    expect(sheet.getCell('A3').value).toEqual(expect.stringContaining('1건'));
    expect(sheet.getCell('A3').value).toEqual(expect.stringContaining('예시'));
    expect(sheet.getCell('A2').font).toMatchObject({ size: 9, color: { argb: 'FF808080' } });
    expect(sheet.getCell('A3').font).toMatchObject({ size: 9, color: { argb: 'FF808080' } });
    expect(sheet.getRow(4).actualCellCount).toBe(0);
    expect(sheet.getRow(5).values).toEqual([
      undefined, '공고번호', '공고명', '발주기관', '공사 위치', '참가 가능 지역', '계약방법', '추정가격(원)', '제출 마감',
    ]);
    for (let column = 1; column <= 8; column += 1) {
      const header = sheet.getRow(5).getCell(column);
      expect(header.font).toMatchObject({ name: '맑은 고딕', size: 9, bold: false });
      expect(header.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } });
      expect(header.alignment).toMatchObject({ horizontal: 'center', vertical: 'middle', wrapText: true });
      expect(header.border).toMatchObject({
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } },
      });
    }
    expect(sheet.columns.map(column => column.width)).toEqual([24, 50, 26, 24, 28, 16, 22, 25]);
    expect(sheet.autoFilter).toBe('A5:H6');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });
    expect(sheet.pageSetup).toMatchObject({
      orientation: 'landscape', paperSize: 9, fitToPage: true,
      fitToWidth: 1, fitToHeight: 0, printArea: 'A1:H6', printTitlesRow: '1:5',
    });
    expect(sheet.model.merges).toEqual([]);
  });

  it('화면 한 페이지의 8건을 넘어 전달된 모든 공고를 순서대로 저장한다', () => {
    const notices = Array.from({ length: 13 }, (_, index) => notice({
      id: `bid-${index}`, number: `000${index}`, title: `공고 ${index}`,
    }));
    const before = structuredClone(notices);
    const sheet = buildBidWorkbook(notices, company, generatedAt).worksheets[0];
    expect(sheet.rowCount).toBe(18);
    expect(Array.from({ length: 13 }, (_, index) => sheet.getCell(`A${index + 6}`).value))
      .toEqual(['0000', '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '00010', '00011', '00012']);
    expect(sheet.getRow(6).values).toEqual([
      undefined, '0000', '공고 0', '예시시청', '경기도 고양시', '서울 · 경기', '제한경쟁',
      109_090_909, new Date('2026-10-20T14:00:00Z'),
    ]);
    expect(sheet.autoFilter).toBe('A5:H18');
    expect(sheet.pageSetup.printArea).toBe('A1:H18');
    expect(sheet.getCell('A3').value).toEqual(expect.stringContaining('13건'));
    expect(notices).toEqual(before);
  });

  it('추정가격을 계산 가능한 원 단위 숫자로 보존하고 미제공과 0원을 구별한다', () => {
    const sheet = buildBidWorkbook([
      notice(), notice({ estimatedPrice: null }), notice({ estimatedPrice: 0 }),
    ], company, generatedAt).worksheets[0];
    expect(sheet.getCell('G6').value).toBe(109_090_909);
    expect(sheet.getCell('G6').numFmt).toBe('#,##0');
    expect(sheet.getCell('G6').alignment.horizontal).toBe('right');
    expect(sheet.getCell('G7').value).toBe('미제공');
    expect(sheet.getCell('G8').value).toBe(0);
    expect(sheet.getCell('G8').numFmt).toBe('#,##0');
  });

  it.each([
    ['한국 시간대', '2026-10-20T14:00:00+09:00'],
    ['UTC 시간대', '2026-10-20T05:00:00Z'],
    ['시간대 없는 입력', '2026-10-20T14:00:00'],
  ])('%s 마감은 엑셀에 한국 시각 14:00으로 표시할 날짜값이 된다', (_, deadline) => {
    const sheet = buildBidWorkbook([notice({ deadline })], company, generatedAt).worksheets[0];
    expect(sheet.getCell('H6').value).toEqual(new Date('2026-10-20T14:00:00Z'));
    expect(sheet.getCell('H6').numFmt).toBe('yyyy/mm/dd hh:mm');
  });

  it('본문 격자와 정렬을 유지하며 긴 공고명·기관·지역에 충분한 행 높이를 준다', () => {
    const sheet = buildBidWorkbook([
      notice(),
      notice({ title: '지역 공공시설 철거사업 '.repeat(12), agency: '공공사업 담당기관 '.repeat(8), allowedRegions: ['서울특별시 마포구', '경기도 고양시', '경기도 파주시', '부산광역시 강서구'] }),
    ], company, generatedAt).worksheets[0];
    expect(sheet.getRow(6).height).toBeGreaterThanOrEqual(26);
    expect(sheet.getRow(7).height).toBeGreaterThanOrEqual(90);
    for (let column = 1; column <= 8; column += 1) {
      const body = sheet.getRow(6).getCell(column);
      expect(body.font).toMatchObject({ name: '맑은 고딕', size: 9 });
      expect(body.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } });
      expect(body.alignment).toMatchObject({ vertical: 'middle', wrapText: true });
      expect(body.border.top?.style).toBe('thin');
      expect(body.border.bottom?.style).toBe('thin');
      expect(body.border.left?.style).toBe('thin');
      expect(body.border.right?.style).toBe('thin');
    }
    expect(sheet.getCell('B6').alignment.horizontal).toBe('left');
    expect(sheet.getCell('C6').alignment.horizontal).toBe('left');
    for (const column of ['A', 'D', 'E', 'F', 'H']) {
      expect(sheet.getCell(`${column}6`).alignment.horizontal).toBe('center');
    }
  });

  it('XLSX 저장·재로드 후에도 원문 문자열·숫자·날짜·표 설정을 보존한다', async () => {
    const workbook = buildBidWorkbook([
      notice({ number: '0000123', title: '=1+1', agency: '+공공기관', allowedRegions: ['@서울'] }),
      notice({ number: '@공고', title: '+공고명', agency: '=기관', estimatedPrice: null, allowedRegions: null }),
      notice({ number: '=0005', estimatedPrice: 0 }),
    ], company, generatedAt);
    const saved = await workbook.xlsx.writeBuffer();
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(saved);
    const sheet = loaded.worksheets[0];
    expect(loaded.worksheets).toHaveLength(1);
    expect(sheet.getCell('A6').value).toBe('0000123');
    expect(sheet.getCell('B6').value).toBe('=1+1');
    expect(sheet.getCell('C6').value).toBe('+공공기관');
    expect(sheet.getCell('E6').value).toBe('@서울');
    expect(sheet.getCell('A7').value).toBe('@공고');
    expect(sheet.getCell('B7').value).toBe('+공고명');
    expect(sheet.getCell('C7').value).toBe('=기관');
    expect(sheet.getCell('E7').value).toBe('원문 확인');
    expect(sheet.getCell('A8').value).toBe('=0005');
    expect(sheet.getCell('G6').value).toBe(109_090_909);
    expect(sheet.getCell('G7').value).toBe('미제공');
    expect(sheet.getCell('G8').value).toBe(0);
    expect(sheet.getCell('H6').value).toEqual(new Date('2026-10-20T14:00:00Z'));
    expect(sheet.getCell('H6').numFmt).toBe('yyyy/mm/dd hh:mm');
    for (const address of ['A6', 'B6', 'C6', 'E6', 'A7', 'B7', 'C7', 'A8']) {
      expect(sheet.getCell(address).numFmt).toBe('@');
      expect(sheet.getCell(address).type).toBe(ExcelJS.ValueType.String);
    }
    sheet.eachRow(row => row.eachCell(cell => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
    expect(sheet.autoFilter).toBe('A5:H8');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });
    expect(sheet.pageSetup.printArea).toBe('A1:H8');
    expect(sheet.pageSetup.printTitlesRow).toBe('1:5');
    expect(sheet.getCell('B5').fill).toMatchObject({ fgColor: { argb: 'FFC0C0C0' } });
    expect(sheet.getCell('B6').border.bottom?.style).toBe('thin');
  });

  it('공고가 없어도 머리글과 0건 안내를 가진 유효한 엑셀을 만든다', () => {
    const sheet = buildBidWorkbook([], company, generatedAt).worksheets[0];
    expect(sheet.rowCount).toBe(5);
    expect(sheet.getCell('A3').value).toEqual(expect.stringContaining('0건'));
    expect(sheet.autoFilter).toBe('A5:H5');
    expect(sheet.pageSetup.printArea).toBe('A1:H5');
  });
});

describe('Excel 다운로드 파일명', () => {
  it('한국 시간의 날짜와 시각을 사용한다', () => {
    expect(getExcelFilename(generatedAt)).toBe('20261012_1404_입찰공고_목록.xlsx');
    expect(getExcelFilename(new Date('2026-10-12T15:30:00Z'))).toBe('20261013_0030_입찰공고_목록.xlsx');
  });
});
