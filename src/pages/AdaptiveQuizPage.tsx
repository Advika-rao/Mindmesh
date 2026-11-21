import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GraduationCap,
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
  Check,
  RotateCcw,
  Trash2,
  AlertTriangle,
  RefreshCw,
  X,
  Clock,
  Cpu,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { Quiz, QuizAttempt, type QuizDifficulty } from '../core/models/Quiz';
import { AIServiceException } from '../core/exceptions/MindMeshExceptions';
import type { StudyAssistantRetryNotice } from '../core/interfaces/CoreInterfaces';
import type {
  QuizFallbackInfo,
  QuizGenerationSource,
} from '../core/services/QuizGeneratorService';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { resolveNoteDisplayTitle } from '../core/utils/sourceNotes';
import { AIStatusBadge } from '../components/AIStatusBadge';

export const AdaptiveQuizPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const { notes, subjects, quizAttempts, notify, demoMode } = useKnowledge();

  const [scopeMode, setScopeMode] = useState<'subject' | 'notes'>('subject');
  const [selectedSubject, setSelectedSubject] = useState<string>('All Subjects');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('easy');
  const [questionCount, setQuestionCount] = useState<number>(5);

  const [generating, setGenerating] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [activeQuiz, setActiveQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [completedAttempt, setCompletedAttempt] = useState<QuizAttempt | null>(null);

  const [generationSource, setGenerationSource] = useState<QuizGenerationSource | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [fallbackInfo, setFallbackInfo] = useState<QuizFallbackInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<StudyAssistantRetryNotice | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const inFlightRef = useRef(false);
  const evaluatingRef = useRef(false);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const evalAbortRef = useRef<AbortController | null>(null);

  // Clean up any in-flight generation/evaluation requests on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      evalAbortRef.current?.abort();
      evalAbortRef.current = null;
      inFlightRef.current = false;
      evaluatingRef.current = false;
    };
  }, []);

  // Cooldown countdown timer for transient retries / click throttling
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  // Keep selectedSubject synchronized if notes/subjects change
  useEffect(() => {
    if (selectedSubject === 'All Subjects') return;
    const exists = subjects.some(
      (s) => s.name.trim().toLowerCase() === selectedSubject.trim().toLowerCase()
    );
    if (!exists && subjects.length > 0) {
      setSelectedSubject('All Subjects');
    }
  }, [subjects, selectedSubject]);

  const targetNotes = useMemo(() => {
    if (scopeMode === 'subject') {
      if (selectedSubject === 'All Subjects') return notes;
      const normalizedTarget = selectedSubject.trim().toLowerCase();
      return notes.filter((n) => (n.subject || 'General').trim().toLowerCase() === normalizedTarget);
    }
    const idSet = new Set(selectedNoteIds);
    return notes.filter((n) => idSet.has(n.noteId));
  }, [scopeMode, selectedSubject, selectedNoteIds, notes]);

  const effectiveSubject = useMemo(() => {
    if (scopeMode === 'subject') return selectedSubject;
    if (targetNotes.length === 0) return 'All Subjects';
    const uniq = Array.from(new Set(targetNotes.map((n) => (n.subject || 'General').trim())));
    return uniq.length === 1 ? uniq[0] : 'Mixed Subjects';
  }, [scopeMode, selectedSubject, targetNotes]);

  const adaptiveAdvice = useMemo(
    () => QuizAttempt.recommendAdaptiveConfig(quizAttempts, effectiveSubject),
    [quizAttempts, effectiveSubject]
  );

  // Automatically sync recommended difficulty when subject changes
  useEffect(() => {
    setDifficulty(adaptiveAdvice.recommendedDifficulty);
  }, [adaptiveAdvice.recommendedDifficulty, effectiveSubject]);

  const subjectStats = useMemo(() => {
    const map = new Map<string, { attempts: number; totalScore: number; weakTopics: Set<string> }>();
    for (const a of quizAttempts) {
      const entry = map.get(a.subject) ?? { attempts: 0, totalScore: 0, weakTopics: new Set<string>() };
      entry.attempts++;
      entry.totalScore += a.score;
      a.weakTopics.forEach((t) => entry.weakTopics.add(t));
      map.set(a.subject, entry);
    }
    return Array.from(map.entries()).map(([subject, stat]) => ({
      subject,
      attempts: stat.attempts,
      average: Math.round(stat.totalScore / stat.attempts),
      weakTopics: Array.from(stat.weakTopics).slice(0, 4),
    }));
  }, [quizAttempts]);

  const answeredCount = useMemo(() => {
    if (!activeQuiz) return 0;
    return activeQuiz.questions.filter((q) => Boolean((answers[q.id] || '').trim())).length;
  }, [activeQuiz, answers]);

  const handleCancelGeneration = useCallback(() => {
    if (!abortControllerRef.current && !inFlightRef.current) return;
    requestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    inFlightRef.current = false;
    setGenerating(false);
    setRetryNotice(null);
    notify('Quiz generation cancelled.', 'info');
  }, [notify]);

  const handleGenerateQuiz = useCallback(
    async (options?: { forceLocal?: boolean; bypassCache?: boolean }) => {
      if (!firebaseUser) {
        setErrorMessage('Please sign in to generate a quiz from your saved notes.');
        return;
      }

      // Prevent duplicate concurrent requests on rapid/double clicks
      if (inFlightRef.current) return;

      if (targetNotes.length === 0) {
        const msg =
          scopeMode === 'notes'
            ? 'Select at least one saved note before generating a quiz.'
            : `No saved notes were found for "${selectedSubject}". Select another subject or add notes first.`;
        setErrorMessage(msg);
        notify(msg, 'error');
        return;
      }

      const currentRequestId = ++requestIdRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      inFlightRef.current = true;

      setGenerating(true);
      setErrorMessage(null);
      setRetryNotice(null);
      setCompletedAttempt(null);
      setAnswers({});

      // Safety client-side watchdog (42s) guaranteeing an infinite spinner can never occur
      const watchdogTimer = window.setTimeout(() => {
        if (abortControllerRef.current === controller && !controller.signal.aborted) {
          controller.abort();
        }
      }, 42_000);

      try {
        const result = await workspaceService.quizGeneratorService.generateWithFallback(
          { userId: firebaseUser.uid },
          {
            selectedNotes: targetNotes,
            subject: effectiveSubject,
            difficulty,
            questionCount,
            previousAttempts: quizAttempts,
            demoMode: options?.forceLocal ? false : demoMode,
            forceLocal: options?.forceLocal,
            bypassCache: options?.bypassCache,
            signal: controller.signal,
            onRetry: (notice) => {
              if (requestIdRef.current === currentRequestId) {
                setRetryNotice(notice);
              }
            },
          }
        );

        // Ignore stale results if another request started or was cancelled
        if (requestIdRef.current !== currentRequestId) return;

        setActiveQuiz(result.quiz);
        setGenerationSource(result.generationSource);
        setStatusLabel(result.statusLabel);
        setFallbackInfo(result.fallbackInfo ?? null);
        setErrorMessage(null);

        if (result.fallbackInfo?.retryAfterSeconds) {
          setCooldownSeconds(result.fallbackInfo.retryAfterSeconds);
        } else {
          setCooldownSeconds(2);
        }

        if (result.generationSource === 'local_fallback' && result.fallbackInfo) {
          notify(`${result.fallbackInfo.title}. Generated a note-grounded quiz locally.`, 'info');
        }
      } catch (err) {
        if (requestIdRef.current !== currentRequestId) return;

        if (
          err instanceof AIServiceException &&
          (err.statusCode === 499 || err.serverCode === 'CANCELLED')
        ) {
          // User cancelled or watchdog aborted; if watchdog fired, show a clear retryable message
          if (!abortControllerRef.current) {
            return;
          }
          const timeoutMsg = 'Quiz generation timed out. Please retry or generate locally from your notes.';
          setErrorMessage(timeoutMsg);
          notify(timeoutMsg, 'error');
          return;
        }

        const msg =
          err instanceof Error && err.message.trim()
            ? err.message
            : 'Unable to generate quiz questions right now. Please try again.';
        setErrorMessage(msg);
        notify(msg, 'error');
      } finally {
        window.clearTimeout(watchdogTimer);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (requestIdRef.current === currentRequestId) {
          inFlightRef.current = false;
          setGenerating(false);
          setRetryNotice(null);
        }
      }
    },
    [
      firebaseUser,
      targetNotes,
      scopeMode,
      selectedSubject,
      effectiveSubject,
      difficulty,
      questionCount,
      quizAttempts,
      demoMode,
      notify,
    ]
  );

  const handleSubmitQuiz = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !activeQuiz || evaluatingRef.current) return;

    evaluatingRef.current = true;
    const controller = new AbortController();
    evalAbortRef.current = controller;
    setEvaluating(true);

    try {
      const outcome = await workspaceService.quizGeneratorService.evaluateAndSaveAttemptDetailed(
        { userId: firebaseUser.uid },
        activeQuiz,
        answers,
        { demoMode, signal: controller.signal }
      );
      setCompletedAttempt(outcome.attempt);
      setActiveQuiz(null);
      setFallbackInfo(null);

      if (!outcome.savedToCloud) {
        notify(
          `Quiz graded (${outcome.attempt.score}%), but cloud history sync is temporarily offline.`,
          'info'
        );
      } else if (outcome.usedLocalGradingFallback) {
        notify(
          `Quiz graded locally! You scored ${outcome.attempt.score}%.`,
          'success'
        );
      } else {
        notify(`Quiz graded! You scored ${outcome.attempt.score}%.`, 'success');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Quiz evaluation failed.', 'error');
    } finally {
      if (evalAbortRef.current === controller) {
        evalAbortRef.current = null;
      }
      evaluatingRef.current = false;
      setEvaluating(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Adaptive Quiz Builder */}
      {!activeQuiz && (
        <div className="grid lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold text-slate-50">
                  Adaptive Quiz Generator
                </h2>
                <p className="text-xs text-slate-400">
                  Generates multiple-choice and short-answer questions directly from your saved notes, adjusting difficulty automatically based on past scores.
                </p>
              </div>
              {demoMode && (
                <AIStatusBadge source="demo" label="Demo Mode" compact />
              )}
            </div>

            {/* Adaptive Recommendation Callout */}
            <div className="p-4 rounded-lg bg-indigo-500/10 border border-indigo-500/25 space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-indigo-300 inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  Adaptive Recommendation ({effectiveSubject})
                </span>
                <span className="font-mono text-indigo-200 uppercase">
                  {adaptiveAdvice.recommendedDifficulty}
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{adaptiveAdvice.rationale}</p>
              {adaptiveAdvice.revisionTopics.length > 0 && (
                <p className="text-xs text-amber-300 pt-1">
                  Topics recommended for revision: {adaptiveAdvice.revisionTopics.join(', ')}
                </p>
              )}
            </div>

            {/* Scope Mode Switcher */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 p-1 bg-[#0b1120] border border-slate-800 rounded-lg w-fit">
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => {
                      setScopeMode('subject');
                      setErrorMessage(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      scopeMode === 'subject' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    By Subject
                  </button>
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => {
                      setScopeMode('notes');
                      setErrorMessage(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      scopeMode === 'notes' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Individual Notes
                  </button>
                </div>
                <span className="text-[11px] font-mono text-slate-400">
                  {targetNotes.length} saved note{targetNotes.length === 1 ? '' : 's'} selected
                </span>
              </div>

              {scopeMode === 'subject' ? (
                <select
                  value={selectedSubject}
                  disabled={generating}
                  onChange={(e) => {
                    setSelectedSubject(e.target.value);
                    setErrorMessage(null);
                  }}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                >
                  <option value="All Subjects">All Subjects ({notes.length} notes)</option>
                  {subjects.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name} ({s.noteCount} notes)
                    </option>
                  ))}
                </select>
              ) : (
                <div className="max-h-40 overflow-y-auto grid sm:grid-cols-2 gap-2 pr-1">
                  {notes.map((n) => {
                    const checked = selectedNoteIds.includes(n.noteId);
                    const displayTitle = resolveNoteDisplayTitle({
                      title: n.title,
                      content: n.content,
                      subject: n.subject,
                      tags: n.tags,
                    });
                    return (
                      <button
                        key={n.noteId}
                        type="button"
                        disabled={generating}
                        onClick={() => {
                          setErrorMessage(null);
                          setSelectedNoteIds((prev) =>
                            prev.includes(n.noteId)
                              ? prev.filter((id) => id !== n.noteId)
                              : [...prev, n.noteId]
                          );
                        }}
                        className={`text-left px-3 py-2 rounded-lg border text-xs flex items-center gap-2 transition-colors ${
                          checked
                            ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200'
                            : 'bg-[#0b1120] border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <span
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                            checked ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-slate-600'
                          }`}
                        >
                          {checked && <Check className="w-3 h-3" />}
                        </span>
                        <span className="truncate flex-1">{displayTitle}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Difficulty & Count */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Difficulty Level</label>
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0b1120] border border-slate-800 rounded-lg">
                  {(['easy', 'medium', 'hard'] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      disabled={generating}
                      onClick={() => setDifficulty(lvl)}
                      className={`py-1.5 text-xs font-medium capitalize rounded-md transition-colors ${
                        difficulty === lvl
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="quiz-count" className="block text-xs font-medium text-slate-300">
                  Number of Questions
                </label>
                <select
                  id="quiz-count"
                  value={questionCount}
                  disabled={generating}
                  onChange={(e) => setQuestionCount(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                >
                  {[3, 5, 7, 10].map((c) => (
                    <option key={c} value={c}>
                      {c} Questions
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Transient Retry Notice while waiting */}
            {generating && retryNotice && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center gap-2.5 text-xs text-amber-200">
                <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  AI is temporarily busy — retrying automatically ({retryNotice.attempt}/{retryNotice.maxAttempts}) in {retryNotice.delaySeconds}s...
                </span>
              </div>
            )}

            {/* Inline Error Panel with Retry */}
            {errorMessage && !generating && (
              <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 space-y-2.5">
                <div className="flex items-start gap-2.5 text-xs text-rose-200">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div className="space-y-1 flex-1">
                    <p className="font-medium text-rose-100">Quiz generation could not complete</p>
                    <p className="text-rose-200/90 leading-relaxed">{errorMessage}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-6">
                  <button
                    type="button"
                    disabled={generating || targetNotes.length === 0}
                    onClick={() => void handleGenerateQuiz({ bypassCache: true })}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-md transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                  {targetNotes.length > 0 && (
                    <button
                      type="button"
                      disabled={generating}
                      onClick={() => void handleGenerateQuiz({ forceLocal: true })}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors disabled:opacity-50"
                    >
                      <Cpu className="w-3.5 h-3.5" />
                      Generate Locally from Notes
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Primary Action + Cancel Button */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={generating || notes.length === 0 || targetNotes.length === 0}
                onClick={() => void handleGenerateQuiz()}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <GraduationCap className="w-4 h-4" />
                )}
                {generating
                  ? 'Crafting Adaptive Questions...'
                  : demoMode
                    ? 'Generate Quiz (Demo Mode)'
                    : 'Generate Quiz'}
              </button>

              {generating && (
                <button
                  type="button"
                  onClick={handleCancelGeneration}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel
                </button>
              )}
            </div>
          </div>

          {/* Subject Performance Analytics */}
          <div className="lg:col-span-5 bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Performance by Subject
            </h3>
            {subjectStats.length === 0 ? (
              <p className="text-xs text-slate-400 leading-relaxed">
                Complete your first quiz to track subject accuracy, adaptive progression, and revision priorities.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {subjectStats.map((st) => (
                  <div key={st.subject} className="py-3 first:pt-0 last:pb-0 space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-100">{st.subject}</span>
                      <span className="font-mono text-xs tabular-nums text-indigo-300">
                        {st.average}% avg · {st.attempts} attempt{st.attempts === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 rounded-full"
                        style={{ width: `${st.average}%` }}
                      />
                    </div>
                    {st.weakTopics.length > 0 && (
                      <p className="text-[11px] text-amber-300/90">
                        Revise: {st.weakTopics.join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Active Quiz Form */}
      {activeQuiz && (
        <form
          onSubmit={handleSubmitQuiz}
          className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800/80">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="font-display text-lg font-semibold text-slate-50">
                  {activeQuiz.subject} Quiz
                </h3>
                {generationSource && statusLabel && (
                  <AIStatusBadge
                    source={generationSource}
                    label={statusLabel}
                    isQuotaOrRateLimited={
                      fallbackInfo?.category === 'quota_exhausted' ||
                      fallbackInfo?.category === 'rate_limit'
                    }
                    compact
                  />
                )}
              </div>
              <p className="text-xs text-slate-400 capitalize">
                {activeQuiz.difficulty} difficulty · {activeQuiz.questions.length} questions ·{' '}
                {answeredCount}/{activeQuiz.questions.length} answered
              </p>
            </div>
            <button
              type="button"
              disabled={evaluating}
              onClick={() => {
                setActiveQuiz(null);
                setFallbackInfo(null);
              }}
              className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
            >
              Cancel quiz
            </button>
          </div>

          {/* Local Fallback Notice with Optional Retry with AI */}
          {fallbackInfo && generationSource === 'local_fallback' && (
            <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/25 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-2.5 text-xs text-amber-100 flex-1 min-w-[220px]">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-medium text-amber-200">{fallbackInfo.title}</p>
                  <p className="text-amber-100/85 leading-relaxed">{fallbackInfo.message}</p>
                </div>
              </div>
              {fallbackInfo.canRetry && (
                <button
                  type="button"
                  disabled={generating || cooldownSeconds > 0}
                  onClick={() => void handleGenerateQuiz({ bypassCache: true })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-100 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/35 rounded-md transition-colors disabled:opacity-50 shrink-0"
                >
                  {generating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  {cooldownSeconds > 0 ? `Retry AI (${cooldownSeconds}s)` : 'Retry with AI'}
                </button>
              )}
            </div>
          )}

          <div className="space-y-6">
            {activeQuiz.questions.map((q, idx) => (
              <div key={q.id} className="space-y-3 pb-6 border-b border-slate-800/60 last:border-b-0 last:pb-0">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm font-medium text-slate-100 leading-relaxed">
                    <span className="font-mono text-indigo-400 mr-2">
                      {String(idx + 1).padStart(2, '0')}.
                    </span>
                    {q.prompt}
                  </p>
                  <span className="text-xs text-slate-500 shrink-0">
                    {q.topic} · {q.type === 'mcq' ? 'Multiple Choice' : 'Short Answer'}
                  </span>
                </div>

                {q.type === 'mcq' ? (
                  <div className="grid sm:grid-cols-2 gap-2.5 pl-7">
                    {q.options.map((opt, optIdx) => {
                      const selected = answers[q.id] === opt;
                      return (
                        <button
                          key={`${q.id}-opt-${optIdx}`}
                          type="button"
                          onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                          className={`text-left px-4 py-2.5 rounded-lg border text-xs transition-colors ${
                            selected
                              ? 'bg-indigo-600/20 border-indigo-500 text-indigo-100'
                              : 'bg-[#0b1120] border-slate-800 text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="pl-7">
                    <textarea
                      rows={3}
                      value={answers[q.id] || ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder="Write a clear, concise answer based on your notes..."
                      className="w-full px-3.5 py-2.5 text-sm bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <span className="text-xs text-slate-400">
              {answeredCount === activeQuiz.questions.length
                ? 'All questions answered — ready to submit.'
                : `${activeQuiz.questions.length - answeredCount} question${
                    activeQuiz.questions.length - answeredCount === 1 ? '' : 's'
                  } remaining.`}
            </span>
            <button
              type="submit"
              disabled={evaluating}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
            >
              {evaluating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {evaluating ? 'Evaluating Answers...' : 'Submit & Grade Quiz'}
            </button>
          </div>
        </form>
      )}

      {/* Completed Quiz Results Review */}
      {completedAttempt && (
        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
            <div>
              <p className="text-xs text-indigo-400 font-medium">Quiz Results</p>
              <h3 className="font-display text-2xl font-bold text-slate-50 font-mono tabular-nums mt-0.5">
                {completedAttempt.score}% Score
              </h3>
              <p className="text-xs text-slate-400 capitalize mt-0.5">
                {completedAttempt.subject} · {completedAttempt.difficulty} difficulty ·{' '}
                {completedAttempt.answers.filter((a) => a.isCorrect).length}/{completedAttempt.totalQuestions} correct
              </p>
            </div>

            <button
              type="button"
              onClick={() => setCompletedAttempt(null)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              New Quiz
            </button>
          </div>

          {completedAttempt.weakTopics.length > 0 && (
            <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
              Recommended topics for revision: <span className="font-semibold">{completedAttempt.weakTopics.join(', ')}</span>
            </div>
          )}

          <div className="divide-y divide-slate-800/70">
            {completedAttempt.questions.map((q, idx) => {
              const evalAns = completedAttempt.answers.find((a) => a.questionId === q.id);
              const isCorrect = evalAns?.isCorrect ?? false;
              return (
                <div key={q.id} className="py-4 first:pt-0 last:pb-0 space-y-2">
                  <div className="flex items-start gap-2.5">
                    {isCorrect ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    )}
                    <div className="space-y-1 flex-1">
                      <p className="text-sm font-medium text-slate-100">
                        {idx + 1}. {q.prompt}
                      </p>
                      <p className="text-xs text-slate-400">
                        Your answer: <span className="text-slate-200">{evalAns?.userAnswer || '(blank)'}</span>
                      </p>
                      {!isCorrect && (
                        <p className="text-xs text-emerald-300">
                          Correct answer: {q.correctAnswer}
                        </p>
                      )}
                      <p className="text-xs text-slate-300 leading-relaxed pt-0.5">
                        {evalAns?.feedback || q.explanation}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Previous Quiz Attempts Table */}
      <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-6 space-y-4">
        <h3 className="font-display text-sm font-semibold text-slate-100">
          Previous Quiz Attempts ({quizAttempts.length})
        </h3>
        {quizAttempts.length === 0 ? (
          <p className="text-xs text-slate-400">No completed quizzes recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 pr-4 font-medium">Subject</th>
                  <th className="py-2.5 pr-4 font-medium">Difficulty</th>
                  <th className="py-2.5 pr-4 font-medium">Score</th>
                  <th className="py-2.5 pr-4 font-medium">Revision Topics</th>
                  <th className="py-2.5 pr-4 font-medium">Completed</th>
                  <th className="py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {quizAttempts.map((att) => (
                  <tr key={att.attemptId} className="hover:bg-slate-800/30">
                    <td className="py-3 pr-4 font-medium text-slate-100">{att.subject}</td>
                    <td className="py-3 pr-4 capitalize text-slate-300">{att.difficulty}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-indigo-300 font-semibold">
                      {att.score}%
                    </td>
                    <td className="py-3 pr-4 text-slate-400 max-w-[220px] truncate">
                      {att.weakTopics.length > 0 ? att.weakTopics.join(', ') : 'All mastered'}
                    </td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {att.completedAt.toLocaleDateString()}
                    </td>
                    <td className="py-3 text-right whitespace-nowrap space-x-2">
                      <button
                        type="button"
                        onClick={() => setCompletedAttempt(att)}
                        className="text-indigo-400 hover:text-indigo-300 font-medium"
                      >
                        Review
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await workspaceService.quizGeneratorService.deleteAttempt(att.attemptId);
                          if (completedAttempt?.attemptId === att.attemptId) setCompletedAttempt(null);
                          notify('Quiz attempt deleted.', 'success');
                        }}
                        className="text-slate-500 hover:text-rose-400 inline-flex align-middle"
                        aria-label="Delete attempt"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
