import { BaseFeatureService } from './BaseFeatureService';
import {
  AIServiceException,
  QuizSubmissionException,
  ValidationException,
} from '../exceptions/MindMeshExceptions';
import type {
  AINoteContext,
  AIProvider,
  FeatureContext,
  Generatable,
  GeneratedQuizQuestionPayload,
  QuizEvaluationResult,
  StudyAssistantRetryNotice,
} from '../interfaces/CoreInterfaces';
import type { Note } from '../models/Note';
import { Quiz, QuizAttempt, type QuizDifficulty } from '../models/Quiz';
import {
  generateSafeId,
  type ActivityHistoryRepository,
  type QuizAttemptRepository,
} from '../repositories/FirestoreRepositories';
import {
  evaluateQuizLocally,
  generateLocalQuiz,
  validateAndNormalizeQuestions,
} from '../utils/localQuizGenerator';
import { isGenericNoteTitle, resolveNoteDisplayTitle } from '../utils/sourceNotes';

/**
 * OOP CONCEPTS: Inheritance, Polymorphism, Abstraction (implements Generatable)
 * Feature 5: QuizGeneratorService extends BaseFeatureService to generate adaptive quizzes
 * from the user's saved notes, validate all questions before rendering, gracefully fall back
 * to local note-grounded generation when AI is unavailable, evaluate submissions, and persist attempts.
 */

export type QuizErrorCategory =
  | 'quota_exhausted'
  | 'rate_limit'
  | 'timeout'
  | 'server_error'
  | 'network_error'
  | 'invalid_response';

export interface QuizFallbackInfo {
  category: QuizErrorCategory;
  title: string;
  message: string;
  canRetry: boolean;
  retryAfterSeconds?: number;
}

export type QuizGenerationSource = 'ai' | 'cached' | 'local_fallback' | 'demo';

export interface QuizGenerateInput {
  selectedNotes: Note[];
  subject: string;
  difficulty: QuizDifficulty;
  questionCount: number;
  previousAttempts: QuizAttempt[];
  demoMode?: boolean;
  forceLocal?: boolean;
  bypassCache?: boolean;
  signal?: AbortSignal;
  onRetry?: (notice: StudyAssistantRetryNotice) => void;
}

export interface QuizGenerationResult {
  quiz: Quiz;
  generationSource: QuizGenerationSource;
  statusLabel: string;
  fallbackInfo?: QuizFallbackInfo;
}

export interface QuizEvaluationAttemptResult {
  attempt: QuizAttempt;
  savedToCloud: boolean;
  usedLocalGradingFallback: boolean;
}

export function classifyQuizError(error: unknown): QuizFallbackInfo {
  if (error instanceof AIServiceException) {
    if (error.isQuotaExhausted || error.serverCode === 'QUOTA_EXHAUSTED') {
      return {
        category: 'quota_exhausted',
        title: 'AI API quota exhausted',
        message:
          'Your Gemini API quota is currently exhausted, so MindMesh generated a grounded quiz locally from your saved notes instead.',
        canRetry: false,
      };
    }

    if (error.statusCode === 429 || error.serverCode === 'RATE_LIMITED') {
      return {
        category: 'rate_limit',
        title: 'AI is temporarily rate-limited (429)',
        message:
          'Too many AI requests were sent recently. A local quiz was generated from your notes so you can keep practicing, or retry with AI shortly.',
        canRetry: true,
        retryAfterSeconds: error.retryAfterSeconds ?? 8,
      };
    }

    if (error.statusCode === 504 || error.serverCode === 'TIMEOUT') {
      return {
        category: 'timeout',
        title: 'AI request timed out',
        message:
          'The AI quiz service took too long to respond. MindMesh built a quiz directly from your saved notes instead, or you can retry with AI.',
        canRetry: true,
      };
    }

    if (
      error.serverCode === 'INVALID_RESPONSE' ||
      error.serverCode === 'PARSING_ERROR' ||
      error.serverCode === 'EMPTY_AI_RESPONSE' ||
      error.serverCode === 'NON_JSON_HTML_RESPONSE'
    ) {
      return {
        category: 'invalid_response',
        title: 'AI returned an incomplete response',
        message:
          'The AI response could not be validated into quiz questions. MindMesh generated a grounded quiz locally from your notes instead.',
        canRetry: true,
      };
    }

    if (error.statusCode === 0 || error.serverCode === 'NETWORK_ERROR') {
      return {
        category: 'network_error',
        title: 'Network connection error',
        message:
          'Could not reach the AI service. MindMesh generated a quiz locally from your saved notes instead.',
        canRetry: true,
      };
    }

    return {
      category: 'server_error',
      title: 'AI service temporarily unavailable',
      message:
        'The AI service is experiencing temporary load. MindMesh generated a quiz locally from your saved notes so your study session is uninterrupted.',
      canRetry: true,
    };
  }

  return {
    category: 'network_error',
    title: 'AI quiz generation unavailable',
    message:
      'Could not complete AI quiz generation. A grounded quiz was created locally from your saved notes instead.',
    canRetry: true,
  };
}

