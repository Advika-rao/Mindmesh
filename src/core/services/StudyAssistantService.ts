import { BaseFeatureService } from './BaseFeatureService';
import { AIServiceException, ValidationException } from '../exceptions/MindMeshExceptions';
import type {
  AINoteContext,
  AIProvider,
  FeatureContext,
  StudyAssistantResponse,
  StudyAssistantRetryNotice,
} from '../interfaces/CoreInterfaces';
import { Note } from '../models/Note';
import type { AIConversationDTO, ChatMessageDTO, SavedSnippetDTO } from '../models/User';
import {
  generateSafeId,
  type ActivityHistoryRepository,
  type AIConversationRepository,
} from '../repositories/FirestoreRepositories';
import {
  deduplicateSourceNotes,
  getNoteContentFingerprint,
  isGenericNoteTitle,
  resolveNoteDisplayTitle,
} from '../utils/sourceNotes';
import { generateLocalStudyAnswer } from '../utils/localStudyFallback';

/**
 * OOP CONCEPTS: Inheritance & Polymorphism
 * Feature 2: StudyAssistantService extends BaseFeatureService and overrides execute()
 * to retrieve ONLY relevant note excerpts locally (zero extra embedding calls),
 * query Gemini once with caching & deduplication, automatically fall back to local
 * note synthesis when AI quota is exceeded or Demo Mode is active, cite source notes,
 * and persist multi-turn chat conversations in Firestore.
 */

export type StudyResponseSource = 'ai' | 'cached' | 'local_fallback' | 'demo';

export interface StudyAssistantInput {
  question: string;
  allNotes: Note[];
  conversation: AIConversationDTO | null;
  mode?: 'ask' | 'simplify' | 'summarize' | 'examples';
  focusedNoteIds?: string[];
  demoMode?: boolean;
  allowLocalFallback?: boolean;
  signal?: AbortSignal;
  onRetry?: (notice: StudyAssistantRetryNotice) => void;
}

export interface StudyAssistantOutput {
  conversation: AIConversationDTO;
  assistantMessage: ChatMessageDTO;
  suggestedFollowUps: string[];
  fromCache?: boolean;
  responseSource: StudyResponseSource;
  statusLabel: string;
  isQuotaOrRateLimited?: boolean;
  retryAfterSeconds?: number;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which', 'who',
  'how', 'why', 'about', 'into', 'your', 'have', 'does', 'can', 'could', 'would', 'should',
  'explain', 'summarize', 'simplify', 'give', 'tell', 'show', 'notes', 'note', 'saved', 'please',
  'are', 'was', 'were', 'been', 'being', 'has', 'had', 'will', 'all', 'any', 'but', 'not',
]);

const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESPONSE_CACHE_MAX_ITEMS = 30;

export class StudyAssistantService extends BaseFeatureService<
  StudyAssistantInput,
  StudyAssistantOutput
