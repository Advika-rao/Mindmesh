import type {
  AINoteContext,
  ConceptConnectionExplanationPayload,
  GeneratedConceptGraphPayload,
} from '../interfaces/CoreInterfaces';
import { isGenericNoteTitle, resolveNoteDisplayTitle } from './sourceNotes';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'have', 'does', 'into', 'your', 'about', 'there', 'their', 'they', 'them', 'also',
  'such', 'used', 'using', 'uses', 'based', 'between', 'more', 'most', 'some', 'many',
  'other', 'each', 'only', 'very', 'well', 'both', 'notes', 'note', 'page', 'section',
  'overview', 'summary', 'introduction', 'example', 'examples', 'key', 'types', 'type',
]);

function cleanText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*•+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKey(text: string): string {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    normKey(text)
      .split(' ')
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

function slugify(text: string, idx: number): string {
  const base = normKey(text).replace(/\s+/g, '-').slice(0, 32);
  return base ? `concept-${base}` : `concept-${idx}`;
}

interface CandidateConcept {
  label: string;
  category: string;
  description: string;
  tier: number;
  sourceNoteIds: Set<string>;
  parentKey?: string;
}

/**
 * Generates a meaningful, deduplicated concept-level Brain Graph locally from
 * the user's selected saved notes when the Gemini API is unavailable or Demo Mode is active.
 */
export function generateLocalBrainGraph(notes: AINoteContext[]): GeneratedConceptGraphPayload {
  const safeNotes = (notes || []).filter((n) => n && (n.content || n.title));
  if (safeNotes.length === 0) {
    return {
      graphTitle: 'Concept Brain Graph',
      summary: 'Select saved notes to extract concepts and relationships.',
      concepts: [],
      edges: [],
    };
  }

  const conceptMap = new Map<string, CandidateConcept>();

  const registerConcept = (
    rawLabel: string,
    category: string,
    description: string,
    tier: number,
    noteId: string,
    parentKey?: string
  ): string | null => {
    const label = cleanText(rawLabel).replace(/[:\-–—;.,]+$/, '').trim();
    if (!label || label.length < 3 || label.length > 56 || isGenericNoteTitle(label)) return null;
    const key = normKey(label);
    if (!key || STOP_WORDS.has(key)) return null;

    const existing = conceptMap.get(key);
    if (existing) {
      existing.sourceNoteIds.add(noteId);
      existing.tier = Math.min(existing.tier, tier);
      if (!existing.description && description) {
        existing.description = description.slice(0, 220);
      }
      return key;
    }

    conceptMap.set(key, {
      label,
      category: category && !/^general|notes$/i.test(category) ? category : 'Core Concepts',
      description: (description || `Concept extracted from your saved notes on ${label}.`).slice(0, 220),
      tier: Math.max(0, Math.min(3, tier)),
      sourceNoteIds: new Set([noteId]),
      parentKey,
    });
    return key;
  };

  // Optional shared umbrella root when multiple notes share a non-generic subject
  const subjects = Array.from(
    new Set(
      safeNotes
        .map((n) => (n.subject || '').trim())
        .filter((s) => s.length >= 3 && !/^general|notes|uncategorized|other$/i.test(s))
    )
  );
  let umbrellaKey: string | null = null;
  if (safeNotes.length >= 2 && subjects.length === 1) {
    umbrellaKey = registerConcept(
      subjects[0],
      subjects[0],
      `Umbrella subject unifying concepts across ${safeNotes.length} selected notes.`,
      0,
      safeNotes[0].noteId
    );
    if (umbrellaKey) {
      safeNotes.forEach((n) => conceptMap.get(umbrellaKey!)?.sourceNoteIds.add(n.noteId));
    }
  }

  for (const note of safeNotes) {
    const resolvedTitle = resolveNoteDisplayTitle({
      title: note.title,
      content: note.content,
      subject: note.subject,
      tags: note.tags,
    });
    const category = note.subject || 'Key Concepts';

    const noteRootKey = registerConcept(
      resolvedTitle,
      category,
      cleanText(note.content || '').slice(0, 180),
      umbrellaKey ? 1 : 0,
      note.noteId,
      umbrellaKey ?? undefined
    );

    const lines = (note.content || '').split(/\r?\n/);
    let currentHeadingKey = noteRootKey;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || /^[-*_|:=\s]+$/.test(trimmed)) continue;

      const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
      if (hMatch) {
        const depth = hMatch[1].length;
        const label = cleanText(hMatch[2]);
        const tier = umbrellaKey ? Math.min(3, depth) : Math.min(3, Math.max(0, depth - 1));
        const key = registerConcept(
          label,
          category,
          `Topic section covered in "${resolvedTitle}".`,
          tier,
          note.noteId,
          depth <= 2 ? (noteRootKey ?? umbrellaKey ?? undefined) : (currentHeadingKey ?? noteRootKey ?? undefined)
        );
        if (key && depth <= 2) {
          currentHeadingKey = key;
        }
        continue;
      }

      // Extract "Term: definition" or "**Term**: definition"
      const boldKv = /^\s*(?:[-*•+]\s+)?\*\*([^*]{3,46})\*\*\s*[:\-–—]\s*(.+)$/.exec(trimmed);
      const plainKv = /^\s*(?:[-*•+]\s+)?([A-Z][A-Za-z0-9\s/-]{2,38}):\s+(.+)$/.exec(trimmed);
      const match = boldKv || plainKv;
      if (match) {
        const term = cleanText(match[1]);
        const desc = cleanText(match[2]);
        if (term.split(/\s+/).length <= 5 && !/^(?:note|page|date|example|summary)$/i.test(term)) {
          registerConcept(
            term,
            category,
            desc,
            currentHeadingKey ? 2 : 1,
            note.noteId,
            currentHeadingKey ?? noteRootKey ?? undefined
          );
        }
      }
    }

    // Also include top non-generic tags as tier-2/3 concepts if graph is still sparse
    for (const tag of (note.tags || []).slice(0, 4)) {
      const niceTag = tag
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
        .trim();
      if (conceptMap.size < 16) {
        registerConcept(
          niceTag,
          category,
          `Key concept tagged in "${resolvedTitle}".`,
          2,
          note.noteId,
          noteRootKey ?? umbrellaKey ?? undefined
        );
      }
    }
  }

  const chosenEntries = Array.from(conceptMap.entries())
    .sort((a, b) => a[1].tier - b[1].tier || b[1].sourceNoteIds.size - a[1].sourceNoteIds.size)
    .slice(0, 16);

  const keyToId = new Map<string, string>();
  const concepts: GeneratedConceptGraphPayload['concepts'] = chosenEntries.map(([key, item], idx) => {
    const id = slugify(item.label, idx);
    keyToId.set(key, id);
    return {
      id,
      label: item.label,
      category: item.category,
      description: item.description,
      tier: item.tier,
      sourceNoteIds: Array.from(item.sourceNoteIds),
    };
  });

  const validIds = new Set(concepts.map((c) => c.id));
  const seenEdges = new Set<string>();
  const edges: GeneratedConceptGraphPayload['edges'] = [];

  const addEdge = (source: string, target: string, relationship: string, reason: string) => {
    if (!source || !target || source === target || !validIds.has(source) || !validIds.has(target)) return;
    const pairKey = [source, target].sort().join('::');
    if (seenEdges.has(pairKey)) return;
    seenEdges.add(pairKey);
    edges.push({
      id: `cedge-${source}--${target}`,
      source,
      target,
      relationship,
      reason,
    });
  };

  // 1. Hierarchical parent -> child edges
  for (const [key, item] of chosenEntries) {
    const targetId = keyToId.get(key)!;
    if (item.parentKey && keyToId.has(item.parentKey)) {
      const sourceId = keyToId.get(item.parentKey)!;
      const parentLabel = conceptMap.get(item.parentKey)?.label ?? 'Parent Topic';
      addEdge(
        sourceId,
        targetId,
        item.tier <= 1 ? 'encompasses' : 'includes',
        `${parentLabel} covers ${item.label} in your selected saved notes.`
      );
    }
  }

  // 2. Semantic co-occurrence edges between concepts sharing notes or terms
  for (let i = 0; i < concepts.length && edges.length < 22; i++) {
    for (let j = i + 1; j < concepts.length && edges.length < 22; j++) {
      const a = concepts[i];
      const b = concepts[j];
      const pairKey = [a.id, b.id].sort().join('::');
      if (seenEdges.has(pairKey)) continue;

      const sharedNotes = a.sourceNoteIds.filter((id) => b.sourceNoteIds.includes(id));
      const tokensA = tokenize(`${a.label} ${a.description}`);
      const tokensB = tokenize(`${b.label} ${b.description}`);
      let sharedToken = '';
      tokensA.forEach((t) => {
        if (!sharedToken && tokensB.has(t)) sharedToken = t;
      });

      if (sharedToken || (sharedNotes.length > 0 && Math.abs(a.tier - b.tier) === 1 && edges.length < concepts.length + 2)) {
        addEdge(
          a.tier <= b.tier ? a.id : b.id,
          a.tier <= b.tier ? b.id : a.id,
          sharedToken ? 'relates to' : 'connects with',
          sharedToken
            ? `Both "${a.label}" and "${b.label}" share the concept of "${sharedToken}" across your selected notes.`
            : `"${a.label}" and "${b.label}" appear together in your saved notes.`
        );
      }
    }
  }

  const graphTitle =
    subjects.length === 1
      ? `${subjects[0]} Concept Graph`
      : safeNotes.length === 1
        ? `${resolveNoteDisplayTitle(safeNotes[0])} Concept Graph`
        : 'Integrated Notes Concept Graph';

  return {
    graphTitle,
    summary: `Extracted ${concepts.length} core concepts and ${edges.length} conceptual relationships locally from ${safeNotes.length} selected note${safeNotes.length === 1 ? '' : 's'}.`,
    concepts,
    edges,
  };
}

