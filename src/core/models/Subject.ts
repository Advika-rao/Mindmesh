import type { Note } from './Note';

/**
 * OOP CONCEPT: Classes & Objects, Encapsulation
 * Subject models a knowledge domain grouping notes and computing topic-level metrics.
 */
export class Subject {
  private readonly _name: string;
  private readonly _notes: Note[];
  private readonly _colorHex: string;

  private static readonly PALETTE = [
    '#6366f1', // Indigo
    '#8b5cf6', // Violet
    '#3b82f6', // Blue
    '#0ea5e9', // Sky
    '#14b8a6', // Teal
    '#a855f7', // Purple
    '#ec4899', // Pink
    '#f59e0b', // Amber
  ];

  constructor(name: string, notes: Note[] = []) {
    this._name = name.trim() || 'General';
    this._notes = [...notes];
    this._colorHex = Subject.resolveColor(this._name);
  }

  public static resolveColor(subjectName: string): string {
    let hash = 0;
    for (let i = 0; i < subjectName.length; i++) {
      hash = (hash << 5) - hash + subjectName.charCodeAt(i);
      hash |= 0;
    }
    return Subject.PALETTE[Math.abs(hash) % Subject.PALETTE.length];
  }

  get name(): string { return this._name; }
  get notes(): Note[] { return [...this._notes]; }
  get colorHex(): string { return this._colorHex; }
  get noteCount(): number { return this._notes.length; }

  public getUniqueTags(): string[] {
    const tags = new Set<string>();
    for (const note of this._notes) {
      for (const tag of note.tags) tags.add(tag);
    }
    return Array.from(tags);
  }

  public getLastUpdated(): Date | null {
    if (this._notes.length === 0) return null;
    return this._notes.reduce(
      (latest, note) => (note.updatedAt > latest ? note.updatedAt : latest),
      this._notes[0].updatedAt
    );
  }

  public static groupNotesBySubject(notes: Note[]): Subject[] {
    const map = new Map<string, Note[]>();
    for (const note of notes) {
      const key = note.subject || 'General';
      const bucket = map.get(key) ?? [];
      bucket.push(note);
      map.set(key, bucket);
    }
    return Array.from(map.entries())
      .map(([name, grouped]) => new Subject(name, grouped))
      .sort((a, b) => b.noteCount - a.noteCount || a.name.localeCompare(b.name));
  }
}
