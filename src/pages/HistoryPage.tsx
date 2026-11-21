import React, { useMemo, useState } from 'react';
import { History, Trash2, ArrowRight, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import type { ActivityHistoryDTO, ActivityType } from '../core/models/User';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { ConfirmDialog } from '../components/ToastNotification';

const TYPE_LABELS: Record<ActivityType, string> = {
  note_created: 'Note Created',
  note_captured: 'Smart Note Capture',
  note_updated: 'Note Edited',
  note_deleted: 'Note Deleted',
  ai_chat: 'Study Assistant',
  quiz_completed: 'Adaptive Quiz',
  mindmap_created: 'Mind Map',
  memory_revived: 'Memory Revival',
  connection_explained: 'Connection Explained',
};

export const HistoryPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const {
    activities,
    notes,
    conversations,
    mindMaps,
    openNoteInEditor,
    setSelectedConversationId,
    setSelectedMindMapId,
    setActivePage,
    notify,
  } = useKnowledge();

  const [typeFilter, setTypeFilter] = useState<'all' | ActivityType>('all');
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const filtered = useMemo(
    () =>
      typeFilter === 'all'
        ? activities
        : activities.filter((a) => a.activityType === typeFilter),
    [activities, typeFilter]
  );

  const noteIdSet = useMemo(() => new Set(notes.map((n) => n.noteId)), [notes]);
  const convIdSet = useMemo(() => new Set(conversations.map((c) => c.conversationId)), [conversations]);
  const mapIdSet = useMemo(() => new Set(mindMaps.map((m) => m.mindMapId)), [mindMaps]);

  const handleOpenActivity = (act: ActivityHistoryDTO) => {
    switch (act.activityType) {
      case 'note_created':
      case 'note_captured':
      case 'note_updated':
      case 'memory_revived':
        if (act.entityId && noteIdSet.has(act.entityId)) {
          openNoteInEditor(act.entityId);
        } else {
          setActivePage('notes');
        }
        break;
      case 'ai_chat':
        if (act.entityId && convIdSet.has(act.entityId)) {
          setSelectedConversationId(act.entityId);
        }
        setActivePage('study-assistant');
        break;
      case 'mindmap_created':
        if (act.entityId && mapIdSet.has(act.entityId)) {
          setSelectedMindMapId(act.entityId);
        }
        setActivePage('mind-map');
        break;
      case 'quiz_completed':
        setActivePage('adaptive-quiz');
        break;
      case 'connection_explained':
        setActivePage('explain-connection');
        break;
      default:
        setActivePage('notes');
    }
  };

  const handleClearHistory = async () => {
    if (!firebaseUser) return;
    setClearing(true);
    try {
      const count = await workspaceService.clearActivityHistory(firebaseUser.uid);
      setConfirmClearOpen(false);
      notify(`Cleared ${count} activity record(s).`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to clear history.', 'error');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold text-slate-50">
            Learning Journey & Activity History
          </h2>
          <p className="text-xs text-slate-400">
            Chronological record of notes, study chats, quizzes, mind maps, memory revivals, and connection analyses preserved across sessions.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as 'all' | ActivityType)}
            aria-label="Filter activity history"
            className="px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All Activities ({activities.length})</option>
            {Object.entries(TYPE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>

          {activities.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear History
            </button>
          )}
        </div>
      </div>

      <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6">
        {filtered.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <History className="w-8 h-8 text-slate-600 mx-auto" />
            <p className="text-sm font-medium text-slate-300">No recorded activity yet</p>
            <p className="text-xs text-slate-500">
              Actions across all six modules appear here chronologically with direct links to resume.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {filtered.map((act) => (
              <div
                key={act.activityId}
                className="py-4 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-indigo-400">
                    <span className="font-medium">{TYPE_LABELS[act.activityType]}</span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-slate-500 inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {act.timestamp.toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-slate-100 truncate">{act.title}</p>
                  <p className="text-xs text-slate-400">{act.description}</p>
                </div>

                {act.activityType !== 'note_deleted' && (
                  <button
                    type="button"
                    onClick={() => handleOpenActivity(act)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-indigo-400 hover:text-indigo-300 whitespace-nowrap shrink-0 self-start sm:self-center"
                  >
                    Open
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear all learning history?"
        description="This permanently removes your chronological activity log entries from Firestore. Your notes, quizzes, and mind maps will remain untouched."
        confirmLabel="Clear History"
        danger
        loading={clearing}
        onConfirm={() => void handleClearHistory()}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  );
};
