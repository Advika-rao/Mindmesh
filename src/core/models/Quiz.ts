import { QuizSubmissionException } from '../exceptions/MindMeshExceptions';

/**
 * OOP CONCEPT: Composition & Encapsulation
 * Quiz is composed of Question objects, and QuizAttempt encapsulates
 * immutable graded attempt records plus adaptive difficulty recommendation logic.
 */

export type QuizDifficulty = 'easy' | 'medium' | 'hard';
export type QuestionType = 'mcq' | 'short_answer';

export interface QuestionDTO {
  id: string;
  type: QuestionType;
  prompt: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  topic: string;
  sourceNoteId: string;
}

export interface EvaluatedAnswerDTO {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean;
  feedback: string;
}

export interface QuizAttemptDTO {
  attemptId: string;
  userId: string;
  subject: string;
  noteIds: string[];
  questions: QuestionDTO[];
  answers: EvaluatedAnswerDTO[];
  score: number;
  totalQuestions: number;
  difficulty: QuizDifficulty;
  weakTopics: string[];
  completedAt: Date;
}

export class Question {
  private readonly _id: string;
  private readonly _type: QuestionType;
  private readonly _prompt: string;
  private readonly _options: string[];
  private readonly _correctAnswer: string;
  private readonly _explanation: string;
  private readonly _topic: string;
  private readonly _sourceNoteId: string;

  constructor(dto: QuestionDTO) {
    this._id = dto.id;
    this._type = dto.type === 'short_answer' ? 'short_answer' : 'mcq';
    this._prompt = dto.prompt;
    this._options = Array.isArray(dto.options) ? [...dto.options] : [];
    this._correctAnswer = dto.correctAnswer;
    this._explanation = dto.explanation;
    this._topic = dto.topic || 'General';
    this._sourceNoteId = dto.sourceNoteId || '';
  }

  get id(): string { return this._id; }
  get type(): QuestionType { return this._type; }
  get prompt(): string { return this._prompt; }
  get options(): string[] { return [...this._options]; }
  get correctAnswer(): string { return this._correctAnswer; }
  get explanation(): string { return this._explanation; }
  get topic(): string { return this._topic; }
  get sourceNoteId(): string { return this._sourceNoteId; }

  public toDTO(): QuestionDTO {
    return {
      id: this._id,
      type: this._type,
      prompt: this._prompt,
      options: [...this._options],
      correctAnswer: this._correctAnswer,
      explanation: this._explanation,
      topic: this._topic,
      sourceNoteId: this._sourceNoteId,
    };
  }
}

export class Quiz {
  private readonly _subject: string;
  private readonly _difficulty: QuizDifficulty;
  private readonly _noteIds: string[];
  private readonly _questions: Question[];

  constructor(params: {
    subject: string;
    difficulty: QuizDifficulty;
    noteIds: string[];
    questions: QuestionDTO[];
  }) {
    if (!params.questions || params.questions.length === 0) {
      throw new QuizSubmissionException('A quiz must contain at least one question.');
    }
    this._subject = params.subject;
    this._difficulty = params.difficulty;
    this._noteIds = [...params.noteIds];
    this._questions = params.questions.map((q) => new Question(q));
  }

  get subject(): string { return this._subject; }
  get difficulty(): QuizDifficulty { return this._difficulty; }
  get noteIds(): string[] { return [...this._noteIds]; }
  get questions(): Question[] { return [...this._questions]; }

  public validateSubmission(userAnswers: Record<string, string>): void {
    const unanswered = this._questions.filter((q) => !(userAnswers[q.id] || '').trim());
    if (unanswered.length > 0) {
      throw new QuizSubmissionException(
        `Please answer all questions before submitting (${unanswered.length} remaining).`
      );
    }
  }
}

export class QuizAttempt {
  private readonly _attemptId: string;
  private readonly _userId: string;
  private readonly _subject: string;
  private readonly _noteIds: string[];
  private readonly _questions: Question[];
  private readonly _answers: EvaluatedAnswerDTO[];
  private readonly _score: number;
  private readonly _totalQuestions: number;
  private readonly _difficulty: QuizDifficulty;
  private readonly _weakTopics: string[];
  private readonly _completedAt: Date;

