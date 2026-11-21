import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Bookmark,
  BookmarkCheck,
  X,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import type { RevivedMemoryItem } from '../core/services/MemoryRevivalService';

export const MemoryRevivalPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const {
    notes,
    activeNoteId,
    revivedStates,
    openNoteInEditor,
    notify,
  } = useKnowledge();

  const [selectedStudyNoteId, setSelectedStudyNoteId] = useState<string>('');
  const [revivals, setRevivals] = useState<RevivedMemoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Default to currently opened note or most recent note
  useEffect(() => {
    if (notes.length === 0) {
      setSelectedStudyNoteId('');
      setRevivals([]);
      return;
    }
    if (activeNoteId && notes.some((n) => n.noteId === activeNoteId)) {
      setSelectedStudyNoteId(activeNoteId);
    } else if (!selectedStudyNoteId || !notes.some((n) => n.noteId === selectedStudyNoteId)) {
      setSelectedStudyNoteId(notes[0].noteId);
    }
  }, [notes, activeNoteId]);

  const runRevival = async (noteId: string) => {
    if (!firebaseUser || !noteId) return;
    setLoading(true);
    try {
      const found = await workspaceService.memoryRevivalService.execute(
        { userId: firebaseUser.uid },
        {
          activeNoteId: noteId,
          allNotes: notes,
          revivedStates,
          useAIReasons: true,
        }
      );
      setRevivals(found);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Memory Revival scan failed.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedStudyNoteId && notes.length >= 2) {
      void runRevival(selectedStudyNoteId);
    } else {
      setRevivals([]);
    }
  }, [selectedStudyNoteId]);

  const noteMap = useMemo(() => new Map(notes.map((n) => [n.noteId, n])), [notes]);
  const bookmarkedStates = useMemo(
    () => revivedStates.filter((s) => s.status === 'bookmarked' && noteMap.has(s.revivedNoteId)),
    [revivedStates, noteMap]
  );
  const dismissedCount = useMemo(
    () => revivedStates.filter((s) => s.status === 'dismissed').length,
    [revivedStates]
  );

  const handleSetStatus = async (item: RevivedMemoryItem, status: 'dismissed' | 'bookmarked') => {
    if (!firebaseUser) return;
    try {
      await workspaceService.memoryRevivalService.setMemoryStatus({
        userId: firebaseUser.uid,
        sourceNoteId: item.sourceNoteId,
        revivedNoteId: item.revivedNote.noteId,
        revivedNoteTitle: item.revivedNote.title,
        status,
        reason: item.reason,
      });
      if (status === 'dismissed') {
        setRevivals((prev) => prev.filter((r) => r.revivedNote.noteId !== item.revivedNote.noteId));
        notify('Suggestion dismissed so it will not repeat for this note.', 'info');
      } else {
        setRevivals((prev) =>
          prev.map((r) =>
            r.revivedNote.noteId === item.revivedNote.noteId ? { ...r, isBookmarked: true } : r
          )
        );
        notify('Revived memory bookmarked.', 'success');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update suggestion.', 'error');
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Study Session Selector */}
      <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-slate-50">
              Memory Revival Engine
            </h2>
            <p className="text-xs text-slate-400">
              Select the note you are currently studying. MindMesh scans your older saved notes, identifies semantically related concepts, and explains why recalling them helps right now.
            </p>
          </div>
          <button
            type="button"
            disabled={loading || !selectedStudyNoteId}
            onClick={() => void runRevival(selectedStudyNoteId)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0b1120] hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh Revivals
          </button>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label htmlFor="study-note-select" className="text-xs font-medium text-slate-300 shrink-0">
            Currently Studying:
          </label>
          <select
            id="study-note-select"
            value={selectedStudyNoteId}
            onChange={(e) => setSelectedStudyNoteId(e.target.value)}
            className="flex-1 px-3.5 py-2 text-sm bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            {notes.length === 0 && <option value="">No saved notes yet</option>}
            {notes.map((n) => (
              <option key={n.noteId} value={n.noteId}>
                {n.title} ({n.subject})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Split: Active Revived Memories + Bookmarked Memories */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-200">
            Revived Memories
          </h3>

          {notes.length < 2 ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-10 text-center space-y-2">
              <Sparkles className="w-8 h-8 text-slate-600 mx-auto" />
              <p className="text-sm text-slate-300 font-medium">
                Add at least two notes to activate Memory Revival
              </p>
              <p className="text-xs text-slate-500">
                MindMesh compares your active study topic against your older notes to surface timely reminders.
              </p>
            </div>
          ) : loading ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-10 text-center space-y-3">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400 mx-auto" />
              <p className="text-xs text-slate-400">
                Scanning older notes and generating relevance explanations...
              </p>
            </div>
          ) : revivals.length === 0 ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-10 text-center space-y-2">
              <p className="text-sm text-slate-300 font-medium">
                No new related older memories for this note
              </p>
              <p className="text-xs text-slate-500">
                Try choosing another study note or adding more notes on related subjects.
                {dismissedCount > 0 && ` (${dismissedCount} previously dismissed suggestion(s) hidden.)`}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {revivals.map((item) => (
                <div
                  key={item.revivedNote.noteId}
                  className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-3.5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-xs font-medium text-violet-400">
                        Remember this? · {item.relevanceScore}% relevance
                      </p>
                      <h4 className="font-display text-base font-semibold text-slate-50">
                        {item.revivedNote.title}
                      </h4>
                      <p className="text-xs text-slate-500">
                        {item.revivedNote.subject} · Saved {item.revivedNote.createdAt.toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSetStatus(item, 'dismissed')}
                      className="p-1.5 text-slate-500 hover:text-rose-300 hover:bg-slate-800/60 rounded-lg transition-colors"
                      title="Dismiss suggestion"
                      aria-label="Dismiss suggestion"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <p className="text-sm text-indigo-100 bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-3.5 leading-relaxed">
                    {item.reason}
                  </p>

                  <p className="text-xs text-slate-400 leading-relaxed">
                    {item.revivedNote.getExcerpt(190)}
                  </p>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/70">
                    <button
                      type="button"
                      onClick={() => openNoteInEditor(item.revivedNote.noteId)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open Original Note
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleSetStatus(item, 'bookmarked')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                        item.isBookmarked
                          ? 'bg-violet-500/20 text-violet-300 border border-violet-500/35'
                          : 'bg-[#0b1120] text-slate-300 hover:text-white border border-slate-800'
                      }`}
                    >
                      {item.isBookmarked ? (
                        <>
                          <BookmarkCheck className="w-3.5 h-3.5" />
                          Bookmarked
                        </>
                      ) : (
                        <>
                          <Bookmark className="w-3.5 h-3.5" />
                          Bookmark Memory
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bookmarked Memories Sidebar */}
        <aside className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 h-fit space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Bookmarked Revivals ({bookmarkedStates.length})
          </h3>
          {bookmarkedStates.length === 0 ? (
            <p className="text-xs text-slate-400">
              Bookmark helpful revived memories to keep key prerequisite notes close at hand.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {bookmarkedStates.map((st) => {
                const target = noteMap.get(st.revivedNoteId);
                if (!target) return null;
                return (
                  <div key={st.stateId} className="py-3 first:pt-0 last:pb-0 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => openNoteInEditor(target.noteId)}
                        className="text-xs font-medium text-slate-100 hover:text-indigo-300 text-left"
                      >
                        {target.title}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await workspaceService.memoryRevivalService.removeStatus(st.stateId);
                          notify('Bookmark removed.', 'info');
                        }}
                        className="text-slate-500 hover:text-rose-400 p-0.5"
                        aria-label="Remove bookmark"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-400 line-clamp-2">{st.reason}</p>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
