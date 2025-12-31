
import { GoogleGenAI } from '@google/genai';
import { quotaManager } from './utils/quotaManager';
import { MODEL_CONFIGS, GLOSSARY_ANALYSIS_PROMPT } from './constants';
import { StoryInfo, FileItem } from './types';

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("Không tìm thấy API Key. Vui lòng kiểm tra biến môi trường.");
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
  const priorityTier = ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
  const available = currentConfigs
    .filter(c => allowedModelIds.includes(c.id) && quotaManager.isModelAvailable(c.id))
    .sort((a, b) => priorityTier.indexOf(a.id) - priorityTier.indexOf(b.id));

  return available.map(m => m.id);
}

export const analyzeStoryContext = async (files: FileItem[], storyInfo: StoryInfo): Promise<string> => {
    const ai = getAiClient();
    const modelsToTry = ['gemini-3-pro-preview', 'gemini-3-flash-preview'];
    let contextContent = files.slice(0, 5).map(f => f.content).join('\n').substring(0, 50000);
    const userPrompt = `Phân tích cốt truyện và lập từ điển nhân vật từ nội dung sau:\n${contextContent}`;

    for (const modelId of modelsToTry) {
        if (!quotaManager.isModelAvailable(modelId)) continue;
        try {
            const response = await ai.models.generateContent({
                model: modelId,
                contents: userPrompt,
                config: {
                    systemInstruction: GLOSSARY_ANALYSIS_PROMPT,
                    temperature: 0.2,
                    thinkingConfig: { thinkingBudget: 8192 }
                },
            });
            if (response.text) {
                quotaManager.recordRequest(modelId);
                return response.text.trim();
            }
        } catch (error: any) {
            handleErrorQuota(error, modelId);
        }
    }
    return "Không thể phân tích ngữ cảnh.";
};

export const translateBatch = async (
    files: { id: string, content: string }[],
    userPrompt: string,
    dictionary: string,
    globalContext: string,
    allowedModelIds: string[]
): Promise<{ results: Map<string, string>, model: string }> => {
    const ai = getAiClient();
    const combinedContent = files.map(f => f.content).join('\n');
    const relevantDictionary = optimizeDictionary(dictionary, combinedContent);

    let inputContent = "";
    for (const file of files) {
        inputContent += `\n[[[FILE_ID: ${file.id}]]]\n${file.content}\n[[[FILE_END: ${file.id}]]]\n`;
    }

    const systemInstruction = `BẠN LÀ CHUYÊN GIA BIÊN TẬP VÀ DỊCH THUẬT TRUNG-VIỆT CAO CẤP.
NHIỆM VỤ: Dịch nội dung được cung cấp sang tiếng Việt mượt mà, văn phong tiểu thuyết, thuần Việt 100%.

QUY TẮC CỨNG:
1. TUYỆT ĐỐI KHÔNG TRẢ VỀ TIẾNG TRUNG. Mọi từ ngữ phải được dịch hoặc để Hán Việt.
2. KHÔNG LẶP LẠI NGUYÊN VĂN NỘI DUNG GỐC (Hán Việt thô/Tiếng Trung). Nếu model trả về tiếng Trung, đó là thất bại hoàn toàn.
3. KHÔNG THÊM lời dẫn, lời chào, hay nhận xét cá nhân.
4. GIỮ NGUYÊN TAGS: [[[FILE_ID: ID]]] và [[[FILE_END: ID]]] để hệ thống tách file.
5. SỬ DỤNG TỪ ĐIỂN ĐỂ NHẤT QUÁN TÊN RIÊNG.
6. Loại bỏ hoàn toàn các dòng rác (link web, quảng cáo lậu) nếu chúng vô tình lọt vào nội dung gốc.`;

    const fullPrompt = `[DICTIONARY]\n${relevantDictionary}\n\n[STORY_CONTEXT]\n${globalContext}\n\n[USER_REQUIREMENTS]\n${userPrompt}\n\n[CONTENT_TO_TRANSLATE]\n${inputContent}`;

    const attempts = selectModel(allowedModelIds);
    for (const modelId of attempts) {
        try {
            const isGemini3 = modelId.includes('gemini-3');
            const response = await ai.models.generateContent({
                model: modelId,
                contents: fullPrompt,
                config: {
                    systemInstruction,
                    temperature: 0.2,
                    maxOutputTokens: 60000,
                    ...(isGemini3 ? { thinkingConfig: { thinkingBudget: 12000 } } : {})
                },
            });

            if (!response.text) continue;
            
            const results = new Map<string, string>();
            for (const file of files) {
                const regex = new RegExp(`\\[\\[\\[FILE_ID:\\s*${file.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]\\]([\\s\\S]*?)\\[\\[\\[FILE_END:\\s*${file.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]\\]`, 'i');
                const match = response.text.match(regex);
                if (match) {
                    let translated = match[1].trim();
                    // Hậu xử lý loại bỏ model lỡ copy lại chữ Hán
                    translated = translated.split('\n').filter(line => {
                        const hasVietnamese = /[a-zA-Záàảãạâấầẩẫậăắằẳẵặéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i.test(line);
                        const hasChinese = /[\u4e00-\u9fa5]/.test(line);
                        // Nếu dòng có chữ Hán mà không có chữ Việt, hoặc tỷ lệ chữ Hán quá cao -> dòng lỗi
                        if (hasChinese && !hasVietnamese) return false;
                        return true;
                    }).join('\n');
                    results.set(file.id, translated);
                }
            }
            if (results.size > 0) {
                quotaManager.recordRequest(modelId);
                return { results, model: modelId };
            }
        } catch (error: any) {
            handleErrorQuota(error, modelId);
        }
    }
    throw new Error("Dịch thất bại trên mọi model hoặc model trả về sai định dạng.");
};
