import { BaseFeatureService } from './BaseFeatureService';
import { AIServiceException, ValidationException } from '../exceptions/MindMeshExceptions';
import type {
  AINoteContext,
  AIProvider,
  FeatureContext,
  Generatable,
  GeneratedMindMapPayload,
  StudyAssistantRetryNotice,
} from '../interfaces/CoreInterfaces';
import type { Note } from '../models/Note';
import { MindMap } from '../models/MindMap';
import {
  generateSafeId,
  type ActivityHistoryRepository,
  type MindMapRepository,
} from '../repositories/FirestoreRepositories';
import { generateLocalMindMap } from '../utils/localMindMapGenerator';
import { isGenericNoteTitle, resolveNoteDisplayTitle } from '../utils/sourceNotes';

/**
 * OOP CONCEPTS: Inheritance, Polymorphism, Abstraction (implements Generatable)
 * Feature 3: MindMapService extends BaseFeatureService and implements Generatable
 * to convert selected saved notes into editable, persisted hierarchical MindMap objects,
 * with distinct AI error classification and local hierarchical fallback when AI is unavailable.
 */

export type MindMapErrorCategory =
  | 'quota_exhausted'
  | 'rate_limit'
  | 'server_error'
  | 'network_error'
  | 'invalid_response';

export interface MindMapFallbackInfo {
  category: MindMapErrorCategory;
  title: string;
  message: string;
  canRetry: boolean;
  retryAfterSeconds?: number;
}

export type MindMapGenerationSource = 'ai' | 'cached' | 'local_fallback' | 'demo';

export interface MindMapGenerateInput {
  selectedNotes: Note[];
  customTitle?: string;
  forceLocal?: boolean;
  demoMode?: boolean;
  signal?: AbortSignal;
  onRetry?: (notice: StudyAssistantRetryNotice) => void;
}

export interface MindMapGenerationResult {
  mindMap: MindMap;
  generationSource: MindMapGenerationSource;
  statusLabel: string;
  savedToCloud: boolean;
  fallbackInfo?: MindMapFallbackInfo;
}

export function classifyMindMapError(error: unknown): MindMapFallbackInfo {
  if (error instanceof AIServiceException) {
    if (error.isQuotaExhausted || error.serverCode === 'QUOTA_EXHAUSTED') {
      return {
        category: 'quota_exhausted',
        title: 'AI API quota exhausted',
        message:
          'Your Gemini API quota is currently exhausted, so MindMesh generated a hierarchical mind map locally from your selected notes instead. You can edit, rearrange, and save it normally.',
        canRetry: false,
      };
    }

    if (error.statusCode === 429 || error.serverCode === 'RATE_LIMITED') {
      return {
        category: 'rate_limit',
        title: 'AI is temporarily rate-limited (429)',
        message:
          'Too many AI requests were sent recently. A local mind map was generated from your notes so you can keep working, or you can retry with AI once the cooldown finishes.',
        canRetry: true,
        retryAfterSeconds: error.retryAfterSeconds ?? 8,
      };
    }

    if (
      error.serverCode === 'INVALID_RESPONSE' ||
      error.serverCode === 'PARSING_ERROR' ||
      error.serverCode === 'EMPTY_AI_RESPONSE' ||
      error.serverCode === 'NON_JSON_RESPONSE' ||
      error.serverCode === 'NON_JSON_HTML_RESPONSE'
    ) {
      return {
        category: 'invalid_response',
        title: 'AI returned an invalid response',
        message:
          'The AI response could not be parsed into a valid mind map structure. A local hierarchical mind map was generated from your selected notes instead.',
        canRetry: true,
      };
    }

    if (
      error.statusCode === 0 ||
      error.statusCode === 504 ||
      error.serverCode === 'NETWORK_ERROR' ||
      error.serverCode === 'TIMEOUT'
    ) {
      return {
        category: 'network_error',
        title: 'Network or timeout issue',
        message:
          'Could not reach the AI service in time. A local hierarchical mind map was generated directly from your saved notes instead.',
        canRetry: true,
      };
    }

    return {
      category: 'server_error',
      title: 'AI service temporarily unavailable',
      message:
        'The AI server encountered an error while generating the mind map. A local hierarchical mind map was created from your notes instead.',
      canRetry: true,
    };
  }

  return {
    category: 'network_error',
    title: 'AI generation unavailable',
    message:
      'Could not connect to the AI service. A local hierarchical mind map was generated from your selected notes instead.',
    canRetry: true,
  };
}

