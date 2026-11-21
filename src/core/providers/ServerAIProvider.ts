import { AIServiceException } from '../exceptions/MindMeshExceptions';
import type {
  AIProvider,
  AINoteContext,
  StudyAssistantResponse,
  GeneratedMindMapPayload,
  GeneratedQuizQuestionPayload,
  QuizEvaluationResult,
  MemoryRevivalReason,
  ConnectionExplanationPayload,
  CaptureImageInput,
  CaptureResponseFormat,
  ExtractionDebugInfo,
  SmartNoteCapturePayload,
  PageExtractionResult,
  CaptureMetadataPayload,
  GeneratedConceptGraphPayload,
  ConceptConnectionExplanationPayload,
  StudyAssistantRetryNotice,
} from '../interfaces/CoreInterfaces';

export interface ParseCaptureResponseInput {
  status: number;
  ok: boolean;
  contentType: string;
  rawText: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  base64Length: number;
  durationMs: number;
  abortedByClient?: boolean;
}

function isHtmlPayload(contentType: string, rawText: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
  return /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(rawText);
}

function parseRetryAfterHeader(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 0) {
    return Math.min(60, Math.max(1, Math.ceil(asNum)));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    if (diffSec > 0) return Math.min(60, diffSec);
  }
  return undefined;
}

function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AIServiceException('Request cancelled.', 499, 'CANCELLED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIServiceException('Request cancelled.', 499, 'CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toFriendlyErrorMessage(
  status: number,
  serverCode?: string,
  serverMessage?: string,
  isQuotaExhausted?: boolean
): string {
  if (serverCode === 'QUOTA_EXHAUSTED' || isQuotaExhausted) {
    return 'Your API quota has been exhausted. Please wait for your quota to reset or check your API key plan before trying again.';
  }
  if (status === 429 || serverCode === 'RATE_LIMITED') {
    return 'AI is temporarily busy. Please wait a moment and try again.';
  }
  if (status === 504 || serverCode === 'TIMEOUT') {
    return 'The request timed out. Please try again.';
  }
  if (status === 500 || status === 502 || status === 503 || serverCode === 'AI_UNAVAILABLE') {
    return 'The AI service is temporarily unavailable. Please try again in a moment.';
  }
  if (
    serverCode === 'PARSING_ERROR' ||
    serverCode === 'NON_JSON_HTML_RESPONSE' ||
    serverCode === 'EMPTY_AI_RESPONSE'
  ) {
    return 'We received an incomplete response from the AI service. Please try again.';
  }
  if (
    status === 403 ||
    serverCode === 'API_KEY_ERROR' ||
    serverCode === 'API_KEY_INVALID' ||
    serverCode === 'PERMISSION_DENIED' ||
    serverCode === 'MISSING_API_KEY'
  ) {
    const cleanedServerMsg = (serverMessage || '').trim();
    if (
      cleanedServerMsg &&
      cleanedServerMsg.length <= 260 &&
      !/<!doctype|<html|\bstack\b|\btrace\b|^\s*[\[{]/i.test(cleanedServerMsg)
    ) {
      return cleanedServerMsg;
    }
    return 'The backend AI service could not authenticate with Gemini. Check the server GEMINI_API_KEY environment variable.';
  }
  // Never expose raw HTML, stack traces, or technical JSON strings to the user
  const cleaned = (serverMessage || '').trim();
  if (
    cleaned &&
    cleaned.length <= 220 &&
    !/<!doctype|<html|\bstack\b|\btrace\b|\bTypeError\b|\bSyntaxError\b|^\s*[\[{]/i.test(cleaned)
  ) {
    return cleaned;
  }
  return 'The AI request could not be completed right now. Please try again.';
}

function tryParseJsonOrFenced(rawText: string): {
  parsed: Record<string, unknown> | null;
  format: 'json' | 'fenced-json' | null;
} {
  const trimmed = rawText.trim();
  if (!trimmed) return { parsed: null, format: null };

  // 1) Direct JSON object
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return { parsed: obj as Record<string, unknown>, format: 'json' };
      }
    } catch {
      // Fall through to fenced JSON check
    }
  }

  // 2) JSON wrapped in Markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return { parsed: obj as Record<string, unknown>, format: 'fenced-json' };
      }
    } catch {
      // Not valid fenced JSON — treat as Markdown/plain text
    }
  }

  return { parsed: null, format: null };
}