  constructor(dto: QuizAttemptDTO) {
    this._attemptId = dto.attemptId;
    this._userId = dto.userId;
    this._subject = dto.subject;
    this._noteIds = [...dto.noteIds];
    this._questions = dto.questions.map((q) => new Question(q));
    this._answers = [...dto.answers];
    this._score = dto.score;
    this._totalQuestions = dto.totalQuestions;
    this._difficulty = dto.difficulty;
    this._weakTopics = [...dto.weakTopics];
    this._completedAt = dto.completedAt;
  }

  get attemptId(): string { return this._attemptId; }
  get userId(): string { return this._userId; }
  get subject(): string { return this._subject; }
  get noteIds(): string[] { return [...this._noteIds]; }
  get questions(): Question[] { return [...this._questions]; }
  get answers(): EvaluatedAnswerDTO[] { return [...this._answers]; }
  get score(): number { return this._score; }
  get totalQuestions(): number { return this._totalQuestions; }
  get difficulty(): QuizDifficulty { return this._difficulty; }
  get weakTopics(): string[] { return [...this._weakTopics]; }
  get completedAt(): Date { return this._completedAt; }

  public toDTO(): QuizAttemptDTO {
    return {
      attemptId: this._attemptId,
      userId: this._userId,
      subject: this._subject,
      noteIds: [...this._noteIds],
      questions: this._questions.map((q) => q.toDTO()),
      answers: [...this._answers],
      score: this._score,
      totalQuestions: this._totalQuestions,
      difficulty: this._difficulty,
      weakTopics: [...this._weakTopics],
      completedAt: this._completedAt,
    };
  }

  /**
   * Adaptive Difficulty Recommendation Engine:
   * Analyzes previous attempts for a subject to recommend stepping up, holding,
   * or stepping down difficulty along with specific weak topics to revise.
   */
  public static recommendAdaptiveConfig(
    attempts: QuizAttempt[],
    subject: string
  ): {
    recommendedDifficulty: QuizDifficulty;
    rationale: string;
    averageScore: number;
    revisionTopics: string[];
  } {
    const subjectAttempts = attempts
      .filter((a) => subject === 'All Subjects' || a.subject.toLowerCase() === subject.toLowerCase())
      .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

    if (subjectAttempts.length === 0) {
      return {
        recommendedDifficulty: 'easy',
        rationale: 'First quiz on this topic — starting with Easy fundamentals to build a baseline.',
        averageScore: 0,
        revisionTopics: [],
      };
    }

    const recent = subjectAttempts.slice(0, 3);
    const avg = Math.round(recent.reduce((sum, a) => sum + a.score, 0) / recent.length);
    const lastDifficulty = recent[0].difficulty;

    const topicCounts = new Map<string, number>();
    for (const attempt of recent) {
      for (const topic of attempt.weakTopics) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }
    }
    const revisionTopics = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([topic]) => topic)
      .slice(0, 5);

    if (avg >= 80) {
      const next: QuizDifficulty =
        lastDifficulty === 'easy' ? 'medium' : 'hard';
      return {
        recommendedDifficulty: next,
        rationale:
          lastDifficulty === 'hard'
            ? `Strong mastery (${avg}% recent average). Staying at Hard to reinforce synthesis.`
            : `High accuracy (${avg}% recent average). Stepping up from ${lastDifficulty} to ${next}.`,
        averageScore: avg,
        revisionTopics,
      };
    }

    if (avg < 55) {
      const next: QuizDifficulty =
        lastDifficulty === 'hard' ? 'medium' : 'easy';
      return {
        recommendedDifficulty: next,
        rationale: `Recent average is ${avg}%. Recommending ${next} revision questions before advancing.`,
        averageScore: avg,
        revisionTopics,
      };
    }

    return {
      recommendedDifficulty: lastDifficulty,
      rationale: `Steady progress (${avg}% recent average). Continuing at ${lastDifficulty} level with targeted revision.`,
      averageScore: avg,
      revisionTopics,
    };
  }
}
