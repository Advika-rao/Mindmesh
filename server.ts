import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distPath = path.resolve(__dirname, 'dist');
const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' ||
  Boolean(process.env.RENDER) ||
  (fs.existsSync(distPath) &&
    process.env.VITE_DEV !== 'true' &&
    process.argv[1]?.endsWith('server.ts') &&
    !process.env.npm_lifecycle_event?.includes('dev'));
const PORT = IS_PRODUCTION ? Number(process.env.PORT) || 3000 : 3000;
const TEXT_MODEL = 'gemini-4-hydrogen';
const FAST_VISION_MODEL = 'gemini-3.1-flash-lite';
const EMBEDDING_MODEL = 'gemini-embedding-2';

function getAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server. Please configure your Gemini API key in Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterSeconds(error: unknown): number | undefined {
  const errObj = error as {
    headers?: Headers | Record<string, string | string[] | undefined>;
    response?: { headers?: Headers | Record<string, string | string[] | undefined> };
    message?: string;
  };
  const headerSource = errObj?.headers ?? errObj?.response?.headers;
  if (headerSource) {
    let rawHeader: string | null | undefined;
    if (typeof (headerSource as Headers).get === 'function') {
      rawHeader = (headerSource as Headers).get('retry-after');
    } else {
      const rec = headerSource as Record<string, string | string[] | undefined>;
      const val = rec['retry-after'] ?? rec['Retry-After'];
      rawHeader = Array.isArray(val) ? val[0] : val;
    }
    if (rawHeader) {
      const asNum = Number(rawHeader);
      if (Number.isFinite(asNum) && asNum > 0) {
        return Math.min(60, Math.max(1, Math.ceil(asNum)));
      }
      const parsedDate = Date.parse(rawHeader);
      if (Number.isFinite(parsedDate)) {
        const diffSec = Math.ceil((parsedDate - Date.now()) / 1000);
        if (diffSec > 0) return Math.min(60, diffSec);
      }
    }
  }

  const msg = error instanceof Error ? error.message : String(error);
  const rpcDelayMatch =
    msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i) ||
    msg.match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  if (rpcDelayMatch && rpcDelayMatch[1]) {
    const parsed = Math.ceil(Number(rpcDelayMatch[1]));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(60, Math.max(1, parsed));
    }
  }
  return undefined;
}

function isQuotaExhaustedError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!msg.includes('resource_exhausted') && !msg.includes('429') && !msg.includes('quota')) {
    return false;
  }
  return (
    msg.includes('perday') ||
    msg.includes('per_day') ||
    msg.includes('daily') ||
    msg.includes('limit: 0') ||
    msg.includes('billing') ||
    msg.includes('free_tier') ||
    msg.includes('quota exceeded for metric') ||
    msg.includes('exceeded your current quota')
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 2,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED');
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (
        signal?.aborted ||
        msg.includes('CLIENT_ABORTED') ||
        msg.includes('REQUEST_TIMEOUT') ||
        msg.includes('ATTEMPT_TIMEOUT') ||
        msg.includes('AbortError') ||
        msg.includes('API_KEY_INVALID') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('400') ||
        msg.includes('403') ||
        isQuotaExhaustedError(error)
      ) {
        throw error;
      }
      const isRateLimit = msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429');
      const isUnavailable = msg.includes('UNAVAILABLE') || msg.includes('503') || msg.includes('502');
      const retryLimit = isRateLimit ? Math.min(2, maxRetries) : isUnavailable ? Math.min(1, maxRetries) : maxRetries;
      if (attempt < retryLimit) {
        const retryAfterSec = parseRetryAfterSeconds(error);
        const exponentialDelayMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        const delayMs = retryAfterSec
          ? Math.min(12_000, retryAfterSec * 1000)
          : isRateLimit
            ? exponentialDelayMs
            : Math.min(8000, 1000 * Math.pow(2, attempt));
        await abortableDelay(delayMs, signal);
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

function detectImageFormatFromBuffer(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function stripOuterMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json|markdown|md|text|txt)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseModelJsonObject<T>(rawText: string): T {
  const cleaned = stripOuterMarkdownFence(rawText || '').trim();
  if (!cleaned) {
    throw new Error('EMPTY_AI_RESPONSE: AI model returned an empty JSON response.');
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error('PARSING_ERROR: AI model returned malformed JSON.');
  }
}

const BANNED_CONCEPT_LABEL_PATTERNS: RegExp[] = [
  /^captured\s+notes?\b/i,
  /^scanned\s+notes?\b/i,
  /^image\s+notes?\b/i,
  /^class(?:room)?\s+notes?\b/i,
  /^lecture\s+notes?\b/i,
  /^study\s+notes?\b/i,
  /^my\s+notes?\b/i,
  /^notes?\s*\(/i,
  /^notes?\s+\d+/i,
  /^untitled\b/i,
  /^page\s+\d+\b/i,
  /^note\s+\d+\b/i,
  /^general$/i,
  /^misc(?:ellaneous)?$/i,
  /^summary$/i,
  /^overview$/i,
];

function normalizeConceptKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugifyConceptId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `concept-${Math.random().toString(36).slice(2, 8)}`;
}

function isGenericConceptLabel(label: string, noteTitles: Set<string>, subjectNames: Set<string>): boolean {
  const cleaned = label.trim();
  if (cleaned.length < 2 || cleaned.length > 80) return true;
  if (BANNED_CONCEPT_LABEL_PATTERNS.some((rx) => rx.test(cleaned))) return true;
  const key = normalizeConceptKey(cleaned);
  if (!key) return true;
  // Reject bare date-like labels ("2026 04 12" or "Apr 12 2026")
  if (/^\d{1,4}[\s/-]\d{1,2}[\s/-]\d{1,4}$/.test(cleaned)) return true;
  // Reject raw generic note titles like "Captured Notes (4/12/2026)" even if partially altered
  if (noteTitles.has(key) && /\bnotes?\b/i.test(cleaned)) return true;
  // Reject overly broad bare academic department names when used generically
  if (subjectNames.has(key) && /^(computer science|general|science|study|notes|engineering|mathematics)$/i.test(key)) {
    return true;
  }
  return false;
}

function inferSourceNotesForConcept(label: string, description: string, notes: NotePayload[]): string[] {
  const terms = normalizeConceptKey(`${label} ${description}`)
    .split(' ')
    .filter((w) => w.length >= 4);
  if (terms.length === 0) return notes.length > 0 ? [notes[0].noteId] : [];

  const matched = notes
    .map((n) => {
      const hay = `${n.title} ${n.subject} ${(n.tags || []).join(' ')} ${n.content}`.toLowerCase();
      const labelLower = label.toLowerCase();
      let score = hay.includes(labelLower) ? 10 : 0;
      for (const term of terms) {
        if (hay.includes(term)) score += 1;
      }
      return { noteId: n.noteId, score };
    })
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((item) => item.noteId);

  return matched.length > 0 ? matched : notes.length > 0 ? [notes[0].noteId] : [];
}

/**
 * Removes accidental conversational AI preambles/postscripts and empty decorative divider runs
 * while preserving all real headings, lists, tables, formulas, and diagram labels.
 */
function cleanTranscriptionMarkdown(rawText: string): string {
  let text = stripOuterMarkdownFence(rawText).replace(/\r\n/g, '\n').trim();

  // Strip common conversational opening lines ("Here is the transcription of the image:", etc.)
  const introLineRegex =
    /^(?:sure[,!.\s]*|certainly[,!.\s]*|of course[,!.\s]*)?(?:here\s+(?:is|are)\s+(?:the\s+|a\s+)?(?:clean\s+|structured\s+)?(?:markdown\s+)?(?:transcription|text|extracted\s+(?:notes|text|content)|notes)\s*(?:from|of)?\s*(?:the\s+)?(?:uploaded\s+|provided\s+)?(?:image|photo|page|notes|document)?\s*:?|below\s+is\s+the\s+(?:transcription|extracted\s+text)[^:\n]*:?)\s*$/i;

  const lines = text.split('\n');
  while (lines.length > 0) {
    const first = lines[0].trim();
    if (!first || /^[-*_]{3,}$/.test(first) || introLineRegex.test(first)) {
      lines.shift();
    } else {
      break;
    }
  }

  // Strip trailing standalone dividers or generic closing remarks
  const outroLineRegex =
    /^(?:let me know if you(?:'d| would) like|hope this helps|note:\s*some words were marked \[unclear\]).*$/i;
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last || /^[-*_]{3,}$/.test(last) || outroLineRegex.test(last)) {
      lines.pop();
    } else {
      break;
    }
  }

  // Collapse excessive consecutive divider lines and excessive blank lines
  const normalizedLines: string[] = [];
  let prevWasDivider = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isDivider = /^[-*_]{3,}$/.test(trimmed);
    if (isDivider && prevWasDivider) continue;
    prevWasDivider = isDivider;
    normalizedLines.push(line);
  }

  return normalizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Calculates accurate word count from actual extracted transcription text
 * (excluding Markdown table pipes, divider lines, headings syntax, and [unclear] markers).
 */
function countRealTranscriptionWords(markdown: string): number {
  if (!markdown) return 0;
  const withoutSyntax = markdown
    .replace(/\[unclear\]/gi, ' ')
    .replace(/^[-_*=]{3,}$/gm, ' ')
    .replace(/[|#`*>_~]/g, ' ');
  const tokens = withoutSyntax
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
    .filter((t) => /[a-zA-Z0-9]/.test(t));
  return tokens.length;
}

interface TranscriptionQualityCheck {
  passed: boolean;
  reason?: string;
  wordCount: number;
  charLength: number;
}

/**
 * Validates that extracted output contains real transcribed notes rather than
 * empty/divider-only junk, a generic intro sentence, or an image description.
 */
function validateTranscriptionQuality(
  cleanedMarkdown: string,
  fileSizeBytes: number
): TranscriptionQualityCheck {
  const charLength = cleanedMarkdown.length;
  const wordCount = countRealTranscriptionWords(cleanedMarkdown);

  // 1. Empty or divider/symbol-only check
  const strippedAlphaNum = cleanedMarkdown.replace(/[^A-Za-z0-9]/g, '');
  if (!cleanedMarkdown.trim() || strippedAlphaNum.length < 4 || wordCount === 0) {
    return {
      passed: false,
      reason: 'EMPTY_OR_DIVIDERS_ONLY: Output contained no real transcribed text (empty or only formatting dividers).',
      wordCount,
      charLength,
    };
  }

  const nonEmptyLines = cleanedMarkdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-*_|:=\s]+$/.test(l));

  if (nonEmptyLines.length === 0) {
    return {
      passed: false,
      reason: 'EMPTY_OR_DIVIDERS_ONLY: Output contained only dividers or empty formatting.',
      wordCount,
      charLength,
    };
  }

  // 2. Detect image-description / visual-captioning hallucination instead of actual text transcription
  const descriptionLinePatterns: RegExp[] = [
    /\b(?:this|the)\s+(?:uploaded\s+|provided\s+)?(?:image|photo|picture|photograph|page|sheet|document|notebook\s+page)\s+(?:contains|shows|depicts|presents|displays|features|illustrates|consists\s+of|is\s+a\s+(?:photo|picture|page|scan)|has\s+\w+\s+sections?)/i,
    /\bhere\s+is\s+(?:a\s+)?(?:detailed\s+)?(?:description|summary|overview|breakdown|analysis)\s+of\s+(?:the\s+)?(?:image|photo|page|notes)/i,
    /\b(?:in|at)\s+the\s+(?:top|bottom|upper|lower|left|right|center|middle)\s*(?:-?(?:left|right))?\s*(?:corner|section|half|part|side|area|portion)\s+of\s+the\s+(?:image|photo|page)/i,
    /\b(?:written|handwritten)\s+in\s+(?:blue|black|red|green|dark|purple)\s+(?:ink|pen|ballpoint|marker|pencil)/i,
    /\bhighlighted\s+(?:in|with)\s+(?:yellow|pink|green|orange|blue)\s*(?:highlighter)?/i,
    /\bon\s+(?:white\s+)?(?:lined|ruled|grid|blank)\s+(?:notebook\s+)?paper\b/i,
    /\bthe\s+notes?\s+(?:are|appear|seem)\s+(?:neatly\s+|clearly\s+)?(?:handwritten|organized\s+into|divided\s+into|structured\s+into)/i,
    /\boverall,?\s+the\s+(?:image|page|notes)\s+(?:covers?|summarizes?|explains?|provides?)/i,
  ];

  let descriptionLineHits = 0;
  for (const line of nonEmptyLines) {
    if (descriptionLinePatterns.some((rx) => rx.test(line))) {
      descriptionLineHits += 1;
    }
  }

  const firstParagraph = nonEmptyLines.slice(0, 3).join(' ');
  const startsWithImageDescription = descriptionLinePatterns
    .slice(0, 3)
    .some((rx) => rx.test(firstParagraph));
  const descriptionRatio = descriptionLineHits / nonEmptyLines.length;

  if (
    (startsWithImageDescription && descriptionLineHits >= 2) ||
    descriptionRatio >= 0.35 ||
    (nonEmptyLines.length <= 4 && startsWithImageDescription)
  ) {
    return {
      passed: false,
      reason: `GENERIC_IMAGE_DESCRIPTION: Model described the image (${descriptionLineHits}/${nonEmptyLines.length} lines) instead of transcribing actual text.`,
      wordCount,
      charLength,
    };
  }

  // 3. Suspiciously short / generic single-line intro check for substantive photos
  if (fileSizeBytes > 50_000 && wordCount < 8) {
    return {
      passed: false,
      reason: `SUSPICIOUSLY_SHORT: Only ${wordCount} real word(s) extracted from a ${Math.round(fileSizeBytes / 1024)}KB note image.`,
      wordCount,
      charLength,
    };
  }

  return {
    passed: true,
    wordCount,
    charLength,
  };
}

function logCaptureDebug(payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== 'production' || process.env.CAPTURE_DEBUG === 'true') {
    console.log('[MindMesh SmartCapture Debug]', JSON.stringify(payload));
  }
}

interface CaptureFallbackOptions {
  mode?: 'standard' | 'enhanced' | 'metadata' | 'reasoning';
  preferredModel?: 'primary' | 'secondary';
}

async function generateCaptureWithFallback(
  ai: GoogleGenAI,
  buildParams: (
    model: string,
    thinkingLevel: ThinkingLevel,
    attemptSignal: AbortSignal
  ) => Parameters<GoogleGenAI['models']['generateContent']>[0],
  signal?: AbortSignal,
  options?: CaptureFallbackOptions
): Promise<{
  response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
  modelUsed: string;
  thinkingLevelUsed: ThinkingLevel;
}> {
  const mode = options?.mode ?? 'standard';
  let candidates: Array<{ model: string; thinkingLevel: ThinkingLevel; timeoutMs?: number }>;

  if (mode === 'metadata') {
    candidates = [
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 12_000 },
      { model: TEXT_MODEL, thinkingLevel: ThinkingLevel.LOW },
    ];
  } else if (mode === 'reasoning') {
    // Structured conceptual reasoning (Brain Graph & Explain Connection):
    // Ultra-fast MINIMAL first (typically 2-5s), failover to LOW, then flagship TEXT_MODEL
    candidates = [
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 14_000 },
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 14_000 },
      { model: TEXT_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 14_000 },
    ];
  } else if (mode === 'enhanced') {
    // Enhanced handwriting/quality recovery retry: deeper reasoning on fast vision model first, then failover to TEXT_MODEL
    candidates = [
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 14_000 },
      { model: TEXT_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 14_000 },
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.MINIMAL },
    ];
  } else if (options?.preferredModel === 'secondary') {
    candidates = [
      { model: TEXT_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 18_000 },
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.MINIMAL },
    ];
  } else {
    // Primary vision path: gemini-3.1-flash-lite with ThinkingLevel.MINIMAL (ultra-fast verbatim OCR, typically 2-6s/page)
    // Fails over to gemini-4-hydrogen on transient spikes, and back to gemini-3.1-flash-lite (LOW) if gemini-4-hydrogen is rate-limited/busy.
    candidates = [
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 18_000 },
      { model: TEXT_MODEL, thinkingLevel: ThinkingLevel.LOW, timeoutMs: 12_000 },
      { model: FAST_VISION_MODEL, thinkingLevel: ThinkingLevel.LOW },
    ];
  }

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED');
    }

    const attemptController = new AbortController();
    const onOuterAbort = () =>
      attemptController.abort(signal?.reason instanceof Error ? signal.reason : new Error('CLIENT_ABORTED'));
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    let attemptTimer: ReturnType<typeof setTimeout> | undefined;
    if (candidate.timeoutMs) {
      attemptTimer = setTimeout(() => {
        attemptController.abort(new Error('ATTEMPT_TIMEOUT'));
      }, candidate.timeoutMs);
    }

    const attemptAbortPromise = new Promise<never>((_, reject) => {
      if (attemptController.signal.aborted) {
        reject(
          attemptController.signal.reason instanceof Error
            ? attemptController.signal.reason
            : new Error('ATTEMPT_TIMEOUT')
        );
        return;
      }
      attemptController.signal.addEventListener(
        'abort',
        () => {
          reject(
            attemptController.signal.reason instanceof Error
              ? attemptController.signal.reason
              : new Error('ATTEMPT_TIMEOUT')
          );
        },
        { once: true }
      );
    });

    try {
      const retriesForCandidate = i === candidates.length - 1 ? 1 : 0;
      const response = await Promise.race([
        withRetry(
          () => ai.models.generateContent(buildParams(candidate.model, candidate.thinkingLevel, attemptController.signal)),
          retriesForCandidate,
          attemptController.signal
        ),
        attemptAbortPromise,
      ]);
      return {
        response,
        modelUsed: candidate.model,
        thinkingLevelUsed: candidate.thinkingLevel,
      };
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const isAttemptTimeout = attemptController.signal.aborted && !signal?.aborted;
      const quotaExhausted = isQuotaExhaustedError(error);
      const nextCandidate = candidates[i + 1];
      const nextUsesDifferentModel = Boolean(nextCandidate && nextCandidate.model !== candidate.model);

      // If quota is exhausted on the current model, never retry the exact same model again
      const shouldFallback =
        !signal?.aborted &&
        i < candidates.length - 1 &&
        (!quotaExhausted || nextUsesDifferentModel) &&
        (isAttemptTimeout ||
          msg.includes('503') ||
          msg.includes('502') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('404') ||
          msg.includes('NOT_FOUND'));

      if (!shouldFallback) {
        throw error;
      }
      console.warn(
        `[MindMesh AI] ${candidate.model} ${isAttemptTimeout ? `stalled (>${candidate.timeoutMs}ms)` : 'unavailable/throttled'}; failing over to ${nextCandidate.model}.`
      );
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('503') || msg.includes('UNAVAILABLE')) {
        const retryAfterSec = parseRetryAfterSeconds(error);
        const delayMs = retryAfterSec ? Math.min(6000, retryAfterSec * 1000) : 1500 + Math.floor(Math.random() * 500);
        await abortableDelay(delayMs, signal);
      }
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastError;
}

