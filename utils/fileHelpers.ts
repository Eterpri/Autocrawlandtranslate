
import JSZip from 'jszip';
import { FileItem, FileStatus, StoryInfo } from '../types';

const PROXY_LIST = [
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://thingproxy.freeboard.io/fetch/"
];

// Các từ khóa rác phổ biến trong nội dung lậu cần loại bỏ
const JUNK_PHRASES = [
    "重要声明", "本站", "版权归", "All rights reserved", "最新章节", "永久地址", 
    "网友发表", "来自搜索引擎", "本站立场无关", "www.", ".com", ".net", ".org",
    "点击下一页", "继续阅读", "顶点小说", "笔趣阁", "69书吧", "飘天文学"
];

// Các selector phổ biến mà các trang truyện hay dùng để chứa nội dung
const CONTENT_SELECTORS = [
    '#content', '#htmlContent', '#article', '#booktxt', '#chaptercontent', 
    '.content', '.showtxt', '.read-content', '.chapter-content', '.post-content',
    'article', 'main'
];

const NEXT_CHAPTER_KEYWORDS = ["下一章", "下一页", "下一节", "next chapter", "chương sau", "chương tiếp"];

/**
 * Lấy nội dung và link chương tiếp theo từ URL
 */
export const fetchContentFromUrl = async (url: string): Promise<{ title: string, content: string, nextUrl: string | null }> => {
    let lastError = "";
    const cleanUrl = url.trim();
    const urlObj = new URL(cleanUrl);
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
    
    for (const proxyBase of PROXY_LIST) {
        try {
            const finalUrl = `${proxyBase}${encodeURIComponent(cleanUrl)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);

            const response = await fetch(finalUrl, { 
                signal: controller.signal,
                headers: { 'Accept': 'text/html' }
            });
            
            clearTimeout(timeoutId);
            if (!response.ok) continue;

            const buffer = await response.arrayBuffer();
            let tempDecoder = new TextDecoder('utf-8');
            let tempHtml = tempDecoder.decode(buffer);
            
            let finalHtml = tempHtml;
            if (tempHtml.toLowerCase().includes('charset=gbk') || tempHtml.toLowerCase().includes('charset=gb2312')) {
                finalHtml = new TextDecoder('gbk').decode(buffer);
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(finalHtml, 'text/html');

            // 1. Tìm Link chương tiếp theo (Giữ nguyên logic cũ)
            let nextUrl: string | null = null;
            const allLinks = Array.from(doc.querySelectorAll('a'));
            for (const link of allLinks) {
                const text = link.innerText.toLowerCase();
                if (NEXT_CHAPTER_KEYWORDS.some(kw => text.includes(kw))) {
                    const href = link.getAttribute('href');
                    if (href && !href.startsWith('javascript') && href !== '#') {
                        if (href.startsWith('http')) nextUrl = href;
                        else if (href.startsWith('/')) nextUrl = baseUrl + href;
                        else {
                            const currentPath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
                            nextUrl = baseUrl + currentPath + href;
                        }
                        break;
                    }
                }
            }

            // 2. Trích xuất Tiêu đề (Lấy H1 hoặc Title dọn dẹp)
            let title = doc.title?.split('_')[0].split('-')[0].trim() || "Chương mới";
            const h1 = doc.querySelector('h1');
            if (h1 && (h1 as HTMLElement).innerText?.trim().length < 150) {
                title = (h1 as HTMLElement).innerText.trim();
            }

            // 3. Dọn dẹp DOM rác
            const junkElements = ['script', 'style', 'iframe', 'ins', 'aside', 'header', 'footer', 'nav', '.ads', '#ads', '.app-download', '.bottom-link'];
            junkElements.forEach(s => doc.querySelectorAll(s).forEach(el => el.remove()));

            // 4. Tìm container nội dung thông minh
            let target: HTMLElement | null = null;

            // Cách A: Thử qua danh sách Selector ưu tiên
            for (const selector of CONTENT_SELECTORS) {
                const found = doc.querySelector(selector);
                if (found && found.textContent && found.textContent.trim().length > 200) {
                    // Kiểm tra xem có chứa quá nhiều link không (nếu nhiều link thì thường là menu/list)
                    const linkCount = found.querySelectorAll('a').length;
                    if (linkCount < 10) {
                        target = found as HTMLElement;
                        break;
                    }
                }
            }

            // Cách B: Nếu không tìm thấy bằng selector, dùng thuật toán Scoring
            if (!target) {
                const potentialContainers = Array.from(doc.querySelectorAll('div, section'));
                let maxScore = 0;

                potentialContainers.forEach(container => {
                    const htmlEl = container as HTMLElement;
                    const text = htmlEl.innerText?.trim() || "";
                    if (text.length < 150) return;

                    // Điểm cộng cho đoạn văn <p> và xuống dòng <br>
                    const pCount = htmlEl.querySelectorAll('p').length;
                    const brCount = htmlEl.querySelectorAll('br').length;
                    
                    // Điểm cộng cho độ dài text thực tế (trừ đi text của link)
                    let textLength = text.length;
                    htmlEl.querySelectorAll('a').forEach(a => textLength -= a.innerText.length);

                    // Điểm trừ cho văn bản chứa từ khóa rác
                    let penalty = 0;
                    JUNK_PHRASES.forEach(phrase => {
                        if (text.includes(phrase)) penalty += 500;
                    });

                    const score = (textLength * 1) + (pCount * 50) + (brCount * 20) - penalty;
                    
                    if (score > maxScore) {
                        maxScore = score;
                        target = htmlEl;
                    }
                });
            }

            const finalContainer = target || doc.body;
            
            // 5. Làm sạch văn bản trích xuất
            let lines: string[] = [];
            
            // Ưu tiên lấy theo <p> hoặc <br> nếu có cấu trúc rõ ràng
            const paragraphs = finalContainer.querySelectorAll('p');
            if (paragraphs.length > 5) {
                lines = Array.from(paragraphs).map(p => (p as HTMLElement).innerText.trim());
            } else {
                // Tách theo xuống dòng nếu là text thô
                lines = finalContainer.innerText.split('\n').map(l => l.trim());
            }

            // Lọc bỏ các dòng rác cuối cùng (máy in, copyright, trang chủ...)
            let cleanLines = lines.filter(line => {
                if (line.length < 2) return false;
                // Nếu dòng chứa trên 2 từ khóa rác, loại bỏ
                const junkMatchCount = JUNK_PHRASES.filter(phrase => line.includes(phrase)).length;
                return junkMatchCount < 2;
            });

            // Nếu dòng đầu tiên hoặc cuối cùng quá ngắn hoặc chứa từ khóa rác đơn lẻ, bỏ qua
            if (cleanLines.length > 0 && JUNK_PHRASES.some(p => cleanLines[0].includes(p))) cleanLines.shift();
            if (cleanLines.length > 0 && JUNK_PHRASES.some(p => cleanLines[cleanLines.length-1].includes(p))) cleanLines.pop();

            const cleanText = cleanLines.join('\n\n').trim();

            if (cleanText.length < 100) continue;

            return { title, content: cleanText, nextUrl };

        } catch (e: any) {
            lastError = e.message;
        }
    }
    throw new Error(lastError || "Không thể tải nội dung truyện.");
};

export const unzipFiles = async (file: File): Promise<FileItem[]> => {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(file);
  const files: FileItem[] = [];
  const filePaths = Object.keys(loadedZip.files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const relativePath of filePaths) {
    const zipEntry = loadedZip.files[relativePath];
    if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.txt')) {
      const content = await zipEntry.async('string');
      files.push({ id: crypto.randomUUID(), name: zipEntry.name.split('/').pop() || zipEntry.name, content, translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: content.length, remainingRawCharCount: 0 });
    }
  }
  return files;
};

export const parseDocx = async (file: File): Promise<string> => {
    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(file);
    const xmlContent = await loadedZip.file("word/document.xml")?.async("string");
    if (!xmlContent) throw new Error("Invalid DOCX");
    const xmlDoc = new DOMParser().parseFromString(xmlContent, "text/xml");
    const paragraphs = xmlDoc.getElementsByTagName("w:p");
    let fullText = "";
    for (let i = 0; i < paragraphs.length; i++) {
        const texts = paragraphs[i].getElementsByTagName("w:t");
        for (let j = 0; j < texts.length; j++) fullText += texts[j].textContent;
        fullText += "\n";
    }
    return fullText.trim();
};

export const splitContentByRegex = (content: string, customRegex?: string): FileItem[] => {
    const regex = customRegex ? new RegExp(customRegex, 'im') : /(?:^|\n)(?:第[0-9零一二三四五六七八九十百千]+[章話節回].*?|Chapter\s+\d+.*?|Chương\s+\d+.*?|Hồi\s+\d+.*?|^\d+[\.．]\s.*?|^\d+話.*?)(?=\n|$)/im;
    const lines = content.split('\n');
    const files: FileItem[] = [];
    let currentBuffer: string[] = [];
    let currentTitle = "Phần mở đầu";
    for (const line of lines) {
        if (regex.test(line)) {
            if (currentBuffer.length > 0) {
                files.push({ id: crypto.randomUUID(), name: currentTitle.substring(0, 50), content: currentBuffer.join('\n').trim(), translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: currentBuffer.join('\n').length, remainingRawCharCount: 0 });
            }
            currentTitle = line.trim();
            currentBuffer = [line];
        } else currentBuffer.push(line);
    }
    if (currentBuffer.length > 0) {
         files.push({ id: crypto.randomUUID(), name: currentTitle.substring(0, 50), content: currentBuffer.join('\n').trim(), translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: currentBuffer.join('\n').length, remainingRawCharCount: 0 });
    }
    return files;
};

export const splitContentByLength = (content: string, charLimit: number = 6000): FileItem[] => {
    const cleanedContent = content.replace(/\n{3,}/g, '\n\n').trim();
    const files: FileItem[] = [];
    let currentIndex = 0;
    let chapterCount = 1;
    while (currentIndex < cleanedContent.length) {
        let endIndex = Math.min(currentIndex + charLimit, cleanedContent.length);
        const chunkText = cleanedContent.substring(currentIndex, endIndex).trim();
        if (chunkText.length > 0) {
             const title = `Chương ${chapterCount}`;
             files.push({ id: crypto.randomUUID(), name: title, content: `${title}\n\n${chunkText}`, translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: chunkText.length, remainingRawCharCount: 0 });
            chapterCount++;
        }
        currentIndex = endIndex;
    }
    return files;
};

export const parseEpub = async (file: File): Promise<{ files: FileItem[], info: Partial<StoryInfo>, coverBlob: Blob | null }> => {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(file);
  const containerXml = await loadedZip.file("META-INF/container.xml")?.async("string");
  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml!, "text/xml");
  const opfPath = containerDoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
  const opfContent = await loadedZip.file(opfPath!)?.async("string");
  const opfDoc = parser.parseFromString(opfContent!, "text/xml");
  const metadataTitle = opfDoc.getElementsByTagName("dc:title")[0]?.textContent || "";
  const metadataAuthor = opfDoc.getElementsByTagName("dc:creator")[0]?.textContent || "";
  const spineItems = opfDoc.getElementsByTagName("itemref");
  const manifestItems = opfDoc.getElementsByTagName("item");
  const manifest: Record<string, string> = {};
  for (let i = 0; i < manifestItems.length; i++) {
    const id = manifestItems[i].getAttribute("id");
    const href = manifestItems[i].getAttribute("href");
    if (id && href) manifest[id] = href;
  }
  const files: FileItem[] = [];
  let chapterIndex = 1;
  const opfDir = opfPath!.substring(0, opfPath!.lastIndexOf('/'));
  for (let i = 0; i < spineItems.length; i++) {
    const idref = spineItems[i].getAttribute("idref");
    const fullPath = opfDir ? `${opfDir}/${manifest[idref!]}` : manifest[idref!];
    const fileContent = await loadedZip.file(fullPath)?.async("string");
    if (!fileContent) continue;
    const htmlDoc = parser.parseFromString(fileContent, "text/html");
    let rawText = htmlDoc.body ? (htmlDoc.body as HTMLElement).innerText : "";
    if (rawText.trim().length < 50) continue;
    files.push({ id: crypto.randomUUID(), name: `Chương ${chapterIndex++}`, content: rawText.trim(), translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: rawText.length, remainingRawCharCount: 0 });
  }
  return { files, info: { title: metadataTitle, author: metadataAuthor }, coverBlob: null };
};

export const createMergedFile = (files: FileItem[]): string => {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .filter((f) => f.status === FileStatus.COMPLETED && f.translatedContent)
    .map((f) => f.translatedContent?.trim()) 
    .join('\n\n'); 
};

export const downloadRawAsZip = async (files: FileItem[], filename: string) => {
    const zip = new JSZip();
    [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .forEach(f => zip.file(`${f.name}.txt`, f.content));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.zip`;
    a.click();
};

export const downloadTextFile = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
};

export const downloadJsonFile = (filename: string, data: any) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
};

