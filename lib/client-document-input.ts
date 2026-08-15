export const MAX_DOCUMENT_ITEMS = 20;
export const MAX_PDF_PAGES = 20;
export const MAX_DOCUMENT_BYTES = 480_000;
export const MAX_DOCUMENT_EDGE = 1600;

export type PreparedDocumentInput = { name: string; file: File; preview?: string };

export const isHeicDocument = (file: File) => file.type === "image/heic" || file.type === "image/heif" || /\.hei[cf]$/i.test(file.name);
export const isPdfDocument = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

const canvasToFile = (canvas: HTMLCanvasElement, name: string, quality: number) => new Promise<File>((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(new File([blob], name, { type: "image/jpeg" })) : reject(new Error("图片转换失败")), "image/jpeg", quality);
});

export const compressDocumentImage = async (input: File, displayName: string) => {
  let source: Blob = input;
  if (isHeicDocument(input)) {
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({ blob: input, toType: "image/jpeg", quality: 0.88 });
    source = Array.isArray(converted) ? converted[0] : converted;
  }
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_DOCUMENT_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片预处理失败");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.82, 0.7, 0.58, 0.45]) {
    const file = await canvasToFile(canvas, displayName.replace(/\.[^.]+$/, "") + ".jpg", quality);
    if (file.size <= MAX_DOCUMENT_BYTES) return file;
  }
  throw new Error("图片压缩后仍然过大，请裁剪到单页或拍得更近一些");
};

export const documentPdfToImages = async (file: File): Promise<PreparedDocumentInput[]> => {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF 共 ${pdf.numPages} 页；一次最多读取 ${MAX_PDF_PAGES} 页，请拆分后上传。`);
  const pages: PreparedDocumentInput[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PDF 页面转换失败");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const raw = await canvasToFile(canvas, `${file.name.replace(/\.pdf$/i, "")}-第${index}页.jpg`, 0.88);
    const compressed = await compressDocumentImage(raw, raw.name);
    pages.push({ name: `${file.name} · 第${index}页`, file: compressed, preview: URL.createObjectURL(compressed) });
  }
  return pages;
};