function extractTextFromAlternateJson(obj: Record<string, unknown>): string {
  const directKeys = ['extractedMarkdown', 'markdown', 'transcription', 'text', 'content', 'output_text'];
  for (const key of directKeys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }

  // Gemini REST/SDK raw candidate structure
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const firstCandidate = obj.candidates[0] as Record<string, unknown> | undefined;
    const contentObj = firstCandidate?.content as Record<string, unknown> | undefined;
    if (Array.isArray(contentObj?.parts)) {
      const joined = contentObj.parts
        .map((p) => (p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string'
          ? String((p as Record<string, unknown>).text)
          : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (joined) return joined;
    }
  }

  // OpenAI-compatible structure
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const firstChoice = obj.choices[0] as Record<string, unknown> | undefined;
    const msg = firstChoice?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === 'string' && msg.content.trim()) {
      return msg.content.trim();
    }
    if (typeof firstChoice?.text === 'string' && firstChoice.text.trim()) {
      return firstChoice.text.trim();
    }
  }

  return '';
}

/**
 * Multi-format response parser for /api/ai/capture-page.
 * Handles JSON, fenced JSON, alternate AI JSON structures, Markdown, and plain text.
 * NEVER fails an HTTP 200 response containing valid transcribed text just because it is not JSON.
 */
