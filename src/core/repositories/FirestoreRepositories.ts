import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../../firebase/config';
import { handleFirestoreError, OperationType } from '../../firebase/errors';
import type { Repository } from '../interfaces/CoreInterfaces';
import { Note, NoteVersion } from '../models/Note';
import { NoteAttachment, type SupportedAttachmentMime } from '../models/NoteAttachment';
import { GraphNode, type GraphRelationshipDTO } from '../models/KnowledgeGraph';
import { MindMap, type MindMapConnectionDTO, type MindMapNodeDTO } from '../models/MindMap';
import { QuizAttempt, type EvaluatedAnswerDTO, type QuestionDTO, type QuizDifficulty } from '../models/Quiz';
import type {
  ActivityHistoryDTO,
  ActivityType,
  AIConversationDTO,
  ChatMessageDTO,
  RevivedMemoryStateDTO,
  SavedExplanationDTO,
  SavedSnippetDTO,
  UserProfileDTO,
} from '../models/User';

/**
 * OOP CONCEPTS: Abstraction (Repository<T> interface), Inheritance (BaseFirestoreRepository),
 * and Encapsulation of all Firestore read/write/security-rule compliance logic.
 */

export function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

function toDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date();
}

abstract class BaseFirestoreRepository<T> implements Repository<T> {
  protected readonly collectionName: string;

  constructor(collectionName: string) {
    this.collectionName = collectionName;
  }

  protected abstract fromFirestore(data: Record<string, unknown>, id: string): T;

  public async getById(id: string): Promise<T | null> {
    const path = `${this.collectionName}/${id}`;
    try {
      const snap = await getDoc(doc(db, this.collectionName, id));
      if (!snap.exists()) return null;
      return this.fromFirestore(snap.data() as Record<string, unknown>, snap.id);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  }

  public async listByUser(userId: string): Promise<T[]> {
    try {
      const q = query(collection(db, this.collectionName), where('userId', '==', userId));
      const snap = await getDocs(q);
      return snap.docs.map((d) => this.fromFirestore(d.data() as Record<string, unknown>, d.id));
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, this.collectionName);
    }
  }

  public abstract save(entity: T): Promise<void>;

