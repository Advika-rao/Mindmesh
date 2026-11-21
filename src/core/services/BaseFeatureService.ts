import { ValidationException } from '../exceptions/MindMeshExceptions';
import type { AIProvider, FeatureContext } from '../interfaces/CoreInterfaces';
import type { ActivityHistoryRepository } from '../repositories/FirestoreRepositories';

/**
 * OOP CONCEPTS: Abstraction, Inheritance, Polymorphism
 * BaseFeatureService is the abstract superclass for MindMesh feature services:
 * - BrainGraphService
 * - StudyAssistantService
 * - MindMapService
 * - QuizGeneratorService
 * - MemoryRevivalService
 * - ConnectionExplanationService
 * - SmartNoteCaptureService
 *
 * Subclasses inherit shared AIProvider injection, activity logging, and user validation,
 * and override execute() and getServiceName() polymorphically.
 */
export abstract class BaseFeatureService<TInput, TOutput> {
  protected readonly aiProvider: AIProvider;
  protected readonly activityRepo: ActivityHistoryRepository;

  constructor(aiProvider: AIProvider, activityRepo: ActivityHistoryRepository) {
    this.aiProvider = aiProvider;
    this.activityRepo = activityRepo;
  }

  public abstract getServiceName(): string;

  public abstract execute(context: FeatureContext, input: TInput): Promise<TOutput>;

  protected validateUserContext(context: FeatureContext): void {
    if (!context || !context.userId || !context.userId.trim()) {
      throw new ValidationException('An authenticated user session is required.', 'userId');
    }
  }
}
