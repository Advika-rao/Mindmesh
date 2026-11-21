import { BaseFeatureService } from './BaseFeatureService';
import { NoteNotFoundException } from '../exceptions/MindMeshExceptions';
import type { AIProvider, FeatureContext, Searchable } from '../interfaces/CoreInterfaces';
import { Note } from '../models/Note';
import type { RevivedMemoryStateDTO } from '../models/User';
import type {
  ActivityHistoryRepository,
  RevivedStateRepository,
} from '../repositories/FirestoreRepositories';

/**
 * OOP CONCEPTS: Inheritance, Polymorphism, Abstraction (implements Searchable)
 * Feature 6: MemoryRevivalService identifies semantically related older notes
 * while a user studies a topic, prioritizes relevant older memories, filters out
 * dismissed duplicates, and generates contextual "Remember this?" explanations.
 */

export interface MemoryRevivalInput {
  activeNoteId: string;
  allNotes: Note[];
  revivedStates: RevivedMemoryStateDTO[];
  useAIReasons?: boolean;
}

export interface RevivedMemoryItem {
  sourceNoteId: string;
  revivedNote: Note;
  relevanceScore: number;
  reason: string;
  keyTakeaway: string;
  isBookmarked: boolean;
  daysOlder: number;
}

export class MemoryRevivalService
  extends BaseFeatureService<MemoryRevivalInput, RevivedMemoryItem[]>
  implements Searchable<{ context: FeatureContext; query: MemoryRevivalInput }, RevivedMemoryItem>
{
  private readonly revivedRepo: RevivedStateRepository;

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    revivedRepo: RevivedStateRepository
  ) {
    super(aiProvider, activityRepo);
    this.revivedRepo = revivedRepo;
  }

  public getServiceName(): string {
    return 'MemoryRevivalService';
  }

  public async search(input: {
    context: FeatureContext;
    query: MemoryRevivalInput;
  }): Promise<RevivedMemoryItem[]> {
    return this.execute(input.context, input.query);
  }

  public async execute(
    context: FeatureContext,
    input: MemoryRevivalInput
  ): Promise<RevivedMemoryItem[]> {
    this.validateUserContext(context);
    const activeNote = input.allNotes.find((n) => n.noteId === input.activeNoteId);
    if (!activeNote) {
      throw new NoteNotFoundException(input.activeNoteId);
    }

    const dismissedKeys = new Set(
      input.revivedStates
        .filter((s) => s.status === 'dismissed')
        .map((s) => `${s.sourceNoteId}::${s.revivedNoteId}`)
    );
    const bookmarkedMap = new Map(
      input.revivedStates
        .filter((s) => s.status === 'bookmarked')
        .map((s) => [`${s.sourceNoteId}::${s.revivedNoteId}`, s])
    );

    // Rank other notes prioritizing older notes that are semantically/conceptually related
    const candidates = input.allNotes
      .filter((other) => other.noteId !== activeNote.noteId)
      .filter((other) => !dismissedKeys.has(`${activeNote.noteId}::${other.noteId}`))
      .map((other) => {
        const semantic = Note.cosineSimilarity(activeNote.embedding, other.embedding);
        const lexical = activeNote.computeLexicalSimilarity(other);
        const sharedTags = activeNote.getSharedTags(other);
        const sameSubject = activeNote.subject.toLowerCase() === other.subject.toLowerCase();

        const msOlder = activeNote.updatedAt.getTime() - other.createdAt.getTime();
        const daysOlder = Math.max(0, Math.round(msOlder / (1000 * 60 * 60 * 24)));
        // Slight recency inversion boost so genuinely older notes surface as "Revived Memories"
        const agePriorityBoost = msOlder > 0 ? Math.min(0.12, (daysOlder / 30) * 0.08 + 0.04) : 0;

        const baseRel =
          (semantic > 0 ? semantic * 0.65 : lexical * 0.7) +
          lexical * 0.2 +
          Math.min(sharedTags.length * 0.14, 0.28) +
          (sameSubject ? 0.12 : 0);

        const totalScore = Math.min(1, baseRel + agePriorityBoost);
        return {
          note: other,
          baseRel,
          totalScore,
          sharedTags,
          sameSubject,
          daysOlder,
        };
      })
      .filter((c) => c.baseRel >= 0.22 || c.sharedTags.length > 0 || c.sameSubject)
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 5);

    if (candidates.length === 0) return [];

    // Request contextual AI reasons when enabled
    let aiReasons = new Map<string, { reason: string; keyTakeaway: string }>();
    if (input.useAIReasons !== false) {
      try {
        const aiResult = await this.aiProvider.analyzeMemoryRevival({
          currentNote: activeNote.toAIContext(),
          candidateNotes: candidates.map((c) => ({
            ...c.note.toAIContext(),
            similarity: c.totalScore,
          })),
        });
        for (const rev of aiResult.revivals || []) {
          aiReasons.set(rev.noteId, {
            reason: rev.reason,
            keyTakeaway: rev.keyTakeaway,
          });
        }
      } catch {
        // Gracefully fall back to deterministic reason summary if AI is temporarily unavailable
      }
    }

    return candidates.map((c) => {
      const key = `${activeNote.noteId}::${c.note.noteId}`;
      const existingBookmark = bookmarkedMap.get(key);
      const aiEntry = aiReasons.get(c.note.noteId);

      const fallbackReason =
        c.sharedTags.length > 0
          ? `Remember this? You previously studied "${c.note.title}", which shares concepts (${c.sharedTags.join(', ')}) relevant to "${activeNote.title}".`
          : `Remember this? Your earlier note "${c.note.title}" in ${c.note.subject} builds conceptual background for "${activeNote.title}".`;

      return {
        sourceNoteId: activeNote.noteId,
        revivedNote: c.note,
        relevanceScore: Math.round(c.totalScore * 100),
        reason: aiEntry?.reason || existingBookmark?.reason || fallbackReason,
        keyTakeaway: aiEntry?.keyTakeaway || c.note.getExcerpt(120),
        isBookmarked: Boolean(existingBookmark),
        daysOlder: c.daysOlder,
      };
    });
  }

  public async setMemoryStatus(params: {
    userId: string;
    sourceNoteId: string;
    revivedNoteId: string;
    revivedNoteTitle: string;
    status: 'dismissed' | 'bookmarked';
    reason: string;
  }): Promise<void> {
    const stateId = `rev-${params.sourceNoteId}-${params.revivedNoteId}`.slice(0, 128);
    await this.revivedRepo.save({
      stateId,
      userId: params.userId,
      sourceNoteId: params.sourceNoteId,
      revivedNoteId: params.revivedNoteId,
      status: params.status,
      reason: params.reason,
      updatedAt: new Date(),
    });

    await this.activityRepo.logActivity({
      userId: params.userId,
      activityType: 'memory_revived',
      title:
        params.status === 'bookmarked'
          ? `Bookmarked Revived Memory: ${params.revivedNoteTitle}`
          : `Dismissed Revived Memory: ${params.revivedNoteTitle}`,
      description: params.reason.slice(0, 400),
      entityId: params.revivedNoteId,
    });
  }

  public async removeStatus(stateId: string): Promise<void> {
    await this.revivedRepo.delete(stateId);
  }
}
