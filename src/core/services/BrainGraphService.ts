import { BaseFeatureService } from './BaseFeatureService';
import type {
  AIProvider,
  ConceptConnectionExplanationPayload,
  FeatureContext,
} from '../interfaces/CoreInterfaces';
import { Note } from '../models/Note';
import {
  ConceptBrainGraph,
  ConceptGraphEdge,
  ConceptGraphNode,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  computeConceptGraphLayout,
  type ConceptBrainGraphDTO,
  type GraphRelationshipDTO,
} from '../models/KnowledgeGraph';
import type { ActivityHistoryRepository, KnowledgeGraphRepository } from '../repositories/FirestoreRepositories';
import { AIServiceException, ValidationException } from '../exceptions/MindMeshExceptions';
import {
  generateLocalBrainGraph,
  generateLocalConnectionExplanation,
} from '../utils/localBrainGraphGenerator';

/**
 * OOP CONCEPTS: Inheritance & Polymorphism
 * Feature 1: BrainGraphService extends BaseFeatureService and overrides execute()
 * to build and persist the user's semantic visual KnowledgeGraph, plus AI-powered
 * concept-level Brain Graph generation from selected notes with caching, Demo Mode,
 * and local fallback when the Gemini API is temporarily unavailable.
 */

export type BrainGraphSource = 'ai' | 'cached' | 'local_fallback' | 'demo';

export interface BrainGraphInput {
  notes: Note[];
  existingGraphNodes: GraphNode[];
  persistToFirestore?: boolean;
}

export interface ConceptBrainGraphInput {
  selectedNotes: Note[];
  demoMode?: boolean;
  allowLocalFallback?: boolean;
  signal?: AbortSignal;
}

export interface ConceptBrainGraphResult {
  graph: ConceptBrainGraph;
  source: BrainGraphSource;
  statusLabel: string;
  isQuotaOrRateLimited?: boolean;
  retryAfterSeconds?: number;
}

export interface ConceptEdgeExplanationInput {
  sourceConcept: ConceptGraphNode;
  targetConcept: ConceptGraphNode;
  edge?: ConceptGraphEdge | null;
  selectedNotes: Note[];
  demoMode?: boolean;
  allowLocalFallback?: boolean;
  signal?: AbortSignal;
}

export interface ConceptEdgeExplanationResult {
  explanation: ConceptConnectionExplanationPayload;
  source: BrainGraphSource;
  statusLabel: string;
  isQuotaOrRateLimited?: boolean;
}

const CONCEPT_GRAPH_CACHE_PREFIX = 'mindmesh_concept_brain_graph_v1_';
const SELECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SELECTION_CACHE_MAX_ITEMS = 20;
const EXPLANATION_CACHE_TTL_MS = 10 * 60 * 1000;
const EXPLANATION_CACHE_MAX_ITEMS = 40;

