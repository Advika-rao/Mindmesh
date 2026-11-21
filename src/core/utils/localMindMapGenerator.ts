import type { AINoteContext, GeneratedMindMapPayload } from '../interfaces/CoreInterfaces';
import { isGenericNoteTitle, resolveNoteDisplayTitle } from './sourceNotes';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'have', 'does', 'into', 'your', 'about', 'there', 'their', 'they', 'them', 'then',
  'than', 'these', 'those', 'also', 'such', 'used', 'using', 'uses', 'based', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'under', 'over', 'into',
  'more', 'most', 'some', 'many', 'other', 'each', 'only', 'very', 'well', 'both',
  'data', 'type', 'types', 'note', 'notes', 'section', 'overview', 'summary', 'topic',
]);

interface RawDetailItem {
  title: string;
  description: string;
  sourceNoteId: string;
}

interface RawSubtopicItem {
  title: string;
  description: string;
  details: RawDetailItem[];
  sourceNoteId: string;
}

interface RawBranchItem {
  title: string;
  description: string;
  subtopics: RawSubtopicItem[];
  sourceNoteIds: Set<string>;
}

function cleanLine(text: string): string {
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

function truncateTitle(text: string, maxLen = 58): string {
  const cleaned = cleanLine(text).replace(/[:\-–—;.,]+$/, '').trim();
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd() + '...';
}

function truncateDesc(text: string, maxLen = 190): string {
  const cleaned = cleanLine(text);
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd() + '...';
}

function normalizeConceptKey(text: string): string {
  return cleanLine(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

function conceptTokens(text: string): Set<string> {
  return new Set(
    normalizeConceptKey(text)
      .split(' ')
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

function areSimilarConcepts(a: string, b: string): boolean {
  const normA = normalizeConceptKey(a);
  const normB = normalizeConceptKey(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.length >= 6 && normB.length >= 6 && (normA.includes(normB) || normB.includes(normA))) {
    const shorter = Math.min(normA.length, normB.length);
    const longer = Math.max(normA.length, normB.length);
    if (shorter / longer >= 0.72) return true;
  }

  const setA = conceptTokens(a);
  const setB = conceptTokens(b);
  if (setA.size === 0 || setB.size === 0) return false;
  let overlap = 0;
  setA.forEach((t) => {
    if (setB.has(t)) overlap += 1;
  });
  const union = setA.size + setB.size - overlap;
  return union > 0 && overlap / union >= 0.6;
}

function splitLabelAndBody(line: string): { label: string; body: string } | null {
  // Match "**Term**: definition", "Term: definition", or "Term - definition"
  const boldColon = /^\*\*([^*]{2,64})\*\*\s*[:\-–—]\s*(.+)$/.exec(line.trim());
  if (boldColon) {
    return { label: cleanLine(boldColon[1]), body: cleanLine(boldColon[2]) };
  }
  const cleaned = cleanLine(line);
  const plainColon = /^([^:]{2,56}):\s+(.+)$/.exec(cleaned);
  if (plainColon && plainColon[1].split(/\s+/).length <= 7) {
    return { label: plainColon[1].trim(), body: plainColon[2].trim() };
  }
  const dashSplit = /^([^-–—]{2,48})\s+[–—-]\s+(.+)$/.exec(cleaned);
  if (dashSplit && dashSplit[1].split(/\s+/).length <= 6) {
    return { label: dashSplit[1].trim(), body: dashSplit[2].trim() };
  }
  return null;
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[-*_|:=\s]+$/.test(trimmed)) return true;
  if (/^page\s+\d+(\s+of\s+\d+)?[:\-–—\s]*$/i.test(trimmed)) return true;
  if (/^\|[\s:-]+\|$/.test(trimmed)) return true;
  return false;
}

function extractDetailsFromText(text: string, sourceNoteId: string): RawDetailItem[] {
  const details: RawDetailItem[] = [];
  const cleaned = cleanLine(text);
  if (!cleaned || cleaned.length < 12) return details;

  // Extract explicit examples or comma-separated algorithm/application lists
  const egMatch = /(?:e\.g\.|for example|such as|including|examples?|algorithms?|applications?)\s*[:,-]?\s*([^.;]+)/i.exec(
    cleaned
  );
  if (egMatch && egMatch[1]) {
    const items = egMatch[1]
      .split(/,|\/|\band\b/i)
      .map((s) => cleanLine(s))
      .filter((s) => s.length >= 3 && s.length <= 56);
    for (const item of items.slice(0, 2)) {
      details.push({
        title: truncateTitle(item, 44),
        description: truncateDesc(cleaned, 150),
        sourceNoteId,
      });
    }
  }

  return details;
}

function extractBranchesFromNote(note: AINoteContext): {
  noteTitle: string;
  summary: string;
  branches: RawBranchItem[];
} {
  const noteTitle = resolveNoteDisplayTitle({
    title: note.title,
    content: note.content,
    subject: note.subject,
    tags: note.tags,
  });

  const rawLines = (note.content || '').split(/\r?\n/);
  const branches: RawBranchItem[] = [];
  let currentBranch: RawBranchItem | null = null;
  let currentSubtopic: RawSubtopicItem | null = null;
  const introSentences: string[] = [];

  const ensureBranch = (fallbackTitle: string, fallbackDesc = ''): RawBranchItem => {
    if (!currentBranch) {
      currentBranch = {
        title: truncateTitle(fallbackTitle),
        description: truncateDesc(fallbackDesc),
        subtopics: [],
        sourceNoteIds: new Set([note.noteId]),
      };
      branches.push(currentBranch);
    }
    return currentBranch;
  };

  for (const rawLine of rawLines) {
    if (isIgnorableLine(rawLine)) continue;
    const trimmed = rawLine.trim();

    // Skip Markdown table rows beyond extracting simple key-value pairs
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => cleanLine(c))
        .filter(Boolean);
      if (cells.length >= 2 && !/^feature|concept|aspect|metric$/i.test(cells[0])) {
        const b = ensureBranch(noteTitle);
        b.subtopics.push({
          title: truncateTitle(cells[0], 50),
          description: truncateDesc(cells.slice(1).join(' · ')),
          details: [],
          sourceNoteId: note.noteId,
        });
      }
      continue;
    }

    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      const depth = hMatch[1].length;
      const headingText = cleanLine(hMatch[2]);
      if (!headingText || isGenericNoteTitle(headingText)) continue;

      // Skip top H1 if it duplicates the note title itself
      if (depth === 1 && areSimilarConcepts(headingText, noteTitle)) {
        continue;
      }

      if (depth <= 2) {
        currentBranch = {
          title: truncateTitle(headingText),
          description: '',
          subtopics: [],
          sourceNoteIds: new Set([note.noteId]),
        };
        branches.push(currentBranch);
        currentSubtopic = null;
      } else {
        const b = ensureBranch(noteTitle);
        currentSubtopic = {
          title: truncateTitle(headingText),
          description: '',
          details: [],
          sourceNoteId: note.noteId,
        };
        b.subtopics.push(currentSubtopic);
      }
      continue;
    }

    const isBullet = /^\s*(?:[-*•+]|\d+[.)])\s+/.test(rawLine);
    const indent = rawLine.search(/\S/);
    const kv = splitLabelAndBody(trimmed);

    if (isBullet) {
      const b = ensureBranch(noteTitle);
      if (indent >= 2 && currentSubtopic) {
        // Nested bullet -> Level 3 supporting detail/example
        currentSubtopic.details.push({
          title: truncateTitle(kv ? kv.label : trimmed, 48),
          description: truncateDesc(kv ? kv.body : trimmed),
          sourceNoteId: note.noteId,
        });
      } else {
        const subTitle = kv ? truncateTitle(kv.label, 52) : truncateTitle(trimmed, 52);
        const subDesc = kv ? truncateDesc(kv.body) : truncateDesc(trimmed);
        const extractedDetails = kv ? extractDetailsFromText(kv.body, note.noteId) : extractDetailsFromText(trimmed, note.noteId);
        currentSubtopic = {
          title: subTitle,
          description: subDesc,
          details: extractedDetails,
          sourceNoteId: note.noteId,
        };
        b.subtopics.push(currentSubtopic);
      }
      continue;
    }

    // Plain line with explicit "Topic: explanation" structure
    if (kv && !isGenericNoteTitle(kv.label)) {
      if (!currentBranch) {
        currentBranch = {
          title: truncateTitle(kv.label),
          description: truncateDesc(kv.body),
          subtopics: [],
          sourceNoteIds: new Set([note.noteId]),
        };
        branches.push(currentBranch);
        currentSubtopic = null;
        const inlineDetails = extractDetailsFromText(kv.body, note.noteId);
        if (inlineDetails.length > 0) {
          currentBranch.subtopics.push({
            title: truncateTitle(inlineDetails[0].title, 48),
            description: inlineDetails[0].description,
            details: inlineDetails.slice(1),
            sourceNoteId: note.noteId,
          });
        }
      } else {
        currentSubtopic = {
          title: truncateTitle(kv.label),
          description: truncateDesc(kv.body),
          details: extractDetailsFromText(kv.body, note.noteId),
          sourceNoteId: note.noteId,
        };
        currentBranch.subtopics.push(currentSubtopic);
      }
      continue;
    }

    // Regular prose line
    const cleaned = cleanLine(trimmed);
    if (cleaned.length < 6) continue;

    if (currentSubtopic && !currentSubtopic.description) {
      currentSubtopic.description = truncateDesc(cleaned);
    } else if (currentBranch && !currentBranch.description) {
      currentBranch.description = truncateDesc(cleaned);
    } else if (!currentBranch) {
      introSentences.push(cleaned);
    } else {
      // Split prose sentences into supporting subtopics or details
      const sentences = cleaned
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 16);
      for (const sentence of sentences.slice(0, 2)) {
        const subKv = splitLabelAndBody(sentence);
        if (currentSubtopic && currentSubtopic.details.length < 2) {
          currentSubtopic.details.push({
            title: truncateTitle(subKv ? subKv.label : sentence, 46),
            description: truncateDesc(subKv ? subKv.body : sentence),
            sourceNoteId: note.noteId,
          });
        } else if (currentBranch.subtopics.length < 4) {
          currentBranch.subtopics.push({
            title: truncateTitle(subKv ? subKv.label : sentence, 48),
            description: truncateDesc(subKv ? subKv.body : sentence),
            details: extractDetailsFromText(sentence, note.noteId),
            sourceNoteId: note.noteId,
          });
        }
      }
    }
  }

  // Fallback for prose-only notes with no headings/bullets
  if (branches.length === 0) {
    const paragraphs = (note.content || '')
      .split(/\n{2,}/)
      .map((p) => cleanLine(p))
      .filter((p) => p.length >= 12);

    if (paragraphs.length > 0) {
      paragraphs.slice(0, 4).forEach((para, idx) => {
        const sentences = para
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 10);
        const lead = sentences[0] || para;
        const kv = splitLabelAndBody(lead);
        const branchTitle = kv
          ? truncateTitle(kv.label, 52)
          : truncateTitle(lead.split(/[,;]/)[0] || `${noteTitle} Part ${idx + 1}`, 52);

        const subtopics: RawSubtopicItem[] = sentences.slice(1, 4).map((sent) => {
          const sKv = splitLabelAndBody(sent);
          return {
            title: truncateTitle(sKv ? sKv.label : sent, 48),
            description: truncateDesc(sKv ? sKv.body : sent),
            details: extractDetailsFromText(sent, note.noteId),
            sourceNoteId: note.noteId,
          };
        });

        branches.push({
          title: branchTitle,
          description: truncateDesc(kv ? kv.body : lead),
          subtopics,
          sourceNoteIds: new Set([note.noteId]),
        });
      });
    } else {
      // Minimal note fallback using tags/subject
      const tags = (note.tags || []).filter((t) => t.trim().length >= 2).slice(0, 4);
      if (tags.length > 0) {
        tags.forEach((tag) => {
          branches.push({
            title: truncateTitle(tag.replace(/[-_]+/g, ' '), 48),
            description: truncateDesc(note.content || `Key concept from ${noteTitle}.`),
            subtopics: [],
            sourceNoteIds: new Set([note.noteId]),
          });
        });
      } else {
        branches.push({
          title: truncateTitle(noteTitle),
          description: truncateDesc(note.content || 'Core note overview.'),
          subtopics: [],
          sourceNoteIds: new Set([note.noteId]),
        });
      }
    }
  }

  // If a single note produced only 1 mega-branch with many subtopics, promote top subtopics to main branches
  if (branches.length === 1 && branches[0].subtopics.length >= 3) {
    const only = branches[0];
    const promoted: RawBranchItem[] = only.subtopics.slice(0, 6).map((sub) => ({
      title: sub.title,
      description: sub.description || only.description,
      subtopics: sub.details.map((d) => ({
        title: d.title,
        description: d.description,
        details: [],
        sourceNoteId: d.sourceNoteId,
      })),
      sourceNoteIds: new Set([note.noteId]),
    }));
    return {
      noteTitle,
      summary: introSentences[0] || only.description || truncateDesc(note.content),
      branches: promoted,
    };
  }

  return {
    noteTitle,
    summary: introSentences[0] || branches[0]?.description || truncateDesc(note.content),
    branches,
  };
}

