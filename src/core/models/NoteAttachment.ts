import { ValidationException } from '../exceptions/MindMeshExceptions';

/**
 * OOP CONCEPT: Classes & Objects, Encapsulation
 * NoteAttachment encapsulates an optionally retained private source image
 * linked to a Note captured via Smart Note Capture, enforcing blueprint volumetric limits.
 */

export type SupportedAttachmentMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface NoteAttachmentDTO {
  attachmentId: string;
  userId: string;
  noteId: string;
  fileName: string;
  mimeType: SupportedAttachmentMime;
  dataUrl: string;
  sizeBytes: number;
  createdAt: Date;
}

export class NoteAttachment {
  public static readonly MAX_DATA_URL_LENGTH = 250000;
  public static readonly MAX_FILE_NAME_LENGTH = 200;
  public static readonly ALLOWED_MIMES: readonly SupportedAttachmentMime[] = [
    'image/jpeg',
    'image/png',
    'image/webp',
  ];

  private readonly _attachmentId: string;
  private readonly _userId: string;
  private readonly _noteId: string;
  private readonly _fileName: string;
  private readonly _mimeType: SupportedAttachmentMime;
  private readonly _dataUrl: string;
  private readonly _sizeBytes: number;
  private readonly _createdAt: Date;

  constructor(dto: NoteAttachmentDTO) {
    if (!dto.attachmentId || !/^[a-zA-Z0-9_-]+$/.test(dto.attachmentId)) {
      throw new ValidationException('Invalid attachmentId.', 'attachmentId');
    }
    if (!dto.userId || !/^[a-zA-Z0-9_-]+$/.test(dto.userId)) {
      throw new ValidationException('Invalid userId.', 'userId');
    }
    if (!dto.noteId || !/^[a-zA-Z0-9_-]+$/.test(dto.noteId)) {
      throw new ValidationException('Invalid noteId.', 'noteId');
    }
    if (!NoteAttachment.ALLOWED_MIMES.includes(dto.mimeType)) {
      throw new ValidationException(`Unsupported attachment MIME type: ${dto.mimeType}`, 'mimeType');
    }
    if (!dto.dataUrl || dto.dataUrl.length > NoteAttachment.MAX_DATA_URL_LENGTH) {
      throw new ValidationException('Compressed image exceeds Firestore attachment size limit.', 'dataUrl');
    }

    this._attachmentId = dto.attachmentId;
    this._userId = dto.userId;
    this._noteId = dto.noteId;
    this._fileName = (dto.fileName || 'captured-page.jpg').trim().slice(0, NoteAttachment.MAX_FILE_NAME_LENGTH);
    this._mimeType = dto.mimeType;
    this._dataUrl = dto.dataUrl;
    this._sizeBytes = Math.min(NoteAttachment.MAX_DATA_URL_LENGTH, Math.max(1, Math.round(dto.sizeBytes)));
    this._createdAt = dto.createdAt;
  }

  get attachmentId(): string { return this._attachmentId; }
  get userId(): string { return this._userId; }
  get noteId(): string { return this._noteId; }
  get fileName(): string { return this._fileName; }
  get mimeType(): SupportedAttachmentMime { return this._mimeType; }
  get dataUrl(): string { return this._dataUrl; }
  get sizeBytes(): number { return this._sizeBytes; }
  get createdAt(): Date { return this._createdAt; }

  public toDTO(): NoteAttachmentDTO {
    return {
      attachmentId: this._attachmentId,
      userId: this._userId,
      noteId: this._noteId,
      fileName: this._fileName,
      mimeType: this._mimeType,
      dataUrl: this._dataUrl,
      sizeBytes: this._sizeBytes,
      createdAt: this._createdAt,
    };
  }
}
