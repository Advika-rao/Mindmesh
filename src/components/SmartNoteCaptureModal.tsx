import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Edit3,
  Eye,
  FileText,
  ImagePlus,
  Loader2,
  Lock,
  Minimize2,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Note } from '../core/models/Note';
import { SmartNoteCaptureService } from '../core/services/SmartNoteCaptureService';
import { useSmartCapture } from '../context/SmartCaptureContext';

interface SmartNoteCapturePanelProps {
  existingSubjects: string[];
  hasActiveEditingNote: boolean;
  activeEditingNoteTitle?: string;
  onSavedDirect: (noteId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const SmartNoteCapturePanel: React.FC<SmartNoteCapturePanelProps> = ({
  existingSubjects,
  hasActiveEditingNote,
  activeEditingNoteTitle,
  onSavedDirect,
}) => {
  const {
    closeCapturePanel,
    resetCaptureSession,
    step,
    setStep,
    images,
    pageStates,
    isPreparing,
    isExtracting,
    isAnalyzingMetadata,
    progressPercent,
    overallStatusText,
    overallStatusTone,
    bannerError,
    setBannerError,
    waitingCount,
    processingCount,
    completedCount,
    failedCount,
    hasUnclearText,
    unclearWarnings,
    confidenceNotes,
    isRunningAnyJob,
    generateMetadata,
    setGenerateMetadata,
    retainImages,
    setRetainImages,
    includeSummary,
    setIncludeSummary,
    title,
    setTitle,
    subject,
    setSubject,
    tags,
    setTags,
    extractedContent,
    setExtractedContent,
    suggestedSummary,
    buildFinalContent,
    addFiles,
    removeImage,
    moveImage,
    clearImages,
    startExtraction,
    retryFailedPages,
    retrySinglePage,
    updatePageTranscription,
    cancelExtraction,
    saveCapturedNoteDirectly,
    saving,
    requestTransferToEditor,
  } = useSmartCapture();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedPreviewIdx, setSelectedPreviewIdx] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [previewMarkdown, setPreviewMarkdown] = useState(false);
  const [expandedPages, setExpandedPages] = useState<Record<string, boolean>>({});
  const [editingPages, setEditingPages] = useState<Record<string, boolean>>({});
  const [copiedPageId, setCopiedPageId] = useState<string | null>(null);

  const handleCopyPageText = async (imageId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPageId(imageId);
      setTimeout(() => {
        setCopiedPageId((prev) => (prev === imageId ? null : prev));
      }, 1800);
    } catch {
      // Clipboard fallback ignored if blocked by iframe permissions
    }
  };

  const unclearMarkerCount = useMemo(() => {
    const matches = extractedContent.match(/\[unclear\]/gi);
    return matches ? matches.length : 0;
  }, [extractedContent]);

  const showUnclearWarning = Boolean(
    hasUnclearText || unclearWarnings.length > 0 || unclearMarkerCount > 0
  );

  const safePreviewIdx = Math.min(selectedPreviewIdx, Math.max(0, images.length - 1));
  const activePreviewImage = images[safePreviewIdx] ?? null;

  const failedPages = useMemo(
    () =>
      images
        .map((img, idx) => ({ img, pageNumber: idx + 1, state: pageStates[img.id] }))
        .filter((item) => item.state?.status === 'failed'),
    [images, pageStates]
  );

  const uncompletedCount = waitingCount + failedCount;

  const handleAddTag = () => {
    const clean = tagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (clean.length === 0) return;
    setTags((prev) => Note.sanitizeTags([...prev, ...clean]));
    setTagInput('');
  };

  const handleSaveDirect = async () => {
    if (tagInput.trim()) {
      const merged = Note.sanitizeTags([...tags, ...tagInput.split(',').map((t) => t.trim())]);
      setTags(merged);
      setTagInput('');
    }
    const createdNoteId = await saveCapturedNoteDirectly();
    if (createdNoteId) {
      onSavedDirect(createdNoteId);
    }
  };

