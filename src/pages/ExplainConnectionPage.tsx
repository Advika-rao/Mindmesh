import React, { useEffect, useMemo, useState } from 'react';
import {
  Link2,
  ArrowRight,
  Bookmark,
  Loader2,
  ExternalLink,
  Trash2,
  Network,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import type { ConnectionExplanationResult } from '../core/services/ConnectionExplanationService';

export const ExplainConnectionPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const {
    notes,
    knowledgeGraph,
    explainPair,
    savedExplanations,
    openNoteInEditor,
    setActivePage,
    notify,
  } = useKnowledge();

  const [sourceNoteId, setSourceNoteId] = useState('');
  const [targetNoteId, setTargetNoteId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ConnectionExplanationResult | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);

  const noteMap = useMemo(() => new Map(notes.map((n) => [n.noteId, n])), [notes]);

  // Pre-fill when navigated directly from Brain Graph
  useEffect(() => {
    if (explainPair) {
      setSourceNoteId(explainPair.sourceNoteId);
      setTargetNoteId(explainPair.targetNoteId);
    } else if (notes.length >= 2 && !sourceNoteId && !targetNoteId) {
      setSourceNoteId(notes[0].noteId);
      setTargetNoteId(notes[1].noteId);
    }
  }, [explainPair, notes]);

  const handleExplain = async (src = sourceNoteId, tgt = targetNoteId) => {
    if (!firebaseUser || !src || !tgt) return;
    if (src === tgt) {
      notify('Choose two different notes to explore their connection.', 'error');
      return;
    }

    setLoading(true);
    setExplainError(null);
    try {
      const explained = await workspaceService.connectionExplanationService.execute(
        { userId: firebaseUser.uid },
        {
          sourceNoteId: src,
          targetNoteId: tgt,
          allNotes: notes,
          graph: knowledgeGraph,
        }
      );
      setResult(explained);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Unable to explain this connection right now. Please try again.';
      setExplainError(message);
      notify(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Auto-run when jumping from Brain Graph with a chosen pair
  useEffect(() => {
    if (explainPair && firebaseUser && notes.length >= 2) {
      void handleExplain(explainPair.sourceNoteId, explainPair.targetNoteId);
    }
  }, [explainPair]);

  const handleSaveExplanation = async () => {
    if (!firebaseUser || !result) return;
    setSaving(true);
    try {
      await workspaceService.connectionExplanationService.saveExplanation(firebaseUser.uid, result);
      notify('Connection explanation saved to Firestore.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save explanation.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Node Pair Selector */}
      <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-slate-50">
              Explain My Connection
            </h2>
            <p className="text-xs text-slate-400">
              Select two concepts from your Brain Graph to trace intermediate path nodes, understand why they relate, and review practical real-world examples grounded in your notes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActivePage('brain-graph')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Network className="w-3.5 h-3.5" />
            Pick in Brain Graph
          </button>
        </div>

        <div className="grid md:grid-cols-11 gap-3 items-end">
          <div className="md:col-span-4 space-y-1.5">
            <label htmlFor="conn-source" className="block text-xs font-medium text-slate-300">
              Concept A (Source Node)
            </label>
            <select
              id="conn-source"
              value={sourceNoteId}
              onChange={(e) => setSourceNoteId(e.target.value)}
              className="w-full px-3.5 py-2.5 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              {notes.length === 0 && <option value="">No notes available</option>}
              {notes.map((n) => (
                <option key={n.noteId} value={n.noteId}>
                  {n.title} ({n.subject})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-1 flex items-center justify-center pb-2.5 text-indigo-400">
            <ArrowRight className="w-4 h-4" />
          </div>

          <div className="md:col-span-4 space-y-1.5">
            <label htmlFor="conn-target" className="block text-xs font-medium text-slate-300">
              Concept B (Target Node)
            </label>
            <select
              id="conn-target"
              value={targetNoteId}
              onChange={(e) => setTargetNoteId(e.target.value)}
              className="w-full px-3.5 py-2.5 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              {notes.length === 0 && <option value="">No notes available</option>}
              {notes.map((n) => (
                <option key={n.noteId} value={n.noteId}>
                  {n.title} ({n.subject})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <button
              type="button"
              disabled={loading || notes.length < 2 || !sourceNoteId || !targetNoteId}
              onClick={() => void handleExplain()}
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
              {loading ? 'Analyzing...' : 'Explain'}
            </button>
          </div>
        </div>
      </div>

      {/* Main Split: Active Explanation + Saved Explanations */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-4">
          {loading ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-12 text-center space-y-3">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400 mx-auto" />
              <p className="text-xs text-slate-400">
                Tracing shortest Brain Graph path and analyzing supporting notes...
              </p>
            </div>
          ) : explainError ? (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-6 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-rose-100">
                    Unable to explain this connection
                  </h3>
                  <p className="text-xs text-rose-200/85 leading-relaxed">{explainError}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleExplain()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry
              </button>
            </div>
          ) : result ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-800/80">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-violet-400">
                    Knowledge Path Analysis · {Math.round(result.similarityScore * 100)}% similarity
                  </p>
                  <h3 className="font-display text-lg font-bold text-slate-50">
                    {result.sourceNote.title} → {result.targetNote.title}
                  </h3>
                  <p className="text-sm text-indigo-200">{result.summary}</p>
                </div>

                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveExplanation()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <Bookmark className="w-3.5 h-3.5" />
                  {saving ? 'Saving...' : 'Save Explanation'}
                </button>
              </div>

              {/* Graph Path Chain */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-300">
                  Brain Graph Path ({result.intermediateNotes.length > 0 ? 'Multi-Hop Connection' : 'Direct Concept Pair'})
                </h4>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {result.pathNoteIds.map((nid, idx) => {
                    const nodeNote = noteMap.get(nid);
                    return (
                      <React.Fragment key={nid}>
                        <button
                          type="button"
                          onClick={() => openNoteInEditor(nid)}
                          className="px-3 py-1.5 rounded-lg bg-[#0b1120] border border-slate-800 hover:border-indigo-500/40 text-slate-200 font-medium"
                        >
                          {nodeNote?.title || nid}
                        </button>
                        {idx < result.pathNoteIds.length - 1 && (
                          <ArrowRight className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Bridging Intermediate Concepts */}
              {result.intermediateConcepts.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-300">Bridging Concepts</h4>
                  <p className="text-sm text-indigo-300">
                    {result.intermediateConcepts.join(' · ')}
                  </p>
                </div>
              )}

              {/* Simple Explanation */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-300">Why These Concepts Connect</h4>
                <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {result.explanation}
                </p>
                {result.connectionStrengthNote && (
                  <p className="text-xs text-slate-400 pt-1">{result.connectionStrengthNote}</p>
                )}
              </div>

              {/* Practical Real-World Examples */}
              {result.examples.length > 0 && (
                <div className="space-y-2.5 pt-4 border-t border-slate-800/80">
                  <h4 className="text-xs font-semibold text-slate-300">
                    Practical Real-World Examples
                  </h4>
                  <ul className="space-y-2 text-sm text-slate-300 list-disc pl-5">
                    {result.examples.map((ex, i) => (
                      <li key={i} className="leading-relaxed">
                        {ex}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Supporting Source Notes */}
              <div className="space-y-2 pt-4 border-t border-slate-800/80">
                <h4 className="text-xs font-semibold text-slate-300">Supporting Source Notes</h4>
                <div className="flex flex-wrap gap-3">
                  {[result.sourceNote, ...result.intermediateNotes, result.targetNote].map((n) => (
                    <button
                      key={n.noteId}
                      type="button"
                      onClick={() => openNoteInEditor(n.noteId)}
                      className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                    >
                      <ExternalLink className="w-3 h-3" />
                      {n.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-12 text-center space-y-2">
              <Link2 className="w-8 h-8 text-slate-600 mx-auto" />
              <p className="text-sm font-medium text-slate-200">
                Choose two concepts above and click Explain
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                MindMesh finds the shortest graph bridge between your notes and explains how they connect using your own stored knowledge.
              </p>
            </div>
          )}
        </div>

        {/* Saved Explanations */}
        <aside className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 h-fit space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Saved Explanations ({savedExplanations.length})
          </h3>
          {savedExplanations.length === 0 ? (
            <p className="text-xs text-slate-400">
              Save insightful connection breakdowns here to revisit them before exams.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {savedExplanations.map((exp) => (
                <div key={exp.explanationId} className="py-3.5 first:pt-0 last:pb-0 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-100 leading-snug">
                      {exp.sourceTitle} → {exp.targetTitle}
                    </p>
                    <button
                      type="button"
                      onClick={async () => {
                        await workspaceService.connectionExplanationService.deleteSavedExplanation(
                          exp.explanationId
                        );
                        notify('Saved explanation deleted.', 'info');
                      }}
                      className="text-slate-500 hover:text-rose-400 p-0.5 shrink-0"
                      aria-label="Delete saved explanation"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-xs text-slate-400 line-clamp-3 whitespace-pre-wrap">
                    {exp.explanation}
                  </p>
                  <p className="text-[11px] font-mono tabular-nums text-slate-500">
                    {exp.createdAt.toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
