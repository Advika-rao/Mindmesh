import type { NoteDTO } from '../models/Note';

const GENERIC_TITLE_PATTERNS: RegExp[] = [
  /^captured\s+notes?(\s*\([^)]*\))?(\s*#?\d+)?$/i,
  /^scanned\s+notes?(\s*\([^)]*\))?(\s*#?\d+)?$/i,
  /^handwritten\s+notes?(\s*\([^)]*\))?(\s*#?\d+)?$/i,
  /^uploaded\s+notes?(\s*\([^)]*\))?(\s*#?\d+)?$/i,
  /^class\s+notes?(\s*\([^)]*\))?(\s*#?\d+)?$/i,
  /^notes?(\s*\([^)]*\))?(\s*#?\d+)?$/i,
  /^untitled(\s+note)?(\s*#?\d+)?$/i,
  /^new\s+note(\s*#?\d+)?$/i,
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^document(\s*#?\d+)?$/i,
];

const GENERIC_LINE_PATTERNS: RegExp[] = [
  /^page\s+\d+(\s+of\s+\d+)?[:\-–—\s]*$/i,
  /^captured\s+notes?(\s*\([^)]*\))?$/i,
  /^date\s*[:\-]/i,
  /^name\s*[:\-]/i,
  /^[-*_|:=\s]+$/,
];

const GENERIC_SUBJECTS = new Set([
  'general',
  'notes',
  'captured notes',
  'uncategorized',
  'other',
  'misc',
  'study',
]);

export function isGenericNoteTitle(title?: string | null): boolean {
  const cleaned = (title ?? '').trim();
  if (!cleaned || cleaned.length < 2) return true;
  return GENERIC_TITLE_PATTERNS.some((rx) => rx.test(cleaned));
}

function stripMarkdownDecorators(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*•+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(?:topic|title|chapter|unit|lecture|section)\s*[:\-–—]\s*/i, '')
    .replace(/[:\-–—\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitleFromContent(content?: string | null): string | null {
  const raw = (content ?? '').trim();
  if (!raw) return null;

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Pass 1: Prefer an explicit Markdown heading (#, ##, ###)
  for (const line of lines.slice(0, 25)) {
    if (!/^#{1,3}\s+/.test(line)) continue;
    const candidate = stripMarkdownDecorators(line);
    if (
      candidate.length >= 3 &&
      candidate.length <= 90 &&
      !isGenericNoteTitle(candidate) &&
      !GENERIC_LINE_PATTERNS.some((rx) => rx.test(candidate))
    ) {
      return candidate;
    }
  }

  // Pass 2: Look for a short, clean opening title/topic line
  for (const line of lines.slice(0, 12)) {
    if (GENERIC_LINE_PATTERNS.some((rx) => rx.test(line))) continue;
    const candidate = stripMarkdownDecorators(line);
    if (
      candidate.length >= 4 &&
      candidate.length <= 72 &&
      !isGenericNoteTitle(candidate) &&
      !/[.!?]$/.test(candidate)
    ) {
      return candidate;
    }
  }

  // Pass 3: Fall back to a cleanly trimmed opening phrase
  for (const line of lines.slice(0, 8)) {
    if (GENERIC_LINE_PATTERNS.some((rx) => rx.test(line))) continue;
    const candidate = stripMarkdownDecorators(line);
    if (candidate.length >= 4 && !isGenericNoteTitle(candidate)) {
      return candidate.length > 64 ? `${candidate.slice(0, 61).trimEnd()}...` : candidate;
    }
  }

  return null;
}

/**
 * Returns the real, meaningful note title for display and AI context.
 * Avoids showing generic placeholder titles like "Captured Notes (date)" whenever
 * a real heading, topic, or tag-derived title is available in the note.
 */
export function resolveNoteDisplayTitle(
  note: Pick<NoteDTO, 'title' | 'content' | 'subject' | 'tags'>
): string {
  const rawTitle = (note.title ?? '').trim();
  if (rawTitle && !isGenericNoteTitle(rawTitle)) {
    return rawTitle;
  }

  const fromContent = extractTitleFromContent(note.content);
  if (fromContent) {
    return fromContent;
  }

  const meaningfulTags = (Array.isArray(note.tags) ? note.tags : [])
    .map((t) => String(t).trim())
    .filter((t) => t.length >= 2 && !isGenericNoteTitle(t) && !GENERIC_SUBJECTS.has(t.toLowerCase()));

  if (meaningfulTags.length > 0) {
    const formatted = meaningfulTags
      .slice(0, 2)
      .map((t) =>
        t
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (ch) => ch.toUpperCase())
      )
      .join(' & ');
    if (formatted) return formatted;
  }

  const subject = (note.subject ?? '').trim();
  if (subject && !GENERIC_SUBJECTS.has(subject.toLowerCase()) && !isGenericNoteTitle(subject)) {
    return `${subject} Notes`;
  }

  return rawTitle || 'Untitled Note';
}

/**
 * Produces a stable normalized fingerprint of a note's content so exact duplicate
 * copies of the same captured note can be collapsed cleanly.
 */
export function getNoteContentFingerprint(
  note: Pick<NoteDTO, 'content' | 'title'>
): string {
  const normalizedContent = (note.content ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 280);

  if (normalizedContent.length >= 40) {
    return `c:${normalizedContent}`;
  }

  const normalizedTitle = (note.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `t:${normalizedTitle}|${normalizedContent}`;
}

export interface ResolvedSourceNote {
  noteId: string;
  displayTitle: string;
  subject: string;
  note: NoteDTO;
}

/**
 * Deduplicates cited source notes by noteId AND near-identical content, resolves
 * real meaningful titles instead of generic "Captured Notes" placeholders, and
 * disambiguates genuinely distinct notes that happen to share the same title.
 */
export function deduplicateSourceNotes(
  citedNoteIds: string[],
  noteMap: Map<string, NoteDTO>
): ResolvedSourceNote[] {
  const seenIds = new Set<string>();
  const uniqueById: NoteDTO[] = [];

  for (const rawId of citedNoteIds || []) {
    const id = String(rawId || '').trim();
    if (!id || seenIds.has(id)) continue;
    const note = noteMap.get(id);
    if (!note) continue;
    seenIds.add(id);
    uniqueById.push(note);
  }

  // Collapse duplicate saved copies with identical normalized content
  const byFingerprint = new Map<string, NoteDTO>();
  const orderedFingerprints: string[] = [];

  for (const note of uniqueById) {
    const fp = getNoteContentFingerprint(note);
    const existing = byFingerprint.get(fp);
    if (!existing) {
      byFingerprint.set(fp, note);
      orderedFingerprints.push(fp);
    } else {
      // Prefer whichever copy has a real (non-generic) saved title, or longer content
      const existingGeneric = isGenericNoteTitle(existing.title);
      const currentGeneric = isGenericNoteTitle(note.title);
      if (
        (existingGeneric && !currentGeneric) ||
        (existingGeneric === currentGeneric && (note.content ?? '').length > (existing.content ?? '').length)
      ) {
        byFingerprint.set(fp, note);
      }
    }
  }

  const resolved: ResolvedSourceNote[] = orderedFingerprints.map((fp) => {
    const note = byFingerprint.get(fp)!;
    return {
      noteId: note.noteId,
      displayTitle: resolveNoteDisplayTitle(note),
      subject: (note.subject ?? '').trim(),
      note,
    };
  });

  // Disambiguate genuinely distinct notes that still share an identical displayTitle
  const titleCounts = new Map<string, number>();
  for (const item of resolved) {
    const key = item.displayTitle.toLowerCase();
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  const usedLabels = new Set<string>();
  return resolved.map((item) => {
    const key = item.displayTitle.toLowerCase();
    if ((titleCounts.get(key) ?? 0) <= 1) {
      usedLabels.add(key);
      return item;
    }

    // Try subject or first distinguishing tag, then updated date
    const subjectCandidate =
      item.subject &&
      !GENERIC_SUBJECTS.has(item.subject.toLowerCase()) &&
      !item.displayTitle.toLowerCase().includes(item.subject.toLowerCase())
        ? `${item.displayTitle} (${item.subject})`
        : null;

    if (subjectCandidate && !usedLabels.has(subjectCandidate.toLowerCase())) {
      usedLabels.add(subjectCandidate.toLowerCase());
      return { ...item, displayTitle: subjectCandidate };
    }

    const firstTag = (Array.isArray(item.note.tags) ? item.note.tags : []).find(
      (t) => t && !item.displayTitle.toLowerCase().includes(t.toLowerCase())
    );
    if (firstTag) {
      const tagCandidate = `${item.displayTitle} · ${firstTag}`;
      if (!usedLabels.has(tagCandidate.toLowerCase())) {
        usedLabels.add(tagCandidate.toLowerCase());
        return { ...item, displayTitle: tagCandidate };
      }
    }

    const dateLabel =
      item.note.updatedAt instanceof Date && !Number.isNaN(item.note.updatedAt.getTime())
        ? item.note.updatedAt.toLocaleDateString()
        : '';
    const dateCandidate = dateLabel ? `${item.displayTitle} (${dateLabel})` : item.displayTitle;
    if (!usedLabels.has(dateCandidate.toLowerCase())) {
      usedLabels.add(dateCandidate.toLowerCase());
      return { ...item, displayTitle: dateCandidate };
    }

    let suffix = 2;
    let finalLabel = `${item.displayTitle} #${suffix}`;
    while (usedLabels.has(finalLabel.toLowerCase())) {
      suffix += 1;
      finalLabel = `${item.displayTitle} #${suffix}`;
    }
    usedLabels.add(finalLabel.toLowerCase());
    return { ...item, displayTitle: finalLabel };
  });
}
