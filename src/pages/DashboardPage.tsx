import React, { useMemo, useState } from 'react';
import {
  Network,
  MessageSquareText,
  GitBranch,
  GraduationCap,
  Sparkles,
  Link2,
  ArrowRight,
  BookOpen,
  Clock,
  Plus,
  Loader2,
  Layers,
  ImagePlus,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge, type AppPage } from '../context/KnowledgeContext';
import { useSmartCapture } from '../context/SmartCaptureContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { Note } from '../core/models/Note';

const STARTER_NOTES = [
  {
    title: 'Python Loops and Iteration',
    subject: 'Computer Science',
    tags: ['python', 'loops', 'iteration', 'control-flow'],
    content: `## Python Loops Overview

Loops allow programs to repeat a block of code multiple times without duplicating statements.

- **for loops** iterate over sequences such as lists, tuples, ranges, and dictionaries.
- **while loops** continue executing as long as a boolean condition evaluates to True.
- **List comprehensions** provide a concise syntax for building transformed lists in a single pass.
- **break** exits a loop early, while **continue** skips to the next iteration.

Loops are foundational for processing datasets, accumulating totals, and automating repetitive operations inside larger programs.`,
  },
  {
    title: 'Python Functions and Modularity',
    subject: 'Computer Science',
    tags: ['python', 'functions', 'modularity', 'parameters'],
    content: `## Python Functions

Functions encapsulate reusable logic into named blocks defined with the \`def\` keyword.

- **Parameters and Return Values**: Functions accept inputs and return computed outputs cleanly.
- **Scope**: Variables defined inside a function remain local, preventing unintended side effects.
- **Composition**: Complex workflows combine loops, conditional logic, and helper functions into clean pipelines.
- **Libraries**: Reusable Python functions are packaged into libraries such as NumPy, Pandas, and scikit-learn for scientific computing.`,
  },
  {
    title: 'Machine Learning Fundamentals',
    subject: 'Data Science',
    tags: ['python', 'machine-learning', 'algorithms', 'datasets'],
    content: `## Introduction to Machine Learning

Machine Learning enables systems to learn patterns from datasets rather than following hard-coded rules.

- **Supervised Learning**: Models train on labeled input-output pairs (regression and classification).
- **Unsupervised Learning**: Algorithms uncover hidden clusters or structure in unlabeled data.
- **Training Pipeline**: Load datasets, clean features, split train/test sets, fit a model, and evaluate accuracy.
- **Python Ecosystem**: Python functions and libraries (NumPy, Pandas, scikit-learn, PyTorch) dominate ML workflows because of clean abstractions and vectorized computation.`,
  },
  {
    title: 'Root Absorption and Xylem Transport in Plants',
    subject: 'Biology',
    tags: ['biology', 'botany', 'osmosis', 'xylem'],
    content: `## How Plants Take Up Water

Plants absorb water and dissolved minerals from soil primarily through microscopic **root hairs** located on the epidermis of roots.

- **Osmosis**: Water moves from soil (higher water potential) into root hair cells (lower water potential) across semi-permeable membranes.
- **Pathways**: Water travels across the root cortex via the apoplast (cell walls) and symplast (cytoplasm) routes before reaching the endodermis.
- **Xylem Vessels**: Once inside the xylem, transpiration pull and cohesion-tension draw water upward from roots to stems and leaves.`,
  },
  {
    title: 'Object-Oriented Programming Core Principles',
    subject: 'Computer Science',
    tags: ['oop', 'encapsulation', 'inheritance', 'polymorphism', 'abstraction'],
    content: `## The Four Pillars of OOP

Object-Oriented Programming structures software around domain objects that bundle state and behavior.

- **Encapsulation**: Protects internal object state using private fields and exposes controlled public methods.
- **Abstraction**: Hides implementation complexity behind interfaces and abstract base classes.
- **Inheritance**: Allows specialized subclasses to extend shared behavior from a parent superclass.
- **Polymorphism**: Enables interchangeable service implementations to respond differently to the same method signature.
- **Composition vs Aggregation**: Composition represents strong ownership (a Quiz owns its Questions), while Aggregation represents independent lifecycle management (a User manages Notes).`,
  },
];

