import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Plus,
  Bookmark,
  Trash2,
  FileText,
  Loader2,
  MessageSquareText,
  AlertTriangle,
  Sparkles,
  X,
  RotateCcw,
  Clock,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { AIServiceException } from '../core/exceptions/MindMeshExceptions';
import type { ChatMessageDTO } from '../core/models/User';
import type { StudyAssistantRetryNotice } from '../core/interfaces/CoreInterfaces';
import { StudyMarkdown } from '../components/StudyMarkdown';
import { AIStatusBadge } from '../components/AIStatusBadge';
import type { StudyResponseSource } from '../core/services/StudyAssistantService';
import { deduplicateSourceNotes, resolveNoteDisplayTitle } from '../core/utils/sourceNotes';

type AssistantMode = 'ask' | 'simplify' | 'summarize' | 'examples';

interface AssistantErrorState {
  message: string;
  lastQuestion: string;
  isRateLimit: boolean;
  isQuotaExhausted: boolean;
  canRetry: boolean;
}

export const StudyAssistantPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const {
    notes,
    conversations,
    selectedConversationId,
    setSelectedConversationId,
    openNoteInEditor,
    notify,
    demoMode,
  } = useKnowledge();

  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<AssistantMode>('ask');
  const [focusedNoteId, setFocusedNoteId] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'chat' | 'saved'>('chat');
  const [loading, setLoading] = useState(false);
  const [retryNotice, setRetryNotice] = useState<StudyAssistantRetryNotice | null>(null);
  const [errorState, setErrorState] = useState<AssistantErrorState | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [lastStatus, setLastStatus] = useState<{
    source: StudyResponseSource;
    label: string;
    isQuotaOrRateLimited?: boolean;
  } | null>(null);
  const [messageMeta, setMessageMeta] = useState<
    Record<string, { source: StudyResponseSource; label: string; isQuotaOrRateLimited?: boolean }>
  >({});

  // Synchronous guards prevent duplicate concurrent requests on rapid double-clicks
  const inFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.conversationId === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );

  const noteMap = useMemo(() => new Map(notes.map((n) => [n.noteId, n])), [notes]);

  const allSavedSnippets = useMemo(
    () =>
      conversations.flatMap((conv) =>
        conv.savedSnippets.map((s) => ({ ...s, conversationTitle: conv.title }))
      ),
    [conversations]
  );

  // Abort any active AI request cleanly when navigating away
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      inFlightRef.current = false;
    };
  }, []);

  // Countdown timer for HTTP 429 rate-limit cooldown
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  // Keep the latest message visible when new messages arrive while keeping panel freely scrollable
  const messageCount = activeConversation?.messages.length ?? 0;
  useEffect(() => {
    if (activeTab === 'chat' && messageCount > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeTab, messageCount, loading]);

  const handleCancelRequest = useCallback(() => {
    if (!abortControllerRef.current) return;
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    inFlightRef.current = false;
    setLoading(false);
    setRetryNotice(null);
    notify('Study Assistant request cancelled.', 'info');
  }, [notify]);

  const handleAsk = useCallback(
    async (promptOverride?: string) => {
      if (!firebaseUser) return;
      // Synchronous lock blocks duplicate calls from rapid double-clicks or Enter spam
      if (inFlightRef.current || cooldownSeconds > 0) return;

      const text = (promptOverride ?? question).trim();
      if (!text) return;

      inFlightRef.current = true;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setRetryNotice(null);
      setErrorState(null);

      try {
        const result = await workspaceService.studyAssistantService.execute(
          { userId: firebaseUser.uid },
          {
            question: text,
            allNotes: notes,
            conversation: activeConversation,
            mode,
            focusedNoteIds: focusedNoteId === 'all' ? undefined : [focusedNoteId],
            demoMode,
            signal: controller.signal,
            onRetry: (notice) => {
              if (!controller.signal.aborted) {
                setRetryNotice(notice);
              }
            },
          }
        );

        if (controller.signal.aborted) return;

        setSelectedConversationId(result.conversation.conversationId);
        setFollowUps(result.suggestedFollowUps);
        setQuestion('');
        setActiveTab('chat');
        setErrorState(null);
        setRetryNotice(null);

        const nextMeta = {
          source: result.responseSource,
          label: result.statusLabel,
          isQuotaOrRateLimited: result.isQuotaOrRateLimited,
        };
        setLastStatus(nextMeta);
        setMessageMeta((prev) => ({
          ...prev,
          [result.assistantMessage.id]: nextMeta,
        }));

        // Apply short throttling cooldown after live AI calls to protect free-tier RPM
        if (result.responseSource === 'ai') {
          setCooldownSeconds(2);
        } else if (result.responseSource === 'local_fallback' && result.isQuotaOrRateLimited) {
          setCooldownSeconds(Math.min(12, Math.max(4, result.retryAfterSeconds ?? 5)));
        }
      } catch (err) {
        if (controller.signal.aborted) return;

        const isAiErr = err instanceof AIServiceException;
        if (isAiErr && (err.statusCode === 499 || err.serverCode === 'CANCELLED')) {
          return;
        }

        const isQuotaExhausted = Boolean(isAiErr && err.isQuotaExhausted);
        const isRateLimit = Boolean(
          isAiErr && !isQuotaExhausted && (err.statusCode === 429 || err.serverCode === 'RATE_LIMITED')
        );

        const friendlyMessage = isQuotaExhausted
          ? 'API quota temporarily exceeded — try again later.'
          : isRateLimit
            ? 'AI is temporarily busy. Please wait a moment and try again.'
            : isAiErr && err.message
              ? err.message
              : 'The AI service could not complete your request right now. Please try again.';

        if (isRateLimit) {
          const waitSec = isAiErr && err.retryAfterSeconds ? Math.min(20, Math.max(4, err.retryAfterSeconds)) : 6;
          setCooldownSeconds(waitSec);
        }

        setErrorState({
          message: friendlyMessage,
          lastQuestion: text,
          isRateLimit,
          isQuotaExhausted,
          canRetry: !isQuotaExhausted,
        });
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        inFlightRef.current = false;
        setLoading(false);
        setRetryNotice(null);
      }
    },
    [
      firebaseUser,
      cooldownSeconds,
      question,
      notes,
      activeConversation,
      mode,
      focusedNoteId,
      demoMode,
      setSelectedConversationId,
    ]
  );

  const handleSaveSnippet = async (msg: ChatMessageDTO, msgIndex: number) => {
    if (!activeConversation) return;
    const prevUserMsg = activeConversation.messages
      .slice(0, msgIndex)
      .reverse()
      .find((m) => m.role === 'user');
    try {
      await workspaceService.studyAssistantService.saveSnippet(
        activeConversation,
        prevUserMsg?.content || activeConversation.title,
        msg
      );
      notify('Response saved to your Study Snippets.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save response.', 'error');
    }
  };

  const handleDeleteConversation = async (convId: string) => {
    try {
      await workspaceService.studyAssistantService.deleteConversation(convId);
      if (selectedConversationId === convId) setSelectedConversationId(null);
      notify('Conversation removed.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to delete conversation.', 'error');
    }
  };

  const submitBlocked = loading || cooldownSeconds > 0 || !question.trim();

  return (
    <div className="grid lg:grid-cols-12 gap-6 max-w-7xl mx-auto">
      {/* Left Sidebar: Chat History & Saved Snippets Switcher */}
      <aside className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-4 h-fit lg:h-[calc(100vh-7.5rem)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 p-1 bg-[#0b1120] rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'chat' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Chats ({conversations.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('saved')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'saved' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Saved ({allSavedSnippets.length})
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setSelectedConversationId(null);
              setFollowUps([]);
              setErrorState(null);
              setActiveTab('chat');
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            New Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
          {conversations.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-500">
              No previous conversations yet. Ask a question about your notes to begin.
            </p>
          ) : (
            conversations.map((conv) => {
              const isSelected = conv.conversationId === selectedConversationId && activeTab === 'chat';
              return (
                <div
                  key={conv.conversationId}
                  className={`py-2.5 px-2.5 rounded-lg my-0.5 flex items-start justify-between gap-2 transition-colors ${
                    isSelected ? 'bg-indigo-600/18' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedConversationId(conv.conversationId);
                      setErrorState(null);
                      setActiveTab('chat');
                    }}
                    className="min-w-0 flex-1 text-left space-y-0.5"
                  >
                    <p className="text-xs font-medium text-slate-100 truncate">{conv.title}</p>
                    <p className="text-[11px] font-mono tabular-nums text-slate-500">
                      {conv.messages.length} msgs · {conv.updatedAt.toLocaleDateString()}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteConversation(conv.conversationId)}
                    className="p-1 text-slate-500 hover:text-rose-400 shrink-0"
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Conversation or Saved Snippets Pane */}
      <div className="lg:col-span-8 min-w-0 bg-[#0f172a] border border-slate-800/80 rounded-xl flex flex-col h-[calc(100vh-7.5rem)] min-h-[560px]">
        {activeTab === 'saved' ? (
          <div className="p-6 min-h-0 overflow-y-auto space-y-4 flex-1">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Saved Study Responses
            </h2>
            {allSavedSnippets.length === 0 ? (
              <p className="text-sm text-slate-400">
                Click "Save Response" on any helpful assistant answer to pin it here for quick revision.
              </p>
            ) : (
              <div className="space-y-4">
                {allSavedSnippets.map((snip) => {
                  const uniqueSnippetSources = deduplicateSourceNotes(snip.citedNoteIds, noteMap);
                  return (
                    <div
                      key={snip.id}
                      className="p-4 sm:p-5 rounded-xl bg-[#0b1120] border border-slate-800 space-y-3 min-w-0"
                    >
                      <p className="text-xs font-semibold text-indigo-300">Q: {snip.question}</p>
                      <StudyMarkdown content={snip.answer} compact />
                      {uniqueSnippetSources.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 pt-2.5 border-t border-slate-800/70 text-xs">
                          <span className="text-slate-500 font-medium">Sources:</span>
                          {uniqueSnippetSources.map((src) => (
                            <button
                              key={src.noteId}
                              type="button"
                              onClick={() => openNoteInEditor(src.noteId)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/25 text-indigo-300 hover:text-indigo-200 transition-colors"
                            >
                              <FileText className="w-3 h-3 shrink-0" />
                              <span className="truncate max-w-[240px]">{src.displayTitle}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Top Mode & Note Focus Controls */}
            <div className="p-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-[#0b1120] rounded-lg border border-slate-800">
                {(
                  [
                    { id: 'ask', label: 'Ask' },
                    { id: 'simplify', label: 'Simplify' },
                    { id: 'summarize', label: 'Summarize' },
                    { id: 'examples', label: 'Examples' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMode(item.id)}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      mode === item.id
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <select
                value={focusedNoteId}
                onChange={(e) => setFocusedNoteId(e.target.value)}
                aria-label="Focus assistant on a specific note"
                className="px-3 py-1.5 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-300 focus:border-indigo-500 focus:outline-none max-w-[240px]"
              >
                <option value="all">Search All Notes ({notes.length})</option>
                {notes.map((n) => (
                  <option key={n.noteId} value={n.noteId}>
                    Focus: {resolveNoteDisplayTitle(n)}
                  </option>
                ))}
              </select>
            </div>

            {(demoMode || lastStatus) && (
              <div className="px-4 py-2 border-b border-slate-800/70 bg-[#0b1120]/60 flex flex-wrap items-center justify-between gap-2">
                {lastStatus ? (
                  <AIStatusBadge
                    source={lastStatus.source}
                    label={lastStatus.label}
                    isQuotaOrRateLimited={lastStatus.isQuotaOrRateLimited}
                    compact
                  />
                ) : (
                  <AIStatusBadge
                    source="demo"
                    label="Demo Mode active — answers synthesized locally from your saved notes"
                    compact
                  />
                )}
                {lastStatus?.source === 'local_fallback' && (
                  <span className="text-[11px] text-amber-200/80">
                    Local fallback mode active — extracted directly from your saved notes
                  </span>
                )}
              </div>
            )}

            {/* Messages Area */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
              {!activeConversation || activeConversation.messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-4">
                  <div className="w-11 h-11 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                    <MessageSquareText className="w-5 h-5" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-display text-base font-semibold text-slate-100">
                      AI Study Assistant
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Ask questions about your saved notes, request simplified explanations, summarize long notes, or explore examples. Answers cite your actual notes and transparently tell you if your repository lacks coverage.
                    </p>
                  </div>
                  {notes.length > 0 && (
                    <div className="flex flex-wrap justify-center gap-2 pt-2">
                      {[
                        `Summarize my note on ${resolveNoteDisplayTitle(notes[0])}`,
                        `Explain ${resolveNoteDisplayTitle(notes[0])} simply with an example`,
                        'What key themes connect my saved notes?',
                      ].map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          disabled={loading || cooldownSeconds > 0}
                          onClick={() => void handleAsk(suggestion)}
                          className="px-3 py-1.5 text-xs text-slate-300 bg-[#0b1120] hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                activeConversation.messages.map((msg, idx) => {
                  const uniqueSources =
                    msg.role === 'assistant'
                      ? deduplicateSourceNotes(msg.citedNoteIds, noteMap)
                      : [];

                  return (
                    <div
                      key={msg.id}
                      className={`flex min-w-0 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`min-w-0 rounded-xl text-sm leading-relaxed ${
                          msg.role === 'user'
                            ? 'max-w-[82%] px-4 py-3 bg-indigo-600 text-white whitespace-pre-wrap break-words'
                            : 'w-full max-w-[96%] px-4 sm:px-5 py-4 space-y-3.5 bg-[#0b1120] border border-slate-800 text-slate-200'
                        }`}
                      >
                        {msg.role === 'assistant' && messageMeta[msg.id] && (
                          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/80">
                            <AIStatusBadge
                              source={messageMeta[msg.id].source}
                              label={messageMeta[msg.id].label}
                              isQuotaOrRateLimited={messageMeta[msg.id].isQuotaOrRateLimited}
                              compact
                            />
                            {messageMeta[msg.id].source === 'local_fallback' && (
                              <span className="text-[11px] text-slate-400">
                                Local note synthesis (not live AI)
                              </span>
                            )}
                          </div>
                        )}

                        {msg.role === 'assistant' && msg.insufficientContext && (
                          <div className="flex items-center gap-2 text-xs text-amber-300 pb-2.5 border-b border-slate-800">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>Limited coverage found in your saved notes</span>
                          </div>
                        )}

                        {msg.role === 'assistant' ? (
                          <StudyMarkdown content={msg.content} />
                        ) : (
                          msg.content
                        )}

                        {msg.role === 'assistant' && (
                          <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              {uniqueSources.length > 0 ? (
                                <>
                                  <span className="text-slate-500 font-medium shrink-0">
                                    Sources ({uniqueSources.length}):
                                  </span>
                                  {uniqueSources.map((src) => (
                                    <button
                                      key={src.noteId}
                                      type="button"
                                      onClick={() => openNoteInEditor(src.noteId)}
                                      title={`Open note: ${src.displayTitle}`}
                                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/25 text-indigo-300 hover:text-indigo-200 transition-colors"
                                    >
                                      <FileText className="w-3 h-3 shrink-0" />
                                      <span className="truncate max-w-[240px]">{src.displayTitle}</span>
                                    </button>
                                  ))}
                                </>
                              ) : (
                                <span className="text-slate-500">No source notes cited</span>
                              )}
                            </div>

                            <button
                              type="button"
                              onClick={() => void handleSaveSnippet(msg, idx)}
                              className="inline-flex items-center gap-1 text-slate-400 hover:text-indigo-300 whitespace-nowrap shrink-0"
                            >
                              <Bookmark className="w-3.5 h-3.5" />
                              Save Response
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}

              {/* Loading & Automatic Retry Progress with Cancel */}
              {loading && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-[#0b1120] border border-slate-800 text-xs text-slate-300">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400 shrink-0" />
                    <span className="leading-snug">
                      {retryNotice
                        ? `AI is temporarily busy — retrying in ${retryNotice.delaySeconds}s (attempt ${retryNotice.attempt} of ${retryNotice.maxAttempts})...`
                        : 'Finding relevant notes and generating a grounded answer...'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCancelRequest}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-rose-300 bg-rose-500/12 hover:bg-rose-500/20 border border-rose-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                </div>
              )}

              {/* Friendly Rate-Limit / Error Banner with Countdown & Retry */}
              {errorState && !loading && (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-amber-200">
                          {errorState.isQuotaExhausted
                            ? 'API quota reached'
                            : errorState.isRateLimit
                              ? 'AI is temporarily busy'
                              : 'Unable to answer right now'}
                        </p>
                        <p className="text-xs text-amber-100/85 leading-relaxed">
                          {errorState.message}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setErrorState(null)}
                      className="p-1 text-amber-300/70 hover:text-amber-100 shrink-0"
                      aria-label="Dismiss error"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {errorState.canRetry && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={cooldownSeconds > 0}
                        onClick={() => void handleAsk(errorState.lastQuestion)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {cooldownSeconds > 0 ? (
                          <>
                            <Clock className="w-3.5 h-3.5" />
                            <span className="font-mono tabular-nums">
                              Retry in {cooldownSeconds}s
                            </span>
                          </>
                        ) : (
                          <>
                            <RotateCcw className="w-3.5 h-3.5" />
                            Retry Question
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {followUps.length > 0 && !loading && (
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <span className="text-xs text-slate-500 inline-flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-indigo-400" />
                    Follow-ups:
                  </span>
                  {followUps.map((f) => (
                    <button
                      key={f}
                      type="button"
                      disabled={loading || cooldownSeconds > 0}
                      onClick={() => void handleAsk(f)}
                      className="px-3 py-1 text-xs text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/25 rounded-lg transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleAsk();
              }}
              className="p-4 border-t border-slate-800/80 flex items-center gap-3"
            >
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={
                  notes.length === 0
                    ? 'Add some notes first, or ask a question...'
                    : `Ask your notes (${mode} mode)...`
                }
                className="flex-1 px-4 py-2.5 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
              />
              {loading ? (
                <button
                  type="button"
                  onClick={handleCancelRequest}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-rose-200 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={submitBlocked}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cooldownSeconds > 0 ? (
                    <>
                      <Clock className="w-4 h-4" />
                      <span className="font-mono tabular-nums">Wait {cooldownSeconds}s</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Send
                    </>
                  )}
                </button>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
};
