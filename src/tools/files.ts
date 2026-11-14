// Turns an attachment into something the AI can use: text for documents, the image itself for pictures.
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { convert as htmlToText } from 'html-to-text';

export type Opened =
  | { kind: 'text'; format: string; text: string; note?: string }
  | { kind: 'image'; mimeType: string; data: Buffer }
  | { kind: 'pages'; format: string; note: string; images: Buffer[] }
  | { kind: 'unsupported'; reason: string };

export const MAX_IMAGE_BYTES = 3_750_000; // about 5 MB once base64-encoded, the usual limit for an image in an AI chat
const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_EXT = /\.(txt|csv|tsv|md|json|xml|ics|vcf|log|ya?ml)$/i;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SCAN_PAGES = 3;

// A scanned PDF has no text: its first pages go back as pictures, so the AI can read them itself.
async function scanPages(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, total: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let n = 1; n <= Math.min(total, SCAN_PAGES); n++) {
    for (const scale of [1.5, 1, 0.6]) {
      const png = Buffer.from(await renderPageAsImage(pdf, n, { canvasImport: () => import('@napi-rs/canvas'), scale }) as Uint8Array);
      if (png.length <= MAX_IMAGE_BYTES) { out.push(png); break; }
    }
  }
  return out;
}

const unxml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Each sheet of an .xlsx as CSV text (values only, no formulas or formatting). shortcut: dates show as Excel serial numbers. */
async function xlsxText(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const read = (p: string) => zip.file(p)?.async('string') ?? Promise.resolve('');
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1]));
  const names = [...(await read('xl/workbook.xml')).matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
  const parts: string[] = [];
  for (const [i, f] of sheets.entries()) {
    const rows: string[] = [];
    for (const r of (await read(f)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = (/r="([A-Z]+)/.exec(c[1])?.[1] ?? '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1];
        const val = /t="s"/.test(c[1]) ? shared[Number(v)] ?? '' : /t="inlineStr"/.test(c[1]) ? unxml(c[2] ?? '') : unxml(v ?? '');
        if (col >= 0) cells[col] = csvCell(val); else cells.push(csvCell(val));
      }
      rows.push(Array.from(cells, (x) => x ?? '').join(','));
    }
    parts.push(`--- Sheet: ${names[i] ?? i + 1} ---\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Senders often label files application/octet-stream, so the file extension decides when the type is vague. */
export async function openFile(contentType: string, filename: string, data: Buffer): Promise<Opened> {
  const type = contentType.toLowerCase();
  const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? '').toLowerCase();
  const image = type.startsWith('image/') ? (Object.values(IMAGES).includes(type) ? type : undefined) : IMAGES[ext];
  if (image) {
    if (data.length > MAX_IMAGE_BYTES) return { kind: 'unsupported', reason: 'This image is too large to show (over 3.75 MB).' };
    return { kind: 'image', mimeType: image, data };
  }
  if (type === 'application/pdf' || ext === 'pdf') {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const body = (text as string[]).map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join('\n\n');
      if (!(text as string[]).some((t) => t.trim())) {
        const images = await scanPages(pdf, totalPages).catch(() => []);
        if (!images.length) return { kind: 'unsupported', reason: `This PDF has ${totalPages} page(s) but no text in it. It is probably a scan or a picture.` };
        return { kind: 'pages', format: `scanned PDF, ${totalPages} page(s)`, images, note: `This PDF is a scan with no text, so its first ${images.length} of ${totalPages} page(s) are shown as images. Read them from the pictures.` };
      }
      return { kind: 'text', format: `PDF, ${totalPages} page(s)`, text: body };
    } catch {
      return { kind: 'unsupported', reason: "This PDF couldn't be read. It may be damaged or password-protected." };
    }
  }
  if (type === DOCX || ext === 'docx') {
    try { return { kind: 'text', format: 'Word document', text: (await mammoth.extractRawText({ buffer: data })).value }; }
    catch { return { kind: 'unsupported', reason: "This Word document couldn't be read." }; }
  }
  if (type === XLSX || ext === 'xlsx') {
    try { return { kind: 'text', format: 'Excel spreadsheet, as CSV', text: await xlsxText(data) }; }
    catch { return { kind: 'unsupported', reason: "This spreadsheet couldn't be read." }; }
  }
  if (type === 'text/html' || ext === 'html' || ext === 'htm') return { kind: 'text', format: 'web page', text: htmlToText(data.toString('utf8'), { wordwrap: false }) };
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || TEXT_EXT.test(filename)) {
    return { kind: 'text', format: type.startsWith('text/') ? type.slice(5) : ext || 'text', text: data.toString('utf8') };
  }
  return { kind: 'unsupported', reason: `This file type (${type}${ext ? `, .${ext}` : ''}) can't be opened. PDFs, Word and Excel files, images and text files can.` };
}
