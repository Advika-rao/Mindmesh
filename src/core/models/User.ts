import type { Note } from './Note';
import type { MindMap } from './MindMap';
import type { QuizAttempt } from './Quiz';

/**
 * OOP CONCEPTS: Encapsulation & Aggregation
 * User aggregates collections of Notes, QuizAttempts, and MindMaps (which exist independently
 * in Firestore collections) and provides workspace-level analytics and accessors.
 */

export interface UserProfileDTO {
  userId: string;
  name: string;
  email: string;
  profileImage: string;
  bio: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ActivityType =
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'note_captured'
  | 'ai_chat'
  | 'quiz_completed'
  | 'mindmap_created'
  | 'memory_revived'
  | 'connection_explained';

export interface ActivityHistoryDTO {
  activityId: string;
  userId: string;
  activityType: ActivityType;
  title: string;
  description: string;
  entityId: string;
  timestamp: Date;
}

export interface ChatMessageDTO {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citedNoteIds: string[];
  insufficientContext?: boolean;
  timestamp: string;
}

export interface SavedSnippetDTO {
  id: string;
  question: string;
  answer: string;
  citedNoteIds: string[];
  savedAt: string;
}

export interface AIConversationDTO {
  conversationId: string;
  userId: string;
  title: string;
  messages: ChatMessageDTO[];
  savedSnippets: SavedSnippetDTO[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RevivedMemoryStateDTO {
  stateId: string;
  userId: string;
  sourceNoteId: string;
  revivedNoteId: string;
  status: 'dismissed' | 'bookmarked';
  reason: string;
  updatedAt: Date;
}

export interface SavedExplanationDTO {
  explanationId: string;
  userId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceTitle: string;
  targetTitle: string;
  intermediateConcepts: string[];
  explanation: string;
  examples: string[];
  sourceNoteIds: string[];
  createdAt: Date;
}

export class User {
  private readonly _userId: string;
  private _name: string;
  private readonly _email: string;
  private _profileImage: string;
  private _bio: string;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  // Aggregation: User manages references to Notes, QuizAttempts, and MindMaps
  private _notes: Note[];
  private _quizAttempts: QuizAttempt[];
  private _mindMaps: MindMap[];

  constructor(
    dto: UserProfileDTO,
    notes: Note[] = [],
    quizAttempts: QuizAttempt[] = [],
    mindMaps: MindMap[] = []
  ) {
    this._userId = dto.userId;
    this._name = dto.name;
    this._email = dto.email;
    this._profileImage = dto.profileImage || '';
    this._bio = dto.bio || '';
    this._createdAt = dto.createdAt;
    this._updatedAt = dto.updatedAt;
    this._notes = [...notes];
    this._quizAttempts = [...quizAttempts];
    this._mindMaps = [...mindMaps];
  }

  get userId(): string { return this._userId; }
  get name(): string { return this._name; }
  get email(): string { return this._email; }
  get profileImage(): string { return this._profileImage; }
  get bio(): string { return this._bio; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }

  get notes(): Note[] { return [...this._notes]; }
  get quizAttempts(): QuizAttempt[] { return [...this._quizAttempts]; }
  get mindMaps(): MindMap[] { return [...this._mindMaps]; }

  public getAverageQuizScore(): number {
    if (this._quizAttempts.length === 0) return 0;
    const sum = this._quizAttempts.reduce((acc, attempt) => acc + attempt.score, 0);
    return Math.round(sum / this._quizAttempts.length);
  }

  public getUniqueSubjects(): string[] {
    return Array.from(new Set(this._notes.map((n) => n.subject))).sort();
  }

  public toDTO(): UserProfileDTO {
    return {
      userId: this._userId,
      name: this._name,
      email: this._email,
      profileImage: this._profileImage,
      bio: this._bio,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
