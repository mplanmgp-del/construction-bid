import { jsPDF } from 'jspdf'
import { autoTable, type CellDef, type RowInput, type UserOptions } from 'jspdf-autotable'
import type { NoticePrintDocument } from './notice-print-model'

const FONT = 'NanumGothic'
const MARGIN = 14
const WIDTH = 210 - MARGIN * 2
const BOTTOM = 18
const FONT_FILES = ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf'] as const

export interface NoticePdfFonts {
  regular: Uint8Array
  bold: Uint8Array
}

let fontsPromise: Promise<NoticePdfFonts> | undefined

async function fetchFont(filename: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}fonts/${filename}`, {
      signal: controller.signal,
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error('font-response')
    const bytes = new Uint8Array(await response.arrayBuffer())
    // A missing static file may return the SPA HTML with a successful status.
    if (bytes.length < 12 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) {
      throw new Error('font-format')
    }
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

function loadFonts(): Promise<NoticePdfFonts> {
  fontsPromise ??= Promise.all(FONT_FILES.map(fetchFont))
    .then(([regular, bold]) => ({ regular, bold }))
    .catch(() => {
      fontsPromise = undefined
      throw new Error('PDF 한글 글꼴을 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.')
    })
  return fontsPromise
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
  }
  return btoa(chunks.join(''))
}

function text(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function labelCell(label: string): CellDef {
  return {
    content: text(label),
    styles: { fontStyle: 'bold', fillColor: [244, 247, 251], textColor: [65, 77, 94] },
  }
}

function valueCell(value: string, colSpan = 1): CellDef {
  return { content: text(value), colSpan }
}

function fieldRows(fields: NoticePrintDocument['summary']): RowInput[] {
  const rows: RowInput[] = []
  let pending: (typeof fields)[number] | undefined
  const flush = () => {
    if (pending) rows.push([labelCell(pending.label), valueCell(pending.value, 3)])
    pending = undefined
  }
  for (const field of fields) {
    // A long value gets the full remaining row width instead of shrinking its font.
    if (field.value.length > 38 || field.value.includes('\n')) {
      flush()
      rows.push([labelCell(field.label), valueCell(field.value, 3)])
    } else if (pending) {
      rows.push([labelCell(pending.label), valueCell(pending.value), labelCell(field.label), valueCell(field.value)])
      pending = undefined
    } else {
      pending = field
    }
  }
  flush()
  return rows
}

function validateSize(document: NoticePrintDocument): void {
  const fields = [...document.summary, ...document.sections.flatMap(section => section.fields)]
  const characterCount = document.title.length + document.number.length
    + fields.reduce((sum, field) => sum + field.label.length + field.value.length, 0)
    + document.sections.reduce((sum, section) => sum + section.title.length, 0)
    + document.documents.reduce((sum, name) => sum + name.length, 0)
  // Fail explicitly rather than silently truncating an unexpectedly large response.
  if (fields.length > 2000 || document.documents.length > 500 || characterCount > 500_000) {
    throw new Error('공고 정보가 너무 많아 PDF를 만들지 못했습니다. 공고 원문에서 확인해 주세요.')
  }
}

/** Uses only the filtered print model; no DOM, account information or network data is included. */
export function buildNoticePdf(document: NoticePrintDocument, fonts: NoticePdfFonts): Blob {
  validateSize(document)
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true })
  pdf.addFileToVFS(FONT_FILES[0], base64(fonts.regular))
  pdf.addFont(FONT_FILES[0], FONT, 'normal')
  pdf.addFileToVFS(FONT_FILES[1], base64(fonts.bold))
  pdf.addFont(FONT_FILES[1], FONT, 'bold')
  pdf.setFont(FONT, 'normal')
  pdf.setProperties({ title: text(document.title), subject: `입찰공고 ${text(document.number)}`, creator: '공사입찰 검색' })
  pdf.setLanguage('ko-KR')

  let y = MARGIN
  const common: UserOptions = {
    theme: 'grid',
    margin: { top: MARGIN, right: MARGIN, bottom: BOTTOM, left: MARGIN },
    tableWidth: WIDTH,
    styles: {
      font: FONT,
      fontStyle: 'normal',
      fontSize: 9.3,
      textColor: [29, 40, 56],
      lineColor: [218, 225, 234],
      lineWidth: 0.15,
      cellPadding: { top: 1.8, right: 2.5, bottom: 1.8, left: 2.5 },
      valign: 'middle',
      overflow: 'linebreak',
    },
    headStyles: {
      font: FONT,
      fontStyle: 'bold',
      fontSize: 10.2,
      fillColor: [229, 237, 248],
      textColor: [31, 64, 111],
      cellPadding: { top: 2.3, right: 2.5, bottom: 2.3, left: 2.5 },
    },
    rowPageBreak: 'avoid',
    pageBreak: 'auto',
    showHead: 'everyPage',
    willDrawPage: data => {
      if (data.pageNumber !== 1 || !data.cursor || !data.table.head.length || !data.table.body.length) return
      const headingHeight = data.table.head.reduce((sum, row) => sum + row.height, 0)
      const pageHeight = pdf.internal.pageSize.getHeight()
      const usableHeight = pageHeight - MARGIN - BOTTOM
      const firstRowHeight = data.table.body[0].height
      // AutoTable can move a tall first row after drawing its heading. Move both
      // together before drawing; rows taller than a page still split normally.
      const requiredHeight = headingHeight + (firstRowHeight + headingHeight > usableHeight ? 20 : firstRowHeight)
      if (data.cursor.y > MARGIN && data.cursor.y + requiredHeight > pageHeight - BOTTOM) {
        pdf.addPage()
        data.cursor.y = MARGIN
      }
    },
  }

  const table = (options: UserOptions) => {
    autoTable(pdf, {
      ...common,
      startY: y,
      ...options,
      didDrawPage: data => { y = data.cursor?.y ?? MARGIN },
    })
    y += 4
  }

  // A table also wraps exceptionally long notice titles safely over page boundaries.
  table({
    theme: 'plain',
    showHead: 'never',
    styles: { ...common.styles, cellPadding: 0, lineWidth: 0 },
    body: [
      [{ content: '입찰 공고 상세', styles: { fontSize: 9, fontStyle: 'bold', textColor: [65, 94, 139], cellPadding: { bottom: 3 } } }],
      [{ content: text(document.title), styles: { fontSize: 18, fontStyle: 'bold', cellPadding: { bottom: 3 } } }],
      [{ content: `공고번호  ${text(document.number)}`, styles: { fontSize: 9, textColor: [89, 102, 120], cellPadding: { bottom: 2 } } }],
    ],
  })

  if (document.summary.length) {
    table({
      body: document.summary.map(field => [labelCell(field.label), {
        content: text(field.value),
        styles: field.label === '추정가격'
          ? { fontSize: 13, fontStyle: 'bold', textColor: [31, 64, 111], cellPadding: 3 }
          : {},
      }]),
      columnStyles: { 0: { cellWidth: 34 }, 1: { cellWidth: WIDTH - 34 } },
    })
  }

  for (const section of document.sections) {
    if (!section.fields.length) continue
    table({
      head: [[{ content: text(section.title), colSpan: 4 }]],
      body: fieldRows(section.fields),
      columnStyles: { 0: { cellWidth: 29 }, 1: { cellWidth: WIDTH / 2 - 29 }, 2: { cellWidth: 29 }, 3: { cellWidth: WIDTH / 2 - 29 } },
    })
  }

  if (document.documents.length) {
    table({
      head: [[{ content: '첨부서류', colSpan: 2 }]],
      body: document.documents.map((name, index) => [String(index + 1), text(name)]),
      columnStyles: { 0: { cellWidth: 10, halign: 'center', textColor: [89, 102, 120] }, 1: { cellWidth: WIDTH - 10 } },
    })
  }

  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page++) {
    pdf.setPage(page)
    pdf.setFont(FONT, 'normal')
    pdf.setFontSize(8)
    pdf.setTextColor(112, 123, 139)
    pdf.text(`${page} / ${pageCount}`, 105, 287, { align: 'center' })
  }
  return pdf.output('blob')
}

/** Font assets are served by this application; the document never leaves the browser. */
export async function createNoticePdf(document: NoticePrintDocument): Promise<Blob> {
  validateSize(document)
  return buildNoticePdf(document, await loadFonts())
}
