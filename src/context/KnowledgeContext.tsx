import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { collection, onSnapshot, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../firebase/config';
import { handleFirestoreError, OperationType } from '../firebase/errors';
import { useAuth } from './AuthContext';
import { Note, NoteVersion } from '../core/models/Note';
import { GraphNode, KnowledgeGraph, type GraphRelationshipDTO } from '../core/models/KnowledgeGraph';
import { MindMap, type MindMapConnectionDTO, type MindMapNodeDTO } from '../core/models/MindMap';
import { QuizAttempt, type EvaluatedAnswerDTO, type QuestionDTO, type QuizDifficulty } from '../core/models/Quiz';
import { Subject } from '../core/models/Subject';
import {
  User,
  type ActivityHistoryDTO,
  type ActivityType,
  type AIConversationDTO,
  type ChatMessageDTO,
  type RevivedMemoryStateDTO,
  type SavedExplanationDTO,
  type SavedSnippetDTO,
} from '../core/models/User';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';

/**
 * Central Personal Knowledge Repository Context:
 * Subscribes in real time to the authenticated user's Firestore collections and exposes
 * unified OOP domain instances (Note, KnowledgeGraph, MindMap, QuizAttempt, Subject, User)
 * so all six features share one synchronized knowledge graph and repository.
 */

export type AppPage =
  | 'dashboard'
  | 'notes'
  | 'brain-graph'
  | 'study-assistant'
  | 'mind-map'
  | 'adaptive-quiz'
  | 'memory-revival'
  | 'explain-connection'
  | 'history'
  | 'settings';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface KnowledgeContextValue {
  // Domain models
  userAggregate: User | null;
  notes: Note[];
  subjects: Subject[];
  noteVersions: NoteVersion[];
  graphNodes: GraphNode[];
  knowledgeGraph: KnowledgeGraph;
  mindMaps: MindMap[];
  quizAttempts: QuizAttempt[];
  conversations: AIConversationDTO[];
  activities: ActivityHistoryDTO[];
  revivedStates: RevivedMemoryStateDTO[];
  savedExplanations: SavedExplanationDTO[];
  dataLoading: boolean;

  // Cross-feature navigation & active selection
  activePage: AppPage;
  setActivePage: (page: AppPage) => void;
  activeNoteId: string | null;
  setActiveNoteId: (noteId: string | null) => void;
  openNoteInEditor: (noteId: string) => void;
  explainPair: { sourceNoteId: string; targetNoteId: string } | null;
  openExplainConnection: (sourceNoteId: string, targetNoteId: string) => void;
  selectedConversationId: string | null;
  setSelectedConversationId: (id: string | null) => void;
  selectedMindMapId: string | null;
  setSelectedMindMapId: (id: string | null) => void;

  // Presentation / Demo Mode (uses cached & local saved-note synthesis without burning API quota)
  demoMode: boolean;
  setDemoMode: (enabled: boolean) => void;

  // Notifications
  toasts: ToastMessage[];
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
  dismissToast: (id: string) => void;
}

const KnowledgeContext = createContext<KnowledgeContextValue | null>(null);

function toDate(val: unknown): Date {
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  if (typeof val === 'string' || typeof val === 'number') return new Date(val);
  return new Date();
}

export const KnowledgeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { firebaseUser, profile, emailVerified } = useAuth();
  const uid = firebaseUser?.uid ?? null;

  const [notes, setNotes] = useState<Note[]>([]);
  const [noteVersions, setNoteVersions] = useState<NoteVersion[]>([]);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [mindMaps, setMindMaps] = useState<MindMap[]>([]);
  const [quizAttempts, setQuizAttempts] = useState<QuizAttempt[]>([]);
  const [conversations, setConversations] = useState<AIConversationDTO[]>([]);
  const [activities, setActivities] = useState<ActivityHistoryDTO[]>([]);
  const [revivedStates, setRevivedStates] = useState<RevivedMemoryStateDTO[]>([]);
  const [savedExplanations, setSavedExplanations] = useState<SavedExplanationDTO[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [activePage, setActivePage] = useState<AppPage>('dashboard');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [explainPair, setExplainPair] = useState<{ sourceNoteId: string; targetNoteId: string } | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedMindMapId, setSelectedMindMapId] = useState<string | null>(null);
  const [demoMode, setDemoModeState] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem('mindmesh_demo_mode_v1') === 'true';
    } catch {
      return false;
    }
  });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const setDemoMode = useCallback((enabled: boolean) => {
    setDemoModeState(enabled);
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('mindmesh_demo_mode_v1', enabled ? 'true' : 'false');
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const notify = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const openNoteInEditor = useCallback((noteId: string) => {
    setActiveNoteId(noteId);
    setActivePage('notes');
  }, []);

  const openExplainConnection = useCallback((sourceNoteId: string, targetNoteId: string) => {
    setExplainPair({ sourceNoteId, targetNoteId });
    setActivePage('explain-connection');
  }, []);

  // Real-time Firestore listeners guarded by authenticated user
  useEffect(() => {
    if (!uid || !emailVerified) {
      setNotes([]);
      setNoteVersions([]);
      setGraphNodes([]);
      setMindMaps([]);
      setQuizAttempts([]);
      setConversations([]);
      setActivities([]);
      setRevivedStates([]);
      setSavedExplanations([]);
      setDataLoading(false);
      return;
    }

    setDataLoading(true);
    let notesReady = false;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(
        query(collection(db, 'notes'), where('userId', '==', uid)),
        (snap) => {
          const list = snap.docs
            .map((d) => {
              const data = d.data();
              return new Note({
                noteId: d.id,
                userId: String(data.userId || uid),
                title: String(data.title || 'Untitled'),
                content: String(data.content || ' '),
                subject: String(data.subject || 'General'),
                tags: Array.isArray(data.tags) ? data.tags : [],
                embedding: Array.isArray(data.embedding) ? data.embedding : [],
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt),
              });
            })
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          setNotes(list);
          if (!notesReady) {
            notesReady = true;
            setDataLoading(false);
          }
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'notes')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'noteVersions'), where('userId', '==', uid)),
        (snap) => {
          const list = snap.docs
            .map((d) => {
              const data = d.data();
              return new NoteVersion({
                versionId: String(data.versionId || d.id),
                userId: String(data.userId || uid),
                noteId: String(data.noteId || ''),
                title: String(data.title || ''),
                previousContent: String(data.previousContent || ''),
                subject: String(data.subject || 'General'),
                updatedAt: toDate(data.updatedAt),
              });
            })
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          setNoteVersions(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'noteVersions')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'knowledgeGraph'), where('userId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => {
            const data = d.data();
            return new GraphNode({
              graphNodeId: String(data.graphNodeId || d.id),
              userId: String(data.userId || uid),
              noteId: String(data.noteId || ''),
              concept: String(data.concept || ''),
              subject: String(data.subject || 'General'),
              positionX: Number(data.positionX ?? 0),
              positionY: Number(data.positionY ?? 0),
              relationships: Array.isArray(data.relationships)
                ? (data.relationships as GraphRelationshipDTO[])
                : [],
              updatedAt: toDate(data.updatedAt),
            });
          });
          setGraphNodes(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'knowledgeGraph')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'mindMaps'), where('userId', '==', uid)),
        (snap) => {
          const list = snap.docs
            .map((d) => {
              const data = d.data();
              return new MindMap({
                mindMapId: String(data.mindMapId || d.id),
                userId: String(data.userId || uid),
                title: String(data.title || 'Untitled Mind Map'),
                nodes: Array.isArray(data.nodes) ? (data.nodes as MindMapNodeDTO[]) : [],
                connections: Array.isArray(data.connections) ? (data.connections as MindMapConnectionDTO[]) : [],
                sourceNoteIds: Array.isArray(data.sourceNoteIds) ? (data.sourceNoteIds as string[]) : [],
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt),
              });
            })
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          setMindMaps(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'mindMaps')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'quizAttempts'), where('userId', '==', uid)),
        (snap) => {
          const list = snap.docs
            .map((d) => {
              const data = d.data();
              return new QuizAttempt({
                attemptId: String(data.attemptId || d.id),
                userId: String(data.userId || uid),
                subject: String(data.subject || 'General'),
                noteIds: Array.isArray(data.noteIds) ? (data.noteIds as string[]) : [],
                questions: Array.isArray(data.questions) ? (data.questions as QuestionDTO[]) : [],
                answers: Array.isArray(data.answers) ? (data.answers as EvaluatedAnswerDTO[]) : [],
                score: Number(data.score ?? 0),
                totalQuestions: Number(data.totalQuestions ?? 1),
                difficulty: (data.difficulty as QuizDifficulty) || 'medium',
                weakTopics: Array.isArray(data.weakTopics) ? (data.weakTopics as string[]) : [],
                completedAt: toDate(data.completedAt),
              });
            })
            .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
          setQuizAttempts(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'quizAttempts')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'aiConversations'), where('userId', '==', uid)),
        (snap) => {
          const list: AIConversationDTO[] = snap.docs
            .map((d) => {
              const data = d.data();
              return {
                conversationId: String(data.conversationId || d.id),
                userId: String(data.userId || uid),
                title: String(data.title || 'Study Conversation'),
                messages: Array.isArray(data.messages) ? (data.messages as ChatMessageDTO[]) : [],
                savedSnippets: Array.isArray(data.savedSnippets)
                  ? (data.savedSnippets as SavedSnippetDTO[])
                  : [],
                createdAt: toDate(data.createdAt),
                updatedAt: toDate(data.updatedAt),
              };
            })
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          setConversations(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'aiConversations')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'activityHistory'), where('userId', '==', uid)),
        (snap) => {
          const list: ActivityHistoryDTO[] = snap.docs
            .filter((d) => d.data().activityType !== 'search')
            .map((d) => {
              const data = d.data();
              return {
                activityId: String(data.activityId || d.id),
                userId: String(data.userId || uid),
                activityType: (data.activityType as ActivityType) || 'note_created',
                title: String(data.title || 'Activity'),
                description: String(data.description || ''),
                entityId: String(data.entityId || ''),
                timestamp: toDate(data.timestamp),
              };
            })
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
          setActivities(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'activityHistory')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'revivedStates'), where('userId', '==', uid)),
        (snap) => {
          const list: RevivedMemoryStateDTO[] = snap.docs.map((d) => {
            const data = d.data();
            return {
              stateId: String(data.stateId || d.id),
              userId: String(data.userId || uid),
              sourceNoteId: String(data.sourceNoteId || ''),
              revivedNoteId: String(data.revivedNoteId || ''),
              status: data.status === 'bookmarked' ? 'bookmarked' : 'dismissed',
              reason: String(data.reason || ''),
              updatedAt: toDate(data.updatedAt),
            };
          });
          setRevivedStates(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'revivedStates')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'savedExplanations'), where('userId', '==', uid)),
        (snap) => {
          const list: SavedExplanationDTO[] = snap.docs
            .map((d) => {
              const data = d.data();
              return {
                explanationId: String(data.explanationId || d.id),
                userId: String(data.userId || uid),
                sourceNodeId: String(data.sourceNodeId || ''),
                targetNodeId: String(data.targetNodeId || ''),
                sourceTitle: String(data.sourceTitle || ''),
                targetTitle: String(data.targetTitle || ''),
                intermediateConcepts: Array.isArray(data.intermediateConcepts)
                  ? (data.intermediateConcepts as string[])
                  : [],
                explanation: String(data.explanation || ''),
                examples: Array.isArray(data.examples) ? (data.examples as string[]) : [],
                sourceNoteIds: Array.isArray(data.sourceNoteIds) ? (data.sourceNoteIds as string[]) : [],
                createdAt: toDate(data.createdAt),
              };
            })
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          setSavedExplanations(list);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'savedExplanations')
      )
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [uid, emailVerified]);

  const subjects = useMemo(() => Subject.groupNotesBySubject(notes), [notes]);

  const knowledgeGraph = useMemo(() => {
    if (!uid) return new KnowledgeGraph();
    return workspaceService.brainGraphService.computeGraph(uid, notes, graphNodes);
  }, [uid, notes, graphNodes]);

  const userAggregate = useMemo(() => {
    if (!profile) return null;
    return new User(profile, notes, quizAttempts, mindMaps);
  }, [profile, notes, quizAttempts, mindMaps]);

  return (
    <KnowledgeContext.Provider
      value={{
        userAggregate,
        notes,
        subjects,
        noteVersions,
        graphNodes,
        knowledgeGraph,
        mindMaps,
        quizAttempts,
        conversations,
        activities,
        revivedStates,
        savedExplanations,
        dataLoading,
        activePage,
        setActivePage,
        activeNoteId,
        setActiveNoteId,
        openNoteInEditor,
        explainPair,
        openExplainConnection,
        selectedConversationId,
        setSelectedConversationId,
        selectedMindMapId,
        setSelectedMindMapId,
        demoMode,
        setDemoMode,
        toasts,
        notify,
        dismissToast,
      }}
    >
      {children}
    </KnowledgeContext.Provider>
  );
};

export function useKnowledge(): KnowledgeContextValue {
  const ctx = useContext(KnowledgeContext);
  if (!ctx) throw new Error('useKnowledge must be used inside KnowledgeProvider');
  return ctx;
}