async function runWithAbortAndTimeout<T>(
  _req: Request,
  res: Response,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  // IMPORTANT: In Node.js 16+, req 'close' fires as soon as express.json() finishes
  // reading the request body. Only res 'close' with !res.writableEnded signals a real
  // premature client disconnect!
  const onResponseClose = () => {
    if (!res.writableEnded) {
      controller.abort(new Error('CLIENT_ABORTED'));
    }
  };
  res.on('close', onResponseClose);

  const timer = setTimeout(() => {
    controller.abort(new Error('REQUEST_TIMEOUT'));
  }, timeoutMs);

  const abortPromise = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('CLIENT_ABORTED'));
      return;
    }
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('CLIENT_ABORTED')
        );
      },
      { once: true }
    );
  });

  try {
    return await Promise.race([task(controller.signal), abortPromise]);
  } finally {
    clearTimeout(timer);
    res.off('close', onResponseClose);
  }
}

function handleAIError(res: Response, error: unknown, context: string): void {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (rawMessage.includes('CLIENT_ABORTED') || res.writableEnded) {
    if (!res.writableEnded) {
      res.status(499).json({ error: 'Request cancelled.', code: 'CANCELLED' });
    }
    return;
  }

  console.error(`[MindMesh AI Error - ${context}]:`, rawMessage);

  if (
    rawMessage.includes('REQUEST_TIMEOUT') ||
    rawMessage.includes('ATTEMPT_TIMEOUT') ||
    rawMessage.includes('ETIMEDOUT') ||
    rawMessage.toLowerCase().includes('timeout')
  ) {
    res.status(504).json({
      error: 'The AI request timed out. Please try again.',
      code: 'TIMEOUT',
    });
    return;
  }
  if (
    rawMessage.includes('PERMISSION_DENIED') ||
    rawMessage.includes('API_KEY_INVALID') ||
    rawMessage.includes('GEMINI_API_KEY')
  ) {
    res.status(403).json({
      error: 'AI API key is missing or invalid. Please check your configuration in Settings > Secrets.',
      code: 'API_KEY_ERROR',
    });
    return;
  }
  if (isQuotaExhaustedError(error)) {
    res.status(429).json({
      error: 'Your API quota has been exhausted. Please wait for your quota to reset or review your API key plan in Settings > Secrets.',
      code: 'QUOTA_EXHAUSTED',
      isQuotaExhausted: true,
    });
    return;
  }
  if (rawMessage.includes('RESOURCE_EXHAUSTED') || rawMessage.includes('429')) {
    const retryAfterSeconds = parseRetryAfterSeconds(error) ?? 8;
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: 'AI is temporarily busy. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
      retryAfterSeconds,
      isQuotaExhausted: false,
    });
    return;
  }
  if (rawMessage.includes('EMPTY_AI_RESPONSE')) {
    res.status(502).json({
      error: 'The AI returned an empty response. Please try again.',
      code: 'EMPTY_AI_RESPONSE',
    });
    return;
  }
  if (rawMessage.includes('PARSING_ERROR')) {
    res.status(502).json({
      error: 'The AI returned an unexpected response format. Please try again.',
      code: 'PARSING_ERROR',
    });
    return;
  }
  if (
    rawMessage.includes('UNAVAILABLE') ||
    rawMessage.includes('503') ||
    rawMessage.includes('502') ||
    rawMessage.includes('high demand')
  ) {
    const retryAfterSeconds = parseRetryAfterSeconds(error) ?? 5;
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(503).json({
      error: 'The AI service is temporarily unavailable. Please try again in a moment.',
      code: 'AI_UNAVAILABLE',
      retryAfterSeconds,
    });
    return;
  }
  res.status(500).json({
    error: 'The AI service encountered a temporary problem. Please try again.',
    code: 'AI_SERVICE_ERROR',
  });
}

interface NotePayload {
  noteId: string;
  title: string;
  subject: string;
  tags: string[];
  content: string;
}

function formatNotesContext(notes: NotePayload[]): string {
  if (!notes || notes.length === 0) return 'No saved notes provided.';
  return notes
    .map(
      (n, idx) =>
        `[NOTE ${idx + 1} | ID: ${n.noteId}]\nTitle: ${n.title}\nSubject: ${n.subject}\nTags: ${(n.tags || []).join(', ')}\nContent:\n${n.content.slice(0, 6000)}`
    )
    .join('\n\n---\n\n');
}

