import type {
  AINoteContext,
  GeneratedQuizQuestionPayload,
  QuizEvaluationResult,
} from '../interfaces/CoreInterfaces';
import type { QuizDifficulty } from '../models/Quiz';
import { resolveNoteDisplayTitle } from './sourceNotes';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'about', 'into', 'your', 'have', 'does', 'can', 'could', 'would',
  'should', 'are', 'was', 'were', 'been', 'being', 'has', 'had', 'will', 'all', 'any',
  'but', 'not', 'they', 'them', 'their', 'then', 'than', 'these', 'those', 'also', 'such',
  'used', 'uses', 'using', 'into', 'onto', 'over', 'under', 'each', 'more', 'most', 'very',
  'only', 'some', 'many', 'much', 'between', 'through', 'during', 'before', 'after', 'while',
  'where', 'there', 'here', 'both', 'other', 'another', 'make', 'makes', 'made', 'like',
]);

function cleanLine(line: string): string {
  return line
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

function truncateText(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 3).trimEnd()}...`;
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      normalizeForCompare(text)
        .split(' ')
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    )
  );
}

/**
 * Validates and normalizes quiz questions returned by either the AI API or local fallback.
 * Ensures every question has a unique ID, valid prompt, valid options (with matching correctAnswer
 * for MCQs), non-empty explanation, topic, and valid sourceNoteId.
 */
export function validateAndNormalizeQuestions(
  rawQuestions: unknown,
  validNoteIds: string[],
  fallbackSubject: string
): GeneratedQuizQuestionPayload[] {
  if (!Array.isArray(rawQuestions)) return [];

  const validNoteIdSet = new Set(validNoteIds.filter(Boolean));
  const defaultNoteId = validNoteIds[0] || '';
  const defaultTopic =
    fallbackSubject && fallbackSubject !== 'All Subjects' && fallbackSubject !== 'Mixed Subjects'
      ? fallbackSubject
      : 'Core Concepts';

  const seenIds = new Set<string>();
  const seenPrompts = new Set<string>();
  const validated: GeneratedQuizQuestionPayload[] = [];

  for (let i = 0; i < rawQuestions.length; i++) {
    const item = rawQuestions[i] as Partial<GeneratedQuizQuestionPayload> | null | undefined;
    if (!item || typeof item !== 'object') continue;

    const prompt = typeof item.prompt === 'string' ? item.prompt.replace(/\s+/g, ' ').trim() : '';
    if (prompt.length < 8) continue;

    const promptKey = normalizeForCompare(prompt);
    if (!promptKey || seenPrompts.has(promptKey)) continue;

    let correctAnswer =
      typeof item.correctAnswer === 'string' ? item.correctAnswer.replace(/\s+/g, ' ').trim() : '';
    if (!correctAnswer) continue;

    let type: 'mcq' | 'short_answer' =
      item.type === 'short_answer' ? 'short_answer' : 'mcq';

    let options: string[] = [];
    if (type === 'mcq') {
      const rawOptions = Array.isArray(item.options) ? item.options : [];
      const optionSeen = new Set<string>();
      for (const opt of rawOptions) {
        if (typeof opt !== 'string') continue;
        const cleanedOpt = opt.replace(/\s+/g, ' ').trim();
        const optKey = cleanedOpt.toLowerCase();
        if (!cleanedOpt || optionSeen.has(optKey)) continue;
        optionSeen.add(optKey);
        options.push(cleanedOpt);
      }

      // Handle letter-only correctAnswer ("A", "B", "C", "D") if the model returned an index label
      const letterMatch = correctAnswer.match(/^([A-D])(?:[.)])?$/i);
      if (letterMatch && options.length >= 2) {
        const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) {
          correctAnswer = options[idx];
        }
      }

      // Ensure correctAnswer matches one of the distinct options
      const matchedOpt = options.find(
        (opt) => opt.toLowerCase() === correctAnswer.toLowerCase()
      );
      if (matchedOpt) {
        correctAnswer = matchedOpt;
      } else if (options.length > 0) {
        // Also check partial prefix match (e.g. option is "A) Supervised Learning" and answer is "Supervised Learning")
        const partialMatch = options.find((opt) =>
          opt.replace(/^[A-D][.)]\s*/i, '').toLowerCase() === correctAnswer.toLowerCase()
        );
        if (partialMatch) {
          correctAnswer = partialMatch;
        } else {
          // Insert the correct answer and cap to 4 distinct options
          options = [correctAnswer, ...options.slice(0, 3)];
        }
      }

      if (options.length < 2) {
        // Cannot render a valid multiple-choice question with fewer than 2 distinct choices
        type = 'short_answer';
        options = [];
      } else if (options.length > 4) {
        // Keep the correct answer plus 3 distractors
        const distractors = options.filter((o) => o !== correctAnswer).slice(0, 3);
        options = [correctAnswer, ...distractors];
      }
    }

    const explanation =
      typeof item.explanation === 'string' && item.explanation.trim().length >= 5
        ? item.explanation.replace(/\s+/g, ' ').trim()
        : `Based on your saved notes, the correct answer is: ${correctAnswer}.`;

    const topic =
      typeof item.topic === 'string' && item.topic.trim().length >= 2
        ? item.topic.replace(/\s+/g, ' ').trim().slice(0, 80)
        : defaultTopic;

    const rawSourceId = typeof item.sourceNoteId === 'string' ? item.sourceNoteId.trim() : '';
    const sourceNoteId = validNoteIdSet.has(rawSourceId) ? rawSourceId : defaultNoteId;

    let id =
      typeof item.id === 'string' && item.id.trim().length > 0
        ? item.id.trim().replace(/[^a-zA-Z0-9_-]/g, '')
        : `q-${validated.length + 1}`;
    if (!id || seenIds.has(id)) {
      id = `q-${validated.length + 1}`;
      while (seenIds.has(id)) {
        id = `q-${validated.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }

    seenIds.add(id);
    seenPrompts.add(promptKey);

    validated.push({
      id,
      type,
      prompt,
      options,
      correctAnswer,
      explanation,
      topic,
      sourceNoteId,
    });
  }

  return validated;
}

