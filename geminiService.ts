
import { GoogleGenAI } from '@google/genai';
import { quotaManager } from './utils/quotaManager';
import { MODEL_CONFIGS, GLOSSARY_ANALYSIS_PROMPT } from './constants';
import { StoryInfo, FileItem } from './utils/types';

const CHUNK_SIZE_LIMIT = 4000; // Tăng lên một chút để giảm số lần gọi API
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Khởi tạo client AI. 
 * Ưu tiên Key từ localStorage (người dùng nhập), nếu không có dùng process.env.API_KEY.
 */
const getAiClient = () => {
  const customKey = localStorage.getItem('CUSTOM_GEMINI_API_KEY') || localStorage.getItem('gemini_api_key');
  const apiKey = (customKey && customKey.trim() !== '') ? customKey.trim() : process.env.API_KEY;
  
  if (!apiKey) {
    throw new Error("Chưa cấu hình API Key. Vui lòng vào phần Cài đặt để thiết lập.");
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

const cleanupTranslatedText = (text: string, originalChapterName: string): string => {
    if (!text) return "";
    let lines = text.split('\n').map(l => l.trim()).filter(l => l !== "");
    const JUNK_PATTERNS = [/đang đọc tại/i, /69shuba/i, /piaotian/i, /www\./i, /\.com/i];
    lines = lines.filter(line => !JUNK_PATTERNS.some(p => p.test(line)));
    return lines.join('\n\n').trim();
};

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export const translateBatch = async (
    files: { id: string, content: string, name: string }[],
    userPrompt: string,
    dictionary: string,
    globalContext: string,
    allowedModelIds: string[]
): Promise<{ results: Map<string, string>, model: string }> => {
    const ai = getAiClient();
    const finalResults = new Map<string, string>();
    let lastUsedModel = "";

    const systemInstruction = `BẠN LÀ CHUYÊN GIA DỊCH THUẬT VĂN HỌC TRUNG-VIỆT.
NHIỆM VỤ: Dịch đầy đủ nội dung, giữ nguyên phong cách, áp dụng từ điển. 
KHÔNG Tóm tắt, KHÔNG bỏ sót.`;

    for (const file of files) {
        const paragraphs = file.content.split('\n').filter(p => p.trim());
        let translatedFullContent = "";
        const relevantDictionary = optimizeDictionary(dictionary, file.content);

        // Chia nhỏ chương thành các phần để dịch (tránh timeout/limit)
        let currentChunk = "";
        const chunks: string[] = [];
        for (const p of paragraphs) {
            if ((currentChunk.length + p.length) > CHUNK_SIZE_LIMIT) {
                chunks.push(currentChunk);
                currentChunk = p;
            } else {
                currentChunk += (currentChunk ? "\n" : "") + p;
            }
        }
        if (currentChunk) chunks.push(currentChunk);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const fullPrompt = `[DICTIONARY]\n${relevantDictionary}\n\n[CONTEXT]\n${globalContext}\n\n[PROMPT]\n${userPrompt}\n\n[CONTENT]\n${chunk}`;
            
            let success = false;
            let errorMsg = "";

            // Thử lần lượt các Model được phép
            for (const modelId of allowedModelIds) {
                if (!quotaManager.isModelAvailable(modelId)) continue;

                for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
                    try {
                        const response = await ai.models.generateContent({
                            model: modelId,
                            contents: fullPrompt,
                            config: { systemInstruction, temperature: 0.1 }
                        });

                        const output = response.text;
                        if (!output) throw new Error("AI trả về nội dung trống.");

                        translatedFullContent += (translatedFullContent ? "\n\n" : "") + output.trim();
                        lastUsedModel = modelId;
                        quotaManager.recordRequest(modelId);
                        success = true;
                        break;
                    } catch (error: any) {
                        const status = error.status || 0;
                        errorMsg = error.message || "Lỗi không xác định";
                        
                        if (status === 429 || errorMsg.includes("429") || errorMsg.includes("quota")) {
                            quotaManager.recordRateLimit(modelId);
                            // Nếu lỗi 429, đợi lâu hơn một chút rồi thử lại hoặc đổi model
                            await delay(2000 * attempt);
                            continue; 
                        }
                        
                        console.error(`Lỗi Model ${modelId} (Lần ${attempt}):`, errorMsg);
                        if (attempt === MAX_RETRY_ATTEMPTS) break;
                    }
                }
                if (success) break;
            }

            if (!success) {
                throw new Error(`Chương "${file.name}" thất bại: ${errorMsg}`);
            }
            // Nghỉ ngắn giữa các chunk để tránh hit RPM limit quá nhanh
            await delay(500);
        }
        
        finalResults.set(file.id, cleanupTranslatedText(translatedFullContent, file.name));
    }

    return { results: finalResults, model: lastUsedModel };
};

export const analyzeStoryContext = async (
    chapters: FileItem[],
    storyInfo: StoryInfo
): Promise<string> => {
    const ai = getAiClient();
    const sampleText = chapters.slice(0, 2).map(c => c.content.substring(0, 2000)).join('\n\n');
    const modelId = 'gemini-3-flash-preview';

    try {
        const response = await ai.models.generateContent({
            model: modelId,
            contents: `${GLOSSARY_ANALYSIS_PROMPT}\n\nTRUYỆN: ${storyInfo.title}\nNỘI DUNG:\n${sampleText}`,
            config: { temperature: 0.2 }
        });
        return response.text || "";
    } catch (e) {
        return "Không thể phân tích bối cảnh tự động.";
    }
};
