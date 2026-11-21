import type { AINoteContext, StudyAssistantResponse } from '../interfaces/CoreInterfaces';
import { resolveNoteDisplayTitle } from './sourceNotes';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'about', 'into', 'your', 'have', 'does', 'can', 'could', 'would',
  'should', 'explain', 'summarize', 'simplify', 'give', 'tell', 'show', 'notes', 'note',
  'saved', 'please', 'are', 'was', 'were', 'been', 'being', 'has', 'had', 'will', 'all',
  'any', 'but', 'not', 'compare', 'difference', 'between', 'contrast', 'versus', 'including',
  'their', 'they', 'them', 'then', 'than', 'these', 'those', 'also', 'such',
]);

function extractQueryTerms(question: string): string[] {
  return Array.from(
    new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    )
  );
}

function cleanSnippetLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*•+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExtractedConceptSummary {
  name: string;
  noteId: string;
  definition: string;
  dataUsed: string;
  algorithms: string;
  applications: string;
  keyPoints: string[];
}

function extractFieldByPattern(lines: string[], regex: RegExp): string {
  for (const line of lines) {
    if (regex.test(line)) {
      const cleaned = cleanSnippetLine(line)
        .replace(/^(?:data\s*used|data|input|goal|objective|algorithms?|methods?|models?|applications?|examples?|use\s*cases?)\s*[:\-–—]\s*/i, '')
        .trim();
      if (cleaned.length >= 4) {
        return cleaned.length > 130 ? `${cleaned.slice(0, 127).trimEnd()}...` : cleaned;
      }
    }
  }
  return '';
}

