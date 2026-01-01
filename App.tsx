
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { 
  FileText, Download, Trash2, AlertCircle, CheckCircle, Loader2, Settings, Zap, Sparkles, ChevronDown, RefreshCw, Languages, Plus, Search, Link2, Book, Brain, Type, Volume2, VolumeX, SkipBack, SkipForward, LogOut, Eye, EyeOff, Menu, ScrollText, Key, ExternalLink, Github, HelpCircle, AlertTriangle, X, PlusCircle, History, Hourglass, Info, Wand2, FileArchive, ArrowRight, Play, Pause, Square, Sliders, Coffee, Sun, Moon, FileOutput, Save, BookOpen, ToggleLeft, ToggleRight, Wand, UploadCloud, Smartphone
} from 'lucide-react';
import { FileItem, FileStatus, StoryProject, ReaderSettings } from './utils/types';
import { DEFAULT_PROMPT, MODEL_CONFIGS, AVAILABLE_LANGUAGES, AVAILABLE_GENRES, AVAILABLE_PERSONALITIES, AVAILABLE_SETTINGS, AVAILABLE_FLOWS, DEFAULT_DICTIONARY } from './constants';
import { translateBatch, analyzeStoryContext } from './geminiService';
import { createMergedFile, downloadTextFile, fetchContentFromUrl, unzipFiles, generateEpub, translateChapterTitle } from './utils/fileHelpers';
import { replacePromptVariables } from './utils/textHelpers';
import { saveProject, getAllProjects, deleteProject } from './utils/storage';
import { quotaManager } from './utils/quotaManager';

const MAX_CONCURRENCY = 1; 
const BATCH_FILE_LIMIT = 2; 

const BG_COLORS = [
    { name: 'Trắng', code: 'bg-white text-slate-900' },
    { name: 'Giấy cũ', code: 'bg-[#f4ecd8] text-slate-900' },
    { name: 'Xanh dịu', code: 'bg-[#e8f5e9] text-slate-900' },
    { name: 'Tối', code: 'bg-slate-900 text-slate-300' }
];

const getStatusLabel = (status: FileStatus) => {
    switch (status) {
        case FileStatus.IDLE: return { label: 'Chờ dịch', color: 'bg-slate-100 text-slate-500' };
        case FileStatus.PROCESSING: return { label: 'Đang dịch...', color: 'bg-indigo-100 text-indigo-600 animate-pulse' };
        case FileStatus.COMPLETED: return { label: 'Đã xong', color: 'bg-emerald-100 text-emerald-600' };
        case FileStatus.ERROR: return { label: 'Lỗi', color: 'bg-rose-100 text-rose-600' };
        default: return { label: 'Chờ', color: 'bg-slate-100 text-slate-500' };
    }
};

const generateId = () => {
    try {
        return crypto.randomUUID();
    } catch (e) {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }
};