  public async delete(id: string): Promise<void> {
    const path = `${this.collectionName}/${id}`;
    try {
      await deleteDoc(doc(db, this.collectionName, id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  }

  public async deleteAllByUser(userId: string): Promise<number> {
    try {
      const q = query(collection(db, this.collectionName), where('userId', '==', userId));
      const snap = await getDocs(q);
      let deleted = 0;
      const chunks: typeof snap.docs[] = [];
      for (let i = 0; i < snap.docs.length; i += 400) {
        chunks.push(snap.docs.slice(i, i + 400));
      }
      for (const chunk of chunks) {
        const batch = writeBatch(db);
        for (const d of chunk) {
          batch.delete(d.ref);
          deleted++;
        }
        await batch.commit();
      }
      return deleted;
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, this.collectionName);
    }
  }
}

export class UserProfileRepository {
  public async getById(userId: string): Promise<UserProfileDTO | null> {
    try {
      const snap = await getDoc(doc(db, 'users', userId));
      if (!snap.exists()) return null;
      const d = snap.data();
      return {
        userId: String(d.userId || userId),
        name: String(d.name || 'Learner'),
        email: String(d.email || ''),
        profileImage: String(d.profileImage || ''),
        bio: String(d.bio || ''),
        createdAt: toDate(d.createdAt),
        updatedAt: toDate(d.updatedAt),
      };
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `users/${userId}`);
    }
  }

  public async createProfile(params: {
    userId: string;
    name: string;
    email: string;
    profileImage?: string;
    bio?: string;
  }): Promise<void> {
    try {
      await setDoc(doc(db, 'users', params.userId), {
        userId: params.userId,
        name: params.name.trim().slice(0, 120) || 'Learner',
        email: params.email.trim().slice(0, 254),
        profileImage: (params.profileImage || '').slice(0, 1000),
        bio: (params.bio || '').slice(0, 500),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${params.userId}`);
    }
  }

  public async updateProfile(
    userId: string,
    updates: { name: string; profileImage: string; bio: string }
  ): Promise<void> {
    try {
      await updateDoc(doc(db, 'users', userId), {
        name: updates.name.trim().slice(0, 120) || 'Learner',
        profileImage: updates.profileImage.trim().slice(0, 1000),
        bio: updates.bio.trim().slice(0, 500),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${userId}`);
    }
  }

  public async deleteProfile(userId: string): Promise<void> {
    try {
      await deleteDoc(doc(db, 'users', userId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `users/${userId}`);
    }
  }
}

export class NoteRepository extends BaseFirestoreRepository<Note> {
  constructor() {
    super('notes');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): Note {
    return new Note({
      noteId: id,
      userId: String(d.userId || ''),
      title: String(d.title || 'Untitled'),
      content: String(d.content || ' '),
      subject: String(d.subject || 'General'),
      tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
      embedding: Array.isArray(d.embedding) ? (d.embedding as number[]) : [],
      createdAt: toDate(d.createdAt),
      updatedAt: toDate(d.updatedAt),
    });
  }

  public async save(note: Note): Promise<void> {
    const dto = note.toDTO();
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== dto.userId) {
      throw new Error('Authentication required: you can only create notes under your own signed-in account.');
    }
    const cleanTitle = dto.title.trim().slice(0, Note.MAX_TITLE_LENGTH) || 'Untitled';
    const cleanContent = dto.content.trim().slice(0, Note.MAX_CONTENT_LENGTH) || ' ';
    const cleanSubject = dto.subject.trim().slice(0, Note.MAX_SUBJECT_LENGTH) || 'General';
    const cleanTags = Note.sanitizeTags(dto.tags);
    const cleanEmbedding = Note.sanitizeEmbedding(dto.embedding);
    try {
      await setDoc(doc(db, 'notes', dto.noteId), {
        noteId: dto.noteId,
        userId: currentUser.uid,
        title: cleanTitle,
        content: cleanContent,
        subject: cleanSubject,
        tags: cleanTags,
        embedding: cleanEmbedding,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `notes/${dto.noteId}`);
    }
  }

  public async updateNote(note: Note): Promise<void> {
    const dto = note.toDTO();
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== dto.userId) {
      throw new Error('Authentication required: you can only edit notes owned by your signed-in account.');
    }
    const cleanTitle = dto.title.trim().slice(0, Note.MAX_TITLE_LENGTH) || 'Untitled';
    const cleanContent = dto.content.trim().slice(0, Note.MAX_CONTENT_LENGTH) || ' ';
    const cleanSubject = dto.subject.trim().slice(0, Note.MAX_SUBJECT_LENGTH) || 'General';
    const cleanTags = Note.sanitizeTags(dto.tags);
    const cleanEmbedding = Note.sanitizeEmbedding(dto.embedding);
    try {
      await updateDoc(doc(db, 'notes', dto.noteId), {
        title: cleanTitle,
        content: cleanContent,
        subject: cleanSubject,
        tags: cleanTags,
        embedding: cleanEmbedding,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `notes/${dto.noteId}`);
    }
  }
}

export class NoteVersionRepository extends BaseFirestoreRepository<NoteVersion> {
  constructor() {
    super('noteVersions');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): NoteVersion {
    return new NoteVersion({
      versionId: String(d.versionId || id),
      userId: String(d.userId || ''),
      noteId: String(d.noteId || ''),
      title: String(d.title || ''),
      previousContent: String(d.previousContent || ''),
      subject: String(d.subject || 'General'),
      updatedAt: toDate(d.updatedAt),
    });
  }

  public async save(version: NoteVersion): Promise<void> {
    const dto = version.toDTO();
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== dto.userId) {
      throw new Error('Authentication required: cannot save note version for another user.');
    }
    try {
      await setDoc(doc(db, 'noteVersions', dto.versionId), {
        versionId: dto.versionId,
        userId: currentUser.uid,
        noteId: dto.noteId,
        title: dto.title.trim().slice(0, 200) || 'Untitled',
        previousContent: dto.previousContent.trim().slice(0, 50000) || ' ',
        subject: dto.subject.trim().slice(0, 80) || 'General',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `noteVersions/${dto.versionId}`);
    }
  }
}

export class MindMapRepository extends BaseFirestoreRepository<MindMap> {
  constructor() {
    super('mindMaps');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): MindMap {
    return new MindMap({
      mindMapId: String(d.mindMapId || id),
      userId: String(d.userId || ''),
      title: String(d.title || 'Untitled Mind Map'),
      nodes: Array.isArray(d.nodes) ? (d.nodes as MindMapNodeDTO[]) : [],
      connections: Array.isArray(d.connections) ? (d.connections as MindMapConnectionDTO[]) : [],
      sourceNoteIds: Array.isArray(d.sourceNoteIds) ? (d.sourceNoteIds as string[]) : [],
      createdAt: toDate(d.createdAt),
      updatedAt: toDate(d.updatedAt),
    });
  }

  public async save(mindMap: MindMap): Promise<void> {
    const dto = mindMap.toDTO();
    try {
      await setDoc(doc(db, 'mindMaps', dto.mindMapId), {
        mindMapId: dto.mindMapId,
        userId: dto.userId,
        title: dto.title.slice(0, 200),
        nodes: dto.nodes.slice(0, 100),
        connections: dto.connections.slice(0, 150),
        sourceNoteIds: dto.sourceNoteIds.slice(0, 25),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `mindMaps/${dto.mindMapId}`);
    }
  }

  public async updateMindMap(mindMap: MindMap): Promise<void> {
    const dto = mindMap.toDTO();
    try {
      await updateDoc(doc(db, 'mindMaps', dto.mindMapId), {
        title: dto.title.slice(0, 200),
        nodes: dto.nodes.slice(0, 100),
        connections: dto.connections.slice(0, 150),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `mindMaps/${dto.mindMapId}`);
    }
  }
}

export class KnowledgeGraphRepository extends BaseFirestoreRepository<GraphNode> {
  constructor() {
    super('knowledgeGraph');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): GraphNode {
    return new GraphNode({
      graphNodeId: String(d.graphNodeId || id),
      userId: String(d.userId || ''),
      noteId: String(d.noteId || ''),
      concept: String(d.concept || ''),
      subject: String(d.subject || 'General'),
      positionX: Number(d.positionX ?? 0),
      positionY: Number(d.positionY ?? 0),
      relationships: Array.isArray(d.relationships) ? (d.relationships as GraphRelationshipDTO[]) : [],
      updatedAt: toDate(d.updatedAt),
    });
  }

  public async save(node: GraphNode, knownExists?: boolean): Promise<void> {
    const dto = node.toDTO();
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== dto.userId) {
      throw new Error('Authentication required: cannot write knowledge graph node for another user.');
    }

    const ref = doc(db, 'knowledgeGraph', dto.graphNodeId);
    const cleanConcept = dto.concept.trim().slice(0, 200) || 'Untitled';
    const cleanSubject = dto.subject.trim().slice(0, 80) || 'General';
    const cleanX = Number.isFinite(dto.positionX) ? Math.round(dto.positionX) : 0;
    const cleanY = Number.isFinite(dto.positionY) ? Math.round(dto.positionY) : 0;
    const cleanRelationships = Array.isArray(dto.relationships) ? dto.relationships.slice(0, 50) : [];

    const updatePayload = {
      concept: cleanConcept,
      subject: cleanSubject,
      positionX: cleanX,
      positionY: cleanY,
      relationships: cleanRelationships,
      updatedAt: serverTimestamp(),
    };

    const createPayload = {
      graphNodeId: dto.graphNodeId,
      userId: currentUser.uid,
      noteId: dto.noteId,
      ...updatePayload,
    };

    try {
      if (knownExists === true) {
        try {
          await updateDoc(ref, updatePayload);
          return;
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === 'not-found') {
            await setDoc(ref, createPayload);
            return;
          }
          throw err;
        }
      }

      const existing = await getDoc(ref);
      if (existing.exists()) {
        await updateDoc(ref, updatePayload);
      } else {
        await setDoc(ref, createPayload);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `knowledgeGraph/${dto.graphNodeId}`);
    }
  }

  public async updatePosition(graphNodeId: string, x: number, y: number): Promise<void> {
    try {
      await updateDoc(doc(db, 'knowledgeGraph', graphNodeId), {
        positionX: Math.round(x),
        positionY: Math.round(y),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `knowledgeGraph/${graphNodeId}`);
    }
  }
}

export class QuizAttemptRepository extends BaseFirestoreRepository<QuizAttempt> {
  constructor() {
    super('quizAttempts');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): QuizAttempt {
    return new QuizAttempt({
      attemptId: String(d.attemptId || id),
      userId: String(d.userId || ''),
      subject: String(d.subject || 'General'),
      noteIds: Array.isArray(d.noteIds) ? (d.noteIds as string[]) : [],
      questions: Array.isArray(d.questions) ? (d.questions as QuestionDTO[]) : [],
      answers: Array.isArray(d.answers) ? (d.answers as EvaluatedAnswerDTO[]) : [],
      score: Number(d.score ?? 0),
      totalQuestions: Number(d.totalQuestions ?? 1),
      difficulty: (d.difficulty as QuizDifficulty) || 'medium',
      weakTopics: Array.isArray(d.weakTopics) ? (d.weakTopics as string[]) : [],
      completedAt: toDate(d.completedAt),
    });
  }

  public async save(attempt: QuizAttempt): Promise<void> {
    const dto = attempt.toDTO();
    try {
      await setDoc(doc(db, 'quizAttempts', dto.attemptId), {
        attemptId: dto.attemptId,
        userId: dto.userId,
        subject: dto.subject.slice(0, 80),
        noteIds: dto.noteIds.slice(0, 25),
        questions: dto.questions.slice(0, 20),
        answers: dto.answers.slice(0, 20),
        score: Math.min(100, Math.max(0, Math.round(dto.score))),
        totalQuestions: Math.min(20, Math.max(1, dto.totalQuestions)),
        difficulty: dto.difficulty,
        weakTopics: dto.weakTopics.map((t) => t.slice(0, 100)).slice(0, 15),
        completedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `quizAttempts/${dto.attemptId}`);
    }
  }
}

export class AIConversationRepository extends BaseFirestoreRepository<AIConversationDTO> {
  constructor() {
    super('aiConversations');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): AIConversationDTO {
    return {
      conversationId: String(d.conversationId || id),
      userId: String(d.userId || ''),
      title: String(d.title || 'Study Conversation'),
      messages: Array.isArray(d.messages) ? (d.messages as ChatMessageDTO[]) : [],
      savedSnippets: Array.isArray(d.savedSnippets) ? (d.savedSnippets as SavedSnippetDTO[]) : [],
      createdAt: toDate(d.createdAt),
      updatedAt: toDate(d.updatedAt),
    };
  }

  public async save(conv: AIConversationDTO): Promise<void> {
    try {
      await setDoc(doc(db, 'aiConversations', conv.conversationId), {
        conversationId: conv.conversationId,
        userId: conv.userId,
        title: conv.title.slice(0, 200),
        messages: conv.messages.slice(-100),
        savedSnippets: conv.savedSnippets.slice(-50),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `aiConversations/${conv.conversationId}`);
    }
  }

  public async updateConversation(
    conversationId: string,
    updates: { title?: string; messages?: ChatMessageDTO[]; savedSnippets?: SavedSnippetDTO[] }
  ): Promise<void> {
    const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (updates.title !== undefined) payload.title = updates.title.slice(0, 200);
    if (updates.messages !== undefined) payload.messages = updates.messages.slice(-100);
    if (updates.savedSnippets !== undefined) payload.savedSnippets = updates.savedSnippets.slice(-50);
    try {
      await updateDoc(doc(db, 'aiConversations', conversationId), payload);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `aiConversations/${conversationId}`);
    }
  }
}

export class ActivityHistoryRepository extends BaseFirestoreRepository<ActivityHistoryDTO> {
  constructor() {
    super('activityHistory');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): ActivityHistoryDTO {
    return {
      activityId: String(d.activityId || id),
      userId: String(d.userId || ''),
      activityType: (d.activityType as ActivityType) || 'note_created',
      title: String(d.title || 'Activity'),
      description: String(d.description || ''),
      entityId: String(d.entityId || ''),
      timestamp: toDate(d.timestamp),
    };
  }

  public async save(record: ActivityHistoryDTO): Promise<void> {
    try {
      await setDoc(doc(db, 'activityHistory', record.activityId), {
        activityId: record.activityId,
        userId: record.userId,
        activityType: record.activityType,
        title: record.title.slice(0, 200) || 'Activity',
        description: record.description.slice(0, 1000) || 'Recorded learning activity',
        entityId: record.entityId.slice(0, 128),
        timestamp: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `activityHistory/${record.activityId}`);
    }
  }

  public async logActivity(params: {
    userId: string;
    activityType: ActivityType;
    title: string;
    description: string;
    entityId?: string;
  }): Promise<void> {
    const activityId = generateSafeId('act');
    await this.save({
      activityId,
      userId: params.userId,
      activityType: params.activityType,
      title: params.title,
      description: params.description,
      entityId: params.entityId || '',
      timestamp: new Date(),
    });
  }
}

export class RevivedStateRepository extends BaseFirestoreRepository<RevivedMemoryStateDTO> {
  constructor() {
    super('revivedStates');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): RevivedMemoryStateDTO {
    return {
      stateId: String(d.stateId || id),
      userId: String(d.userId || ''),
      sourceNoteId: String(d.sourceNoteId || ''),
      revivedNoteId: String(d.revivedNoteId || ''),
      status: d.status === 'bookmarked' ? 'bookmarked' : 'dismissed',
      reason: String(d.reason || ''),
      updatedAt: toDate(d.updatedAt),
    };
  }

  public async save(state: RevivedMemoryStateDTO): Promise<void> {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid !== state.userId) {
      throw new Error('Authentication required: cannot save revived state for another user.');
    }
    const ref = doc(db, 'revivedStates', state.stateId);
    try {
      const existing = await getDoc(ref);
      if (existing.exists()) {
        await updateDoc(ref, {
          status: state.status,
          reason: state.reason.slice(0, 500),
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          stateId: state.stateId,
          userId: currentUser.uid,
          sourceNoteId: state.sourceNoteId,
          revivedNoteId: state.revivedNoteId,
          status: state.status,
          reason: state.reason.slice(0, 500),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `revivedStates/${state.stateId}`);
    }
  }
}

export class SavedExplanationRepository extends BaseFirestoreRepository<SavedExplanationDTO> {
  constructor() {
    super('savedExplanations');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): SavedExplanationDTO {
    return {
      explanationId: String(d.explanationId || id),
      userId: String(d.userId || ''),
      sourceNodeId: String(d.sourceNodeId || ''),
      targetNodeId: String(d.targetNodeId || ''),
      sourceTitle: String(d.sourceTitle || ''),
      targetTitle: String(d.targetTitle || ''),
      intermediateConcepts: Array.isArray(d.intermediateConcepts) ? (d.intermediateConcepts as string[]) : [],
      explanation: String(d.explanation || ''),
      examples: Array.isArray(d.examples) ? (d.examples as string[]) : [],
      sourceNoteIds: Array.isArray(d.sourceNoteIds) ? (d.sourceNoteIds as string[]) : [],
      createdAt: toDate(d.createdAt),
    };
  }

  public async save(item: SavedExplanationDTO): Promise<void> {
    try {
      await setDoc(doc(db, 'savedExplanations', item.explanationId), {
        explanationId: item.explanationId,
        userId: item.userId,
        sourceNodeId: item.sourceNodeId,
        targetNodeId: item.targetNodeId,
        sourceTitle: item.sourceTitle.slice(0, 200),
        targetTitle: item.targetTitle.slice(0, 200),
        intermediateConcepts: item.intermediateConcepts.map((c) => c.slice(0, 150)).slice(0, 15),
        explanation: item.explanation.slice(0, 10000),
        examples: item.examples.map((e) => e.slice(0, 1000)).slice(0, 10),
        sourceNoteIds: item.sourceNoteIds.slice(0, 20),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `savedExplanations/${item.explanationId}`);
    }
  }
}

export class NoteAttachmentRepository extends BaseFirestoreRepository<NoteAttachment> {
  constructor() {
    super('noteAttachments');
  }

  protected fromFirestore(d: Record<string, unknown>, id: string): NoteAttachment {
    const rawMime = String(d.mimeType || 'image/jpeg');
    const mimeType: SupportedAttachmentMime =
      rawMime === 'image/png' || rawMime === 'image/webp' ? rawMime : 'image/jpeg';
    return new NoteAttachment({
      attachmentId: String(d.attachmentId || id),
      userId: String(d.userId || ''),
      noteId: String(d.noteId || ''),
      fileName: String(d.fileName || 'captured-page.jpg'),
      mimeType,
      dataUrl: String(d.dataUrl || ''),
      sizeBytes: Number(d.sizeBytes ?? 1),
      createdAt: toDate(d.createdAt),
    });
  }

  public async listByNote(userId: string, noteId: string): Promise<NoteAttachment[]> {
    try {
      const q = query(
        collection(db, this.collectionName),
        where('userId', '==', userId),
        where('noteId', '==', noteId)
      );
      const snap = await getDocs(q);
      return snap.docs
        .map((d) => this.fromFirestore(d.data() as Record<string, unknown>, d.id))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, this.collectionName);
    }
  }

  public async save(attachment: NoteAttachment): Promise<void> {
    const dto = attachment.toDTO();
    try {
      await setDoc(doc(db, 'noteAttachments', dto.attachmentId), {
        attachmentId: dto.attachmentId,
        userId: dto.userId,
        noteId: dto.noteId,
        fileName: dto.fileName.slice(0, 200),
        mimeType: dto.mimeType,
        dataUrl: dto.dataUrl,
        sizeBytes: dto.sizeBytes,
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `noteAttachments/${dto.attachmentId}`);
    }
  }

  public async deleteByNoteId(userId: string, noteId: string): Promise<void> {
    const existing = await this.listByNote(userId, noteId);
    for (const att of existing) {
      await this.delete(att.attachmentId);
    }
  }
}
