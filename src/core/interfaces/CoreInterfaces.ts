/**
 * OOP CONCEPT: Abstraction & Interfaces
 * Core interfaces define clean contracts for persistence (Repository),
 * semantic retrieval (Searchable), connection reasoning (Explainable),
 * AI content generation (Generatable), and server-side AI communication (AIProvider).
 */

export interface Repository<T> {
  getById(id: string): Promise<T | null>;
  listByUser(userId: string): Promise<T[]>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface Searchable<TQuery, TResult> {
  search(query: TQuery): Promise<TResult[]>;
}

export interface Explainable<TInput, TExplanation> {
  explain(input: TInput): Promise<TExplanation>;
}

export interface Generatable<TConfig, TOutput> {
  generate(config: TConfig): Promise<TOutput>;
}

export interface AINoteContext {
  noteId: string;
  title: string;
  subject: string;
  tags: string[];
  content: string;
}

export interface StudyAssistantResponse {
  answer: string;
  citedNoteIds: string[];
  insufficientContext: boolean;
  suggestedFollowUps: string[];
  cached?: boolean;
}

export interface StudyAssistantRetryNotice {
  attempt: number;
  maxAttempts: number;
  delaySeconds: number;
  reason: 'rate_limit' | 'server_busy';
}

export interface GeneratedMindMapPayload {
  title: string;
  nodes: Array<{
    id: string;
    title: string;
    description: string;
    level: number;
    parentId: string;
  }>;
  connections: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
  }>;
  cached?: boolean;
}

export interface GeneratedQuizQuestionPayload {
  id: string;
  type: 'mcq' | 'short_answer';
  prompt: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  topic: string;
  sourceNoteId: string;
}

export interface QuizEvaluationResult {
  score: number;
  correctCount: number;
  totalQuestions: number;
  evaluatedAnswers: Array<{
    questionId: string;
    userAnswer: string;
    isCorrect: boolean;
    feedback: string;
  }>;
  weakTopics: string[];
}

export interface MemoryRevivalReason {
  noteId: string;
  reason: string;
  keyTakeaway: string;
}

export interface ConnectionExplanationPayload {
  summary: string;
  explanation: string;
  intermediateConcepts: string[];
  examples: string[];
  connectionStrengthNote: string;
}

export interface CaptureImageInput {
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64Data: string;
}

export interface SmartNoteCapturePayload {
  extractedMarkdown: string;
  hasUnclearText: boolean;
  unclearWarnings: string[];
  isEmptyExtraction: boolean;
  confidenceNote: string;
  suggestedTitle: string;
  suggestedSummary: string;
  suggestedSubject: string;
  suggestedTags: string[];
}

export type CaptureResponseFormat =
  | 'json'
  | 'fenced-json'
  | 'plain-text'
  | 'markdown'
  | 'html-error'
  | 'empty';

export interface ExtractionDebugInfo {
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  detectedFormat?: string;
  imageAttached: boolean;
  base64Length: number;
  modelName: string;
  thinkingLevel?: string;
  retryMode?: 'standard' | 'enhanced';
  httpStatus: number;
  responseContentType?: string;
  responseFormat?: CaptureResponseFormat;
  extractedTextLength?: number;
  wordCount?: number;
  qualityCheckPassed?: boolean;
  qualityCheckReason?: string;
  retryCount?: number;
  finishReason?: string;
  rawResponsePreview?: string;
  durationMs: number;
  actualError?: string;
  fallbackAttempted?: boolean;
}

export interface PageExtractionResult {
  extractedMarkdown: string;
  hasUnclearText: boolean;
  unclearWarnings: string[];
  isEmptyExtraction: boolean;
  confidenceNote: string;
  wordCount?: number;
  qualityCheckPassed?: boolean;
  qualityCheckReason?: string;
  retryCount?: number;
  modelUsed?: string;
  debug?: ExtractionDebugInfo;
  suggestedTitle?: string;
  suggestedSummary?: string;
  suggestedSubject?: string;
  suggestedTags?: string[];
}

export interface CaptureMetadataPayload {
  suggestedTitle: string;
  suggestedSummary: string;
  suggestedSubject: string;
  suggestedTags: string[];
}