function deriveCentralTitle(
  notes: AINoteContext[],
  resolvedTitles: string[],
  customTitle?: string
): string {
  const trimmedCustom = (customTitle || '').trim();
  if (trimmedCustom) return trimmedCustom.slice(0, 120);

  if (resolvedTitles.length === 1) {
    return resolvedTitles[0];
  }

  // Check if notes share a meaningful subject
  const subjects = Array.from(
    new Set(
      notes
        .map((n) => (n.subject || '').trim())
        .filter((s) => s.length >= 2 && !/^general|notes|uncategorized|other$/i.test(s))
    )
  );

  if (resolvedTitles.length === 2) {
    const combined = `${resolvedTitles[0]} & ${resolvedTitles[1]}`;
    if (combined.length <= 68) return combined;
  }

  if (subjects.length === 1) {
    return `${subjects[0]} — Concept Map`;
  }

  // Look for most common meaningful keyword across titles/tags
  const freq = new Map<string, number>();
  for (const n of notes) {
    const tokens = new Set([
      ...conceptTokens(resolveNoteDisplayTitle(n)),
      ...(n.tags || []).flatMap((t) => Array.from(conceptTokens(t))),
    ]);
    tokens.forEach((tok) => freq.set(tok, (freq.get(tok) ?? 0) + 1));
  }
  const shared = Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([tok]) => tok.charAt(0).toUpperCase() + tok.slice(1));

  if (shared.length > 0) {
    return `${shared.join(' & ')} — Integrated Mind Map`;
  }

  return `${resolvedTitles[0]} & Related Notes`;
}

