import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { useKnowledge } from './KnowledgeContext';
import { Note } from '../core/models/Note';
import { ImageCaptureException } from '../core/exceptions/MindMeshExceptions';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import {
  SmartNoteCaptureService,
  type PageExtractionState,
  type PreparedCaptureImage,
} from '../core/services/SmartNoteCaptureService';

export interface SmartCaptureTransferPayload {
  title: string;
  subject: string;
  tags: string[];
  content: string;
  attachments: PreparedCaptureImage[];
  mode: 'new' | 'append';
}

export type SmartCaptureStep = 'upload' | 'extracting' | 'review';

interface SmartCaptureContextValue {
  // Visibility & navigation
  panelOpen: boolean;
  openCapturePanel: () => void;
  closeCapturePanel: () => void;
  resetCaptureSession: () => void;

  // Workflow state
  step: SmartCaptureStep;
  setStep: (step: SmartCaptureStep) => void;
  images: PreparedCaptureImage[];
  pageStates: Record<string, PageExtractionState>;
  isPreparing: boolean;
  isExtracting: boolean;
  isAnalyzingMetadata: boolean;
  progressPercent: number;
  overallStatusText: string;
  overallStatusTone: 'neutral' | 'processing' | 'success' | 'partial' | 'error';
  bannerError: string | null;
  setBannerError: (msg: string | null) => void;

  // Derived page counts (single source of truth)
  waitingCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
  hasUnclearText: boolean;
  unclearWarnings: string[];
  confidenceNotes: string[];
  isRunningAnyJob: boolean;

  // Options
  generateMetadata: boolean;
  setGenerateMetadata: (val: boolean) => void;
  retainImages: boolean;
  setRetainImages: (val: boolean) => void;
  includeSummary: boolean;
  setIncludeSummary: (val: boolean) => void;

  // Editable review fields
  title: string;
  setTitle: (val: string) => void;
  subject: string;
  setSubject: (val: string) => void;
  tags: string[];
  setTags: React.Dispatch<React.SetStateAction<string[]>>;
  extractedContent: string;
  setExtractedContent: (val: string) => void;
  suggestedSummary: string;
  buildFinalContent: () => string;

  // Actions
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeImage: (imageId: string) => void;
  moveImage: (index: number, direction: -1 | 1) => void;
  clearImages: () => void;
  startExtraction: (options?: { onlyFailed?: boolean }) => Promise<void>;
  retryFailedPages: () => Promise<void>;
  retrySinglePage: (imageId: string) => Promise<void>;
  updatePageTranscription: (imageId: string, markdown: string) => void;
  cancelExtraction: (returnToUpload?: boolean) => void;
  saveCapturedNoteDirectly: () => Promise<string | null>;
  saving: boolean;

  // Transfer handoff into NotesPage full editor
  pendingEditorTransfer: SmartCaptureTransferPayload | null;
  consumeEditorTransfer: () => SmartCaptureTransferPayload | null;
  requestTransferToEditor: (mode: 'new' | 'append') => void;
}

const SmartCaptureContext = createContext<SmartCaptureContextValue | null>(null);

function createWaitingPageState(): PageExtractionState {
  return {
    status: 'waiting',
    extractedMarkdown: '',
    hasUnclearText: false,
    unclearWarnings: [],
    confidenceNote: '',
  };
}