export interface ConceptGraphNodePayload {
  id: string;
  label: string;
  category: string;
  description: string;
  tier: number;
  sourceNoteIds: string[];
}

export interface ConceptGraphEdgePayload {
  id: string;
  source: string;
  target: string;
  relationship: string;
  reason: string;
}

export interface GeneratedConceptGraphPayload {
  graphTitle: string;
  summary: string;
  concepts: ConceptGraphNodePayload[];
  edges: ConceptGraphEdgePayload[];
  modelUsed?: string;
  cached?: boolean;
}

export interface ConceptConnectionExplanationPayload {
  summary: string;
  whyConnected: string;
  howTheyRelate: string;
  explanation: string;
  examples: string[];
  intermediateConcepts: string[];
  citedNoteIds: string[];
  connectionStrengthNote: string;
  cached?: boolean;
}

export interface AIProvider {
  generateEmbedding(text: string): Promise<number[]>;
  askStudyAssistant(
    params: {
      question: string;
      notes: AINoteContext[];
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      mode?: 'ask' | 'simplify' | 'summarize' | 'examples';
    },
    options?: {
      signal?: AbortSignal;
      onRetry?: (notice: StudyAssistantRetryNotice) => void;
    }
  ): Promise<StudyAssistantResponse>;
  generateMindMap(
    params: {
      notes: AINoteContext[];
      customTitle?: string;
    },
    options?: {
      signal?: AbortSignal;
      onRetry?: (notice: StudyAssistantRetryNotice) => void;
    }
  ): Promise<GeneratedMindMapPayload>;
  generateQuiz(
    params: {
      notes: AINoteContext[];
      subject?: string;
      difficulty: 'easy' | 'medium' | 'hard';
      questionCount: number;
      weakTopics?: string[];
      bypassCache?: boolean;
    },
    options?: {
      signal?: AbortSignal;
      onRetry?: (notice: StudyAssistantRetryNotice) => void;
    }
  ): Promise<{ questions: GeneratedQuizQuestionPayload[]; cached?: boolean }>;
  evaluateQuiz(
    params: {
      questions: GeneratedQuizQuestionPayload[];
      userAnswers: Record<string, string>;
    },
    options?: {
      signal?: AbortSignal;
    }
  ): Promise<QuizEvaluationResult>;
  analyzeMemoryRevival(params: {
    currentNote: AINoteContext;
    candidateNotes: Array<AINoteContext & { similarity: number }>;
  }): Promise<{ revivals: MemoryRevivalReason[] }>;
  explainConnection(params: {
    sourceNote: AINoteContext;
    targetNote: AINoteContext;
    intermediateNotes: AINoteContext[];
    sharedTags: string[];
    similarityScore: number;
  }): Promise<ConnectionExplanationPayload>;
  generateBrainGraph(
    params: { notes: AINoteContext[] },
    signal?: AbortSignal
  ): Promise<GeneratedConceptGraphPayload>;
  explainConceptConnection(
    params: {
      sourceConcept: {
        id: string;
        label: string;
        category: string;
        description: string;
        sourceNoteIds: string[];
      };
      targetConcept: {
        id: string;
        label: string;
        category: string;
        description: string;
        sourceNoteIds: string[];
      };
      relationship: string;
      edgeReason: string;
      selectedNotes: AINoteContext[];
    },
    signal?: AbortSignal
  ): Promise<ConceptConnectionExplanationPayload>;
  captureNotesFromImages(
    params: {
      images: CaptureImageInput[];
      generateMetadata: boolean;
      existingSubjects: string[];
    },
    signal?: AbortSignal
  ): Promise<SmartNoteCapturePayload>;
  extractSinglePageNote(
    params: {
      image: CaptureImageInput;
      pageNumber: number;
      totalPages: number;
      includeMetadata: boolean;
      existingSubjects: string[];
      retryMode?: 'standard' | 'enhanced';
      preferredModel?: 'primary' | 'secondary';
    },
    signal?: AbortSignal
  ): Promise<PageExtractionResult>;
  generateCaptureMetadata(
    params: {
      combinedMarkdown: string;
      existingSubjects: string[];
    },
    signal?: AbortSignal
  ): Promise<CaptureMetadataPayload>;
}

export interface FeatureContext {
  userId: string;
}