const FEATURE_CARDS: Array<{
  id: AppPage;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    id: 'brain-graph',
    title: 'Brain Graph',
    description: 'Explore an interactive visual network of connected concepts.',
    icon: Network,
  },
  {
    id: 'study-assistant',
    title: 'AI Study Assistant',
    description: 'Ask questions grounded directly in your personal notes.',
    icon: MessageSquareText,
  },
  {
    id: 'mind-map',
    title: 'Mind Map Generator',
    description: 'Convert notes into editable hierarchical mind maps & PNGs.',
    icon: GitBranch,
  },
  {
    id: 'adaptive-quiz',
    title: 'Adaptive Quiz',
    description: 'Test mastery with difficulty that adapts to your scores.',
    icon: GraduationCap,
  },
  {
    id: 'memory-revival',
    title: 'Memory Revival',
    description: 'Resurface older related notes at the right moment.',
    icon: Sparkles,
  },
  {
    id: 'explain-connection',
    title: 'Explain My Connection',
    description: 'Understand how and why two Brain Graph nodes link.',
    icon: Link2,
  },
];

export const DashboardPage: React.FC = () => {
  const { firebaseUser, profile } = useAuth();
  const {
    notes,
    subjects,
    knowledgeGraph,
    quizAttempts,
    activities,
    revivedStates,
    graphNodes,
    dataLoading,
    setActivePage,
    openNoteInEditor,
    setActiveNoteId,
    notify,
  } = useKnowledge();
  const { openCapturePanel } = useSmartCapture();

  const [seeding, setSeeding] = useState(false);

  const avgQuizScore = useMemo(() => {
    if (quizAttempts.length === 0) return 0;
    const total = quizAttempts.reduce((acc, a) => acc + a.score, 0);
    return Math.round(total / quizAttempts.length);
  }, [quizAttempts]);

  const totalConnections = knowledgeGraph.getEdges().length;

  // Quick local revived memory suggestions based on most recently updated note
  const quickRevivals = useMemo(() => {
    if (notes.length < 2) return [];
    const current = notes[0];
    const dismissed = new Set(
      revivedStates
        .filter((s) => s.status === 'dismissed')
        .map((s) => `${s.sourceNoteId}::${s.revivedNoteId}`)
    );

    return notes
      .slice(1)
      .filter((other) => !dismissed.has(`${current.noteId}::${other.noteId}`))
      .map((other) => {
        const sem = Note.cosineSimilarity(current.embedding, other.embedding);
        const lex = current.computeLexicalSimilarity(other);
        const shared = current.getSharedTags(other);
        const score =
          (sem > 0 ? sem * 0.65 : lex * 0.7) +
          lex * 0.2 +
          Math.min(shared.length * 0.15, 0.3) +
          (current.subject === other.subject ? 0.12 : 0);
        return { other, score, shared };
      })
      .filter((item) => item.score >= 0.22)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [notes, revivedStates]);

  const handleSeedStarterNotes = async () => {
    if (!firebaseUser) return;
    setSeeding(true);
    try {
      let runningNotes = [...notes];
      for (const item of STARTER_NOTES) {
        const created = await workspaceService.createNote({
          userId: firebaseUser.uid,
          title: item.title,
          content: item.content,
          subject: item.subject,
          tags: item.tags,
          existingNotes: runningNotes,
          existingGraphNodes: graphNodes,
        });
        runningNotes = [created, ...runningNotes];
      }
      notify('Added 5 interconnected starter notes with semantic embeddings and Brain Graph links.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create starter notes.', 'error');
    } finally {
      setSeeding(false);
    }
  };

  const firstName = (profile?.name || firebaseUser?.displayName || 'Learner').split(' ')[0];

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Welcome Banner */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-slate-800/80">
        <div className="space-y-1.5">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-50">
            Welcome back, {firstName}
          </h2>
          <p className="text-sm text-slate-400">
            Your personal knowledge ecosystem — {notes.length} notes across {subjects.length} subject
            {subjects.length === 1 ? '' : 's'}.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {notes.length === 0 && !dataLoading && (
            <button
              type="button"
              disabled={seeding}
              onClick={() => void handleSeedStarterNotes()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {seeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
              {seeding ? 'Building Sample Graph...' : 'Load 5 Starter Notes'}
            </button>
          )}
          <button
            type="button"
            onClick={openCapturePanel}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-emerald-300 bg-emerald-500/12 hover:bg-emerald-500/22 border border-emerald-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <ImagePlus className="w-4 h-4" />
            Upload Image
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveNoteId(null);
              setActivePage('notes');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Create Note
          </button>
        </div>
      </section>

      {/* 4-Column Metric Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-2">
          <p className="text-xs font-medium text-slate-400">Total Notes Saved</p>
          <p className="font-mono text-3xl font-semibold text-slate-50 tabular-nums">
            {dataLoading ? '—' : notes.length}
          </p>
          <p className="text-xs text-slate-500">
            {subjects.length} active subject{subjects.length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-2">
          <p className="text-xs font-medium text-slate-400">Connected Concepts</p>
          <p className="font-mono text-3xl font-semibold text-indigo-300 tabular-nums">
            {dataLoading ? '—' : totalConnections}
          </p>
          <p className="text-xs text-slate-500">
            Semantic & tag graph links
          </p>
        </div>

        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-2">
          <p className="text-xs font-medium text-slate-400">Completed Quizzes</p>
          <p className="font-mono text-3xl font-semibold text-slate-50 tabular-nums">
            {dataLoading ? '—' : quizAttempts.length}
          </p>
          <p className="text-xs text-slate-500">
            Adaptive practice sessions
          </p>
        </div>

        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-2">
          <p className="text-xs font-medium text-slate-400">Average Quiz Score</p>
          <p className="font-mono text-3xl font-semibold text-violet-300 tabular-nums">
            {dataLoading ? '—' : quizAttempts.length > 0 ? `${avgQuizScore}%` : '—'}
          </p>
          <p className="text-xs text-slate-500">
            {quizAttempts.length > 0 ? 'Across all completed quizzes' : 'Take your first quiz'}
          </p>
        </div>
      </section>

      {/* Main Content Split: Recent Notes + Revived Memories / Topics */}
      <section className="grid lg:grid-cols-12 gap-6">
        {/* Recently Added & Modified Notes */}
        <div className="lg:col-span-7 bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-slate-100">
              Recently Updated Notes
            </h3>
            <button
              type="button"
              onClick={() => setActivePage('notes')}
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1"
            >
              View all
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {notes.length === 0 ? (
            <div className="py-10 text-center space-y-3 border-t border-slate-800/70">
              <BookOpen className="w-7 h-7 text-slate-600 mx-auto" />
              <p className="text-sm text-slate-400">
                Your knowledge repository is empty. Create your first note or load the 5 starter notes to experience all six AI modules immediately.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {notes.slice(0, 5).map((note) => (
                <button
                  key={note.noteId}
                  type="button"
                  onClick={() => openNoteInEditor(note.noteId)}
                  className="w-full text-left py-3.5 first:pt-1 last:pb-0 hover:bg-slate-800/30 -mx-2 px-2 rounded-lg transition-colors flex items-start justify-between gap-4"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-slate-100 truncate">{note.title}</p>
                    <p className="text-xs text-slate-400 line-clamp-1">{note.getExcerpt(110)}</p>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{note.subject}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {note.updatedAt.toLocaleDateString()}
                      </span>
                      {note.tags.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{note.tags.slice(0, 3).join(', ')}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-600 shrink-0 mt-1" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Revived Memories & Active Subjects */}
        <div className="lg:col-span-5 space-y-6">
          {/* Revived Memories Preview */}
          <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-100">
                Revived Memories
              </h3>
              <button
                type="button"
                onClick={() => setActivePage('memory-revival')}
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1"
              >
                Explore
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {quickRevivals.length === 0 ? (
              <p className="text-xs text-slate-400 leading-relaxed">
                Add at least two related notes to automatically resurface relevant prior knowledge when you study.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">
                  While studying <span className="text-slate-200 font-medium">{notes[0]?.title}</span>:
                </p>
                <div className="divide-y divide-slate-800/70">
                  {quickRevivals.map(({ other, score, shared }) => (
                    <button
                      key={other.noteId}
                      type="button"
                      onClick={() => openNoteInEditor(other.noteId)}
                      className="w-full text-left py-2.5 first:pt-0 last:pb-0 hover:text-indigo-300 transition-colors space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-200 truncate">
                          {other.title}
                        </span>
                        <span className="text-xs font-mono tabular-nums text-indigo-400 shrink-0">
                          {Math.round(score * 100)}% match
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 line-clamp-1">
                        {shared.length > 0
                          ? `Shared concepts: ${shared.join(', ')}`
                          : `Earlier note in ${other.subject}`}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Recently Accessed Topics */}
          <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-3">
            <h3 className="font-display text-base font-semibold text-slate-100">
              Your Study Subjects
            </h3>
            {subjects.length === 0 ? (
              <p className="text-xs text-slate-400">Subjects appear automatically as you organize notes.</p>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {subjects.slice(0, 5).map((subj) => (
                  <div key={subj.name} className="py-2 first:pt-0 last:pb-0 flex items-center justify-between text-sm">
                    <span className="text-slate-200 font-medium truncate">{subj.name}</span>
                    <span className="text-xs font-mono tabular-nums text-slate-400 shrink-0">
                      {subj.noteCount} note{subj.noteCount === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Quick Access to Core Modules */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-semibold text-slate-100">
            Six Intelligent Learning Modules
          </h3>
          <span className="text-xs text-slate-500">
            All powered by your central knowledge repository
          </span>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {FEATURE_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => setActivePage(card.id)}
                className="group text-left bg-[#0f172a] hover:bg-[#131d36] border border-slate-800/80 hover:border-indigo-500/40 rounded-xl p-5 transition-colors flex flex-col justify-between gap-4"
              >
                <div className="space-y-2.5">
                  <div className="w-9 h-9 rounded-lg bg-indigo-500/12 border border-indigo-500/25 flex items-center justify-center text-indigo-400">
                    <Icon className="w-4 h-4" />
                  </div>
                  <h4 className="font-display text-sm font-semibold text-slate-100 group-hover:text-indigo-300 transition-colors">
                    {card.title}
                  </h4>
                  <p className="text-xs text-slate-400 leading-relaxed">{card.description}</p>
                </div>
                <span className="text-xs font-medium text-indigo-400 inline-flex items-center gap-1">
                  Open module
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Recent Learning Activity */}
      <section className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-semibold text-slate-100">
            Recent Learning Activity
          </h3>
          <button
            type="button"
            onClick={() => setActivePage('history')}
            className="text-xs font-medium text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1"
          >
            Full history
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {activities.length === 0 ? (
          <p className="text-xs text-slate-400">
            Your activity timeline records notes created, quizzes, mind maps, and study chats automatically.
          </p>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {activities.slice(0, 6).map((act) => (
              <div key={act.activityId} className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm text-slate-200 font-medium truncate">{act.title}</p>
                  <p className="text-xs text-slate-400 truncate">{act.description}</p>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0 inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {act.timestamp.toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
