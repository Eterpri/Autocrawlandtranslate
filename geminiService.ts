
import { GoogleGenAI } from '@google/genai';
import { quotaManager } from './utils/quotaManager';
import { MODEL_CONFIGS, GLOSSARY_ANALYSIS_PROMPT } from './constants';
import { StoryInfo, FileItem } from './utils/types';

const CHUNK_SIZE_LIMIT = 3500; 

const getAiClient = (apiKey: string) => {
  if (!apiKey || apiKey.length < 30) {
    throw new Error("Gemini API Key không hợp lệ. Vui lòng kiểm tra lại.");
  }
  return new GoogleGenAI({ apiKey });
};

const optimizeDictionary = (dictionary: string, content: string): string => {
  if (!content || !dictionary) return '';
  const lines = dictionary.split('\n');
  const uniqueMap = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue; 
    const key = trimmed.substring(0, eqIndex).trim();
    if (key) uniqueMap.set(key, trimmed);
  }
  const usedLines: string[] = [];
  for (const [key, line] of uniqueMap.entries()) {
      if (content.includes(key)) usedLines.push(line);
  }
  return usedLines.join('\n');
};

/**
 * Lọc rác thông minh đa lớp:
 * 1. Lọc AI chatter (Vâng, đây là bản dịch...)
 * 2. Lọc quảng cáo web (Regex patterns)
 * 3. Lọc dòng rác kỹ thuật (Link, số chương lặp lại)
 * 4. Kiểm soát mật độ tiếng Trung sót lại
 */
const cleanupTranslatedText = (text: string, originalChapterName: string): string => {
    if (!text) return "";
    
    let lines = text.split('\n').map(l => l.trim()).filter(l => l !== "");
    
    // Mẫu AI chatter thường gặp
    const AI_INTRO_OUTRO = [
        /^vâng/i, /^đây là/i, /^bản dịch/i, /^tôi đã/i, /^dưới đây là/i, 
        /^chào/i, /^tất nhiên/i, /^chắc chắn/i, /^hy vọng/i, /^phần tiếp theo/i,
        /\[\[\[.*?\]\]\]/g, /###/g, /===/g, /---/g
    ];

    // Mẫu rác quảng cáo & tech rác từ các web Trung (mạnh mẽ hơn)
    const JUNK_PATTERNS = [
        /đang đọc tại/i, /truyenfull/i, /metruyen/i, /sstruyen/i, /tangthuvien/i,
        /chúc bạn đọc truyện vui vẻ/i, /bản dịch thuộc về/i, /nguồn:/i,
        /tác giả:/i, /người dịch:/i, /biên tập:/i, /vui lòng không/i,
        /mọi người nhớ ủng hộ/i, /nhấn thích/i, /đánh giá/i, /bấm vào đây/i,
        /tải xuống/i, /69shuba/i, /piaotian/i, /uukanshu/i, /biquge/i, /69shu/i,
        /www\./i, /\.com/i, /\.net/i, /\.org/i, /\.vn/i, /https?:\/\//i,
        /69 thư ba/i, /bí thư các/i, /đỉnh điểm tiểu thuyết/i, /bi tâm các/i
    ];

    lines = lines.filter((line, idx) => {
        const lower = line.toLowerCase();
        
        // 1. Loại bỏ AI Intro ở 2 dòng đầu hoặc 2 dòng cuối
        if ((idx < 2 || idx > lines.length - 3) && AI_INTRO_OUTRO.some(p => p.test(line))) return false;
        
        // 2. Lọc quảng cáo
        if (JUNK_PATTERNS.some(p => p.test(line))) return false;
        
        // 3. Lọc dòng quá ngắn chứa ký tự web rác
        if (line.length < 60 && (lower.includes('shuba') || lower.includes('69') || lower.includes('html'))) return false;

        // 4. Kiểm tra tỷ lệ tiếng Trung (Nếu > 15% là chữ Hán -> chưa dịch xong)
        const chineseChars = line.match(/[\u4e00-\u9fa5]/g);
        if (chineseChars && chineseChars.length > line.length * 0.15) {
            // Trừ khi dòng này cực ngắn và là tên riêng (nhưng thường tên riêng cũng nên dịch)
            if (line.length > 10) return false;
        }

        // 5. Loại bỏ các dòng lặp lại tên chương (Raw) nếu AI lỡ để lại
        if (originalChapterName && lower.includes(originalChapterName.toLowerCase()) && line.length < originalChapterName.length + 10) {
            // Nếu là dòng đầu tiên thì CÓ THỂ là tiêu đề đã dịch, nên ta kiểm tra xem nó còn tiếng Trung không
            if (idx === 0 && !/[\u4e00-\u9fa5]/.test(line)) return true;
            return false;
        }

        return true;
    });

    return lines.join('\n\n').trim();
};

const handleErrorQuota = (error: any, modelId: string) => {
    const msg = (error.message || error.toString()).toLowerCase();
    if (msg.includes('quota') || msg.includes('exhausted')) {
        quotaManager.markAsDepleted(modelId);
    } else if (error.status === 429 || msg.includes('429')) {
        quotaManager.recordRateLimit(modelId);
    }
};

const selectModel = (allowedModelIds: string[]) => {
  const currentConfigs = quotaManager.getConfigs();
  const priorityTier = ['gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-flash-latest'];
  const available = currentConfigs
    .filter(c => allowedModelIds.includes(c.id) && quotaManager.isModelAvailable(c.id))
    .sort((a, b) => {
        const aIndex = priorityTier.indexOf(a.id);
        const bIndex = priorityTier.indexOf(b.id);
        const aPrio = aIndex === -1 ? Infinity : aIndex;
        const bPrio = bIndex === -1 ? Infinity : bIndex;
        if (aPrio !== bPrio) return aPrio - bPrio;
        return a.priority - b.priority;
    });
  return available.map(m => m.id);
}

