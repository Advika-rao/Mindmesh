import { BaseFeatureService } from './BaseFeatureService';
import { NoteNotFoundException, ValidationException } from '../exceptions/MindMeshExceptions';
import type { AIProvider, Explainable, FeatureContext } from '../interfaces/CoreInterfaces';
import { Note } from '../models/Note';
import type { KnowledgeGraph } from '../models/KnowledgeGraph';
import type { SavedExplanationDTO } from '../models/User';
import {
  generateSafeId,
  type ActivityHistoryRepository,
  type SavedExplanationRepository,
} from '../repositories/FirestoreRepositories';

/**
 * OOP CONCEPTS: Inheritance, Polymorphism, Abstraction (implements Explainable)
 * Feature 7: ConnectionExplanationService bridges Brain Graph topology (BFS shortest path)
 * with Gemini reasoning to explain how two concepts in the user's knowledge graph relate.
 */

export interface ExplainConnectionInput {
  sourceNoteId: string;
  targetNoteId: string;
  allNotes: Note[];
  graph: KnowledgeGraph;
}

export interface ConnectionExplanationResult {
  sourceNote: Note;
  targetNote: Note;
  intermediateNotes: Note[];
  pathNoteIds: string[];
  summary: string;
  explanation: string;
  intermediateConcepts: string[];
  examples: string[];
  connectionStrengthNote: string;
  similarityScore: number;
  sharedTags: string[];
}

export class ConnectionExplanationService
  extends BaseFeatureService<ExplainConnectionInput, ConnectionExplanationResult>
  implements Explainable<{ context: FeatureContext; input: ExplainConnectionInput }, ConnectionExplanationResult>
{
  private readonly explanationRepo: SavedExplanationRepository;

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    explanationRepo: SavedExplanationRepository
  ) {
    super(aiProvider, activityRepo);
    this.explanationRepo = explanationRepo;
  }

  public getServiceName(): string {
    return 'ConnectionExplanationService';
  }

  public async explain(params: {
    context: FeatureContext;
    input: ExplainConnectionInput;
  }): Promise<ConnectionExplanationResult> {
    return this.execute(params.context, params.input);
  }

  public async execute(
    context: FeatureContext,
    input: ExplainConnectionInput
  ): Promise<ConnectionExplanationResult> {
    this.validateUserContext(context);
    if (input.sourceNoteId === input.targetNoteId) {
      throw new ValidationException('Select two different concepts to explain their connection.', 'targetNoteId');
    }

    const noteMap = new Map(input.allNotes.map((n) => [n.noteId, n]));
    const sourceNote = noteMap.get(input.sourceNoteId);
    const targetNote = noteMap.get(input.targetNoteId);
    if (!sourceNote) throw new NoteNotFoundException(input.sourceNoteId);
    if (!targetNote) throw new NoteNotFoundException(input.targetNoteId);

    // Discover shortest path through Brain Graph using BFS
    const pathNoteIds = input.graph.findShortestPath(sourceNote.noteId, targetNote.noteId);
    const intermediateIds =
      pathNoteIds.length > 2 ? pathNoteIds.slice(1, pathNoteIds.length - 1) : [];
    const intermediateNotes = intermediateIds
      .map((id) => noteMap.get(id))
      .filter((n): n is Note => Boolean(n));

    const sharedTags = sourceNote.getSharedTags(targetNote);
    const semantic = Note.cosineSimilarity(sourceNote.embedding, targetNote.embedding);
    const lexical = sourceNote.computeLexicalSimilarity(targetNote);
    const similarityScore = semantic > 0 ? semantic : lexical;

    const aiExplanation = await this.aiProvider.explainConnection({
      sourceNote: sourceNote.toAIContext(),
      targetNote: targetNote.toAIContext(),
      intermediateNotes: intermediateNotes.map((n) => n.toAIContext()),
      sharedTags,
      similarityScore,
    });

    await this.activityRepo.logActivity({
      userId: context.userId,
      activityType: 'connection_explained',
      title: `Explained: ${sourceNote.title} → ${targetNote.title}`,
      description: aiExplanation.summary.slice(0, 400),
      entityId: `${sourceNote.noteId}`,
    });

    return {
      sourceNote,
      targetNote,
      intermediateNotes,
      pathNoteIds: pathNoteIds.length > 0 ? pathNoteIds : [sourceNote.noteId, targetNote.noteId],
      summary: aiExplanation.summary,
      explanation: aiExplanation.explanation,
      intermediateConcepts: aiExplanation.intermediateConcepts || [],
      examples: aiExplanation.examples || [],
      connectionStrengthNote: aiExplanation.connectionStrengthNote || '',
      similarityScore,
      sharedTags,
    };
  }

  public async saveExplanation(
    userId: string,
    result: ConnectionExplanationResult
  ): Promise<SavedExplanationDTO> {
    const record: SavedExplanationDTO = {
      explanationId: generateSafeId('exp'),
      userId,
      sourceNodeId: result.sourceNote.noteId,
      targetNodeId: result.targetNote.noteId,
      sourceTitle: result.sourceNote.title,
      targetTitle: result.targetNote.title,
      intermediateConcepts: result.intermediateConcepts,
      explanation: `${result.summary}\n\n${result.explanation}`,
      examples: result.examples,
      sourceNoteIds: [
        result.sourceNote.noteId,
        ...result.intermediateNotes.map((n) => n.noteId),
        result.targetNote.noteId,
      ],
      createdAt: new Date(),
    };

    await this.explanationRepo.save(record);
    return record;
  }

  public async deleteSavedExplanation(explanationId: string): Promise<void> {
    await this.explanationRepo.delete(explanationId);
  }
}