const MIND_MAP_CACHE_TTL_MS = 5 * 60 * 1000;
const MIND_MAP_CACHE_MAX_ITEMS = 20;

export class MindMapService
  extends BaseFeatureService<MindMapGenerateInput, MindMap>
  implements Generatable<{ context: FeatureContext; input: MindMapGenerateInput }, MindMap>
{
  private readonly mindMapRepo: MindMapRepository;
  private readonly mapCache = new Map<
    string,
    { expiresAt: number; payload: GeneratedMindMapPayload }
  >();

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    mindMapRepo: MindMapRepository
  ) {
    super(aiProvider, activityRepo);
    this.mindMapRepo = mindMapRepo;
  }

  public getServiceName(): string {
    return 'MindMapService';
  }

  public async generate(config: { context: FeatureContext; input: MindMapGenerateInput }): Promise<MindMap> {
    return this.execute(config.context, config.input);
  }

  public async execute(context: FeatureContext, input: MindMapGenerateInput): Promise<MindMap> {
    const result = await this.generateWithFallback(context, input);
    return result.mindMap;
  }

  /**
   * Generates a 4-level hierarchical mind map from the selected notes.
   * Passes verified noteIds and full note contents to the AI API, classifies failures cleanly,
   * never retries exhausted quotas, and automatically falls back to a local hierarchical
   * generator when AI is unavailable.
   */
  public async generateWithFallback(
    context: FeatureContext,
    input: MindMapGenerateInput
  ): Promise<MindMapGenerationResult> {
    this.validateUserContext(context);
    if (!input.selectedNotes || input.selectedNotes.length === 0) {
      throw new ValidationException('Select at least one note to generate a mind map.', 'selectedNotes');
    }

    // Deduplicate selected notes by noteId while preserving full note contents and meaningful titles
    const seenIds = new Set<string>();
    const verifiedNotes: Note[] = [];
    for (const note of input.selectedNotes) {
      if (!note || !note.noteId || seenIds.has(note.noteId)) continue;
      seenIds.add(note.noteId);
      verifiedNotes.push(note);
    }

    if (verifiedNotes.length === 0) {
      throw new ValidationException('No valid saved notes were selected.', 'selectedNotes');
    }

    const noteContexts: AINoteContext[] = verifiedNotes.map((n) => {
      const ctx = n.toAIContext();
      return {
        ...ctx,
        title: isGenericNoteTitle(ctx.title) ? resolveNoteDisplayTitle(ctx) : ctx.title,
      };
    });

    const cleanedCustomTitle = input.customTitle?.trim() || undefined;
    const cacheKey = this.buildSelectionCacheKey(context.userId, noteContexts, cleanedCustomTitle);

    let payload: GeneratedMindMapPayload;
    let generationSource: MindMapGenerationSource = 'ai';
    let statusLabel = 'AI response generated successfully';
    let fallbackInfo: MindMapFallbackInfo | undefined;

    const cachedEntry = this.mapCache.get(cacheKey);
    if (!input.forceLocal && cachedEntry && cachedEntry.expiresAt > Date.now()) {
      payload = cachedEntry.payload;
      generationSource = 'cached';
      statusLabel = 'Cached response displayed';
    } else if (input.demoMode) {
      payload = generateLocalMindMap(noteContexts, cleanedCustomTitle);
      generationSource = 'demo';
      statusLabel = 'Demo Mode active — prepared from your saved notes';
    } else if (input.forceLocal) {
      payload = generateLocalMindMap(noteContexts, cleanedCustomTitle);
      generationSource = 'local_fallback';
      statusLabel = 'Local fallback mode active';
    } else {
      try {
        payload = await this.aiProvider.generateMindMap(
          {
            notes: noteContexts,
            customTitle: cleanedCustomTitle,
          },
          {
            signal: input.signal,
            onRetry: input.onRetry,
          }
        );
        this.storeCacheEntry(cacheKey, payload);
        if (payload.cached) {
          generationSource = 'cached';
          statusLabel = 'Cached response displayed';
        } else {
          generationSource = 'ai';
          statusLabel = 'AI response generated successfully';
        }
      } catch (error) {
        // Respect explicit user cancellation — never build a fallback if cancelled
        if (
          input.signal?.aborted ||
          (error instanceof AIServiceException &&
            (error.statusCode === 499 || error.serverCode === 'CANCELLED'))
        ) {
          throw new AIServiceException('Mind map generation cancelled.', 499, 'CANCELLED');
        }

        fallbackInfo = classifyMindMapError(error);
        payload = generateLocalMindMap(noteContexts, cleanedCustomTitle);
        generationSource = 'local_fallback';
        statusLabel =
          fallbackInfo.category === 'quota_exhausted' || fallbackInfo.category === 'rate_limit'
            ? 'API quota temporarily exceeded — try again later'
            : 'Local fallback mode active';
      }
    }

    if (input.signal?.aborted) {
      throw new AIServiceException('Mind map generation cancelled.', 499, 'CANCELLED');
    }

    const positionedNodes = MindMap.applyHierarchicalLayout(payload.nodes || []);
    const validIds = new Set(positionedNodes.map((n) => n.id));
    const connections = (payload.connections || []).filter(
      (c) => validIds.has(c.source) && validIds.has(c.target) && c.source !== c.target
    );

    // Ensure every non-root node has an edge from its parent
    const edgeKeys = new Set(connections.map((c) => `${c.source}->${c.target}`));
    for (const node of positionedNodes) {
      if (node.parentId && validIds.has(node.parentId) && !edgeKeys.has(`${node.parentId}->${node.id}`)) {
        edgeKeys.add(`${node.parentId}->${node.id}`);
        connections.push({
          id: `conn-${node.parentId}-${node.id}`,
          source: node.parentId,
          target: node.id,
          label: '',
        });
      }
    }

    const defaultTitle =
      verifiedNotes.length === 1
        ? resolveNoteDisplayTitle(verifiedNotes[0])
        : `${resolveNoteDisplayTitle(verifiedNotes[0])} & Related Notes`;

    const mindMap = new MindMap({
      mindMapId: generateSafeId('mm'),
      userId: context.userId,
      title: cleanedCustomTitle || payload.title || defaultTitle,
      nodes: positionedNodes,
      connections,
      sourceNoteIds: verifiedNotes.map((n) => n.noteId),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let savedToCloud = false;
    try {
      await this.mindMapRepo.save(mindMap);
      savedToCloud = true;
    } catch {
      // Allow user to inspect, edit, and manually save the generated mind map even if Firestore is temporarily unreachable
      savedToCloud = false;
    }

    try {
      await this.activityRepo.logActivity({
        userId: context.userId,
        activityType: 'mindmap_created',
        title: `Mind Map: ${mindMap.title}`,
        description: `Generated ${mindMap.nodes.length} concept nodes from ${verifiedNotes.length} note(s)${
          generationSource === 'local_fallback' ? ' (local mode)' : ''
        }.`,
        entityId: mindMap.mindMapId,
      });
    } catch {
      // Non-critical activity log failure should never block returning the generated mind map
    }

    return {
      mindMap,
      generationSource,
      statusLabel,
      savedToCloud,
      fallbackInfo,
    };
  }

  private buildSelectionCacheKey(
    userId: string,
    notes: AINoteContext[],
    customTitle?: string
  ): string {
    const notesKey = notes
      .map((n) => `${n.noteId}:${n.content.length}`)
      .sort()
      .join('|');
    return `${userId}::${(customTitle || '').toLowerCase()}::${notesKey}`;
  }

  private storeCacheEntry(key: string, payload: GeneratedMindMapPayload): void {
    if (this.mapCache.size >= MIND_MAP_CACHE_MAX_ITEMS) {
      const oldestKey = this.mapCache.keys().next().value;
      if (oldestKey) this.mapCache.delete(oldestKey);
    }
    this.mapCache.set(key, {
      expiresAt: Date.now() + MIND_MAP_CACHE_TTL_MS,
      payload,
    });
  }

  public async saveEdits(mindMap: MindMap, isNewUnsaved = false): Promise<void> {
    if (isNewUnsaved) {
      await this.mindMapRepo.save(mindMap);
      return;
    }
    try {
      await this.mindMapRepo.updateMindMap(mindMap);
    } catch {
      // Fallback to setDoc if the document was not initially persisted while offline
      await this.mindMapRepo.save(mindMap);
    }
  }

  public async deleteMindMap(mindMapId: string): Promise<void> {
    await this.mindMapRepo.delete(mindMapId);
  }
}