/**
 * Produces a grounded local explanation for a Brain Graph edge when AI is unavailable or Demo Mode is active.
 */
export function generateLocalConnectionExplanation(params: {
  sourceLabel: string;
  sourceDescription: string;
  sourceNoteIds: string[];
  targetLabel: string;
  targetDescription: string;
  targetNoteIds: string[];
  relationship: string;
  edgeReason?: string;
  selectedNotes: AINoteContext[];
}): ConceptConnectionExplanationPayload {
  const citedNoteIds = Array.from(
    new Set([...(params.sourceNoteIds || []), ...(params.targetNoteIds || [])])
  ).filter((id) => params.selectedNotes.some((n) => n.noteId === id));

  const fallbackCited =
    citedNoteIds.length > 0 ? citedNoteIds : params.selectedNotes.slice(0, 2).map((n) => n.noteId);

  const relatedNotes = params.selectedNotes.filter((n) => fallbackCited.includes(n.noteId));
  const noteNames = relatedNotes.map((n) => resolveNoteDisplayTitle(n));

  const summary =
    params.edgeReason && params.edgeReason.trim().length > 10
      ? params.edgeReason.trim()
      : `${params.sourceLabel} ${params.relationship || 'relates to'} ${params.targetLabel} in your saved notes.`;

  const explanation = [
    `${params.sourceLabel} and ${params.targetLabel} are connected through the "${params.relationship || 'relates to'}" relationship in your selected study notes${noteNames.length > 0 ? ` (${noteNames.join(', ')})` : ''}.`,
    params.sourceDescription ? `${params.sourceLabel}: ${params.sourceDescription}` : '',
    params.targetDescription ? `${params.targetLabel}: ${params.targetDescription}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const whyConnected =
    params.edgeReason && params.edgeReason.trim().length > 10
      ? params.edgeReason.trim()
      : `Both ${params.sourceLabel} and ${params.targetLabel} appear together in your selected study notes${noteNames.length > 0 ? ` (${noteNames.join(', ')})` : ''}.`;

  const howTheyRelate = `${params.sourceLabel} ${params.relationship || 'relates to'} ${params.targetLabel}: ${
    params.targetDescription || `${params.targetLabel} builds on or connects directly with ${params.sourceLabel}.`
  }`;

  const examples: string[] = [];
  for (const n of relatedNotes) {
    const match = (n.content || '')
      .split(/\r?\n/)
      .map((l) => cleanText(l))
      .find((l) => /\b(?:example|e\.g\.|application|such as)\b/i.test(l) && l.length >= 16);
    if (match) {
      examples.push(match.slice(0, 180));
      if (examples.length >= 2) break;
    }
  }

  const intermediateConcepts = Array.from(
    new Set(
      relatedNotes
        .flatMap((n) => n.tags || [])
        .map((t) => t.replace(/[-_]+/g, ' ').trim())
        .filter(
          (t) =>
            t.length >= 3 &&
            t.toLowerCase() !== params.sourceLabel.toLowerCase() &&
            t.toLowerCase() !== params.targetLabel.toLowerCase()
        )
    )
  ).slice(0, 4);

  return {
    summary,
    whyConnected,
    howTheyRelate,
    explanation,
    examples,
    intermediateConcepts,
    citedNoteIds: fallbackCited,
    connectionStrengthNote:
      relatedNotes.length >= 2
        ? `Strong conceptual bridge grounded across ${relatedNotes.length} selected notes (local mode).`
        : 'Direct conceptual link extracted from your selected notes (local mode).',
  };
}