> {
  private readonly conversationRepo: AIConversationRepository;
  private readonly responseCache = new Map<
    string,
    { expiresAt: number; payload: StudyAssistantResponse }
  >();
  private readonly activeRequests = new Map<string, Promise<StudyAssistantResponse>>();

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    conversationRepo: AIConversationRepository
  ) {
    super(aiProvider, activityRepo);
    this.conversationRepo = conversationRepo;
  }

  public getServiceName(): string {
    return 'StudyAssistantService';
  }

  public async execute(
    context: FeatureContext,
    input: StudyAssistantInput
  ): Promise<StudyAssistantOutput> {
    this.validateUserContext(context);
    const question = input.question.trim();
    if (!question) {
      throw new ValidationException('Please enter a study question.', 'question');
    }

    if (input.signal?.aborted) {
      throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
    }

    const mode = input.mode ?? 'ask';

    // 1. Retrieve ONLY the most relevant saved notes locally (zero extra API calls)
    const relevantNoteContexts = this.buildRelevantNoteContexts(
      question,
      input.allNotes,
      input.focusedNoteIds
    );

    const priorHistory = (input.conversation?.messages ?? []).slice(-6).map((m) => ({
      role: m.role,
      content: m.content.slice(0, 600),
    }));

    // 2. Build deterministic cache & in-flight deduplication key
    const cacheKey = this.buildQueryCacheKey(
      context.userId,
      question,
      mode,
      relevantNoteContexts,
      priorHistory
    );

    let aiResponse: StudyAssistantResponse;
    let fromCache = false;
    let responseSource: StudyResponseSource = 'ai';
    let statusLabel = 'AI response generated successfully';
    let isQuotaOrRateLimited = false;
    let retryAfterSeconds: number | undefined;

    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      aiResponse = cached.payload;
      fromCache = true;
      responseSource = 'cached';
      statusLabel = 'Cached response displayed';
    } else if (input.demoMode) {
      // Presentation / Demo Mode: answer immediately from the user's saved notes with zero API calls
      aiResponse = generateLocalStudyAnswer(question, relevantNoteContexts, mode);
      responseSource = 'demo';
      statusLabel = 'Demo Mode active — prepared from your saved notes';
    } else {
      // Reuse in-flight request if an identical query is already running
      let pending = this.activeRequests.get(cacheKey);
      if (!pending) {
        pending = this.aiProvider.askStudyAssistant(
          {
            question,
            notes: relevantNoteContexts,
            history: priorHistory,
            mode,
          },
          {
            signal: input.signal,
            onRetry: input.onRetry,
          }
        );
        this.activeRequests.set(cacheKey, pending);
        pending
          .then((res) => {
            this.storeCacheEntry(cacheKey, res);
          })
          .catch(() => {
            // Do not cache failed responses
          })
          .finally(() => {
            if (this.activeRequests.get(cacheKey) === pending) {
              this.activeRequests.delete(cacheKey);
            }
          });
      }

      try {
        aiResponse = await pending;
        fromCache = Boolean(aiResponse.cached);
        responseSource = fromCache ? 'cached' : 'ai';
        statusLabel = fromCache
          ? 'Cached response displayed'
          : 'AI response generated successfully';
      } catch (err) {
        if (
          input.signal?.aborted ||
          err instanceof ValidationException ||
          (err instanceof AIServiceException &&
            (err.statusCode === 499 || err.serverCode === 'CANCELLED'))
        ) {
          throw err;
        }

        if (input.allowLocalFallback === false) {
          throw err;
        }

        const aiErr = err instanceof AIServiceException ? err : null;
        isQuotaOrRateLimited = Boolean(
          aiErr?.isQuotaExhausted ||
            aiErr?.serverCode === 'QUOTA_EXHAUSTED' ||
            aiErr?.statusCode === 429 ||
            aiErr?.serverCode === 'RATE_LIMITED'
        );
        retryAfterSeconds = aiErr?.retryAfterSeconds;

        aiResponse = generateLocalStudyAnswer(question, relevantNoteContexts, mode);
        responseSource = 'local_fallback';
        statusLabel = isQuotaOrRateLimited
          ? 'API quota temporarily exceeded — try again later'
          : 'Local fallback mode active';
      }
    }

    // Do not persist anything if the user cancelled while the request was completing
    if (input.signal?.aborted) {
      throw new AIServiceException('Request cancelled.', 499, 'CANCELLED');
    }

    const noteLookup = new Map(input.allNotes.map((n) => [n.noteId, n]));
    const verifiedCitations = deduplicateSourceNotes(aiResponse.citedNoteIds || [], noteLookup).map(
      (src) => src.noteId
    );

    const nowIso = new Date().toISOString();
    const userMsg: ChatMessageDTO = {
      id: generateSafeId('msg'),
      role: 'user',
      content: question,
      citedNoteIds: [],
      timestamp: nowIso,
    };
    const assistantMsg: ChatMessageDTO = {
      id: generateSafeId('msg'),
      role: 'assistant',
      content: aiResponse.answer,
      citedNoteIds: verifiedCitations,
      insufficientContext: Boolean(aiResponse.insufficientContext),
      timestamp: new Date().toISOString(),
    };

    let updatedConv: AIConversationDTO;
    if (input.conversation) {
      const nextMessages = [...input.conversation.messages, userMsg, assistantMsg].slice(-100);
      updatedConv = {
        ...input.conversation,
        messages: nextMessages,
        updatedAt: new Date(),
      };
      try {
        await this.conversationRepo.updateConversation(input.conversation.conversationId, {
          messages: nextMessages,
        });
      } catch {
        // Non-fatal persistence failure: still show the answer so the live demo never crashes
      }
    } else {
      const convId = generateSafeId('conv');
      const title = question.length > 70 ? `${question.slice(0, 67)}...` : question;
      updatedConv = {
        conversationId: convId,
        userId: context.userId,
        title,
        messages: [userMsg, assistantMsg],
        savedSnippets: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      try {
        await this.conversationRepo.save(updatedConv);
      } catch {
        // Non-fatal persistence failure: still show the answer so the live demo never crashes
      }
    }

    try {
      await this.activityRepo.logActivity({
        userId: context.userId,
        activityType: 'ai_chat',
        title: `Study Assistant: ${question.slice(0, 80)}`,
        description: `Answered using ${verifiedCitations.length} source note(s)${
          responseSource === 'local_fallback'
            ? ' (local fallback)'
            : responseSource === 'demo'
              ? ' (demo mode)'
              : ''
        }.`,
        entityId: updatedConv.conversationId,
      });
    } catch {
      // Non-critical activity log failure should never lose a generated answer
    }

    return {
      conversation: updatedConv,
      assistantMessage: assistantMsg,
      suggestedFollowUps: aiResponse.suggestedFollowUps || [],
      fromCache,
      responseSource,
      statusLabel,
      isQuotaOrRateLimited,
      retryAfterSeconds,
    };
  }

  public async saveSnippet(
    conversation: AIConversationDTO,
    question: string,
    assistantMsg: ChatMessageDTO
  ): Promise<SavedSnippetDTO> {
    const snippet: SavedSnippetDTO = {
      id: generateSafeId('snip'),
      question: question.slice(0, 400),
      answer: assistantMsg.content.slice(0, 4000),
      citedNoteIds: assistantMsg.citedNoteIds,
      savedAt: new Date().toISOString(),
    };
    const nextSnippets = [...conversation.savedSnippets, snippet].slice(-50);
    await this.conversationRepo.updateConversation(conversation.conversationId, {
      savedSnippets: nextSnippets,
    });
    return snippet;
  }

  public async deleteConversation(conversationId: string): Promise<void> {
    await this.conversationRepo.delete(conversationId);
  }

  private storeCacheEntry(key: string, payload: StudyAssistantResponse): void {
    if (this.responseCache.size >= RESPONSE_CACHE_MAX_ITEMS) {
      const oldestKey = this.responseCache.keys().next().value;
      if (oldestKey) this.responseCache.delete(oldestKey);
    }
    this.responseCache.set(key, {
      expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
      payload,
    });
  }

  private buildQueryCacheKey(
    userId: string,
    question: string,
    mode: string,
    notes: AINoteContext[],
    history: Array<{ role: string; content: string }>
  ): string {
    const normQuestion = question.toLowerCase().replace(/\s+/g, ' ').trim();
    const notesKey = notes
      .map((n) => `${n.noteId}:${n.content.length}:${n.title.slice(0, 32)}`)
      .join('|');
    const historyKey = history
      .slice(-4)
      .map((m) => `${m.role}:${m.content.slice(0, 60)}`)
      .join('|');
    return `${userId}::${mode}::${normQuestion}::${notesKey}::${historyKey}`;
  }

  /**
   * Local zero-API-call retrieval engine: ranks saved notes by focused priority,
   * exact phrase matches, and IDF-weighted keyword relevance across title, tags,
   * subject, and body, then trims long notes to the most relevant passages.
   */
  private buildRelevantNoteContexts(
    queryText: string,
    allNotes: Note[],
    focusedNoteIds?: string[]
  ): AINoteContext[] {
    if (allNotes.length === 0) return [];

    const focusedSet = new Set((focusedNoteIds ?? []).filter(Boolean));
    const lowerQuery = queryText.toLowerCase().trim();
    const rawTokens = lowerQuery
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    const queryTokens = Array.from(
      new Set(rawTokens.filter((t) => !STOP_WORDS.has(t)))
    );
    const activeTokens = queryTokens.length > 0 ? queryTokens : Array.from(new Set(rawTokens));

    // Compute document frequency across user's notes for IDF weighting
    const docFreq = new Map<string, number>();
    for (const token of activeTokens) {
      let count = 0;
      for (const note of allNotes) {
        const safeTags = Array.isArray(note.tags) ? note.tags.join(' ') : '';
        const hay = `${note.title ?? ''} ${note.subject ?? ''} ${safeTags} ${note.content ?? ''}`.toLowerCase();
        if (hay.includes(token)) count += 1;
      }
      docFreq.set(token, count);
    }

    const totalDocs = allNotes.length;

    const scored = allNotes.map((note, idx) => {
      const titleLower = (note.title ?? '').toLowerCase();
      const subjectLower = (note.subject ?? '').toLowerCase();
      const tagsLower = (Array.isArray(note.tags) ? note.tags.join(' ') : '').toLowerCase();
      const contentLower = (note.content ?? '').toLowerCase();

      let score = focusedSet.has(note.noteId) ? 100 : 0;

      // Exact phrase bonus
      if (lowerQuery.length >= 4 && (titleLower.includes(lowerQuery) || contentLower.includes(lowerQuery))) {
        score += 12;
      }

      for (const token of activeTokens) {
        const df = docFreq.get(token) ?? 1;
        const idf = Math.log((totalDocs + 1) / (df + 0.5)) + 1;

        if (titleLower.includes(token)) score += 4.5 * idf;
        if (tagsLower.includes(token)) score += 3.5 * idf;
        if (subjectLower.includes(token)) score += 2.5 * idf;
        if (contentLower.includes(token)) {
          // Count up to 5 occurrences for term-frequency boost without letting giant notes dominate
          let occurrences = 0;
          let pos = contentLower.indexOf(token);
          while (pos !== -1 && occurrences < 5) {
            occurrences += 1;
            pos = contentLower.indexOf(token, pos + token.length);
          }
          score += (1.2 + Math.min(occurrences, 4) * 0.45) * idf;
        }
      }

      // Slight recency tie-breaker so recent notes win ties naturally
      score += Math.max(0, 0.25 - idx * 0.01);

      return { note, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Deduplicate near-identical note copies (prefer focused note, then non-generic title, then highest score)
    const uniqueRanked: Note[] = [];
    const seenFingerprints = new Set<string>();
    for (const entry of scored) {
      const fp = getNoteContentFingerprint(entry.note);
      if (seenFingerprints.has(fp) && !focusedSet.has(entry.note.noteId)) {
        continue;
      }
      seenFingerprints.add(fp);
      uniqueRanked.push(entry.note);
    }

    // If user explicitly focused specific note(s), send focused note(s) + up to 2 top related notes
    const maxNotes =
      focusedSet.size > 0 ? Math.min(3, uniqueRanked.length) : Math.min(5, uniqueRanked.length);
    const chosen = uniqueRanked.slice(0, maxNotes);
    const perNoteBudget = chosen.length <= 2 ? 3800 : 2200;

    return chosen.map((note) => ({
      noteId: note.noteId,
      title: isGenericNoteTitle(note.title) ? resolveNoteDisplayTitle(note) : (note.title ?? 'Untitled Note'),
      subject: note.subject ?? 'General',
      tags: Array.isArray(note.tags) ? note.tags : [],
      content: this.extractFocusedContent(note.content ?? '', activeTokens, perNoteBudget),
    }));
  }

  /**
   * When a note exceeds the per-note token budget, keeps its opening overview plus
   * the highest-scoring paragraphs matching the user's question.
   */
  private extractFocusedContent(content: string, tokens: string[], maxChars: number): string {
    const trimmed = (content ?? '').trim();
    if (trimmed.length <= maxChars) return trimmed;

    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (paragraphs.length <= 2) {
      return trimmed.slice(0, maxChars);
    }

    const selectedIndices = new Set<number>([0]);
    let usedChars = paragraphs[0].length;

    const scoredParas = paragraphs
      .slice(1)
      .map((para, offset) => {
        const lower = para.toLowerCase();
        let hits = 0;
        for (const token of tokens) {
          if (lower.includes(token)) hits += 1;
        }
        return { index: offset + 1, para, hits };
      })
      .sort((a, b) => b.hits - a.hits || a.index - b.index);

    for (const item of scoredParas) {
      if (usedChars + item.para.length + 2 > maxChars) continue;
      selectedIndices.add(item.index);
      usedChars += item.para.length + 2;
    }

    const ordered = Array.from(selectedIndices)
      .sort((a, b) => a - b)
      .map((idx) => paragraphs[idx])
      .join('\n\n');

    return ordered.length <= maxChars ? ordered : ordered.slice(0, maxChars);
  }
}