const QUIZ_CLIENT_CACHE_TTL_MS = 2 * 60 * 1000;
const QUIZ_CLIENT_CACHE_MAX_ITEMS = 16;

export class QuizGeneratorService
  extends BaseFeatureService<QuizGenerateInput, Quiz>
  implements Generatable<{ context: FeatureContext; input: QuizGenerateInput }, Quiz>
{
  private readonly quizRepo: QuizAttemptRepository;
  private readonly quizCache = new Map<
    string,
    { expiresAt: number; questions: GeneratedQuizQuestionPayload[] }
  >();

  constructor(
    aiProvider: AIProvider,
    activityRepo: ActivityHistoryRepository,
    quizRepo: QuizAttemptRepository
  ) {
    super(aiProvider, activityRepo);
    this.quizRepo = quizRepo;
  }

  public getServiceName(): string {
    return 'QuizGeneratorService';
  }

  public async generate(config: { context: FeatureContext; input: QuizGenerateInput }): Promise<Quiz> {
    return this.execute(config.context, config.input);
  }

  public async execute(context: FeatureContext, input: QuizGenerateInput): Promise<Quiz> {
    const result = await this.generateWithFallback(context, input);
    return result.quiz;
  }

  /**
   * Generates a validated adaptive quiz from the selected notes / subject.
   * Handles Demo Mode, short TTL caching, timeout/rate-limit/quota classification,
   * strict question validation, and automatic local saved-note fallback so quiz
   * generation never hangs or breaks a live demo.
   */
  public async generateWithFallback(
    context: FeatureContext,
    input: QuizGenerateInput
  ): Promise<QuizGenerationResult> {
    this.validateUserContext(context);
    if (!input.selectedNotes || input.selectedNotes.length === 0) {
      throw new ValidationException(
        'Select at least one note or a subject with saved notes before generating a quiz.',
        'selectedNotes'
      );
    }

    // Deduplicate notes by noteId and resolve meaningful display titles
    const seenIds = new Set<string>();
    const verifiedNotes: Note[] = [];
    for (const note of input.selectedNotes) {
      if (!note || !note.noteId || seenIds.has(note.noteId)) continue;
      seenIds.add(note.noteId);
      verifiedNotes.push(note);
    }

    if (verifiedNotes.length === 0) {
      throw new ValidationException('No valid saved notes were selected.', 'selectedNotes');
    }

    const noteContexts: AINoteContext[] = verifiedNotes.map((n) => {
      const ctx = n.toAIContext();
      return {
        ...ctx,
        title: isGenericNoteTitle(ctx.title) ? resolveNoteDisplayTitle(ctx) : ctx.title,
      };
    });

    const validNoteIds = verifiedNotes.map((n) => n.noteId);
    const adaptive = QuizAttempt.recommendAdaptiveConfig(input.previousAttempts, input.subject);
    const cacheKey = this.buildCacheKey(
      context.userId,
      input.subject,
      input.difficulty,
      input.questionCount,
      noteContexts
    );

    let validatedQuestions: GeneratedQuizQuestionPayload[] = [];
    let generationSource: QuizGenerationSource = 'ai';
    let statusLabel = 'AI quiz generated successfully';
    let fallbackInfo: QuizFallbackInfo | undefined;

    const cachedEntry = this.quizCache.get(cacheKey);
    if (
      !input.forceLocal &&
      !input.bypassCache &&
      !input.demoMode &&
      cachedEntry &&
      cachedEntry.expiresAt > Date.now()
    ) {
      validatedQuestions = cachedEntry.questions;
      generationSource = 'cached';
      statusLabel = 'Cached AI quiz displayed';
    } else if (input.demoMode) {
      validatedQuestions = generateLocalQuiz({
        notes: noteContexts,
        subject: input.subject,
        difficulty: input.difficulty,
        questionCount: input.questionCount,
        weakTopics: adaptive.revisionTopics,
      });
      generationSource = 'demo';
      statusLabel = 'Demo Mode active — quiz generated from your saved notes';
    } else if (input.forceLocal) {
      validatedQuestions = generateLocalQuiz({
        notes: noteContexts,
        subject: input.subject,
        difficulty: input.difficulty,
        questionCount: input.questionCount,
        weakTopics: adaptive.revisionTopics,
      });
      generationSource = 'local_fallback';
      statusLabel = 'Local note-based quiz generated';
    } else {
      try {
        const result = await this.aiProvider.generateQuiz(
          {
            notes: noteContexts,
            subject: input.subject,
            difficulty: input.difficulty,
            questionCount: input.questionCount,
            weakTopics: adaptive.revisionTopics,
            bypassCache: input.bypassCache,
          },
          {
            signal: input.signal,
            onRetry: input.onRetry,
          }
        );

        validatedQuestions = validateAndNormalizeQuestions(
          result.questions,
          validNoteIds,
          input.subject
        );

        if (validatedQuestions.length === 0) {
          throw new AIServiceException(
            'The AI returned malformed quiz questions that could not be validated.',
            502,
            'INVALID_RESPONSE'
          );
        }

        this.storeCacheEntry(cacheKey, validatedQuestions);
        if (result.cached) {
          generationSource = 'cached';
          statusLabel = 'Cached AI quiz displayed';
        } else {
          generationSource = 'ai';
          statusLabel = 'AI quiz generated successfully';
        }
      } catch (error) {
        // Respect explicit user cancellation — never build a fallback if cancelled
        if (
          input.signal?.aborted ||
          (error instanceof AIServiceException &&
            (error.statusCode === 499 || error.serverCode === 'CANCELLED'))
        ) {
          throw new AIServiceException('Quiz generation cancelled.', 499, 'CANCELLED');
        }

        fallbackInfo = classifyQuizError(error);
        validatedQuestions = generateLocalQuiz({
          notes: noteContexts,
          subject: input.subject,
          difficulty: input.difficulty,
          questionCount: input.questionCount,
          weakTopics: adaptive.revisionTopics,
        });
        generationSource = 'local_fallback';
        statusLabel =
          fallbackInfo.category === 'quota_exhausted' || fallbackInfo.category === 'rate_limit'
            ? 'AI busy/quota exceeded — local note quiz active'
            : 'Local fallback quiz active';
      }
    }

    if (input.signal?.aborted) {
      throw new AIServiceException('Quiz generation cancelled.', 499, 'CANCELLED');
    }

    if (validatedQuestions.length === 0) {
      throw new QuizSubmissionException(
        'Could not build quiz questions from the selected notes. Add more content to your notes and try again.'
      );
    }

    const quiz = new Quiz({
      subject: input.subject,
      difficulty: input.difficulty,
      noteIds: validNoteIds,
      questions: validatedQuestions,
    });

    return {
      quiz,
      generationSource,
      statusLabel,
      fallbackInfo,
    };
  }

  public async evaluateAndSaveAttempt(
    context: FeatureContext,
    quiz: Quiz,
    userAnswers: Record<string, string>,
    options?: { demoMode?: boolean; signal?: AbortSignal }
  ): Promise<QuizAttempt> {
    const outcome = await this.evaluateAndSaveAttemptDetailed(context, quiz, userAnswers, options);
    return outcome.attempt;
  }

  public async evaluateAndSaveAttemptDetailed(
    context: FeatureContext,
    quiz: Quiz,
    userAnswers: Record<string, string>,
    options?: { demoMode?: boolean; signal?: AbortSignal }
  ): Promise<QuizEvaluationAttemptResult> {
    this.validateUserContext(context);
    quiz.validateSubmission(userAnswers);

    const questionDTOs = quiz.questions.map((q) => q.toDTO());
    const hasShortAnswer = questionDTOs.some((q) => q.type === 'short_answer');

    let evaluation: QuizEvaluationResult;
    let usedLocalGradingFallback = false;

    if (options?.demoMode || !hasShortAnswer) {
      // Pure MCQ quizzes or Demo Mode can be graded deterministically without wasting API quota
      evaluation = evaluateQuizLocally(questionDTOs, userAnswers);
    } else {
      try {
        evaluation = await this.aiProvider.evaluateQuiz(
          {
            questions: questionDTOs,
            userAnswers,
          },
          { signal: options?.signal }
        );

        if (!evaluation || !Array.isArray(evaluation.evaluatedAnswers) || evaluation.evaluatedAnswers.length === 0) {
          evaluation = evaluateQuizLocally(questionDTOs, userAnswers);
          usedLocalGradingFallback = true;
        }
      } catch (error) {
        if (
          options?.signal?.aborted ||
          (error instanceof AIServiceException &&
            (error.statusCode === 499 || error.serverCode === 'CANCELLED'))
        ) {
          throw error;
        }
        // Gracefully grade locally if AI evaluation is unavailable or times out
        evaluation = evaluateQuizLocally(questionDTOs, userAnswers);
        usedLocalGradingFallback = true;
      }
    }

    const attempt = new QuizAttempt({
      attemptId: generateSafeId('quiz'),
      userId: context.userId,
      subject: quiz.subject,
      noteIds: quiz.noteIds,
      questions: questionDTOs,
      answers: evaluation.evaluatedAnswers,
      score: evaluation.score,
      totalQuestions: evaluation.totalQuestions,
      difficulty: quiz.difficulty,
      weakTopics: evaluation.weakTopics,
      completedAt: new Date(),
    });

    let savedToCloud = false;
    try {
      await this.quizRepo.save(attempt);
      savedToCloud = true;
    } catch {
      savedToCloud = false;
    }

    try {
      await this.activityRepo.logActivity({
        userId: context.userId,
        activityType: 'quiz_completed',
        title: `Completed ${quiz.difficulty} Quiz (${quiz.subject})`,
        description: `Scored ${attempt.score}% (${evaluation.correctCount}/${evaluation.totalQuestions} correct).`,
        entityId: attempt.attemptId,
      });
    } catch {
      // Non-critical activity log error should never block displaying quiz results
    }

    return {
      attempt,
      savedToCloud,
      usedLocalGradingFallback,
    };
  }

  public async deleteAttempt(attemptId: string): Promise<void> {
    await this.quizRepo.delete(attemptId);
  }

  private buildCacheKey(
    userId: string,
    subject: string,
    difficulty: QuizDifficulty,
    questionCount: number,
    notes: AINoteContext[]
  ): string {
    const notesKey = notes
      .map((n) => `${n.noteId}:${n.content.length}`)
      .sort()
      .join('|');
    return `${userId}::${subject.toLowerCase()}::${difficulty}::${questionCount}::${notesKey}`;
  }

  private storeCacheEntry(key: string, questions: GeneratedQuizQuestionPayload[]): void {
    if (this.quizCache.size >= QUIZ_CLIENT_CACHE_MAX_ITEMS) {
      const oldestKey = this.quizCache.keys().next().value;
      if (oldestKey) this.quizCache.delete(oldestKey);
    }
    this.quizCache.set(key, {
      expiresAt: Date.now() + QUIZ_CLIENT_CACHE_TTL_MS,
      questions,
    });
  }
}
