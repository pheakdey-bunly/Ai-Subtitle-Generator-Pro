import { useState, useCallback, useRef, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  FileVideo, 
  FileAudio,
  Upload, 
  Download, 
  Languages, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  FileText,
  Play,
  ShieldCheck,
  HardDrive,
  Trash2,
  Info,
  Music,
  Copy,
  Settings2,
  ChevronRight,
  Cpu,
  Plus,
  Archive,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { 
  Sheet, 
  SheetContent, 
  SheetDescription, 
  SheetHeader, 
  SheetTitle
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { generateSubtitles } from './lib/gemini';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

const LANGUAGES = [
  { label: 'English', value: 'English' },
  { label: 'Khmer (ខ្មែរ)', value: 'Khmer' },
  { label: 'Chinese (中文)', value: 'Chinese' },
  { label: 'Japanese (日本語)', value: 'Japanese' },
  { label: 'Korean (한국어)', value: 'Korean' },
  { label: 'French (Français)', value: 'French' },
  { label: 'Spanish (Español)', value: 'Spanish' },
];

// Helper to extract audio from video on the client side
// This helps bypass server-side payload limits (413 Payload Too Large)
async function extractAudioFromVideo(videoFile: File): Promise<Blob> {
  return new Promise(async (resolve, reject) => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const arrayBuffer = await videoFile.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Basic WAV encoding logic in a worker to keep UI responsive
      const workerCode = `
        self.onmessage = function(e) {
          const buffer = e.data;
          const length = buffer[0].length * 2;
          const result = new DataView(new ArrayBuffer(44 + length));
          
          function writeString(view, offset, string) {
            for (let i = 0; i < string.length; i++) {
              view.setUint8(offset + i, string.charCodeAt(i));
            }
          }
          
          writeString(result, 0, 'RIFF');
          result.setUint32(4, 36 + length, true);
          writeString(result, 8, 'WAVE');
          writeString(result, 12, 'fmt ');
          result.setUint32(16, 16, true);
          result.setUint16(20, 1, true);
          result.setUint16(22, 1, true);
          result.setUint32(24, 44100, true);
          result.setUint32(28, 44100 * 2, true);
          result.setUint16(32, 2, true);
          result.setUint16(34, 16, true);
          writeString(result, 36, 'data');
          result.setUint32(40, length, true);
          
          let offset = 44;
          for (let i = 0; i < buffer[0].length; i++) {
            const sample = Math.max(-1, Math.min(1, buffer[0][i]));
            result.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
          }
          
          self.postMessage(result.buffer, [result.buffer]);
        };
      `;
      
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const encoder = new Worker(workerUrl);
      
      encoder.onmessage = (e) => {
        const wavBlob = new Blob([e.data], { type: 'audio/wav' });
        URL.revokeObjectURL(workerUrl);
        encoder.terminate();
        resolve(wavBlob);
      };
      
      encoder.onerror = reject;
      
      // We take the first channel for transcription
      const channelData = audioBuffer.getChannelData(0);
      encoder.postMessage([channelData], [channelData.buffer]);
      
    } catch (error) {
      reject(error);
    }
  });
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [processingFiles, setProcessingFiles] = useState<Set<string>>(new Set());
  const [fileProgress, setFileProgress] = useState<Record<string, number>>({});
  const [srtResults, setSrtResults] = useState<Record<string, string>>({});
  const [targetLanguage, setTargetLanguage] = useState(() => localStorage.getItem('targetLanguage') || 'Khmer');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [detectGender, setDetectGender] = useState(() => {
    const saved = localStorage.getItem('detectGender');
    return saved === 'true';
  });
  const [autoDownload, setAutoDownload] = useState(() => {
    const saved = localStorage.getItem('autoDownload');
    return saved !== null ? saved === 'true' : true;
  });
  const [isInsideIframe, setIsInsideIframe] = useState(false);
  const [showCookieModal, setShowCookieModal] = useState(false);

  useEffect(() => {
    try {
      if (window.self !== window.top) {
        setIsInsideIframe(true);
      }
    } catch (e) {
      setIsInsideIframe(true);
    }
  }, []);

  // Refs to avoid stale closures in async functions
  const srtResultsRef = useRef(srtResults);
  const processingFilesRef = useRef(processingFiles);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    srtResultsRef.current = srtResults;
  }, [srtResults]);

  useEffect(() => {
    processingFilesRef.current = processingFiles;
  }, [processingFiles]);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('targetLanguage', targetLanguage);
  }, [targetLanguage]);

  useEffect(() => {
    localStorage.setItem('autoDownload', String(autoDownload));
  }, [autoDownload]);

  useEffect(() => {
    localStorage.setItem('detectGender', String(detectGender));
  }, [detectGender]);

  // Persist SRT results
  useEffect(() => {
    const savedResults = localStorage.getItem('srtResults');
    if (savedResults) {
      try {
        setSrtResults(JSON.parse(savedResults));
      } catch (e) {
        console.error("Failed to load saved results", e);
      }
    }
  }, []);

  useEffect(() => {
    if (Object.keys(srtResults).length > 0) {
      localStorage.setItem('srtResults', JSON.stringify(srtResults));
    }
  }, [srtResults]);

  const processFile = async (file: File) => {
    if (processingFilesRef.current.has(file.name) || srtResultsRef.current[file.name]) return;

    setProcessingFiles(prev => new Set(prev).add(file.name));
    setFileProgress(prev => ({ ...prev, [file.name]: 10 }));
    
    try {
      let fileToSend: File | Blob = file;
      
      // If video is large (> 15MB), extract audio to avoid 413 Payload Too Large
      if (file.type.startsWith('video/') && file.size > 15 * 1024 * 1024) {
        toast.info(`វីដេអូមានទំហំធំ (${(file.size / 1024 / 1024).toFixed(1)}MB)។ កំពុងស្រង់យកតែសំឡេងដើម្បីបង្កើនល្បឿន...`, { duration: 3000 });
        setFileProgress(prev => ({ ...prev, [file.name]: 15 }));
        try {
          fileToSend = await extractAudioFromVideo(file);
          // Set a meaningful name for the extracted audio
          (fileToSend as any).name = file.name.replace(/\.[^/.]+$/, "") + ".wav";
        } catch (audioErr) {
          console.error("Audio extraction failed, trying original file", audioErr);
        }
      }

      setFileProgress(prev => ({ ...prev, [file.name]: 20 }));
      
      let accumulatedResult = "";
      const result = await generateSubtitles(
        fileToSend as File, 
        targetLanguage, 
        detectGender,
        (chunk) => {
          accumulatedResult += chunk;
          setSrtResults(prev => ({ ...prev, [file.name]: accumulatedResult }));
          // Smoothly advance progress as we get chunks
          setFileProgress(prev => ({ 
            ...prev, 
            [file.name]: Math.min(95, (prev[file.name] || 10) + 0.5) 
          }));
        }
      );
      
      let finalResult = result;
      if (finalResult.includes('```')) {
        finalResult = finalResult.replace(/```[a-z]*\n/g, '').replace(/```/g, '').trim();
      }

      setSrtResults(prev => ({ ...prev, [file.name]: finalResult }));
      setFileProgress(prev => ({ ...prev, [file.name]: 100 }));
      
      if (autoDownload) {
        downloadSRT(file, finalResult);
      }
      
      toast.success(`បកប្រែ ${file.name} បានជោគជ័យ`);
    } catch (error: any) {
      console.error(error);
      const errorMsg = error?.message?.toLowerCase() || "";
      const isCookieError = errorMsg.includes('cookie') || errorMsg.includes('iframe') || errorMsg.includes('third-party') || errorMsg.includes('រារាំងដោយសារលក្ខខណ្ឌ cookie') || errorMsg.includes('invalid response body start') || errorMsg.includes('cookie check') || errorMsg.includes('<!doctype html>');
      const isRateLimit = errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.includes('resource_exhausted');
      const isHighDemand = errorMsg.includes('503') || errorMsg.includes('unavailable') || errorMsg.includes('high demand');

      if (isCookieError) {
        setShowCookieModal(true);
        toast.error(`⚠️ ដំណើរការបកប្រែត្រូវបានរារាំងដោយសារ iframe/Cookie! សូមចុច "បើកក្នុង Tab ថ្មី" ដើម្បីបន្ត។`, {
          duration: 8000
        });
      } else if (isRateLimit) {
        toast.error(`ជាប់ដែនកំណត់ (Rate Limit) សម្រាប់ ${file.name}។ ប្រសិនបើអ្នកប្រើគណនីឥតគិតថ្លៃ សូមរង់ចាំបន្តិច។`, {
          duration: 5000
        });
      } else if (isHighDemand) {
        toast.error(`ម៉ូដែល AI កំពុងមានអ្នកប្រើប្រាស់ច្រើន (High Demand)។ សូមព្យាយាមម្តងទៀតក្នុងពេលឆាប់ៗនេះ។`, {
          duration: 5000
        });
      } else {
        toast.error(`មានបញ្ហាក្នុងការបកប្រែ ${file.name}: ${error.message}`);
      }
    } finally {
      setProcessingFiles(prev => {
        const next = new Set(prev);
        next.delete(file.name);
        return next;
      });
    }
  };

  const handleGenerateAll = useCallback(async (currentFiles: File[]) => {
    if (isProcessingRef.current) return;
    
    const filesToProcess = currentFiles.filter(f => !srtResultsRef.current[f.name] && !processingFilesRef.current.has(f.name));
    if (filesToProcess.length === 0) return;

    isProcessingRef.current = true;
    try {
      // Process sequentially to avoid hitting API rate limits or memory issues
      for (const file of filesToProcess) {
        // Re-check inside loop using ref to get the most up-to-date state
        if (!srtResultsRef.current[file.name]) {
          await processFile(file);
          // Reduced delay between files to increase speed (500ms)
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } finally {
      isProcessingRef.current = false;
    }
  }, [targetLanguage, autoDownload, detectGender]);

  // Automatic processing when files are added
  useEffect(() => {
    const filesToProcess = files.filter(f => !srtResults[f.name] && !processingFiles.has(f.name));
    if (filesToProcess.length > 0 && !isProcessingRef.current) {
      handleGenerateAll(files);
    }
  }, [files, srtResults, processingFiles, handleGenerateAll]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const newFiles = [...files];
      
      acceptedFiles.forEach(file => {
        if (!newFiles.find(f => f.name === file.name && f.size === file.size)) {
          newFiles.push(file);
        }
      });

      setFiles(newFiles);
      if (selectedFileIndex === null) setSelectedFileIndex(newFiles.length - acceptedFiles.length);
      toast.success(`បានភ្ជាប់ឯកសារចំនួន ${acceptedFiles.length} បន្ថែម`);
    }
  }, [files, selectedFileIndex]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'video/*': [], 'audio/*': [] },
    multiple: true
  } as any);

  const removeFile = (index: number) => {
    const fileToRemove = files[index];
    const newFiles = files.filter((_, i) => i !== index);

    const newSrtResults = { ...srtResults };
    delete newSrtResults[fileToRemove.name];

    const newProgress = { ...fileProgress };
    delete newProgress[fileToRemove.name];

    setFiles(newFiles);
    setSrtResults(newSrtResults);
    setFileProgress(newProgress);

    if (selectedFileIndex === index) {
      setSelectedFileIndex(newFiles.length > 0 ? 0 : null);
    } else if (selectedFileIndex !== null && selectedFileIndex > index) {
      setSelectedFileIndex(selectedFileIndex - 1);
    }
  };

  const clearAllFiles = () => {
    if (processingFiles.size > 0) {
      toast.error("សូមរង់ចាំការបកប្រែបញ្ចប់សិន មុននឹងលុបទាំងអស់");
      return;
    }
    setFiles([]);
    setSrtResults({});
    setFileProgress({});
    setSelectedFileIndex(null);
    localStorage.removeItem('srtResults');
    toast.success("បានលុបឯកសារទាំងអស់");
  };

  const copyToClipboard = (content: string) => {
    navigator.clipboard.writeText(content);
    toast.success("បានចម្លង");
  };

  const downloadSRT = (file: File, content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${file.name.split('.')[0]}_${targetLanguage}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllSRTs = async () => {
    const resultsCount = Object.keys(srtResults).length;
    if (resultsCount === 0) return;

    const zip = new JSZip();
    files.forEach(file => {
      if (srtResults[file.name]) {
        const fileName = `${file.name.split('.')[0]}_${targetLanguage}.srt`;
        zip.file(fileName, srtResults[file.name]);
      }
    });

    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitles_all_${targetLanguage}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("បានទាញយកឯកសារទាំងអស់ជា ZIP");
  };

  const selectedFile = selectedFileIndex !== null ? files[selectedFileIndex] : null;
  const selectedSrt = selectedFile ? srtResults[selectedFile.name] : null;
  const isAudio = selectedFile?.type.startsWith('audio/');
  const allFilesProcessed = files.length > 0 && files.every(f => srtResults[f.name]);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground font-sans p-4 md:p-8 dark relative overflow-hidden">
        {/* Decorative Background Elements */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
        
        <Toaster position="top-center" richColors />
        
        <div className="max-w-6xl mx-auto space-y-8 relative z-10">
          {isInsideIframe && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-5 flex flex-col gap-4 backdrop-blur-md"
            >
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold text-amber-500 text-sm">
                    ⚠️ ដំណើរការបកប្រែវីដេអូត្រូវបានរារាំងដោយសារ iFrame? (Browser Cookie Blocked Error)
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    ដោយសារសុវត្ថិភាព Browser និង Cookie Restrictions (Third-party cookie restriction) ដំណើរការបកប្រែនៅក្នុង Preview iFrame របស់ AI Studio នឹងត្រូវបានរារាំង។ ដើម្បីបន្តដំណើរការដោយរលូន សូមបើកកម្មវិធីនេះក្នុង Tab ថ្មី។
                  </p>
                  <p className="text-xs text-amber-500/80 leading-relaxed font-medium">
                    Requests are blocked due to third-party cookie restrictions inside the preview frame. Click the link/button below to open the app in a new tab!
                  </p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-2 mt-1 bg-background/50 p-2 rounded-lg border border-border">
                <div className="flex-1 w-full flex items-center gap-2 overflow-hidden px-2">
                  <span className="text-[10px] uppercase font-mono tracking-wider text-muted-foreground shrink-0">Direct URL:</span>
                  <input 
                    type="text" 
                    readOnly 
                    value={window.location.href} 
                    className="bg-transparent border-none text-xs font-mono text-foreground focus:outline-none focus:ring-0 w-full overflow-ellipsis"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs font-medium gap-1 w-full sm:w-auto"
                    onClick={() => {
                      navigator.clipboard.writeText(window.location.href);
                      toast.success("ចម្លងតំណភ្ជាប់ជោគជ័យ! Copied to clipboard!");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>ចម្លង / Copy URL</span>
                  </Button>
                  <a
                    href={window.location.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 text-xs font-bold gap-1.5 flex items-center justify-center bg-amber-600 hover:bg-amber-500 text-white rounded-md px-3 shrink-0 shadow-sm w-full sm:w-auto"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>បើកជា Tab ថ្មី / Open</span>
                  </a>
                </div>
              </div>
            </motion.div>
          )}

          <header className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">AI Subtitle Generator Pro</h1>
              <p className="text-muted-foreground text-sm">បកប្រែវីដេអូ និងសំឡេងច្រើនឯកសារក្នុងពេលតែមួយ</p>
            </div>
            <div className="flex gap-2">
              {Object.keys(srtResults).length > 0 && (
                <Button 
                  variant="default" 
                  size="sm" 
                  onClick={downloadAllSRTs}
                  className="gap-2 bg-green-600 hover:bg-green-700 text-white border-none shadow-lg shadow-green-900/20"
                >
                  <Archive className="w-4 h-4" />
                  ទាញយកទាំងអស់ ({Object.keys(srtResults).length})
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setIsSettingsOpen(true)} className="gap-2">
                <Settings2 className="w-4 h-4" />
                ភាសា: {targetLanguage}
              </Button>
            </div>
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Sidebar: File List */}
            <div className="lg:col-span-4 space-y-4">
              <Card className="bg-card border-border h-full flex flex-col max-h-[700px]">
                <CardHeader className="py-4 px-4 border-b border-border flex flex-row items-center justify-between">
                  <div className="flex flex-col">
                    <CardTitle className="text-sm font-bold">បញ្ជីឯកសារ ({files.length})</CardTitle>
                  </div>
                  <div className="flex gap-1">
                    {files.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger 
                          render={
                            <Button variant="ghost" size="icon" onClick={clearAllFiles} className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>លុបទាំងអស់</TooltipContent>
                      </Tooltip>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => (document.querySelector('input[type="file"]') as HTMLInputElement)?.click()} className="h-8 w-8">
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="p-0 flex-1 overflow-hidden flex flex-col">
                  <ScrollArea className="flex-1 h-[400px] lg:h-full">
                    <div className="p-2 space-y-2">
                      {files.length === 0 ? (
                        <div {...getRootProps()} className="p-8 border-2 border-dashed border-border rounded-lg text-center cursor-pointer hover:bg-accent/50 transition-colors">
                          <input {...getInputProps()} />
                          <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">ដាក់ឯកសារនៅទីនេះ</p>
                        </div>
                      ) : (
                        files.map((f, i) => (
                          <div 
                            key={f.name + i}
                            onClick={() => setSelectedFileIndex(i)}
                            className={`p-3 rounded-lg border cursor-pointer transition-all group relative ${selectedFileIndex === i ? 'bg-primary/10 border-primary' : 'bg-accent/30 border-transparent hover:border-border'}`}
                          >
                            <div className="flex items-center gap-3">
                              {f.type.startsWith('video/') ? <FileVideo className="w-4 h-4 text-primary" /> : <FileAudio className="w-4 h-4 text-primary" />}
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium truncate">{f.name}</p>
                                <p className="text-[10px] text-muted-foreground">{(f.size / (1024 * 1024)).toFixed(2)} MB</p>
                              </div>
                              {srtResults[f.name] ? (
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                              ) : processingFiles.has(f.name) ? (
                                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                              ) : null}
                            </div>
                            {processingFiles.has(f.name) && (
                              <Progress value={fileProgress[f.name]} className="h-0.5 mt-2" />
                            )}
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-background border border-border opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeFile(i);
                              }}
                            >
                              <Trash2 className="w-3 h-3 text-destructive" />
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                  {files.length > 0 && (
                    <div className="p-4 border-t border-border bg-accent/20 space-y-2">
                      <Button 
                        className="w-full font-bold" 
                        onClick={() => handleGenerateAll(files)}
                        disabled={processingFiles.size > 0 || allFilesProcessed}
                      >
                        {processingFiles.size > 0 ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                        {allFilesProcessed ? "បកប្រែរួចរាល់ទាំងអស់" : "បកប្រែទាំងអស់"}
                      </Button>
                      
                      {Object.keys(srtResults).length > 0 && (
                        <Button 
                          variant="outline"
                          className="w-full font-bold border-green-500/20 hover:bg-green-500/10 text-green-500" 
                          onClick={downloadAllSRTs}
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          ទាញយកទាំងអស់ (.zip)
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Main Content: Result */}
            <div className="lg:col-span-8 space-y-6">
              {selectedFile ? (
                <div className="grid grid-cols-1 gap-6">
                  {/* SRT Result Card */}
                  <Card className="bg-card border-border flex flex-col min-h-[500px]">
                    <CardHeader className="flex flex-row items-center justify-between py-3 px-4 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20">
                          {selectedFile.type.startsWith('audio/') ? "Audio" : "Video"}
                        </Badge>
                        <CardTitle className="text-sm font-medium truncate max-w-[300px]">{selectedFile.name}</CardTitle>
                      </div>
                      {selectedSrt && (
                        <div className="flex gap-2">
                          <Button variant="ghost" size="icon" onClick={() => copyToClipboard(selectedSrt)} className="h-8 w-8">
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => downloadSRT(selectedFile, selectedSrt)} className="h-8 gap-2">
                            <Download className="w-3.5 h-3.5" />
                            ទាញយក
                          </Button>
                        </div>
                      )}
                    </CardHeader>
                    <CardContent className="flex-1 p-0">
                      <ScrollArea className="h-[500px] w-full">
                        {selectedSrt ? (
                          <pre className="p-4 font-mono text-xs text-muted-foreground whitespace-pre-wrap">
                            {selectedSrt}
                          </pre>
                        ) : processingFiles.has(selectedFile.name) ? (
                          <div className="h-full flex flex-col items-center justify-center p-12 text-center space-y-4">
                            <Loader2 className="w-10 h-10 animate-spin text-primary opacity-50" />
                            <div className="w-full max-w-xs space-y-2">
                              <Progress value={fileProgress[selectedFile.name]} className="h-1" />
                              <p className="text-xs text-muted-foreground">កំពុងបកប្រែ... {fileProgress[selectedFile.name]}%</p>
                            </div>
                          </div>
                        ) : (
                          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-12 text-center">
                            <FileText className="w-12 h-12 mb-4 opacity-20" />
                            <p className="text-sm">កំពុងរង់ចាំការបកប្រែ...</p>
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="mt-4"
                              onClick={() => processFile(selectedFile)}
                            >
                              បកប្រែដោយដៃ
                            </Button>
                          </div>
                        )}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <div {...getRootProps()} className={`h-full min-h-[500px] border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center p-12 text-center transition-all ${isDragActive ? 'border-primary bg-primary/5' : 'hover:bg-accent/10'}`}>
                  <input {...getInputProps()} />
                  <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                    <Upload className="w-10 h-10 text-primary" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">
                    {files.length > 0 ? "ជ្រើសរើសឯកសារដើម្បីមើលលទ្ធផល" : "ជ្រើសរើសឯកសារដើម្បីចាប់ផ្តើម"}
                  </h3>
                  <p className="text-muted-foreground max-w-sm mb-8">
                    {files.length > 0 
                      ? `អ្នកមានឯកសារចំនួន ${files.length} ក្នុងបញ្ជី។ ចុចលើឯកសារណាមួយដើម្បីមើលអត្ថបទ SRT។`
                      : "អ្នកអាចដាក់វីដេអូ ឬសំឡេងបានច្រើនក្នុងពេលតែមួយ។ មិនមានការកំណត់ទំហំឯកសារឡើយ។"}
                  </p>
                  <div className="flex gap-4">
                    <Button size="lg" className="px-8 font-bold">
                      {files.length > 0 ? "បន្ថែមឯកសារ" : "ជ្រើសរើសឯកសារ"}
                    </Button>
                    {Object.keys(srtResults).length > 0 && (
                      <Button 
                        size="lg" 
                        variant="outline" 
                        className="px-8 font-bold border-green-500/20 text-green-500 hover:bg-green-500/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadAllSRTs();
                        }}
                      >
                        <Archive className="mr-2 h-5 w-5" />
                        ទាញយកទាំងអស់ ({Object.keys(srtResults).length})
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <Sheet open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
          <SheetContent side="right" className="bg-background border-border text-foreground">
            <SheetHeader>
              <SheetTitle className="text-foreground">ការកំណត់</SheetTitle>
              <SheetDescription className="text-muted-foreground">ជ្រើសរើសភាសាដែលអ្នកចង់បកប្រែទៅ</SheetDescription>
            </SheetHeader>
            <div className="py-6 space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-foreground">Segmented Processing</h4>
                  <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
                    Active
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  ប្រព័ន្ធនឹងបកប្រែដោយបែងចែកជាផ្នែកៗ (Segment by Segment) ដើម្បីធានាបាននូវភាពត្រឹមត្រូវខ្ពស់ និងពេលវេលាច្បាស់លាស់។
                </p>
              </div>
              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold">សម្គាល់តួអង្គ/ភេទ (Character Detect)</h4>
                  <Button 
                    variant={detectGender ? "default" : "outline"} 
                    size="sm" 
                    onClick={() => setDetectGender(!detectGender)}
                    className="h-8 px-3"
                  >
                    {detectGender ? "បើក" : "បិទ"}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  សម្គាល់តួអង្គនៃសំឡេងអ្នកនិយាយ (Male, Female, Old, Girl, Boy, Extra, Narrator, Think_Female, Think_Male) រួចដាក់បញ្ជាក់នៅក្នុងអត្ថបទ SRT។
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold">ទាញយកអត្ថបទដោយស្វ័យប្រវត្តិ</h4>
                  <Button 
                    variant={autoDownload ? "default" : "outline"} 
                    size="sm" 
                    onClick={() => setAutoDownload(!autoDownload)}
                    className="h-8 px-3"
                  >
                    {autoDownload ? "បើក" : "បិទ"}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  នៅពេលបកប្រែចប់ វានឹងទាញយកឯកសារ SRT ដោយស្វ័យប្រវត្តិទៅកាន់ម៉ាស៊ីនរបស់អ្នក។
                </p>
              </div>

              <Separator />

              <div className="space-y-2">
                <h4 className="text-sm font-bold">ជ្រើសរើសភាសាបកប្រែ</h4>
                <div className="grid grid-cols-1 gap-2">
                  {LANGUAGES.map((lang) => (
                    <Button
                      key={lang.value}
                      variant={targetLanguage === lang.value ? "default" : "outline"}
                      className="justify-start"
                      onClick={() => {
                        setTargetLanguage(lang.value);
                        setIsSettingsOpen(false);
                      }}
                    >
                      {lang.label}
                      {targetLanguage === lang.value && <CheckCircle2 className="ml-auto w-4 h-4" />}
                    </Button>
                  ))}
                </div>
              </div>
              <Separator />
              <div className="p-4 bg-primary/5 rounded-lg border border-primary/10">
                <div className="flex items-start gap-3">
                  <Info className="w-4 h-4 text-primary mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-bold">ចំណាំអំពីទំហំឯកសារ</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      ទោះបីជាកម្មវិធីមិនកំណត់ទំហំឯកសារ ប៉ុន្តែការបកប្រែឯកសារធំពេក (លើសពី 100MB) អាចនឹងបរាជ័យអាស្រ័យលើល្បឿនអ៊ីនធឺណិត និងដែនកំណត់របស់ AI API។
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <AnimatePresence>
          {showCookieModal && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-background/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
            >
              <motion.div 
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                className="bg-card border border-border rounded-xl max-w-xl w-full p-6 shadow-2xl relative"
                id="cookie-error-modal"
              >
                <div className="flex items-center gap-3 text-amber-500 mb-4 pb-3 border-b border-border">
                  <AlertCircle className="w-6 h-6 animate-pulse text-amber-500" />
                  <h3 className="text-lg font-bold">⚠️ បញ្ហា Cookie របស់ Browser / Browser Cookie Error</h3>
                </div>
                
                <div className="space-y-4 text-sm text-foreground">
                  <div className="bg-amber-500/10 border border-amber-500/20 p-3.5 rounded-lg text-amber-500 font-medium">
                    <p className="leading-relaxed">
                      ដំណើរការបកប្រែវីដេអូ ឬសំឡេងមិនអាចសរសេរ/ហៅទៅកាន់ API បានទេ ដោយសារត្រូវបានរារាំងដោយលក្ខខណ្ឌសុវត្ថិភាព iFrame របស់ Browser (Third-Party Cookie Restriction)។
                    </p>
                  </div>
                  
                  <div className="space-y-3 leading-relaxed">
                    <p className="font-bold text-foreground">វិធីសាស្ត្រដោះស្រាយ៖</p>
                    <ul className="list-disc list-inside space-y-2 text-muted-foreground text-xs pl-1">
                      <li>
                        ចុលចុចប៊ូតុង <span className="font-bold text-foreground">“បើកក្នុង Tab ថ្មី (Open in New Tab)”</span> ខាងក្រោមនេះ ដើម្បីដំណើរការកម្មវិធីដាច់ដោយឡែក។
                      </li>
                      <li>
                        ការដំណើរការដាច់ដោយឡែកនឹងជម្រុះរាល់ការរារាំងរបស់ Browser ទាំងអស់ និងអាចអនុញ្ញាតឱ្យការបកប្រែដំណើរការបានធម្មតា និងរហ័សបំផុត។
                      </li>
                      <li>
                        អ្នកក៏អាចចម្លងតំណភ្ជាប់ (URL) ទៅបើកក្នុង Browser ណាផ្សេងទៀតដោយផ្ទាល់បានផងដែរ។
                      </li>
                    </ul>
                  </div>

                  <div className="pt-2 bg-muted/40 p-3 rounded-lg border border-border text-xs font-mono flex items-center justify-between gap-3 overflow-hidden">
                    <span className="text-muted-foreground select-none shrink-0 uppercase tracking-widest text-[9px]">Direct Link:</span>
                    <span className="truncate flex-1 select-all hover:text-foreground transition-colors">{window.location.href}</span>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        navigator.clipboard.writeText(window.location.href);
                        toast.success("ចម្លងតំណភ្ជាប់ជោគជ័យ! Copied!");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 mt-6 justify-end">
                  <Button 
                    variant="outline" 
                    className="w-full sm:w-auto h-10 font-bold"
                    onClick={() => setShowCookieModal(false)}
                  >
                    បិទផ្ទាំងនេះ / Close
                  </Button>
                  <a
                    href={window.location.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full sm:w-auto h-10 font-bold bg-amber-600 hover:bg-amber-500 text-white rounded-md px-5 flex items-center justify-center gap-2 shadow-md transition-all active:scale-95"
                  >
                    <ExternalLink className="h-4 w-4" />
                    <span>បើកជា Tab ថ្មី / Open in New Tab</span>
                  </a>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TooltipProvider>
  );
}
