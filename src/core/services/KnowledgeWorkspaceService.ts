import { ServerAIProvider } from '../providers/ServerAIProvider';
import {
  ActivityHistoryRepository,
  AIConversationRepository,
  generateSafeId,
  KnowledgeGraphRepository,
  MindMapRepository,
  NoteAttachmentRepository,
  NoteRepository,
  NoteVersionRepository,
  QuizAttemptRepository,
  RevivedStateRepository,
  SavedExplanationRepository,
  UserProfileRepository,
} from '../repositories/FirestoreRepositories';
import { Note, NoteVersion } from '../models/Note';
import type { GraphNode } from '../models/KnowledgeGraph';
import { BrainGraphService } from './BrainGraphService';
import { StudyAssistantService } from './StudyAssistantService';
import { MindMapService } from './MindMapService';
import { QuizGeneratorService } from './QuizGeneratorService';
import { MemoryRevivalService } from './MemoryRevivalService';
import { ConnectionExplanationService } from './ConnectionExplanationService';
import { SmartNoteCaptureService, type PreparedCaptureImage } from './SmartNoteCaptureService';
import type { BaseFeatureService } from './BaseFeatureService';

/**
 * OOP CONCEPT: Facade / Coordinator + Polymorphism
 * KnowledgeWorkspaceService wires together all 11 Firestore Repositories,
 * the ServerAIProvider, and all 7 polymorphic BaseFeatureService subclasses so that
 * every note mutation automatically updates embeddings, version snapshots, optional
 * retained image attachments, Brain Graph connections, and learning activity history
 * in one central personal knowledge repository.
 */
export class KnowledgeWorkspaceService {
  public readonly aiProvider = new ServerAIProvider();

  // Repositories
  public readonly userRepo = new UserProfileRepository();
  public readonly noteRepo = new NoteRepository();
  public readonly noteVersionRepo = new NoteVersionRepository();
  public readonly noteAttachmentRepo = new NoteAttachmentRepository();
  public readonly mindMapRepo = new MindMapRepository();
  public readonly graphRepo = new KnowledgeGraphRepository();
  public readonly quizRepo = new QuizAttemptRepository();
  public readonly conversationRepo = new AIConversationRepository();
  public readonly activityRepo = new ActivityHistoryRepository();
  public readonly revivedRepo = new RevivedStateRepository();
  public readonly explanationRepo = new SavedExplanationRepository();

  // Feature Services inheriting from BaseFeatureService
  public readonly brainGraphService: BrainGraphService;
  public readonly studyAssistantService: StudyAssistantService;
  public readonly mindMapService: MindMapService;
  public readonly quizGeneratorService: QuizGeneratorService;
  public readonly memoryRevivalService: MemoryRevivalService;
  public readonly connectionExplanationService: ConnectionExplanationService;
  public readonly smartNoteCaptureService: SmartNoteCaptureService;

  constructor() {
    this.brainGraphService = new BrainGraphService(this.aiProvider, this.activityRepo, this.graphRepo);
    this.studyAssistantService = new StudyAssistantService(
      this.aiProvider,
      this.activityRepo,
      this.conversationRepo
    );
    this.mindMapService = new MindMapService(this.aiProvider, this.activityRepo, this.mindMapRepo);
    this.quizGeneratorService = new QuizGeneratorService(this.aiProvider, this.activityRepo, this.quizRepo);
    this.memoryRevivalService = new MemoryRevivalService(
      this.aiProvider,
      this.activityRepo,
      this.revivedRepo
    );
    this.connectionExplanationService = new ConnectionExplanationService(
      this.aiProvider,
      this.activityRepo,
      this.explanationRepo
    );
    this.smartNoteCaptureService = new SmartNoteCaptureService(
      this.aiProvider,
      this.activityRepo,
      this.noteAttachmentRepo
    );
  }

  /**
   * Polymorphic accessor returning all registered feature services as their common BaseFeatureService type.
   */
  public getRegisteredServices(): BaseFeatureService<unknown, unknown>[] {
    return [
      this.brainGraphService as BaseFeatureService<unknown, unknown>,
      this.studyAssistantService as BaseFeatureService<unknown, unknown>,
      this.mindMapService as BaseFeatureService<unknown, unknown>,
      this.quizGeneratorService as BaseFeatureService<unknown, unknown>,
      this.memoryRevivalService as BaseFeatureService<unknown, unknown>,
      this.connectionExplanationService as BaseFeatureService<unknown, unknown>,
      this.smartNoteCaptureService as BaseFeatureService<unknown, unknown>,
    ];
  }