async function createServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Guarantee explicit JSON content-type headers for all /api/* routes
  app.use('/api', (_req: Request, res: Response, next: express.NextFunction) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'MindMesh API' });
  });

  // 1. Semantic Embedding Endpoint (Feature 1, 4, 6 — cached & coalesced)
  const embedCache = new Map<string, { expiresAt: number; embedding: number[] }>();
  const embedInFlight = new Map<string, Promise<number[]>>();
  const EMBED_CACHE_TTL_MS = 10 * 60 * 1000;
  const EMBED_CACHE_MAX_ENTRIES = 200;

  app.post('/api/ai/embed', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'Text input is required to generate an embedding.' });
        return;
      }

      const trimmed = text.trim().slice(0, 8000);
      const cacheKey = trimmed.toLowerCase().replace(/\s+/g, ' ');
      const cached = embedCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.status(200).json({ embedding: cached.embedding, cached: true });
        return;
      }

      const existing = embedInFlight.get(cacheKey);
      if (existing) {
        const values = await existing;
        res.status(200).json({ embedding: values, cached: true });
        return;
      }

      const ai = getAIClient();
      const task = (async () => {
        const result = await withRetry(
          () =>
            ai.models.embedContent({
              model: EMBEDDING_MODEL,
              contents: trimmed,
              config: {
                outputDimensionality: 256,
              },
            }),
          1
        );
        const values = result.embeddings?.[0]?.values ?? [];
        if (values.length > 0) {
          if (embedCache.size >= EMBED_CACHE_MAX_ENTRIES) {
            const oldest = embedCache.keys().next().value;
            if (oldest) embedCache.delete(oldest);
          }
          embedCache.set(cacheKey, { expiresAt: Date.now() + EMBED_CACHE_TTL_MS, embedding: values });
        }
        return values;
      })();

      embedInFlight.set(cacheKey, task);
      try {
        const values = await task;
        res.json({ embedding: values });
      } finally {
        if (embedInFlight.get(cacheKey) === task) {
          embedInFlight.delete(cacheKey);
        }
      }
    } catch (error) {
      handleAIError(res, error, 'embedding generation');
    }
  });

  // 2. AI Study Assistant Endpoint (Feature 2 — cached, coalesced, compact context, resilient failover)
  interface StudyAssistantCachedResult {
    answer: string;
    citedNoteIds: string[];
    insufficientContext: boolean;
    suggestedFollowUps: string[];
  }
  const studyAssistantCache = new Map<string, { expiresAt: number; payload: StudyAssistantCachedResult }>();
  const studyAssistantInFlight = new Map<string, Promise<StudyAssistantCachedResult>>();
  const STUDY_CACHE_TTL_MS = 5 * 60 * 1000;
  const STUDY_CACHE_MAX_ENTRIES = 100;

  app.post('/api/ai/study-assistant', async (req: Request, res: Response) => {
    try {
      const { question, notes, history, mode } = req.body as {
        question?: string;
        notes?: NotePayload[];
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
        mode?: 'ask' | 'simplify' | 'summarize' | 'examples';
      };

      const cleanedQuestion = typeof question === 'string' ? question.trim() : '';
      if (!cleanedQuestion) {
        res.status(400).json({ error: 'Please enter a question to ask your notes.', code: 'INVALID_REQUEST' });
        return;
      }

      // Send only compact, high-relevance note context (max 5 notes, ~11,000 chars total) to stay well within TPM limits
      const safeNotes = Array.isArray(notes) ? notes.slice(0, 5) : [];
      const validNoteIds = new Set(safeNotes.map((n) => n.noteId));
      const perNoteCharLimit = safeNotes.length <= 2 ? 4200 : Math.floor(11_000 / Math.max(1, safeNotes.length));

      const compactNotesContext =
        safeNotes.length > 0
          ? safeNotes
              .map(
                (n, idx) =>
                  `[NOTE ${idx + 1} | ID: ${n.noteId}]\nTitle: ${String(n.title || '').slice(0, 160)}\nSubject: ${String(n.subject || '').slice(0, 80)}\nTags: ${(n.tags || []).slice(0, 8).join(', ')}\nContent:\n${String(n.content || '').slice(0, perNoteCharLimit)}`
              )
              .join('\n\n---\n\n')
          : 'No saved notes provided.';

      // Keep only the last 6 conversation turns, trimmed cleanly
      const safeHistory = Array.isArray(history)
        ? history.slice(-6).map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content || '').slice(0, 600),
          }))
        : [];

      const activeMode = mode ?? 'ask';

      // Build deterministic cache/coalescing key from question + mode + recent history + note fingerprints
      const noteFingerprint = safeNotes
        .map((n) => `${n.noteId}:${String(n.content || '').length}:${String(n.title || '').slice(0, 40)}`)
        .join('|');
      const historyFingerprint = safeHistory.map((m) => `${m.role}:${m.content.slice(0, 80)}`).join('|');
      const cacheKey = `v2::${activeMode}::${cleanedQuestion.toLowerCase().replace(/\s+/g, ' ')}::${noteFingerprint}::${historyFingerprint}`;

      // 1) Serve fresh cached response immediately if identical query was answered recently
      const cachedEntry = studyAssistantCache.get(cacheKey);
      if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
        res.status(200).json({ ...cachedEntry.payload, cached: true });
        return;
      }

      // 2) Coalesce simultaneous duplicate requests so only one Gemini API call runs
      const existingInFlight = studyAssistantInFlight.get(cacheKey);
      if (existingInFlight) {
        const sharedPayload = await runWithAbortAndTimeout(req, res, 42_000, () => existingInFlight);
        res.status(200).json(sharedPayload);
        return;
      }

      const modeDirective =
        activeMode === 'simplify'
          ? 'Explain the topic in plain, beginner-friendly language using short paragraphs, clear headings, and relatable analogies grounded in the notes.'
          : activeMode === 'summarize'
            ? 'Provide a structured, concise summary with clear headings, scannable bullet points, and a short Key Takeaway section.'
            : activeMode === 'examples'
              ? 'Explain the concept with concrete, practical real-world examples linked directly to the concepts in the notes, using clear headings and bullet points.'
              : 'Answer the user question accurately, clearly, and thoroughly using structured Markdown.';

      const systemInstruction = `You are the MindMesh AI Study Assistant.

GROUNDING & SOURCE RULES:
1. Base your primary answer strictly on the user's saved personal notes provided below.
2. In citedNoteIds, return ONLY the exact unique note IDs from the [NOTE X | ID: ...] headers whose content actually contributed to your answer. Never include duplicates or unrelated notes.
3. If the user's saved notes do NOT contain enough information to fully answer the question, set insufficientContext to true and briefly explain what is missing from the notes.
4. SEPARATION OF EXTERNAL KNOWLEDGE: If you add helpful general/external knowledge to complete a comparison (e.g., standard algorithms, formulas, or real-world applications not explicitly written in the user's notes), NEVER mix it silently into note facts. Place any external context at the end under the exact heading:
### Additional General Knowledge (Beyond Your Saved Notes)
Only include that section when external knowledge is genuinely needed beyond what is in the saved notes.

MARKDOWN FORMATTING RULES (ALWAYS FOLLOW):
- Format the "answer" field in clean, valid GitHub-Flavored Markdown.
- Use clear headings (## and ###), short readable paragraphs, bold key terms, and bullet or numbered lists with clean spacing between sections.
- COMPARISON QUESTIONS (e.g., "compare", "difference between", "vs", "contrast"):
  1. Start with a concise overview grounded in the saved notes.
  2. Include a clean Markdown comparison table using pipe syntax with informative columns tailored to the question (for ML/technical comparisons, prefer columns such as: | Concept | Data Used | Goal | Algorithms | Applications |).
  3. Follow the table with concise bullet points for key distinctions, concrete examples, and a brief **Key Takeaway** section.
- EXPLANATION QUESTIONS:
  - Organize with clear headings, short paragraphs, bullet points, concrete examples, and a short **Key Takeaway** / **Summary** section when helpful.
- Use LaTeX math ($...$ for inline formulas, $$...$$ for display equations) when mathematical formulas are relevant, and fenced code blocks (\`\`\`lang) when code or pseudocode helps.
- ${modeDirective}`;

      const conversationContext =
        safeHistory.length > 0
          ? `Recent Conversation History:\n${safeHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}\n\n`
          : '';

      const prompt = `User's Relevant Saved Notes:\n${compactNotesContext}\n\n${conversationContext}Current User Question: ${cleanedQuestion}`;

      const ai = getAIClient();

      const executeQuery = async (signal: AbortSignal): Promise<StudyAssistantCachedResult> => {
        const { response } = await generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: prompt,
            config: {
              systemInstruction,
              abortSignal: attemptSignal,
              maxOutputTokens: 2800,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  answer: {
                    type: Type.STRING,
                    description:
                      'Clean GitHub-Flavored Markdown educational answer grounded in the saved notes, with comparison tables for comparisons and clearly separated Additional General Knowledge heading if external context is added.',
                  },
                  citedNoteIds: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Exact unique IDs of the saved notes that actually contributed to the answer.',
                  },
                  insufficientContext: {
                    type: Type.BOOLEAN,
                    description: 'True if the user notes did not contain enough information to answer the question.',
                  },
                  suggestedFollowUps: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Up to 3 helpful follow-up study questions based on the notes.',
                  },
                },
                required: ['answer', 'citedNoteIds', 'insufficientContext', 'suggestedFollowUps'],
              },
            },
          }),
          signal,
          { mode: 'reasoning' }
        );

        const parsed = parseModelJsonObject<{
          answer?: string;
          citedNoteIds?: string[];
          insufficientContext?: boolean;
          suggestedFollowUps?: string[];
        }>(response.text ?? '');

        const answer = String(parsed.answer || '').trim();
        if (!answer) {
          throw new Error('EMPTY_AI_RESPONSE: Study assistant returned an empty answer.');
        }

        const citedNoteIds = Array.isArray(parsed.citedNoteIds)
          ? Array.from(new Set(parsed.citedNoteIds.map((id) => String(id).trim()).filter((id) => validNoteIds.has(id))))
          : [];

        const suggestedFollowUps = Array.isArray(parsed.suggestedFollowUps)
          ? parsed.suggestedFollowUps
              .map((q) => String(q).trim())
              .filter(Boolean)
              .slice(0, 3)
          : [];

        const normalized: StudyAssistantCachedResult = {
          answer,
          citedNoteIds,
          insufficientContext: Boolean(parsed.insufficientContext),
          suggestedFollowUps,
        };

        // Store in bounded TTL cache
        if (studyAssistantCache.size >= STUDY_CACHE_MAX_ENTRIES) {
          const oldestKey = studyAssistantCache.keys().next().value;
          if (oldestKey) studyAssistantCache.delete(oldestKey);
        }
        studyAssistantCache.set(cacheKey, {
          expiresAt: Date.now() + STUDY_CACHE_TTL_MS,
          payload: normalized,
        });

        return normalized;
      };

      const taskPromise = runWithAbortAndTimeout(req, res, 42_000, (signal) => executeQuery(signal));
      studyAssistantInFlight.set(cacheKey, taskPromise);
      try {
        const result = await taskPromise;
        res.status(200).json(result);
      } finally {
        if (studyAssistantInFlight.get(cacheKey) === taskPromise) {
          studyAssistantInFlight.delete(cacheKey);
        }
      }
    } catch (error) {
      handleAIError(res, error, 'study assistant response');
    }
  });

  // 3. Automatic Mind Map Generator Endpoint (Feature 3 — cached, coalesced, 4-level hierarchy, resilient failover)
  interface MindMapCachedResult {
    title: string;
    nodes: Array<{
      id: string;
      title: string;
      description: string;
      level: number;
      parentId: string;
    }>;
    connections: Array<{
      id: string;
      source: string;
      target: string;
      label: string;
    }>;
  }
  const mindMapCache = new Map<string, { expiresAt: number; payload: MindMapCachedResult }>();
  const mindMapInFlight = new Map<string, Promise<MindMapCachedResult>>();
  const MINDMAP_CACHE_TTL_MS = 5 * 60 * 1000;
  const MINDMAP_CACHE_MAX_ENTRIES = 40;

  app.post('/api/ai/mindmap', async (req: Request, res: Response) => {
    try {
      const { notes, customTitle } = req.body as { notes?: NotePayload[]; customTitle?: string };
      if (!Array.isArray(notes) || notes.length === 0) {
        res.status(400).json({
          error: 'Select at least one note to generate a mind map.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      const safeNotes = notes
        .filter((n) => n && typeof n.noteId === 'string' && n.noteId.trim().length > 0)
        .slice(0, 10);

      if (safeNotes.length === 0) {
        res.status(400).json({
          error: 'Selected notes are missing valid IDs or content.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      // Preserve full selected note contents within a generous 24,000-char total context budget
      const totalBudget = 24_000;
      const perNoteCharLimit = Math.max(
        2200,
        Math.min(12_000, Math.floor(totalBudget / Math.max(1, safeNotes.length)))
      );

      const formattedNotes = safeNotes
        .map(
          (n, idx) =>
            `[NOTE ${idx + 1} | ID: ${n.noteId}]\nTitle: ${String(n.title || 'Untitled Note').slice(0, 160)}\nSubject: ${String(n.subject || 'General').slice(0, 80)}\nTags: ${(Array.isArray(n.tags) ? n.tags : []).slice(0, 10).join(', ')}\nContent:\n${String(n.content || '').slice(0, perNoteCharLimit)}`
        )
        .join('\n\n---\n\n');

      const cleanedCustomTitle = typeof customTitle === 'string' ? customTitle.trim().slice(0, 120) : '';
      const noteFingerprint = safeNotes
        .map((n) => `${n.noteId}:${String(n.content || '').length}:${String(n.title || '').slice(0, 40)}`)
        .join('|');
      const cacheKey = `mm-v2::${cleanedCustomTitle.toLowerCase()}::${noteFingerprint}`;

      // 1) Serve fresh cached mind map if identical note selection was generated recently
      const cached = mindMapCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.status(200).json({ ...cached.payload, cached: true });
        return;
      }

      // 2) Coalesce simultaneous duplicate requests so only one AI call runs
      const existingInFlight = mindMapInFlight.get(cacheKey);
      if (existingInFlight) {
        const shared = await runWithAbortAndTimeout(req, res, 42_000, () => existingInFlight);
        res.status(200).json(shared);
        return;
      }

      const multiNoteRule =
        safeNotes.length > 1
          ? `MULTI-NOTE SYNTHESIS (${safeNotes.length} notes selected):
- Combine concepts across ALL selected notes into ONE unified mind map.
- NEVER create duplicate branches for the same concept or theme across different notes — merge overlapping ideas into a single branch.
- Add 1 to 3 meaningful cross-branch connections in "connections" linking related concepts across different branches (with short relationship labels like "uses", "enables", "contrasts with", "builds on").`
          : 'Focus deeply on extracting the complete hierarchy of topics, subtopics, and supporting details/examples from this note.';

      const systemInstruction = `You are the MindMesh Hierarchical Mind Map Architect.
Analyze the provided saved note(s) and build an accurate, well-organized 4-level hierarchical mind map grounded strictly in the actual concepts, definitions, algorithms, and examples in the notes.

REQUIRED HIERARCHICAL STRUCTURE:
- Level 0 (Central Topic): Exactly 1 root node ("id": "node-root", "level": 0, "parentId": ""). Use a real, specific topic title (NEVER generic labels like "Captured Notes" or "Note 1").
- Level 1 (Main Branches): 3 to 6 distinct major themes ("level": 1, "parentId": "node-root").
- Level 2 (Subtopics): 2 to 3 subtopics per main branch ("level": 2, "parentId": branch id).
- Level 3 (Supporting Details / Examples): 1 to 2 concise supporting details, formulas, algorithms, or concrete examples under key subtopics ("level": 3, "parentId": subtopic id).
- Total nodes between 10 and 30.
- Every node must have a concise title (max 58 chars) and a clear 1-sentence description grounded in the notes.
- Use clean hierarchical IDs: "node-root", "node-1", "node-1-1", "node-1-1-1".
- Include parent->child edges for every non-root node in "connections", plus optional cross-branch relationship edges when concepts genuinely connect.

${multiNoteRule}`;

      const prompt = `${cleanedCustomTitle ? `Requested Central Topic Title: ${cleanedCustomTitle}\n\n` : ''}Selected Saved Notes (${safeNotes.length}):\n${formattedNotes}`;

      const ai = getAIClient();

      const executeGeneration = async (signal: AbortSignal): Promise<MindMapCachedResult> => {
        const { response } = await generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: prompt,
            config: {
              systemInstruction,
              abortSignal: attemptSignal,
              maxOutputTokens: 3200,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: 'Clear central title of the mind map.' },
                  nodes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        level: { type: Type.INTEGER },
                        parentId: { type: Type.STRING },
                      },
                      required: ['id', 'title', 'description', 'level', 'parentId'],
                    },
                  },
                  connections: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        source: { type: Type.STRING },
                        target: { type: Type.STRING },
                        label: { type: Type.STRING },
                      },
                      required: ['id', 'source', 'target', 'label'],
                    },
                  },
                },
                required: ['title', 'nodes', 'connections'],
              },
            },
          }),
          signal,
          { mode: 'reasoning' }
        );

        const parsed = parseModelJsonObject<{
          title?: string;
          nodes?: Array<{
            id?: string;
            title?: string;
            description?: string;
            level?: number;
            parentId?: string;
          }>;
          connections?: Array<{
            id?: string;
            source?: string;
            target?: string;
            label?: string;
          }>;
        }>(response.text ?? '');

        const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
        const cleanedNodes = rawNodes
          .map((n, idx) => ({
            id: String(n?.id || `node-${idx}`).trim(),
            title: String(n?.title || '').trim().slice(0, 100),
            description: String(n?.description || '').trim().slice(0, 400),
            level: Math.max(0, Math.min(3, Math.floor(Number(n?.level ?? 0)))),
            parentId: String(n?.parentId || '').trim(),
          }))
          .filter((n) => n.id.length > 0 && n.title.length > 0);

        if (cleanedNodes.length < 2) {
          throw new Error('EMPTY_AI_RESPONSE: Mind map generation returned too few concept nodes.');
        }

        // Ensure unique node IDs and single root
        const seenNodeIds = new Set<string>();
        const uniqueNodes: MindMapCachedResult['nodes'] = [];
        for (const n of cleanedNodes) {
          if (seenNodeIds.has(n.id)) continue;
          seenNodeIds.add(n.id);
          uniqueNodes.push(n);
        }

        const root = uniqueNodes.find((n) => n.level === 0 || !n.parentId) ?? uniqueNodes[0];
        root.level = 0;
        root.parentId = '';

        // Deduplicate Level-1 main branches with identical normalized titles (merge children into first branch)
        const branchCanonicalByKey = new Map<string, string>();
        const remappedIds = new Map<string, string>();
        const dedupedNodes: MindMapCachedResult['nodes'] = [root];

        for (const n of uniqueNodes) {
          if (n.id === root.id) continue;
          const isMainBranch = n.parentId === root.id || n.level === 1;
          if (isMainBranch) {
            const key = n.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const existingId = branchCanonicalByKey.get(key);
            if (existingId) {
              remappedIds.set(n.id, existingId);
              continue;
            }
            branchCanonicalByKey.set(key, n.id);
            dedupedNodes.push({ ...n, level: 1, parentId: root.id });
          } else {
            dedupedNodes.push(n);
          }
        }

        const validNodeIdSet = new Set(dedupedNodes.map((n) => n.id));
        const normalizedNodes = dedupedNodes.map((n) => {
          if (n.id === root.id) return n;
          let pid = remappedIds.get(n.parentId) ?? n.parentId;
          if (!pid || !validNodeIdSet.has(pid) || pid === n.id) {
            pid = root.id;
          }
          return { ...n, parentId: pid };
        });

        // Build clean deduplicated connections (parent-child + valid cross-branch edges)
        const rawConns = Array.isArray(parsed.connections) ? parsed.connections : [];
        const edgeKeys = new Set<string>();
        const normalizedConnections: MindMapCachedResult['connections'] = [];

        for (const n of normalizedNodes) {
          if (n.id === root.id || !n.parentId) continue;
          const key = `${n.parentId}->${n.id}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            normalizedConnections.push({
              id: `conn-${n.parentId}-${n.id}`,
              source: n.parentId,
              target: n.id,
              label: '',
            });
          }
        }

        for (const c of rawConns) {
          const src = remappedIds.get(String(c?.source || '').trim()) ?? String(c?.source || '').trim();
          const tgt = remappedIds.get(String(c?.target || '').trim()) ?? String(c?.target || '').trim();
          if (!src || !tgt || src === tgt || !validNodeIdSet.has(src) || !validNodeIdSet.has(tgt)) {
            continue;
          }
          const key = `${src}->${tgt}`;
          const reverseKey = `${tgt}->${src}`;
          const label = String(c?.label || '').trim().slice(0, 48);
          if (edgeKeys.has(key)) {
            if (label) {
              const existingEdge = normalizedConnections.find((e) => e.source === src && e.target === tgt);
              if (existingEdge && !existingEdge.label) existingEdge.label = label;
            }
            continue;
          }
          if (edgeKeys.has(reverseKey)) continue;
          edgeKeys.add(key);
          normalizedConnections.push({
            id: String(c?.id || `conn-cross-${src}-${tgt}`).trim(),
            source: src,
            target: tgt,
            label,
          });
        }

        const result: MindMapCachedResult = {
          title: cleanedCustomTitle || String(parsed.title || root.title || safeNotes[0].title).trim().slice(0, 120),
          nodes: normalizedNodes,
          connections: normalizedConnections,
        };

        if (mindMapCache.size >= MINDMAP_CACHE_MAX_ENTRIES) {
          const oldest = mindMapCache.keys().next().value;
          if (oldest) mindMapCache.delete(oldest);
        }
        mindMapCache.set(cacheKey, {
          expiresAt: Date.now() + MINDMAP_CACHE_TTL_MS,
          payload: result,
        });

        return result;
      };

      const taskPromise = runWithAbortAndTimeout(req, res, 42_000, (signal) => executeGeneration(signal));
      mindMapInFlight.set(cacheKey, taskPromise);
      try {
        const result = await taskPromise;
        res.status(200).json(result);
      } finally {
        if (mindMapInFlight.get(cacheKey) === taskPromise) {
          mindMapInFlight.delete(cacheKey);
        }
      }
    } catch (error) {
      handleAIError(res, error, 'mind map generation');
    }
  });

  // 4. Adaptive Quiz Generator Endpoint (Feature 5 — cached, coalesced, timeout-bounded, failover, strict validation)
  interface QuizQuestionPayloadServer {
    id: string;
    type: 'mcq' | 'short_answer';
    prompt: string;
    options: string[];
    correctAnswer: string;
    explanation: string;
    topic: string;
    sourceNoteId: string;
  }

  interface QuizCachedResult {
    questions: QuizQuestionPayloadServer[];
    modelUsed?: string;
  }

  const quizCache = new Map<string, { expiresAt: number; payload: QuizCachedResult }>();
  const quizInFlight = new Map<string, Promise<QuizCachedResult>>();
  const QUIZ_CACHE_TTL_MS = 3 * 60 * 1000;
  const QUIZ_CACHE_MAX_ENTRIES = 40;

  function sanitizeServerQuizQuestions(
    rawQuestions: unknown,
    validNoteIds: string[],
    fallbackSubject: string
  ): QuizQuestionPayloadServer[] {
    if (!Array.isArray(rawQuestions)) return [];

    const validNoteIdSet = new Set(validNoteIds);
    const defaultNoteId = validNoteIds[0] || '';
    const defaultTopic =
      fallbackSubject && fallbackSubject !== 'All Subjects' && fallbackSubject !== 'Mixed Subjects'
        ? fallbackSubject
        : 'Core Concepts';

    const seenIds = new Set<string>();
    const seenPrompts = new Set<string>();
    const result: QuizQuestionPayloadServer[] = [];

    for (let i = 0; i < rawQuestions.length; i++) {
      const q = rawQuestions[i] as Record<string, unknown> | null | undefined;
      if (!q || typeof q !== 'object') continue;

      const prompt = typeof q.prompt === 'string' ? q.prompt.replace(/\s+/g, ' ').trim() : '';
      if (prompt.length < 8) continue;

      const promptKey = prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!promptKey || seenPrompts.has(promptKey)) continue;

      let correctAnswer =
        typeof q.correctAnswer === 'string' ? q.correctAnswer.replace(/\s+/g, ' ').trim() : '';
      if (!correctAnswer) continue;

      let type: 'mcq' | 'short_answer' = q.type === 'short_answer' ? 'short_answer' : 'mcq';
      let options: string[] = [];

      if (type === 'mcq') {
        const rawOpts = Array.isArray(q.options) ? q.options : [];
        const optSeen = new Set<string>();
        for (const rawOpt of rawOpts) {
          if (typeof rawOpt !== 'string') continue;
          const cleaned = rawOpt.replace(/\s+/g, ' ').trim();
          const key = cleaned.toLowerCase();
          if (!cleaned || optSeen.has(key)) continue;
          optSeen.add(key);
          options.push(cleaned);
        }

        const letterMatch = correctAnswer.match(/^([A-D])(?:[.)])?$/i);
        if (letterMatch && options.length >= 2) {
          const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
          if (idx >= 0 && idx < options.length) {
            correctAnswer = options[idx];
          }
        }

        const exactOpt = options.find((o) => o.toLowerCase() === correctAnswer.toLowerCase());
        if (exactOpt) {
          correctAnswer = exactOpt;
        } else if (options.length > 0) {
          const strippedMatch = options.find(
            (o) => o.replace(/^[A-D][.)]\s*/i, '').toLowerCase() === correctAnswer.toLowerCase()
          );
          if (strippedMatch) {
            correctAnswer = strippedMatch;
          } else {
            options = [correctAnswer, ...options.slice(0, 3)];
          }
        }

        if (options.length < 2) {
          type = 'short_answer';
          options = [];
        } else if (options.length > 4) {
          const distractors = options.filter((o) => o !== correctAnswer).slice(0, 3);
          options = [correctAnswer, ...distractors];
        }
      }

      const explanation =
        typeof q.explanation === 'string' && q.explanation.trim().length >= 5
          ? q.explanation.replace(/\s+/g, ' ').trim()
          : `Based on your saved notes, the correct answer is: ${correctAnswer}.`;

      const topic =
        typeof q.topic === 'string' && q.topic.trim().length >= 2
          ? q.topic.replace(/\s+/g, ' ').trim().slice(0, 80)
          : defaultTopic;

      const rawSource = typeof q.sourceNoteId === 'string' ? q.sourceNoteId.trim() : '';
      const sourceNoteId = validNoteIdSet.has(rawSource) ? rawSource : defaultNoteId;

      let id =
        typeof q.id === 'string' && q.id.trim().length > 0
          ? q.id.trim().replace(/[^a-zA-Z0-9_-]/g, '')
          : `q-${result.length + 1}`;
      if (!id || seenIds.has(id)) {
        id = `q-${result.length + 1}`;
        while (seenIds.has(id)) {
          id = `q-${result.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
        }
      }

      seenIds.add(id);
      seenPrompts.add(promptKey);
      result.push({
        id,
        type,
        prompt,
        options,
        correctAnswer,
        explanation,
        topic,
        sourceNoteId,
      });
    }

    return result;
  }

  app.post('/api/ai/quiz/generate', async (req: Request, res: Response) => {
    try {
      const { notes, subject, difficulty, questionCount, weakTopics, bypassCache } = req.body as {
        notes?: NotePayload[];
        subject?: string;
        difficulty?: 'easy' | 'medium' | 'hard';
        questionCount?: number;
        weakTopics?: string[];
        bypassCache?: boolean;
      };

      if (!Array.isArray(notes) || notes.length === 0) {
        res.status(400).json({
          error: 'Select at least one note or subject to generate a quiz.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      // Deduplicate and sanitize selected notes while keeping a safe total token budget
      const seenNoteIds = new Set<string>();
      const safeNotes: NotePayload[] = [];
      for (const n of notes) {
        if (!n || typeof n.noteId !== 'string' || !n.noteId.trim()) continue;
        if (seenNoteIds.has(n.noteId)) continue;
        seenNoteIds.add(n.noteId);
        safeNotes.push(n);
        if (safeNotes.length >= 10) break;
      }

      if (safeNotes.length === 0) {
        res.status(400).json({
          error: 'Selected notes are missing valid IDs or content.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      const cleanedSubject =
        typeof subject === 'string' && subject.trim() ? subject.trim().slice(0, 100) : 'Selected Notes';
      const count = Math.min(Math.max(Number(questionCount) || 5, 1), 15);
      const level = difficulty === 'easy' || difficulty === 'hard' ? difficulty : 'medium';
      const safeWeakTopics = Array.isArray(weakTopics)
        ? weakTopics
            .map((t) => String(t || '').trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];

      const totalBudget = 20_000;
      const perNoteCharLimit = Math.max(
        1800,
        Math.min(8000, Math.floor(totalBudget / Math.max(1, safeNotes.length)))
      );

      const compactNotesContext = safeNotes
        .map(
          (n, idx) =>
            `[NOTE ${idx + 1} | ID: ${n.noteId}]\nTitle: ${String(n.title || 'Untitled Note').slice(0, 160)}\nSubject: ${String(n.subject || cleanedSubject).slice(0, 80)}\nTags: ${(Array.isArray(n.tags) ? n.tags : []).slice(0, 8).join(', ')}\nContent:\n${String(n.content || '').slice(0, perNoteCharLimit)}`
        )
        .join('\n\n---\n\n');

      const noteFingerprint = safeNotes
        .map((n) => `${n.noteId}:${String(n.content || '').length}`)
        .sort()
        .join('|');
      const cacheKey = `quiz::v1::${cleanedSubject.toLowerCase()}::${level}::${count}::${safeWeakTopics.join(',').toLowerCase()}::${noteFingerprint}`;

      if (!bypassCache) {
        const cachedEntry = quizCache.get(cacheKey);
        if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
          res.status(200).json({ ...cachedEntry.payload, cached: true });
          return;
        }
      }

      const existingInFlight = quizInFlight.get(cacheKey);
      if (existingInFlight) {
        const shared = await runWithAbortAndTimeout(req, res, 38_000, () => existingInFlight);
        res.status(200).json({ ...shared, cached: true });
        return;
      }

      const mcqTarget = Math.max(1, Math.round(count * 0.7));
      const shortTarget = Math.max(0, count - mcqTarget);
      const focusGuidance =
        safeWeakTopics.length > 0
          ? `The learner previously struggled with these topics: ${safeWeakTopics.join(', ')}. Prioritize reinforcing these areas.`
          : '';

      const systemInstruction = `You are the MindMesh Adaptive Quiz Engine.
Generate exactly ${count} accurate, unambiguous quiz questions strictly grounded in the user's saved notes for the subject "${cleanedSubject}".
Difficulty level: ${level.toUpperCase()}.
- For "easy": test fundamental definitions, terminology, and core recall from the notes.
- For "medium": test conceptual understanding, comparisons, mechanisms, and practical application.
- For "hard": test deep synthesis, multi-step reasoning, edge cases, trade-offs, and cross-note connections.

STRICT OUTPUT RULES:
1. Create approximately ${mcqTarget} multiple-choice ("mcq") questions and ${shortTarget} short-answer ("short_answer") questions.
2. For every "mcq" question:
   - Provide EXACTLY 4 distinct, plausible answer options in "options".
   - Set "correctAnswer" to the EXACT string matching one of the 4 items in "options" (never just "A" or "B").
3. For every "short_answer" question:
   - Set "options" to an empty array [].
   - Set "correctAnswer" to a clear, concise expected answer grounded in the notes.
4. Every question must include a unique "id" ("q-1", "q-2", ...), a clear "explanation" citing the concept, a concise "topic", and a valid "sourceNoteId" from the provided [NOTE X | ID: ...] headers.
5. Output ONLY valid JSON matching the response schema.
${focusGuidance}`;

      const prompt = `Subject: ${cleanedSubject}\nRequested Questions: ${count} (${level} difficulty)\n\nSaved Notes:\n${compactNotesContext}`;
      const validNoteIds = safeNotes.map((n) => n.noteId);
      const ai = getAIClient();

      const executeGeneration = async (signal: AbortSignal): Promise<QuizCachedResult> => {
        const { response, modelUsed } = await generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: prompt,
            config: {
              systemInstruction,
              abortSignal: attemptSignal,
              maxOutputTokens: 3200,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  questions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        type: { type: Type.STRING, description: 'Either "mcq" or "short_answer"' },
                        prompt: { type: Type.STRING },
                        options: { type: Type.ARRAY, items: { type: Type.STRING } },
                        correctAnswer: { type: Type.STRING },
                        explanation: { type: Type.STRING },
                        topic: { type: Type.STRING },
                        sourceNoteId: { type: Type.STRING },
                      },
                      required: [
                        'id',
                        'type',
                        'prompt',
                        'options',
                        'correctAnswer',
                        'explanation',
                        'topic',
                        'sourceNoteId',
                      ],
                    },
                  },
                },
                required: ['questions'],
              },
            },
          }),
          signal,
          { mode: 'reasoning' }
        );

        const parsed = parseModelJsonObject<{ questions?: unknown }>(response.text ?? '');
        const sanitized = sanitizeServerQuizQuestions(parsed.questions, validNoteIds, cleanedSubject);

        if (sanitized.length === 0) {
          throw new Error('PARSING_ERROR: AI returned no valid quiz questions.');
        }

        const normalized: QuizCachedResult = {
          questions: sanitized.slice(0, count),
          modelUsed,
        };

        if (quizCache.size >= QUIZ_CACHE_MAX_ENTRIES) {
          const oldestKey = quizCache.keys().next().value;
          if (oldestKey) quizCache.delete(oldestKey);
        }
        quizCache.set(cacheKey, {
          expiresAt: Date.now() + QUIZ_CACHE_TTL_MS,
          payload: normalized,
        });

        return normalized;
      };

      const taskPromise = runWithAbortAndTimeout(req, res, 38_000, (signal) => executeGeneration(signal));
      quizInFlight.set(cacheKey, taskPromise);
      try {
        const result = await taskPromise;
        res.status(200).json(result);
      } finally {
        if (quizInFlight.get(cacheKey) === taskPromise) {
          quizInFlight.delete(cacheKey);
        }
      }
    } catch (error) {
      handleAIError(res, error, 'quiz generation');
    }
  });

  // 5. Adaptive Quiz Evaluation Endpoint (Feature 5 — timeout-bounded with failover and local short-answer fallback)
  function gradeShortAnswerLocallyServer(
    submitted: string,
    expected: string,
    topic: string,
    explanation: string
  ): { isCorrect: boolean; feedback: string } {
    const cleanSubmitted = submitted.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanExpected = expected.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'into', 'your', 'have']);
    const expectedTerms = Array.from(
      new Set(`${cleanExpected} ${topic.toLowerCase()}`.split(' ').filter((w) => w.length >= 3 && !stop.has(w)))
    );
    const submittedSet = new Set(cleanSubmitted.split(' ').filter((w) => w.length >= 3));
    let matched = 0;
    for (const term of expectedTerms) {
      if (submittedSet.has(term) || cleanSubmitted.includes(term)) matched += 1;
    }
    const ratio = expectedTerms.length > 0 ? matched / expectedTerms.length : 0;
    const isCorrect =
      cleanSubmitted.length >= 6 &&
      (cleanSubmitted === cleanExpected || ratio >= 0.35 || matched >= 3);
    return {
      isCorrect,
      feedback: isCorrect
        ? `Good conceptual match with your notes. ${explanation}`
        : `Compare with expected concept: "${expected}". ${explanation}`,
    };
  }

  app.post('/api/ai/quiz/evaluate', async (req: Request, res: Response) => {
    try {
      const { questions, userAnswers } = req.body as {
        questions?: Array<{
          id: string;
          type: 'mcq' | 'short_answer';
          prompt: string;
          correctAnswer: string;
          explanation: string;
          topic: string;
        }>;
        userAnswers?: Record<string, string>;
      };

      if (!Array.isArray(questions) || questions.length === 0 || !userAnswers) {
        res.status(400).json({ error: 'Questions and submitted answers are required.', code: 'INVALID_REQUEST' });
        return;
      }

      const shortAnswerItems = questions.filter((q) => q.type === 'short_answer');
      let aiShortGrades: Record<string, { isCorrect: boolean; feedback: string }> = {};

      if (shortAnswerItems.length > 0) {
        try {
          const ai = getAIClient();
          const gradingPrompt = shortAnswerItems
            .map(
              (q) =>
                `Question ID: ${q.id}\nQuestion: ${q.prompt}\nExpected Concept/Answer: ${q.correctAnswer}\nStudent Answer: ${userAnswers[q.id] || '(blank)'}`
            )
            .join('\n\n---\n\n');

          const { response } = await runWithAbortAndTimeout(req, res, 24_000, (signal) =>
            generateCaptureWithFallback(
              ai,
              (model, thinkingLevel, attemptSignal) => ({
                model,
                contents: gradingPrompt,
                config: {
                  systemInstruction:
                    'Grade each short-answer student response fairly based on conceptual accuracy against the expected answer. Give brief constructive feedback.',
                  abortSignal: attemptSignal,
                  maxOutputTokens: 1600,
                  thinkingConfig: { thinkingLevel },
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      grades: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            questionId: { type: Type.STRING },
                            isCorrect: { type: Type.BOOLEAN },
                            feedback: { type: Type.STRING },
                          },
                          required: ['questionId', 'isCorrect', 'feedback'],
                        },
                      },
                    },
                    required: ['grades'],
                  },
                },
              }),
              signal,
              { mode: 'reasoning' }
            )
          );

          const parsed = parseModelJsonObject<{
            grades?: Array<{ questionId: string; isCorrect: boolean; feedback: string }>;
          }>(response.text ?? '');
          for (const g of parsed.grades ?? []) {
            if (g && typeof g.questionId === 'string') {
              aiShortGrades[g.questionId] = {
                isCorrect: Boolean(g.isCorrect),
                feedback: typeof g.feedback === 'string' ? g.feedback : '',
              };
            }
          }
        } catch (aiErr) {
          // If AI grading is unavailable/rate-limited/timed-out, gracefully grade short answers locally instead of blocking quiz submission
          console.warn(
            '[MindMesh AI] Short-answer AI grading unavailable; using deterministic local grading fallback:',
            aiErr instanceof Error ? aiErr.message : String(aiErr)
          );
        }
      }

      const evaluatedAnswers = questions.map((q) => {
        const submitted = (userAnswers[q.id] ?? '').trim();
        if (q.type === 'mcq') {
          const isCorrect = submitted.toLowerCase() === q.correctAnswer.trim().toLowerCase();
          return {
            questionId: q.id,
            userAnswer: submitted,
            isCorrect,
            feedback: isCorrect ? `Correct. ${q.explanation}` : `Expected "${q.correctAnswer}". ${q.explanation}`,
          };
        }
        const grade = aiShortGrades[q.id];
        if (grade) {
          return {
            questionId: q.id,
            userAnswer: submitted,
            isCorrect: grade.isCorrect,
            feedback: grade.feedback ? `${grade.feedback} ${q.explanation}` : q.explanation,
          };
        }
        const localGrade = gradeShortAnswerLocallyServer(submitted, q.correctAnswer, q.topic || '', q.explanation || '');
        return {
          questionId: q.id,
          userAnswer: submitted,
          isCorrect: localGrade.isCorrect,
          feedback: localGrade.feedback,
        };
      });

      const correctCount = evaluatedAnswers.filter((a) => a.isCorrect).length;
      const score = Math.round((correctCount / questions.length) * 100);
      const weakTopics = Array.from(
        new Set(
          questions
            .filter((q) => !evaluatedAnswers.find((a) => a.questionId === q.id)?.isCorrect)
            .map((q) => q.topic)
            .filter(Boolean)
        )
      ).slice(0, 15);

      res.status(200).json({
        score,
        correctCount,
        totalQuestions: questions.length,
        evaluatedAnswers,
        weakTopics,
      });
    } catch (error) {
      handleAIError(res, error, 'quiz evaluation');
    }
  });

  // 6. Memory Revival Relevance Reason Generator (Feature 6)
  app.post('/api/ai/memory-revival', async (req: Request, res: Response) => {
    try {
      const { currentNote, candidateNotes } = req.body as {
        currentNote?: NotePayload;
        candidateNotes?: Array<NotePayload & { similarity: number }>;
      };

      if (!currentNote || !Array.isArray(candidateNotes) || candidateNotes.length === 0) {
        res.status(400).json({ error: 'Current note and candidate notes are required.' });
        return;
      }

      const prompt = `Currently Studied Note:\nTitle: ${currentNote.title}\nSubject: ${currentNote.subject}\nContent: ${currentNote.content.slice(0, 2500)}\n\nCandidate Older Notes:\n${candidateNotes
        .slice(0, 6)
        .map(
          (c) =>
            `[ID: ${c.noteId}] Title: ${c.title} | Subject: ${c.subject} | Tags: ${c.tags.join(', ')}\nSnippet: ${c.content.slice(0, 1000)}`
        )
        .join('\n\n')}`;

      const ai = getAIClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: TEXT_MODEL,
          contents: prompt,
          config: {
            systemInstruction:
              'You are the MindMesh Memory Revival Engine. For each candidate older note, write a concise 1-2 sentence "Remember this?" explanation describing specifically how that older note helps the user understand what they are currently studying. Ground every reason in the actual note contents.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                revivals: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      noteId: { type: Type.STRING },
                      reason: { type: Type.STRING },
                      keyTakeaway: { type: Type.STRING },
                    },
                    required: ['noteId', 'reason', 'keyTakeaway'],
                  },
                },
              },
              required: ['revivals'],
            },
          },
        })
      );

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (error) {
      handleAIError(res, error, 'memory revival analysis');
    }
  });

  // 7. Explain My Connection Endpoint (Feature 7 — supports both Note pairs & Brain Graph Concept edges)
  app.post('/api/ai/explain-connection', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        mode?: 'note' | 'concept';
        // Note-pair mode (ExplainConnectionPage)
        sourceNote?: NotePayload;
        targetNote?: NotePayload;
        intermediateNotes?: NotePayload[];
        sharedTags?: string[];
        similarityScore?: number;
        // Concept-edge mode (BrainGraphPage)
        sourceConcept?: {
          id: string;
          label: string;
          category?: string;
          description?: string;
          sourceNoteIds?: string[];
        };
        targetConcept?: {
          id: string;
          label: string;
          category?: string;
          description?: string;
          sourceNoteIds?: string[];
        };
        relationship?: string;
        edgeReason?: string;
        selectedNotes?: NotePayload[];
      };

      const ai = getAIClient();

      // Mode A: Concept-to-Concept Connection Explanation (Brain Graph edge / pair)
      if (body.mode === 'concept' || (body.sourceConcept && body.targetConcept)) {
        const { sourceConcept, targetConcept, relationship, edgeReason, selectedNotes } = body;
        if (!sourceConcept?.label || !targetConcept?.label) {
          res.status(400).json({
            error: 'Both a source concept and a target concept are required.',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        const safeNotes = Array.isArray(selectedNotes) ? selectedNotes.slice(0, 15) : [];
        const perNoteBudget = safeNotes.length > 6 ? 2200 : 3800;
        const notesContext =
          safeNotes.length > 0
            ? safeNotes
                .map(
                  (n, idx) =>
                    `[NOTE ${idx + 1} | ID: ${n.noteId}]\nTitle: ${n.title}\nSubject: ${n.subject}\nContent:\n${String(n.content || '').slice(0, perNoteBudget)}`
                )
                .join('\n\n---\n\n')
            : 'No supporting note excerpts provided.';

        const validNoteIds = new Set(safeNotes.map((n) => n.noteId));

        const prompt = `Explain the conceptual connection between these two concepts from the user's Brain Graph:
Concept A (Source): "${sourceConcept.label}"${sourceConcept.category ? ` [Category: ${sourceConcept.category}]` : ''}
Concept A Description: ${sourceConcept.description || 'Not provided'}

Concept B (Target): "${targetConcept.label}"${targetConcept.category ? ` [Category: ${targetConcept.category}]` : ''}
Concept B Description: ${targetConcept.description || 'Not provided'}

Graph Edge Relationship Label: "${relationship || 'relates to'}"
Brief Edge Context: ${edgeReason || 'Connected conceptually within the selected notes.'}

User's Selected Study Notes:
${notesContext}`;

        const { response } = await runWithAbortAndTimeout(req, res, 42_000, (signal) =>
          generateCaptureWithFallback(
            ai,
            (model, thinkingLevel, attemptSignal) => ({
              model,
              contents: prompt,
              config: {
                systemInstruction: `You are the MindMesh Brain Graph Connection Explainer.
Explain clearly and concisely how Concept A connects to Concept B based strictly on the user's selected study notes.
- Ground every claim in the provided notes.
- Keep summary to 1 sentence, whyConnected to 2-3 sentences, and howTheyRelate to 2-3 sentences.
- Give 1-2 short practical examples and 1-3 related bridging concepts.
- Return exact noteId strings from [NOTE X | ID: ...] in citedNoteIds.`,
                abortSignal: attemptSignal,
                maxOutputTokens: 1024,
                thinkingConfig: { thinkingLevel },
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    summary: { type: Type.STRING, description: 'One concise headline sentence.' },
                    whyConnected: { type: Type.STRING, description: '2-3 sentences explaining why they are connected in the notes.' },
                    howTheyRelate: { type: Type.STRING, description: '2-3 sentences explaining how Concept A relates to Concept B.' },
                    examples: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: '1 to 2 simple practical examples.',
                    },
                    intermediateConcepts: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: '0 to 3 bridging concepts.',
                    },
                    citedNoteIds: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: 'Exact note IDs supporting this connection.',
                    },
                    connectionStrengthNote: {
                      type: Type.STRING,
                      description: 'One short sentence on note coverage.',
                    },
                  },
                  required: [
                    'summary',
                    'whyConnected',
                    'howTheyRelate',
                    'examples',
                    'intermediateConcepts',
                    'citedNoteIds',
                    'connectionStrengthNote',
                  ],
                },
              },
            }),
            signal,
            { mode: 'reasoning' }
          )
        );

        const parsed = parseModelJsonObject<{
          summary?: string;
          whyConnected?: string;
          howTheyRelate?: string;
          examples?: string[];
          intermediateConcepts?: string[];
          citedNoteIds?: string[];
          connectionStrengthNote?: string;
        }>(response.text ?? '');

        const fallbackCitedIds = Array.from(
          new Set([
            ...(sourceConcept.sourceNoteIds || []),
            ...(targetConcept.sourceNoteIds || []),
          ])
        ).filter((id) => validNoteIds.has(id));

        const citedNoteIds = Array.isArray(parsed.citedNoteIds)
          ? Array.from(new Set(parsed.citedNoteIds.filter((id) => validNoteIds.has(id))))
          : [];

        res.status(200).json({
          summary: String(parsed.summary || `${sourceConcept.label} connects directly to ${targetConcept.label}.`).trim(),
          whyConnected: String(parsed.whyConnected || '').trim(),
          howTheyRelate: String(parsed.howTheyRelate || '').trim(),
          explanation: [parsed.whyConnected, parsed.howTheyRelate].filter(Boolean).join('\n\n').trim(),
          examples: Array.isArray(parsed.examples)
            ? parsed.examples.map((e) => String(e).trim()).filter(Boolean).slice(0, 4)
            : [],
          intermediateConcepts: Array.isArray(parsed.intermediateConcepts)
            ? parsed.intermediateConcepts.map((c) => String(c).trim()).filter(Boolean).slice(0, 6)
            : [],
          citedNoteIds: citedNoteIds.length > 0 ? citedNoteIds : fallbackCitedIds,
          connectionStrengthNote: String(parsed.connectionStrengthNote || '').trim(),
        });
        return;
      }

      // Mode B: Note-to-Note Connection Explanation (ExplainConnectionPage)
      const { sourceNote, targetNote, intermediateNotes, sharedTags, similarityScore } = body;

      if (!sourceNote || !targetNote) {
        res.status(400).json({ error: 'Both a source note and a target note are required.' });
        return;
      }

      const pathNotes = [sourceNote, ...(intermediateNotes || []), targetNote];
      const prompt = `Explain the knowledge connection between these two nodes in the user's Brain Graph:
Source Concept: "${sourceNote.title}" (${sourceNote.subject})
Target Concept: "${targetNote.title}" (${targetNote.subject})
Shared Tags: ${(sharedTags || []).join(', ') || 'None'}
Semantic Similarity Score: ${typeof similarityScore === 'number' ? Math.round(similarityScore * 100) + '%' : 'Computed via graph path'}
Intermediate Bridge Notes in Graph Path: ${(intermediateNotes || []).map((n) => n.title).join(' -> ') || 'Direct connection'}

Supporting Personal Notes:\n${formatNotesContext(pathNotes)}`;

      const { response } = await runWithAbortAndTimeout(req, res, 38_000, (signal) =>
        generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: prompt,
            config: {
              systemInstruction: `You are the MindMesh Connection Explainer.
Analyze the user's actual saved notes to explain why the source and target concepts are connected.
- Ground your explanation in the provided notes wherever possible. If the notes only show a weak or indirect conceptual bridge, state that honestly rather than fabricating links.
- List intermediate concepts that bridge the two topics.
- Provide a clear, simple explanation.
- Provide 2 to 4 practical, real-world examples illustrating how these concepts work together.`,
              abortSignal: attemptSignal,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  summary: { type: Type.STRING, description: 'One-sentence headline summary of the connection.' },
                  explanation: { type: Type.STRING, description: 'Clear, accessible explanation grounded in the user notes.' },
                  intermediateConcepts: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Key bridging concepts between the source and target nodes.',
                  },
                  examples: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Practical, real-world examples showing how the two concepts work together.',
                  },
                  connectionStrengthNote: {
                    type: Type.STRING,
                    description: 'Honest note on how strongly the saved notes support this connection.',
                  },
                },
                required: ['summary', 'explanation', 'intermediateConcepts', 'examples', 'connectionStrengthNote'],
              },
            },
          }),
          signal,
          { mode: 'reasoning' }
        )
      );

      const parsed = parseModelJsonObject(response.text ?? '');
      res.status(200).json(parsed);
    } catch (error) {
      handleAIError(res, error, 'connection explanation');
    }
  });

  // 7b. Brain Graph Concept Extraction Endpoint (Feature 1 — Selected Notes -> Concept Graph)
  const brainGraphCache = new Map<string, { expiresAt: number; payload: Record<string, unknown> }>();
  const BRAIN_GRAPH_CACHE_TTL_MS = 5 * 60 * 1000;
  const BRAIN_GRAPH_CACHE_MAX_ENTRIES = 40;

  app.post('/api/ai/brain-graph', async (req: Request, res: Response) => {
    try {
      const { notes } = req.body as { notes?: NotePayload[] };
      if (!Array.isArray(notes) || notes.length === 0) {
        res.status(400).json({
          error: 'Select at least one saved note to generate a Brain Graph.',
          code: 'NO_NOTES_SELECTED',
        });
        return;
      }

      const selectedNotes = notes.slice(0, 25);
      const cacheKey = selectedNotes
        .map((n) => `${n.noteId}:${String(n.content || '').length}:${String(n.title || '').slice(0, 40)}`)
        .sort()
        .join('|');
      const cachedGraph = brainGraphCache.get(cacheKey);
      if (cachedGraph && cachedGraph.expiresAt > Date.now()) {
        res.status(200).json({ ...cachedGraph.payload, cached: true });
        return;
      }

      const validNoteIds = new Set(selectedNotes.map((n) => n.noteId));
      const noteTitleKeys = new Set(selectedNotes.map((n) => normalizeConceptKey(n.title || '')));
      const subjectKeys = new Set(selectedNotes.map((n) => normalizeConceptKey(n.subject || '')));

      // Dynamically size per-note excerpt budget so even large multi-note selections stay fast and complete
      const maxTotalChars = 30_000;
      const perNoteBudget = Math.max(1100, Math.min(4500, Math.floor(maxTotalChars / selectedNotes.length)));

      const formattedNotes = selectedNotes
        .map(
          (n, idx) =>
            `[NOTE ${idx + 1} | ID: ${n.noteId}]\nTitle: ${n.title}\nSubject: ${n.subject}\nTags: ${(n.tags || []).join(', ') || 'None'}\nContent:\n${String(n.content || '').slice(0, perNoteBudget)}`
        )
        .join('\n\n---\n\n');

      const ai = getAIClient();
      const { response, modelUsed } = await runWithAbortAndTimeout(req, res, 42_000, (signal) =>
        generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: `Analyze ONLY the following ${selectedNotes.length} selected study note(s) and build a clean, meaningful conceptual Brain Graph:\n\n${formattedNotes}`,
            config: {
              systemInstruction: `You are the MindMesh Brain Graph Concept Extractor.
Analyze the ACTUAL CONTENT inside the user's selected notes and extract a clean, structured concept graph.

STRICT RULES:
1. NEVER create generic metadata nodes such as "Captured Notes", "Notes (date)", "Class Notes", "Untitled", "Page 1", "Summary", or repeated generic subject names like "Computer Science".
2. Extract ONLY meaningful domain concepts actually present in the selected notes (e.g., for AI/ML notes: "Artificial Intelligence", "Machine Learning", "Supervised Learning", "Unsupervised Learning", "Deep Learning", "Neural Networks", "Classification", "Regression", "Data Preprocessing", "Model Evaluation").
3. Aim for 6 to 18 distinct, high-value concepts depending on the richness of the notes (fewer if only one short note is selected, never invent concepts absent from the notes).
4. Every concept must be unique — NEVER duplicate a concept under slightly different wording.
5. Assign each concept a hierarchy tier:
   - tier 0: 1-2 overarching root/umbrella concepts
   - tier 1: major sub-fields or primary pillars
   - tier 2: core techniques, methods, workflows, or mechanisms
   - tier 3: specific algorithms, metrics, formulas, or detailed examples
6. Assign each concept a concise topic category (2-3 words, e.g., "AI Foundations", "Learning Paradigms", "Model Pipeline") and a concise 1-2 sentence description grounded strictly in the selected notes.
7. Map each concept's sourceNoteIds to the EXACT note IDs ([NOTE X | ID: ...]) from which that concept was extracted.
8. Create directed conceptual edges ONLY when a genuine conceptual relationship exists (hierarchy, specialization, dependency, workflow, technique, evaluation). Keep edges clean and purposeful (avoid connecting every node to every other node).
9. Give each edge a crisp 1-3 word relationship verb/phrase (e.g., "encompasses", "specializes into", "includes", "uses", "prepares data for", "evaluates") and a concise 1-sentence reason grounded in the notes.`,
              abortSignal: attemptSignal,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  graphTitle: {
                    type: Type.STRING,
                    description: 'Concise conceptual title for the generated Brain Graph (e.g., "AI & Machine Learning Concept Map").',
                  },
                  summary: {
                    type: Type.STRING,
                    description: 'One concise sentence summarizing the key conceptual structure extracted from the selected notes.',
                  },
                  concepts: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING, description: 'Short unique lowercase slug id.' },
                        label: { type: Type.STRING, description: 'Clean domain concept name (2-5 words).' },
                        category: { type: Type.STRING, description: 'Short topic cluster label.' },
                        description: { type: Type.STRING, description: 'Concise 1-2 sentence explanation grounded in the selected notes.' },
                        tier: { type: Type.INTEGER, description: 'Conceptual depth tier from 0 (umbrella) to 3 (specific detail).' },
                        sourceNoteIds: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                          description: 'Exact noteId values from the selected notes where this concept appears.',
                        },
                      },
                      required: ['id', 'label', 'category', 'description', 'tier', 'sourceNoteIds'],
                    },
                  },
                  edges: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        source: { type: Type.STRING, description: 'Source concept id.' },
                        target: { type: Type.STRING, description: 'Target concept id.' },
                        relationship: { type: Type.STRING, description: 'Short 1-3 word relationship label.' },
                        reason: { type: Type.STRING, description: 'One concise sentence explaining why these concepts connect.' },
                      },
                      required: ['source', 'target', 'relationship', 'reason'],
                    },
                  },
                },
                required: ['graphTitle', 'summary', 'concepts', 'edges'],
              },
            },
          }),
          signal,
          { mode: 'reasoning' }
        )
      );

      const rawParsed = parseModelJsonObject<{
        graphTitle?: string;
        summary?: string;
        concepts?: Array<{
          id?: string;
          label?: string;
          category?: string;
          description?: string;
          tier?: number;
          sourceNoteIds?: string[];
        }>;
        edges?: Array<{
          source?: string;
          target?: string;
          relationship?: string;
          reason?: string;
        }>;
      }>(response.text ?? '');

      // Sanitize & deduplicate concept nodes
      const canonicalByKey = new Map<
        string,
        {
          id: string;
          label: string;
          category: string;
          description: string;
          tier: number;
          sourceNoteIds: string[];
        }
      >();
      const rawIdToCanonicalId = new Map<string, string>();
      const usedIds = new Set<string>();

      for (const rawNode of Array.isArray(rawParsed.concepts) ? rawParsed.concepts : []) {
        const label = String(rawNode?.label || '').trim();
        if (!label || isGenericConceptLabel(label, noteTitleKeys, subjectKeys)) {
          continue;
        }
        const key = normalizeConceptKey(label);
        const description = String(rawNode?.description || '').trim();
        const rawSourceIds = Array.isArray(rawNode?.sourceNoteIds)
          ? rawNode.sourceNoteIds.map((id) => String(id).trim()).filter((id) => validNoteIds.has(id))
          : [];
        const sourceNoteIds =
          rawSourceIds.length > 0
            ? Array.from(new Set(rawSourceIds))
            : inferSourceNotesForConcept(label, description, selectedNotes);

        const existing = canonicalByKey.get(key);
        if (existing) {
          // Merge sourceNoteIds into the existing canonical concept
          existing.sourceNoteIds = Array.from(new Set([...existing.sourceNoteIds, ...sourceNoteIds]));
          if (!existing.description && description) {
            existing.description = description;
          }
          if (rawNode?.id) {
            rawIdToCanonicalId.set(String(rawNode.id).trim(), existing.id);
          }
          continue;
        }

        let canonicalId = slugifyConceptId(String(rawNode?.id || label));
        if (usedIds.has(canonicalId)) {
          let suffix = 2;
          while (usedIds.has(`${canonicalId}-${suffix}`)) suffix += 1;
          canonicalId = `${canonicalId}-${suffix}`;
        }
        usedIds.add(canonicalId);

        const clampedTier = Number.isFinite(Number(rawNode?.tier))
          ? Math.max(0, Math.min(3, Math.round(Number(rawNode?.tier))))
          : 1;

        const conceptObj = {
          id: canonicalId,
          label,
          category: String(rawNode?.category || selectedNotes[0]?.subject || 'Core Concept').trim().slice(0, 48),
          description:
            description || `Key concept identified in your selected ${selectedNotes[0]?.subject || 'study'} notes.`,
          tier: clampedTier,
          sourceNoteIds,
        };

        canonicalByKey.set(key, conceptObj);
        if (rawNode?.id) {
          rawIdToCanonicalId.set(String(rawNode.id).trim(), canonicalId);
        }
        rawIdToCanonicalId.set(label.toLowerCase(), canonicalId);
      }

      const concepts = Array.from(canonicalByKey.values()).slice(0, 22);
      const validConceptIds = new Set(concepts.map((c) => c.id));

      if (concepts.length === 0) {
        res.status(422).json({
          error: 'Could not identify enough distinct study concepts in the selected notes. Add more detailed note content and try again.',
          code: 'INSUFFICIENT_CONCEPTS',
        });
        return;
      }

      // Sanitize & deduplicate edges (no self-loops, no duplicate or reversed duplicate pairs)
      const seenUndirectedPairs = new Set<string>();
      const edges: Array<{
        id: string;
        source: string;
        target: string;
        relationship: string;
        reason: string;
      }> = [];

      for (const rawEdge of Array.isArray(rawParsed.edges) ? rawParsed.edges : []) {
        const rawSrc = String(rawEdge?.source || '').trim();
        const rawTgt = String(rawEdge?.target || '').trim();
        const source = rawIdToCanonicalId.get(rawSrc) || rawIdToCanonicalId.get(rawSrc.toLowerCase()) || rawSrc;
        const target = rawIdToCanonicalId.get(rawTgt) || rawIdToCanonicalId.get(rawTgt.toLowerCase()) || rawTgt;

        if (!source || !target || source === target) continue;
        if (!validConceptIds.has(source) || !validConceptIds.has(target)) continue;

        const pairKey = [source, target].sort().join('::');
        if (seenUndirectedPairs.has(pairKey)) continue;
        seenUndirectedPairs.add(pairKey);

        const relationship = String(rawEdge?.relationship || 'relates to').trim().slice(0, 42);
        const reason = String(rawEdge?.reason || 'Conceptually connected in your selected notes.').trim();

        edges.push({
          id: `cedge-${source}--${target}`,
          source,
          target,
          relationship: relationship || 'relates to',
          reason,
        });
      }

      const responsePayload = {
        graphTitle: String(rawParsed.graphTitle || 'Concept Brain Graph').trim().slice(0, 100),
        summary: String(
          rawParsed.summary || `Extracted ${concepts.length} concepts and ${edges.length} connections from ${selectedNotes.length} selected note${selectedNotes.length === 1 ? '' : 's'}.`
        ).trim(),
        concepts,
        edges: edges.slice(0, 36),
        modelUsed,
      };

      if (brainGraphCache.size >= BRAIN_GRAPH_CACHE_MAX_ENTRIES) {
        const oldest = brainGraphCache.keys().next().value;
        if (oldest) brainGraphCache.delete(oldest);
      }
      brainGraphCache.set(cacheKey, {
        expiresAt: Date.now() + BRAIN_GRAPH_CACHE_TTL_MS,
        payload: responsePayload,
      });

      res.status(200).json(responsePayload);
    } catch (error) {
      handleAIError(res, error, 'Brain Graph concept extraction');
    }
  });

  // 8. Smart Note Capture (Image-to-Notes) Multimodal Vision Endpoint
  app.post('/api/ai/capture-note', async (req: Request, res: Response) => {
    try {
      const { images, generateMetadata, existingSubjects } = req.body as {
        images?: Array<{ fileName?: string; mimeType?: string; base64Data?: string }>;
        generateMetadata?: boolean;
        existingSubjects?: string[];
      };

      if (!Array.isArray(images) || images.length === 0) {
        res.status(400).json({ error: 'Upload at least one image to extract notes.' });
        return;
      }

      if (images.length > 6) {
        res.status(400).json({ error: 'You can process up to 6 images per note capture.' });
        return;
      }

      const allowedMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
      const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const normalizedMime = (img.mimeType || '').toLowerCase() === 'image/jpg'
          ? 'image/jpeg'
          : (img.mimeType || '').toLowerCase();

        if (!allowedMimeTypes.has(normalizedMime)) {
          res.status(400).json({
            error: `Unsupported image format for "${img.fileName || `image ${i + 1}`}". Please upload JPG, JPEG, PNG, or WebP files.`,
          });
          return;
        }
        if (!img.base64Data || typeof img.base64Data !== 'string' || img.base64Data.length < 20) {
          res.status(400).json({ error: `Image "${img.fileName || `image ${i + 1}`}" appears empty or corrupted.` });
          return;
        }
        if (img.base64Data.length > 8_000_000) {
          res.status(400).json({
            error: `Image "${img.fileName || `image ${i + 1}`}" is too large after encoding. Please use a smaller image.`,
          });
          return;
        }
        imageParts.push({
          inlineData: {
            mimeType: normalizedMime,
            data: img.base64Data,
          },
        });
      }

      const subjectsHint =
        Array.isArray(existingSubjects) && existingSubjects.length > 0
          ? `User's existing subjects (reuse one if it matches well, otherwise suggest a clear academic subject): ${existingSubjects.slice(0, 20).join(', ')}.`
          : '';

      const systemInstruction = `You are the MindMesh Smart Note Capture Vision Engine.
Your task is to transcribe handwritten notes, printed notes, textbook pages, slides, or whiteboard classroom notes from one or more uploaded images into clean, well-structured Markdown notes.

STRICT ACCURACY & INTEGRITY RULES:
1. Preserve the logical structure faithfully: headings (##, ###), bullet points (-), numbered lists (1., 2.), mathematical equations/formulas (readable notation or LaTeX-style expressions), tables/definitions, and fenced code blocks (\`\`\`lang ... \`\`\`).
2. When multiple images are provided, combine them in order into one cohesive note (adding subtle section headings if they represent distinct pages/sections).
3. CRITICAL — NEVER SILENTLY INVENT UNREADABLE CONTENT: If any word, formula, symbol, or handwritten line is blurry, smudged, low-contrast, cropped, or illegible, insert "[unclear]" inline at that exact spot, set hasUnclearText = true, and explain specifically which page/section was unclear in unclearWarnings.
4. If the uploaded image(s) contain NO readable notes or text (e.g., blank page, non-text photo, completely unreadable blur), set isEmptyExtraction = true, extractedMarkdown = "", and explain why in confidenceNote.
5. ${generateMetadata ? `Also generate a concise suggestedTitle (max 120 chars), a helpful 2-3 sentence suggestedSummary, an accurate suggestedSubject, and 3 to 6 relevant lowercase suggestedTags. ${subjectsHint}` : 'Leave suggestedTitle, suggestedSummary, suggestedSubject as empty strings and suggestedTags as an empty array.'}`;

      const promptText = `Extract structured study notes from the ${images.length} uploaded image(s) (${images
        .map((img, idx) => `Page ${idx + 1}: ${img.fileName || `image-${idx + 1}`}`)
        .join(', ')}). ${
        generateMetadata
          ? 'Also generate a suggested title, summary, subject, and tags.'
          : 'Focus strictly on accurate structured text extraction.'
      }`;

      const ai = getAIClient();
      const { response } = await runWithAbortAndTimeout(req, res, 60_000, (signal) =>
        generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: {
              parts: [...imageParts, { text: promptText }],
            },
            config: {
              systemInstruction,
              abortSignal: attemptSignal,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  extractedMarkdown: {
                    type: Type.STRING,
                    description: 'Clean structured Markdown transcription preserving headings, lists, equations, and code blocks.',
                  },
                  hasUnclearText: {
                    type: Type.BOOLEAN,
                    description: 'True if any handwriting, equation, or printed text was unclear, blurry, or partially illegible.',
                  },
                  unclearWarnings: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Specific warnings pinpointing which page/region had unclear text.',
                  },
                  isEmptyExtraction: {
                    type: Type.BOOLEAN,
                    description: 'True if no readable text or note content could be extracted from the uploaded image(s).',
                  },
                  confidenceNote: {
                    type: Type.STRING,
                    description: 'Brief summary of transcription clarity and readability across pages.',
                  },
                  suggestedTitle: {
                    type: Type.STRING,
                    description: 'AI-suggested note title when metadata generation is enabled.',
                  },
                  suggestedSummary: {
                    type: Type.STRING,
                    description: 'Concise 2-3 sentence summary of the extracted notes when metadata generation is enabled.',
                  },
                  suggestedSubject: {
                    type: Type.STRING,
                    description: 'AI-suggested academic subject when metadata generation is enabled.',
                  },
                  suggestedTags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Up to 6 relevant concept tags when metadata generation is enabled.',
                  },
                },
                required: [
                  'extractedMarkdown',
                  'hasUnclearText',
                  'unclearWarnings',
                  'isEmptyExtraction',
                  'confidenceNote',
                  'suggestedTitle',
                  'suggestedSummary',
                  'suggestedSubject',
                  'suggestedTags',
                ],
              },
            },
          }),
          signal,
          { mode: 'standard' }
        )
      );

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({
          error: 'AI model returned an empty response while processing your images.',
          code: 'EMPTY_AI_RESPONSE',
        });
        return;
      }
      const parsed = JSON.parse(rawText);
      res.json(parsed);
    } catch (error) {
      handleAIError(res, error, 'smart note capture');
    }
  });

  // 8b. Vision-Capable Per-Page OCR Endpoint (direct Markdown output, magic-byte validation, fallback vision failover, dev diagnostics)
  app.post('/api/ai/capture-page', async (req: Request, res: Response) => {
    const requestStartedAt = Date.now();
    let debugContext: Record<string, unknown> = {
      fileName: 'unknown',
      fileSizeBytes: 0,
      mimeType: '',
      detectedFormat: 'unknown',
      imageAttached: false,
      base64Length: 0,
      modelName: FAST_VISION_MODEL,
      thinkingLevel: ThinkingLevel.MINIMAL,
      retryMode: 'standard',
      httpStatus: 500,
      durationMs: 0,
    };

    try {
      const {
        image,
        pageNumber,
        totalPages,
        includeMetadata,
        existingSubjects,
        retryMode,
        preferredModel,
      } = req.body as {
        image?: { fileName?: string; mimeType?: string; base64Data?: string };
        pageNumber?: number;
        totalPages?: number;
        includeMetadata?: boolean;
        existingSubjects?: string[];
        retryMode?: 'standard' | 'enhanced';
        preferredModel?: 'primary' | 'secondary';
      };

      const safeFileName = image?.fileName || `page-${Number(pageNumber) || 1}`;
      const effectiveRetryMode: 'standard' | 'enhanced' =
        retryMode === 'enhanced' ? 'enhanced' : 'standard';

      debugContext.fileName = safeFileName;
      debugContext.retryMode = effectiveRetryMode;

      if (!image || !image.base64Data || typeof image.base64Data !== 'string') {
        debugContext.httpStatus = 400;
        debugContext.actualError = 'Missing base64 image payload.';
        debugContext.durationMs = Date.now() - requestStartedAt;
        logCaptureDebug(debugContext);
        res.status(400).json({
          error: 'Invalid image payload: image data was not attached to the request.',
          code: 'INVALID_IMAGE_PAYLOAD',
          debug: debugContext,
        });
        return;
      }

      // Strip accidental data-URL header if present so pure base64 is always passed to Gemini inlineData
      let cleanedBase64 = image.base64Data.trim();
      let headerMime = '';
      const dataUrlMatch = cleanedBase64.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
      if (dataUrlMatch) {
        headerMime = dataUrlMatch[1].toLowerCase();
        cleanedBase64 = dataUrlMatch[2].trim();
      }
      cleanedBase64 = cleanedBase64.replace(/\s+/g, '');

      if (cleanedBase64.length < 32) {
        debugContext.httpStatus = 400;
        debugContext.base64Length = cleanedBase64.length;
        debugContext.actualError = 'Image base64 payload too small to be a valid image.';
        debugContext.durationMs = Date.now() - requestStartedAt;
        logCaptureDebug(debugContext);
        res.status(400).json({
          error: `Invalid image payload for "${safeFileName}": encoded image is empty or truncated.`,
          code: 'INVALID_IMAGE_PAYLOAD',
          debug: debugContext,
        });
        return;
      }

      if (cleanedBase64.length > 10_000_000) {
        debugContext.httpStatus = 400;
        debugContext.base64Length = cleanedBase64.length;
        debugContext.actualError = 'Encoded image exceeds 10MB base64 limit.';
        debugContext.durationMs = Date.now() - requestStartedAt;
        logCaptureDebug(debugContext);
        res.status(400).json({
          error: `Image "${safeFileName}" is too large after encoding. Please use a smaller image.`,
          code: 'INVALID_IMAGE_PAYLOAD',
          debug: debugContext,
        });
        return;
      }

      const rawBuffer = Buffer.from(cleanedBase64, 'base64');
      const detectedFormat = detectImageFormatFromBuffer(rawBuffer);

      const allowedMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
      const declaredMime = (headerMime || image.mimeType || '').toLowerCase() === 'image/jpg'
        ? 'image/jpeg'
        : (headerMime || image.mimeType || '').toLowerCase();

      debugContext.fileSizeBytes = rawBuffer.length;
      debugContext.base64Length = cleanedBase64.length;
      debugContext.mimeType = declaredMime;
      debugContext.detectedFormat = detectedFormat || 'invalid';

      if (!allowedMimeTypes.has(declaredMime)) {
        debugContext.httpStatus = 400;
        debugContext.actualError = `Unsupported MIME type: ${declaredMime || 'none'}`;
        debugContext.durationMs = Date.now() - requestStartedAt;
        logCaptureDebug(debugContext);
        res.status(400).json({
          error: `Unsupported image format for "${safeFileName}". Upload JPG, JPEG, PNG, or WebP.`,
          code: 'INVALID_FILE_TYPE',
          debug: debugContext,
        });
        return;
      }

      if (!detectedFormat) {
        debugContext.httpStatus = 400;
        debugContext.actualError = 'Decoded image bytes do not match JPEG, PNG, or WebP magic headers.';
        debugContext.durationMs = Date.now() - requestStartedAt;
        logCaptureDebug(debugContext);
        res.status(400).json({
          error: `Invalid image payload for "${safeFileName}": file bytes are corrupted or not a valid JPEG/PNG/WebP image.`,
          code: 'INVALID_IMAGE_PAYLOAD',
          debug: debugContext,
        });
        return;
      }

      // Always pass the verified binary format MIME type to Gemini so bytes and MIME can NEVER mismatch
      const effectiveMime = detectedFormat;
      debugContext.mimeType = effectiveMime;
      debugContext.imageAttached = true;

      const safePageNum = Math.max(1, Number(pageNumber) || 1);
      const safeTotal = Math.max(safePageNum, Number(totalPages) || 1);
      const wantMetadata = Boolean(includeMetadata);

      const systemInstruction = `You are a precise handwritten and printed notes transcription engine.

Extract the actual text visible in the uploaded image. Do not describe the image. Do not summarize it. Do not add an introduction or conclusion.

Transcribe:
- Titles and headings
- Subheadings
- Definitions
- Bullet points
- Numbered lists
- Tables
- Formulas
- Examples
- Diagram labels
- Important annotations

Preserve the original order and structure using Markdown.

If a word is difficult to read, mark it [unclear]. Do not skip an entire section because some words are difficult.

Return ONLY the transcription of the actual visible content. Only if the image is completely blank with zero readable text anywhere, output exactly: [NO_READABLE_TEXT]`;

      const buildUserPrompt = (attemptNum: number, failureReason?: string): string => {
        if (attemptNum > 0) {
          return `CRITICAL CORRECTION (Retry ${attemptNum}): Your previous output failed transcription quality validation (${failureReason || 'described or summarized the image instead of transcribing text'}).
Do NOT write sentences about what the image contains, how it looks, pen colors, highlighters, or layout.
Output ONLY the exact verbatim visible text from Page ${safePageNum} of ${safeTotal} ("${safeFileName}"): titles, headings, subheadings, definitions, bullet points, numbered lists, tables, formulas, examples, diagram labels, and annotations in clean Markdown.`;
        }
        if (effectiveRetryMode === 'enhanced') {
          return `Transcribe ALL visible text from this enhanced photo of Page ${safePageNum} of ${safeTotal} ("${safeFileName}") verbatim into Markdown. Do not describe or summarize the image. Return ONLY the actual visible text.`;
        }
        return `Transcribe ALL visible text from Page ${safePageNum} of ${safeTotal} ("${safeFileName}") verbatim into Markdown. Do not describe or summarize the image. Return ONLY the actual visible text.`;
      };

      const ai = getAIClient();
      let retryCount = 0;
      let finalModelUsed = FAST_VISION_MODEL;
      let finalThinkingLevel: ThinkingLevel = ThinkingLevel.LOW;
      let finalFinishReason = 'UNKNOWN';
      let finalRawText = '';
      let finalCleanedMarkdown = '';
      let finalQuality: TranscriptionQualityCheck = {
        passed: false,
        wordCount: 0,
        charLength: 0,
      };
      let isExplicitNoText = false;

      // Attempt 0 (standard/enhanced) + up to 1 automatic server-side quality retry if output is generic/empty/suspiciously short
      for (let attempt = 0; attempt <= 1; attempt++) {
        const attemptMode: 'standard' | 'enhanced' =
          attempt === 0 ? effectiveRetryMode : 'enhanced';
        const attemptPrompt = buildUserPrompt(attempt, finalQuality.reason);

        const { response, modelUsed, thinkingLevelUsed } = await runWithAbortAndTimeout(
          req,
          res,
          attempt === 0 ? 44_000 : 38_000,
          (signal) =>
            generateCaptureWithFallback(
              ai,
              (model, thinkingLevel, attemptSignal) => ({
                model,
                contents: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: effectiveMime,
                        data: cleanedBase64,
                      },
                    },
                    { text: attemptPrompt },
                  ],
                },
                config: {
                  systemInstruction,
                  abortSignal: attemptSignal,
                  thinkingConfig: { thinkingLevel },
                },
              }),
              signal,
              { mode: attemptMode, preferredModel }
            )
        );

        finalModelUsed = modelUsed;
        finalThinkingLevel = thinkingLevelUsed;
        finalFinishReason = response.candidates?.[0]?.finishReason
          ? String(response.candidates[0].finishReason)
          : 'UNKNOWN';
        finalRawText = (response.text ?? '').trim();

        if (!finalRawText) {
          if (attempt === 0) {
            retryCount += 1;
            finalQuality = {
              passed: false,
              reason: `Empty response on attempt 1 (finishReason: ${finalFinishReason})`,
              wordCount: 0,
              charLength: 0,
            };
            continue;
          }
          break;
        }

        const strippedFence = stripOuterMarkdownFence(finalRawText);
        if (
          /^\[NO_READABLE_TEXT\]$/i.test(strippedFence) ||
          /^no readable text\b\.?$/i.test(strippedFence)
        ) {
          isExplicitNoText = true;
          finalCleanedMarkdown = '';
          finalQuality = {
            passed: false,
            reason: 'EXPLICIT_NO_TEXT',
            wordCount: 0,
            charLength: 0,
          };
          break;
        }

        finalCleanedMarkdown = cleanTranscriptionMarkdown(finalRawText);
        finalQuality = validateTranscriptionQuality(finalCleanedMarkdown, rawBuffer.length);

        if (finalQuality.passed) {
          break;
        }

        if (attempt === 0) {
          retryCount += 1;
          console.warn(
            `[MindMesh SmartCapture Quality Retry] Page ${safePageNum} ("${safeFileName}") failed validation (${finalQuality.reason}). Automatically retrying once...`
          );
        }
      }

      debugContext.modelName = finalModelUsed;
      debugContext.thinkingLevel = String(finalThinkingLevel);
      debugContext.finishReason = finalFinishReason;
      debugContext.rawResponsePreview = finalRawText.slice(0, 350);
      debugContext.extractedTextLength = finalQuality.charLength;
      debugContext.wordCount = finalQuality.wordCount;
      debugContext.qualityCheckPassed = finalQuality.passed;
      debugContext.qualityCheckReason = finalQuality.reason;
      debugContext.retryCount = retryCount;
      debugContext.responseContentType = 'application/json';
      debugContext.responseFormat = 'json';
      debugContext.durationMs = Date.now() - requestStartedAt;

      // Never silently turn an empty model response or safety refusal into "Text could not be detected"
      if (!finalRawText) {
        const isBlocked =
          finalFinishReason !== 'STOP' &&
          finalFinishReason !== 'UNKNOWN' &&
          finalFinishReason !== 'FINISH_REASON_UNSPECIFIED';
        const errCode = isBlocked ? 'MODEL_ERROR' : 'EMPTY_AI_RESPONSE';
        const errMsg = isBlocked
          ? `Model error (${finalModelUsed}): extraction stopped with finishReason "${finalFinishReason}".`
          : `Empty response from vision model (${finalModelUsed}, finishReason: ${finalFinishReason}). Please retry.`;

        debugContext.httpStatus = 502;
        debugContext.actualError = errMsg;
        logCaptureDebug(debugContext);
        res.status(502).json({
          error: errMsg,
          code: errCode,
          debug: debugContext,
        });
        return;
      }

      if (isExplicitNoText) {
        debugContext.httpStatus = 200;
        logCaptureDebug(debugContext);
        res.json({
          extractedMarkdown: '',
          hasUnclearText: false,
          unclearWarnings: [],
          isEmptyExtraction: true,
          wordCount: 0,
          qualityCheckPassed: false,
          qualityCheckReason: 'EXPLICIT_NO_TEXT',
          retryCount,
          confidenceNote: `Vision model (${finalModelUsed}) inspected "${safeFileName}" and reported no readable text.`,
          modelUsed: finalModelUsed,
          debug: debugContext,
        });
        return;
      }

      // Do NOT mark a page as Completed if quality validation failed even after automatic retry!
      if (!finalQuality.passed) {
        const qualityErrMsg = finalQuality.reason?.startsWith('GENERIC_IMAGE_DESCRIPTION')
          ? 'The AI described the image instead of transcribing the visible notes. Click Retry to transcribe the actual text.'
          : finalQuality.reason?.startsWith('EMPTY_OR_DIVIDERS_ONLY')
            ? 'Extraction returned empty or divider-only formatting instead of readable notes. Click Retry.'
            : `Extraction returned suspiciously little text (${finalQuality.wordCount} word${finalQuality.wordCount === 1 ? '' : 's'}). Click Retry or upload a clearer photo.`;

        debugContext.httpStatus = 422;
        debugContext.actualError = finalQuality.reason || qualityErrMsg;
        logCaptureDebug(debugContext);
        res.status(422).json({
          error: qualityErrMsg,
          code: 'QUALITY_VALIDATION_FAILED',
          debug: debugContext,
        });
        return;
      }

      const unclearMatches = finalCleanedMarkdown.match(/\[unclear\]/gi) || [];
      const hasUnclearText = unclearMatches.length > 0;
      const unclearWarnings = hasUnclearText
        ? [
            `Page ${safePageNum} contains ${unclearMatches.length} word${unclearMatches.length === 1 ? '' : 's'} marked [unclear] — verify against the photo.`,
          ]
        : [];

      const payload: Record<string, unknown> = {
        extractedMarkdown: finalCleanedMarkdown,
        hasUnclearText,
        unclearWarnings,
        isEmptyExtraction: false,
        wordCount: finalQuality.wordCount,
        qualityCheckPassed: true,
        retryCount,
        confidenceNote: hasUnclearText
          ? `Transcribed ${finalQuality.wordCount} words with ${finalModelUsed}; ${unclearMatches.length} unclear spot(s) flagged.`
          : `Transcribed ${finalQuality.wordCount} words cleanly with ${finalModelUsed}.`,
        modelUsed: finalModelUsed,
        debug: { ...debugContext, httpStatus: 200 },
      };

      // Optional single-page metadata synthesis (never fails the OCR extraction if metadata hiccups)
      if (wantMetadata && finalCleanedMarkdown.length > 10) {
        try {
          const subjectsHint =
            Array.isArray(existingSubjects) && existingSubjects.length > 0
              ? `Existing user subjects (prefer reusing an exact match if appropriate): ${existingSubjects.slice(0, 20).join(', ')}.`
              : '';
          const metaExcerpt = finalCleanedMarkdown.slice(0, 4500);
          const metaResult = await runWithAbortAndTimeout(req, res, 22_000, (signal) =>
            generateCaptureWithFallback(
              ai,
              (model, thinkingLevel, attemptSignal) => ({
                model,
                contents: `Generate a concise title, 2-sentence summary, academic subject, and 3-6 lowercase concept tags for these extracted study notes:\n\n${metaExcerpt}`,
                config: {
                  systemInstruction: `You are the MindMesh Note Metadata Assistant. Return accurate, concise metadata strictly grounded in the extracted notes. ${subjectsHint}`,
                  abortSignal: attemptSignal,
                  thinkingConfig: { thinkingLevel },
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      suggestedTitle: { type: Type.STRING },
                      suggestedSummary: { type: Type.STRING },
                      suggestedSubject: { type: Type.STRING },
                      suggestedTags: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['suggestedTitle', 'suggestedSummary', 'suggestedSubject', 'suggestedTags'],
                  },
                },
              }),
              signal,
              { mode: 'metadata' }
            )
          );
          const metaRaw = (metaResult.response.text ?? '').trim();
          if (metaRaw) {
            const parsedMeta = JSON.parse(stripOuterMarkdownFence(metaRaw));
            payload.suggestedTitle = parsedMeta.suggestedTitle;
            payload.suggestedSummary = parsedMeta.suggestedSummary;
            payload.suggestedSubject = parsedMeta.suggestedSubject;
            payload.suggestedTags = parsedMeta.suggestedTags;
          }
        } catch (metaErr) {
          console.warn('[MindMesh Capture] Non-fatal single-page metadata synthesis skipped:', metaErr instanceof Error ? metaErr.message : String(metaErr));
        }
      }

      debugContext.httpStatus = 200;
      debugContext.durationMs = Date.now() - requestStartedAt;
      payload.debug = debugContext;
      logCaptureDebug(debugContext);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json(payload);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      debugContext.actualError = rawMessage;
      debugContext.durationMs = Date.now() - requestStartedAt;
      debugContext.httpStatus = rawMessage.includes('REQUEST_TIMEOUT')
        ? 504
        : rawMessage.includes('429') || rawMessage.includes('RESOURCE_EXHAUSTED')
          ? 429
          : rawMessage.includes('503') || rawMessage.includes('UNAVAILABLE')
            ? 503
            : 500;
      logCaptureDebug(debugContext);

      if (rawMessage.includes('CLIENT_ABORTED') || res.writableEnded) {
        if (!res.writableEnded) {
          res.status(499).json({ error: 'Request cancelled by client.', code: 'CANCELLED', debug: debugContext });
        }
        return;
      }
      if (rawMessage.includes('REQUEST_TIMEOUT') || rawMessage.includes('ETIMEDOUT') || rawMessage.includes('timeout')) {
        res.status(504).json({
          error: 'AI service timeout: this page took too long to process. Please retry.',
          code: 'TIMEOUT',
          debug: debugContext,
        });
        return;
      }
      if (rawMessage.includes('PERMISSION_DENIED') || rawMessage.includes('API_KEY_INVALID') || rawMessage.includes('GEMINI_API_KEY')) {
        res.status(403).json({
          error: 'API error: Gemini API key is missing or invalid. Check Settings > Secrets.',
          code: 'API_KEY_ERROR',
          debug: debugContext,
        });
        return;
      }
      if (rawMessage.includes('RESOURCE_EXHAUSTED') || rawMessage.includes('429')) {
        res.status(429).json({
          error: 'API rate limit reached. Wait a few seconds and retry this page.',
          code: 'RATE_LIMITED',
          debug: debugContext,
        });
        return;
      }
      if (rawMessage.includes('UNAVAILABLE') || rawMessage.includes('503') || rawMessage.includes('high demand')) {
        res.status(503).json({
          error: 'Model temporarily unavailable due to high demand. Wait a moment and retry this page.',
          code: 'MODEL_ERROR',
          debug: debugContext,
        });
        return;
      }
      res.status(500).json({
        error: `Model error during page text extraction: ${rawMessage.slice(0, 220)}`,
        code: 'MODEL_ERROR',
        debug: debugContext,
      });
    }
  });

  // 8c. Fast Text-Only Metadata Synthesis for Multi-Page Captured Notes
  app.post('/api/ai/capture-metadata', async (req: Request, res: Response) => {
    try {
      const { combinedMarkdown, existingSubjects } = req.body as {
        combinedMarkdown?: string;
        existingSubjects?: string[];
      };

      if (!combinedMarkdown || typeof combinedMarkdown !== 'string' || !combinedMarkdown.trim()) {
        res.status(400).json({ error: 'Extracted note content is required to generate metadata.' });
        return;
      }

      const subjectsHint =
        Array.isArray(existingSubjects) && existingSubjects.length > 0
          ? `Existing user subjects (prefer reusing an exact match if appropriate): ${existingSubjects.slice(0, 20).join(', ')}.`
          : '';

      // Build a concise representative excerpt (all headings + first 4,500 chars) so metadata synthesis stays fast and never times out
      const headings = combinedMarkdown
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^#{1,3}\s+/.test(line))
        .slice(0, 20)
        .join('\n');
      const excerpt = combinedMarkdown.slice(0, 4500);
      const metadataInput = headings
        ? `Section Headings:\n${headings}\n\nNote Excerpt:\n${excerpt}`
        : excerpt;

      const ai = getAIClient();
      const { response } = await runWithAbortAndTimeout(req, res, 30_000, (signal) =>
        generateCaptureWithFallback(
          ai,
          (model, thinkingLevel, attemptSignal) => ({
            model,
            contents: `Generate a concise title, 2-sentence summary, academic subject, and 3-6 lowercase concept tags for these extracted study notes:\n\n${metadataInput}`,
            config: {
              systemInstruction: `You are the MindMesh Note Metadata Assistant. Return accurate, concise metadata strictly grounded in the extracted notes. ${subjectsHint}`,
              abortSignal: attemptSignal,
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  suggestedTitle: { type: Type.STRING, description: 'Concise title (max 120 chars).' },
                  suggestedSummary: { type: Type.STRING, description: '2-3 sentence summary of the notes.' },
                  suggestedSubject: { type: Type.STRING, description: 'Academic subject name.' },
                  suggestedTags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: '3 to 6 relevant lowercase concept tags.',
                  },
                },
                required: ['suggestedTitle', 'suggestedSummary', 'suggestedSubject', 'suggestedTags'],
              },
            },
          }),
          signal,
          { mode: 'metadata' }
        )
      );

      const rawMeta = (response.text ?? '').trim();
      if (!rawMeta) {
        res.status(502).json({ error: 'AI model returned an empty metadata response.', code: 'EMPTY_AI_RESPONSE' });
        return;
      }
      const parsed = JSON.parse(stripOuterMarkdownFence(rawMeta));
      res.json(parsed);
    } catch (error) {
      handleAIError(res, error, 'note metadata synthesis');
    }
  });

  // Ensure /api/* routes NEVER fall through to Vite SPA HTML (HTTP 200 text/html) or default HTML error pages
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({
      error: 'API endpoint not found.',
      code: 'API_NOT_FOUND',
    });
  });

  app.use((err: unknown, req: Request, res: Response, next: express.NextFunction) => {
    if (!req.path.startsWith('/api')) {
      next(err);
      return;
    }
    const errObj = err as { status?: number; type?: string; message?: string };
    const status = errObj?.status || (errObj?.type === 'entity.too.large' ? 413 : 400);
    const message =
      errObj?.type === 'entity.too.large'
        ? 'Uploaded image payload exceeded the server request size limit. Try a smaller photo.'
        : errObj?.message || 'Unexpected API server error.';
    if (!res.headersSent) {
      res.status(status).json({
        error: message,
        code: status === 413 ? 'INVALID_IMAGE_PAYLOAD' : 'API_ERROR',
      });
    }
  });

  // Frontend Vite Dev Middleware or Production Static Files
  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MindMesh server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start MindMesh server:', err);
  process.exit(1);
});