export const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsText(file);
  });
};

export const generateEpub = async (files: FileItem[], storyInfo: StoryInfo, coverImage: File | null): Promise<Blob> => {
  const zip = new JSZip();
  const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).filter(f => f.status === FileStatus.COMPLETED);
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.folder("META-INF")?.file("container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const oebps = zip.folder("OEBPS");
  oebps?.file("Styles/style.css", `body { font-family: serif; line-height: 1.5; padding: 1em; } h2 { text-align: center; } p { text-indent: 1.5em; margin: 0.5em 0; }`);
  let manifest = ""; let spine = "";
  sortedFiles.forEach((f, i) => {
    const id = `ch${i}`;
    const html = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${f.name}</title><link href="../Styles/style.css" rel="stylesheet" type="text/css"/></head><body><h2>${f.name}</h2>${(f.translatedContent || "").split('\n').map(l => `<p>${l}</p>`).join('')}</body></html>`;
    oebps?.file(`Text/${id}.xhtml`, html);
    manifest += `<item id="${id}" href="Text/${id}.xhtml" media-type="application/xhtml+xml"/>\n`;
    spine += `<itemref idref="${id}"/>\n`;
  });
  oebps?.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${storyInfo.title}</dc:title><dc:creator>${storyInfo.author}</dc:creator><dc:language>vi</dc:language><dc:identifier id="id">uuid</dc:identifier></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`);
  return await zip.generateAsync({ type: "blob" });
};