export class BrainGraphService extends BaseFeatureService<BrainGraphInput, KnowledgeGraph> {
  private readonly graphRepo: KnowledgeGraphRepository;
  private readonly selectionCache = new Map<
    string,
    { expiresAt: number; graph: ConceptBrainGraph }
  >();
  private readonly explanationCache = new Map<
    string,
    { expiresAt: number; payload: ConceptConnectionExplanationPayload }
  >();

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    graphRepo: KnowledgeGraphRepository
  ) {
    super(aiProvider, activityRepo);
    this.graphRepo = graphRepo;
  }

  public getServiceName(): string {
    return 'BrainGraphService';
  }

  public async execute(context: FeatureContext, input: BrainGraphInput): Promise<KnowledgeGraph> {
    this.validateUserContext(context);
    const { notes, existingGraphNodes, persistToFirestore = false } = input;
    const graph = this.computeGraph(context.userId, notes, existingGraphNodes);

    if (persistToFirestore) {
      await this.persistGraph(graph, existingGraphNodes, notes);
    }

    return graph;
  }

  /**
   * Generates a meaningful, deduplicated concept-level Brain Graph strictly from
   * the user's selected notes using the server-side Gemini API and automatic DAG layout,
   * with caching, Demo Mode, and automatic local fallback when AI is unavailable.
   */
  public async generateConceptGraph(
    context: FeatureContext,
    input: ConceptBrainGraphInput
  ): Promise<ConceptBrainGraph> {
    const result = await this.generateConceptGraphWithStatus(context, input);
    return result.graph;
  }

  public async generateConceptGraphWithStatus(
    context: FeatureContext,
    input: ConceptBrainGraphInput
  ): Promise<ConceptBrainGraphResult> {
    this.validateUserContext(context);
    const ownedSelectedNotes = input.selectedNotes.filter((n) => n.userId === context.userId);
    if (ownedSelectedNotes.length === 0) {
      throw new ValidationException('Select at least one saved note before generating a Brain Graph.');
    }

    const selectionKey = this.buildSelectionCacheKey(context.userId, ownedSelectedNotes);
    const cachedGraph = this.selectionCache.get(selectionKey);
    if (cachedGraph && cachedGraph.expiresAt > Date.now()) {
      this.saveCachedConceptGraph(context.userId, cachedGraph.graph);
      return {
        graph: cachedGraph.graph,
        source: 'cached',
        statusLabel: 'Cached response displayed',
      };
    }

    const noteContexts = ownedSelectedNotes.map((n) => n.toAIContext());
    let aiPayload;
    let source: BrainGraphSource = 'ai';
    let statusLabel = 'AI response generated successfully';
    let isQuotaOrRateLimited = false;
    let retryAfterSeconds: number | undefined;

    if (input.demoMode) {
      aiPayload = generateLocalBrainGraph(noteContexts);
      source = 'demo';
      statusLabel = 'Demo Mode active — prepared from your saved notes';
    } else {
      try {
        aiPayload = await this.aiProvider.generateBrainGraph(
          { notes: noteContexts },
          input.signal
        );
        if (aiPayload.cached) {
          source = 'cached';
          statusLabel = 'Cached response displayed';
        } else {
          source = 'ai';
          statusLabel = 'AI response generated successfully';
        }
      } catch (err) {
        if (
          input.signal?.aborted ||
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
        aiPayload = generateLocalBrainGraph(noteContexts);
        source = 'local_fallback';
        statusLabel = isQuotaOrRateLimited
          ? 'API quota temporarily exceeded — try again later'
          : 'Local fallback mode active';
      }
    }

    const validNoteIds = new Set(ownedSelectedNotes.map((n) => n.noteId));

    // Client-side defensive deduplication in addition to server-side sanitization
    const dedupedRawNodes = new Map<
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
    const rawIdMap = new Map<string, string>();

    for (const c of aiPayload.concepts || []) {
      const label = (c.label || '').trim();
      if (!label) continue;
      const normKey = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const filteredSources = Array.from(
        new Set((c.sourceNoteIds || []).filter((id) => validNoteIds.has(id)))
      );
      const sourceNoteIds = filteredSources.length > 0 ? filteredSources : [ownedSelectedNotes[0].noteId];

      const existing = dedupedRawNodes.get(normKey);
      if (existing) {
        existing.sourceNoteIds = Array.from(new Set([...existing.sourceNoteIds, ...sourceNoteIds]));
        rawIdMap.set(c.id, existing.id);
        continue;
      }

      dedupedRawNodes.set(normKey, {
        id: c.id,
        label,
        category: c.category || ownedSelectedNotes[0].subject,
        description: c.description || '',
        tier: Number.isFinite(c.tier) ? c.tier : 1,
        sourceNoteIds,
      });
      rawIdMap.set(c.id, c.id);
    }

    const uniqueNodeList = Array.from(dedupedRawNodes.values());
    const validConceptIds = new Set(uniqueNodeList.map((n) => n.id));

    const seenPairs = new Set<string>();
    const cleanEdges: ConceptGraphEdge[] = [];
    for (const e of aiPayload.edges || []) {
      const sourceId = rawIdMap.get(e.source) || e.source;
      const targetId = rawIdMap.get(e.target) || e.target;
      if (!sourceId || !targetId || sourceId === targetId) continue;
      if (!validConceptIds.has(sourceId) || !validConceptIds.has(targetId)) continue;
      const pairKey = [sourceId, targetId].sort().join('::');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      cleanEdges.push(
        new ConceptGraphEdge({
          id: e.id || `cedge-${sourceId}--${targetId}`,
          source: sourceId,
          target: targetId,
          relationship: e.relationship || 'relates to',
          reason: e.reason || 'Conceptually linked in your selected notes.',
        })
      );
    }

    const layoutPositions = computeConceptGraphLayout(
      uniqueNodeList,
      cleanEdges.map((e) => e.toDTO())
    );

    const positionedNodes = uniqueNodeList.map((n) => {
      const pos = layoutPositions.get(n.id) ?? { x: 0, y: 0 };
      return new ConceptGraphNode({
        ...n,
        positionX: pos.x,
        positionY: pos.y,
      });
    });

    const conceptGraph = new ConceptBrainGraph({
      userId: context.userId,
      graphTitle: aiPayload.graphTitle || 'Concept Brain Graph',
      summary:
        aiPayload.summary ||
        `Extracted ${positionedNodes.length} concepts and ${cleanEdges.length} connections from ${ownedSelectedNotes.length} selected note${ownedSelectedNotes.length === 1 ? '' : 's'}.`,
      selectedNoteIds: ownedSelectedNotes.map((n) => n.noteId),
      nodes: positionedNodes,
      edges: cleanEdges,
      generatedAt: new Date(),
    });

    // Only cache genuine AI-generated concept graphs so retry after quota reset can upgrade to AI
    if (source === 'ai' || source === 'cached') {
      this.storeSelectionCache(selectionKey, conceptGraph);
    }
    this.saveCachedConceptGraph(context.userId, conceptGraph);

    return {
      graph: conceptGraph,
      source,
      statusLabel,
      isQuotaOrRateLimited,
      retryAfterSeconds,
    };
  }

  /**
   * Explains a conceptual edge or pair of concepts in the Brain Graph grounded strictly
   * in the user's selected notes, with caching, Demo Mode, and local fallback.
   */
  public async explainConceptEdge(
    context: FeatureContext,
    input: ConceptEdgeExplanationInput
  ): Promise<ConceptConnectionExplanationPayload> {
    const result = await this.explainConceptEdgeWithStatus(context, input);
    return result.explanation;
  }

  public async explainConceptEdgeWithStatus(
    context: FeatureContext,
    input: ConceptEdgeExplanationInput
  ): Promise<ConceptEdgeExplanationResult> {
    this.validateUserContext(context);
    const ownedSelectedNotes = input.selectedNotes.filter((n) => n.userId === context.userId);
    const noteContexts = ownedSelectedNotes.map((n) => n.toAIContext());
    const cacheKey = `${context.userId}::${input.sourceConcept.id}::${input.targetConcept.id}::${ownedSelectedNotes
      .map((n) => n.noteId)
      .sort()
      .join(',')}`;

    const cached = this.explanationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        explanation: cached.payload,
        source: 'cached',
        statusLabel: 'Cached response displayed',
      };
    }

    let payload: ConceptConnectionExplanationPayload;
    let source: BrainGraphSource = 'ai';
    let statusLabel = 'AI response generated successfully';
    let isQuotaOrRateLimited = false;

    if (input.demoMode) {
      payload = generateLocalConnectionExplanation({
        sourceLabel: input.sourceConcept.label,
        sourceDescription: input.sourceConcept.description,
        sourceNoteIds: input.sourceConcept.sourceNoteIds,
        targetLabel: input.targetConcept.label,
        targetDescription: input.targetConcept.description,
        targetNoteIds: input.targetConcept.sourceNoteIds,
        relationship: input.edge?.relationship || 'relates to',
        edgeReason: input.edge?.reason || '',
        selectedNotes: noteContexts,
      });
      source = 'demo';
      statusLabel = 'Demo Mode active — prepared from your saved notes';
    } else {
      try {
        payload = await this.aiProvider.explainConceptConnection(
          {
            sourceConcept: {
              id: input.sourceConcept.id,
              label: input.sourceConcept.label,
              category: input.sourceConcept.category,
              description: input.sourceConcept.description,
              sourceNoteIds: input.sourceConcept.sourceNoteIds,
            },
            targetConcept: {
              id: input.targetConcept.id,
              label: input.targetConcept.label,
              category: input.targetConcept.category,
              description: input.targetConcept.description,
              sourceNoteIds: input.targetConcept.sourceNoteIds,
            },
            relationship: input.edge?.relationship || 'relates to',
            edgeReason: input.edge?.reason || '',
            selectedNotes: noteContexts,
          },
          input.signal
        );
        this.storeExplanationCache(cacheKey, payload);
        source = payload.cached ? 'cached' : 'ai';
        statusLabel = payload.cached
          ? 'Cached response displayed'
          : 'AI response generated successfully';
      } catch (err) {
        if (
          input.signal?.aborted ||
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
        payload = generateLocalConnectionExplanation({
          sourceLabel: input.sourceConcept.label,
          sourceDescription: input.sourceConcept.description,
          sourceNoteIds: input.sourceConcept.sourceNoteIds,
          targetLabel: input.targetConcept.label,
          targetDescription: input.targetConcept.description,
          targetNoteIds: input.targetConcept.sourceNoteIds,
          relationship: input.edge?.relationship || 'relates to',
          edgeReason: input.edge?.reason || '',
          selectedNotes: noteContexts,
        });
        source = 'local_fallback';
        statusLabel = isQuotaOrRateLimited
          ? 'API quota temporarily exceeded — try again later'
          : 'Local fallback mode active';
      }
    }

    try {
      await this.activityRepo.logActivity({
        userId: context.userId,
        activityType: 'connection_explained',
        title: `Explained: ${input.sourceConcept.label} → ${input.targetConcept.label}`.slice(0, 200),
        description: (payload.summary || '').slice(0, 400),
        entityId: `${input.sourceConcept.id}--${input.targetConcept.id}`.slice(0, 120),
      });
    } catch {
      // Non-critical activity log failure should never block connection explanation display
    }

    return {
      explanation: payload,
      source,
      statusLabel,
      isQuotaOrRateLimited,
    };
  }

  private buildSelectionCacheKey(userId: string, notes: Note[]): string {
    const notesKey = notes
      .map((n) => `${n.noteId}:${(n.content || '').length}`)
      .sort()
      .join('|');
    return `${userId}::${notesKey}`;
  }

  private storeSelectionCache(key: string, graph: ConceptBrainGraph): void {
    if (this.selectionCache.size >= SELECTION_CACHE_MAX_ITEMS) {
      const oldestKey = this.selectionCache.keys().next().value;
      if (oldestKey) this.selectionCache.delete(oldestKey);
    }
    this.selectionCache.set(key, {
      expiresAt: Date.now() + SELECTION_CACHE_TTL_MS,
      graph,
    });
  }

  private storeExplanationCache(key: string, payload: ConceptConnectionExplanationPayload): void {
    if (this.explanationCache.size >= EXPLANATION_CACHE_MAX_ITEMS) {
      const oldestKey = this.explanationCache.keys().next().value;
      if (oldestKey) this.explanationCache.delete(oldestKey);
    }
    this.explanationCache.set(key, {
      expiresAt: Date.now() + EXPLANATION_CACHE_TTL_MS,
      payload,
    });
  }

  public saveCachedConceptGraph(userId: string, graph: ConceptBrainGraph): void {
    try {
      if (typeof window === 'undefined' || !userId) return;
      window.localStorage.setItem(
        `${CONCEPT_GRAPH_CACHE_PREFIX}${userId}`,
        JSON.stringify(graph.toDTO())
      );
    } catch {
      // Ignore storage quota or private-mode errors
    }
  }

  public loadCachedConceptGraph(userId: string, validNoteIds: Set<string>): ConceptBrainGraph | null {
    try {
      if (typeof window === 'undefined' || !userId) return null;
      const raw = window.localStorage.getItem(`${CONCEPT_GRAPH_CACHE_PREFIX}${userId}`);
      if (!raw) return null;
      const dto = JSON.parse(raw) as ConceptBrainGraphDTO;
      if (!dto || dto.userId !== userId || !Array.isArray(dto.nodes) || dto.nodes.length === 0) {
        return null;
      }
      // Keep only selected note IDs that still exist in this user's Firestore notes
      const survivingSelected = (dto.selectedNoteIds || []).filter((id) => validNoteIds.has(id));
      if (survivingSelected.length === 0) return null;

      const filteredNodes = dto.nodes.map((node) => ({
        ...node,
        sourceNoteIds: (node.sourceNoteIds || []).filter((id) => validNoteIds.has(id)),
      }));

      return ConceptBrainGraph.fromDTO({
        ...dto,
        selectedNoteIds: survivingSelected,
        nodes: filteredNodes,
      });
    } catch {
      return null;
    }
  }

  public clearCachedConceptGraph(userId: string): void {
    try {
      if (typeof window === 'undefined' || !userId) return;
      window.localStorage.removeItem(`${CONCEPT_GRAPH_CACHE_PREFIX}${userId}`);
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Computes relationships between notes using semantic cosine similarity,
   * shared tags, shared subject, and lexical overlap.
   */
  public computeGraph(userId: string, notes: Note[], savedNodes: GraphNode[]): KnowledgeGraph {
    const savedByNoteId = new Map(savedNodes.map((gn) => [gn.noteId, gn]));
    const graph = new KnowledgeGraph();

    // Arrange new nodes on a clean multi-ring radial layout grouped by subject
    const subjects = Array.from(new Set(notes.map((n) => n.subject))).sort();
    const subjectIndexMap = new Map(subjects.map((s, idx) => [s, idx]));

    const computedNodes: GraphNode[] = notes.map((note, idx) => {
      const existing = savedByNoteId.get(note.noteId);
      let x = existing?.positionX;
      let y = existing?.positionY;

      if (x === undefined || y === undefined) {
        const sIdx = subjectIndexMap.get(note.subject) ?? 0;
        const angleBase = (sIdx / Math.max(subjects.length, 1)) * Math.PI * 2;
        const jitter = ((idx % 6) - 2.5) * 0.28;
        const radius = 220 + Math.floor(idx / Math.max(subjects.length, 1)) * 165;
        x = Math.round(Math.cos(angleBase + jitter) * radius);
        y = Math.round(Math.sin(angleBase + jitter) * radius);
      }

      return new GraphNode({
        graphNodeId: `gn-${note.noteId}`,
        userId,
        noteId: note.noteId,
        concept: note.title,
        subject: note.subject,
        positionX: x,
        positionY: y,
        relationships: [],
        updatedAt: new Date(),
      });
    });

    const relMap = new Map<string, GraphRelationshipDTO[]>();
    for (const n of notes) relMap.set(n.noteId, []);

    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const a = notes[i];
        const b = notes[j];
        const semantic = Note.cosineSimilarity(a.embedding, b.embedding);
        const lexical = a.computeLexicalSimilarity(b);
        const sharedTags = a.getSharedTags(b);
        const sameSubject = a.subject.toLowerCase() === b.subject.toLowerCase();

        // Weighted hybrid relationship score
        const tagBoost = Math.min(sharedTags.length * 0.16, 0.36);
        const subjectBoost = sameSubject ? 0.16 : 0;
        const combinedWeight = Math.min(
          1,
          (semantic > 0 ? semantic * 0.65 : lexical * 0.7) + lexical * 0.2 + tagBoost + subjectBoost
        );

        const isConnected =
          (semantic >= 0.66) ||
          (combinedWeight >= 0.42) ||
          (sharedTags.length >= 1 && (sameSubject || lexical >= 0.08 || semantic >= 0.52));

        if (isConnected) {
          const reasons: string[] = [];
          if (semantic >= 0.66) reasons.push(`${Math.round(semantic * 100)}% semantic match`);
          if (sharedTags.length > 0) reasons.push(`Shared tags: ${sharedTags.join(', ')}`);
          if (sameSubject) reasons.push(`Same subject (${a.subject})`);
          if (reasons.length === 0) reasons.push('Related concepts');
          const reason = reasons.join(' · ');

          const edge = new GraphEdge({
            sourceNoteId: a.noteId,
            targetNoteId: b.noteId,
            weight: combinedWeight,
            reason,
            sharedTags,
          });
          graph.addEdge(edge);

          relMap.get(a.noteId)!.push({
            targetNoteId: b.noteId,
            weight: edge.weight,
            reason,
            sharedTags,
          });
          relMap.get(b.noteId)!.push({
            targetNoteId: a.noteId,
            weight: edge.weight,
            reason,
            sharedTags,
          });
        }
      }
    }

    for (const node of computedNodes) {
      node.setRelationships(
        (relMap.get(node.noteId) ?? []).sort((x, y) => y.weight - x.weight)
      );
      graph.addNode(node);
    }

    return graph;
  }

  public async persistGraph(
    graph: KnowledgeGraph,
    previousNodes: GraphNode[],
    currentNotes: Note[]
  ): Promise<void> {
    const validNoteIds = new Set(currentNotes.map((n) => n.noteId));
    // Clean up orphaned graph nodes for deleted notes
    for (const oldNode of previousNodes) {
      if (!validNoteIds.has(oldNode.noteId)) {
        await this.graphRepo.delete(oldNode.graphNodeId);
      }
    }
    // Persist current graph nodes and relationships in small parallel batches
    const existingIds = new Set(previousNodes.map((n) => n.graphNodeId));
    const nodes = graph.getNodes();
    const batchSize = 5;
    for (let i = 0; i < nodes.length; i += batchSize) {
      const chunk = nodes.slice(i, i + batchSize);
      await Promise.all(chunk.map((node) => this.graphRepo.save(node, existingIds.has(node.graphNodeId))));
    }
  }

  public async saveNodePosition(graphNodeId: string, x: number, y: number): Promise<void> {
    await this.graphRepo.updatePosition(graphNodeId, x, y);
  }
}