  const handleSendToEditor = (mode: 'new' | 'append') => {
    if (tagInput.trim()) {
      const merged = Note.sanitizeTags([...tags, ...tagInput.split(',').map((t) => t.trim())]);
      setTags(merged);
      setTagInput('');
    }
    requestTransferToEditor(mode);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-[#0f172a] border border-slate-800/80 rounded-2xl overflow-hidden shadow-lg">
        {/* Non-Blocking Top Header — Back, Minimize, and Cancel All are ALWAYS responsive */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-slate-800/80 bg-[#0b1120]">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={closeCapturePanel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Notes
            </button>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ImagePlus className="w-4 h-4 text-indigo-400 shrink-0" />
                <h2 className="font-display text-base font-semibold text-slate-50 truncate">
                  Smart Note Capture (Image-to-Notes)
                </h2>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
                <span className={step === 'upload' ? 'text-indigo-300 font-medium' : ''}>
                  1. Upload / Photo
                </span>
                <span aria-hidden="true">→</span>
                <span className={step === 'extracting' ? 'text-indigo-300 font-medium' : ''}>
                  2. Extract Pages
                </span>
                <span aria-hidden="true">→</span>
                <span className={step === 'review' ? 'text-indigo-300 font-medium' : ''}>
                  3. Review & Save
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {isRunningAnyJob && (
              <>
                <button
                  type="button"
                  onClick={closeCapturePanel}
                  title="Keep extracting in the background while you use other MindMesh features"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0f172a] hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  Run in Background
                </button>
                <button
                  type="button"
                  onClick={() => cancelExtraction(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-rose-200 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Cancel All
                </button>
              </>
            )}

            {!isRunningAnyJob && images.length > 0 && (
              <button
                type="button"
                onClick={resetCaptureSession}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-100 bg-slate-800/60 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Start Over
              </button>
            )}
          </div>
        </div>

        {/* Hidden File Inputs (Gallery + Mobile Camera) */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              void addFiles(e.target.files);
            }
            e.target.value = '';
          }}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              void addFiles(e.target.files);
            }
            e.target.value = '';
          }}
        />