  /**
   * Creates a new note, computes its semantic embedding, persists to Firestore,
   * syncs Brain Graph connections, and logs activity history.
   */
  public async createNote(params: {
    userId: string;
    title: string;
    content: string;
    subject: string;
    tags: string[];
    existingNotes: Note[];
    existingGraphNodes: GraphNode[];
    attachments?: PreparedCaptureImage[];
    isSmartCapture?: boolean;
  }): Promise<Note> {
    const noteId = generateSafeId('note');
    const draft = new Note({
      noteId,
      userId: params.userId,
      title: params.title,
      content: params.content,
      subject: params.subject,
      tags: params.tags,
      embedding: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let embedding: number[] = [];
    try {
      embedding = await this.aiProvider.generateEmbedding(draft.getEmbeddingInputText());
    } catch {
      embedding = [];
    }

    draft.update({ embedding });
    await this.noteRepo.save(draft);

    // Optionally persist private source images attached to this note
    if (params.attachments && params.attachments.length > 0) {
      await this.smartNoteCaptureService.saveAttachmentsForNote({
        userId: params.userId,
        noteId: draft.noteId,
        images: params.attachments,
      });
    }

    await this.activityRepo.logActivity({
      userId: params.userId,
      activityType: params.isSmartCapture ? 'note_captured' : 'note_created',
      title: params.isSmartCapture
        ? `Captured note from image: ${draft.title}`
        : `Created note: ${draft.title}`,
      description: params.isSmartCapture
        ? `Extracted into ${draft.subject} (${draft.getWordCount()} words)${
            params.attachments && params.attachments.length > 0
              ? ` with ${params.attachments.length} retained image(s)`
              : ''
          }.`
        : `Saved in ${draft.subject} (${draft.getWordCount()} words).`,
      entityId: draft.noteId,
    });

    // Refresh Brain Graph connections in Firestore
    const updatedNotes = [draft, ...params.existingNotes];
    await this.brainGraphService.execute(
      { userId: params.userId },
      { notes: updatedNotes, existingGraphNodes: params.existingGraphNodes, persistToFirestore: true }
    );

    return draft;
  }

  /**
   * Updates an existing note, saves an immutable NoteVersion snapshot of the previous content,
   * refreshes semantic embedding, and recalculates Brain Graph connections.
   */
  public async updateNote(params: {
    userId: string;
    originalNote: Note;
    title: string;
    content: string;
    subject: string;
    tags: string[];
    allNotes: Note[];
    existingGraphNodes: GraphNode[];
    attachments?: PreparedCaptureImage[];
  }): Promise<Note> {
    if (params.originalNote.userId !== params.userId) {
      throw new Error('Permission denied: you can only edit notes belonging to your own account.');
    }

    // 1. Build updated note + refreshed embedding
    const updated = new Note({
      ...params.originalNote.toDTO(),
      userId: params.userId,
      title: params.title,
      content: params.content,
      subject: params.subject,
      tags: params.tags,
      updatedAt: new Date(),
    });

    let embedding = params.originalNote.embedding;
    try {
      embedding = await this.aiProvider.generateEmbedding(updated.getEmbeddingInputText());
    } catch {
      // Keep prior embedding if embedding service is temporarily unreachable
    }
    updated.update({ embedding });

    // 2. Persist the primary note update in Firestore first so user edits always save cleanly
    await this.noteRepo.updateNote(updated);

    // 3. Save immutable revision snapshot of the previous version
    const version = new NoteVersion({
      versionId: generateSafeId('ver'),
      userId: params.userId,
      noteId: params.originalNote.noteId,
      title: params.originalNote.title,
      previousContent: params.originalNote.content,
      subject: params.originalNote.subject,
      updatedAt: new Date(),
    });
    await this.noteVersionRepo.save(version);

    if (params.attachments && params.attachments.length > 0) {
      await this.smartNoteCaptureService.saveAttachmentsForNote({
        userId: params.userId,
        noteId: updated.noteId,
        images: params.attachments,
      });
    }

    await this.activityRepo.logActivity({
      userId: params.userId,
      activityType: 'note_updated',
      title: `Updated note: ${updated.title}`,
      description: `Revised in ${updated.subject} and saved revision snapshot.`,
      entityId: updated.noteId,
    });

    // 4. Refresh Brain Graph connections
    const nextNotes = params.allNotes.map((n) => (n.noteId === updated.noteId ? updated : n));
    await this.brainGraphService.execute(
      { userId: params.userId },
      { notes: nextNotes, existingGraphNodes: params.existingGraphNodes, persistToFirestore: true }
    );

    return updated;
  }

  /**
   * Deletes a note, removes its graph node, recalculates connections, and logs history.
   */
  public async deleteNote(params: {
    userId: string;
    note: Note;
    allNotes: Note[];
    existingGraphNodes: GraphNode[];
  }): Promise<void> {
    await this.noteAttachmentRepo.deleteByNoteId(params.userId, params.note.noteId);
    await this.noteRepo.delete(params.note.noteId);

    const remainingNotes = params.allNotes.filter((n) => n.noteId !== params.note.noteId);
    await this.brainGraphService.execute(
      { userId: params.userId },
      { notes: remainingNotes, existingGraphNodes: params.existingGraphNodes, persistToFirestore: true }
    );

    await this.activityRepo.logActivity({
      userId: params.userId,
      activityType: 'note_deleted',
      title: `Deleted note: ${params.note.title}`,
      description: `Removed from ${params.note.subject} and refreshed Brain Graph.`,
      entityId: params.note.noteId,
    });
  }

  public async clearActivityHistory(userId: string): Promise<number> {
    return this.activityRepo.deleteAllByUser(userId);
  }

  /**
   * Permanently deletes all Firestore data owned by the user (used during account deletion).
   */
  public async deleteAllUserData(userId: string): Promise<void> {
    await Promise.all([
      this.noteVersionRepo.deleteAllByUser(userId),
      this.noteAttachmentRepo.deleteAllByUser(userId),
      this.graphRepo.deleteAllByUser(userId),
      this.mindMapRepo.deleteAllByUser(userId),
      this.quizRepo.deleteAllByUser(userId),
      this.conversationRepo.deleteAllByUser(userId),
      this.activityRepo.deleteAllByUser(userId),
      this.revivedRepo.deleteAllByUser(userId),
      this.explanationRepo.deleteAllByUser(userId),
    ]);
    await this.noteRepo.deleteAllByUser(userId);
    await this.userRepo.deleteProfile(userId);
  }
}

export const workspaceService = new KnowledgeWorkspaceService();
