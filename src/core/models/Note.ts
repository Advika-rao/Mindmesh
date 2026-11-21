import { ValidationException } from '../exceptions/MindMeshExceptions';
import type { AINoteContext } from '../interfaces/CoreInterfaces';

/**
 * OOP CONCEPTS: Classes & Objects, Encapsulation
 * Note encapsulates private fields (_noteId, _title, _content, _subject, _tags, _embedding)
 * and enforces blueprint-synchronized validation invariants on every mutation.
 */

export interface NoteDTO {
  noteId: string;
  userId: string;
  title: string;
  content: string;
  subject: string;
  tags: string[];
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteVersionDTO {
  versionId: string;
  userId: string;
  noteId: string;
  title: string;
  previousContent: string;
  subject: string;
  updatedAt: Date;
}

export class NoteVersion {
  private readonly _versionId: string;
  private readonly _userId: string;
  private readonly _noteId: string;
  private readonly _title: string;
  private readonly _previousContent: string;
  private readonly _subject: string;
  private readonly _updatedAt: Date;

  constructor(dto: NoteVersionDTO) {
    this._versionId = dto.versionId;
    this._userId = dto.userId;
    this._noteId = dto.noteId;
    this._title = dto.title;
    this._previousContent = dto.previousContent;
    this._subject = dto.subject;
    this._updatedAt = dto.updatedAt;
  }

  get versionId(): string { return this._versionId; }
  get userId(): string { return this._userId; }
  get noteId(): string { return this._noteId; }
  get title(): string { return this._title; }
  get previousContent(): string { return this._previousContent; }
  get subject(): string { return this._subject; }
  get updatedAt(): Date { return this._updatedAt; }

  public toDTO(): NoteVersionDTO {
    return {
      versionId: this._versionId,
      userId: this._userId,
      noteId: this._noteId,
      title: this._title,
      previousContent: this._previousContent,
      subject: this._subject,
      updatedAt: this._updatedAt,
    };
  }
}

export class Note {
  public static readonly MAX_TITLE_LENGTH = 200;
  public static readonly MAX_CONTENT_LENGTH = 50000;
  public static readonly MAX_SUBJECT_LENGTH = 80;
  public static readonly MAX_TAGS = 15;
  public static readonly MAX_TAG_LENGTH = 40;
  public static readonly MAX_EMBEDDING_DIM = 768;

  private readonly _noteId: string;
  private readonly _userId: string;
  private _title: string;
  private _content: string;
  private _subject: string;
  private _tags: string[];
  private _embedding: number[];
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  constructor(dto: NoteDTO) {
    this._noteId = Note.validateId(dto.noteId, 'noteId');
    this._userId = Note.validateId(dto.userId, 'userId');
    this._title = Note.validateText(dto.title, 'title', 1, Note.MAX_TITLE_LENGTH);
    this._content = Note.validateText(dto.content, 'content', 1, Note.MAX_CONTENT_LENGTH);
    this._subject = Note.validateText(dto.subject, 'subject', 1, Note.MAX_SUBJECT_LENGTH);
    this._tags = Note.sanitizeTags(dto.tags);
    this._embedding = Note.sanitizeEmbedding(dto.embedding);
    this._createdAt = dto.createdAt;
    this._updatedAt = dto.updatedAt;
  }

  private static validateId(value: string, field: string): string {
    const trimmed = (value || '').trim();
    if (!trimmed || trimmed.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      throw new ValidationException(`Invalid ${field} format.`, field);
    }
    return trimmed;
  }

  private static validateText(value: string, field: string, min: number, max: number): string {
    const trimmed = (value || '').trim();
    if (trimmed.length < min) {
      throw new ValidationException(`${field} is required.`, field);
    }
    if (trimmed.length > max) {
      return trimmed.slice(0, max);
    }
    return trimmed;
  }

  public static sanitizeTags(tags: string[]): string[] {
    if (!Array.isArray(tags)) return [];
    const unique = new Set<string>();
    for (const raw of tags) {
      const cleaned = raw.trim().slice(0, Note.MAX_TAG_LENGTH);
      if (cleaned.length > 0) unique.add(cleaned);
      if (unique.size >= Note.MAX_TAGS) break;
    }
    return Array.from(unique);
  }

  public static sanitizeEmbedding(embedding: number[]): number[] {
    if (!Array.isArray(embedding)) return [];
    return embedding
      .slice(0, Note.MAX_EMBEDDING_DIM)
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
  }

  get noteId(): string { return this._noteId; }
  get userId(): string { return this._userId; }
  get title(): string { return this._title; }
  get content(): string { return this._content; }
  get subject(): string { return this._subject; }
  get tags(): string[] { return [...this._tags]; }
  get embedding(): number[] { return [...this._embedding]; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }

  public update(params: { title?: string; content?: string; subject?: string; tags?: string[]; embedding?: number[] }): void {
    if (params.title !== undefined) {
      this._title = Note.validateText(params.title, 'title', 1, Note.MAX_TITLE_LENGTH);
    }
    if (params.content !== undefined) {
      this._content = Note.validateText(params.content, 'content', 1, Note.MAX_CONTENT_LENGTH);
    }
    if (params.subject !== undefined) {
      this._subject = Note.validateText(params.subject, 'subject', 1, Note.MAX_SUBJECT_LENGTH);
    }
    if (params.tags !== undefined) {
      this._tags = Note.sanitizeTags(params.tags);
    }
    if (params.embedding !== undefined) {
      this._embedding = Note.sanitizeEmbedding(params.embedding);
    }
    this._updatedAt = new Date();
  }

  public getExcerpt(maxLength = 160): string {
    const plain = this._content.replace(/[#*_`>-]/g, ' ').replace(/\s+/g, ' ').trim();
    return plain.length <= maxLength ? plain : `${plain.slice(0, maxLength).trim()}...`;
  }

  public getWordCount(): number {
    return this._content.trim().split(/\s+/).filter(Boolean).length;
  }

  public getEmbeddingInputText(): string {
    return `Title: ${this._title}\nSubject: ${this._subject}\nTags: ${this._tags.join(', ')}\n\n${this._content.slice(0, 6000)}`;
  }

  public toAIContext(): AINoteContext {
    return {
      noteId: this._noteId,
      title: this._title,
      subject: this._subject,
      tags: [...this._tags],
      content: this._content,
    };
  }

  public toDTO(): NoteDTO {
    return {
      noteId: this._noteId,
      userId: this._userId,
      title: this._title,
      content: this._content,
      subject: this._subject,
      tags: [...this._tags],
      embedding: [...this._embedding],
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }

  public static cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA.length || !vecB.length || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      magA += vecA[i] * vecA[i];
      magB += vecB[i] * vecB[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  public computeLexicalSimilarity(other: Note): number {
    const tokenize = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3)
      );
    const setA = tokenize(`${this._title} ${this._tags.join(' ')} ${this._content.slice(0, 1500)}`);
    const setB = tokenize(`${other.title} ${other.tags.join(' ')} ${other.content.slice(0, 1500)}`);
    if (setA.size === 0 || setB.size === 0) return 0;
    let overlap = 0;
    setA.forEach((word) => {
      if (setB.has(word)) overlap++;
    });
    const union = setA.size + setB.size - overlap;
    return union === 0 ? 0 : overlap / union;
  }

  public getSharedTags(other: Note): string[] {
    const otherSet = new Set(other.tags.map((t) => t.toLowerCase()));
    return this._tags.filter((t) => otherSet.has(t.toLowerCase()));
  }
}