        {/* Main Panel Body */}
        <div className="p-5 sm:p-6 space-y-5">
          {/* Inline Error Banner */}
          {bannerError && (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 p-3.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-xs text-rose-200"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed">{bannerError}</p>
              </div>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                aria-label="Dismiss error"
                className="text-rose-300 hover:text-rose-100 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* STEP 1: UPLOAD / TAKE PHOTO */}
          {step === 'upload' && (
            <div className="space-y-5">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files) {
                    void addFiles(e.dataTransfer.files);
                  }
                }}
                className={`rounded-xl border-2 border-dashed p-6 sm:p-8 text-center transition-colors ${
                  isDragging
                    ? 'border-indigo-400 bg-indigo-500/10'
                    : 'border-slate-700/80 bg-[#0b1120] hover:border-slate-600'
                }`}
              >
                <Upload className="w-9 h-9 text-indigo-400 mx-auto mb-3" />
                <h3 className="font-display text-sm sm:text-base font-semibold text-slate-100">
                  Upload handwritten, printed, classroom, or textbook note photos
                </h3>
                <p className="text-xs text-slate-400 mt-1.5 max-w-xl mx-auto leading-relaxed">
                  Drag and drop up to {SmartNoteCaptureService.MAX_IMAGES} pages (JPG, PNG, or WebP). Images are compressed automatically and extracted in parallel while keeping MindMesh responsive.
                </p>

                <div className="flex flex-wrap items-center justify-center gap-3 mt-5">
                  <button
                    type="button"
                    disabled={isPreparing || images.length >= SmartNoteCaptureService.MAX_IMAGES}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <ImagePlus className="w-4 h-4" />
                    Choose Images
                  </button>

                  <button
                    type="button"
                    disabled={isPreparing || images.length >= SmartNoteCaptureService.MAX_IMAGES}
                    onClick={() => cameraInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Camera className="w-4 h-4" />
                    Take Photo
                  </button>
                </div>

                {isPreparing && (
                  <p className="mt-4 inline-flex items-center gap-2 text-xs text-indigo-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {overallStatusText}
                  </p>
                )}
              </div>

              {/* Selected Pages Grid */}
              {images.length > 0 && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Uploaded Pages ({images.length} / {SmartNoteCaptureService.MAX_IMAGES})
                      {completedCount > 0 ? ` · ${completedCount} completed` : ''}
                      {failedCount > 0 ? ` · ${failedCount} failed` : ''}
                    </h4>
                    <div className="flex items-center gap-3">
                      {completedCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setStep('review')}
                          className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          Review {completedCount} Completed Page{completedCount > 1 ? 's' : ''}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={clearImages}
                        className="text-xs text-rose-400 hover:text-rose-300"
                      >
                        Clear All
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
                    {images.map((img, idx) => {
                      const pState = pageStates[img.id];
                      const status = pState?.status ?? 'waiting';
                      return (
                        <div
                          key={img.id}
                          className="rounded-xl bg-[#0b1120] border border-slate-800 overflow-hidden flex flex-col"
                        >
                          <div className="relative aspect-[4/3] bg-slate-950 overflow-hidden">
                            <img
                              src={img.previewUrl}
                              alt={`Note page ${idx + 1}: ${img.fileName}`}
                              className="w-full h-full object-contain"
                            />
                            <span className="absolute top-2 left-2 px-2 py-0.5 text-[11px] font-mono font-medium bg-slate-950/85 text-slate-200 rounded">
                              Page {idx + 1}
                            </span>
                            {status === 'completed' && (
                              <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-emerald-950/90 text-emerald-300 border border-emerald-500/35 rounded">
                                <CheckCircle2 className="w-3 h-3" />
                                Completed
                              </span>
                            )}
                            {status === 'failed' && (
                              <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-rose-950/90 text-rose-300 border border-rose-500/35 rounded">
                                <AlertTriangle className="w-3 h-3" />
                                Failed
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => removeImage(img.id)}
                              aria-label={`Remove ${img.fileName}`}
                              className="absolute top-2 right-2 p-1.5 rounded-md bg-slate-950/85 text-slate-300 hover:text-rose-400 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="p-2.5 flex items-center justify-between gap-2 border-t border-slate-800/80">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-200 truncate">
                                {img.fileName}
                              </p>
                              <p className="text-[11px] font-mono tabular-nums text-slate-500">
                                {formatBytes(img.originalSizeBytes)} → {formatBytes(img.visionSizeBytes)}
                              </p>
                            </div>

                            {images.length > 1 && (
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => moveImage(idx, -1)}
                                  aria-label="Move page earlier"
                                  className="p-1 text-slate-400 hover:text-slate-100 disabled:opacity-30"
                                >
                                  <ArrowLeft className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === images.length - 1}
                                  onClick={() => moveImage(idx, 1)}
                                  aria-label="Move page later"
                                  className="p-1 text-slate-400 hover:text-slate-100 disabled:opacity-30"
                                >
                                  <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Extraction & Privacy Options */}
              <div className="grid sm:grid-cols-2 gap-3.5 pt-1">
                <label className="flex items-start gap-3 p-3.5 rounded-xl bg-[#0b1120] border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={generateMetadata}
                    onChange={(e) => setGenerateMetadata(e.target.checked)}
                    className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-slate-200 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      Auto-generate title, summary, subject & tags
                    </span>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Suggests structured metadata from your notes that you can edit before saving.
                    </p>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3.5 rounded-xl bg-[#0b1120] border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={retainImages}
                    onChange={(e) => setRetainImages(e.target.checked)}
                    className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-slate-200 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-emerald-400" />
                      Retain original images privately with note
                    </span>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Stores compressed private copies linked to your note so you can inspect the originals anytime.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* STEP 2: LIVE EXTRACTION SCREEN WITH PER-PAGE STATUS, TEXT PREVIEW, RETRY & CANCEL ALL */}
          {step === 'extracting' && (
            <div className="space-y-5">
              {/* Overall Progress Card — 100% derived from actual page statuses */}
              <div className="p-5 rounded-xl bg-[#0b1120] border border-slate-800 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {overallStatusTone === 'processing' ? (
                      <Loader2 className="w-5 h-5 text-indigo-400 animate-spin shrink-0" />
                    ) : overallStatusTone === 'success' ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    ) : overallStatusTone === 'error' ? (
                      <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
                    )}

                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-100">{overallStatusText}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {overallStatusTone === 'processing'
                          ? 'Results save progressively as each page completes. You can cancel or navigate away anytime.'
                          : completedCount > 0 && failedCount > 0
                            ? `${completedCount} completed page${completedCount > 1 ? 's are' : ' is'} already preserved. Retry only the failed page${failedCount > 1 ? 's' : ''} or continue to review.`
                            : failedCount > 0
                              ? 'Review the specific error on each page below and retry without re-uploading.'
                              : 'All pages extracted and ready to review.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {overallStatusTone === 'processing' && (
                      <button
                        type="button"
                        onClick={() => cancelExtraction(true)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-rose-200 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 rounded-lg transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Cancel All
                      </button>
                    )}

                    {overallStatusTone !== 'processing' && failedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => void retryFailedPages()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-indigo-200 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 rounded-lg transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Retry Failed Pages ({failedCount})
                      </button>
                    )}

                    {completedCount > 0 && !isRunningAnyJob && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleSaveDirect()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-100 bg-emerald-600/85 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {saving ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        Save to Notes
                      </button>
                    )}

                    {completedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setStep('review')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                      >
                        Review Completed ({completedCount})
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress Bar + Exact Derived Counts */}
                <div className="space-y-2">
                  <div className="h-2 w-full bg-slate-800/90 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ease-out ${
                        overallStatusTone === 'error'
                          ? 'bg-rose-500'
                          : overallStatusTone === 'success'
                            ? 'bg-emerald-500'
                            : overallStatusTone === 'partial'
                              ? 'bg-amber-500'
                              : 'bg-indigo-500'
                      }`}
                      style={{ width: `${Math.max(4, Math.min(100, progressPercent))}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-400">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-emerald-400">{completedCount} Completed</span>
                      {processingCount > 0 && (
                        <span className="text-indigo-300">{processingCount} Processing</span>
                      )}
                      {waitingCount > 0 && (
                        <span className="text-slate-400">{waitingCount} Waiting</span>
                      )}
                      {failedCount > 0 && (
                        <span className="text-rose-400">{failedCount} Failed</span>
                      )}
                    </div>
                    <span>{progressPercent}%</span>
                  </div>
                </div>
              </div>

              {/* Per-Page Extraction Cards with Live Text Preview & Actionable Errors */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Pages ({images.length})
                </h4>
                <div className="grid md:grid-cols-2 gap-3.5">
                  {images.map((img, idx) => {
                    const pState = pageStates[img.id];
                    const status = pState?.status ?? 'waiting';
                    const pageNum = idx + 1;
                    const wordCount = pState?.extractedMarkdown
                      ? SmartNoteCaptureService.countWords(pState.extractedMarkdown)
                      : 0;
                    const isExpanded = Boolean(expandedPages[img.id]);
                    const isEditing = Boolean(editingPages[img.id]);
                    const isCopied = copiedPageId === img.id;

                    return (
                      <div
                        key={img.id}
                        className={`flex flex-col gap-3 p-3.5 rounded-xl bg-[#0b1120] border transition-colors ${
                          isExpanded || isEditing ? 'md:col-span-2' : ''
                        } ${
                          status === 'failed'
                            ? 'border-rose-500/40'
                            : status === 'completed'
                              ? 'border-emerald-500/30'
                              : status === 'processing'
                                ? 'border-indigo-500/40'
                                : 'border-slate-800'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <img
                            src={img.previewUrl}
                            alt={`Page ${pageNum}: ${img.fileName}`}
                            className="w-14 h-14 rounded-lg object-cover bg-slate-950 border border-slate-800 shrink-0"
                          />

                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold text-slate-100 truncate">
                                Page {pageNum} · {img.fileName}
                              </p>

                              {/* Exact 4-State Status Indicator */}
                              <span className="shrink-0 text-[11px] font-medium">
                                {status === 'processing' ? (
                                  <span className="inline-flex items-center gap-1 text-indigo-300">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Processing
                                  </span>
                                ) : status === 'completed' ? (
                                  <span className="inline-flex items-center gap-1 text-emerald-400">
                                    <CheckCircle2 className="w-3 h-3" />
                                    Completed
                                  </span>
                                ) : status === 'failed' ? (
                                  <span className="inline-flex items-center gap-1 text-rose-400">
                                    <AlertTriangle className="w-3 h-3" />
                                    Failed
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-slate-400">
                                    <Clock className="w-3 h-3" />
                                    Waiting
                                  </span>
                                )}
                              </span>
                            </div>

                            <p className="text-[11px] font-mono tabular-nums text-slate-500">
                              {formatBytes(img.visionSizeBytes)}
                              {status === 'completed' && pState?.durationMs
                                ? ` · ${(pState.durationMs / 1000).toFixed(1)}s · ${wordCount} words`
                                : status === 'processing'
                                  ? ` · ${pState?.statusNote || 'Transcribing handwriting, headings, formulas & tables…'}`
                                  : status === 'waiting'
                                    ? ' · Waiting to start'
                                    : ''}
                            </p>
                          </div>
                        </div>

                        {/* Clean, Full-Fidelity Extracted Transcription Display with Expand, Edit & Copy */}
                        {status === 'completed' && pState?.extractedMarkdown && (
                          <div className="rounded-lg bg-slate-950/75 border border-slate-800/80 overflow-hidden">
                            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-800/80 bg-slate-900/60">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                Extracted Notes ({wordCount} words)
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedPages((prev) => ({
                                      ...prev,
                                      [img.id]: !prev[img.id],
                                    }))
                                  }
                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 rounded transition-colors"
                                >
                                  {isExpanded ? (
                                    <>
                                      <ChevronUp className="w-3 h-3" />
                                      Collapse
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown className="w-3 h-3" />
                                      Expand
                                    </>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingPages((prev) => ({
                                      ...prev,
                                      [img.id]: !prev[img.id],
                                    }));
                                    if (!isExpanded) {
                                      setExpandedPages((prev) => ({ ...prev, [img.id]: true }));
                                    }
                                  }}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                                    isEditing
                                      ? 'text-emerald-200 bg-emerald-600/30 border border-emerald-500/40'
                                      : 'text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80'
                                  }`}
                                >
                                  <Edit3 className="w-3 h-3" />
                                  {isEditing ? 'Done' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleCopyPageText(img.id, pState.extractedMarkdown)}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 rounded transition-colors"
                                >
                                  {isCopied ? (
                                    <>
                                      <Check className="w-3 h-3 text-emerald-400" />
                                      Copied
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3 h-3" />
                                      Copy
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            <div className="p-3 space-y-2">
                              {isEditing ? (
                                <textarea
                                  rows={10}
                                  value={pState.extractedMarkdown}
                                  onChange={(e) => updatePageTranscription(img.id, e.target.value)}
                                  aria-label={`Edit extracted notes for Page ${pageNum}`}
                                  className="w-full p-2.5 text-xs bg-[#0b1120] border border-slate-700 focus:border-indigo-500 focus:outline-none rounded-md text-slate-100 font-mono leading-relaxed"
                                />
                              ) : (
                                <div
                                  className={`text-xs text-slate-200 font-mono leading-relaxed whitespace-pre-wrap break-words ${
                                    isExpanded ? 'max-h-[420px] overflow-y-auto pr-1' : 'line-clamp-6'
                                  }`}
                                >
                                  {pState.extractedMarkdown}
                                </div>
                              )}

                              {pState.hasUnclearText && (
                                <p className="text-[11px] text-amber-300">
                                  Contains [unclear] sections — edit inline or verify in Review before saving.
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Specific Actionable Error & Per-Page Retry */}
                        {status === 'failed' && (
                          <div className="p-2.5 rounded-lg bg-rose-950/35 border border-rose-500/30 space-y-2">
                            <div className="space-y-0.5">
                              <p className="text-xs font-semibold text-rose-300">
                                {pState?.error?.title || 'Extraction error'}
                              </p>
                              <p className="text-[11px] text-rose-200/85 leading-snug">
                                {pState?.error?.detail || 'This page could not be processed.'}
                              </p>
                              {pState?.error?.actionHint && (
                                <p className="text-[11px] text-slate-300/85">
                                  {pState.error.actionHint}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              {pState?.error?.retryable !== false && (
                                <button
                                  type="button"
                                  onClick={() => void retrySinglePage(img.id)}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-indigo-200 bg-indigo-600/25 hover:bg-indigo-600/35 border border-indigo-500/40 rounded-md transition-colors"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  Retry Page {pageNum}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => removeImage(img.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-rose-300 bg-slate-800/80 hover:bg-slate-800 rounded-md transition-colors"
                              >
                                <Trash2 className="w-3 h-3" />
                                Remove
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Development-only Diagnostics Disclosure (zero API keys/secrets) */}
                        {import.meta.env.DEV && pState?.debug && (
                          <details className="text-[10px] font-mono text-slate-400 bg-slate-950/60 border border-slate-800/70 rounded-lg px-2.5 py-1.5">
                            <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-300">
                              Dev Debug · {pState.debug.modelName} · HTTP {pState.debug.httpStatus} ·{' '}
                              {pState.debug.responseFormat || 'json'} · {pState.debug.durationMs}ms
                              {(pState.debug.retryCount ?? pState.retryCount ?? 0) > 0
                                ? ` · ${pState.debug.retryCount ?? pState.retryCount} retr${
                                    (pState.debug.retryCount ?? pState.retryCount ?? 0) === 1 ? 'y' : 'ies'
                                  }`
                                : ''}
                            </summary>
                            <div className="mt-1.5 space-y-0.5 break-all text-slate-400">
                              <div>
                                File: {pState.debug.fileName} ({formatBytes(pState.debug.fileSizeBytes)}) · MIME:{' '}
                                {pState.debug.mimeType} (verified: {pState.debug.detectedFormat || 'n/a'}) · Attached:{' '}
                                {String(pState.debug.imageAttached)}
                              </div>
                              <div>
                                Response: {pState.debug.responseFormat || 'json'} ({pState.debug.responseContentType || 'application/json'}) · Length:{' '}
                                {pState.debug.extractedTextLength ?? pState.extractedMarkdown.length} chars · Words:{' '}
                                {wordCount}
                              </div>
                              <div>
                                Quality Check:{' '}
                                <span
                                  className={
                                    (pState.debug.qualityCheckPassed ?? pState.qualityCheckPassed)
                                      ? 'text-emerald-400'
                                      : 'text-rose-300'
                                  }
                                >
                                  {(pState.debug.qualityCheckPassed ?? pState.qualityCheckPassed) ? 'PASS' : 'FAIL'}
                                </span>{' '}
                                ({pState.debug.qualityCheckReason || pState.qualityCheckReason || 'n/a'}) · Retries:{' '}
                                {pState.debug.retryCount ?? pState.retryCount ?? 0}
                              </div>
                              <div>
                                Model: {pState.debug.modelName} ({pState.debug.thinkingLevel || 'default'}) · Mode:{' '}
                                {pState.debug.retryMode || 'standard'} · Finish: {pState.debug.finishReason || 'n/a'}
                              </div>
                              {pState.debug.actualError && (
                                <div className="text-rose-300">Error: {pState.debug.actualError}</div>
                              )}
                              {pState.debug.rawResponsePreview && (
                                <div className="text-slate-500 line-clamp-2">
                                  Raw: {pState.debug.rawResponsePreview}
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: REVIEW & EDIT SIDE-BY-SIDE WORKSPACE */}
          {step === 'review' && (
            <div className="space-y-4">
              {/* Partial Failure / Individual Page Retry Banner inside Review */}
              {failedPages.length > 0 && (
                <div className="p-4 rounded-xl bg-rose-950/35 border border-rose-500/35 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-rose-200">
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>
                        {failedPages.length} page{failedPages.length > 1 ? 's' : ''} failed — your{' '}
                        {completedCount} completed page{completedCount > 1 ? 's are' : ' is'} preserved below
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={isRunningAnyJob}
                      onClick={() => void retryFailedPages()}
                      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-indigo-200 bg-indigo-600/25 hover:bg-indigo-600/35 border border-indigo-500/40 rounded-md transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Retry All Failed ({failedPages.length})
                    </button>
                  </div>

                  <div className="space-y-2">
                    {failedPages.map(({ img, pageNumber, state }) => {
                      const isRetrying = state?.status === 'processing';
                      return (
                        <div
                          key={img.id}
                          className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-[#0b1120]/80 border border-slate-800 text-xs"
                        >
                          <div className="min-w-0">
                            <span className="font-medium text-slate-200">
                              Page {pageNumber} ({img.fileName}) —{' '}
                              <span className="text-rose-300">{state?.error?.title || 'Failed'}:</span>
                            </span>{' '}
                            <span className="text-slate-400">
                              {state?.error?.detail || 'Extraction failed.'}
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={isRetrying}
                            onClick={() => void retrySinglePage(img.id)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                          >
                            {isRetrying ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3 h-3" />
                            )}
                            Retry Page {pageNumber}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid lg:grid-cols-12 gap-5">
                {/* Left Column: Original Uploaded Image Reference */}
                <div className="lg:col-span-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Original Source ({images.length} page{images.length > 1 ? 's' : ''})
                    </span>
                    <button
                      type="button"
                      onClick={() => setZoomed((z) => !z)}
                      className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                    >
                      {zoomed ? <ZoomOut className="w-3.5 h-3.5" /> : <ZoomIn className="w-3.5 h-3.5" />}
                      {zoomed ? 'Fit' : 'Zoom'}
                    </button>
                  </div>

                  {activePreviewImage && (
                    <div className="rounded-xl bg-slate-950 border border-slate-800 overflow-auto max-h-[440px]">
                      <img
                        src={activePreviewImage.previewUrl}
                        alt={activePreviewImage.fileName}
                        className={
                          zoomed
                            ? 'w-[180%] max-w-none h-auto'
                            : 'w-full h-auto object-contain max-h-[430px]'
                        }
                      />
                    </div>
                  )}

                  {images.length > 1 && (
                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                      {images.map((img, idx) => {
                        const st = pageStates[img.id]?.status;
                        return (
                          <button
                            key={img.id}
                            type="button"
                            onClick={() => {
                              setSelectedPreviewIdx(idx);
                              setZoomed(false);
                            }}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                              idx === safePreviewIdx
                                ? 'bg-indigo-600/25 border-indigo-500 text-indigo-200'
                                : 'bg-[#0b1120] border-slate-800 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <span>Page {idx + 1}</span>
                            {st === 'completed' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                            {st === 'failed' && <AlertTriangle className="w-3 h-3 text-rose-400" />}
                            {st === 'processing' && <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <label className="flex items-center gap-2.5 p-3 rounded-lg bg-[#0b1120] border border-slate-800 cursor-pointer text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={retainImages}
                      onChange={(e) => setRetainImages(e.target.checked)}
                      disabled={saving}
                      className="rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                    />
                    <span>Keep original image{images.length > 1 ? 's' : ''} privately attached to note</span>
                  </label>

                  {confidenceNotes.length > 0 && (
                    <div className="text-[11px] text-slate-400 leading-relaxed px-1 space-y-1">
                      <p className="font-medium text-slate-300">Readability notes:</p>
                      {confidenceNotes.slice(0, 4).map((note, idx) => (
                        <p key={idx}>{note}</p>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right Column: Editable Extracted Note Panel */}
                <div className="lg:col-span-7 space-y-4">
                  {/* Unclear Handwriting / Text Warning */}
                  {showUnclearWarning && (
                    <div className="p-3.5 rounded-xl bg-amber-950/45 border border-amber-500/40 space-y-1.5">
                      <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>
                          Unclear handwriting or text detected
                          {unclearMarkerCount > 0
                            ? ` (${unclearMarkerCount} [unclear] marker${unclearMarkerCount > 1 ? 's' : ''})`
                            : ''}
                        </span>
                      </div>
                      <p className="text-xs text-amber-200/85 leading-relaxed">
                        Unreadable portions were marked as{' '}
                        <code className="font-mono text-amber-200">[unclear]</code> instead of guessing. Compare with the photo on the left and edit before saving.
                      </p>
                      {unclearWarnings.length > 0 && (
                        <ul className="list-disc list-inside text-[11px] text-amber-200/80 space-y-0.5 pt-0.5">
                          {unclearWarnings.map((warn, i) => (
                            <li key={i}>{warn}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Editable Title & Subject */}
                  <div className="grid sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2 space-y-1">
                      <label htmlFor="capture-title" className="block text-xs font-medium text-slate-300">
                        Note Title
                      </label>
                      <input
                        id="capture-title"
                        type="text"
                        maxLength={200}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Enter note title..."
                        className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="capture-subject" className="block text-xs font-medium text-slate-300">
                        Subject
                      </label>
                      <input
                        id="capture-subject"
                        type="text"
                        maxLength={80}
                        list="capture-subjects-list"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="Subject..."
                        className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100"
                      />
                      <datalist id="capture-subjects-list">
                        {existingSubjects.map((s) => (
                          <option key={s} value={s} />
                        ))}
                        <option value="Computer Science" />
                        <option value="Mathematics" />
                        <option value="Physics" />
                        <option value="Biology" />
                        <option value="Data Science" />
                      </datalist>
                    </div>
                  </div>

                  {/* Editable Tags */}
                  <div className="space-y-1.5">
                    <label htmlFor="capture-tags" className="block text-xs font-medium text-slate-300">
                      Concept Tags
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="capture-tags"
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            handleAddTag();
                          }
                        }}
                        placeholder="Add tags separated by commas..."
                        className="flex-1 px-3 py-1.5 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100"
                      />
                      <button
                        type="button"
                        onClick={handleAddTag}
                        className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                      >
                        Add
                      </button>
                    </div>
                    {tags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-3 text-xs text-indigo-300 pt-0.5">
                        {tags.map((tag) => (
                          <span key={tag} className="inline-flex items-center gap-1">
                            <span>#{tag}</span>
                            <button
                              type="button"
                              onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                              aria-label={`Remove tag ${tag}`}
                              className="text-slate-500 hover:text-rose-400"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Optional AI Summary Card */}
                  {suggestedSummary && (
                    <div className="p-3 rounded-lg bg-[#0b1120] border border-slate-800 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-indigo-300 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5" />
                          AI-Generated Summary
                        </span>
                        <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={includeSummary}
                            onChange={(e) => setIncludeSummary(e.target.checked)}
                            className="rounded border-slate-700 bg-slate-900 text-indigo-500"
                          />
                          Include at top of note
                        </label>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{suggestedSummary}</p>
                    </div>
                  )}

                  {/* Editable Extracted Markdown */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor="capture-content" className="text-xs font-medium text-slate-300">
                        Extracted Note Content (Review & Edit)
                      </label>
                      <button
                        type="button"
                        onClick={() => setPreviewMarkdown((p) => !p)}
                        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                      >
                        {previewMarkdown ? <Edit3 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {previewMarkdown ? 'Edit Text' : 'Preview'}
                      </button>
                    </div>

                    {previewMarkdown ? (
                      <div className="min-h-[240px] max-h-[340px] overflow-y-auto p-3.5 rounded-lg bg-[#0b1120] border border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                        {buildFinalContent() || 'Empty note content.'}
                      </div>
                    ) : (
                      <textarea
                        id="capture-content"
                        rows={12}
                        maxLength={50000}
                        value={extractedContent}
                        onChange={(e) => setExtractedContent(e.target.value)}
                        className="w-full p-3.5 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 leading-relaxed font-mono"
                      />
                    )}
                  </div>

                  {/* Ecosystem Integration Notice */}
                  <div className="flex items-start gap-2 text-[11px] text-slate-400">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      Saving automatically generates semantic embeddings and integrates this note into Brain Graph, Study Assistant, Mind Maps, Adaptive Quizzes, Memory Revival, and Explain My Connection.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Workspace Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-slate-800/80 bg-[#0b1120]">
          {step === 'upload' && (
            <>
              <span className="text-xs text-slate-500">
                {images.length === 0
                  ? 'No images selected yet'
                  : `${images.length} page${images.length > 1 ? 's' : ''} ready · up to ${Math.min(
                      SmartNoteCaptureService.MAX_CONCURRENCY,
                      images.length
                    )} processed simultaneously`}
              </span>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={closeCapturePanel}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-800/80 hover:bg-slate-800 rounded-lg transition-colors"
                >
                  Back to Notes
                </button>
                <button
                  type="button"
                  disabled={isPreparing || images.length === 0}
                  onClick={() => void startExtraction()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {completedCount > 0 && uncompletedCount > 0
                    ? `Extract Remaining (${uncompletedCount})`
                    : completedCount === images.length && images.length > 0
                      ? 'Continue to Review'
                      : 'Extract Notes with AI'}
                </button>
              </div>
            </>
          )}

          {step === 'extracting' && (
            <>
              <button
                type="button"
                onClick={() => setStep('upload')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Images
              </button>

              <div className="flex flex-wrap items-center gap-2.5">
                {isRunningAnyJob ? (
                  <>
                    <button
                      type="button"
                      onClick={closeCapturePanel}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0f172a] hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors"
                    >
                      <Minimize2 className="w-3.5 h-3.5" />
                      Minimize & Browse
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelExtraction(true)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-rose-200 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 rounded-lg transition-colors"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Cancel All
                    </button>
                  </>
                ) : (
                  <>
                    {failedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => void retryFailedPages()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-lg transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Retry Failed Pages ({failedCount})
                      </button>
                    )}
                    {completedCount > 0 && (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void handleSaveDirect()}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-100 bg-emerald-600/85 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {saving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Save className="w-3.5 h-3.5" />
                          )}
                          Save to Notes
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep('review')}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                        >
                          Continue to Review ({completedCount})
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {step === 'review' && (
            <>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setStep('upload');
                    setBannerError(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to Images
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setStep('extracting')}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800/50 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
                >
                  Page Status ({completedCount}/{images.length})
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {hasActiveEditingNote && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => handleSendToEditor('append')}
                    title={
                      activeEditingNoteTitle
                        ? `Append extracted content to "${activeEditingNoteTitle}"`
                        : 'Append to current note in editor'
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0f172a] hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Append to Current Note
                  </button>
                )}

                <button
                  type="button"
                  disabled={saving}
                  onClick={() => handleSendToEditor('new')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  Open in Full Editor
                </button>

                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveDirect()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Saving & Indexing...
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      Save Note to MindMesh
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