function summarizeNoteForComparison(note: AINoteContext): ExtractedConceptSummary {
  const name = resolveNoteDisplayTitle({
    title: note.title,
    content: note.content,
    subject: note.subject,
    tags: note.tags,
  });

  const lines = (note.content || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !/^[-*_|:=\s]+$/.test(l));

  const bodyLines = lines.filter((l) => !/^#\s+/.test(l));

  const definition =
    bodyLines
      .map((l) => cleanSnippetLine(l))
      .find((l) => l.length >= 20 && !/^(?:algorithms?|applications?|examples?|metrics?)\s*:/i.test(l)) ||
    cleanSnippetLine(note.content || '').slice(0, 140) ||
    `Core concept from ${name}`;

  const dataUsed =
    extractFieldByPattern(bodyLines, /\b(?:labeled|unlabeled|data\s*used|training\s*data|input[\s-]output|dataset)\b/i) ||
    'See note details';

  const algorithms =
    extractFieldByPattern(bodyLines, /\b(?:algorithms?|regression|svm|decision\s*tree|random\s*forest|k-?means|dbscan|pca|neural|apriori|clustering)\b/i) ||
    'See saved note';

  const applications =
    extractFieldByPattern(bodyLines, /\b(?:applications?|examples?|e\.g\.|spam|diagnosis|segmentation|anomaly|prediction|forecasting|fraud|detection)\b/i) ||
    'See saved note';

  const keyPoints = bodyLines
    .map((l) => cleanSnippetLine(l))
    .filter((l) => l.length >= 16)
    .slice(0, 4);

  return {
    name,
    noteId: note.noteId,
    definition: definition.length > 140 ? `${definition.slice(0, 137).trimEnd()}...` : definition,
    dataUsed,
    algorithms,
    applications,
    keyPoints,
  };
}

function scoreLine(line: string, terms: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += 3;
  }
  if (/^#{1,3}\s+/.test(line)) score += 1.5;
  if (/\b(?:definition|means|is a|refers to|example|e\.g\.|algorithm|application|formula|summary)\b/i.test(line)) {
    score += 1.2;
  }
  return score;
}

/**
 * Produces a structured Markdown study answer directly from the user's saved notes
 * without calling the Gemini API. Used for both Local Fallback Mode (when API quota is
 * exhausted or unavailable) and Presentation/Demo Mode.
 */
export function generateLocalStudyAnswer(
  question: string,
  relevantNotes: AINoteContext[],
  mode: 'ask' | 'simplify' | 'summarize' | 'examples' = 'ask'
): StudyAssistantResponse {
  const cleanedQuestion = question.trim();
  const terms = extractQueryTerms(cleanedQuestion);

  if (!relevantNotes || relevantNotes.length === 0) {
    return {
      answer: [
        '## No Matching Saved Notes Found',
        '',
        `No saved notes were available to answer **"${cleanedQuestion}"** locally.`,
        '',
        '- Add or capture notes in **My Notes** so MindMesh can extract grounded answers and examples.',
      ].join('\n'),
      citedNoteIds: [],
      insufficientContext: true,
      suggestedFollowUps: ['What topics are currently in my saved notes?'],
    };
  }

  const isComparison = /\b(?:compare|comparison|difference|differences|versus|vs\.?|contrast)\b/i.test(
    cleanedQuestion
  );

  // Rank notes by query overlap so we only cite genuinely relevant notes
  const rankedNotes = relevantNotes
    .map((note) => {
      const hay = `${note.title} ${note.subject} ${(note.tags || []).join(' ')} ${note.content}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (hay.includes(term)) hits += 1;
      }
      return { note, hits };
    })
    .sort((a, b) => b.hits - a.hits);

  const matchingNotes = rankedNotes.filter((r) => r.hits > 0).map((r) => r.note);
  const chosenNotes = (matchingNotes.length > 0 ? matchingNotes : relevantNotes).slice(0, 3);
  const insufficientContext = matchingNotes.length === 0 && terms.length > 0;
  const citedNoteIds = Array.from(new Set(chosenNotes.map((n) => n.noteId)));

  const followUps: string[] = [];
  const firstTitle = resolveNoteDisplayTitle(chosenNotes[0]);
  if (chosenNotes.length >= 2) {
    const secondTitle = resolveNoteDisplayTitle(chosenNotes[1]);
    followUps.push(`Compare ${firstTitle} and ${secondTitle}`);
  }
  followUps.push(`Summarize key points from ${firstTitle}`);
  followUps.push(`Give examples from ${firstTitle}`);

  // 1) Comparison layout with readable Markdown table
  if (isComparison && chosenNotes.length >= 2) {
    const compared = chosenNotes.slice(0, 3).map((n) => summarizeNoteForComparison(n));
    const tableHeader = '| Concept | Core Goal / Definition | Data / Input | Algorithms & Techniques | Applications & Examples |';
    const tableSep = '| :--- | :--- | :--- | :--- | :--- |';
    const tableRows = compared.map(
      (c) =>
        `| **${c.name.replace(/\|/g, '/')}** | ${c.definition.replace(/\|/g, '/')} | ${c.dataUsed.replace(/\|/g, '/')} | ${c.algorithms.replace(/\|/g, '/')} | ${c.applications.replace(/\|/g, '/')} |`
    );

    const detailSections = compared.map(
      (c) =>
        `### ${c.name}\n${c.keyPoints
          .slice(0, 3)
          .map((pt) => `- ${pt}`)
          .join('\n')}`
    );

    const answer = [
      `## Comparison Based on Your Saved Notes`,
      '',
      `Here is a structured comparison extracted directly from your **${compared.length} most relevant saved notes**:`,
      '',
      tableHeader,
      tableSep,
      ...tableRows,
      '',
      '### Key Highlights from Your Notes',
      '',
      ...detailSections,
      '',
      `**Key Takeaway:** Review the table above to contrast how **${compared[0].name}** and **${compared[1].name}** differ in data requirements, techniques, and real-world applications.`,
    ].join('\n');

    return {
      answer,
      citedNoteIds,
      insufficientContext,
      suggestedFollowUps: followUps.slice(0, 3),
    };
  }

  // 2) Structured explanation / summary / examples / simplify response
  const sections: string[] = [];
  const headingPrefix =
    mode === 'summarize'
      ? 'Summary from Your Saved Notes'
      : mode === 'examples'
        ? 'Examples from Your Saved Notes'
        : mode === 'simplify'
          ? 'Simplified Breakdown from Your Saved Notes'
          : `Answer Grounded in Your Saved Notes`;

  sections.push(`## ${headingPrefix}`);
  sections.push('');

  if (insufficientContext) {
    sections.push(
      `Your saved notes do not contain an exact keyword match for **"${cleanedQuestion}"**. Here are the closest relevant excerpts from your library:`
    );
    sections.push('');
  }

  for (const note of chosenNotes) {
    const title = resolveNoteDisplayTitle({
      title: note.title,
      content: note.content,
      subject: note.subject,
      tags: note.tags,
    });

    const rawLines = (note.content || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 4 && !/^[-*_|:=\s]+$/.test(l));

    let prioritized = rawLines
      .map((line, index) => ({
        line,
        index,
        score:
          scoreLine(line, terms) +
          (mode === 'examples' && /\b(?:example|e\.g\.|application|such as|used for|like)\b/i.test(line)
            ? 4
            : 0),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, mode === 'summarize' ? 4 : 5)
      .sort((a, b) => a.index - b.index)
      .map((item) => cleanSnippetLine(item.line))
      .filter(Boolean);

    if (prioritized.length === 0) {
      prioritized = [cleanSnippetLine(note.content || '').slice(0, 220)];
    }

    sections.push(`### ${title}`);
    for (const point of prioritized) {
      const formatted = point.length > 260 ? `${point.slice(0, 257).trimEnd()}...` : point;
      sections.push(`- ${formatted}`);
    }
    sections.push('');
  }

  sections.push(
    `**Key Takeaway:** These points were extracted locally from **${chosenNotes
      .map((n) => resolveNoteDisplayTitle(n))
      .join('**, **')}**. Click any source note below to read the full context.`
  );

  return {
    answer: sections.join('\n').trim(),
    citedNoteIds,
    insufficientContext,
    suggestedFollowUps: followUps.slice(0, 3),
  };
}
