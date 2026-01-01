
import JSZip from 'jszip';
import { FileItem, FileStatus, StoryInfo } from './types';

const PROXY_LIST = [
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://thingproxy.freeboard.io/fetch/"
];

const JUNK_PHRASES = [
    "重要声明", "本站", "版权归", "All rights reserved", "最新章节", "永久地址", 
    "网友发表", "来自搜索引擎", "本站立场无关", "www.", ".com", ".net", ".org",
    "点击下一页", "继续阅读", "顶点小说", "笔趣阁", "69书吧", "飘天文学", "shubao", "paoshu"
];

const CONTENT_SELECTORS = [
    '#content', '#htmlContent', '#article', '#booktxt', '#chaptercontent', '#chapterContent', 
    '.content', '.showtxt', '.read-content', '.chapter-content', '.post-content', '.txtnav',
    'article', 'main', '.entry-content'
];

const NEXT_CHAPTER_KEYWORDS = [
    "下一章", "下一页", "下一节", "next chapter", "chương sau", "chương tiếp", "下一页",
    ">", "next", "下—章"
];

/**
 * Chuyển đổi tiêu đề chương thô (Trung/Anh) sang Tiếng Việt chuẩn
 */
export const translateChapterTitle = (title: string): string => {
  let clean = title.trim();
  // Xử lý mẫu: 第1章, 第123章
  clean = clean.replace(/第\s*(\d+)\s*[章話节回]/g, 'Chương $1');
  // Xử lý mẫu: Chapter 1
  clean = clean.replace(/Chapter\s*(\d+)/gi, 'Chương $1');
  // Xử lý số Hán Việt cơ bản
  const hanVietMap: Record<string, string> = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
  clean = clean.replace(/第\s*([一二三四五六七八九十]+)\s*[章話节回]/g, (match, p1) => {
    return `Chương ${hanVietMap[p1] || p1}`;
  });
  return clean;
};

const resolveUrl = (base: string, relative: string) => {
    try {
        return new URL(relative, base).href;
    } catch (e) {
        return relative;
    }
};