const splitIntoChunks = (text: string, limit: number): string[] => {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split('\n');
  let currentChunk = "";

  for (const p of paragraphs) {
    if ((currentChunk.length + p.length + 1) > limit && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = p;
    } else {
      currentChunk += (currentChunk ? "\n" : "") + p;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
};

export const translateBatch = async (
    files: { id: string, content: string, name: string }[],
    userPrompt: string,
    dictionary: string,
    globalContext: string,
    allowedModelIds: string[],
    apiKey: string
): Promise<{ results: Map<string, string>, model: string }> => {
    const ai = getAiClient(apiKey);
    const finalResults = new Map<string, string>();
    let lastUsedModel = "";

    const systemInstruction = `BẠN LÀ CHUYÊN GIA DỊCH THUẬT VĂN HỌC TRUNG-VIỆT LÃO LUYỆN.
NHIỆM VỤ: Dịch đầy đủ 100% nội dung, KHÔNG TÓM TẮT, KHÔNG BỎ SÓT DÒNG.

QUY TẮC BẮT BUỘC:
1. TIÊU ĐỀ: Dịch tiêu đề chương mượt mà ở DÒNG ĐẦU TIÊN (VD: Chương 122: Sức mạnh kinh người).
2. NỘI DUNG: Dịch sát nghĩa, thuần Việt, mượt mà. Áp dụng bảng từ điển nghiêm ngặt.
3. KHÔNG TẠP CHẤT: Tuyệt đối không để lại tiếng Trung, không thêm lời bình AI, không giữ lại quảng cáo web.
4. CẤU TRÚC: Giữ nguyên các đoạn văn.
5. KIỂM SOÁT: Nếu nội dung có dấu hiệu rác web, hãy lọc bỏ khi dịch.`;

    for (const file of files) {
        const chunks = splitIntoChunks(file.content, CHUNK_SIZE_LIMIT);
        let translatedFullContent = "";
        const relevantDictionary = optimizeDictionary(dictionary, file.content);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isFirst = i === 0;
            const chunkMeta = chunks.length > 1 ? `\n(Đây là phần ${i + 1}/${chunks.length} của chương "${file.name}")` : "";

            const fullPrompt = `[DICTIONARY]\n${relevantDictionary}\n\n[CONTEXT]\n${globalContext}\n\n[REQUIREMENTS]\n${userPrompt}${chunkMeta}\n${isFirst ? "Dịch tiêu đề ở dòng 1." : "Tiếp tục mạch văn của phần trước."}\n\n[RAW_CONTENT]\n${chunk}`;

            const attempts = selectModel(allowedModelIds);
            let chunkSuccess = false;

            for (const modelId of attempts) {
                try {
                    const response = await ai.models.generateContent({
                        model: modelId,
                        contents: fullPrompt,
                        config: {
                            systemInstruction,
                            temperature: 0.0,
                        },
                    });

                    const output = response.text || "";
                    
                    // Kiểm soát chất lượng nhanh: Nếu output chứa quá nhiều tiếng Trung (>30%) -> AI "lười" dịch
                    const chineseMatches = output.match(/[\u4e00-\u9fa5]/g);
                    if (chineseMatches && chineseMatches.length > output.length * 0.3) {
                         console.warn(`Model ${modelId} trả về quá nhiều tiếng Trung, thử lại...`);
                         continue;
                    }

                    translatedFullContent += (translatedFullContent ? "\n\n" : "") + output.trim();
                    lastUsedModel = modelId;
                    quotaManager.recordRequest(modelId);
                    chunkSuccess = true;
                    break; 
                } catch (error: any) {
                    handleErrorQuota(error, modelId);
                }
            }
            if (!chunkSuccess) throw new Error(`Không thể dịch chương ${file.name} sau nhiều lần thử.`);
        }
        
        const finalCleaned = cleanupTranslatedText(translatedFullContent, file.name);
        finalResults.set(file.id, finalCleaned);
    }

    return { results: finalResults, model: lastUsedModel };
};

/**
 * Phân tích các chương truyện để tạo hồ sơ bối cảnh và từ điển tự động
 */
export const analyzeStoryContext = async (
    chapters: FileItem[],
    storyInfo: StoryInfo,
    apiKey: string
): Promise<string> => {
    const ai = getAiClient(apiKey);
    
    // Lấy mẫu nội dung từ 3 chương đầu (mỗi chương 3000 ký tự đầu)
    const sampleText = chapters
        .slice(0, 3)
        .map(c => `--- ${c.name} ---\n${c.content.substring(0, 3000)}`)
        .join('\n\n');

    const prompt = `${GLOSSARY_ANALYSIS_PROMPT}

**THÔNG TIN TRUYỆN:**
- Tên: ${storyInfo.title}
- Thể loại: ${storyInfo.genres.join(', ')}
- Tác giả: ${storyInfo.author}

**NỘI DUNG MẪU:**
${sampleText}`;

    const modelId = 'gemini-3-flash-preview';

    try {
        const response = await ai.models.generateContent({
            model: modelId,
            contents: prompt,
            config: { temperature: 0.2 },
        });

        if (!response.text) return "";
        quotaManager.recordRequest(modelId);
        return response.text.trim();
    } catch (error: any) {
        handleErrorQuota(error, modelId);
        throw error;
    }
};