interface ExtractedFact {
  term: string;
  detail: string;
  topic: string;
  noteId: string;
  noteTitle: string;
  subject: string;
  priority: number;
}

const GENERIC_HEADING_RE = /^(?:overview|summary|introduction|notes|conclusion|references|key\s+takeaways?|examples?)$/i;

function extractStructuredFactsFromNotes(
  notes: AINoteContext[],
  weakTopics: string[]
): ExtractedFact[] {
  const weakSet = weakTopics.map((w) => w.toLowerCase().trim()).filter(Boolean);
  const facts: ExtractedFact[] = [];
  const seenKeys = new Set<string>();

  const pushFact = (fact: ExtractedFact) => {
    const termClean = cleanLine(fact.term).replace(/[:\-–—]+$/, '').trim();
    const detailClean = cleanLine(fact.detail).trim();
    if (termClean.length < 2 || termClean.length > 85) return;
    if (detailClean.length < 18) return;
    if (GENERIC_HEADING_RE.test(termClean)) return;

    const key = `${normalizeForCompare(termClean)}::${normalizeForCompare(detailClean).slice(0, 60)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const hay = `${termClean} ${detailClean} ${fact.topic}`.toLowerCase();
    const weakBonus = weakSet.some((w) => hay.includes(w)) ? 5 : 0;

    facts.push({
      ...fact,
      term: termClean,
      detail: truncateText(detailClean, 190),
      topic: cleanLine(fact.topic || termClean).slice(0, 60) || termClean,
      priority: fact.priority + weakBonus,
    });
  };

  for (const note of notes) {
    const noteTitle = resolveNoteDisplayTitle({
      title: note.title,
      content: note.content,
      subject: note.subject,
      tags: note.tags,
    });
    const subject = (note.subject || 'General').trim();
    const lines = (note.content || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^[-*_|:=\s]+$/.test(l));

    let currentHeading = noteTitle;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];

      // 1) Heading + following descriptive line(s)
      if (/^#{1,4}\s+/.test(rawLine)) {
        const headingText = cleanLine(rawLine);
        if (headingText.length >= 3 && !GENERIC_HEADING_RE.test(headingText)) {
          currentHeading = headingText;
          // Look ahead for the first non-heading explanatory line
          const nextLines: string[] = [];
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            if (/^#{1,4}\s+/.test(lines[j])) break;
            const cleanedNext = cleanLine(lines[j]);
            if (cleanedNext.length >= 16) {
              nextLines.push(cleanedNext);
              if (nextLines.join(' ').length >= 90) break;
            }
          }
          if (nextLines.length > 0) {
            pushFact({
              term: headingText,
              detail: nextLines.join(' '),
              topic: headingText,
              noteId: note.noteId,
              noteTitle,
              subject,
              priority: 4,
            });
          }
        }
        continue;
      }

      // Skip markdown table separator rows
      if (/^\|[\s:-]+\|/.test(rawLine)) continue;

      // 2) Markdown table rows: | Concept | Description | ... |
      if (rawLine.startsWith('|') && rawLine.endsWith('|')) {
        const cells = rawLine
          .split('|')
          .map((c) => cleanLine(c))
          .filter(Boolean);
        if (
          cells.length >= 2 &&
          !/^(?:concept|term|topic|algorithm|layer|protocol|property|feature|name)$/i.test(cells[0])
        ) {
          pushFact({
            term: cells[0],
            detail: cells.slice(1).join(' — '),
            topic: currentHeading || cells[0],
            noteId: note.noteId,
            noteTitle,
            subject,
            priority: 4,
          });
        }
        continue;
      }

      const cleaned = cleanLine(rawLine);

      // 3) "Term: Definition" or "Term - Definition" pattern
      const colonMatch = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9\s/()&+'-]{1,65}?)\s*(?::|–|—|\s-\s)\s+(.{18,})$/);
      if (colonMatch) {
        const left = colonMatch[1].trim();
        const right = colonMatch[2].trim();
        if (left.split(/\s+/).length <= 8) {
          pushFact({
            term: left,
            detail: right,
            topic: currentHeading || left,
            noteId: note.noteId,
            noteTitle,
            subject,
            priority: 5,
          });
          continue;
        }
      }

      // 4) Split paragraph into sentences and detect definitional patterns
      const sentences = cleaned
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 24);

      for (const sentence of sentences) {
        const defMatch = sentence.match(
          /^([A-Za-z0-9][A-Za-z0-9\s/()'-]{2,55}?)\s+(?:is\s+(?:a|an|the)|are|refers\s+to|means|defines?|represents?|provides?|ensures?|uses?|allows?|converts?|manages?|controls?|handles?|prevents?|occurs\s+when)\s+(.{16,})$/i
        );
        if (defMatch) {
          const term = defMatch[1].trim();
          const wordCount = term.split(/\s+/).length;
          if (wordCount <= 7 && !/^(?:it|this|that|they|there|here|these|those|which)\b/i.test(term)) {
            pushFact({
              term,
              detail: sentence,
              topic: currentHeading || term,
              noteId: note.noteId,
              noteTitle,
              subject,
              priority: 4,
            });
            continue;
          }
        }

        // Fallback sentence fact under current heading
        if (sentence.length >= 35) {
          pushFact({
            term: currentHeading,
            detail: sentence,
            topic: currentHeading,
            noteId: note.noteId,
            noteTitle,
            subject,
            priority: 2,
          });
        }
      }
    }

    // Ensure every note contributes at least one summary fact if its body was very short
    const noteHasFact = facts.some((f) => f.noteId === note.noteId);
    if (!noteHasFact && (note.content || '').trim().length >= 10) {
      pushFact({
        term: noteTitle,
        detail: cleanLine(note.content || ''),
        topic: noteTitle,
        noteId: note.noteId,
        noteTitle,
        subject,
        priority: 1,
      });
    }
  }

  return facts.sort((a, b) => b.priority - a.priority);
}

function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = Math.abs(seed) + 1;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const FALLBACK_DISTRACTOR_DESCRIPTIONS: string[] = [
  'A deprecated manual procedure that bypasses validation and discards intermediate state.',
  'An unrelated hardware-only voltage regulation mechanism used exclusively in power supplies.',
  'A static naming convention that has no effect on execution, accuracy, or system behavior.',
  'A random trial-and-error approach that ignores input structure and recorded observations.',
];

const FALLBACK_DISTRACTOR_TERMS: string[] = [
  'Static Register Allocation',
  'Unstructured Sequential Polling',
  'Manual Checksum Truncation',
  'Deterministic Clock Gating',
];

function buildDistinctDistractors(
  correct: string,
  candidatePool: string[],
  fallbackPool: string[],
  seed: number
): string[] {
  const correctNorm = normalizeForCompare(correct);
  const chosen: string[] = [];
  const used = new Set<string>([correctNorm]);

  const tryAdd = (raw: string) => {
    const cleaned = truncateText(raw, 130);
    const norm = normalizeForCompare(cleaned);
    if (!cleaned || cleaned.length < 3 || used.has(norm)) return;
    // Avoid distractors that are exact substrings of the correct answer or vice versa
    if (norm.length > 10 && (correctNorm.includes(norm) || norm.includes(correctNorm))) return;
    used.add(norm);
    chosen.push(cleaned);
  };

  for (const c of deterministicShuffle(candidatePool, seed)) {
    if (chosen.length >= 3) break;
    tryAdd(c);
  }
  for (const f of deterministicShuffle(fallbackPool, seed + 17)) {
    if (chosen.length >= 3) break;
    tryAdd(f);
  }

  return chosen.slice(0, 3);
}

/**
 * Generates a grounded, validated quiz strictly from the user's saved notes locally
 * without calling the Gemini API. Supports Easy, Medium, and Hard difficulty styles
 * and guarantees valid MCQ options, correct answers, and explanations.
 */
export function generateLocalQuiz(params: {
  notes: AINoteContext[];
  subject: string;
  difficulty: QuizDifficulty;
  questionCount: number;
  weakTopics?: string[];
}): GeneratedQuizQuestionPayload[] {
  const { notes, subject, difficulty, questionCount, weakTopics = [] } = params;
  if (!notes || notes.length === 0) return [];

  const targetCount = Math.min(Math.max(Number(questionCount) || 5, 1), 15);
  const facts = extractStructuredFactsFromNotes(notes, weakTopics);

  // Build candidate pools for realistic distractors across all selected notes
  const allTerms = Array.from(
    new Set([
      ...facts.map((f) => f.term),
      ...notes.map((n) => resolveNoteDisplayTitle(n)),
      ...notes.flatMap((n) => (n.tags || []).map((t) => t.replace(/[-_]+/g, ' '))),
    ])
  ).filter((t) => t.trim().length >= 2 && t.trim().length <= 80);

  const allDetails = Array.from(
    new Set(facts.map((f) => truncateText(f.detail, 130)))
  ).filter((d) => d.length >= 18);

  const generated: GeneratedQuizQuestionPayload[] = [];
  const desiredMcqCount = Math.max(1, Math.round(targetCount * 0.7));

  // If notes had very sparse content, synthesize per-note fallback facts so we can still build questions
  const workingFacts: ExtractedFact[] =
    facts.length > 0
      ? facts
      : notes.map((n) => {
          const title = resolveNoteDisplayTitle(n);
          return {
            term: title,
            detail: truncateText(cleanLine(n.content || title), 170),
            topic: title,
            noteId: n.noteId,
            noteTitle: title,
            subject: n.subject || subject,
            priority: 1,
          };
        });

  const usedPromptFingerprints = new Set<string>();

  for (let i = 0; i < targetCount; i++) {
    const fact = workingFacts[i % workingFacts.length];
    const pass = Math.floor(i / workingFacts.length);
    const isMcq = i < desiredMcqCount;
    const seed = i * 31 + fact.term.length * 7 + (difficulty === 'hard' ? 13 : difficulty === 'medium' ? 5 : 1);

    if (isMcq) {
      // Alternate between definition-lookup MCQs and term-identification MCQs so questions feel varied
      const askForTerm = pass % 2 === 1 || (i % 2 === 1 && allTerms.length >= 4 && fact.term !== fact.noteTitle);

      if (askForTerm) {
        const snippet = truncateText(
          fact.detail.replace(new RegExp(fact.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'this concept'),
          145
        );
        const prompt =
          difficulty === 'hard'
            ? `In ${fact.subject || subject}, which concept best fits the following behavior from your notes: "${snippet}"?`
            : difficulty === 'medium'
              ? `Which concept from your notes on "${fact.noteTitle}" is described as: "${snippet}"?`
              : `Which term matches this description from your saved notes: "${snippet}"?`;

        if (!usedPromptFingerprints.has(normalizeForCompare(prompt))) {
          usedPromptFingerprints.add(normalizeForCompare(prompt));
          const correct = fact.term;
          const distractors = buildDistinctDistractors(
            correct,
            allTerms,
            FALLBACK_DISTRACTOR_TERMS,
            seed
          );
          const options = deterministicShuffle([correct, ...distractors], seed + 3);
          generated.push({
            id: `local-q-${i + 1}`,
            type: 'mcq',
            prompt,
            options,
            correctAnswer: correct,
            explanation: `From "${fact.noteTitle}": ${fact.term} — ${fact.detail}`,
            topic: fact.topic,
            sourceNoteId: fact.noteId,
          });
          continue;
        }
      }

      const correctDetail = truncateText(fact.detail, 130);
      const prompt =
        difficulty === 'hard'
          ? `Applying your notes on "${fact.noteTitle}", which statement most accurately characterizes ${fact.term}?`
          : difficulty === 'medium'
            ? `According to your "${fact.noteTitle}" notes, how is ${fact.term} best described?`
            : `Based on your saved notes, what is ${fact.term}?`;

      const finalPrompt = usedPromptFingerprints.has(normalizeForCompare(prompt))
        ? `Which of the following statements from "${fact.noteTitle}" is accurate regarding ${fact.term} (#${pass + 1})?`
        : prompt;

      usedPromptFingerprints.add(normalizeForCompare(finalPrompt));
      const distractors = buildDistinctDistractors(
        correctDetail,
        allDetails,
        FALLBACK_DISTRACTOR_DESCRIPTIONS,
        seed
      );
      const options = deterministicShuffle([correctDetail, ...distractors], seed + 7);

      generated.push({
        id: `local-q-${i + 1}`,
        type: 'mcq',
        prompt: finalPrompt,
        options,
        correctAnswer: correctDetail,
        explanation: `Directly supported by your note "${fact.noteTitle}": ${fact.detail}`,
        topic: fact.topic,
        sourceNoteId: fact.noteId,
      });
    } else {
      // Short-answer question tailored to difficulty
      const prompt =
        difficulty === 'hard'
          ? `Explain ${fact.term} in your own words and describe its practical role or key implication based on your "${fact.noteTitle}" notes.`
          : difficulty === 'medium'
            ? `Summarize the key mechanism or purpose of ${fact.term} as covered in "${fact.noteTitle}".`
            : `Briefly define ${fact.term} based on your saved notes on "${fact.noteTitle}".`;

      const finalPrompt = usedPromptFingerprints.has(normalizeForCompare(prompt))
        ? `What are the essential points to remember about ${fact.term} from "${fact.noteTitle}"?`
        : prompt;

      usedPromptFingerprints.add(normalizeForCompare(finalPrompt));
      generated.push({
        id: `local-q-${i + 1}`,
        type: 'short_answer',
        prompt: finalPrompt,
        options: [],
        correctAnswer: fact.detail,
        explanation: `Key reference from "${fact.noteTitle}": ${fact.detail}`,
        topic: fact.topic,
        sourceNoteId: fact.noteId,
      });
    }
  }

  return validateAndNormalizeQuestions(
    generated,
    notes.map((n) => n.noteId),
    subject
  );
}