export const fetchContentFromUrl = async (url: string): Promise<{ title: string, content: string, nextUrl: string | null }> => {
    let lastError = "";
    const cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http')) throw new Error("Link không hợp lệ. Phải bắt đầu bằng http/https.");

    const urlObj = new URL(cleanUrl);
    
    // Thử lần lượt qua các proxy
    for (const proxyBase of PROXY_LIST) {
        try {
            const finalUrl = `${proxyBase}${encodeURIComponent(cleanUrl)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // Tăng timeout lên 15s

            const response = await fetch(finalUrl, { 
                signal: controller.signal,
                headers: { 'Accept': 'text/html' }
            });
            
            clearTimeout(timeoutId);
            if (!response.ok) {
                lastError = `Proxy trả về lỗi: ${response.status}`;
                continue;
            }

            const buffer = await response.arrayBuffer();
            let tempDecoder = new TextDecoder('utf-8');
            let tempHtml = tempDecoder.decode(buffer);
            
            // Tự động nhận diện charset cho các web Trung Quốc cũ
            if (tempHtml.toLowerCase().includes('charset=gbk') || tempHtml.toLowerCase().includes('charset=gb2312')) {
                tempHtml = new TextDecoder('gbk').decode(buffer);
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(tempHtml, 'text/html');

            // Tìm link chương tiếp theo
            let nextUrl: string | null = null;
            const allLinks = Array.from(doc.querySelectorAll('a'));
            for (const link of allLinks) {
                const text = (link.innerText || link.textContent || "").toLowerCase().trim();
                if (NEXT_CHAPTER_KEYWORDS.some(kw => text === kw || (text.includes(kw) && text.length < 15))) {
                    const href = link.getAttribute('href');
                    if (href && !href.startsWith('javascript') && href !== '#' && !href.includes('login')) {
                        nextUrl = resolveUrl(cleanUrl, href);
                        break;
                    }
                }
            }

            // Tìm tiêu đề
            let rawTitle = doc.title?.split('_')[0].split('-')[0].trim() || "Chương mới";
            const h1 = doc.querySelector('h1');
            if (h1 && (h1 as HTMLElement).innerText?.trim().length < 150) {
                rawTitle = (h1 as HTMLElement).innerText.trim();
            }
            const title = translateChapterTitle(rawTitle);

            // Dọn dẹp rác
            const junkElements = ['script', 'style', 'iframe', 'ins', 'aside', 'header', 'footer', 'nav', '.ads', '#ads', '.app-download', '.bottom-link', '.read-notice'];
            junkElements.forEach(s => doc.querySelectorAll(s).forEach(el => el.remove()));

            // Tìm nội dung chương bằng selector phổ biến
            let target: HTMLElement | null = null;
            for (const selector of CONTENT_SELECTORS) {
                const found = doc.querySelector(selector);
                if (found && found.textContent && found.textContent.trim().length > 300) {
                    const linkCount = found.querySelectorAll('a').length;
                    // Chống bắt nhầm menu link
                    if (linkCount < 15) {
                        target = found as HTMLElement;
                        break;
                    }
                }
            }

            // Nếu không tìm thấy bằng selector, dùng thuật toán tính điểm nội dung
            if (!target) {
                const potentialContainers = Array.from(doc.querySelectorAll('div, section, article'));
                let maxScore = 0;
                potentialContainers.forEach(container => {
                    const htmlEl = container as HTMLElement;
                    const text = htmlEl.innerText?.trim() || "";
                    if (text.length < 200) return;
                    
                    const pCount = htmlEl.querySelectorAll('p').length;
                    const brCount = htmlEl.querySelectorAll('br').length;
                    let textLength = text.length;
                    
                    // Giảm điểm nếu chứa quá nhiều link (khả năng cao là menu)
                    const aTags = htmlEl.querySelectorAll('a');
                    aTags.forEach(a => textLength -= a.innerText.length);
                    
                    let penalty = aTags.length * 10;
                    JUNK_PHRASES.forEach(phrase => { if (text.includes(phrase)) penalty += 100; });
                    
                    const score = (textLength * 1) + (pCount * 50) + (brCount * 25) - penalty;
                    if (score > maxScore) { 
                        maxScore = score; 
                        target = htmlEl; 
                    }
                });
            }

            const finalContainer = target || doc.body;
            let lines: string[] = [];
            const paragraphs = finalContainer.querySelectorAll('p');
            
            if (paragraphs.length > 5) {
                lines = Array.from(paragraphs).map(p => (p as HTMLElement).innerText.trim());
            } else {
                // Xử lý trang dùng thẻ <br> thay vì <p>
                const htmlContent = finalContainer.innerHTML
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>/gi, '\n');
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = htmlContent;
                lines = tempDiv.innerText.split('\n').map(l => l.trim());
            }

            let cleanLines = lines.filter(line => {
                if (line.length < 2) return false;
                const junkMatchCount = JUNK_PHRASES.filter(phrase => line.toLowerCase().includes(phrase.toLowerCase())).length;
                return junkMatchCount < 1; // Khắt khe hơn để dọn sạch rác
            });

            const cleanText = cleanLines.join('\n\n').trim();
            if (cleanText.length < 150) {
                lastError = "Nội dung bóc tách quá ngắn, có thể sai khu vực.";
                continue;
            }

            return { title, content: cleanText, nextUrl };
        } catch (e: any) {
            lastError = `Lỗi hệ thống: ${e.message}`;
        }
    }
    throw new Error(lastError || "Không thể tải nội dung truyện. Web nguồn có thể đang chặn robot hoặc proxy quá tải.");
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
      files.push({ id: crypto.randomUUID(), name: translateChapterTitle(zipEntry.name.split('/').pop() || zipEntry.name), content, translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: content.length, remainingRawCharCount: 0 });
    }
  }
  return files;
};

export const createMergedFile = (files: FileItem[]): string => {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .filter((f) => f.status === FileStatus.COMPLETED && f.translatedContent)
    .map((f) => `### ${f.name}\n\n${f.translatedContent?.trim()}`) 
    .join('\n\n'); 
};

export const downloadTextFile = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
};

export const generateEpub = async (files: FileItem[], storyInfo: StoryInfo): Promise<Blob> => {
  const zip = new JSZip();
  const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).filter(f => f.status === FileStatus.COMPLETED);
  
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.folder("META-INF")?.file("container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  
  const oebps = zip.folder("OEBPS");
  oebps?.file("Styles/style.css", `body { font-family: serif; line-height: 1.6; padding: 5%; color: #111; } h2 { text-align: center; margin-bottom: 2em; border-bottom: 1px solid #eee; padding-bottom: 0.5em; } p { text-indent: 1.5em; margin: 0.8em 0; text-align: justify; }`);
  
  let manifest = ""; 
  let spine = "";
  let navItems = "";

  sortedFiles.forEach((f, i) => {
    const id = `ch${i + 1}`;
    const fileName = `${id}.xhtml`;
    const chapterTitle = f.name;
    
    const htmlContent = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${chapterTitle}</title>
  <link href="../Styles/style.css" rel="stylesheet" type="text/css"/>
</head>
<body>
  <section epub:type="chapter">
    <h2>${chapterTitle}</h2>
    ${(f.translatedContent || "").split('\n').filter(l => l.trim()).map(l => `<p>${l.trim()}</p>`).join('\n')}
  </section>
</body>
</html>`;

    oebps?.file(`Text/${fileName}`, htmlContent);
    manifest += `<item id="${id}" href="Text/${fileName}" media-type="application/xhtml+xml"/>\n`;
    spine += `<itemref idref="${id}"/>\n`;
    navItems += `<li><a href="Text/${fileName}">${chapterTitle}</a></li>\n`;
  });

  const navHtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Mục lục</title>
  <style>nav ol { list-style-type: none; padding-left: 0; } nav li { margin: 0.5em 0; } a { text-decoration: none; color: #333; }</style>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Mục lục</h1>
    <ol>
      ${navItems}
    </ol>
  </nav>
</body>
</html>`;
  oebps?.file("nav.xhtml", navHtml);

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">uuid-${crypto.randomUUID()}</dc:identifier>
    <dc:title>${storyInfo.title}</dc:title>
    <dc:creator>${storyInfo.author || 'Vô danh'}</dc:creator>
    <dc:language>vi</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="Styles/style.css" media-type="text/css"/>
    ${manifest}
  </manifest>
  <spine>
    <itemref idref="nav"/>
    ${spine}
  </spine>
</package>`;

  oebps?.file("content.opf", opf);

  return await zip.generateAsync({ type: "blob" });
};