/**
 * Generates a clean, deduplicated 4-level hierarchical mind map locally from
 * one or more selected saved notes without requiring an external AI API call.
 *
 * Hierarchy:
 * - Level 0: Central topic
 * - Level 1: Main branches (3–6 distinct themes, merged across multiple notes)
 * - Level 2: Subtopics (up to 3 per branch)
 * - Level 3: Supporting details / examples (up to 2 per subtopic)
 * Plus cross-branch conceptual connections when multiple notes share concepts.
 */
export function generateLocalMindMap(
  notes: AINoteContext[],
  customTitle?: string
): GeneratedMindMapPayload {
  const safeNotes = (notes || []).filter((n) => n && (n.content || n.title));
  if (safeNotes.length === 0) {
    return {
      title: customTitle?.trim() || 'Study Mind Map',
      nodes: [
        {
          id: 'node-root',
          title: customTitle?.trim() || 'Study Mind Map',
          description: 'Select notes with content to extract concepts and branches.',
          level: 0,
          parentId: '',
        },
      ],
      connections: [],
    };
  }

  const perNoteResults = safeNotes.map((n) => extractBranchesFromNote(n));
  const resolvedTitles = perNoteResults.map((r) => r.noteTitle);
  const centralTitle = deriveCentralTitle(safeNotes, resolvedTitles, customTitle);

  // Merge and deduplicate branches across all selected notes
  const mergedBranches: RawBranchItem[] = [];

  const mergeBranchInto = (incoming: RawBranchItem) => {
    const existing = mergedBranches.find((b) => areSimilarConcepts(b.title, incoming.title));
    if (!existing) {
      mergedBranches.push({
        title: incoming.title,
        description: incoming.description,
        subtopics: [...incoming.subtopics],
        sourceNoteIds: new Set(incoming.sourceNoteIds),
      });
      return;
    }

    incoming.sourceNoteIds.forEach((id) => existing.sourceNoteIds.add(id));
    if (!existing.description && incoming.description) {
      existing.description = incoming.description;
    }

    // Merge non-duplicate subtopics
    for (const sub of incoming.subtopics) {
      const existingSub = existing.subtopics.find((s) => areSimilarConcepts(s.title, sub.title));
      if (!existingSub) {
        existing.subtopics.push({ ...sub, details: [...sub.details] });
      } else {
        if (!existingSub.description && sub.description) {
          existingSub.description = sub.description;
        }
        for (const det of sub.details) {
          if (!existingSub.details.some((d) => areSimilarConcepts(d.title, det.title))) {
            existingSub.details.push(det);
          }
        }
      }
    }
  };

  if (safeNotes.length === 1) {
    for (const b of perNoteResults[0].branches) {
      mergeBranchInto(b);
    }
  } else {
    // Multi-note: if a note has multiple top-level sections, merge them directly so shared themes unify cleanly;
    // if a note only yielded generic/flat bullets under its own title, keep its resolved note title as a branch.
    for (let i = 0; i < perNoteResults.length; i++) {
      const res = perNoteResults[i];
      const note = safeNotes[i];
      if (res.branches.length >= 2 && res.branches.length <= 4) {
        for (const b of res.branches) {
          mergeBranchInto(b);
        }
      } else {
        const subtopics: RawSubtopicItem[] = res.branches.flatMap((b) =>
          b.subtopics.length > 0
            ? [
                {
                  title: b.title,
                  description: b.description || b.subtopics[0]?.description || '',
                  details: b.subtopics.slice(0, 2).map((s) => ({
                    title: s.title,
                    description: s.description,
                    sourceNoteId: note.noteId,
                  })),
                  sourceNoteId: note.noteId,
                },
              ]
            : [
                {
                  title: b.title,
                  description: b.description,
                  details: [],
                  sourceNoteId: note.noteId,
                },
              ]
        );
        mergeBranchInto({
          title: truncateTitle(res.noteTitle),
          description: truncateDesc(res.summary),
          subtopics,
          sourceNoteIds: new Set([note.noteId]),
        });
      }
    }
  }

  // Prioritize richest branches (more subtopics / cross-note mentions) and cap at 6 main branches
  const selectedBranches = mergedBranches
    .filter((b) => b.title.trim().length > 0 && !areSimilarConcepts(b.title, centralTitle))
    .sort((a, b) => {
      const scoreA = a.sourceNoteIds.size * 3 + Math.min(a.subtopics.length, 4);
      const scoreB = b.sourceNoteIds.size * 3 + Math.min(b.subtopics.length, 4);
      return scoreB - scoreA;
    })
    .slice(0, 6);

  // If filtering out centralTitle left nothing, keep all merged branches up to 6
  const finalBranches = selectedBranches.length > 0 ? selectedBranches : mergedBranches.slice(0, 6);

  const nodes: GeneratedMindMapPayload['nodes'] = [
    {
      id: 'node-root',
      title: truncateTitle(centralTitle, 64),
      description:
        safeNotes.length === 1
          ? truncateDesc(perNoteResults[0].summary || `Core concepts extracted from ${resolvedTitles[0]}.`)
          : `Integrated concept hierarchy built from ${safeNotes.length} selected notes: ${resolvedTitles
              .slice(0, 3)
              .join(', ')}${resolvedTitles.length > 3 ? '...' : ''}.`,
      level: 0,
      parentId: '',
    },
  ];

  const connections: GeneratedMindMapPayload['connections'] = [];
  const branchTokensMap = new Map<string, Set<string>>();

  finalBranches.forEach((branch, bIdx) => {
    const branchId = `node-${bIdx + 1}`;
    nodes.push({
      id: branchId,
      title: truncateTitle(branch.title, 58),
      description: truncateDesc(
        branch.description || `Key theme covering ${branch.subtopics.length || 1} core point(s).`
      ),
      level: 1,
      parentId: 'node-root',
    });
    connections.push({
      id: `conn-root-${branchId}`,
      source: 'node-root',
      target: branchId,
      label: '',
    });

    const tokenBag = new Set<string>([
      ...conceptTokens(branch.title),
      ...conceptTokens(branch.description),
    ]);

    // Deduplicate subtopics within each branch
    const uniqueSubtopics: RawSubtopicItem[] = [];
    for (const sub of branch.subtopics) {
      if (
        !sub.title.trim() ||
        areSimilarConcepts(sub.title, branch.title) ||
        uniqueSubtopics.some((u) => areSimilarConcepts(u.title, sub.title))
      ) {
        continue;
      }
      uniqueSubtopics.push(sub);
      if (uniqueSubtopics.length >= 3) break;
    }

    uniqueSubtopics.forEach((sub, sIdx) => {
      const subId = `${branchId}-${sIdx + 1}`;
      nodes.push({
        id: subId,
        title: truncateTitle(sub.title, 56),
        description: truncateDesc(sub.description || sub.title),
        level: 2,
        parentId: branchId,
      });
      connections.push({
        id: `conn-${branchId}-${subId}`,
        source: branchId,
        target: subId,
        label: '',
      });

      conceptTokens(sub.title).forEach((t) => tokenBag.add(t));
      conceptTokens(sub.description).forEach((t) => tokenBag.add(t));

      // Add up to 2 Level-3 supporting details/examples per subtopic
      const uniqueDetails: RawDetailItem[] = [];
      for (const det of sub.details) {
        if (
          !det.title.trim() ||
          areSimilarConcepts(det.title, sub.title) ||
          uniqueDetails.some((u) => areSimilarConcepts(u.title, det.title))
        ) {
          continue;
        }
        uniqueDetails.push(det);
        if (uniqueDetails.length >= 2) break;
      }

      uniqueDetails.forEach((det, dIdx) => {
        const detId = `${subId}-${dIdx + 1}`;
        nodes.push({
          id: detId,
          title: truncateTitle(det.title, 52),
          description: truncateDesc(det.description || det.title),
          level: 3,
          parentId: subId,
        });
        connections.push({
          id: `conn-${subId}-${detId}`,
          source: subId,
          target: detId,
          label: 'example',
        });
        conceptTokens(det.title).forEach((t) => tokenBag.add(t));
      });
    });

    branchTokensMap.set(branchId, tokenBag);
  });

  // Create meaningful cross-branch links when branches share real domain concepts (especially across multiple notes)
  const branchIds = Array.from(branchTokensMap.keys());
  let crossLinks = 0;
  for (let i = 0; i < branchIds.length && crossLinks < 3; i++) {
    for (let j = i + 1; j < branchIds.length && crossLinks < 3; j++) {
      const idA = branchIds[i];
      const idB = branchIds[j];
      const setA = branchTokensMap.get(idA)!;
      const setB = branchTokensMap.get(idB)!;
      const sharedTerms: string[] = [];
      setA.forEach((t) => {
        if (setB.has(t)) sharedTerms.push(t);
      });
      if (sharedTerms.length >= 2) {
        connections.push({
          id: `conn-cross-${idA}-${idB}`,
          source: idA,
          target: idB,
          label: `related: ${sharedTerms[0]}`,
        });
        crossLinks += 1;
      }
    }
  }

  return {
    title: truncateTitle(centralTitle, 100),
    nodes,
    connections,
  };
}
