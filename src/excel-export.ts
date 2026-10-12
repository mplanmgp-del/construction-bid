import ExcelJS from 'exceljs';
import type { BidNotice, CompanyProfile } from './types';

const KOREA_OFFSET_MS = 9 * 60 * 60 * 1000;
const HEADERS = ['공고번호', '공고명', '발주기관', '공사 위치', '참가 가능 지역', '계약방법', '추정가격(원)', '제출 마감'];
const COLUMN_WIDTHS = [24, 50, 26, 24, 28, 16, 22, 25];
const GRID: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
};

function koreanWallClock(date: Date): Date {
  return new Date(date.getTime() + KOREA_OFFSET_MS);
}

function deadlineValue(value: string): Date | string {
  // Excel 날짜에는 시간대가 없으므로 UTC 필드에 한국 시각을 담아 저장합니다.
  const qualified = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`;
  const parsed = Date.parse(qualified);
  return Number.isFinite(parsed) ? koreanWallClock(new Date(parsed)) : value;
}

function wrappedLineCount(value: string, width: number): number {
  // 한글은 영문보다 넓으므로 두 글자 너비로 계산하고 셀 여백을 남깁니다.
  return value.split(/\r\n|\r|\n/).reduce((count, line) => {
    const units = Array.from(line).reduce((total, character) => total + (character.codePointAt(0)! > 0xff ? 2 : 1), 0);
    return count + Math.max(1, Math.ceil(units / (width - 2)));
  }, 0);
}

export function buildBidWorkbook(notices: BidNotice[], profile: CompanyProfile, generatedAt: Date, source?: 'live' | 'demo'): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const lastRow = notices.length + 5;
  const sheet = workbook.addWorksheet('입찰공고목록', {
    views: [{ state: 'frozen', ySplit: 5, topLeftCell: 'A6' }],
    pageSetup: {
      orientation: 'landscape', paperSize: 9, fitToPage: true,
      fitToWidth: 1, fitToHeight: 0, printArea: `A1:H${lastRow}`, printTitlesRow: '1:5',
    },
  });
  sheet.columns = COLUMN_WIDTHS.map(width => ({ width }));

  const title = sheet.getCell('A1');
  title.value = '입찰공고목록';
  title.numFmt = '@';
  title.font = { name: '맑은 고딕', size: 14, bold: true };
  sheet.getRow(1).height = 22;

  const createdAt = koreanWallClock(generatedAt).toISOString();
  const timestamp = `${createdAt.slice(0, 10).replaceAll('-', '/')} ${createdAt.slice(11, 16)}`;
  sheet.getCell('A2').value = `업체: ${profile.companyName} (${profile.province} ${profile.district})`;
  const sourceLabel = source === 'live' || (notices.length > 0 && notices.every(notice => notice.source === 'live')) ? '나라장터 공개 데이터' : notices.some(notice => notice.source === 'live') ? '혼합 데이터' : '테스트용 예시 데이터';
  sheet.getCell('A3').value = `생성일: ${timestamp} (한국 시간, 공고 ${notices.length}건, ${sourceLabel})`;
  for (const address of ['A2', 'A3']) {
    const cell = sheet.getCell(address);
    cell.numFmt = '@';
    cell.font = { name: '맑은 고딕', size: 9, color: { argb: 'FF808080' } };
  }
  sheet.getRow(2).height = 16;
  sheet.getRow(3).height = 16;
  sheet.getRow(4).height = 8;

  const header = sheet.getRow(5);
  header.values = HEADERS;
  header.height = 26;
  header.eachCell(cell => {
    cell.numFmt = '@';
    cell.font = { name: '맑은 고딕', size: 9, bold: false };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } };
    cell.border = GRID;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  notices.forEach((bid, index) => {
    const values = [
      bid.number, bid.title, bid.agency, `${bid.province} ${bid.district}`,
      bid.allowedRegions?.join(' · ') || '원문 확인', bid.contractMethod,
      bid.estimatedPrice !== null && Number.isFinite(bid.estimatedPrice) && bid.estimatedPrice >= 0 ? bid.estimatedPrice : '미제공',
      deadlineValue(bid.deadline),
    ];
    const row = sheet.getRow(index + 6);
    row.values = values;
    const lines = Math.max(...values.map((value, column) => typeof value === 'string' ? wrappedLineCount(value, COLUMN_WIDTHS[column]) : 1));
    row.height = Math.max(26, lines * 13 + 12);
    row.eachCell((cell, column) => {
      // 문자열을 직접 넣고 텍스트 형식으로 지정해 앞자리 0과 수식처럼 보이는 원문을 보존합니다.
      cell.numFmt = cell.value instanceof Date ? 'yyyy/mm/dd hh:mm' : typeof cell.value === 'number' ? '#,##0' : '@';
      cell.font = { name: '맑은 고딕', size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      cell.border = GRID;
      cell.alignment = {
        horizontal: column === 2 || column === 3 ? 'left' : column === 7 ? 'right' : 'center',
        vertical: 'middle', wrapText: true,
      };
    });
  });
  sheet.autoFilter = `A5:H${lastRow}`;
  return workbook;
}

export function getExcelFilename(generatedAt: Date): string {
  const koreanTime = koreanWallClock(generatedAt).toISOString();
  return `${koreanTime.slice(0, 10).replaceAll('-', '')}_${koreanTime.slice(11, 16).replace(':', '')}_입찰공고_목록.xlsx`;
}
