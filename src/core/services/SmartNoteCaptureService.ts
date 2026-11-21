import { BaseFeatureService } from './BaseFeatureService';
import {
  AIServiceException,
  ImageCaptureException,
  type ImageCaptureReasonCode,
} from '../exceptions/MindMeshExceptions';
import type {
  AIProvider,
  CaptureImageInput,
  CaptureMetadataPayload,
  ExtractionDebugInfo,
  FeatureContext,
  PageExtractionResult,
  SmartNoteCapturePayload,
} from '../interfaces/CoreInterfaces';
import { NoteAttachment, type SupportedAttachmentMime } from '../models/NoteAttachment';
import {
  generateSafeId,
  type ActivityHistoryRepository,
  type NoteAttachmentRepository,
} from '../repositories/FirestoreRepositories';

/**
 * OOP CONCEPTS: Inheritance & Polymorphism
 * SmartNoteCaptureService extends BaseFeatureService and manages:
 *  - High-clarity image validation & preprocessing (1800px @ 0.86) with exact MIME integrity & blank-canvas guard
 *  - Vision-capable per-page OCR with AbortSignal cancellation & automatic contrast-enhanced fallback retry
 *  - Transparent, non-silent typed error classification & development diagnostics logging
 *  - Private Firestore image attachment retention
 */

export interface PreparedCaptureImage {
  id: string;
  fileName: string;
  /** Verified MIME type matching visionBase64 bytes */
  mimeType: SupportedAttachmentMime;
  /** Verified MIME type matching storageDataUrl bytes */
  storageMimeType: SupportedAttachmentMime;
  originalSizeBytes: number;
  visionSizeBytes: number;
  previewUrl: string;
  visionBase64: string;
  storageDataUrl: string;
  storageSizeBytes: number;
  /** Retained strictly in memory so automatic high-res contrast fallback can re-process from original quality */
  sourceFile?: File;
}

export type PageProcessingStatus = 'waiting' | 'processing' | 'completed' | 'failed';

export interface PageErrorDetail {
  title: string;
  detail: string;
  actionHint: string;
  reasonCode: ImageCaptureReasonCode;
  retryable: boolean;
}

export interface PageExtractionState {
  status: PageProcessingStatus;
  statusNote?: string;
  extractedMarkdown: string;
  wordCount?: number;
  qualityCheckPassed?: boolean;
  qualityCheckReason?: string;
  retryCount?: number;
  hasUnclearText: boolean;
  unclearWarnings: string[];
  confidenceNote: string;
  modelUsed?: string;
  debug?: ExtractionDebugInfo;
  error?: PageErrorDetail;
  startedAt?: number;
  durationMs?: number;
  suggestedTitle?: string;
  suggestedSummary?: string;
  suggestedSubject?: string;
  suggestedTags?: string[];
}

export interface SmartNoteCaptureInput {
  images: PreparedCaptureImage[];
  generateMetadata: boolean;
  existingSubjects: string[];
}

export interface CombinedExtractionOutput {
  combinedMarkdown: string;
  hasUnclearText: boolean;
  unclearWarnings: string[];
  confidenceNotes: string[];
  waitingCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
}

function extractMimeFromDataUrl(
  dataUrl: string,
  fallback: SupportedAttachmentMime = 'image/jpeg'
): SupportedAttachmentMime {
  if (dataUrl.startsWith('data:image/png')) return 'image/png';
  if (dataUrl.startsWith('data:image/webp')) return 'image/webp';
  if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) {
    return 'image/jpeg';
  }
  return fallback;
}

function extractBase64FromDataUrl(dataUrl: string): string {
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1).trim() : dataUrl.trim();
}

function isDevLoggingEnabled(): boolean {
  try {
    return Boolean(import.meta.env?.DEV) || localStorage.getItem('mindmesh_capture_debug') === 'true';
  } catch {
    return false;
  }
}

export class SmartNoteCaptureService extends BaseFeatureService<
  SmartNoteCaptureInput,
  SmartNoteCapturePayload
