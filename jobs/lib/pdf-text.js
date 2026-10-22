// Node-only: positioned text items per page from a PDF (pdfjs-dist).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfTextItems(bytes) {
  const doc = await getDocument({ data: bytes, verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.filter(it => it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], str: it.str })));
  }
  await doc.destroy();
  return pages;
}
