
import { GoogleGenAI } from '@google/genai';
import { quotaManager } from './utils/quotaManager.ts';
import { MODEL_CONFIGS, GLOSSARY_ANALYSIS_PROMPT } from './constants.ts';
import { StoryInfo, FileItem } from './types.ts';

const getAiClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
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
  const priorityTier = ['gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-2.5-flash'];
  const available = currentConfigs
    .filter(c => allowedModelIds.includes(c.id) && quotaManager.isModelAvailable(c.id))
    .sort((a, b) => priorityTier.indexOf(a.id) - priorityTier.indexOf(b.id));

  return available.map(m => m.id);
}

export const analyzeStoryContext = async (files: FileItem[], storyInfo: StoryInfo): Promise<string> => {
    const ai = getAiClient();
    const modelsToTry = ['gemini-3-flash-preview', 'gemini-3-pro-preview'];
    const sampleFiles = files.length > 3 ? [files[0], files[Math.floor(files.length/2)], files[files.length-1]] : files;
    let contextContent = sampleFiles.map(f => `--- ${f.name} ---\n${f.content.substring(0, 1500)}`).join('\n\n');
    const userPrompt = `Phân tích cốt truyện cho truyện "${storyInfo.title}" từ nội dung mẫu:\n\n${contextContent}`;

    for (const modelId of modelsToTry) {
        if (!quotaManager.isModelAvailable(modelId)) continue;
        try {
            const response = await ai.models.generateContent({
                model: modelId,
                contents: userPrompt,
                config: { systemInstruction: GLOSSARY_ANALYSIS_PROMPT, temperature: 0.3 },
            });
            if (response.text) {
                quotaManager.recordRequest(modelId);
                return response.text.trim();
            }
        } catch (error: any) {
            handleErrorQuota(error, modelId);
        }
    }
    throw new Error("AI không thể phản hồi lúc này.");
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

    const systemInstruction = `DỊCH SANG TIẾNG VIỆT MƯỢT MÀ, THUẦN VIỆT 100%. GIỮ NGUYÊN FILE_ID TAGS.`;
    const fullPrompt = `[DICTIONARY]\n${relevantDictionary}\n\n[CONTEXT]\n${globalContext}\n\n[REQUIREMENTS]\n${userPrompt}\n\n[CONTENT]\n${inputContent}`;

    const attempts = selectModel(allowedModelIds);
    for (const modelId of attempts) {
        try {
            const response = await ai.models.generateContent({
                model: modelId,
                contents: fullPrompt,
                config: { systemInstruction, temperature: 0.2, maxOutputTokens: 60000 },
            });
            if (!response.text) continue;
            const results = new Map<string, string>();
            for (const file of files) {
                const regex = new RegExp(`\\[\\[\\[FILE_ID:\\s*${file.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]\\]([\\s\\S]*?)\\[\\[\\[FILE_END:\\s*${file.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\]\\]`, 'i');
                const match = response.text.match(regex);
                if (match) results.set(file.id, match[1].trim());
            }
            if (results.size > 0) {
                quotaManager.recordRequest(modelId);
                return { results, model: modelId };
            }
        } catch (error: any) {
            handleErrorQuota(error, modelId);
        }
    }
    throw new Error("Dịch thất bại.");
};
