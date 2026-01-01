
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { 
  FileText, Download, Trash2, AlertCircle, CheckCircle, Loader2, Settings, Zap, Sparkles, ChevronDown, RefreshCw, Languages, Plus, Search, Link2, Book, Brain, Type, Volume2, VolumeX, SkipBack, SkipForward, LogOut, Eye, EyeOff, Menu, ScrollText, Key, ExternalLink, Github, HelpCircle, AlertTriangle, X, PlusCircle, History, Hourglass, Info, Wand2, FileArchive, ArrowRight, Play, Pause, Square, Sliders, Coffee, Sun, Moon
} from 'lucide-react';
import { FileItem, FileStatus, StoryProject, ReaderSettings } from './utils/types';
import { DEFAULT_PROMPT, MODEL_CONFIGS, AVAILABLE_LANGUAGES, AVAILABLE_GENRES, AVAILABLE_PERSONALITIES, AVAILABLE_SETTINGS, AVAILABLE_FLOWS, DEFAULT_DICTIONARY } from './constants';
import { translateBatch, analyzeStoryContext } from './geminiService';
import { createMergedFile, downloadTextFile, fetchContentFromUrl, unzipFiles } from './utils/fileHelpers';
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
  const [crawlLimit, setCrawlLimit] = useState<number>(10);
  const [isAutoCrawlEnabled, setIsAutoCrawlEnabled] = useState<boolean>(true);
  const [isFetchingLinks, setIsFetchingLinks] = useState<boolean>(false);
  const [fetchProgress, setFetchProgress] = useState<{current: number, total: number} | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);

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

  // Defensive helper for rendering dynamic text
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
    if (typeof message === 'string') {
        safeMessage = message;
    } else if (message instanceof Error) {
        safeMessage = message.message;
    } else if (message && typeof message === 'object') {
        // Handle React element or general object
        if (message.$$typeof) {
            safeMessage = "[UI Element]";
        } else {
            try {
                safeMessage = JSON.stringify(message);
            } catch (e) {
                safeMessage = "Dữ liệu không hợp lệ";
            }
        }
    } else {
        safeMessage = String(message || "");
    }
    
    setToasts(prev => [...prev, { id, message: safeMessage, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const toggleWakeLock = async () => {
    if (!('wakeLock' in navigator)) {
        addToast("Trình duyệt của bạn không hỗ trợ Wake Lock.", "warning");
        return;
    }
    try {
        if (isWakeLockActive) {
            if (wakeLockRef.current) {
                await wakeLockRef.current.release();
                wakeLockRef.current = null;
            }
            setIsWakeLockActive(false);
            addToast("Đã tắt chế độ giữ sáng.", "info");
        } else {
            wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
            setIsWakeLockActive(true);
            addToast("Đã bật chế độ giữ sáng màn hình.", "success");
            wakeLockRef.current.addEventListener('release', () => {
                setIsWakeLockActive(false);
            });
        }
    } catch (err: any) {
        setIsWakeLockActive(false);
        addToast("Lỗi Wake Lock: " + err.message, "error");
    }
  };

  useEffect(() => {
    const updateVoices = () => {
        if (!window.speechSynthesis) return;
        const voices = window.speechSynthesis.getVoices();
        const sorted = voices.sort((a, b) => {
            if (a.lang.startsWith('vi') && !b.lang.startsWith('vi')) return -1;
            if (!a.lang.startsWith('vi') && b.lang.startsWith('vi')) return 1;
            return 0;
        });
        setAvailableVoices(sorted.filter(v => v.lang.startsWith('vi') || v.lang.startsWith('en')));
    };
    updateVoices();
    if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, []);

  useEffect(() => {
    getAllProjects().then(setProjects);
  }, []);

  const updateProject = (id: string, updates: Partial<StoryProject>) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates, lastModified: Date.now() } : p));
  };

  const persistProject = async (project: StoryProject) => {
    setIsSaving(true);
    try {
      await saveProject(project);
    } catch (e) { 
        console.error("Save failed", e);
    } finally { 
        setIsSaving(false); 
    }
  };

  useEffect(() => {
    if (currentProject) persistProject(currentProject);
  }, [currentProject?.lastModified]);

  const createNewProject = async () => {
    if (!newProjectInfo.title.trim()) return addToast("Tên truyện không được để trống", "warning");
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
        setNewProjectInfo({
            title: '', author: '', languages: ['Convert thô'], genres: ['Tiên Hiệp'], 
            mcPersonality: ['Trầm ổn/Già dặn'], worldSetting: ['Trung Cổ/Cổ Đại'], sectFlow: ['Phàm nhân lưu']
        });
        addToast("Đã tạo truyện mới", "success");
    } catch (e) {
        addToast("Lỗi khi tạo truyện", "error");
    }
  };

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Xác nhận xóa truyện này?")) return;
    await deleteProject(id);
    setProjects(prev => prev.filter(p => p.id !== id));
    if (currentProjectId === id) setCurrentProjectId(null);
    addToast("Đã xóa truyện", "info");
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
                newChapters.push({
                    id: generateId(),
                    name: file.name.replace('.txt', ''),
                    content,
                    translatedContent: null,
                    status: FileStatus.IDLE,
                    retryCount: 0,
                    originalCharCount: content.length,
                    remainingRawCharCount: 0
                });
            }
        } catch (err) {
            addToast(`Lỗi đọc file: ${file.name}`, "error");
        }
    }
    updateProject(currentProject.id, { chapters: [...currentProject.chapters, ...newChapters] });
    addToast(`Đã thêm ${newChapters.length} chương`, "success");
  };

  const handleLinkCrawl = async (limitOverride?: number) => {
    if (!currentProject || (!linkInput && !currentProject.lastCrawlUrl)) return;
    const startUrl = linkInput || currentProject.lastCrawlUrl;
    if (!startUrl) return;

    setIsFetchingLinks(true);
    setShowLinkModal(false);
    let currentUrl = startUrl;
    let count = 0;
    const targetLimit = limitOverride || crawlLimit;
    
    try {
        while (currentUrl && count < targetLimit) {
            setFetchProgress({ current: count + 1, total: targetLimit });
            const result = await fetchContentFromUrl(currentUrl);
            const newChapter: FileItem = {
                id: generateId(),
                name: result.title,
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
                lastCrawlUrl: result.nextUrl || currentUrl 
            } : p));
            
            currentUrl = result.nextUrl || "";
            count++;
            if (!currentUrl) break;
            await new Promise(r => setTimeout(r, 1500)); 
        }
        if (count > 0) addToast(`Cào xong ${count} chương`, "success");
    } catch (e: any) {
        addToast("Lỗi cào link: " + e.message, "error");
    } finally {
        setIsFetchingLinks(false);
        setFetchProgress(null);
        setLinkInput("");
    }
  };

  const startTranslation = useCallback((retryAll: boolean = false) => {
    if (!currentProject) return;
    const toProcess = currentProject.chapters
        .filter(c => retryAll ? true : (c.status === FileStatus.IDLE || c.status === FileStatus.ERROR))
        .map(c => c.id);
    if (toProcess.length === 0) return addToast("Không còn chương cần dịch", "info");
    setProcessingQueue(prev => [...new Set([...prev, ...toProcess])]);
    setIsProcessing(true);
  }, [currentProject, addToast]);

  const stopTranslation = useCallback(() => {
    setIsProcessing(false);
    setProcessingQueue([]);
    addToast("Đã dừng dịch", "info");
  }, [addToast]);

  useEffect(() => {
    if (!isProcessing || processingQueue.length === 0 || activeWorkers >= MAX_CONCURRENCY || !currentProjectId) return;
    const processBatch = async () => {
        const batchIds = processingQueue.slice(0, BATCH_FILE_LIMIT);
        setProcessingQueue(prev => prev.slice(BATCH_FILE_LIMIT));
        setActiveWorkers(prev => prev + 1);
        try {
            const targetProj = projects.find(p => p.id === currentProjectId);
            if (!targetProj) throw new Error("No project");
            const prompt = replacePromptVariables(targetProj.promptTemplate, targetProj.info);
            const { results, model } = await translateBatch(
                targetProj.chapters.filter(c => batchIds.includes(c.id)), 
                prompt, targetProj.dictionary, targetProj.globalContext, 
                MODEL_CONFIGS.map(m => m.id)
            );
            setProjects(prev => prev.map(p => p.id === currentProjectId ? { ...p, lastModified: Date.now(), chapters: p.chapters.map(c => {
                if (batchIds.includes(c.id)) {
                    const translated = results.get(c.id);
                    return { ...c, status: translated ? FileStatus.COMPLETED : FileStatus.ERROR, translatedContent: translated || null, usedModel: model };
                }
                return c;
            }) } : p));
            if (isAutoCrawlEnabled && batchIds.length >= 2) handleLinkCrawl(2); 
        } catch (e) {
            setProjects(prev => prev.map(p => p.id === currentProjectId ? { ...p, chapters: p.chapters.map(c => batchIds.includes(c.id) ? { ...c, status: FileStatus.ERROR } : c) } : p));
        } finally { setActiveWorkers(prev => prev - 1); }
    };
    processBatch();
  }, [isProcessing, processingQueue, activeWorkers, currentProjectId]);

  const sortedChapters = useMemo(() => {
    if (!currentProject) return [];
    return [...currentProject.chapters].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [currentProject]);

  const viewingChapter = useMemo(() => sortedChapters.find(c => c.id === viewingFileId) || null, [sortedChapters, viewingFileId]);

  const stopTTS = useCallback(() => {
    if (synthesisRef.current) {
        synthesisRef.current.cancel();
    }
    setActiveTTSIndex(-1);
    setIsTTSPaused(false);
  }, []);

  const playTTS = useCallback((startIndex: number = 0) => {
    if (!isReaderActiveRef.current || !viewingChapter?.translatedContent) {
        stopTTS();
        return;
    }
    if (synthesisRef.current) {
        synthesisRef.current.cancel();
    }
    const paragraphs = viewingChapter.translatedContent.split('\n').filter(p => p.trim().length > 0);
    if (startIndex >= paragraphs.length) {
        const currentIndex = sortedChapters.findIndex(c => c.id === viewingFileId);
        if (currentIndex < sortedChapters.length - 1 && isReaderActiveRef.current) {
            setViewingFileId(sortedChapters[currentIndex + 1].id);
            addToast("Chuyển chương...", "info");
            setTimeout(() => {
                if (isReaderActiveRef.current) playTTS(0);
            }, 800);
        } else {
            addToast("Đã đọc hết danh sách", "success");
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
        const allVoices = synthesisRef.current.getVoices();
        const selectedVoice = allVoices.find(v => v.voiceURI === readerSettings.ttsVoice);
        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }
    }
    utterance.onend = () => {
        if (isReaderActiveRef.current && !isTTSPaused) {
            playTTS(startIndex + 1);
        }
    };
    utterance.onerror = (e) => {
        if (isReaderActiveRef.current) stopTTS();
    };
    synthesisRef.current?.speak(utterance);
  }, [viewingChapter, readerSettings, viewingFileId, sortedChapters, stopTTS, isTTSPaused, addToast]);

  const toggleTTSPause = () => {
    if (synthesisRef.current?.speaking) {
        if (synthesisRef.current.paused) {
            synthesisRef.current.resume();
            setIsTTSPaused(false);
        } else {
            synthesisRef.current.pause();
            setIsTTSPaused(true);
        }
    } else {
        playTTS(activeTTSIndex === -1 ? 0 : activeTTSIndex);
    }
  };

  const openReader = (id: string) => {
    isReaderActiveRef.current = true;
    setViewingFileId(id);
  };

  const closeReader = () => {
    isReaderActiveRef.current = false;
    stopTTS();
    setViewingFileId(null);
  };

  useEffect(() => {
    if (activeTTSIndex !== -1 && activeLineRef.current) {
        activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeTTSIndex]);

  return (
    <div className="flex h-screen w-full bg-slate-50 overflow-hidden font-sans">
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
            <button onClick={toggleWakeLock} className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all font-semibold ${isWakeLockActive ? 'bg-amber-100 text-amber-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                {isWakeLockActive ? <Sun className="w-5 h-5 animate-pulse" /> : <Moon className="w-5 h-5" />}
                {isWakeLockActive ? "Đang giữ sáng" : "Chế độ nền (Beta)"}
            </button>
            <button onClick={() => setShowSettings(true)} className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-slate-600 hover:bg-slate-100 font-semibold transition-all"><Settings className="w-5 h-5" />Cài đặt</button>
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
            <div className="flex items-center gap-4">
                <button onClick={() => isProcessing ? stopTranslation() : startTranslation(false)} className={`flex items-center gap-2 ${isProcessing ? 'bg-rose-500 hover:bg-rose-600' : 'bg-indigo-600 hover:bg-indigo-700'} text-white font-bold py-2 px-4 rounded-xl text-sm shadow-lg active:scale-95`}>
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {isProcessing ? "Dừng dịch" : "Dịch tiếp"}
                </button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {!currentProject ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="w-20 h-20 bg-slate-100 rounded-3xl flex items-center justify-center mb-6 text-slate-300"><Book className="w-10 h-10" /></div>
                  <h2 className="text-xl font-bold text-slate-800 mb-2">Chào mừng bạn trở lại!</h2>
                  <p className="text-slate-400 mb-8">Hãy chọn truyện hoặc tạo một dự án dịch mới.</p>
                  <button onClick={() => setShowNewProjectModal(true)} className="flex items-center gap-3 bg-indigo-600 text-white font-bold py-4 px-8 rounded-2xl shadow-xl active:scale-95 transition-all"><Plus className="w-5 h-5" />Bắt đầu truyện đầu tiên</button>
              </div>
          ) : (
            <div className="max-w-6xl mx-auto space-y-6">
                <div className="flex flex-wrap gap-3">
                    <input type="file" id="up" className="hidden" multiple accept=".txt,.zip" onChange={handleFileUpload} />
                    <label htmlFor="up" className="flex items-center gap-2 bg-white border border-slate-200 p-3 rounded-2xl cursor-pointer hover:border-indigo-400 font-bold text-slate-600 shadow-sm"><PlusCircle className="w-5 h-5" />Tải File</label>
                    <button onClick={() => setShowLinkModal(true)} className="flex items-center gap-2 bg-white border border-slate-200 p-3 rounded-2xl hover:border-amber-400 font-bold text-slate-600 shadow-sm"><Link2 className="w-5 h-5" />Cào Link</button>
                    <button onClick={() => downloadTextFile(`${currentProject.info.title}.txt`, createMergedFile(currentProject.chapters))} className="flex items-center gap-2 bg-slate-800 text-white p-3 rounded-2xl hover:bg-slate-900 font-bold shadow-lg"><Download className="w-5 h-5" />Xuất .TXT</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sortedChapters.map((ch) => (
                        <div key={ch.id} className="bg-white p-5 rounded-3xl border border-slate-100 hover:shadow-xl transition-all relative overflow-hidden group">
                            <h4 className="font-bold text-slate-800 truncate mb-3">{safeStr(ch.name)}</h4>
                            <div className="flex items-center justify-between">
                                <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-lg ${ch.status === FileStatus.COMPLETED ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>{safeStr(ch.status)}</span>
                                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {ch.status === FileStatus.COMPLETED && <button onClick={() => openReader(ch.id)} className="p-2 bg-indigo-50 text-indigo-600 rounded-xl"><Eye className="w-4 h-4" /></button>}
                                    <button onClick={() => updateProject(currentProject.id, { chapters: currentProject.chapters.filter(c => c.id !== ch.id) })} className="p-2 bg-rose-50 text-rose-500 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
          )}
        </div>
      </main>

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
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Giọng nói</label>
                              <select value={readerSettings.ttsVoice} onChange={(e) => setReaderSettings(prev => ({ ...prev, ttsVoice: e.target.value }))} className="w-full p-3 rounded-xl bg-slate-50 outline-none text-sm font-medium">
                                  <option value="">Mặc định</option>
                                  {availableVoices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{safeStr(v.name)}</option>)}
                              </select>
                          </div>
                          <div className="space-y-2">
                              <div className="flex justify-between"><label className="text-[10px] font-bold text-slate-400 uppercase">Tốc độ</label><span className="text-xs font-bold text-indigo-600">{readerSettings.ttsRate}x</span></div>
                              <input type="range" min="0.5" max="2.5" step="0.1" value={readerSettings.ttsRate} onChange={(e) => setReaderSettings(prev => ({ ...prev, ttsRate: parseFloat(e.target.value) }))} className="w-full accent-indigo-600" />
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

      {showNewProjectModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-[2.5rem] w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col text-slate-800">
                <div className="px-8 py-6 border-b flex items-center justify-between"><h3 className="font-bold text-2xl">Truyện mới</h3><button onClick={() => setShowNewProjectModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6" /></button></div>
                <div className="p-8 space-y-6"><input type="text" placeholder="Tên truyện" value={newProjectInfo.title} onChange={(e) => setNewProjectInfo({...newProjectInfo, title: e.target.value})} className="w-full p-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:border-indigo-500 outline-none font-semibold" /></div>
                <div className="p-8 bg-slate-50 border-t flex gap-4"><button onClick={() => setShowNewProjectModal(false)} className="flex-1 font-bold text-slate-400">Hủy</button><button onClick={createNewProject} className="flex-[2] bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all">Tạo Dự án</button></div>
            </div>
        </div>
      )}

      {showLinkModal && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-white rounded-[2.5rem] w-full max-w-lg overflow-hidden shadow-2xl flex flex-col text-slate-800">
                  <div className="px-8 py-6 border-b flex items-center justify-between"><h3 className="font-bold text-xl">Cào nội dung từ URL</h3><button onClick={() => setShowLinkModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6" /></button></div>
                  <div className="p-8 space-y-4">
                      <p className="text-sm text-slate-500">Nhập link chương 1, hệ thống sẽ tự động tìm link chương tiếp theo.</p>
                      <input type="text" placeholder="https://..." value={linkInput} onChange={(e) => setLinkInput(e.target.value)} className="w-full p-4 rounded-2xl bg-slate-50 border-2 border-transparent focus:border-indigo-500 outline-none font-medium" />
                      <div className="flex items-center gap-4">
                          <label className="text-sm font-bold text-slate-400">Số chương:</label>
                          <input type="number" value={crawlLimit} onChange={(e) => setCrawlLimit(parseInt(e.target.value))} className="w-20 p-2 rounded-xl bg-slate-50 border border-slate-200" />
                      </div>
                  </div>
                  <div className="p-8 bg-slate-50 border-t flex gap-4"><button onClick={() => setShowLinkModal(false)} className="flex-1 font-bold text-slate-400">Hủy</button><button onClick={() => handleLinkCrawl()} className="flex-[2] bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg">Bắt đầu cào</button></div>
              </div>
          </div>
      )}

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

      {isFetchingLinks && (
          <div className="fixed bottom-6 left-6 z-[100] bg-white p-4 rounded-2xl shadow-2xl border border-slate-200 animate-in slide-in-from-left duration-300 flex items-center gap-4">
              <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
              <div>
                  <p className="font-bold text-sm text-slate-800">Đang cào chương...</p>
                  <p className="text-xs text-slate-400">{fetchProgress ? `${fetchProgress.current}/${fetchProgress.total}` : 'Đang tìm link...'}</p>
              </div>
          </div>
      )}
    </div>
  );
};

export default App;