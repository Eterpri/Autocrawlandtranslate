
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { 
  FileText, Download, Trash2, AlertCircle, CheckCircle, Loader2, Settings, Zap, Sparkles, ChevronDown, RefreshCw, Languages, Plus, Search, Link2, Book, Brain, Type, Volume2, VolumeX, SkipBack, SkipForward, LogOut, Eye, EyeOff, Menu, ScrollText, Key, ExternalLink, Github, HelpCircle, AlertTriangle, X, PlusCircle, History, Hourglass, Info
} from 'lucide-react';
import { FileItem, FileStatus, StoryProject, ReaderSettings } from './types';
import { DEFAULT_PROMPT, MODEL_CONFIGS } from './constants';
import { translateBatch, analyzeStoryContext } from './geminiService';
import { createMergedFile, downloadTextFile, generateEpub, fetchContentFromUrl } from './utils/fileHelpers';
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

const App: React.FC = () => {
  const [projects, setProjects] = useState<StoryProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingQueue, setProcessingQueue] = useState<string[]>([]);
  const [activeWorkers, setActiveWorkers] = useState<number>(0);
  const [showLinkModal, setShowLinkModal] = useState<boolean>(false);
  const [showContextSetup, setShowContextSetup] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [userApiKey, setUserApiKey] = useState<string>(localStorage.getItem('user_gemini_api_key') || '');
  
  const [linkInput, setLinkInput] = useState<string>("");
  const [autoCrawl, setAutoCrawl] = useState<boolean>(false);
  const [crawlLimit, setCrawlLimit] = useState<number>(10);
  const [isFetchingLinks, setIsFetchingLinks] = useState<boolean>(false);
  const [fetchProgress, setFetchProgress] = useState<{current: number, total: number} | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isContinuousFlow, setIsContinuousFlow] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);

  const stopCrawlRef = useRef<boolean>(false);
  const [viewingFileId, setViewingFileId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{id: string, message: string, type: string}[]>([]);

  const processingProjectIdRef = useRef<string | null>(null);
  const currentProject = useMemo(() => projects.find(p => p.id === currentProjectId) || null, [projects, currentProjectId]);

  const [readerSettings, setReaderSettings] = useState<ReaderSettings>({
      fontSize: 18,
      bgColor: 'bg-[#f4ecd8] text-slate-900',
      fontFamily: 'font-serif',
      ttsRate: 1.0,
      showOriginal: false,
      isAutoScrollActive: true
  });

  const [isTTSPlaying, setIsTTSPlaying] = useState<boolean>(false);
  const [activeTTSIndex, setActiveTTSIndex] = useState<number>(-1);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string | null>(null);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const readerScrollRef = useRef<HTMLDivElement>(null);

  // Sync API Key to Environment and Storage
  useEffect(() => {
    if (userApiKey) {
        localStorage.setItem('user_gemini_api_key', userApiKey);
        // @ts-ignore
        process.env.API_KEY = userApiKey;
    }
  }, [userApiKey]);

  useEffect(() => {
      if (isTTSPlaying && activeTTSIndex !== -1 && readerScrollRef.current && readerSettings.isAutoScrollActive) {
          const activeElement = readerScrollRef.current.querySelector(`[data-index="${activeTTSIndex}"]`);
          if (activeElement) {
              activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
      }
  }, [activeTTSIndex, isTTSPlaying, readerSettings.isAutoScrollActive]);

  const [visibleOriginalIndices, setVisibleOriginalIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);
      if (voices.length > 0 && !selectedVoiceName) {
          const viVoice = voices.find(v => v.lang.includes('vi')) || voices[0];
          setSelectedVoiceName(viVoice.name);
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, [selectedVoiceName]);

  useEffect(() => {
    getAllProjects().then(setProjects);
  }, []);

  useEffect(() => {
    if (currentProject?.readerSettings) {
        setReaderSettings(prev => ({...prev, ...currentProject.readerSettings}));
    }
  }, [currentProjectId]);

  const persistProject = async (project: StoryProject) => {
    setIsSaving(true);
    try {
      await saveProject(project);
    } catch (e) { console.error(e); } finally { setIsSaving(false); }
  };

  useEffect(() => {
    if (currentProject) persistProject(currentProject);
  }, [currentProject?.lastModified]);

  const addToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };

  const createNewProject = () => {
    const newProject: StoryProject = {
      id: crypto.randomUUID(),
      info: { title: 'Truyện mới ' + (projects.length + 1), author: '', languages: ['Convert thô'], genres: ['Tiên Hiệp'], mcPersonality: [], worldSetting: [], sectFlow: [] },
      chapters: [],
      promptTemplate: DEFAULT_PROMPT,
      dictionary: '',
      globalContext: '',
      createdAt: Date.now(),
      lastModified: Date.now()
    };
    setProjects(prev => [newProject, ...prev]);
    setCurrentProjectId(newProject.id);
    setIsSidebarOpen(false);
  };

  const updateProject = (id: string, updates: Partial<StoryProject>) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates, lastModified: Date.now() } : p));
  };

  const handleLinkSubmit = async () => {
    if (!currentProject) return;
    const urls = linkInput.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
    if (urls.length === 0) {
        addToast("Vui lòng dán link truyện hợp lệ", "warning");
        return;
    }

    setIsFetchingLinks(true);
    stopCrawlRef.current = false;
    let updatedChapters = [...currentProject.chapters];
    let addedCount = 0;
    
    try {
      let currentUrl: string | null = urls[0];
      setFetchProgress({ current: 0, total: crawlLimit });
      
      for (let i = 0; i < crawlLimit; i++) {
          if (!currentUrl || stopCrawlRef.current) break;
          
          try {
            const { title, content, nextUrl } = await fetchContentFromUrl(currentUrl);
            if (!updatedChapters.some(c => c.name === title)) {
                updatedChapters.push({ 
                    id: crypto.randomUUID(), 
                    name: title, 
                    content, 
                    translatedContent: null, 
                    status: FileStatus.IDLE, 
                    retryCount: 0, 
                    originalCharCount: content.length, 
                    remainingRawCharCount: 0 
                });
                addedCount++;
            }
            setFetchProgress({ current: i + 1, total: crawlLimit });
            currentUrl = nextUrl;
            updateProject(currentProject.id, { 
                chapters: [...updatedChapters], 
                lastCrawlUrl: currentUrl || undefined 
            });
            await new Promise(r => setTimeout(r, 1200));
          } catch (fetchErr: any) {
              if (autoCrawl) break;
          }
      }
      if (addedCount > 0) addToast(`Đã cào thêm ${addedCount} chương`, "success");
    } catch (e: any) { 
        addToast(e.message, 'error'); 
    } finally { 
        setIsFetchingLinks(false); 
        setFetchProgress(null); 
        setShowLinkModal(false); 
        setLinkInput("");
    }
  };

  const deleteChapter = (chapterId: string) => {
    if (!currentProject) return;
    const updatedChapters = currentProject.chapters.filter(c => c.id !== chapterId);
    updateProject(currentProject.id, { chapters: updatedChapters });
  };

  const handleStartTranslateRequest = () => {
      if (!userApiKey) {
          addToast("Vui lòng cấu hình API Key trong phần Cài đặt trước khi dịch", "error");
          setShowSettings(true);
          return;
      }
      if (!currentProject) return;
      if (!currentProject.globalContext || currentProject.globalContext.length < 50) {
          setShowContextSetup(true);
      } else {
          startTranslation(false);
      }
  };

  const startTranslation = (continuous: boolean = false) => {
    if (!currentProject) return;
    const idleChapters = currentProject.chapters
        .filter(c => c.status === FileStatus.IDLE || c.status === FileStatus.ERROR)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (idleChapters.length === 0) {
        addToast("Không còn chương nào cần dịch", "info");
        return;
    }
    setIsContinuousFlow(continuous);
    processingProjectIdRef.current = currentProject.id;
    setProcessingQueue(idleChapters.map(c => c.id));
    setIsProcessing(true);
  };

  const stopTranslation = () => {
      setIsProcessing(false);
      setIsContinuousFlow(false);
      setProcessingQueue([]);
      processingProjectIdRef.current = null;
  };

  const handleExport = async (format: 'epub' | 'txt') => {
    if (!currentProject) return;
    const completedChapters = currentProject.chapters.filter(c => c.status === FileStatus.COMPLETED);
    if (completedChapters.length === 0) {
        addToast("Chưa có chương nào dịch xong để xuất", "warning");
        return;
    }
    try {
      if (format === 'epub') {
        const blob = await generateEpub(currentProject.chapters, currentProject.info, null);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${currentProject.info.title}.epub`; a.click();
      } else {
        const content = createMergedFile(currentProject.chapters);
        downloadTextFile(`${currentProject.info.title}.txt`, content);
      }
    } catch (e: any) { addToast(e.message, 'error'); }
  };

  const handleAnalyzeContext = async () => {
      if (!userApiKey) {
          addToast("Vui lòng cấu hình API Key trước", "error");
          setShowSettings(true);
          return;
      }
      if (!currentProject || isAnalyzing) return;
      setIsAnalyzing(true);
      try {
          const context = await analyzeStoryContext(currentProject.chapters.slice(0, 10), currentProject.info);
          updateProject(currentProject.id, { globalContext: context });
          addToast("AI đã lập bối cảnh thành công", "success");
      } catch (e: any) { addToast(e.message, 'error'); } finally { setIsAnalyzing(false); }
  };

  useEffect(() => {
    if (!isProcessing || processingQueue.length === 0 || activeWorkers >= MAX_CONCURRENCY || !currentProjectId) return;
    const processBatch = async () => {
        const batchIds = processingQueue.slice(0, BATCH_FILE_LIMIT);
        const targetProjectId = currentProjectId;
        setProcessingQueue(prev => prev.slice(BATCH_FILE_LIMIT));
        setActiveWorkers(prev => prev + 1);
        setProjects(prev => prev.map(p => p.id === targetProjectId ? { ...p, chapters: p.chapters.map(c => batchIds.includes(c.id) ? { ...c, status: FileStatus.PROCESSING } : c) } : p));
        const targetProj = projects.find(p => p.id === targetProjectId);
        if (!targetProj) { setActiveWorkers(prev => prev - 1); return; }
        try {
            const { results, model } = await translateBatch(targetProj.chapters.filter(c => batchIds.includes(c.id)), replacePromptVariables(targetProj.promptTemplate, targetProj.info), targetProj.dictionary, targetProj.globalContext, MODEL_CONFIGS.map(m => m.id));
            setProjects(prev => prev.map(p => p.id === targetProjectId ? { ...p, lastModified: Date.now(), chapters: p.chapters.map(c => batchIds.includes(c.id) ? { ...c, status: results.get(c.id) ? FileStatus.COMPLETED : FileStatus.ERROR, translatedContent: results.get(c.id) || null, usedModel: model } : c) } : p));
        } catch (e) {
            setProjects(prev => prev.map(p => p.id === targetProjectId ? { ...p, chapters: p.chapters.map(c => batchIds.includes(c.id) ? { ...c, status: FileStatus.ERROR } : c) } : p));
        } finally { setActiveWorkers(prev => prev - 1); }
    };
    processBatch();
  }, [isProcessing, processingQueue, activeWorkers, currentProjectId]);

  const sortedChapters = useMemo(() => {
    if (!currentProject) return [];
    return [...currentProject.chapters].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [currentProject]);

  // Define stats to fix the error and track project progress
  const stats = useMemo(() => {
    if (!currentProject) return { total: 0, done: 0 };
    return {
      total: currentProject.chapters.length,
      done: currentProject.chapters.filter(c => c.status === FileStatus.COMPLETED).length
    };
  }, [currentProject]);

  const viewingChapter = useMemo(() => {
    return sortedChapters.find(c => c.id === viewingFileId) || null;
  }, [sortedChapters, viewingFileId]);

  const handleNextChapter = useCallback(() => {
    const currentIndex = sortedChapters.findIndex(c => c.id === viewingFileId);
    if (currentIndex < sortedChapters.length - 1) {
        setViewingFileId(sortedChapters[currentIndex + 1].id);
        setVisibleOriginalIndices(new Set());
        if (readerScrollRef.current) readerScrollRef.current.scrollTop = 0;
        return true;
    }
    return false;
  }, [sortedChapters, viewingFileId]);

  const handlePrevChapter = useCallback(() => {
    const currentIndex = sortedChapters.findIndex(c => c.id === viewingFileId);
    if (currentIndex > 0) {
        setViewingFileId(sortedChapters[currentIndex - 1].id);
        setVisibleOriginalIndices(new Set());
        if (readerScrollRef.current) readerScrollRef.current.scrollTop = 0;
        return true;
    }
    return false;
  }, [sortedChapters, viewingFileId]);

  const stopTTS = useCallback(() => {
    window.speechSynthesis.cancel();
    setIsTTSPlaying(false);
    setActiveTTSIndex(-1);
    currentUtteranceRef.current = null;
  }, []);

  const playTTS = useCallback((text: string) => {
    if (!text) return;
    stopTTS();
    const chunks = text.split('\n').filter(line => line.trim().length > 0);
    let currentChunkIndex = 0;
    const speakChunk = () => {
        if (currentChunkIndex >= chunks.length) {
            if (!handleNextChapter()) stopTTS();
            return;
        }
        setActiveTTSIndex(currentChunkIndex);
        const utterance = new SpeechSynthesisUtterance(chunks[currentChunkIndex]);
        const voice = availableVoices.find(v => v.name === selectedVoiceName);
        if (voice) utterance.voice = voice;
        utterance.rate = readerSettings.ttsRate || 1.0;
        utterance.onend = () => { currentChunkIndex++; speakChunk(); };
        utterance.onerror = () => stopTTS();
        currentUtteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
    };
    setIsTTSPlaying(true);
    speakChunk();
  }, [availableVoices, selectedVoiceName, readerSettings.ttsRate, handleNextChapter, stopTTS]);

  const toggleParagraphOriginal = (index: number) => {
      if (!readerSettings.showOriginal) return;
      setVisibleOriginalIndices(prev => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
      });
  };

  const contextStatus = useMemo(() => {
      if (isAnalyzing) return { text: "Đang phân tích...", icon: <Loader2 className="w-4 h-4 animate-spin" />, color: "bg-blue-50 text-blue-600 border-blue-200" };
      // Use AlertTriangle icon for context warning
      if (!currentProject?.globalContext || currentProject.globalContext.trim().length === 0) 
          return { text: "Thiếu bối cảnh", icon: <AlertTriangle className="w-4 h-4" />, color: "bg-amber-50 text-amber-600 border-amber-200" };
      return { text: "Đã có bối cảnh", icon: <CheckCircle className="w-4 h-4" />, color: "bg-emerald-50 text-emerald-600 border-emerald-200" };
  }, [currentProject?.globalContext, isAnalyzing]);

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 w-72 bg-white border-r border-slate-200 flex flex-col shrink-0 z-50 transition-transform duration-300 lg:relative lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-white/80 backdrop-blur-md">
            <div className="flex items-center gap-2">
                <div className="p-1.5 bg-sky-500 rounded-lg text-white shadow-md"><Zap className="w-4 h-4" /></div>
                <h1 className="font-bold text-base tracking-tight">Dịch Truyện Pro</h1>
            </div>
            {/* Fix: X icon for mobile sidebar toggle */}
            <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden p-2 text-slate-400"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <div className="flex justify-between items-center px-2 mb-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase">Dự án ({projects.length})</span>
                {/* Fix: PlusCircle icon for new project button */}
                <button onClick={createNewProject} className="p-1 text-sky-600 hover:bg-sky-50 rounded-lg" title="Thêm dự án"><PlusCircle className="w-4 h-4" /></button>
            </div>
            {projects.map(p => (
                <div key={p.id} onClick={() => { setCurrentProjectId(p.id); setIsSidebarOpen(false); }} className={`group p-3.5 rounded-xl cursor-pointer border transition-all ${currentProjectId === p.id ? 'bg-sky-50 border-sky-200' : 'bg-white border-transparent hover:bg-slate-50'}`}>
                    <div className="flex justify-between items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <h4 className="font-bold text-xs truncate">{p.info.title}</h4>
                            {/* Fix: History icon for project list */}
                            <p className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1"><History className="w-2.5 h-2.5" /> {new Date(p.lastModified).toLocaleDateString()}</p>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); if(confirm("Xóa dự án này?")) deleteProject(p.id).then(() => setProjects(prev => prev.filter(x => x.id !== p.id))); }} className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                </div>
            ))}
        </div>
        <div className="p-4 border-t border-slate-100">
            <button onClick={() => setShowSettings(true)} className="w-full flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl transition-all font-medium text-xs">
                <Settings className={`w-4 h-4 ${!userApiKey ? 'text-rose-500 animate-pulse' : ''}`} />
                <span>Cài đặt { !userApiKey && "(Cần nhập Key)"}</span>
            </button>
        </div>
      </aside>

      {isSidebarOpen && <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden" onClick={() => setIsSidebarOpen(false)} />}

      <main className="flex-1 flex flex-col overflow-hidden relative">
          {currentProject ? (
            <>
              <header className="h-16 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between shrink-0 z-10">
                  <div className="flex items-center gap-3 min-w-0">
                      <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 hover:bg-slate-50 rounded-xl"><Menu className="w-5 h-5" /></button>
                      <div className="flex flex-col min-w-0">
                          <input className="bg-transparent font-bold text-sm lg:text-base outline-none truncate" value={currentProject.info.title} onChange={e => updateProject(currentProject.id, { info: { ...currentProject.info, title: e.target.value } })} />
                          <div className="flex items-center gap-2 text-[9px] lg:text-[10px] text-slate-400">
                              <span className="flex items-center gap-1"><Book className="w-2.5 h-2.5" /> {currentProject.chapters.length}</span>
                              {/* Fix: stats variable used for done count */}
                              <span className="text-emerald-500 font-bold"><CheckCircle className="w-2.5 h-2.5 inline" /> {stats.done} xong</span>
                          </div>
                      </div>
                  </div>
                  <div className="flex items-center gap-2">
                      <button onClick={() => setShowContextSetup(true)} className={`hidden sm:flex items-center gap-2 px-3 py-1.5 border rounded-lg font-bold text-[10px] transition-all ${contextStatus.color}`}>
                          {contextStatus.icon} <span>{contextStatus.text}</span>
                      </button>
                      <button onClick={() => isProcessing ? stopTranslation() : handleStartTranslateRequest()} className={`px-4 py-1.5 rounded-lg font-bold text-[10px] shadow-sm ${isProcessing ? 'bg-rose-500 text-white' : 'bg-sky-500 text-white'}`}>
                          {isProcessing ? 'Dừng' : 'Dịch'}
                      </button>
                      <button onClick={() => handleExport('epub')} className="p-2 text-slate-400 hover:bg-slate-100 rounded-lg"><Download className="w-4 h-4" /></button>
                  </div>
              </header>

              <div className="flex-1 flex flex-col p-4 lg:p-6 overflow-hidden">
                    <div className="mb-4 flex gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                            <input className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-sky-100" placeholder="Tìm chương..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
                        </div>
                        <button onClick={() => setShowLinkModal(true)} className="flex items-center gap-2 px-4 py-2 bg-sky-50 text-sky-600 border border-sky-100 rounded-xl font-bold text-xs hover:bg-sky-100">
                            <Link2 className="w-4 h-4" /> <span className="hidden sm:inline">Cào truyện</span>
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 content-start pb-20">
                        {currentProject.chapters.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(ch => (
                            <div key={ch.id} className={`p-3.5 rounded-2xl border transition-all flex flex-col gap-2 relative ${ch.status === FileStatus.COMPLETED ? 'bg-emerald-50/10 border-emerald-100' : ch.status === FileStatus.PROCESSING ? 'bg-sky-50/30 border-sky-100 animate-pulse' : 'bg-white border-slate-100'}`}>
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <div className={`p-2 rounded-xl shrink-0 ${ch.status === FileStatus.COMPLETED ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                                            {ch.status === FileStatus.PROCESSING ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                                        </div>
                                        <div className="min-w-0">
                                            <h5 className="font-bold text-[11px] truncate leading-tight">{ch.name}</h5>
                                            <p className="text-[9px] text-slate-400 mt-0.5">{ch.originalCharCount} ký tự</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center">
                                        <button onClick={() => setViewingFileId(ch.id)} className="p-1.5 text-slate-400 hover:text-sky-500 rounded-lg"><Eye className="w-3.5 h-3.5" /></button>
                                        <button onClick={() => deleteChapter(ch.id)} className="p-1.5 text-slate-300 hover:text-rose-500 rounded-lg"><Trash2 className="w-3.5 h-3.5" /></button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-white">
                <div className="max-w-md w-full space-y-8 animate-in fade-in duration-700">
                    <div className="relative mx-auto w-24 h-24 mb-6">
                        <div className="absolute inset-0 bg-sky-500/20 blur-2xl rounded-full animate-pulse"></div>
                        <div className="relative w-full h-full bg-gradient-to-br from-sky-400 to-sky-600 rounded-3xl flex items-center justify-center text-white shadow-xl">
                            <Sparkles className="w-12 h-12" />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <h2 className="text-3xl font-black tracking-tight text-slate-900">Dịch Truyện AI</h2>
                        <p className="text-slate-500 text-sm leading-relaxed">Nền tảng dịch truyện lậu mượt mà nhất. Sử dụng công nghệ Gemini 3.0 để tối ưu văn phong thuần Việt.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                        <button onClick={createNewProject} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold shadow-lg hover:translate-y-[-2px] transition-all flex items-center justify-center gap-2">
                            <Plus className="w-5 h-5" /> Bắt đầu Dự án Mới
                        </button>
                        <button onClick={() => setShowSettings(true)} className="w-full py-4 bg-white border border-slate-200 text-slate-700 rounded-2xl font-bold hover:bg-slate-50 transition-all flex items-center justify-center gap-2">
                            <Key className="w-4 h-4" /> Cấu hình API Key
                        </button>
                    </div>
                    <div className="pt-8 border-t border-slate-100 flex items-center justify-center gap-6">
                        <a href="https://ai.google.dev/" target="_blank" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest hover:text-sky-500 transition-all flex items-center gap-1.5"><ExternalLink className="w-3 h-3" /> Lấy API Key Miễn phí</a>
                    </div>
                </div>
            </div>
          )}
      </main>

      {/* Reader Modal */}
      {viewingChapter && (
          <div className={`fixed inset-0 z-[100] flex flex-col animate-in fade-in duration-300 ${readerSettings.bgColor}`}>
             <header className="sticky top-0 h-14 px-4 border-b flex items-center justify-between shrink-0 bg-black/5 backdrop-blur-md z-20 py-2">
                <div className="flex items-center gap-2 min-w-0">
                    <button onClick={() => { stopTTS(); setViewingFileId(null); }} className="p-2 hover:bg-black/10 rounded-lg text-slate-500"><SkipBack className="w-4 h-4 rotate-90" /></button>
                    <h3 className="font-bold text-xs lg:text-sm truncate">{viewingChapter.name}</h3>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-black/5 rounded-lg p-1">
                        <button onClick={handlePrevChapter} className="p-1.5 hover:bg-black/10 rounded-md text-slate-600 disabled:opacity-30" disabled={sortedChapters.indexOf(viewingChapter) === 0}><SkipBack className="w-3.5 h-3.5" /></button>
                        <span className="text-[10px] font-bold px-1">{sortedChapters.indexOf(viewingChapter) + 1}/{sortedChapters.length}</span>
                        <button onClick={handleNextChapter} className="p-1.5 hover:bg-black/10 rounded-md text-slate-600 disabled:opacity-30" disabled={sortedChapters.indexOf(viewingChapter) === sortedChapters.length - 1}><SkipForward className="w-3.5 h-3.5" /></button>
                    </div>
                    <button onClick={() => isTTSPlaying ? stopTTS() : playTTS(viewingChapter.translatedContent || "")} className={`p-2 rounded-lg ${isTTSPlaying ? 'bg-sky-500 text-white' : 'bg-sky-500/10 text-sky-600'}`}>
                        {isTTSPlaying ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </button>
                    <button onClick={() => setViewingFileId(null)} className="p-2 bg-rose-50 text-rose-500 rounded-lg"><LogOut className="w-4 h-4" /></button>
                </div>
             </header>

             <div ref={readerScrollRef} className="flex-1 overflow-y-auto p-5 lg:p-10 scroll-smooth">
                <div className={`max-w-2xl mx-auto space-y-6 ${readerSettings.fontFamily}`} style={{ fontSize: `${readerSettings.fontSize}px` }}>
                    {viewingChapter.translatedContent ? (
                        viewingChapter.translatedContent.split('\n').filter(l => l.trim().length > 0).map((p, i) => (
                            <div key={i} data-index={i} onClick={() => toggleParagraphOriginal(i)} className={`p-2 rounded-xl transition-all relative cursor-pointer group hover:bg-black/5 ${activeTTSIndex === i ? 'bg-sky-500/10 ring-1 ring-sky-500/20' : ''}`}>
                                <p className="leading-relaxed whitespace-pre-wrap">{p}</p>
                            </div>
                        ))
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
                            {/* Fix: Hourglass icon for loading state */}
                            <Hourglass className="w-8 h-8 animate-pulse" />
                            <p className="text-sm italic">Đang đợi bản dịch...</p>
                        </div>
                    )}
                    <div className="h-64" />
                </div>
             </div>
          </div>
      )}

      {/* Settings Modal (API Key Management) */}
      {showSettings && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
              <div className="bg-white rounded-[28px] shadow-2xl w-full max-md overflow-hidden animate-in zoom-in-95">
                  <div className="p-6 lg:p-8 space-y-6">
                      <div className="flex items-center gap-4">
                          <div className="p-3 bg-slate-900 text-white rounded-2xl shadow-lg"><Settings className="w-6 h-6" /></div>
                          <div><h3 className="text-xl font-bold">Cài đặt</h3><p className="text-xs text-slate-500 font-medium">Cấu hình API Key để sử dụng dịch thuật.</p></div>
                      </div>
                      <div className="space-y-4">
                          <div className="space-y-2">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Gemini API Key</label>
                              <div className="relative">
                                  <input 
                                    type="password" 
                                    className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-sky-500 outline-none pr-12 font-mono" 
                                    placeholder="Dán key của bạn vào đây..."
                                    value={userApiKey}
                                    onChange={(e) => setUserApiKey(e.target.value)}
                                  />
                                  <div className="absolute right-4 top-1/2 -translate-y-1/2">
                                      {userApiKey ? <CheckCircle className="w-5 h-5 text-emerald-500" /> : <Key className="w-5 h-5 text-slate-300" />}
                                  </div>
                              </div>
                              <a href="https://aistudio.google.com/app/apikey" target="_blank" className="flex items-center gap-1.5 text-[10px] text-sky-600 font-bold hover:underline px-1"><HelpCircle className="w-3 h-3" /> Hướng dẫn lấy Key miễn phí (Google AI Studio)</a>
                          </div>
                          <div className="p-4 bg-amber-50 border border-amber-100 rounded-2xl space-y-2">
                              <h4 className="text-[10px] font-bold text-amber-700 uppercase">Lưu ý bảo mật</h4>
                              <p className="text-[10px] text-amber-600 leading-relaxed font-medium">Key của bạn được lưu trực tiếp tại trình duyệt (Local Storage). Chúng tôi không thu thập hoặc lưu trữ Key của bạn trên bất kỳ máy chủ nào khác.</p>
                          </div>
                      </div>
                      <button onClick={() => setShowSettings(false)} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold text-sm shadow-xl active:scale-95 transition-all">Lưu và Đóng</button>
                  </div>
              </div>
          </div>
      )}

      {/* Crawl Modal */}
      {showLinkModal && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
              <div className="bg-white rounded-[28px] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95">
                  <div className="p-6 lg:p-8 space-y-6">
                      <div className="flex items-center gap-4">
                          <div className="p-3 bg-sky-100 text-sky-600 rounded-2xl"><Link2 className="w-6 h-6" /></div>
                          <div><h3 className="text-xl font-bold">Cào Truyện</h3><p className="text-xs text-slate-500 font-medium">Tự động lấy nội dung từ các trang web truyện.</p></div>
                      </div>
                      <textarea className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-sky-500" placeholder="Dán link chương đầu tiên..." value={linkInput} onChange={e => setLinkInput(e.target.value)} />
                      <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                          <span className="text-xs font-bold text-slate-600">Số chương muốn lấy:</span>
                          <input type="number" className="w-16 p-2 bg-white border rounded-xl text-xs text-center font-bold" value={crawlLimit} onChange={e => setCrawlLimit(Math.max(1, parseInt(e.target.value) || 0))} />
                      </div>
                      {fetchProgress && (
                          <div className="space-y-2">
                              <div className="flex justify-between text-[9px] font-bold text-slate-500 uppercase">
                                  <span>Tiến độ: {fetchProgress.current}/{fetchProgress.total}</span>
                                  <button onClick={() => { stopCrawlRef.current = true; }} className="text-rose-500">Dừng</button>
                              </div>
                              <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-sky-500 transition-all" style={{ width: `${(fetchProgress.current / fetchProgress.total) * 100}%` }} /></div>
                          </div>
                      )}
                      <div className="flex gap-3 pt-2">
                          <button onClick={() => setShowLinkModal(false)} className="flex-1 py-4 font-bold text-slate-400 text-sm hover:bg-slate-50 rounded-2xl transition-all">Hủy</button>
                          <button onClick={handleLinkSubmit} disabled={isFetchingLinks || !linkInput} className="flex-[2] py-4 bg-sky-500 text-white rounded-2xl font-bold text-sm shadow-lg disabled:opacity-50">Bắt đầu cào</button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Context Setup */}
      {showContextSetup && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
              <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-xl overflow-hidden animate-in zoom-in-95">
                  <div className="p-8 space-y-6">
                      <div className="flex items-center gap-4">
                          <div className="p-4 bg-emerald-100 text-emerald-600 rounded-3xl"><Brain className="w-8 h-8" /></div>
                          <div><h3 className="text-2xl font-bold">Bối cảnh truyện</h3><p className="text-sm text-slate-500">Giúp AI hiểu thế giới và xưng hô tốt hơn.</p></div>
                      </div>
                      <textarea className="w-full h-56 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm focus:ring-2 focus:ring-sky-500 outline-none resize-none" placeholder="Ví dụ: Truyện tiên hiệp, main tên Lâm Phong, tính cách cẩn trọng. Thế giới tu chân cấp độ: Luyện khí, Trúc cơ..." value={currentProject?.globalContext} onChange={(e) => updateProject(currentProject!.id, { globalContext: e.target.value })} />
                      <div className="flex gap-4">
                          <button onClick={() => startTranslation(false)} className="flex-1 py-4 font-bold text-slate-400 hover:bg-slate-50 rounded-2xl">Bỏ qua</button>
                          <button onClick={() => { startTranslation(false); }} className="flex-1 py-4 bg-emerald-500 text-white rounded-2xl font-bold shadow-lg hover:bg-emerald-600 transition-all">Lưu & Dịch</button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-4 left-4 sm:left-auto lg:right-6 z-[400] flex flex-col gap-3">
          {toasts.map(t => (
              <div key={t.id} className={`px-5 py-3.5 rounded-2xl shadow-xl border flex items-center gap-3 animate-in slide-in-from-bottom lg:slide-in-from-right backdrop-blur-md ${t.type === 'error' ? 'bg-rose-50/90 border-rose-100 text-rose-600' : 'bg-white/90 border-slate-200 text-slate-700'}`}>
                  {/* Fix: Info icon for generic toasts */}
                  {t.type === 'success' ? <CheckCircle className="w-4 h-4" /> : t.type === 'error' ? <AlertCircle className="w-4 h-4" /> : <Info className="w-4 h-4" />}
                  <span className="font-bold text-xs">{t.message}</span>
              </div>
          ))}
      </div>
    </div>
  );
};

export default App;