> {
  public static readonly MAX_IMAGES = 6;
  public static readonly MAX_RAW_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per raw file
  public static readonly MAX_CONCURRENCY = 2; // Parallel processing without overwhelming API burst limits
  public static readonly PAGE_WATCHDOG_MS = 56_000; // Failsafe watchdog (> client 48s timeout) to detect stalled jobs
  /** High-clarity OCR resolution so handwritten words, subscripts, formulas & diagrams remain crisp */
  public static readonly VISION_MAX_DIMENSION = 1800;
  public static readonly VISION_QUALITY = 0.86;
  /** Automatic fallback resolution & quality when retrying with contrast enhancement */
  public static readonly FALLBACK_MAX_DIMENSION = 2200;
  public static readonly FALLBACK_QUALITY = 0.92;
  public static readonly ACCEPTED_MIMES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
  ]);

  private readonly attachmentRepo: NoteAttachmentRepository;

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    attachmentRepo: NoteAttachmentRepository
  ) {
    super(aiProvider, activityRepo);
    this.attachmentRepo = attachmentRepo;
  }

  public getServiceName(): string {
    return 'SmartNoteCaptureService';
  }

  public async execute(
    context: FeatureContext,
    input: SmartNoteCaptureInput
  ): Promise<SmartNoteCapturePayload> {
    this.validateUserContext(context);

    if (!input.images || input.images.length === 0) {
      throw new ImageCaptureException(
        'Upload or capture at least one image before extracting notes.',
        'PROCESSING_ERROR'
      );
    }

    if (input.images.length > SmartNoteCaptureService.MAX_IMAGES) {
      throw new ImageCaptureException(
        `You can upload up to ${SmartNoteCaptureService.MAX_IMAGES} images per note.`,
        'FILE_TOO_LARGE'
      );
    }

    const visionPayload: CaptureImageInput[] = input.images.map((img) => ({
      fileName: img.fileName,
      mimeType: img.mimeType,
      base64Data: img.visionBase64,
    }));

    const result = await this.aiProvider.captureNotesFromImages({
      images: visionPayload,
      generateMetadata: input.generateMetadata,
      existingSubjects: input.existingSubjects,
    });

    if (!result.extractedMarkdown?.trim()) {
      throw new ImageCaptureException(
        result.confidenceNote ||
          'Text could not be detected from the uploaded image(s). Try a clearer, well-lit photo.',
        'EMPTY_EXTRACTION'
      );
    }

    return result;
  }

  /**
   * Strips Markdown fences, conversational intros/outros, and redundant horizontal divider runs.
   */
  public static cleanTranscriptionMarkdown(rawText: string): string {
    let text = String(rawText || '').replace(/\r\n/g, '\n').trim();
    if (!text) return '';

    const fenceMatch = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
    if (fenceMatch && fenceMatch[1]) {
      text = fenceMatch[1].trim();
    }

    const lines = text.split('\n');
    while (
      lines.length > 0 &&
      /^(?:here\s+(?:is|are)\s+(?:a|the)?\s*(?:verbatim\s+)?(?:transcription|extracted\s+text|notes|markdown)|below\s+is\s+(?:a|the)?\s*(?:transcription|extracted)|sure[,!.]?\s+here|certainly[,!.]?\s+here|transcription\s*:|extracted\s+notes\s*:)/i.test(
        lines[0].trim()
      )
    ) {
      lines.shift();
    }
    while (
      lines.length > 0 &&
      /^(?:let\s+me\s+know\s+if|hope\s+this\s+helps|note:\s*some\s+parts\s+of\s+the\s+image)/i.test(
        lines[lines.length - 1].trim()
      )
    ) {
      lines.pop();
    }

    const cleaned = lines
      .join('\n')
      .replace(/^(?:\s*[-_*]{3,}\s*\n)+/, '')
      .replace(/(?:\n\s*[-_*]{3,}\s*)+$/, '')
      .replace(/\n(?:\s*[-_*]{3,}\s*\n){2,}/g, '\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  }

  /**
   * Computes real word count strictly from the actual transcribed text (never AI-estimated),
   * excluding Markdown syntax, horizontal rules (---), table borders, and [unclear] markers.
   */
  public static countWords(markdown: string): number {
    if (!markdown) return 0;
    const stripped = markdown
      .replace(/\[unclear\]/gi, ' ')
      .replace(/^[-_*=]{3,}$/gm, ' ')
      .replace(/[|#`*>_~]/g, ' ');
    const tokens = stripped
      .split(/\s+/)
      .map((t) => t.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
      .filter((t) => /[a-zA-Z0-9]/.test(t));
    return tokens.length;
  }

  /**
   * Validates transcription quality so empty, divider-only, or generic image-description outputs
   * are NEVER marked Completed.
   */
  public static validateExtractedQuality(
    cleanedMarkdown: string,
    fileSizeBytes: number
  ): { passed: boolean; reason: string; wordCount: number; textLength: number } {
    const text = cleanedMarkdown.trim();
    const textLength = text.length;
    const wordCount = SmartNoteCaptureService.countWords(text);

    if (!text || wordCount === 0) {
      return { passed: false, reason: 'EMPTY_OR_DIVIDERS_ONLY', wordCount, textLength };
    }

    const meaningfulLines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^[-_*=|:\s]+$/.test(l));

    if (meaningfulLines.length === 0) {
      return { passed: false, reason: 'EMPTY_OR_DIVIDERS_ONLY', wordCount, textLength };
    }

    const first300 = text.slice(0, 300);
    const strongGenericOpening =
      /^(?:this|the)\s+(?:uploaded\s+)?(?:image|photo|picture|page|document|handwritten\s+page)\s+(?:contains|shows|depicts|displays|features|presents|illustrates|consists\s+of|is\s+a\s+(?:photo|scan|page|picture))/i.test(
        first300
      ) ||
      /^(?:in\s+this\s+image|the\s+image\s+appears\s+to\s+be|an?\s+overview\s+of\s+the\s+image|summary\s+of\s+the\s+image)/i.test(
        first300
      );

    const visualCaptionSignals = [
      /\b(?:this|the)\s+(?:uploaded\s+)?image\s+(?:contains|shows|depicts|features|is\s+divided\s+into)\b/i,
      /\b(?:written\s+in\s+(?:blue|black|red|green|pink|neat|cursive)\s+(?:ink|pen|handwriting))\b/i,
      /\b(?:highlighted\s+in\s+(?:yellow|green|pink|blue|orange))\b/i,
      /\b(?:on\s+(?:lined|ruled|white|blank)\s+(?:notebook\s+)?paper)\b/i,
      /\b(?:in\s+the\s+(?:top|bottom)\s+(?:left|right)\s+corner\s+of\s+the\s+(?:image|page))\b/i,
      /\b(?:visual\s+layout\s+of\s+the\s+page|overall\s+structure\s+of\s+the\s+image)\b/i,
    ];
    const captionHits = visualCaptionSignals.filter((re) => re.test(text)).length;

    if (strongGenericOpening && (captionHits >= 1 || wordCount < 90)) {
      return { passed: false, reason: 'GENERIC_IMAGE_DESCRIPTION', wordCount, textLength };
    }
    if (captionHits >= 2) {
      return { passed: false, reason: 'GENERIC_IMAGE_DESCRIPTION', wordCount, textLength };
    }

    if (fileSizeBytes > 50 * 1024 && wordCount < 8) {
      return { passed: false, reason: 'SUSPICIOUSLY_SHORT', wordCount, textLength };
    }

    return { passed: true, reason: 'OK', wordCount, textLength };
  }

  /**
   * Logs structured dev diagnostics for every capture attempt (never includes API keys or secrets).
   */
  public static logDevDiagnostics(label: string, info: Partial<ExtractionDebugInfo>): void {
    if (!isDevLoggingEnabled()) return;
    console.groupCollapsed(`[MindMesh SmartCapture Debug] ${label}`);
    console.log({
      fileName: info.fileName,
      fileSizeBytes: info.fileSizeBytes,
      fileSizeKB: info.fileSizeBytes ? Number((info.fileSizeBytes / 1024).toFixed(1)) : 0,
      mimeType: info.mimeType,
      detectedFormat: info.detectedFormat,
      imageAttached: info.imageAttached,
      base64Length: info.base64Length,
      modelName: info.modelName,
      thinkingLevel: info.thinkingLevel,
      retryMode: info.retryMode,
      httpStatus: info.httpStatus,
      responseContentType: info.responseContentType,
      responseFormat: info.responseFormat,
      extractedTextLength: info.extractedTextLength,
      wordCount: info.wordCount,
      qualityCheckPassed: info.qualityCheckPassed,
      qualityCheckReason: info.qualityCheckReason,
      retryCount: info.retryCount ?? 0,
      finishReason: info.finishReason,
      durationMs: info.durationMs,
      fallbackAttempted: info.fallbackAttempted ?? false,
      rawResponsePreview: info.rawResponsePreview,
      actualError: info.actualError,
    });
    console.groupEnd();
  }

  /**
   * Classifies any extraction error into an exact, transparent title, detail, and actionable hint.
   * NEVER masks API, model, payload, timeout, or parsing errors as "Text could not be detected."
   */
  public static classifyError(err: unknown): PageErrorDetail {
    if (err instanceof ImageCaptureException) {
      switch (err.reasonCode) {
        case 'EMPTY_EXTRACTION':
          return {
            title: 'Text could not be detected',
            detail: err.message,
            actionHint: 'Even after contrast enhancement, no readable text was found. Try a closer, well-lit photo or remove this page.',
            reasonCode: 'EMPTY_EXTRACTION',
            retryable: true,
          };
        case 'INVALID_IMAGE_PAYLOAD':
          return {
            title: 'Invalid image payload',
            detail: err.message,
            actionHint: 'Remove and re-upload a valid JPG, PNG, or WebP photo.',
            reasonCode: 'INVALID_IMAGE_PAYLOAD',
            retryable: false,
          };
        case 'EMPTY_AI_RESPONSE':
          return {
            title: 'Empty AI response',
            detail: err.message,
            actionHint: 'The vision model returned an empty response. Click Retry to try again.',
            reasonCode: 'EMPTY_AI_RESPONSE',
            retryable: true,
          };
        case 'MODEL_ERROR':
          return {
            title: 'AI model error',
            detail: err.message,
            actionHint: 'Wait a moment and click Retry to run this page again.',
            reasonCode: 'MODEL_ERROR',
            retryable: true,
          };
        case 'PARSING_ERROR':
          return {
            title: 'Response parsing error',
            detail: err.message,
            actionHint: 'The server returned an unexpected format. Click Retry.',
            reasonCode: 'PARSING_ERROR',
            retryable: true,
          };
        case 'QUALITY_VALIDATION_FAILED':
          return {
            title: 'Transcription quality check failed',
            detail: err.message,
            actionHint: 'The AI returned an image description or incomplete text instead of the actual notes. Click Retry to transcribe again.',
            reasonCode: 'QUALITY_VALIDATION_FAILED',
            retryable: true,
          };
        case 'TIMEOUT':
          return {
            title: 'AI service timeout',
            detail: err.message,
            actionHint: 'Click Retry to try this page again.',
            reasonCode: 'TIMEOUT',
            retryable: true,
          };
        case 'NETWORK_ERROR':
          return {
            title: 'Network error',
            detail: err.message,
            actionHint: 'Check your internet connection and click Retry.',
            reasonCode: 'NETWORK_ERROR',
            retryable: true,
          };
        case 'RATE_LIMITED':
          return {
            title: 'API rate limit reached',
            detail: err.message,
            actionHint: 'Wait a few seconds, then click Retry.',
            reasonCode: 'RATE_LIMITED',
            retryable: true,
          };
        case 'INVALID_FILE_TYPE':
          return {
            title: 'Unsupported file',
            detail: err.message,
            actionHint: 'Upload a JPG, JPEG, PNG, or WebP image instead.',
            reasonCode: 'INVALID_FILE_TYPE',
            retryable: false,
          };
        case 'UNREADABLE_IMAGE':
          return {
            title: 'Image could not be read',
            detail: err.message,
            actionHint: 'Remove and re-upload a valid, uncorrupted photo.',
            reasonCode: 'UNREADABLE_IMAGE',
            retryable: false,
          };
        case 'API_ERROR':
          return {
            title: 'API request failure',
            detail: err.message,
            actionHint: 'Click Retry to try again.',
            reasonCode: 'API_ERROR',
            retryable: true,
          };
        default:
          return {
            title: 'Extraction error',
            detail: err.message,
            actionHint: 'Click Retry to reprocess this page.',
            reasonCode: err.reasonCode,
            retryable: true,
          };
      }
    }

    if (err instanceof AIServiceException) {
      if (err.serverCode === 'INVALID_IMAGE_PAYLOAD') {
        return {
          title: 'Invalid image payload',
          detail: err.message,
          actionHint: 'Remove and re-upload a valid JPG, PNG, or WebP image.',
          reasonCode: 'INVALID_IMAGE_PAYLOAD',
          retryable: false,
        };
      }
      if (err.serverCode === 'EMPTY_AI_RESPONSE') {
        return {
          title: 'Empty AI response',
          detail: err.message,
          actionHint: 'Click Retry to request vision extraction again.',
          reasonCode: 'EMPTY_AI_RESPONSE',
          retryable: true,
        };
      }
      if (err.serverCode === 'PARSING_ERROR') {
        return {
          title: 'Response parsing error',
          detail: err.message,
          actionHint: 'Click Retry to try this page again.',
          reasonCode: 'PARSING_ERROR',
          retryable: true,
        };
      }
      if (err.serverCode === 'QUALITY_VALIDATION_FAILED') {
        return {
          title: 'Transcription quality check failed',
          detail: err.message,
          actionHint: 'The AI returned an image description or incomplete text instead of the actual notes. Click Retry.',
          reasonCode: 'QUALITY_VALIDATION_FAILED',
          retryable: true,
        };
      }
      if (err.serverCode === 'MODEL_ERROR') {
        return {
          title: 'AI model error',
          detail: err.message,
          actionHint: 'Wait a moment, then click Retry.',
          reasonCode: 'MODEL_ERROR',
          retryable: true,
        };
      }
      if (err.statusCode === 504) {
        return {
          title: 'AI service timeout',
          detail: err.message,
          actionHint: 'Click Retry to try this page again.',
          reasonCode: 'TIMEOUT',
          retryable: true,
        };
      }
      if (err.statusCode === 503) {
        const lowerMsg = err.message.toLowerCase();
        if (lowerMsg.includes('high demand') || lowerMsg.includes('model') || lowerMsg.includes('ai service')) {
          return {
            title: 'AI model temporarily unavailable',
            detail: err.message,
            actionHint: 'Wait a moment, then click Retry.',
            reasonCode: 'MODEL_ERROR',
            retryable: true,
          };
        }
        return {
          title: 'Network error',
          detail: err.message,
          actionHint: 'Check your internet connection and click Retry.',
          reasonCode: 'NETWORK_ERROR',
          retryable: true,
        };
      }
      if (err.statusCode === 429) {
        return {
          title: 'API rate limit reached',
          detail: err.message,
          actionHint: 'Wait a few seconds, then click Retry.',
          reasonCode: 'RATE_LIMITED',
          retryable: true,
        };
      }
      return {
        title: 'API request failure',
        detail: err.message,
        actionHint: 'Click Retry to try this page again.',
        reasonCode: 'API_ERROR',
        retryable: true,
      };
    }

    return {
      title: 'Extraction error',
      detail: err instanceof Error ? err.message : 'An unexpected error occurred on this page.',
      actionHint: 'Click Retry to reprocess this page.',
      reasonCode: 'PROCESSING_ERROR',
      retryable: true,
    };
  }

  /**
   * Extracts a single page using a vision-capable model.
   * - Validates image bytes are actually attached before sending.
   * - Never discards non-empty extracted Markdown.
   * - If the first attempt explicitly returns no readable text, AUTOMATICALLY builds a
   *   higher-resolution contrast-enhanced & border-trimmed version and retries once with
   *   enhanced vision recovery before ever reporting EMPTY_EXTRACTION.
   * - Logs complete dev diagnostics (never logging API keys/secrets).
   */
  public async extractSinglePage(
    context: FeatureContext,
    params: {
      image: PreparedCaptureImage;
      pageNumber: number;
      totalPages: number;
      includeMetadata: boolean;
      existingSubjects: string[];
      onStatusNote?: (note: string) => void;
    },
    signal?: AbortSignal
  ): Promise<PageExtractionResult> {
    this.validateUserContext(context);

    if (signal?.aborted) {
      throw new ImageCaptureException('Extraction cancelled.', 'CANCELLED');
    }

    if (!params.image.visionBase64 || params.image.visionBase64.length < 32) {
      const errMsg = `Invalid image payload: "${params.image.fileName}" has missing or empty base64 image data.`;
      SmartNoteCaptureService.logDevDiagnostics(`Page ${params.pageNumber} INVALID_PAYLOAD`, {
        fileName: params.image.fileName,
        fileSizeBytes: params.image.visionSizeBytes,
        mimeType: params.image.mimeType,
        imageAttached: false,
        base64Length: params.image.visionBase64?.length || 0,
        httpStatus: 0,
        actualError: errMsg,
      });
      throw new ImageCaptureException(errMsg, 'INVALID_IMAGE_PAYLOAD');
    }

    const attemptStart = Date.now();
    const finalizeValidResult = (
      rawResult: PageExtractionResult,
      cleanedMarkdown: string,
      quality: { passed: boolean; reason: string; wordCount: number; textLength: number },
      extra: { fallbackAttempted: boolean; retryCount: number; fileSizeBytes: number; mimeType: string; base64Length: number }
    ): PageExtractionResult => {
      const mergedDebug: ExtractionDebugInfo = {
        fileName: params.image.fileName,
        fileSizeBytes: extra.fileSizeBytes,
        mimeType: extra.mimeType,
        imageAttached: true,
        base64Length: extra.base64Length,
        modelName: rawResult.modelUsed || 'gemini-3.1-flash-lite',
        httpStatus: 200,
        durationMs: Date.now() - attemptStart,
        ...(rawResult.debug || {}),
        extractedTextLength: quality.textLength,
        wordCount: quality.wordCount,
        qualityCheckPassed: true,
        qualityCheckReason: quality.reason,
        retryCount: extra.retryCount,
        fallbackAttempted: extra.fallbackAttempted,
        rawResponsePreview: rawResult.debug?.rawResponsePreview || cleanedMarkdown.slice(0, 300),
      };

      return {
        ...rawResult,
        extractedMarkdown: cleanedMarkdown,
        wordCount: quality.wordCount,
        qualityCheckPassed: true,
        qualityCheckReason: quality.reason,
        retryCount: extra.retryCount,
        hasUnclearText: rawResult.hasUnclearText || /\[unclear\]/i.test(cleanedMarkdown),
        isEmptyExtraction: false,
        debug: mergedDebug,
      };
    };

    const runContrastEnhancedFallback = async (
      priorRetries: number,
      reasonLabel: string
    ): Promise<PageExtractionResult> => {
      if (signal?.aborted) {
        throw new ImageCaptureException('Extraction cancelled.', 'CANCELLED');
      }

      params.onStatusNote?.(reasonLabel);
      const enhancedPayload = await this.buildEnhancedFallbackImage(params.image);
      if (signal?.aborted) {
        throw new ImageCaptureException('Extraction cancelled.', 'CANCELLED');
      }

      const enhancedSizeBytes = Math.round((enhancedPayload.base64Data.length * 3) / 4);
      const fallbackResult = await this.aiProvider.extractSinglePageNote(
        {
          image: enhancedPayload,
          pageNumber: params.pageNumber,
          totalPages: params.totalPages,
          includeMetadata: params.includeMetadata,
          existingSubjects: params.existingSubjects,
          retryMode: 'enhanced',
          preferredModel: 'primary',
        },
        signal
      );

      const cleanedFallback = SmartNoteCaptureService.cleanTranscriptionMarkdown(
        fallbackResult.extractedMarkdown || ''
      );
      const fallbackQuality = SmartNoteCaptureService.validateExtractedQuality(
        cleanedFallback,
        enhancedSizeBytes
      );
      const totalRetries = priorRetries + (fallbackResult.retryCount ?? 0) + 1;

      if (fallbackQuality.passed) {
        const finalized = finalizeValidResult(fallbackResult, cleanedFallback, fallbackQuality, {
          fallbackAttempted: true,
          retryCount: totalRetries,
          fileSizeBytes: enhancedSizeBytes,
          mimeType: enhancedPayload.mimeType,
          base64Length: enhancedPayload.base64Data.length,
        });
        SmartNoteCaptureService.logDevDiagnostics(
          `Page ${params.pageNumber} (${params.image.fileName}) FALLBACK SUCCESS`,
          finalized.debug || {}
        );
        return finalized;
      }

      const failedDebug: ExtractionDebugInfo = {
        fileName: params.image.fileName,
        fileSizeBytes: enhancedSizeBytes,
        mimeType: enhancedPayload.mimeType,
        imageAttached: true,
        base64Length: enhancedPayload.base64Data.length,
        modelName: fallbackResult.modelUsed || 'gemini-3.1-flash-lite',
        httpStatus: fallbackResult.debug?.httpStatus ?? 200,
        responseContentType: fallbackResult.debug?.responseContentType,
        responseFormat: fallbackResult.debug?.responseFormat,
        durationMs: Date.now() - attemptStart,
        ...(fallbackResult.debug || {}),
        extractedTextLength: fallbackQuality.textLength,
        wordCount: fallbackQuality.wordCount,
        qualityCheckPassed: false,
        qualityCheckReason: fallbackQuality.reason,
        retryCount: totalRetries,
        fallbackAttempted: true,
        actualError:
          fallbackQuality.reason === 'EMPTY_OR_DIVIDERS_ONLY'
            ? 'No readable note text detected even after contrast enhancement.'
            : `Quality validation failed (${fallbackQuality.reason}) after automatic retry.`,
      };

      SmartNoteCaptureService.logDevDiagnostics(
        `Page ${params.pageNumber} (${params.image.fileName}) FAILED QUALITY AFTER FALLBACK`,
        failedDebug
      );

      if (fallbackQuality.reason === 'GENERIC_IMAGE_DESCRIPTION' || fallbackQuality.reason === 'SUSPICIOUSLY_SHORT') {
        throw new ImageCaptureException(
          fallbackQuality.reason === 'GENERIC_IMAGE_DESCRIPTION'
            ? `Page ${params.pageNumber} returned an image description instead of actual transcribed notes.`
            : `Page ${params.pageNumber} produced an unusually short transcription (${fallbackQuality.wordCount} words).`,
          'QUALITY_VALIDATION_FAILED',
          failedDebug as unknown as Record<string, unknown>
        );
      }

      throw new ImageCaptureException(
        fallbackResult.confidenceNote ||
          `No readable text was detected on Page ${params.pageNumber} ("${params.image.fileName}") even after contrast enhancement.`,
        'EMPTY_EXTRACTION',
        failedDebug as unknown as Record<string, unknown>
      );
    };

    try {
      params.onStatusNote?.('Transcribing handwriting, headings, formulas & tables…');

      const firstResult = await this.aiProvider.extractSinglePageNote(
        {
          image: {
            fileName: params.image.fileName,
            mimeType: params.image.mimeType,
            base64Data: params.image.visionBase64,
          },
          pageNumber: params.pageNumber,
          totalPages: params.totalPages,
          includeMetadata: params.includeMetadata,
          existingSubjects: params.existingSubjects,
          retryMode: 'standard',
          preferredModel: 'primary',
        },
        signal
      );

      const cleanedFirst = SmartNoteCaptureService.cleanTranscriptionMarkdown(
        firstResult.extractedMarkdown || ''
      );
      const firstQuality = SmartNoteCaptureService.validateExtractedQuality(
        cleanedFirst,
        params.image.visionSizeBytes
      );

      if (firstQuality.passed) {
        const finalized = finalizeValidResult(firstResult, cleanedFirst, firstQuality, {
          fallbackAttempted: false,
          retryCount: firstResult.retryCount ?? 0,
          fileSizeBytes: params.image.visionSizeBytes,
          mimeType: params.image.mimeType,
          base64Length: params.image.visionBase64.length,
        });
        SmartNoteCaptureService.logDevDiagnostics(
          `Page ${params.pageNumber} (${params.image.fileName}) SUCCESS`,
          finalized.debug || {}
        );
        return finalized;
      }

      // First attempt returned empty, divider-only, suspiciously short, or generic image description -> automatic fallback retry!
      SmartNoteCaptureService.logDevDiagnostics(
        `Page ${params.pageNumber} (${params.image.fileName}) ATTEMPT 1 REJECTED [${firstQuality.reason}] — RETRYING ENHANCED`,
        {
          ...(firstResult.debug || {}),
          fileName: params.image.fileName,
          fileSizeBytes: params.image.visionSizeBytes,
          mimeType: params.image.mimeType,
          imageAttached: true,
          base64Length: params.image.visionBase64.length,
          modelName: firstResult.modelUsed || 'gemini-3.1-flash-lite',
          httpStatus: firstResult.debug?.httpStatus ?? 200,
          extractedTextLength: firstQuality.textLength,
          wordCount: firstQuality.wordCount,
          qualityCheckPassed: false,
          qualityCheckReason: firstQuality.reason,
          retryCount: firstResult.retryCount ?? 0,
          durationMs: Date.now() - attemptStart,
        }
      );

      return await runContrastEnhancedFallback(
        firstResult.retryCount ?? 0,
        firstQuality.reason === 'GENERIC_IMAGE_DESCRIPTION'
          ? 'Retrying for verbatim note transcription…'
          : 'Enhancing contrast & retrying transcription…'
      );
    } catch (err) {
      if (err instanceof ImageCaptureException) {
        throw err;
      }
      if (signal?.aborted) {
        throw new ImageCaptureException('Extraction cancelled.', 'CANCELLED');
      }

      // If server rejected transcription quality (HTTP 422 QUALITY_VALIDATION_FAILED), automatically attempt ONE contrast-enhanced fallback retry
      if (err instanceof AIServiceException && err.serverCode === 'QUALITY_VALIDATION_FAILED') {
        const priorRetries = Number(err.debugInfo?.retryCount || 1);
        try {
          return await runContrastEnhancedFallback(
            priorRetries,
            'Enhancing image contrast & retrying verbatim transcription…'
          );
        } catch (fallbackErr) {
          if (fallbackErr instanceof ImageCaptureException) {
            throw fallbackErr;
          }
          const fallbackDebug: ExtractionDebugInfo = {
            fileName: params.image.fileName,
            fileSizeBytes: params.image.visionSizeBytes,
            mimeType: params.image.mimeType,
            imageAttached: true,
            base64Length: params.image.visionBase64.length,
            modelName: String(
              (fallbackErr instanceof AIServiceException && fallbackErr.debugInfo?.modelName) ||
                err.debugInfo?.modelName ||
                'unknown'
            ),
            httpStatus: fallbackErr instanceof AIServiceException ? fallbackErr.statusCode : 422,
            durationMs: Date.now() - attemptStart,
            qualityCheckPassed: false,
            qualityCheckReason: String(err.debugInfo?.qualityCheckReason || 'QUALITY_VALIDATION_FAILED'),
            retryCount: priorRetries + 1,
            fallbackAttempted: true,
            actualError: fallbackErr instanceof Error ? fallbackErr.message : err.message,
            ...(err.debugInfo as Partial<ExtractionDebugInfo>),
            ...(fallbackErr instanceof AIServiceException && fallbackErr.debugInfo
              ? (fallbackErr.debugInfo as Partial<ExtractionDebugInfo>)
              : {}),
          };
          throw new ImageCaptureException(
            fallbackErr instanceof Error ? fallbackErr.message : err.message,
            'QUALITY_VALIDATION_FAILED',
            fallbackDebug as unknown as Record<string, unknown>
          );
        }
      }

      if (err instanceof AIServiceException) {
        const debugRecord: ExtractionDebugInfo = {
          fileName: params.image.fileName,
          fileSizeBytes: params.image.visionSizeBytes,
          mimeType: params.image.mimeType,
          imageAttached: true,
          base64Length: params.image.visionBase64.length,
          modelName: String(err.debugInfo?.modelName || 'unknown'),
          httpStatus: err.statusCode,
          durationMs: Date.now() - attemptStart,
          actualError: err.message,
          ...(err.debugInfo as Partial<ExtractionDebugInfo>),
        };
        SmartNoteCaptureService.logDevDiagnostics(
          `Page ${params.pageNumber} (${params.image.fileName}) ERROR [${err.serverCode || err.statusCode}]`,
          debugRecord
        );

        if (err.serverCode === 'INVALID_IMAGE_PAYLOAD' || err.statusCode === 400) {
          throw new ImageCaptureException(
            err.message,
            err.serverCode === 'INVALID_FILE_TYPE' ? 'INVALID_FILE_TYPE' : 'INVALID_IMAGE_PAYLOAD',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        if (err.serverCode === 'EMPTY_AI_RESPONSE') {
          throw new ImageCaptureException(
            err.message,
            'EMPTY_AI_RESPONSE',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        if (err.serverCode === 'PARSING_ERROR') {
          throw new ImageCaptureException(
            err.message,
            'PARSING_ERROR',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        if (err.serverCode === 'MODEL_ERROR') {
          throw new ImageCaptureException(
            err.message,
            'MODEL_ERROR',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        if (err.statusCode === 504) {
          throw new ImageCaptureException(
            `Page ${params.pageNumber} exceeded the time limit while extracting.`,
            'TIMEOUT',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        if (err.statusCode === 503) {
          const isModelBusy =
            err.message.toLowerCase().includes('high demand') ||
            err.message.toLowerCase().includes('model');
          throw new ImageCaptureException(
            err.message || 'Unable to reach the server. Check your internet connection.',
            isModelBusy ? 'MODEL_ERROR' : 'NETWORK_ERROR',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        if (err.statusCode === 429) {
          throw new ImageCaptureException(
            'Too many concurrent requests — Gemini API rate limit reached.',
            'RATE_LIMITED',
            debugRecord as unknown as Record<string, unknown>
          );
        }
        throw new ImageCaptureException(
          err.message,
          'API_ERROR',
          debugRecord as unknown as Record<string, unknown>
        );
      }

      const fallbackMsg =
        err instanceof Error ? err.message : `Failed to extract Page ${params.pageNumber}.`;
      SmartNoteCaptureService.logDevDiagnostics(
        `Page ${params.pageNumber} (${params.image.fileName}) UNEXPECTED ERROR`,
        {
          fileName: params.image.fileName,
          fileSizeBytes: params.image.visionSizeBytes,
          mimeType: params.image.mimeType,
          imageAttached: true,
          base64Length: params.image.visionBase64.length,
          modelName: 'unknown',
          httpStatus: 0,
          durationMs: Date.now() - attemptStart,
          actualError: fallbackMsg,
        }
      );
      throw new ImageCaptureException(fallbackMsg, 'PROCESSING_ERROR');
    }
  }

  /**
   * Fast text-only metadata generation across multi-page extracted notes.
   */
  public async generateMetadata(
    context: FeatureContext,
    params: {
      combinedMarkdown: string;
      existingSubjects: string[];
    },
    signal?: AbortSignal
  ): Promise<CaptureMetadataPayload> {
    this.validateUserContext(context);
    if (signal?.aborted) {
      throw new ImageCaptureException('Extraction cancelled.', 'CANCELLED');
    }
    return this.aiProvider.generateCaptureMetadata(params, signal);
  }

  /**
   * Single source of truth: derives exact counts and combines all completed pages in page order.
   */
  public static combinePageResults(
    images: PreparedCaptureImage[],
    pageStates: Record<string, PageExtractionState>
  ): CombinedExtractionOutput {
    const sections: string[] = [];
    const unclearWarnings: string[] = [];
    const confidenceNotes: string[] = [];
    let hasUnclearText = false;
    let waitingCount = 0;
    let processingCount = 0;
    let completedCount = 0;
    let failedCount = 0;

    images.forEach((img, idx) => {
      const state = pageStates[img.id];
      const status = state?.status ?? 'waiting';

      if (status === 'waiting') {
        waitingCount += 1;
        return;
      }
      if (status === 'processing') {
        processingCount += 1;
        return;
      }
      if (status === 'failed') {
        failedCount += 1;
        return;
      }

      if (status === 'completed' && state.extractedMarkdown.trim()) {
        completedCount += 1;
        const pageNum = idx + 1;
        const body = state.extractedMarkdown.trim();
        sections.push(images.length > 1 ? `## Page ${pageNum}\n\n${body}` : body);

        if (state.hasUnclearText || /\[unclear\]/i.test(body)) {
          hasUnclearText = true;
        }
        for (const w of state.unclearWarnings || []) {
          const clean = w.trim();
          if (!clean) continue;
          const prefixed =
            images.length > 1 && !/^page\s+\d+/i.test(clean) ? `Page ${pageNum}: ${clean}` : clean;
          unclearWarnings.push(prefixed);
        }
        if (state.confidenceNote?.trim()) {
          confidenceNotes.push(
            images.length > 1 ? `Page ${pageNum}: ${state.confidenceNote.trim()}` : state.confidenceNote.trim()
          );
        }
      }
    });

    return {
      combinedMarkdown: sections.join('\n\n---\n\n'),
      hasUnclearText,
      unclearWarnings,
      confidenceNotes,
      waitingCount,
      processingCount,
      completedCount,
      failedCount,
    };
  }

  /**
   * Concurrently validates and prepares multiple selected image files without blocking the main thread.
   */
  public async prepareImageFiles(
    files: File[],
    onProgress?: (completed: number, total: number) => void
  ): Promise<{ prepared: PreparedCaptureImage[]; errors: string[] }> {
    const prepared: PreparedCaptureImage[] = [];
    const errors: string[] = [];
    let completed = 0;

    const chunkSize = 4;
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      const settled = await Promise.allSettled(chunk.map((file) => this.prepareImageFile(file)));
      settled.forEach((outcome, offset) => {
        completed += 1;
        if (outcome.status === 'fulfilled') {
          prepared.push(outcome.value);
        } else {
          const fileName = chunk[offset]?.name || 'image';
          const msg =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : `Image could not be read: "${fileName}".`;
          errors.push(msg);
        }
        onProgress?.(completed, files.length);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return { prepared, errors };
  }

  /**
   * Validates raw File type & size and creates:
   *  1) High-clarity base64 image for Gemini Vision OCR (max 1800px, q=0.86) with verified non-blank pixels & exact MIME
   *  2) Compact private Firestore attachment snapshot (< 240KB)
   *  3) In-memory reference to sourceFile for automatic high-res contrast-enhanced fallback retry
   */
  public async prepareImageFile(file: File): Promise<PreparedCaptureImage> {
    const normalizedMime = this.validateRawFile(file);
    let source = await this.decodeImageSource(file);

    try {
      let visionDataUrl = this.renderSourceToCanvas(
        source,
        SmartNoteCaptureService.VISION_MAX_DIMENSION,
        normalizedMime,
        SmartNoteCaptureService.VISION_QUALITY,
        false
      );

      // Guard against browser createImageBitmap blank-canvas quirks: fall back to HTMLImageElement or raw FileReader
      if (!visionDataUrl) {
        if ('close' in source && typeof source.close === 'function') {
          source.close();
        }
        source = await this.loadImageFromFile(file);
        visionDataUrl = this.renderSourceToCanvas(
          source,
          SmartNoteCaptureService.VISION_MAX_DIMENSION,
          normalizedMime,
          SmartNoteCaptureService.VISION_QUALITY,
          false
        );
      }

      if (!visionDataUrl) {
        // Last-resort raw file read if canvas returned uniform white/empty pixels
        visionDataUrl = await this.readFileAsDataUrl(file);
      }

      const visionBase64 = extractBase64FromDataUrl(visionDataUrl);
      const visionMimeType = extractMimeFromDataUrl(visionDataUrl, normalizedMime);

      if (!visionBase64 || visionBase64.length < 32) {
        throw new ImageCaptureException(
          `Image could not be read: "${file.name}" produced empty image data.`,
          'UNREADABLE_IMAGE'
        );
      }

      const storageDataUrl = this.compressForFirestoreStorage(source, normalizedMime, visionDataUrl);
      const storageMimeType = extractMimeFromDataUrl(storageDataUrl, 'image/jpeg');

      return {
        id: generateSafeId('img'),
        fileName: file.name || `captured-${Date.now()}.jpg`,
        mimeType: visionMimeType,
        storageMimeType,
        originalSizeBytes: file.size,
        visionSizeBytes: Math.round((visionBase64.length * 3) / 4),
        previewUrl: visionDataUrl,
        visionBase64,
        storageDataUrl,
        storageSizeBytes: storageDataUrl.length,
        sourceFile: file,
      };
    } finally {
      if ('close' in source && typeof source.close === 'function') {
        source.close();
      }
    }
  }

  /**
   * Builds a contrast-enhanced, border-trimmed, higher-resolution (2200px @ 0.92) JPEG
   * from the original uploaded File for automatic empty-result fallback retry.
   */
  private async buildEnhancedFallbackImage(
    prepared: PreparedCaptureImage
  ): Promise<CaptureImageInput> {
    try {
      const source = prepared.sourceFile
        ? await this.loadImageFromFile(prepared.sourceFile)
        : await this.loadImageFromDataUrl(prepared.previewUrl, prepared.fileName);

      const enhancedDataUrl = this.renderSourceToCanvas(
        source,
        SmartNoteCaptureService.FALLBACK_MAX_DIMENSION,
        'image/jpeg',
        SmartNoteCaptureService.FALLBACK_QUALITY,
        true
      );

      if (enhancedDataUrl) {
        const base64Data = extractBase64FromDataUrl(enhancedDataUrl);
        if (base64Data.length >= 32) {
          return {
            fileName: prepared.fileName,
            mimeType: extractMimeFromDataUrl(enhancedDataUrl, 'image/jpeg'),
            base64Data,
          };
        }
      }
    } catch {
      // Fall back to existing prepared image if enhanced re-render fails
    }

    return {
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      base64Data: prepared.visionBase64,
    };
  }

  public async saveAttachmentsForNote(params: {
    userId: string;
    noteId: string;
    images: PreparedCaptureImage[];
  }): Promise<NoteAttachment[]> {
    const saved: NoteAttachment[] = [];
    for (const img of params.images.slice(0, SmartNoteCaptureService.MAX_IMAGES)) {
      const attachment = new NoteAttachment({
        attachmentId: generateSafeId('att'),
        userId: params.userId,
        noteId: params.noteId,
        fileName: img.fileName,
        mimeType: img.storageMimeType || img.mimeType,
        dataUrl: img.storageDataUrl,
        sizeBytes: img.storageSizeBytes,
        createdAt: new Date(),
      });
      await this.attachmentRepo.save(attachment);
      saved.push(attachment);
    }
    return saved;
  }

  public async listAttachmentsForNote(userId: string, noteId: string): Promise<NoteAttachment[]> {
    return this.attachmentRepo.listByNote(userId, noteId);
  }

  public async deleteAttachment(attachmentId: string): Promise<void> {
    await this.attachmentRepo.delete(attachmentId);
  }

  private validateRawFile(file: File): SupportedAttachmentMime {
    const rawType = (file.type || '').toLowerCase();
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const inferredMime =
      rawType ||
      (ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : '');

    if (!SmartNoteCaptureService.ACCEPTED_MIMES.has(inferredMime)) {
      throw new ImageCaptureException(
        `Unsupported file "${file.name}". Please upload JPG, JPEG, PNG, or WebP images.`,
        'INVALID_FILE_TYPE'
      );
    }

    if (file.size === 0) {
      throw new ImageCaptureException(
        `Image could not be read: "${file.name}" is empty (0 bytes).`,
        'UNREADABLE_IMAGE'
      );
    }

    if (file.size > SmartNoteCaptureService.MAX_RAW_FILE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      throw new ImageCaptureException(
        `"${file.name}" is ${mb} MB, which exceeds the 10 MB limit per image.`,
        'FILE_TOO_LARGE'
      );
    }

    return inferredMime === 'image/png'
      ? 'image/png'
      : inferredMime === 'image/webp'
        ? 'image/webp'
        : 'image/jpeg';
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () =>
        reject(
          new ImageCaptureException(
            `Image could not be read: failed to read "${file.name}".`,
            'UNREADABLE_IMAGE'
          )
        );
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsDataURL(file);
    });
  }

  private async decodeImageSource(file: File): Promise<ImageBitmap | HTMLImageElement> {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        // Fallback to HTMLImageElement below
      }
    }
    return this.loadImageFromFile(file);
  }

  private loadImageFromFile(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(
          new ImageCaptureException(
            `Image could not be read: "${file.name}" appears corrupted or unreadable.`,
            'UNREADABLE_IMAGE'
          )
        );
      };
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.src = objectUrl;
    });
  }

  private loadImageFromDataUrl(dataUrl: string, fileName: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onerror = () =>
        reject(
          new ImageCaptureException(
            `Image could not be read: "${fileName}" could not be reloaded for fallback.`,
            'UNREADABLE_IMAGE'
          )
        );
      img.onload = () => resolve(img);
      img.src = dataUrl;
    });
  }

  /**
   * Renders an image to canvas with optional contrast enhancement & dark-border trim.
   * Returns empty string if the resulting canvas has zero visual variance (blank-canvas guard).
   */
  private renderSourceToCanvas(
    source: ImageBitmap | HTMLImageElement,
    maxDimension: number,
    mimeType: SupportedAttachmentMime,
    quality: number,
    enhanceContrast: boolean
  ): string {
    const rawW = 'naturalWidth' in source ? source.naturalWidth : source.width;
    const rawH = 'naturalHeight' in source ? source.naturalHeight : source.height;
    if (!rawW || !rawH) return '';

    const scale = Math.min(1, maxDimension / Math.max(rawW, rawH));
    const width = Math.max(1, Math.round(rawW * scale));
    const height = Math.max(1, Math.round(rawH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new ImageCaptureException('Browser canvas unavailable for image processing.', 'PROCESSING_ERROR');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (enhanceContrast) {
      try {
        ctx.filter = 'contrast(1.24) brightness(1.05) saturate(0.85)';
      } catch {
        // Older canvas implementations without ctx.filter fall back safely
      }
    }

    ctx.drawImage(source, 0, 0, width, height);
    ctx.filter = 'none';

    // Verify rendered canvas is not an accidental solid blank frame
    if (!this.hasNonBlankCanvasContent(ctx, width, height)) {
      return '';
    }

    // In enhanced fallback mode, also trim uniform dark outer desk borders conservatively (max 12% per side)
    let targetCanvas = canvas;
    if (enhanceContrast && width >= 200 && height >= 200) {
      const trimmed = this.tryConservativeBorderTrim(canvas, ctx);
      if (trimmed) {
        targetCanvas = trimmed;
      }
    }

    // Always output reliable JPEG for vision OCR (eliminates browser WebP fallback quirks & ensures crisp photos)
    const outputMime: SupportedAttachmentMime =
      mimeType === 'image/png' ? 'image/jpeg' : mimeType === 'image/webp' ? 'image/jpeg' : 'image/jpeg';
    return targetCanvas.toDataURL(outputMime, quality);
  }

  private hasNonBlankCanvasContent(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): boolean {
    try {
      const sampleW = Math.min(width, 64);
      const sampleH = Math.min(height, 64);
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = sampleW;
      probeCanvas.height = sampleH;
      const probeCtx = probeCanvas.getContext('2d');
      if (!probeCtx) return true;
      probeCtx.drawImage(ctx.canvas, 0, 0, sampleW, sampleH);
      const { data } = probeCtx.getImageData(0, 0, sampleW, sampleH);
      let minLum = 255;
      let maxLum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }
      return maxLum - minLum >= 6;
    } catch {
      return true;
    }
  }

  private tryConservativeBorderTrim(
    sourceCanvas: HTMLCanvasElement,
    sourceCtx: CanvasRenderingContext2D
  ): HTMLCanvasElement | null {
    try {
      const w = sourceCanvas.width;
      const h = sourceCanvas.height;
      const data = sourceCtx.getImageData(0, 0, w, h).data;
      const maxTrimX = Math.floor(w * 0.12);
      const maxTrimY = Math.floor(h * 0.12);

      const isDarkRow = (y: number): boolean => {
        let sum = 0;
        let samples = 0;
        for (let x = 0; x < w; x += 8) {
          const idx = (y * w + x) * 4;
          sum += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
          samples++;
        }
        return samples > 0 && sum / samples < 75;
      };

      const isDarkCol = (x: number): boolean => {
        let sum = 0;
        let samples = 0;
        for (let y = 0; y < h; y += 8) {
          const idx = (y * w + x) * 4;
          sum += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
          samples++;
        }
        return samples > 0 && sum / samples < 75;
      };

      let top = 0;
      while (top < maxTrimY && isDarkRow(top)) top += 4;
      let bottom = h - 1;
      while (h - 1 - bottom < maxTrimY && isDarkRow(bottom)) bottom -= 4;
      let left = 0;
      while (left < maxTrimX && isDarkCol(left)) left += 4;
      let right = w - 1;
      while (w - 1 - right < maxTrimX && isDarkCol(right)) right -= 4;

      const cropW = right - left + 1;
      const cropH = bottom - top + 1;
      if (cropW >= w - 16 && cropH >= h - 16) return null;
      if (cropW < w * 0.7 || cropH < h * 0.7) return null;

      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cCtx = cropped.getContext('2d');
      if (!cCtx) return null;
      cCtx.drawImage(sourceCanvas, left, top, cropW, cropH, 0, 0, cropW, cropH);
      return cropped;
    } catch {
      return null;
    }
  }

  private compressForFirestoreStorage(
    source: ImageBitmap | HTMLImageElement,
    mimeType: SupportedAttachmentMime,
    alreadyRenderedVisionUrl: string
  ): string {
    if (alreadyRenderedVisionUrl.length <= NoteAttachment.MAX_DATA_URL_LENGTH) {
      return alreadyRenderedVisionUrl;
    }
    const attempts: Array<{ dim: number; q: number }> = [
      { dim: 900, q: 0.66 },
      { dim: 720, q: 0.58 },
      { dim: 540, q: 0.5 },
    ];
    for (const attempt of attempts) {
      const candidate = this.renderSourceToCanvas(source, attempt.dim, mimeType, attempt.q, false);
      if (candidate && candidate.length <= NoteAttachment.MAX_DATA_URL_LENGTH) {
        return candidate;
      }
    }
    return (
      this.renderSourceToCanvas(source, 420, 'image/jpeg', 0.44, false) || alreadyRenderedVisionUrl
    );
  }
}
