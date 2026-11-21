import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Search,
  Save,
  Trash2,
  History,
  Bold,
  Italic,
  Heading2,
  List,
  Code,
  Eye,
  Edit3,
  Sparkles,
  RotateCcw,
  Loader2,
  X,
  ImagePlus,
  Lock,
  ZoomIn,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import {
  useSmartCapture,
  type SmartCaptureTransferPayload,
} from '../context/SmartCaptureContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { Note } from '../core/models/Note';
import type { NoteAttachment } from '../core/models/NoteAttachment';
import type { PreparedCaptureImage } from '../core/services/SmartNoteCaptureService';
import { ConfirmDialog } from '../components/ToastNotification';
import { SmartNoteCapturePanel } from '../components/SmartNoteCaptureModal';

export const NotesPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const {
    notes,
    subjects,
    noteVersions,
    graphNodes,
    activeNoteId,
    setActiveNoteId,
    setActivePage,
    notify,
  } = useKnowledge();

  const {
    panelOpen,
    openCapturePanel,
    pendingEditorTransfer,
    consumeEditorTransfer,
  } = useSmartCapture();

  const [searchQuery, setSearchQuery] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('All');
  const [sortBy, setSortBy] = useState<'updatedAt' | 'createdAt'>('updatedAt');

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('Computer Science');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  // Smart Note Capture (Image-to-Notes) editor attachment state
  const [stagedAttachments, setStagedAttachments] = useState<PreparedCaptureImage[]>([]);
  const [isSmartCaptureDraft, setIsSmartCaptureDraft] = useState(false);
  const [savedAttachments, setSavedAttachments] = useState<NoteAttachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [attachmentsRefreshTick, setAttachmentsRefreshTick] = useState(0);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name: string } | null>(null);
  const pendingTransferRef = useRef<SmartCaptureTransferPayload | null>(null);

  const selectedNote = useMemo(
    () => notes.find((n) => n.noteId === activeNoteId) ?? null,
    [notes, activeNoteId]
  );

  const existingSubjectNames = useMemo(() => subjects.map((s) => s.name), [subjects]);

  // Hydrate editor whenever the active note selection changes
  useEffect(() => {
    if (selectedNote) {
      setTitle(selectedNote.title);
      setSubject(selectedNote.subject);
      setTags(selectedNote.tags);
      setContent(selectedNote.content);
      setShowVersions(false);
      setStagedAttachments([]);
      setIsSmartCaptureDraft(false);
    } else if (pendingTransferRef.current) {
      const draft = pendingTransferRef.current;
      pendingTransferRef.current = null;
      setTitle(draft.title);
      setSubject(draft.subject);
      setTags(draft.tags);
      setContent(draft.content);
      setStagedAttachments(draft.attachments);
      setIsSmartCaptureDraft(true);
      setShowVersions(false);
      setPreviewMode(false);
    } else {
      setTitle('');
      setSubject(subjects[0]?.name || 'Computer Science');
      setTags([]);
      setContent('');
      setStagedAttachments([]);
      setIsSmartCaptureDraft(false);
      setShowVersions(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNote?.noteId]);

  // Load privately retained source images on demand for the currently opened note
  useEffect(() => {
    let cancelled = false;
    if (!firebaseUser || !selectedNote) {
      setSavedAttachments([]);
      setLoadingAttachments(false);
      return;
    }

    setLoadingAttachments(true);
    workspaceService.smartNoteCaptureService
      .listAttachmentsForNote(firebaseUser.uid, selectedNote.noteId)
      .then((list) => {
        if (!cancelled) {
          setSavedAttachments(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSavedAttachments([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingAttachments(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [firebaseUser, selectedNote?.noteId, attachmentsRefreshTick]);

  // Close image lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxImage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxImage]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return notes
      .filter((note) => {
        if (subjectFilter !== 'All' && note.subject !== subjectFilter) return false;
        if (!q) return true;
        return (
          note.title.toLowerCase().includes(q) ||
          note.subject.toLowerCase().includes(q) ||
          note.content.toLowerCase().includes(q) ||
          note.tags.some((t) => t.toLowerCase().includes(q))
        );
      })
      .sort((a, b) =>
        sortBy === 'updatedAt'
          ? b.updatedAt.getTime() - a.updatedAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime()
      );
  }, [notes, searchQuery, subjectFilter, sortBy]);

  const currentNoteVersions = useMemo(
    () => (selectedNote ? noteVersions.filter((v) => v.noteId === selectedNote.noteId) : []),
    [noteVersions, selectedNote]
  );

  // Instant inline Memory Revival suggestions while studying the opened note
  const relatedOlderNotes = useMemo(() => {
    if (!selectedNote) return [];
    return notes
      .filter((other) => other.noteId !== selectedNote.noteId)
      .map((other) => {
        const sem = Note.cosineSimilarity(selectedNote.embedding, other.embedding);
        const lex = selectedNote.computeLexicalSimilarity(other);
        const shared = selectedNote.getSharedTags(other);
        const score =
          (sem > 0 ? sem * 0.65 : lex * 0.7) +
          lex * 0.2 +
          Math.min(shared.length * 0.15, 0.3) +
          (selectedNote.subject === other.subject ? 0.12 : 0);
        return { other, score, shared };
      })
      .filter((r) => r.score >= 0.24)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [selectedNote, notes]);

  const handleAddTag = () => {
    const clean = tagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (clean.length === 0) return;
    setTags((prev) => Note.sanitizeTags([...prev, ...clean]));
    setTagInput('');
  };

  const insertFormatting = (prefix: string, suffix = '') => {
    setContent((prev) => `${prev}${prev.endsWith('\n') || prev === '' ? '' : '\n'}${prefix}${suffix}`);
  };

  const formatErrorMessage = (err: unknown, fallback: string): string => {
    if (!(err instanceof Error)) return fallback;
    try {
      const parsed = JSON.parse(err.message) as { error?: string; path?: string };
      if (parsed && typeof parsed.error === 'string') {
        return parsed.path ? `${parsed.error} (${parsed.path})` : parsed.error;
      }
    } catch {
      // Plain error message
    }
    return err.message || fallback;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) {
      notify('Please sign in before saving notes.', 'error');
      return;
    }
    if (!title.trim() || !content.trim() || !subject.trim()) {
      notify('Title, subject, and content are required.', 'error');
      return;
    }

    setSaving(true);
    try {
      const mergedTags = tagInput.trim()
        ? Note.sanitizeTags([...tags, ...tagInput.split(',').map((t) => t.trim())])
        : tags;
      setTags(mergedTags);
      setTagInput('');

      if (selectedNote) {
        const savedNote = await workspaceService.updateNote({
          userId: firebaseUser.uid,
          originalNote: selectedNote,
          title,
          content,
          subject,
          tags: mergedTags,
          allNotes: notes,
          existingGraphNodes: graphNodes,
          attachments: stagedAttachments,
        });
        setTitle(savedNote.title);
        setSubject(savedNote.subject);
        setTags(savedNote.tags);
        setContent(savedNote.content);
        setStagedAttachments([]);
        setIsSmartCaptureDraft(false);
        setAttachmentsRefreshTick((t) => t + 1);
        notify('Note updated, revision snapshot saved, and Brain Graph refreshed.', 'success');
      } else {
        const created = await workspaceService.createNote({
          userId: firebaseUser.uid,
          title,
          content,
          subject,
          tags: mergedTags,
          existingNotes: notes,
          existingGraphNodes: graphNodes,
          attachments: stagedAttachments,
          isSmartCapture: isSmartCaptureDraft,
        });
        setStagedAttachments([]);
        setIsSmartCaptureDraft(false);
        setActiveNoteId(created.noteId);
        setAttachmentsRefreshTick((t) => t + 1);
        notify('Note saved with semantic embedding and linked into Brain Graph.', 'success');
      }
    } catch (err) {
      notify(formatErrorMessage(err, 'Failed to save note.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTransferCaptureToEditor = (payload: SmartCaptureTransferPayload) => {
    if (payload.mode === 'append' && selectedNote) {
      setContent((prev) => (prev.trim() ? `${prev.trim()}\n\n${payload.content}` : payload.content));
      setTags((prev) => Note.sanitizeTags([...prev, ...payload.tags]));
      if (payload.attachments.length > 0) {
        setStagedAttachments((prev) => [...prev, ...payload.attachments].slice(0, 6));
      }
      setPreviewMode(false);
      notify('Appended extracted text to your current note. Click Save Changes to persist.', 'info');
      return;
    }

    if (selectedNote) {
      pendingTransferRef.current = payload;
      setActiveNoteId(null);
    } else {
      setTitle(payload.title);
      setSubject(payload.subject);
      setTags(payload.tags);
      setContent(payload.content);
      setStagedAttachments(payload.attachments);
      setIsSmartCaptureDraft(true);
      setPreviewMode(false);
    }
    notify('Extracted note loaded into editor. Review any edits and click Save Note.', 'info');
  };

  // Consume any transfer sent from SmartCaptureContext ("Open in Full Editor" / "Append to Current Note")
  useEffect(() => {
    if (!pendingEditorTransfer) return;
    const payload = consumeEditorTransfer();
    if (payload) {
      handleTransferCaptureToEditor(payload);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEditorTransfer]);

  const handleDeleteSavedAttachment = async (attachmentId: string) => {
    setDeletingAttachmentId(attachmentId);
    try {
      await workspaceService.smartNoteCaptureService.deleteAttachment(attachmentId);
      setSavedAttachments((prev) => prev.filter((a) => a.attachmentId !== attachmentId));
      notify('Removed retained source image.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to remove source image.', 'error');
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!firebaseUser || !selectedNote) return;
    setDeleting(true);
    try {
      await workspaceService.deleteNote({
        userId: firebaseUser.uid,
        note: selectedNote,
        allNotes: notes,
        existingGraphNodes: graphNodes,
      });
      setActiveNoteId(null);
      setConfirmDeleteOpen(false);
      notify('Note deleted and Brain Graph updated.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to delete note.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  if (panelOpen) {
    return (
      <SmartNoteCapturePanel
        existingSubjects={existingSubjectNames}
        hasActiveEditingNote={Boolean(selectedNote)}
        activeEditingNoteTitle={selectedNote?.title}
        onSavedDirect={(noteId) => {
          setActiveNoteId(noteId);
          setAttachmentsRefreshTick((t) => t + 1);
        }}
      />
    );
  }

  return (
    <div className="grid lg:grid-cols-12 gap-6 max-w-7xl mx-auto">
      {/* Left Pane: Notes List & Filters */}
      <div className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-4 h-fit lg:max-h-[calc(100vh-7.5rem)]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-slate-100 truncate">
            Knowledge Repository ({filteredNotes.length})
          </h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={openCapturePanel}
              title="Upload image or take photo to extract notes with AI"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/12 hover:bg-emerald-500/22 border border-emerald-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              Upload Image
            </button>
            <button
              type="button"
              onClick={() => setActiveNoteId(null)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter notes by keyword or tag..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <select
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              aria-label="Filter by subject"
              className="px-2.5 py-1.5 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-300 focus:border-indigo-500 focus:outline-none"
            >
              <option value="All">All Subjects</option>
              {subjects.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.noteCount})
                </option>
              ))}
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'updatedAt' | 'createdAt')}
              aria-label="Sort notes"
              className="px-2.5 py-1.5 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-300 focus:border-indigo-500 focus:outline-none"
            >
              <option value="updatedAt">Recently Modified</option>
              <option value="createdAt">Creation Date</option>
            </select>
          </div>
        </div>

        <div className="overflow-y-auto divide-y divide-slate-800/70 pr-1 max-h-[420px] lg:max-h-none">
          {filteredNotes.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-500">
              No notes match your current filter.
            </p>
          ) : (
            filteredNotes.map((note) => {
              const isSelected = note.noteId === activeNoteId;
              return (
                <button
                  key={note.noteId}
                  type="button"
                  onClick={() => setActiveNoteId(note.noteId)}
                  className={`w-full text-left py-3 px-2.5 transition-colors rounded-lg my-0.5 space-y-1 ${
                    isSelected
                      ? 'bg-indigo-600/18 text-slate-50'
                      : 'hover:bg-slate-800/40 text-slate-300'
                  }`}
                >
                  <p className="text-sm font-medium truncate">{note.title}</p>
                  <p className="text-xs text-slate-400 line-clamp-2">{note.getExcerpt(95)}</p>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="truncate">{note.subject}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums shrink-0">
                      {note.updatedAt.toLocaleDateString()}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right Pane: Note Editor & Revision History */}
      <div className="lg:col-span-8 space-y-6">
        <form
          onSubmit={handleSave}
          className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-5"
        >
          {/* Editor Header Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800/80">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-50">
                {selectedNote ? 'Edit Note' : 'Create New Note'}
              </h2>
              {selectedNote && (
                <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                  Created {selectedNote.createdAt.toLocaleString()} · Updated{' '}
                  {selectedNote.updatedAt.toLocaleString()}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={openCapturePanel}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/12 hover:bg-emerald-500/22 border border-emerald-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                Upload Image
              </button>

              {selectedNote && (
                <button
                  type="button"
                  onClick={() => setShowVersions((v) => !v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                    showVersions
                      ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                      : 'bg-[#0b1120] text-slate-300 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <History className="w-3.5 h-3.5" />
                  Revisions ({currentNoteVersions.length})
                </button>
              )}

              <button
                type="button"
                onClick={() => setPreviewMode((p) => !p)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-[#0b1120] border border-slate-800 hover:border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {previewMode ? <Edit3 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {previewMode ? 'Edit' : 'Preview'}
              </button>

              {selectedNote && (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )}

              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? 'Saving & Indexing...' : selectedNote ? 'Save Changes' : 'Save Note'}
              </button>
            </div>
          </div>

          {/* Title & Subject */}
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2 space-y-1.5">
              <label htmlFor="note-title" className="block text-xs font-medium text-slate-300">
                Note Title
              </label>
              <input
                id="note-title"
                type="text"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Python Functions and Modularity"
                className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="note-subject" className="block text-xs font-medium text-slate-300">
                Subject
              </label>
              <input
                id="note-subject"
                type="text"
                required
                maxLength={80}
                list="mindmesh-subjects"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Computer Science"
                className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
              />
              <datalist id="mindmesh-subjects">
                {subjects.map((s) => (
                  <option key={s.name} value={s.name} />
                ))}
                <option value="Computer Science" />
                <option value="Data Science" />
                <option value="Biology" />
                <option value="Physics" />
                <option value="Mathematics" />
              </datalist>
            </div>
          </div>

          {/* Tags Input */}
          <div className="space-y-2">
            <label htmlFor="note-tags" className="block text-xs font-medium text-slate-300">
              Concept Tags (press Enter or comma to add, up to 15)
            </label>
            <div className="flex gap-2">
              <input
                id="note-tags"
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder="python, functions, algorithms..."
                className="flex-1 px-3.5 py-2 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
              />
              <button
                type="button"
                onClick={handleAddTag}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Add Tag
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-indigo-300">
                {tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1">
                    <span>#{tag}</span>
                    <button
                      type="button"
                      onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                      className="text-slate-500 hover:text-rose-400"
                      aria-label={`Remove tag ${tag}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Formatting Toolbar & Content Area */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="note-content" className="text-xs font-medium text-slate-300">
                Note Content
              </label>
              {!previewMode && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => insertFormatting('## ', 'Heading')}
                    className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md"
                    title="Insert heading"
                  >
                    <Heading2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertFormatting('**', 'bold text**')}
                    className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md"
                    title="Insert bold"
                  >
                    <Bold className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertFormatting('_', 'italic text_')}
                    className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md"
                    title="Insert italic"
                  >
                    <Italic className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertFormatting('- ', 'Key takeaway')}
                    className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md"
                    title="Insert bullet list"
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => insertFormatting('```\n', '\n```')}
                    className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-md"
                    title="Insert code block"
                  >
                    <Code className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {previewMode ? (
              <div className="min-h-[280px] p-5 bg-[#0b1120] border border-slate-800 rounded-lg text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                {content || 'Nothing to preview yet.'}
              </div>
            ) : (
              <textarea
                id="note-content"
                required
                rows={12}
                maxLength={50000}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Write structured study notes, definitions, formulas, code snippets, or key takeaways..."
                className="w-full p-4 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500 leading-relaxed font-sans"
              />
            )}
          </div>

          {/* Staged Captured Images Pending Save */}
          {stagedAttachments.length > 0 && (
            <div className="p-4 rounded-xl bg-[#0b1120] border border-emerald-500/30 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-emerald-300">
                  <Lock className="w-3.5 h-3.5" />
                  <span>
                    {stagedAttachments.length} captured image{stagedAttachments.length > 1 ? 's' : ''} staged to save privately with this note
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setStagedAttachments([])}
                  className="text-xs text-slate-400 hover:text-rose-400"
                >
                  Remove all
                </button>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
                {stagedAttachments.map((img) => (
                  <div
                    key={img.id}
                    className="relative group rounded-lg overflow-hidden border border-slate-800 bg-slate-950 aspect-square"
                  >
                    <button
                      type="button"
                      onClick={() => setLightboxImage({ src: img.previewUrl, name: img.fileName })}
                      className="w-full h-full block"
                      title={`Preview ${img.fileName}`}
                    >
                      <img
                        src={img.previewUrl}
                        alt={img.fileName}
                        className="w-full h-full object-cover"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setStagedAttachments((prev) => prev.filter((item) => item.id !== img.id))
                      }
                      aria-label={`Remove staged image ${img.fileName}`}
                      className="absolute top-1 right-1 p-1 rounded bg-slate-950/85 text-slate-300 hover:text-rose-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </form>

        {/* Privately Retained Source Images for Opened Note */}
        {selectedNote && (loadingAttachments || savedAttachments.length > 0) && (
          <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-emerald-400" />
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Retained Source Images ({savedAttachments.length})
                </h3>
              </div>
              <span className="text-xs text-slate-500">
                Private to your account · Click any image to inspect
              </span>
            </div>

            {loadingAttachments ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                Loading private source images...
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {savedAttachments.map((att) => (
                  <div
                    key={att.attachmentId}
                    className="rounded-xl bg-[#0b1120] border border-slate-800 overflow-hidden flex flex-col"
                  >
                    <button
                      type="button"
                      onClick={() => setLightboxImage({ src: att.dataUrl, name: att.fileName })}
                      className="relative aspect-[4/3] bg-slate-950 overflow-hidden group"
                      title="Inspect original captured image"
                    >
                      <img
                        src={att.dataUrl}
                        alt={att.fileName}
                        className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                      />
                      <span className="absolute bottom-2 right-2 p-1.5 rounded-md bg-slate-950/80 text-slate-200 opacity-85 group-hover:opacity-100">
                        <ZoomIn className="w-3.5 h-3.5" />
                      </span>
                    </button>
                    <div className="p-2.5 flex items-center justify-between gap-2 border-t border-slate-800/80">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-slate-200 truncate">{att.fileName}</p>
                        <p className="text-[11px] font-mono tabular-nums text-slate-500">
                          {att.createdAt.toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={deletingAttachmentId === att.attachmentId}
                        onClick={() => void handleDeleteSavedAttachment(att.attachmentId)}
                        aria-label={`Delete retained image ${att.fileName}`}
                        className="p-1.5 text-slate-400 hover:text-rose-400 transition-colors disabled:opacity-40"
                      >
                        {deletingAttachmentId === att.attachmentId ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Revision Snapshots Panel */}
        {showVersions && selectedNote && (
          <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-slate-100">
                Revision Snapshots for "{selectedNote.title}"
              </h3>
              <span className="text-xs text-slate-500">
                Saved automatically before each edit
              </span>
            </div>

            {currentNoteVersions.length === 0 ? (
              <p className="text-xs text-slate-400">
                No previous revisions yet. Edit and save this note to create a revision snapshot.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {currentNoteVersions.map((ver) => (
                  <div key={ver.versionId} className="py-3.5 first:pt-0 last:pb-0 space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-slate-200">{ver.title}</p>
                        <p className="text-xs font-mono tabular-nums text-slate-500">
                          {ver.subject} · {ver.updatedAt.toLocaleString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTitle(ver.title);
                          setSubject(ver.subject);
                          setContent(ver.previousContent);
                          setShowVersions(false);
                          notify('Loaded previous revision into editor. Click Save Changes to restore.', 'info');
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Load Revision
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-3 whitespace-pre-wrap">
                      {ver.previousContent}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Contextual Revived Memories while studying an opened note */}
        {selectedNote && relatedOlderNotes.length > 0 && (
          <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400" />
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Revived Memories Related to This Note
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setActivePage('memory-revival')}
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
              >
                Open Memory Revival Engine
              </button>
            </div>
            <div className="grid sm:grid-cols-3 gap-4 pt-1">
              {relatedOlderNotes.map(({ other, score }) => (
                <button
                  key={other.noteId}
                  type="button"
                  onClick={() => setActiveNoteId(other.noteId)}
                  className="text-left p-3.5 rounded-lg bg-[#0b1120] border border-slate-800 hover:border-indigo-500/40 transition-colors space-y-1.5"
                >
                  <p className="text-xs font-medium text-slate-100 line-clamp-1">{other.title}</p>
                  <p className="text-[11px] text-slate-400 line-clamp-2">{other.getExcerpt(85)}</p>
                  <p className="text-[11px] font-mono tabular-nums text-indigo-400">
                    {other.subject} · {Math.round(score * 100)}% related
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-sm p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${lightboxImage.name}`}
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] bg-[#0f172a] border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-slate-800 bg-[#0b1120]">
              <span className="text-xs font-medium text-slate-200 truncate">
                {lightboxImage.name}
              </span>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                aria-label="Close image preview"
                className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-auto bg-slate-950 p-2">
              <img
                src={lightboxImage.src}
                alt={lightboxImage.name}
                className="max-h-[78vh] w-auto mx-auto object-contain"
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete this note?"
        description={`"${selectedNote?.title || ''}" and any privately retained source images will be permanently removed from Firestore and detached from your Brain Graph.`}
        confirmLabel="Delete Note"
        danger
        loading={deleting}
        onConfirm={() => void handleDeleteConfirmed()}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
};