/**
 * Deterministic local quiz evaluator used when all questions are MCQs, when Demo Mode is active,
 * or as a reliable fallback if AI short-answer grading is temporarily unavailable.
 */
export function evaluateQuizLocally(
  questions: GeneratedQuizQuestionPayload[],
  userAnswers: Record<string, string>
): QuizEvaluationResult {
  const evaluatedAnswers = questions.map((q) => {
    const submitted = (userAnswers[q.id] ?? '').trim();

    if (q.type === 'mcq') {
      const isCorrect = submitted.toLowerCase() === q.correctAnswer.trim().toLowerCase();
      return {
        questionId: q.id,
        userAnswer: submitted,
        isCorrect,
        feedback: isCorrect
          ? `Correct. ${q.explanation}`
          : `Expected "${q.correctAnswer}". ${q.explanation}`,
      };
    }

    // Short answer conceptual keyword matching against expected answer & explanation
    const expectedKeywords = extractKeywords(`${q.correctAnswer} ${q.topic}`);
    const submittedNorm = normalizeForCompare(submitted);
    const submittedTokens = new Set(extractKeywords(submitted));

    let matchedCount = 0;
    for (const kw of expectedKeywords) {
      if (submittedTokens.has(kw) || submittedNorm.includes(kw)) {
        matchedCount += 1;
      }
    }

    const ratio = expectedKeywords.length > 0 ? matchedCount / expectedKeywords.length : 0;
    const isCorrect =
      submitted.length >= 6 &&
      (submittedNorm === normalizeForCompare(q.correctAnswer) ||
        ratio >= 0.35 ||
        matchedCount >= 3);

    return {
      questionId: q.id,
      userAnswer: submitted,
      isCorrect,
      feedback: isCorrect
        ? `Good conceptual match with your notes. ${q.explanation}`
        : `Compare with expected concept: "${q.correctAnswer}". ${q.explanation}`,
    };
  });

  const correctCount = evaluatedAnswers.filter((a) => a.isCorrect).length;
  const totalQuestions = Math.max(1, questions.length);
  const score = Math.round((correctCount / totalQuestions) * 100);
  const weakTopics = Array.from(
    new Set(
      questions
        .filter((q) => !evaluatedAnswers.find((a) => a.questionId === q.id)?.isCorrect)
        .map((q) => q.topic)
        .filter(Boolean)
    )
  ).slice(0, 15);

  return {
    score,
    correctCount,
    totalQuestions: questions.length,
    evaluatedAnswers,
    weakTopics,
  };
}
