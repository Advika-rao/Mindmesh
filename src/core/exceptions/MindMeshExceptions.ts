/**
 * OOP CONCEPT: Exception Handling & Inheritance Hierarchy
 * Custom domain-specific exception classes inheriting from MindMeshException
 * allow services and UI layers to handle validation, auth, database, AI,
 * and quiz errors cleanly and polymorphically.
 */

export class MindMeshException extends Error {
  public readonly code: string;
  public readonly timestamp: Date;

  constructor(message: string, code: string = 'MINDMESH_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.timestamp = new Date();
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationException extends MindMeshException {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR');
    this.field = field;
  }
}

export class NoteNotFoundException extends MindMeshException {
  public readonly noteId: string;

  constructor(noteId: string) {
    super(`Note with ID "${noteId}" could not be found in your knowledge repository.`, 'NOTE_NOT_FOUND');
    this.noteId = noteId;
  }
}

export class DatabaseException extends MindMeshException {
  public readonly operation: string;

  constructor(message: string, operation: string) {
    super(message, 'DATABASE_ERROR');
    this.operation = operation;
  }
}

export class AIServiceException extends MindMeshException {
  public readonly statusCode: number;
  public readonly serverCode?: string;
  public readonly debugInfo?: Record<string, unknown>;
  public readonly retryAfterSeconds?: number;
  public readonly isQuotaExhausted: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    serverCode?: string,
    debugInfo?: Record<string, unknown>,
    meta?: { retryAfterSeconds?: number; isQuotaExhausted?: boolean }
  ) {
    super(message, serverCode || 'AI_SERVICE_ERROR');
    this.statusCode = statusCode;
    this.serverCode = serverCode;
    this.debugInfo = debugInfo;
    this.retryAfterSeconds = meta?.retryAfterSeconds;
    this.isQuotaExhausted = Boolean(meta?.isQuotaExhausted || serverCode === 'QUOTA_EXHAUSTED');
  }
}

export class AuthenticationException extends MindMeshException {
  constructor(message: string) {
    super(message, 'AUTH_ERROR');
  }
}

export class QuizSubmissionException extends MindMeshException {
  constructor(message: string) {
    super(message, 'QUIZ_SUBMISSION_ERROR');
  }
}

export type ImageCaptureReasonCode =
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'UNREADABLE_IMAGE'
  | 'INVALID_IMAGE_PAYLOAD'
  | 'EMPTY_EXTRACTION'
  | 'EMPTY_AI_RESPONSE'
  | 'QUALITY_VALIDATION_FAILED'
  | 'MODEL_ERROR'
  | 'PARSING_ERROR'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'API_ERROR'
  | 'PROCESSING_ERROR';

export class ImageCaptureException extends MindMeshException {
  public readonly reasonCode: ImageCaptureReasonCode;
  public readonly debugInfo?: Record<string, unknown>;

  constructor(
    message: string,
    reasonCode: ImageCaptureReasonCode = 'PROCESSING_ERROR',
    debugInfo?: Record<string, unknown>
  ) {
    super(message, `IMAGE_CAPTURE_${reasonCode}`);
    this.reasonCode = reasonCode;
    this.debugInfo = debugInfo;
  }
}
