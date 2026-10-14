// Refresh the public administrative locality catalogue. No API key is required.
// Run from the repository root: node scripts/update-region-directory.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://www.data.go.kr/data/3033254/fileData.do';
const output = new URL('../src/data/administrative-regions.json', import.meta.url);

async function read(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public region data returned HTTP ${response.status}`);
  return response;
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(value); value = ''; }
    else if (character === '\n' && !quoted) {
      row.push(value.replace(/\r+$/, ''));
      if (row.some(cell => cell.trim())) rows.push(row);
      row = []; value = '';
    } else value += character;
  }
  if (quoted) throw new Error('Unclosed quoted field in public CSV');
  if (value || row.length) { row.push(value.replace(/\r+$/, '')); rows.push(row); }
  return rows;
}

const page = await (await read(sourceUrl)).text();
// The portal publishes the download location in its Dataset JSON-LD metadata.
const downloadValue = page.match(/"contentUrl"\s*:\s*"(https:\/\/www\.data\.go\.kr\/cmm\/cmm\/fileDownload\.do[^\"]+)"/)?.[1];
if (!downloadValue) throw new Error('Official download URL was not found in the public metadata');
const downloadUrl = downloadValue.replace(/&amp;/g, '&');
const bytes = await (await read(downloadUrl)).arrayBuffer();
const text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
const [header, ...sourceRows] = parseCsv(text);
const required = ['행정기관코드', '기준연월', '시도명', '시군구명', '읍면동명'];
const columns = required.map(name => {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`Missing official column: ${name}`);
  return index;
});
const dates = new Set();
const seen = new Set();
const rows = sourceRows.map(sourceRow => {
  const [code, asOf, province, district, locality] = columns.map(index => sourceRow[index]?.trim() || '');
  if (!/^\d{10}$/.test(code) || !province || !locality || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error('An administrative locality row has an unexpected format');
  }
  if (seen.has(code)) throw new Error(`Duplicate administrative code: ${code}`);
  seen.add(code); dates.add(asOf);
  // Preserve the official empty district for Sejong. UI normalization is separate.
  return [code, province, district, locality];
});
if (rows.length < 3_000 || dates.size !== 1) throw new Error('Official catalogue appears incomplete or mixes reference dates');
const metadata = {
  title: '행정안전부_지역별(행정동) 성별 주민등록 인구증감',
  sourceUrl, downloadUrl, asOf: [...dates][0], sourceEncoding: 'CP949',
  license: '이용허락범위 제한 없음',
  columns: ['행정기관코드', '시도명', '시군구명', '읍면동명'],
  transformation: '공식 CSV에서 행정기관코드와 지역명만 추출. 인구통계 수치는 제외. 원문 시군구 공란과 일반구 명칭 보존.',
};
const json = `${JSON.stringify(metadata, null, 2).slice(0, -2)},\n  "rows": [\n${rows.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
JSON.parse(json);
await mkdir(new URL('../src/data/', import.meta.url), { recursive: true });
await writeFile(output, json, 'utf8');
console.log(`Saved ${rows.length} administrative localities (${metadata.asOf}) to ${fileURLToPath(output)}`);