export const SmartCaptureProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { firebaseUser } = useAuth();
  const {
    notes,
    subjects,
    graphNodes,
    activePage,
    setActivePage,
    setActiveNoteId,
    notify,
  } = useKnowledge();

  const existingSubjectNames = useMemo(() => subjects.map((s) => s.name), [subjects]);

  const [panelOpen, setPanelOpen] = useState(false);
  const [step, setStep] = useState<SmartCaptureStep>('upload');
  const [images, setImages] = useState<PreparedCaptureImage[]>([]);
  const [pageStates, setPageStates] = useState<Record<string, PageExtractionState>>({});

  const [isPreparing, setIsPreparing] = useState(false);
  const [preparingMessage, setPreparingMessage] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzingMetadata, setIsAnalyzingMetadata] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const [generateMetadata, setGenerateMetadata] = useState(true);
  const [retainImages, setRetainImages] = useState(true);
  const [includeSummary, setIncludeSummary] = useState(true);

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('Computer Science');
  const [tags, setTags] = useState<string[]>([]);
  const [extractedContent, setExtractedContent] = useState('');
  const [suggestedSummary, setSuggestedSummary] = useState('');
  const [pendingEditorTransfer, setPendingEditorTransfer] =
    useState<SmartCaptureTransferPayload | null>(null);

  // Per-page & metadata AbortControllers + monotonic runId so cancelled/stale work can never corrupt state
  const pageControllersRef = useRef<Map<string, AbortController>>(new Map());
  const metadataControllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const imagesRef = useRef<PreparedCaptureImage[]>([]);
  const pageStatesRef = useRef<Record<string, PageExtractionState>>({});
  const activePageRef = useRef(activePage);
  const panelOpenRef = useRef(panelOpen);
  const contentManuallyEditedRef = useRef(false);

  imagesRef.current = images;
  pageStatesRef.current = pageStates;
  activePageRef.current = activePage;
  panelOpenRef.current = panelOpen;

  // Keep default subject synced before user types one
  useEffect(() => {
    if (!title && existingSubjectNames.length > 0) {
      setSubject((prev) => (prev ? prev : existingSubjectNames[0]));
    }
  }, [existingSubjectNames, title]);

  // Abort everything cleanly on unmount
  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      pageControllersRef.current.forEach((ctrl) => ctrl.abort());
      pageControllersRef.current.clear();
      metadataControllerRef.current?.abort();
      metadataControllerRef.current = null;
    };
  }, []);

  // SINGLE SOURCE OF TRUTH: derive every count directly from images + pageStates
  const combined = useMemo(
    () => SmartNoteCaptureService.combinePageResults(images, pageStates),
    [images, pageStates]
  );

  const isRunningAnyJob =
    isPreparing || isExtracting || isAnalyzingMetadata || combined.processingCount > 0;

  // Derived progress percentage — mathematically impossible to show 100% while pages are still running!
  const progressPercent = useMemo(() => {
    const total = images.length;
    if (total === 0) return 0;
    const settled = combined.completedCount + combined.failedCount;
    const active = combined.processingCount + (isExtracting ? combined.waitingCount : 0);

    if (isExtracting || combined.processingCount > 0) {
      const ocrCeiling = generateMetadata && total > 1 ? 85 : 95;
      const weighted = settled + combined.processingCount * 0.25;
      return Math.min(ocrCeiling, Math.max(5, Math.round((weighted / total) * ocrCeiling)));
    }
    if (isAnalyzingMetadata) {
      return 93;
    }
    if (active === 0 && settled === total) {
      return 100;
    }
    return Math.min(95, Math.round((settled / total) * 100));
  }, [images.length, combined, isExtracting, isAnalyzingMetadata, generateMetadata]);

  // Derived overall status text & tone — mathematically impossible to contradict per-page states!
  const { overallStatusText, overallStatusTone } = useMemo<{
    overallStatusText: string;
    overallStatusTone: 'neutral' | 'processing' | 'success' | 'partial' | 'error';
  }>(() => {
    const total = images.length;
    if (isPreparing) {
      return {
        overallStatusText: preparingMessage || 'Preparing images…',
        overallStatusTone: 'processing',
      };
    }

    if (isExtracting || combined.processingCount > 0) {
      const processingPages = images
        .map((img, idx) => ({ idx: idx + 1, status: pageStates[img.id]?.status }))
        .filter((p) => p.status === 'processing');

      if (processingPages.length > 1) {
        return {
          overallStatusText: `Processing ${processingPages.length} of ${total} pages concurrently…`,
          overallStatusTone: 'processing',
        };
      }
      if (processingPages.length === 1) {
        return {
          overallStatusText: `Processing page ${processingPages[0].idx} of ${total}…`,
          overallStatusTone: 'processing',
        };
      }
      return {
        overallStatusText: `Extracting notes (${combined.completedCount} of ${total} completed)…`,
        overallStatusTone: 'processing',
      };
    }

    if (isAnalyzingMetadata) {
      return {
        overallStatusText: 'Analyzing extracted notes…',
        overallStatusTone: 'processing',
      };
    }

    if (total === 0) {
      return { overallStatusText: 'No images selected', overallStatusTone: 'neutral' };
    }

    if (combined.completedCount === total) {
      return {
        overallStatusText: `Completed — ${total} of ${total} page${total === 1 ? '' : 's'} extracted`,
        overallStatusTone: 'success',
      };
    }

    if (combined.completedCount > 0 && combined.failedCount > 0) {
      return {
        overallStatusText: `${combined.completedCount} of ${total} completed · ${combined.failedCount} failed`,
        overallStatusTone: 'partial',
      };
    }

    if (combined.completedCount === 0 && combined.failedCount === total) {
      return {
        overallStatusText: `Extraction failed for all ${total} page${total === 1 ? '' : 's'}`,
        overallStatusTone: 'error',
      };
    }

    if (combined.completedCount > 0) {
      return {
        overallStatusText: `${combined.completedCount} of ${total} completed · ${combined.waitingCount} waiting`,
        overallStatusTone: 'partial',
      };
    }

    return {
      overallStatusText: `${total} page${total === 1 ? '' : 's'} ready to extract`,
      overallStatusTone: 'neutral',
    };
  }, [images, pageStates, isPreparing, preparingMessage, isExtracting, isAnalyzingMetadata, combined]);

  // Stalled-job watchdog: automatically detects and fails any page stuck in 'processing' > 35s
  useEffect(() => {
    if (combined.processingCount === 0) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const states = pageStatesRef.current;
      let changed = false;
      const nextStates: Record<string, PageExtractionState> = { ...states };

      for (const img of imagesRef.current) {
        const st = states[img.id];
        if (
          st &&
          st.status === 'processing' &&
          st.startedAt &&
          now - st.startedAt > SmartNoteCaptureService.PAGE_WATCHDOG_MS
        ) {
          pageControllersRef.current.get(img.id)?.abort();
          pageControllersRef.current.delete(img.id);
          nextStates[img.id] = {
            ...createWaitingPageState(),
            status: 'failed',
            error: {
              title: 'AI service timeout',
              detail: 'This page stalled and took too long to respond.',
              actionHint: 'Click Retry to try this page again.',
              reasonCode: 'TIMEOUT',
              retryable: true,
            },
          };
          changed = true;
        }
      }

      if (changed) {
        pageStatesRef.current = nextStates;
        setPageStates(nextStates);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [combined.processingCount]);

  // Progressive save helper: persists completed text immediately to state + sessionStorage
  const persistProgressiveDraft = useCallback(
    (nextImages: PreparedCaptureImage[], nextStates: Record<string, PageExtractionState>) => {
      const merged = SmartNoteCaptureService.combinePageResults(nextImages, nextStates);
      if (!contentManuallyEditedRef.current) {
        setExtractedContent(merged.combinedMarkdown);
      }
      if (firebaseUser && merged.completedCount > 0) {
        try {
          sessionStorage.setItem(
            `mindmesh_capture_progressive_${firebaseUser.uid}`,
            JSON.stringify({
              updatedAt: Date.now(),
              completedCount: merged.completedCount,
              totalCount: nextImages.length,
              combinedMarkdown: merged.combinedMarkdown,
            })
          );
        } catch {
          // Ignore storage quota issues safely
        }
      }
      return merged;
    },
    [firebaseUser]
  );

  const updateExtractedContentByUser = useCallback((val: string) => {
    contentManuallyEditedRef.current = true;
    setExtractedContent(val);
  }, []);

  const updatePageTranscription = useCallback(
    (imageId: string, newMarkdown: string) => {
      const existing = pageStatesRef.current[imageId];
      if (!existing) return;

      const updatedPage: PageExtractionState = {
        ...existing,
        extractedMarkdown: newMarkdown,
        wordCount: SmartNoteCaptureService.countWords(newMarkdown),
        hasUnclearText: /\[unclear\]/i.test(newMarkdown),
      };
      const nextStates = { ...pageStatesRef.current, [imageId]: updatedPage };
      pageStatesRef.current = nextStates;
      setPageStates(nextStates);
      contentManuallyEditedRef.current = false;
      persistProgressiveDraft(imagesRef.current, nextStates);
    },
    [persistProgressiveDraft]
  );

  const openCapturePanel = useCallback(() => {
    setPanelOpen(true);
    setActivePage('notes');
  }, [setActivePage]);

  const closeCapturePanel = useCallback(() => {
    setPanelOpen(false);
  }, []);

  const abortAllActiveRequests = useCallback(() => {
    runIdRef.current += 1;
    pageControllersRef.current.forEach((ctrl) => ctrl.abort());
    pageControllersRef.current.clear();
    metadataControllerRef.current?.abort();
    metadataControllerRef.current = null;
  }, []);

  const resetCaptureSession = useCallback(() => {
    abortAllActiveRequests();
    setStep('upload');
    setImages([]);
    setPageStates({});
    setIsPreparing(false);
    setPreparingMessage('');
    setIsExtracting(false);
    setIsAnalyzingMetadata(false);
    setSaving(false);
    setBannerError(null);
    setTitle('');
    setSubject(existingSubjectNames[0] || 'Computer Science');
    setTags([]);
    setExtractedContent('');
    setSuggestedSummary('');
    setIncludeSummary(true);
    contentManuallyEditedRef.current = false;
    if (firebaseUser) {
      try {
        sessionStorage.removeItem(`mindmesh_capture_progressive_${firebaseUser.uid}`);
      } catch {
        // ignore
      }
    }
  }, [abortAllActiveRequests, existingSubjectNames, firebaseUser]);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    setBannerError(null);

    const currentCount = imagesRef.current.length;
    const remainingSlots = SmartNoteCaptureService.MAX_IMAGES - currentCount;
    if (remainingSlots <= 0) {
      setBannerError(
        `Maximum of ${SmartNoteCaptureService.MAX_IMAGES} images per note reached. Remove a page to add another.`
      );
      return;
    }

    const filesToProcess = incoming.slice(0, remainingSlots);
    const overflowCount = incoming.length - filesToProcess.length;

    setIsPreparing(true);
    setPreparingMessage(
      filesToProcess.length === 1
        ? 'Preparing image…'
        : `Preparing images (0 of ${filesToProcess.length})…`
    );

    const { prepared, errors } = await workspaceService.smartNoteCaptureService.prepareImageFiles(
      filesToProcess,
      (done, total) => {
        setPreparingMessage(`Preparing images (${done} of ${total})…`);
      }
    );

    if (prepared.length > 0) {
      setImages((prev) => [...prev, ...prepared]);
      setPageStates((prev) => {
        const next = { ...prev };
        for (const img of prepared) {
          next[img.id] = createWaitingPageState();
        }
        return next;
      });
    }

    if (overflowCount > 0) {
      errors.push(
        `Only the first ${filesToProcess.length} image(s) were added (max ${SmartNoteCaptureService.MAX_IMAGES} per note).`
      );
    }

    if (errors.length > 0) {
      setBannerError(errors.join(' '));
    }

    setIsPreparing(false);
    setPreparingMessage('');
  }, []);

  const removeImage = useCallback(
    (imageId: string) => {
      const ctrl = pageControllersRef.current.get(imageId);
      if (ctrl) {
        ctrl.abort();
        pageControllersRef.current.delete(imageId);
      }
      const nextImages = imagesRef.current.filter((img) => img.id !== imageId);
      const nextStates = { ...pageStatesRef.current };
      delete nextStates[imageId];
      imagesRef.current = nextImages;
      pageStatesRef.current = nextStates;
      setImages(nextImages);
      setPageStates(nextStates);
      persistProgressiveDraft(nextImages, nextStates);
      setBannerError(null);
    },
    [persistProgressiveDraft]
  );

  const moveImage = useCallback(
    (index: number, direction: -1 | 1) => {
      const prev = imagesRef.current;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      imagesRef.current = next;
      setImages(next);
      persistProgressiveDraft(next, pageStatesRef.current);
    },
    [persistProgressiveDraft]
  );

  const clearImages = useCallback(() => {
    abortAllActiveRequests();
    setImages([]);
    setPageStates({});
    setIsExtracting(false);
    setIsAnalyzingMetadata(false);
    setBannerError(null);
    setStep('upload');
  }, [abortAllActiveRequests]);

  /**
   * Core page processor used by both batch extraction and single-page retry.
   * Saves results progressively immediately upon completion.
   */
  const processPage = useCallback(
    async (params: {
      image: PreparedCaptureImage;
      pageNumber: number;
      totalPages: number;
      includeMetadata: boolean;
      expectedRunId?: number;
    }): Promise<PageExtractionState | null> => {
      if (!firebaseUser) return null;

      const { image, pageNumber, totalPages, includeMetadata, expectedRunId } = params;

      // Cancel any existing in-flight request for this specific page
      pageControllersRef.current.get(image.id)?.abort();
      const pageCtrl = new AbortController();
      pageControllersRef.current.set(image.id, pageCtrl);

      const startedAt = Date.now();
      const processingState: PageExtractionState = {
        ...createWaitingPageState(),
        status: 'processing',
        statusNote: 'Reading handwriting, formulas & layout…',
        startedAt,
      };
      pageStatesRef.current = { ...pageStatesRef.current, [image.id]: processingState };
      setPageStates((prev) => ({ ...prev, [image.id]: processingState }));

      try {
        const result = await workspaceService.smartNoteCaptureService.extractSinglePage(
          { userId: firebaseUser.uid },
          {
            image,
            pageNumber,
            totalPages,
            includeMetadata,
            existingSubjects: existingSubjectNames,
            onStatusNote: (note) => {
              if (
                pageCtrl.signal.aborted ||
                (expectedRunId !== undefined && runIdRef.current !== expectedRunId)
              ) {
                return;
              }
              const updated: PageExtractionState = {
                ...(pageStatesRef.current[image.id] || processingState),
                status: 'processing',
                statusNote: note,
              };
              pageStatesRef.current = { ...pageStatesRef.current, [image.id]: updated };
              setPageStates((prev) => ({ ...prev, [image.id]: updated }));
            },
          },
          pageCtrl.signal
        );

        // Ignore stale response if cancelled or replaced by a newer run
        if (
          pageCtrl.signal.aborted ||
          (expectedRunId !== undefined && runIdRef.current !== expectedRunId)
        ) {
          return null;
        }

        const computedWordCount = SmartNoteCaptureService.countWords(result.extractedMarkdown);
        const completedState: PageExtractionState = {
          status: 'completed',
          statusNote: undefined,
          extractedMarkdown: result.extractedMarkdown,
          wordCount: computedWordCount,
          qualityCheckPassed: result.qualityCheckPassed ?? true,
          qualityCheckReason: result.qualityCheckReason ?? 'OK',
          retryCount: result.retryCount ?? result.debug?.retryCount ?? 0,
          hasUnclearText: result.hasUnclearText,
          unclearWarnings: result.unclearWarnings || [],
          confidenceNote: result.confidenceNote || '',
          modelUsed: result.modelUsed,
          debug: result.debug,
          durationMs: Date.now() - startedAt,
          suggestedTitle: result.suggestedTitle,
          suggestedSummary: result.suggestedSummary,
          suggestedSubject: result.suggestedSubject,
          suggestedTags: result.suggestedTags,
        };

        const nextStates = { ...pageStatesRef.current, [image.id]: completedState };
        pageStatesRef.current = nextStates;
        setPageStates(nextStates);

        // Save result progressively immediately — do NOT wait for all pages!
        persistProgressiveDraft(imagesRef.current, nextStates);

        return completedState;
      } catch (err) {
        // ONLY swallow if THIS page's AbortController or runId was explicitly cancelled
        if (
          pageCtrl.signal.aborted ||
          (expectedRunId !== undefined && runIdRef.current !== expectedRunId)
        ) {
          return null;
        }

        const classified = SmartNoteCaptureService.classifyError(err);
        const debugFromErr =
          err instanceof ImageCaptureException && err.debugInfo
            ? (err.debugInfo as unknown as PageExtractionState['debug'])
            : undefined;
        const failedState: PageExtractionState = {
          ...createWaitingPageState(),
          status: 'failed',
          wordCount: debugFromErr?.wordCount ?? 0,
          qualityCheckPassed: debugFromErr?.qualityCheckPassed ?? false,
          qualityCheckReason: debugFromErr?.qualityCheckReason,
          retryCount: debugFromErr?.retryCount ?? 0,
          durationMs: Date.now() - startedAt,
          debug: debugFromErr,
          error: classified,
        };

        const nextStates = { ...pageStatesRef.current, [image.id]: failedState };
        pageStatesRef.current = nextStates;
        setPageStates(nextStates);
        return failedState;
      } finally {
        if (pageControllersRef.current.get(image.id) === pageCtrl) {
          pageControllersRef.current.delete(image.id);
        }
      }
    },
    [firebaseUser, existingSubjectNames, persistProgressiveDraft]
  );

  const runMetadataSynthesis = useCallback(
    async (combinedMarkdown: string, expectedRunId: number) => {
      if (!firebaseUser || !combinedMarkdown.trim()) return;

      metadataControllerRef.current?.abort();
      const metaCtrl = new AbortController();
      metadataControllerRef.current = metaCtrl;

      setIsAnalyzingMetadata(true);
      try {
        const meta = await workspaceService.smartNoteCaptureService.generateMetadata(
          { userId: firebaseUser.uid },
          {
            combinedMarkdown,
            existingSubjects: existingSubjectNames,
          },
          metaCtrl.signal
        );
        if (metaCtrl.signal.aborted || runIdRef.current !== expectedRunId) return;

        setTitle(meta.suggestedTitle || `Captured Notes (${new Date().toLocaleDateString()})`);
        setSubject(meta.suggestedSubject || existingSubjectNames[0] || 'General');
        setTags(Note.sanitizeTags(meta.suggestedTags || []));
        setSuggestedSummary(meta.suggestedSummary || '');
        setIncludeSummary(Boolean(meta.suggestedSummary?.trim()));
      } catch {
        if (metaCtrl.signal.aborted || runIdRef.current !== expectedRunId) return;
        // Non-fatal fallback: keep extracted pages editable and ready to save
        setTitle((prev) => prev || `Captured Notes (${new Date().toLocaleDateString()})`);
        setSubject((prev) => prev || existingSubjectNames[0] || 'General');
      } finally {
        if (metadataControllerRef.current === metaCtrl) {
          metadataControllerRef.current = null;
        }
        if (runIdRef.current === expectedRunId) {
          setIsAnalyzingMetadata(false);
        }
      }
    },
    [firebaseUser, existingSubjectNames]
  );

  const startExtraction = useCallback(
    async (options?: { onlyFailed?: boolean }) => {
      if (!firebaseUser) return;
      const currentImages = imagesRef.current;
      if (currentImages.length === 0) {
        setBannerError('Upload or capture at least one note image before extracting.');
        return;
      }

      abortAllActiveRequests();
      const myRunId = runIdRef.current;

      setBannerError(null);
      setIsExtracting(true);
      setIsAnalyzingMetadata(false);
      setStep('extracting');

      const totalPages = currentImages.length;
      const nextStates: Record<string, PageExtractionState> = { ...pageStatesRef.current };
      const targetIndices: number[] = [];

      currentImages.forEach((img, idx) => {
        const existing = nextStates[img.id];
        if (existing?.status === 'completed' && existing.extractedMarkdown.trim()) {
          // Never waste API calls reprocessing already-completed pages
          return;
        }
        if (options?.onlyFailed && existing?.status !== 'failed') {
          return;
        }
        nextStates[img.id] = createWaitingPageState();
        targetIndices.push(idx);
      });

      pageStatesRef.current = nextStates;
      setPageStates({ ...nextStates });

      const singlePageInlineMetadata = totalPages === 1 && generateMetadata;
      let cursor = 0;
      const concurrency = Math.min(
        SmartNoteCaptureService.MAX_CONCURRENCY,
        Math.max(1, targetIndices.length)
      );

      const worker = async () => {
        while (cursor < targetIndices.length) {
          if (runIdRef.current !== myRunId) return;
          const idx = targetIndices[cursor++];
          const img = currentImages[idx];
          await processPage({
            image: img,
            pageNumber: idx + 1,
            totalPages,
            includeMetadata: singlePageInlineMetadata,
            expectedRunId: myRunId,
          });
        }
      };

      if (targetIndices.length > 0) {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      }

      if (runIdRef.current !== myRunId) {
        return;
      }

      setIsExtracting(false);

      const merged = persistProgressiveDraft(currentImages, pageStatesRef.current);

      if (merged.completedCount === 0) {
        setBannerError(
          'No pages could be extracted. Review each page error below and retry individual pages or upload clearer photos.'
        );
        return;
      }

      if (generateMetadata) {
        if (singlePageInlineMetadata) {
          const only = pageStatesRef.current[currentImages[0].id];
          setTitle(only?.suggestedTitle || `Captured Notes (${new Date().toLocaleDateString()})`);
          setSubject(only?.suggestedSubject || existingSubjectNames[0] || 'General');
          setTags(Note.sanitizeTags(only?.suggestedTags || []));
          setSuggestedSummary(only?.suggestedSummary || '');
          setIncludeSummary(Boolean(only?.suggestedSummary?.trim()));
        } else {
          await runMetadataSynthesis(merged.combinedMarkdown, myRunId);
        }
      } else {
        setTitle((prev) => prev || `Captured Notes (${new Date().toLocaleDateString()})`);
        setSubject((prev) => prev || existingSubjectNames[0] || 'General');
        setSuggestedSummary('');
        setIncludeSummary(false);
      }

      if (runIdRef.current !== myRunId) return;

      // Only auto-jump into Review if ALL pages succeeded; if some failed, stay on the clean extraction screen
      // where completed previews AND failed-page Retry buttons are immediately visible (plus a 1-click "Continue to Review" button)!
      if (merged.failedCount === 0) {
        setStep('review');
      }

      if (!panelOpenRef.current || activePageRef.current !== 'notes') {
        notify(
          merged.failedCount > 0
            ? `Smart Note Capture: ${merged.completedCount}/${totalPages} pages completed (${merged.failedCount} failed — click Open to retry).`
            : `Smart Note Capture completed: ${merged.completedCount}/${totalPages} page${totalPages > 1 ? 's' : ''} ready to review.`,
          merged.failedCount > 0 ? 'info' : 'success'
        );
      }
    },
    [
      firebaseUser,
      abortAllActiveRequests,
      generateMetadata,
      processPage,
      persistProgressiveDraft,
      existingSubjectNames,
      runMetadataSynthesis,
      notify,
    ]
  );

  const retryFailedPages = useCallback(async () => {
    await startExtraction({ onlyFailed: true });
  }, [startExtraction]);

  const retrySinglePage = useCallback(
    async (imageId: string) => {
      if (!firebaseUser) return;
      const currentImages = imagesRef.current;
      const idx = currentImages.findIndex((img) => img.id === imageId);
      if (idx === -1) return;

      const img = currentImages[idx];
      const totalPages = currentImages.length;
      const singlePageInlineMetadata = totalPages === 1 && generateMetadata;

      setBannerError(null);
      const outcome = await processPage({
        image: img,
        pageNumber: idx + 1,
        totalPages,
        includeMetadata: singlePageInlineMetadata,
      });

      if (!outcome) return;

      if (outcome.status === 'completed') {
        if (singlePageInlineMetadata && outcome.suggestedTitle) {
          setTitle(outcome.suggestedTitle);
          setSubject(outcome.suggestedSubject || existingSubjectNames[0] || 'General');
          setTags(Note.sanitizeTags(outcome.suggestedTags || []));
          setSuggestedSummary(outcome.suggestedSummary || '');
          setIncludeSummary(Boolean(outcome.suggestedSummary?.trim()));
        } else if (!title.trim()) {
          setTitle(`Captured Notes (${new Date().toLocaleDateString()})`);
        }

        if (contentManuallyEditedRef.current) {
          const addition =
            totalPages > 1
              ? `## Page ${idx + 1}\n\n${outcome.extractedMarkdown.trim()}`
              : outcome.extractedMarkdown.trim();
          setExtractedContent((prev) =>
            prev.trim() ? `${prev.trim()}\n\n---\n\n${addition}` : addition
          );
        }

        notify(`Page ${idx + 1} extracted and saved progressively.`, 'success');
      } else if (outcome.status === 'failed' && outcome.error) {
        notify(`Page ${idx + 1}: ${outcome.error.title}`, 'error');
      }
    },
    [firebaseUser, generateMetadata, processPage, existingSubjectNames, title, notify]
  );

  /**
   * Immediate, non-blocking cancellation:
   * - Aborts all in-flight page & metadata requests
   * - Invalidates runId so any un-cancellable response is completely ignored
   * - Preserves uploaded images and any already-completed pages
   * - Immediately returns the user to the previous screen without freezing
   */
  const cancelExtraction = useCallback(
    (returnToUpload = true) => {
      abortAllActiveRequests();
      setIsExtracting(false);
      setIsAnalyzingMetadata(false);
      setBannerError(null);

      // Revert any in-flight 'processing' pages cleanly to 'waiting', preserving completed & failed pages
      const nextStates: Record<string, PageExtractionState> = {};
      let completed = 0;
      for (const img of imagesRef.current) {
        const prev = pageStatesRef.current[img.id] || createWaitingPageState();
        if (prev.status === 'completed') {
          completed += 1;
          nextStates[img.id] = prev;
        } else if (prev.status === 'processing') {
          nextStates[img.id] = createWaitingPageState();
        } else {
          nextStates[img.id] = prev;
        }
      }
      pageStatesRef.current = nextStates;
      setPageStates(nextStates);

      if (completed > 0) {
        persistProgressiveDraft(imagesRef.current, nextStates);
      }

      if (returnToUpload) {
        setStep('upload');
      }

      notify(
        completed > 0
          ? `Extraction cancelled. ${completed} already-completed page${completed > 1 ? 's were' : ' was'} preserved.`
          : 'Extraction cancelled.',
        'info'
      );
    },
    [abortAllActiveRequests, persistProgressiveDraft, notify]
  );

  const buildFinalContent = useCallback((): string => {
    const trimmedContent = extractedContent.trim();
    const summaryText = suggestedSummary.trim();
    if (includeSummary && summaryText) {
      return `> **AI Summary:** ${summaryText}\n\n${trimmedContent}`;
    }
    return trimmedContent;
  }, [extractedContent, includeSummary, suggestedSummary]);

  const saveCapturedNoteDirectly = useCallback(async (): Promise<string | null> => {
    if (!firebaseUser) return null;
    const finalTitle = title.trim() || `Captured Notes (${new Date().toLocaleDateString()})`;
    const finalSubject = subject.trim() || existingSubjectNames[0] || 'General';
    const finalContent = buildFinalContent();

    if (!finalContent) {
      setBannerError('Extracted content cannot be empty before saving.');
      return null;
    }

    setBannerError(null);
    setSaving(true);
    try {
      const created = await workspaceService.createNote({
        userId: firebaseUser.uid,
        title: finalTitle,
        content: finalContent,
        subject: finalSubject,
        tags,
        existingNotes: notes,
        existingGraphNodes: graphNodes,
        attachments: retainImages ? imagesRef.current : [],
        isSmartCapture: true,
      });

      notify(
        retainImages
          ? `Captured note saved with ${imagesRef.current.length} private source image(s) and linked into Brain Graph.`
          : 'Captured note saved with semantic embedding and linked into Brain Graph.',
        'success'
      );
      setActiveNoteId(created.noteId);
      setPanelOpen(false);
      resetCaptureSession();
      return created.noteId;
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to save captured note.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [
    firebaseUser,
    title,
    subject,
    existingSubjectNames,
    buildFinalContent,
    tags,
    notes,
    graphNodes,
    retainImages,
    notify,
    setActiveNoteId,
    resetCaptureSession,
  ]);

  const requestTransferToEditor = useCallback(
    (mode: 'new' | 'append') => {
      const finalContent = buildFinalContent();
      if (!finalContent) {
        setBannerError('Extracted content cannot be empty.');
        return;
      }

      setPendingEditorTransfer({
        title: title.trim() || `Captured Notes (${new Date().toLocaleDateString()})`,
        subject: subject.trim() || existingSubjectNames[0] || 'General',
        tags,
        content: finalContent,
        attachments: retainImages ? imagesRef.current : [],
        mode,
      });
      setPanelOpen(false);
      resetCaptureSession();
    },
    [buildFinalContent, title, subject, existingSubjectNames, tags, retainImages, resetCaptureSession]
  );

  const consumeEditorTransfer = useCallback((): SmartCaptureTransferPayload | null => {
    const current = pendingEditorTransfer;
    if (current) {
      setPendingEditorTransfer(null);
    }
    return current;
  }, [pendingEditorTransfer]);

  return (
    <SmartCaptureContext.Provider
      value={{
        panelOpen,
        openCapturePanel,
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
        waitingCount: combined.waitingCount,
        processingCount: combined.processingCount,
        completedCount: combined.completedCount,
        failedCount: combined.failedCount,
        hasUnclearText: combined.hasUnclearText,
        unclearWarnings: combined.unclearWarnings,
        confidenceNotes: combined.confidenceNotes,
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
        setExtractedContent: updateExtractedContentByUser,
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
        pendingEditorTransfer,
        consumeEditorTransfer,
        requestTransferToEditor,
      }}
    >
      {children}
    </SmartCaptureContext.Provider>
  );
};

export function useSmartCapture(): SmartCaptureContextValue {
  const ctx = useContext(SmartCaptureContext);
  if (!ctx) throw new Error('useSmartCapture must be used inside SmartCaptureProvider');
  return ctx;
}