const App: React.FC = () => {
  const [projects, setProjects] = useState<StoryProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingQueue, setProcessingQueue] = useState<string[]>([]);
  const [activeWorkers, setActiveWorkers] = useState<number>(0);
  const [showLinkModal, setShowLinkModal] = useState<boolean>(false);
  const [showContextSetup, setShowContextSetup] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState<boolean>(false);
  const [showTTSSettings, setShowTTSSettings] = useState<boolean>(false);
  
  const [linkInput, setLinkInput] = useState<string>("");
  const [isAutoCrawlEnabled, setIsAutoCrawlEnabled] = useState<boolean>(true);
  const [isFetchingLinks, setIsFetchingLinks] = useState<boolean>(false);
  const isFetchingLinksRef = useRef<boolean>(false);
  const [fetchProgress, setFetchProgress] = useState<{current: number, total: number} | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  
  // API Key Management State
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<string>("");
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);

  const [isWakeLockActive, setIsWakeLockActive] = useState<boolean>(false);
  const wakeLockRef = useRef<any>(null);

  const [viewingFileId, setViewingFileId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{id: string, message: string, type: string}[]>([]);

  const readerScrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const isReaderActiveRef = useRef<boolean>(false); 
  const synthesisRef = useRef<SpeechSynthesis | null>(window.speechSynthesis);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [activeTTSIndex, setActiveTTSIndex] = useState<number>(-1);
  const [isTTSPaused, setIsTTSPaused] = useState<boolean>(false);

  const currentProject = useMemo(() => projects.find(p => p.id === currentProjectId) || null, [projects, currentProjectId]);

  const [readerSettings, setReaderSettings] = useState<ReaderSettings>({
      fontSize: 19,
      bgColor: 'bg-[#f4ecd8] text-slate-900',
      fontFamily: 'font-serif',
      ttsRate: 1.2,
      ttsVoice: '',
      showOriginal: false,
      isAutoScrollActive: true
  });

  const [newProjectInfo, setNewProjectInfo] = useState({
      title: '', author: '', languages: ['Convert thô'], genres: ['Tiên Hiệp'], mcPersonality: ['Trầm ổn/Già dặn'], worldSetting: ['Trung Cổ/Cổ Đại'], sectFlow: ['Phàm nhân lưu']
  });

  useEffect(() => {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey && savedKey.length > 30) {
      setApiKey(savedKey);
    } else {
      setShowApiKeyModal(true);
    }
  }, []);

  const handleSaveApiKey = () => {
    const keyToSave = apiKeyInput.trim();
    if (keyToSave.length < 30) {
        addToast("API Key không hợp lệ. Vui lòng kiểm tra lại.", "error");
        return;
    }
    localStorage.setItem('gemini_api_key', keyToSave);
    setApiKey(keyToSave);
    setShowApiKeyModal(false);
    addToast("Đã lưu API Key thành công!", "success");
  };

  const safeStr = (val: any): string => {
    if (val === null || val === undefined) return "";
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
        try { return JSON.stringify(val); } catch (e) { return "[Object]"; }
    }
    return String(val);
  };

  const addToast = useCallback((message: any, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    const id = generateId();
    let safeMessage = "Thông báo hệ thống";
    if (typeof message === 'string') safeMessage = message;
    else if (message instanceof Error) safeMessage = message.message;
    else if (message && typeof message === 'object') safeMessage = message.$$typeof ? "[UI]" : JSON.stringify(message);
    else safeMessage = String(message || "");
    setToasts(prev => [...prev, { id, message: safeMessage, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const toggleWakeLock = async () => {
    if (!('wakeLock' in navigator)) { addToast("Không hỗ trợ Wake Lock", "warning"); return; }
    try {
        if (isWakeLockActive) {
            if (wakeLockRef.current) await wakeLockRef.current.release();
            setIsWakeLockActive(false); addToast("Tắt giữ sáng", "info");
        } else {
            wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
            setIsWakeLockActive(true); addToast("Bật giữ sáng", "success");
            wakeLockRef.current.addEventListener('release', () => setIsWakeLockActive(false));
        }
    } catch (err: any) { addToast("Lỗi Wake Lock: " + err.message, "error"); }
  };

  useEffect(() => {
    const updateVoices = () => {
        if (!window.speechSynthesis) return;
        const voices = window.speechSynthesis.getVoices();
        const sorted = [...voices].sort((a, b) => {
            if (a.lang.startsWith('vi') && !b.lang.startsWith('vi')) return -1;
            if (!a.lang.startsWith('vi') && b.lang.startsWith('vi')) return 1;
            return 0;
        });
        setAvailableVoices(sorted.filter(v => v.lang.startsWith('vi') || v.lang.startsWith('en')));
    };
    updateVoices();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = updateVoices;
  }, []);

  useEffect(() => { getAllProjects().then(setProjects); }, []);

  const updateProject = (id: string, updates: Partial<StoryProject>) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates, lastModified: Date.now() } : p));
  };

  const persistProject = async (project: StoryProject) => {
    setIsSaving(true);
    try { await saveProject(project); } catch (e) { console.error("Save failed", e); } finally { setIsSaving(false); }
  };

  useEffect(() => { if (currentProject) persistProject(currentProject); }, [currentProject?.lastModified]);

  const handleAIAnalyze = async () => {
    if (!currentProject || currentProject.chapters.length === 0 || !apiKey) return addToast("Cần API Key và ít nhất vài chương để phân tích", "warning");
    setIsAnalyzing(true);
    try {
        const result = await analyzeStoryContext(currentProject.chapters, currentProject.info, apiKey);
        updateProject(currentProject.id, { globalContext: result });
        addToast("Đã hoàn thành phân tích bối cảnh AI!", "success");
    } catch (e: any) {
        addToast("Lỗi phân tích AI: " + e.message, "error");
    } finally {
        setIsAnalyzing(false);
    }
  };

  const createNewProject = async () => {
    if (!newProjectInfo.title.trim()) return addToast("Tên truyện trống", "warning");
    const projectId = generateId();
    const newProject: StoryProject = {
      id: projectId,
      info: { ...newProjectInfo, contextNotes: "" },
      chapters: [],
      promptTemplate: DEFAULT_PROMPT,
      dictionary: DEFAULT_DICTIONARY,
      globalContext: "",
      createdAt: Date.now(),
      lastModified: Date.now()
    };
    try {
        await saveProject(newProject);
        setProjects(prev => [...prev, newProject]);
        setCurrentProjectId(projectId);
        setShowNewProjectModal(false);
        setNewProjectInfo({ title: '', author: '', languages: ['Convert thô'], genres: ['Tiên Hiệp'], mcPersonality: ['Trầm ổn/Già dặn'], worldSetting: ['Trung Cổ/Cổ Đại'], sectFlow: ['Phàm nhân lưu'] });
        addToast("Đã tạo truyện mới", "success");
    } catch (e) { addToast("Lỗi tạo truyện", "error"); }
  };

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Xóa truyện?")) return;
    await deleteProject(id);
    setProjects(prev => prev.filter(p => p.id !== id));
    if (currentProjectId === id) setCurrentProjectId(null);
    addToast("Đã xóa", "info");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!currentProject || !e.target.files?.length) return;
    const files = e.target.files;
    let newChapters: FileItem[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            if (file.name.endsWith('.zip')) {
                const unzipped = await unzipFiles(file);
                newChapters = [...newChapters, ...unzipped];
            } else {
                const content = await file.text();
                newChapters.push({ id: generateId(), name: translateChapterTitle(file.name.replace('.txt', '')), content, translatedContent: null, status: FileStatus.IDLE, retryCount: 0, originalCharCount: content.length, remainingRawCharCount: 0 });
            }
        } catch (err) { addToast(`Lỗi đọc file: ${file.name}`, "error"); }
    }
    updateProject(currentProject.id, { chapters: [...currentProject.chapters, ...newChapters] });
    addToast(`Đã thêm ${newChapters.length} chương`, "success");
  };

  const mergeDictionaries = (base: string, newly: string): string => {
    const parse = (str: string) => {
        const map = new Map<string, string>();
        str.split('\n').forEach(line => {
            const l = line.trim();
            if (!l || l.startsWith('#') || l.startsWith('//')) return;
            const idx = l.indexOf('=');
            if (idx === -1) return;
            map.set(l.substring(0, idx).trim(), l.substring(idx + 1).trim());
        });
        return map;
    };
    const baseMap = parse(base);
    const newMap = parse(newly);
    newMap.forEach((v, k) => baseMap.set(k, v));
    
    let result = "# --- DICTIONARY MERGED ---\n";
    baseMap.forEach((v, k) => {
        result += `${k}=${v}\n`;
    });
    return result;
  };

  const handleDictionaryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!currentProject || !e.target.files?.length) return;
      const file = e.target.files[0];
      try {
          const content = await file.text();
          const merged = mergeDictionaries(currentProject.dictionary, content);
          updateProject(currentProject.id, { dictionary: merged });
          addToast("Đã hợp nhất từ điển mới!", "success");
      } catch (err) { addToast("Lỗi đọc file từ điển", "error"); }
  };

  const handleLinkCrawl = async () => {
    if (!currentProject || isFetchingLinksRef.current) return;
    const startUrl = linkInput;
    if (!startUrl) {
        addToast("Vui lòng nhập link để bắt đầu.", "warning");
        return;
    }

    isFetchingLinksRef.current = true;
    setIsFetchingLinks(true);
    setShowLinkModal(false);

    try {
        setFetchProgress({ current: 1, total: 1 });
        const result = await fetchContentFromUrl(startUrl);
        const chapterId = generateId();
        const newChapter: FileItem = { 
            id: chapterId, 
            name: translateChapterTitle(result.title), 
            content: result.content, 
            translatedContent: null, 
            status: FileStatus.IDLE, 
            retryCount: 0, 
            originalCharCount: result.content.length, 
            remainingRawCharCount: 0 
        };
        
        setProjects(prev => prev.map(p => p.id === currentProject.id ? { 
            ...p, 
            chapters: [...p.chapters, newChapter], 
            lastCrawlUrl: result.nextUrl || startUrl,
            lastModified: Date.now()
        } : p));

        addToast(`Đã nạp chương đầu tiên. Hãy nhấn "Bắt đầu dịch" để kích hoạt Tự động cào.`, "success");
    } catch (e: any) { 
        addToast(`Cào link thất bại: ${e.message}`, "error"); 
    } finally {
        isFetchingLinksRef.current = false;
        setIsFetchingLinks(false); 
        setFetchProgress(null); 
        setLinkInput("");
    }
  };

  useEffect(() => {
    if (!isProcessing || !currentProject || isFetchingLinksRef.current || !isAutoCrawlEnabled) return;

    const idleChapters = currentProject.chapters.filter(c => c.status === FileStatus.IDLE || c.status === FileStatus.PROCESSING);
    if (idleChapters.length >= 2) return;

    const nextUrl = currentProject.lastCrawlUrl;
    if (!nextUrl) return;

    const autoFetch = async () => {
        isFetchingLinksRef.current = true;
        setIsFetchingLinks(true);
        try {
            const result = await fetchContentFromUrl(nextUrl);
            const chapterId = generateId();
            const newChapter: FileItem = { 
                id: chapterId, 
                name: translateChapterTitle(result.title), 
                content: result.content, 
                translatedContent: null, 
                status: FileStatus.IDLE, 
                retryCount: 0, 
                originalCharCount: result.content.length, 
                remainingRawCharCount: 0 
            };
            
            setProjects(prev => prev.map(p => p.id === currentProject.id ? { 
                ...p, 
                chapters: [...p.chapters, newChapter], 
                lastCrawlUrl: result.nextUrl || nextUrl,
                lastModified: Date.now()
            } : p));

            setProcessingQueue(prev => [...new Set([...prev, chapterId])]);
        } catch (e) {
            console.error("Auto-crawl failed", e);
        } finally {
            isFetchingLinksRef.current = false;
            setIsFetchingLinks(false);
        }
    };

    const timer = setTimeout(autoFetch, 5000);
    return () => clearTimeout(timer);
  }, [isProcessing, currentProject?.chapters.length, currentProject?.lastCrawlUrl, isAutoCrawlEnabled, processingQueue.length]);

  const handleExportEpub = useCallback(async () => {
    if (!currentProject) return;
    const completedChapters = currentProject.chapters.filter(c => c.status === FileStatus.COMPLETED);
    if (completedChapters.length === 0) {
      addToast("Cần ít nhất một chương đã dịch xong để xuất EPUB", "warning");
      return;
    }
    try {
      addToast("Đang tạo EPUB...", "info");
      const blob = await generateEpub(currentProject.chapters, currentProject.info);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentProject.info.title || 'Novel'}.epub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast("Đã tải xuống EPUB", "success");
    } catch (err: any) {
      addToast("Lỗi xuất EPUB: " + err.message, "error");
    }
  }, [currentProject, addToast]);

  const startTranslation = useCallback((retryAll: boolean = false) => {
    if (!currentProject) return;
    const toProcess = currentProject.chapters.filter(c => retryAll ? true : (c.status === FileStatus.IDLE || c.status === FileStatus.ERROR)).map(c => c.id);
    if (toProcess.length === 0 && !currentProject.lastCrawlUrl) return addToast("Tất cả đã dịch xong", "info");
    
    setProcessingQueue(prev => [...new Set([...prev, ...toProcess])]);
    setIsProcessing(true);
    addToast(isAutoCrawlEnabled ? "Đã bật chế độ Dịch & Cào tự động" : "Bắt đầu tiến trình dịch", "success");
  }, [currentProject, addToast, isAutoCrawlEnabled]);

  const stopTranslation = useCallback(() => {
    setIsProcessing(false); setProcessingQueue([]); addToast("Đã dừng tiến trình dịch", "info");
  }, [addToast]);

  useEffect(() => {
    if (!isProcessing || processingQueue.length === 0 || activeWorkers >= MAX_CONCURRENCY || !currentProjectId || !apiKey) return;
    const processBatch = async () => {
        const batchIds = processingQueue.slice(0, BATCH_FILE_LIMIT);
        setProcessingQueue(prev => prev.slice(BATCH_FILE_LIMIT));
        setActiveWorkers(prev => prev + 1);
        
        setProjects(prev => prev.map(p => p.id === currentProjectId ? {
            ...p,
            chapters: p.chapters.map(c => batchIds.includes(c.id) ? { ...c, status: FileStatus.PROCESSING } : c)
        } : p));

        try {
            const targetProj = projects.find(p => p.id === currentProjectId);
            if (!targetProj) throw new Error("No project found");
            const prompt = replacePromptVariables(targetProj.promptTemplate, targetProj.info);
            const { results, model } = await translateBatch(targetProj.chapters.filter(c => batchIds.includes(c.id)), prompt, targetProj.dictionary, targetProj.globalContext, MODEL_CONFIGS.map(m => m.id), apiKey);
            
            setProjects(prev => prev.map(p => p.id === currentProjectId ? { ...p, lastModified: Date.now(), chapters: p.chapters.map(c => {
                if (batchIds.includes(c.id)) {
                    const translated = results.get(c.id);
                    if (translated) {
                        const firstLine = translated.split('\n')[0];
                        const newName = (firstLine.includes('Chương') || firstLine.includes('第')) ? firstLine.trim() : c.name;
                        return { ...c, name: translateChapterTitle(newName), status: FileStatus.COMPLETED, translatedContent: translated, usedModel: model };
                    }
                    return { ...c, status: FileStatus.ERROR };
                }
                return c;
            }) } : p));
        } catch (e: any) {
            addToast(`Lỗi dịch: ${e.message}`, 'error');
            setProjects(prev => prev.map(p => p.id === currentProjectId ? { ...p, chapters: p.chapters.map(c => batchIds.includes(c.id) ? { ...c, status: FileStatus.ERROR } : c) } : p));
        } finally { setActiveWorkers(prev => prev - 1); }
    };
    processBatch();
  }, [isProcessing, processingQueue, activeWorkers, currentProjectId, addToast, apiKey]);

  const sortedChapters = useMemo(() => {
    if (!currentProject) return [];
    return [...currentProject.chapters].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [currentProject]);

  const viewingChapter = useMemo(() => sortedChapters.find(c => c.id === viewingFileId) || null, [sortedChapters, viewingFileId]);

  const stopTTS = useCallback(() => {
    if (synthesisRef.current) synthesisRef.current.cancel();
    setActiveTTSIndex(-1); setIsTTSPaused(false);
  }, []);

  const playTTS = useCallback((startIndex: number = 0) => {
    if (!isReaderActiveRef.current || !viewingChapter?.translatedContent) { stopTTS(); return; }
    if (synthesisRef.current) synthesisRef.current.cancel();
    const paragraphs = viewingChapter.translatedContent.split('\n').filter(p => p.trim().length > 0);
    if (startIndex >= paragraphs.length) {
        const currentIndex = sortedChapters.findIndex(c => c.id === viewingFileId);
        if (currentIndex < sortedChapters.length - 1) {
            const nextChapter = sortedChapters[currentIndex + 1];
            if (nextChapter.status === FileStatus.COMPLETED) {
                setViewingFileId(nextChapter.id);
                setActiveTTSIndex(-1);
                addToast("Chuyển chương tiếp theo...", "info");
            } else {
                addToast("Chương tiếp theo chưa dịch xong.", "warning");
                stopTTS();
            }
        } else {
            addToast("Đã đọc hết danh sách.", "success");
            stopTTS();
        }
        return;
    }
    const textToRead = paragraphs[startIndex].trim();
    setActiveTTSIndex(startIndex);
    const utterance = new SpeechSynthesisUtterance(textToRead);
    utterance.lang = 'vi-VN';
    utterance.rate = readerSettings.ttsRate || 1.1;
    if (readerSettings.ttsVoice && synthesisRef.current) {
        const voices = synthesisRef.current.getVoices();
        const selectedVoice = voices.find(v => v.voiceURI === readerSettings.ttsVoice);
        if (selectedVoice) utterance.voice = selectedVoice;
    }
    utterance.onend = () => { if (isReaderActiveRef.current && !isTTSPaused) playTTS(startIndex + 1); };
    utterance.onerror = () => { if (isReaderActiveRef.current) stopTTS(); };
    synthesisRef.current?.speak(utterance);
  }, [viewingChapter, readerSettings, viewingFileId, sortedChapters, stopTTS, isTTSPaused, addToast]);

  useEffect(() => {
    if (isReaderActiveRef.current && viewingFileId && activeTTSIndex === -1 && !isTTSPaused) {
        const t = setTimeout(() => playTTS(0), 600);
        return () => clearTimeout(t);
    }
  }, [viewingFileId]);

  const toggleTTSPause = () => {
    if (synthesisRef.current?.speaking) {
        if (synthesisRef.current.paused) { synthesisRef.current.resume(); setIsTTSPaused(false); }
        else { synthesisRef.current.pause(); setIsTTSPaused(true); }
    } else playTTS(activeTTSIndex === -1 ? 0 : activeTTSIndex);
  };

  const openReader = (id: string) => { 
    isReaderActiveRef.current = true; setViewingFileId(id); setActiveTTSIndex(-1); setIsTTSPaused(false);
  };
  
  const closeReader = () => { 
    isReaderActiveRef.current = false; stopTTS(); setViewingFileId(null); 
  };

  const handleVoiceChange = (voiceURI: string) => {
    setReaderSettings(prev => ({ ...prev, ttsVoice: voiceURI }));
    if (isReaderActiveRef.current && activeTTSIndex !== -1) {
        stopTTS(); setTimeout(() => playTTS(activeTTSIndex), 100);
    }
  };

  useEffect(() => { if (activeTTSIndex !== -1 && activeLineRef.current) activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [activeTTSIndex]);

  const handleInstallClick = () => {
    addToast("Trên Android: Nhấn dấu 3 chấm Chrome -> 'Cài đặt ứng dụng' hoặc 'Thêm vào màn hình chính'", "info");
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 overflow-hidden font-sans">
      {showApiKeyModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-white rounded-3xl w-full max-w-md m-4 p-8 text-center shadow-2xl">
                <div className="w-16 h-16 bg-amber-100 text-amber-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <Key className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold text-slate-800 mb-2">Nhập Google Gemini API Key</h2>
                <p className="text-slate-500 text-sm mb-6">
                    Ứng dụng cần API Key để hoạt động. Key của bạn được lưu trữ an toàn ngay trên trình duyệt này và không được gửi đi bất cứ đâu.
                </p>
                <div className="space-y-4">
                    <input 
                        type="password"
                        placeholder="Dán API Key của bạn vào đây"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        className="w-full text-center p-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:border-indigo-500 outline-none font-medium transition-all"
                    />
                    <button onClick={handleSaveApiKey} className="w-full bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all">
                        Lưu và Bắt đầu
                    </button>
                </div>
                 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-xs text-slate-400 hover:text-indigo-600 mt-4">
                    <ExternalLink className="w-3 h-3" />
                    Lấy API Key tại Google AI Studio
                </a>
            </div>
        </div>
      )}

      <aside className={`fixed inset-y-0 left-0 z-50 w-72 glass-panel border-r border-slate-200 transition-transform duration-300 lg:relative lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex flex-col h-full">
          <div className="p-6 border-b border-slate-100">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg"><Languages className="w-6 h-6 text-white" /></div>
              <h1 className="font-display font-bold text-xl text-slate-800">AI Novel <span className="text-indigo-600">Pro</span></h1>
            </div>
            <button onClick={() => setShowNewProjectModal(true)} className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-4 rounded-2xl transition-all shadow-md active:scale-95">
              <PlusCircle className="w-5 h-5" />Tạo Truyện Mới
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {projects.map(p => (
              <div key={p.id} onClick={() => { setCurrentProjectId(p.id); setIsSidebarOpen(false); }} className={`group flex items-center justify-between p-4 rounded-2xl cursor-pointer transition-all ${currentProjectId === p.id ? 'bg-indigo-50 border border-indigo-100' : 'hover:bg-slate-100'}`}>
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className={`p-2 rounded-xl shrink-0 ${currentProjectId === p.id ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'}`}><FileText className="w-4 h-4" /></div>
                  <div className="truncate">
                    <p className={`font-bold text-sm truncate ${currentProjectId === p.id ? 'text-indigo-900' : 'text-slate-700'}`}>{safeStr(p.info.title)}</p>
                    <p className="text-xs text-slate-400">{p.chapters.length} chương</p>
                  </div>
                </div>
                <button onClick={(e) => handleDeleteProject(p.id, e)} className="opacity-0 group-hover:opacity-100 p-2 hover:bg-rose-100 text-rose-500 rounded-xl transition-all"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
          <div className="p-4 border-t border-slate-100 space-y-2">
            <button onClick={() => setShowApiKeyModal(true)} className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-amber-700 hover:bg-amber-100 font-semibold transition-all"><Key className="w-5 h-5" />Đổi API Key</button>
            <button onClick={handleInstallClick} className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-indigo-600 hover:bg-indigo-50 font-semibold transition-all"><Smartphone className="w-5 h-5" />Cài đặt APK/App</button>
            <button onClick={toggleWakeLock} className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all font-semibold ${isWakeLockActive ? 'bg-amber-100 text-amber-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                {isWakeLockActive ? <Sun className="w-5 h-5 animate-pulse" /> : <Moon className="w-5 h-5" />}
                {isWakeLockActive ? "Đang giữ sáng" : "Giữ sáng màn hình"}
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 bg-transparent overflow-hidden">
        <header className="h-16 glass-panel border-b border-slate-200 flex items-center justify-between px-6 shrink-0 z-40">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 hover:bg-slate-100 rounded-xl"><Menu className="w-6 h-6 text-slate-600" /></button>
            <h2 className="font-display font-bold text-lg text-slate-800 truncate max-w-[200px] sm:max-w-md">{currentProject ? safeStr(currentProject.info.title) : "Chọn một truyện"}</h2>
          </div>
          {currentProject && (
            <div className="flex items-center gap-3">
                <button 
                  onClick={() => setShowContextSetup(true)}
                  disabled={!apiKey}
                  className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition-all flex items-center gap-2 font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed" title="Bối cảnh truyện">
                    <Brain className="w-5 h-5" />
                    <span className="hidden sm:inline">Bối cảnh</span>
                </button>
                <button 
                  onClick={() => isProcessing ? stopTranslation() : startTranslation(false)}
                  disabled={!apiKey}
                  className={`flex items-center gap-2 ${isProcessing ? 'bg-rose-500 hover:bg-rose-600' : 'bg-indigo-600 hover:bg-indigo-700'} text-white font-bold py-2.5 px-5 rounded-xl text-sm shadow-lg active:scale-95 transition-all disabled:bg-slate-300 disabled:shadow-none disabled:cursor-not-allowed`}>
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {isProcessing ? "Dừng dịch" : "Bắt đầu dịch"}
                </button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {!currentProject ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="w-20 h-20 bg-slate-100 rounded-3xl flex items-center justify-center mb-6 text-slate-300"><Book className="w-10 h-10" /></div>
                  <h2 className="text-xl font-bold text-slate-800 mb-2">Sẵn sàng dịch thuật!</h2>
                  <p className="text-slate-400 mb-8">Hãy chọn dự án bên trái hoặc tạo truyện mới để bắt đầu.</p>
                  <button onClick={() => setShowNewProjectModal(true)} className="flex items-center gap-3 bg-indigo-600 text-white font-bold py-4 px-8 rounded-2xl shadow-xl active:scale-95 transition-all"><Plus className="w-5 h-5" />Bắt đầu ngay</button>
              </div>
          ) : (
            <div className="max-w-6xl mx-auto space-y-6">
                <div className="flex flex-wrap gap-3">
                    <input type="file" id="up" className="hidden" multiple accept=".txt,.zip" onChange={handleFileUpload} />
                    <label htmlFor="up" className="flex items-center gap-2 bg-white border border-slate-200 p-3 rounded-2xl cursor-pointer hover:border-indigo-400 font-bold text-slate-600 shadow-sm transition-all"><PlusCircle className="w-5 h-5" />Thêm File</label>
                    <button onClick={() => setShowLinkModal(true)} className="flex items-center gap-2 bg-white border border-slate-200 p-3 rounded-2xl hover:border-amber-400 font-bold text-slate-600 shadow-sm transition-all"><Link2 className="w-5 h-5" />Cào Link</button>
                    <button onClick={() => downloadTextFile(`${currentProject.info.title}.txt`, createMergedFile(currentProject.chapters))} className="flex items-center gap-2 bg-slate-100 text-slate-700 p-3 rounded-2xl hover:bg-slate-200 font-bold transition-all"><Download className="w-5 h-5" />Xuất TXT</button>
                    <button onClick={handleExportEpub} className="flex items-center gap-2 bg-indigo-600 text-white p-3 rounded-2xl hover:bg-indigo-700 font-bold shadow-lg shadow-indigo-200 transition-all"><FileOutput className="w-5 h-5" />Xuất EPUB</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sortedChapters.map((ch) => {
                        const { label, color } = getStatusLabel(ch.status);
                        return (
                            <div key={ch.id} className="bg-white p-5 rounded-3xl border border-slate-100 hover:shadow-xl transition-all relative overflow-hidden group">
                                <h4 className="font-bold text-slate-800 truncate mb-3" title={safeStr(ch.name)}>{safeStr(ch.name)}</h4>
                                <div className="flex items-center justify-between">
                                    <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-lg ${color}`}>{label}</span>
                                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        {ch.status === FileStatus.COMPLETED && <button onClick={() => openReader(ch.id)} className="p-2 bg-indigo-50 text-indigo-600 rounded-xl"><Eye className="w-4 h-4" /></button>}
                                        <button onClick={() => updateProject(currentProject.id, { chapters: currentProject.chapters.filter(c => c.id !== ch.id) })} className="p-2 bg-rose-50 text-rose-500 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
          )}
        </div>
      </main>

      {/* MODAL: Context Setup */}
      {showContextSetup && currentProject && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
              <div className="bg-white rounded-[2.5rem] w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col text-slate-800 h-[85vh]">
                  <div className="px-8 py-6 border-b flex items-center justify-between">
                      <div className="flex items-center gap-3">
                          <Brain className="w-6 h-6 text-indigo-600" />
                          <h3 className="font-bold text-xl text-slate-800">Bối cảnh & Từ điển</h3>
                      </div>
                      <div className="flex items-center gap-3">
                          <input type="file" id="dict-up" className="hidden" accept=".txt" onChange={handleDictionaryUpload} />
                          <label htmlFor="dict-up" className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl font-bold text-sm cursor-pointer hover:bg-indigo-100 transition-all">
                              <UploadCloud className="w-4 h-4" />
                              Hợp nhất từ điển
                          </label>
                          <button 
                            onClick={handleAIAnalyze} 
                            disabled={isAnalyzing || !apiKey}
                            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm transition-all ${isAnalyzing ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-inner' : 'bg-amber-50 text-amber-600 hover:bg-amber-100 shadow-sm'} disabled:opacity-50 disabled:cursor-not-allowed`}
                          >
                              {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand className="w-4 h-4" />}
                              {isAnalyzing ? "Đang phân tích..." : "AI Tự Phân Tích"}
                          </button>
                          <button onClick={() => setShowContextSetup(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6 text-slate-400" /></button>
                      </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">
                      <div className="space-y-2">
                          <label className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Từ điển & Xưng hô (Định dạng: Gốc=Dịch)</label>
                          <textarea 
                              placeholder="Ví dụ: 我=ta"
                              value={currentProject.dictionary}
                              onChange={e => updateProject(currentProject.id, { dictionary: e.target.value })}
                              className="w-full h-96 p-5 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:border-indigo-400 font-mono text-sm leading-relaxed"
                          />
                      </div>
                      <div className="space-y-2">
                          <label className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Phân tích bối cảnh AI (Series Bible)</label>
                          <textarea 
                              placeholder="Kết quả phân tích từ AI sẽ hiện ở đây..."
                              value={currentProject.globalContext}
                              onChange={e => updateProject(currentProject.id, { globalContext: e.target.value })}
                              className="w-full h-64 p-5 rounded-2xl bg-slate-50 border border-slate-200 outline-none focus:border-indigo-400 font-mono text-sm leading-relaxed"
                          />
                      </div>
                  </div>
                  <div className="p-8 bg-slate-50 border-t flex justify-end">
                      <button onClick={() => setShowContextSetup(false)} className="bg-indigo-600 text-white font-bold py-3 px-10 rounded-2xl shadow-lg active:scale-95 transition-all">Lưu bối cảnh</button>
                  </div>
              </div>
          </div>
      )}

      {/* READER OVERLAY */}
      {viewingChapter && (
          <div className={`fixed inset-0 z-[60] flex flex-col animate-in fade-in duration-300 ${readerSettings.bgColor}`}>
              <div className="h-16 flex items-center justify-between px-6 border-b border-black/5 bg-black/5 backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <button onClick={closeReader} className="p-2 hover:bg-black/10 rounded-full"><X className="w-6 h-6" /></button>
                    <h3 className="font-bold truncate max-w-xs">{safeStr(viewingChapter.name)}</h3>
                </div>
                <div className="flex items-center gap-3">
                    <button onClick={() => setShowTTSSettings(!showTTSSettings)} className={`p-2 rounded-xl transition-all ${showTTSSettings ? 'bg-indigo-600 text-white shadow-lg' : 'hover:bg-black/10'}`}><Sliders className="w-5 h-5" /></button>
                </div>
              </div>

              {showTTSSettings && (
                  <div className="absolute top-20 right-6 w-80 bg-white rounded-3xl shadow-2xl p-6 z-[70] border border-slate-100 animate-in slide-in-from-top-4 duration-300">
                      <div className="flex items-center justify-between mb-6">
                          <h4 className="font-bold text-slate-800">Cấu hình TTS</h4>
                          <button onClick={() => setShowTTSSettings(false)} className="text-slate-400"><X className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-6 text-slate-800">
                          <div className="space-y-2">
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Giọng nói (Ưu tiên vi-VN)</label>
                              <select value={readerSettings.ttsVoice} onChange={(e) => handleVoiceChange(e.target.value)} className="w-full p-3 rounded-xl bg-slate-50 border border-slate-200 outline-none text-sm font-medium">
                                  <option value="">Giọng mặc định</option>
                                  {availableVoices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{safeStr(v.name)} ({v.lang})</option>)}
                              </select>
                          </div>
                          <div className="space-y-2">
                              <div className="flex justify-between"><label className="text-[10px] font-bold text-slate-400 uppercase">Tốc độ đọc</label><span className="text-xs font-bold text-indigo-600">{readerSettings.ttsRate}x</span></div>
                              <input type="range" min="0.5" max="3.0" step="0.1" value={readerSettings.ttsRate} onChange={(e) => setReaderSettings(prev => ({ ...prev, ttsRate: parseFloat(e.target.value) }))} className="w-full accent-indigo-600" />
                          </div>
                      </div>
                  </div>
              )}

              <div className="flex-1 overflow-y-auto custom-scrollbar p-6" ref={readerScrollRef}>
                  <div className="max-w-3xl mx-auto py-12">
                      <h1 className="text-3xl font-bold mb-16 text-center opacity-80">{safeStr(viewingChapter.name)}</h1>
                      <div className={`space-y-8 leading-relaxed ${readerSettings.fontFamily}`} style={{ fontSize: `${readerSettings.fontSize}px` }}>
                          {viewingChapter.translatedContent?.split('\n').filter(l => l.trim().length > 0).map((line, idx) => (
                              <div key={idx} ref={activeTTSIndex === idx ? activeLineRef : null} onClick={() => playTTS(idx)} className={`p-4 rounded-2xl transition-all duration-500 cursor-pointer hover:bg-black/5 ${activeTTSIndex === idx ? 'bg-indigo-500/10 ring-1 ring-indigo-500/20 shadow-sm' : ''}`}>
                                  <p className={`${activeTTSIndex === idx ? 'text-indigo-900 font-medium' : 'opacity-90'}`}>{safeStr(line.trim())}</p>
                              </div>
                          ))}
                      </div>
                  </div>
              </div>

              <div className="p-6 bg-black/5 border-t border-black/5 flex flex-wrap items-center justify-center gap-6">
                  <div className="flex items-center gap-3 bg-black/5 rounded-2xl p-1.5">
                      {BG_COLORS.map(c => <button key={c.code} onClick={() => setReaderSettings(prev => ({ ...prev, bgColor: c.code }))} className={`w-8 h-8 rounded-xl border-2 transition-all ${c.code} ${readerSettings.bgColor === c.code ? 'border-indigo-500' : 'border-transparent'}`} />)}
                  </div>
                  <div className="flex items-center gap-2 bg-indigo-600 rounded-2xl p-1 shadow-lg shadow-indigo-200">
                      <button onClick={stopTTS} className="p-3 text-white hover:bg-white/10 rounded-xl transition-all"><Square className="w-5 h-5 fill-white" /></button>
                      <button onClick={toggleTTSPause} className="p-3 bg-white text-indigo-600 rounded-xl shadow-sm hover:scale-105 active:scale-95 transition-all">
                          {isTTSPaused || activeTTSIndex === -1 ? <Play className="w-6 h-6 fill-indigo-600" /> : <Pause className="w-6 h-6 fill-indigo-600" />}
                      </button>
                      <button onClick={() => playTTS(activeTTSIndex + 1)} className="p-3 text-white hover:bg-white/10 rounded-xl transition-all"><SkipForward className="w-5 h-5 fill-white" /></button>
                  </div>
              </div>
          </div>
      )}

      {/* NEW PROJECT MODAL */}
      {showNewProjectModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-[2.5rem] w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col text-slate-800">
                <div className="px-8 py-6 border-b flex items-center justify-between"><h3 className="font-bold text-2xl">Dự án truyện mới</h3><button onClick={() => setShowNewProjectModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6" /></button></div>
                <div className="p-8 space-y-6">
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Tiêu đề truyện</label>
                        <input type="text" placeholder="Ví dụ: Đấu Phá Thương Khung" value={newProjectInfo.title} onChange={(e) => setNewProjectInfo({...newProjectInfo, title: e.target.value})} className="w-full p-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:border-indigo-500 outline-none font-semibold transition-all" />
                    </div>
                </div>
                <div className="p-8 bg-slate-50 border-t flex gap-4"><button onClick={() => setShowNewProjectModal(false)} className="flex-1 font-bold text-slate-400">Quay lại</button><button onClick={createNewProject} className="flex-[2] bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all">Tạo Dự Án</button></div>
            </div>
        </div>
      )}

      {/* CRAWL MODAL */}
      {showLinkModal && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-white rounded-[2.5rem] w-full max-w-lg overflow-hidden shadow-2xl flex flex-col text-slate-800">
                  <div className="px-8 py-6 border-b flex items-center justify-between"><h3 className="font-bold text-xl">Cào nội dung từ URL</h3><button onClick={() => setShowLinkModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6" /></button></div>
                  <div className="p-8 space-y-5">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-400 uppercase px-1">Link chương 1</label>
                        <input type="text" placeholder="https://..." value={linkInput} onChange={(e) => setLinkInput(e.target.value)} className="w-full p-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:border-indigo-500 outline-none font-medium transition-all" />
                      </div>
                      <div className="flex items-center justify-between px-1">
                          <button onClick={() => setIsAutoCrawlEnabled(!isAutoCrawlEnabled)} className="flex items-center gap-2 group w-full justify-between">
                              <span className="text-sm font-bold text-slate-600">Dịch & Cào tự động (Khi nhấn nút Dịch):</span>
                              {isAutoCrawlEnabled ? <ToggleRight className="w-8 h-8 text-indigo-600" /> : <ToggleLeft className="w-8 h-8 text-slate-300" />}
                          </button>
                      </div>
                  </div>
                  <div className="p-8 bg-slate-50 border-t flex gap-4"><button onClick={() => setShowLinkModal(false)} className="flex-1 font-bold text-slate-400">Hủy</button><button onClick={() => handleLinkCrawl()} className="flex-[2] bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all">Nạp mốc chương</button></div>
              </div>
          </div>
      )}

      {/* TOASTS */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl border-2 animate-in slide-in-from-right duration-300 min-w-[280px] ${
            t.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-100' :
            t.type === 'error' ? 'bg-rose-50 text-rose-800 border-rose-100' :
            'bg-white text-slate-800 border-slate-100'
          }`}>
            <div className={`p-2 rounded-xl ${t.type === 'success' ? 'bg-emerald-500 text-white' : t.type === 'error' ? 'bg-rose-500 text-white' : 'bg-indigo-500 text-white'}`}>
                {t.type === 'success' ? <CheckCircle className="w-4 h-4" /> : t.type === 'error' ? <AlertCircle className="w-4 h-4" /> : <Info className="w-4 h-4" />}
            </div>
            <span className="font-bold text-sm">{safeStr(t.message)}</span>
          </div>
        ))}
      </div>

      {/* FETCH PROGRESS */}
      {isFetchingLinks && (
          <div className="fixed bottom-6 left-6 z-[100] bg-white p-4 rounded-2xl shadow-2xl border border-slate-200 animate-in slide-in-from-left duration-300 flex items-center gap-4">
              <div className="relative">
                <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                    <Link2 className="w-3 h-3 text-indigo-400" />
                </div>
              </div>
              <div>
                  <p className="font-bold text-sm text-slate-800">Đang cào dữ liệu...</p>
                  <p className="text-xs text-slate-400">{fetchProgress ? `Tiến độ: ${fetchProgress.current}/${fetchProgress.total}` : 'Chế độ tự động đang chạy...'}</p>
              </div>
          </div>
      )}
    </div>
  );
};

export default App;