export function parseCapturePageResponse(input: ParseCaptureResponseInput): PageExtractionResult {
  const contentType = (input.contentType || '').trim();
  const rawText = input.rawText || '';
  const trimmed = rawText.trim();
  const baseDebug: ExtractionDebugInfo = {
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes,
    mimeType: input.mimeType,
    imageAttached: true,
    base64Length: input.base64Length,
    modelName: 'vision-server',
    httpStatus: input.status,
    responseContentType: contentType || 'unknown',
    rawResponsePreview: trimmed.slice(0, 300),
    durationMs: input.durationMs,
  };

  // 1) Guard against HTML error pages / SPA index.html fallback
  if (isHtmlPayload(contentType, trimmed)) {
    throw new AIServiceException(
      `Server returned HTML instead of extracted notes (HTTP ${input.status}).`,
      input.ok ? 502 : input.status,
      'PARSING_ERROR',
      {
        ...baseDebug,
        responseFormat: 'html-error' as CaptureResponseFormat,
        extractedTextLength: 0,
        actualError: `HTML payload received (${contentType || 'text/html'})`,
      }
    );
  }

  // 2) Guard against completely empty body
  if (!trimmed) {
    throw new AIServiceException(
      `Empty response received from extraction server (HTTP ${input.status}).`,
      input.ok ? 502 : input.status,
      'EMPTY_AI_RESPONSE',
      {
        ...baseDebug,
        responseFormat: 'empty' as CaptureResponseFormat,
        extractedTextLength: 0,
        actualError: 'Empty HTTP response body',
      }
    );
  }

  // 3) Try JSON or Markdown-fenced JSON
  const { parsed, format: jsonFormat } = tryParseJsonOrFenced(trimmed);
  if (parsed && jsonFormat) {
    const serverDebug =
      parsed.debug && typeof parsed.debug === 'object'
        ? (parsed.debug as Partial<ExtractionDebugInfo>)
        : {};

    if (!input.ok) {
      const safeStatus = input.status === 499 && !input.abortedByClient ? 502 : input.status;
      const errMessage =
        typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : `API request failed (HTTP ${input.status}).`;
      const serverCode =
        typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code.trim() : 'API_ERROR';

      throw new AIServiceException(errMessage, safeStatus, serverCode, {
        ...baseDebug,
        ...serverDebug,
        httpStatus: input.status,
        responseContentType: contentType || serverDebug.responseContentType || 'application/json',
        responseFormat: jsonFormat,
        rawResponsePreview: serverDebug.rawResponsePreview || trimmed.slice(0, 300),
      });
    }

    const extractedMarkdown = extractTextFromAlternateJson(parsed);
    const hasUnclearText =
      typeof parsed.hasUnclearText === 'boolean'
        ? parsed.hasUnclearText || /\[unclear\]/i.test(extractedMarkdown)
        : /\[unclear\]/i.test(extractedMarkdown);
    const unclearWarnings = Array.isArray(parsed.unclearWarnings)
      ? parsed.unclearWarnings.map((w) => String(w)).filter(Boolean)
      : hasUnclearText
        ? ['Some words were marked [unclear] during transcription.']
        : [];
    const isEmptyExtraction =
      extractedMarkdown.length === 0 ? true : Boolean(parsed.isEmptyExtraction) && extractedMarkdown.length === 0;

    const mergedDebug: ExtractionDebugInfo = {
      ...baseDebug,
      ...serverDebug,
      httpStatus: input.status,
      responseContentType: contentType || serverDebug.responseContentType || 'application/json',
      responseFormat: jsonFormat,
      extractedTextLength: extractedMarkdown.length,
      wordCount: typeof parsed.wordCount === 'number' ? parsed.wordCount : serverDebug.wordCount,
      qualityCheckPassed:
        typeof parsed.qualityCheckPassed === 'boolean'
          ? parsed.qualityCheckPassed
          : serverDebug.qualityCheckPassed,
      qualityCheckReason:
        typeof parsed.qualityCheckReason === 'string'
          ? parsed.qualityCheckReason
          : serverDebug.qualityCheckReason,
      retryCount:
        typeof parsed.retryCount === 'number' ? parsed.retryCount : serverDebug.retryCount ?? 0,
      rawResponsePreview: serverDebug.rawResponsePreview || extractedMarkdown.slice(0, 300),
    };

    return {
      extractedMarkdown,
      hasUnclearText,
      unclearWarnings,
      isEmptyExtraction,
      confidenceNote:
        typeof parsed.confidenceNote === 'string'
          ? parsed.confidenceNote
          : extractedMarkdown
            ? 'Transcribed from image.'
            : 'No readable text detected.',
      wordCount: typeof parsed.wordCount === 'number' ? parsed.wordCount : undefined,
      qualityCheckPassed:
        typeof parsed.qualityCheckPassed === 'boolean' ? parsed.qualityCheckPassed : undefined,
      qualityCheckReason:
        typeof parsed.qualityCheckReason === 'string' ? parsed.qualityCheckReason : undefined,
      retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : 0,
      modelUsed:
        typeof parsed.modelUsed === 'string'
          ? parsed.modelUsed
          : mergedDebug.modelName || 'vision-server',
      debug: mergedDebug,
      suggestedTitle: typeof parsed.suggestedTitle === 'string' ? parsed.suggestedTitle : undefined,
      suggestedSummary:
        typeof parsed.suggestedSummary === 'string' ? parsed.suggestedSummary : undefined,
      suggestedSubject:
        typeof parsed.suggestedSubject === 'string' ? parsed.suggestedSubject : undefined,
      suggestedTags: Array.isArray(parsed.suggestedTags)
        ? parsed.suggestedTags.map((t) => String(t))
        : undefined,
    };
  }

  // 4) Non-JSON response: if HTTP error, preserve raw response instead of throwing blind JSON error
  if (!input.ok) {
    const safeStatus = input.status === 499 && !input.abortedByClient ? 502 : input.status;
    throw new AIServiceException(
      `API request failed (HTTP ${input.status}): ${trimmed.slice(0, 220)}`,
      safeStatus,
      'API_ERROR',
      {
        ...baseDebug,
        responseFormat: 'plain-text' as CaptureResponseFormat,
        extractedTextLength: 0,
        actualError: trimmed.slice(0, 300),
      }
    );
  }

  // 5) HTTP 2xx with plain text or Markdown — accept directly as transcribed content!
  const looksLikeMarkdown =
    contentType.toLowerCase().includes('markdown') ||
    /(^|\n)(#{1,4}\s|[-*•]\s|\d+\.\s|\|.*\|)/m.test(trimmed);
  const responseFormat: CaptureResponseFormat = looksLikeMarkdown ? 'markdown' : 'plain-text';
  const hasUnclearText = /\[unclear\]/i.test(trimmed);

  return {
    extractedMarkdown: trimmed,
    hasUnclearText,
    unclearWarnings: hasUnclearText
      ? ['Some words were marked [unclear] during transcription.']
      : [],
    isEmptyExtraction: false,
    confidenceNote: `Transcribed directly from ${responseFormat} response.`,
    retryCount: 0,
    modelUsed: 'vision-server',
    debug: {
      ...baseDebug,
      responseContentType: contentType || 'text/plain',
      responseFormat,
      extractedTextLength: trimmed.length,
      retryCount: 0,
      rawResponsePreview: trimmed.slice(0, 300),
    },
  };
}

/**
 * OOP CONCEPT: Abstraction & Polymorphism
 * ServerAIProvider implements the AIProvider interface by communicating exclusively
 * with the Node.js/Express backend (/api/ai/*), keeping Gemini credentials server-side.
 */
export class ServerAIProvider implements AIProvider {
  private resolveEndpoint(endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) return endpoint;
    const rawBase =
      typeof import.meta !== 'undefined' &&
      import.meta.env &&
      typeof import.meta.env.VITE_API_BASE_URL === 'string'
        ? import.meta.env.VITE_API_BASE_URL.trim().replace(/\/+$/, '')
        : '';
    if (!rawBase) return endpoint;
    return `${rawBase}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  }

  private async fetchWithTimeout(
    endpoint: string,
    body: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;

    const externalSignal = options?.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw new AIServiceException('Request cancelled.', 499);
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutMs = options?.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(this.resolveEndpoint(endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/markdown, text/plain',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (externalSignal?.aborted) {
        throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
      }
      if (timedOut) {
        throw new AIServiceException(
          'AI service timeout — this request took too long to process.',
          504,
          'TIMEOUT'
        );
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
      }
      throw new AIServiceException(
        'Network error — unable to reach the server. Check your internet connection.',
        0,
        'NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async postJSON<TResponse>(
    endpoint: string,
    body: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<TResponse> {
    const response = await this.fetchWithTimeout(endpoint, body, options);
    const contentType = (response.headers.get('content-type') || '').trim();

    let rawText = '';
    try {
      rawText = await response.text();
    } catch {
      throw new AIServiceException(
        'Network error while reading the server response. Please try again.',
        503,
        'NETWORK_ERROR'
      );
    }

    // Explicitly guard against HTML responses (e.g. proxy/SPA fallback) before attempting JSON parse
    if (isHtmlPayload(contentType, rawText)) {
      console.error(`[ServerAIProvider] Unexpected HTML response from ${endpoint}`, {
        status: response.status,
        contentType,
        preview: rawText.slice(0, 200),
      });
      throw new AIServiceException(
        'The AI service returned an unexpected page instead of data. Please retry in a moment.',
        response.ok ? 502 : response.status,
        'NON_JSON_HTML_RESPONSE',
        {
          httpStatus: response.status,
          responseContentType: contentType || 'text/html',
        }
      );
    }

    const isDeclaredJson = contentType.toLowerCase().includes('application/json') || contentType.toLowerCase().includes('+json');
    const { parsed } = tryParseJsonOrFenced(rawText);
    const data = parsed as
      | ({
          error?: string;
          code?: string;
          debug?: Record<string, unknown>;
          retryAfterSeconds?: number;
          isQuotaExhausted?: boolean;
        } & TResponse)
      | null;

    if (!isDeclaredJson && !data) {
      console.error(`[ServerAIProvider] Non-JSON response from ${endpoint}`, {
        status: response.status,
        contentType,
        preview: rawText.slice(0, 200),
      });
      throw new AIServiceException(
        'We received an incomplete response from the AI service. Please try again.',
        response.ok ? 502 : response.status,
        'PARSING_ERROR',
        {
          httpStatus: response.status,
          responseContentType: contentType || 'unknown',
        }
      );
    }

    if (rawText.trim() && !data) {
      console.error(`[ServerAIProvider] Malformed JSON response from ${endpoint}`, {
        status: response.status,
        contentType,
        preview: rawText.slice(0, 200),
      });
      throw new AIServiceException(
        'We received an incomplete response from the AI service. Please try again.',
        response.ok ? 502 : response.status,
        'PARSING_ERROR',
        {
          httpStatus: response.status,
          responseContentType: contentType || 'unknown',
        }
      );
    }

    if (!response.ok) {
      // Never misclassify an unexpected server 499 as a local client cancellation
      const safeStatus = response.status === 499 && !options?.signal?.aborted ? 502 : response.status;
      const headerRetryAfter = parseRetryAfterHeader(response.headers.get('retry-after'));
      const bodyRetryAfter =
        typeof data?.retryAfterSeconds === 'number' && Number.isFinite(data.retryAfterSeconds) && data.retryAfterSeconds > 0
          ? Math.min(60, Math.ceil(data.retryAfterSeconds))
          : undefined;
      const retryAfterSeconds = headerRetryAfter ?? bodyRetryAfter;
      const serverCode = data?.code || (safeStatus === 429 ? 'RATE_LIMITED' : 'API_ERROR');
      const isQuotaExhausted = Boolean(data?.isQuotaExhausted || serverCode === 'QUOTA_EXHAUSTED');

      throw new AIServiceException(
        toFriendlyErrorMessage(safeStatus, serverCode, data?.error, isQuotaExhausted),
        safeStatus,
        serverCode,
        data?.debug,
        { retryAfterSeconds, isQuotaExhausted }
      );
    }

    if (!data) {
      throw new AIServiceException(
        'We received an empty response from the AI service. Please try again.',
        502,
        'EMPTY_AI_RESPONSE',
        { httpStatus: response.status, responseContentType: contentType }
      );
    }

    return data;
  }

  public async generateEmbedding(text: string): Promise<number[]> {
    const data = await this.postJSON<{ embedding: number[] }>('/api/ai/embed', { text });
    return Array.isArray(data.embedding) ? data.embedding : [];
  }

  public async askStudyAssistant(
    params: {
      question: string;
      notes: AINoteContext[];
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      mode?: 'ask' | 'simplify' | 'summarize' | 'examples';
    },
    options?: {
      signal?: AbortSignal;
      onRetry?: (notice: StudyAssistantRetryNotice) => void;
    }
  ): Promise<StudyAssistantResponse> {
    // Cap temporary retries at max 2 with exponential backoff (2s, 4s) to protect free-tier quota
    const backoffSeconds = [2, 4];
    const maxRetries = backoffSeconds.length;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (options?.signal?.aborted) {
        throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
      }

      try {
        const result = await this.postJSON<StudyAssistantResponse>('/api/ai/study-assistant', params, {
          signal: options?.signal,
          timeoutMs: 44_000,
        });

        if (!result || typeof result.answer !== 'string' || !result.answer.trim()) {
          throw new AIServiceException(
            'We received an incomplete response from the AI service. Please try again.',
            502,
            'EMPTY_AI_RESPONSE'
          );
        }

        return {
          answer: result.answer.trim(),
          citedNoteIds: Array.isArray(result.citedNoteIds) ? result.citedNoteIds : [],
          insufficientContext: Boolean(result.insufficientContext),
          suggestedFollowUps: Array.isArray(result.suggestedFollowUps) ? result.suggestedFollowUps : [],
          cached: Boolean(result.cached),
        };
      } catch (err) {
        if (options?.signal?.aborted) {
          throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
        }

        const aiErr = err instanceof AIServiceException ? err : null;
        const status = aiErr?.statusCode ?? 500;
        const isQuota = Boolean(aiErr?.isQuotaExhausted || aiErr?.serverCode === 'QUOTA_EXHAUSTED');
        const isCancelled = status === 499 || aiErr?.serverCode === 'CANCELLED';
        const isRateLimit = status === 429 && !isQuota;
        const isTransientServer = status === 502 || status === 503;

        // Never retry cancellations, quota exhaustion, client validation errors, or auth errors
        const shouldRetry = !isCancelled && !isQuota && (isRateLimit || isTransientServer) && attempt < maxRetries;
        if (!shouldRetry) {
          throw err;
        }

        // Respect server Retry-After header when present, otherwise use exponential backoff (2s, 4s, 8s)
        const baseBackoffSec = backoffSeconds[attempt];
        const delaySeconds = aiErr?.retryAfterSeconds
          ? Math.min(20, Math.max(baseBackoffSec, aiErr.retryAfterSeconds))
          : baseBackoffSec;

        options?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries,
          delaySeconds,
          reason: isRateLimit ? 'rate_limit' : 'server_busy',
        });

        await abortableWait(delaySeconds * 1000, options?.signal);
      }
    }

    throw new AIServiceException(
      'AI is temporarily busy. Please wait a moment and try again.',
      429,
      'RATE_LIMITED',
      undefined,
      { retryAfterSeconds: 8 }
    );
  }

  public async generateMindMap(
    params: {
      notes: AINoteContext[];
      customTitle?: string;
    },
    options?: {
      signal?: AbortSignal;
      onRetry?: (notice: StudyAssistantRetryNotice) => void;
    }
  ): Promise<GeneratedMindMapPayload> {
    const maxRetries = 2;
    const backoffSeconds = [2, 4];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (options?.signal?.aborted) {
        throw new AIServiceException('Mind map generation cancelled.', 499, 'CANCELLED');
      }

      try {
        const result = await this.postJSON<GeneratedMindMapPayload>(
          '/api/ai/mindmap',
          params,
          { signal: options?.signal, timeoutMs: 44_000 }
        );

        if (
          !result ||
          !Array.isArray(result.nodes) ||
          result.nodes.length < 2 ||
          !result.nodes.every((n) => n && typeof n.id === 'string' && typeof n.title === 'string')
        ) {
          throw new AIServiceException(
            'The AI returned an incomplete or invalid mind map structure.',
            502,
            'INVALID_RESPONSE'
          );
        }

        return {
          title: typeof result.title === 'string' ? result.title.trim() : '',
          nodes: result.nodes,
          connections: Array.isArray(result.connections) ? result.connections : [],
          cached: Boolean(result.cached),
        };
      } catch (error) {
        const aiErr =
          error instanceof AIServiceException
            ? error
            : new AIServiceException(
                'Network connection error while contacting the AI service.',
                0,
                'NETWORK_ERROR',
                error instanceof Error ? { cause: error.message } : undefined
              );

        // NEVER retry user cancellation, invalid requests, auth errors, or exhausted API quota
        if (
          aiErr.statusCode === 499 ||
          aiErr.serverCode === 'CANCELLED' ||
          aiErr.isQuotaExhausted ||
          aiErr.serverCode === 'QUOTA_EXHAUSTED' ||
          aiErr.statusCode === 400 ||
          aiErr.statusCode === 401 ||
          aiErr.statusCode === 403
        ) {
          throw aiErr;
        }

        const isRateLimit = aiErr.statusCode === 429 || aiErr.serverCode === 'RATE_LIMITED';
        const isTransientOverload =
          aiErr.statusCode === 502 ||
          aiErr.statusCode === 503 ||
          aiErr.serverCode === 'AI_UNAVAILABLE';

        if ((!isRateLimit && !isTransientOverload) || attempt >= maxRetries) {
          throw aiErr;
        }

        const baseBackoffSec = backoffSeconds[attempt] ?? 4;
        const delaySeconds = aiErr.retryAfterSeconds
          ? Math.min(15, Math.max(baseBackoffSec, aiErr.retryAfterSeconds))
          : baseBackoffSec;

        options?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries,
          delaySeconds,
          reason: isRateLimit ? 'rate_limit' : 'server_busy',
        });

        await abortableWait(delaySeconds * 1000, options?.signal);
      }
    }

    throw new AIServiceException(
      'AI is temporarily busy. Please wait a moment and try again.',
      429,
      'RATE_LIMITED',
      undefined,
      { retryAfterSeconds: 8 }
    );
  }

  public async generateQuiz(
    params: {
      notes: AINoteContext[];
      subject?: string;
      difficulty: 'easy' | 'medium' | 'hard';
      questionCount: number;
      weakTopics?: string[];
      bypassCache?: boolean;
    },
    options?: {
      signal?: AbortSignal;
      onRetry?: (notice: StudyAssistantRetryNotice) => void;
    }
  ): Promise<{ questions: GeneratedQuizQuestionPayload[]; cached?: boolean }> {
    const maxRetries = 1;
    const backoffSeconds = [2];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (options?.signal?.aborted) {
        throw new AIServiceException('Quiz generation cancelled.', 499, 'CANCELLED');
      }

      try {
        const result = await this.postJSON<{
          questions?: GeneratedQuizQuestionPayload[];
          cached?: boolean;
        }>('/api/ai/quiz/generate', params, {
          signal: options?.signal,
          timeoutMs: 36_000,
        });

        if (!result || !Array.isArray(result.questions) || result.questions.length === 0) {
          throw new AIServiceException(
            'The AI did not return any valid quiz questions.',
            502,
            'INVALID_RESPONSE'
          );
        }

        return {
          questions: result.questions,
          cached: Boolean(result.cached),
        };
      } catch (error) {
        if (options?.signal?.aborted) {
          throw new AIServiceException('Quiz generation cancelled.', 499, 'CANCELLED');
        }

        const aiErr =
          error instanceof AIServiceException
            ? error
            : new AIServiceException(
                'Network connection error while contacting the AI service.',
                0,
                'NETWORK_ERROR',
                error instanceof Error ? { cause: error.message } : undefined
              );

        // NEVER retry user cancellation, quota exhaustion, invalid requests, auth errors, or timeouts
        if (
          aiErr.statusCode === 499 ||
          aiErr.serverCode === 'CANCELLED' ||
          aiErr.isQuotaExhausted ||
          aiErr.serverCode === 'QUOTA_EXHAUSTED' ||
          aiErr.statusCode === 504 ||
          aiErr.serverCode === 'TIMEOUT' ||
          aiErr.statusCode === 400 ||
          aiErr.statusCode === 401 ||
          aiErr.statusCode === 403
        ) {
          throw aiErr;
        }

        const isRateLimit = aiErr.statusCode === 429 || aiErr.serverCode === 'RATE_LIMITED';
        const isTransientOverload =
          aiErr.statusCode === 502 ||
          aiErr.statusCode === 503 ||
          aiErr.serverCode === 'AI_UNAVAILABLE';

        if ((!isRateLimit && !isTransientOverload) || attempt >= maxRetries) {
          throw aiErr;
        }

        const baseBackoffSec = backoffSeconds[attempt] ?? 2;
        const delaySeconds = aiErr.retryAfterSeconds
          ? Math.min(10, Math.max(baseBackoffSec, aiErr.retryAfterSeconds))
          : baseBackoffSec;

        options?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries,
          delaySeconds,
          reason: isRateLimit ? 'rate_limit' : 'server_busy',
        });

        await abortableWait(delaySeconds * 1000, options?.signal);
      }
    }

    throw new AIServiceException(
      'AI is temporarily busy. Please wait a moment and try again.',
      429,
      'RATE_LIMITED',
      undefined,
      { retryAfterSeconds: 6 }
    );
  }

  public async evaluateQuiz(
    params: {
      questions: GeneratedQuizQuestionPayload[];
      userAnswers: Record<string, string>;
    },
    options?: {
      signal?: AbortSignal;
    }
  ): Promise<QuizEvaluationResult> {
    return this.postJSON<QuizEvaluationResult>('/api/ai/quiz/evaluate', params, {
      signal: options?.signal,
      timeoutMs: 26_000,
    });
  }

  public async analyzeMemoryRevival(params: {
    currentNote: AINoteContext;
    candidateNotes: Array<AINoteContext & { similarity: number }>;
  }): Promise<{ revivals: MemoryRevivalReason[] }> {
    return this.postJSON<{ revivals: MemoryRevivalReason[] }>('/api/ai/memory-revival', params);
  }

  public async explainConnection(params: {
    sourceNote: AINoteContext;
    targetNote: AINoteContext;
    intermediateNotes: AINoteContext[];
    sharedTags: string[];
    similarityScore: number;
  }): Promise<ConnectionExplanationPayload> {
    return this.postJSON<ConnectionExplanationPayload>(
      '/api/ai/explain-connection',
      { mode: 'note', ...params },
      { timeoutMs: 44_000 }
    );
  }

  public async generateBrainGraph(
    params: { notes: AINoteContext[] },
    signal?: AbortSignal
  ): Promise<GeneratedConceptGraphPayload> {
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
      }
      try {
        const result = await this.postJSON<GeneratedConceptGraphPayload>('/api/ai/brain-graph', params, {
          signal,
          timeoutMs: 48_000,
        });
        return {
          ...result,
          cached: Boolean(result.cached),
        };
      } catch (err) {
        if (signal?.aborted) {
          throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
        }
        const aiErr = err instanceof AIServiceException ? err : null;
        const isTransient = aiErr?.statusCode === 502 || aiErr?.statusCode === 503;
        // Never retry 429/quota exhaustion or cancellations on brain graph generation
        if (!isTransient || attempt >= maxRetries) {
          throw err;
        }
        await abortableWait(2000, signal);
      }
    }
    throw new AIServiceException('The AI service is temporarily unavailable.', 503, 'AI_UNAVAILABLE');
  }

  public async explainConceptConnection(
    params: {
      sourceConcept: {
        id: string;
        label: string;
        category: string;
        description: string;
        sourceNoteIds: string[];
      };
      targetConcept: {
        id: string;
        label: string;
        category: string;
        description: string;
        sourceNoteIds: string[];
      };
      relationship: string;
      edgeReason: string;
      selectedNotes: AINoteContext[];
    },
    signal?: AbortSignal
  ): Promise<ConceptConnectionExplanationPayload> {
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
      }
      try {
        return await this.postJSON<ConceptConnectionExplanationPayload>(
          '/api/ai/explain-connection',
          { mode: 'concept', ...params },
          { signal, timeoutMs: 44_000 }
        );
      } catch (err) {
        if (signal?.aborted) {
          throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
        }
        const aiErr = err instanceof AIServiceException ? err : null;
        const isTransient = aiErr?.statusCode === 502 || aiErr?.statusCode === 503;
        if (!isTransient || attempt >= maxRetries) {
          throw err;
        }
        await abortableWait(2000, signal);
      }
    }
    throw new AIServiceException('The AI service is temporarily unavailable.', 503, 'AI_UNAVAILABLE');
  }

  public async captureNotesFromImages(
    params: {
      images: CaptureImageInput[];
      generateMetadata: boolean;
      existingSubjects: string[];
    },
    signal?: AbortSignal
  ): Promise<SmartNoteCapturePayload> {
    return this.postJSON<SmartNoteCapturePayload>('/api/ai/capture-note', params, {
      signal,
      timeoutMs: 65_000,
    });
  }

  public async extractSinglePageNote(
    params: {
      image: CaptureImageInput;
      pageNumber: number;
      totalPages: number;
      includeMetadata: boolean;
      existingSubjects: string[];
      retryMode?: 'standard' | 'enhanced';
      preferredModel?: 'primary' | 'secondary';
    },
    signal?: AbortSignal
  ): Promise<PageExtractionResult> {
    const startedAt = Date.now();
    const response = await this.fetchWithTimeout('/api/ai/capture-page', params, {
      signal,
      timeoutMs: 48_000,
    });

    const contentType = response.headers.get('content-type') || '';
    let rawText = '';
    try {
      rawText = await response.text();
    } catch {
      throw new AIServiceException(
        'Network error while reading server response.',
        503,
        'NETWORK_ERROR'
      );
    }

    return parseCapturePageResponse({
      status: response.status,
      ok: response.ok,
      contentType,
      rawText,
      fileName: params.image.fileName,
      fileSizeBytes: Math.round((params.image.base64Data.length * 3) / 4),
      mimeType: params.image.mimeType,
      base64Length: params.image.base64Data.length,
      durationMs: Date.now() - startedAt,
      abortedByClient: Boolean(signal?.aborted),
    });
  }

  public async generateCaptureMetadata(
    params: {
      combinedMarkdown: string;
      existingSubjects: string[];
    },
    signal?: AbortSignal
  ): Promise<CaptureMetadataPayload> {
    return this.postJSON<CaptureMetadataPayload>('/api/ai/capture-metadata', params, {
      signal,
      timeoutMs: 34_000,
    });
  }
}
