import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import { toPng } from 'html-to-image';
import {
  GitBranch,
  Sparkles,
  Download,
  Save,
  Plus,
  Trash2,
  Loader2,
  Check,
  RefreshCw,
  AlertTriangle,
  Clock,
  X,
  Cpu,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { MindMap } from '../core/models/MindMap';
import { AIServiceException } from '../core/exceptions/MindMeshExceptions';
import type { StudyAssistantRetryNotice } from '../core/interfaces/CoreInterfaces';
import type {
  MindMapFallbackInfo,
  MindMapGenerationSource,
} from '../core/services/MindMapService';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import { resolveNoteDisplayTitle } from '../core/utils/sourceNotes';
import { AIStatusBadge } from '../components/AIStatusBadge';

interface MindMapStatusBanner {
  type: 'fallback' | 'error';
  title: string;
  message: string;
  canRetry: boolean;
  isQuotaExhausted: boolean;
  lastNoteIds: string[];
  lastCustomTitle: string;
}

const LEVEL_BADGES: Record<number, string> = {
  0: 'Central Topic',
  1: 'Main Branch',
  2: 'Subtopic',
  3: 'Detail / Example',
};

export const MindMapPage: React.FC = () => {
  const { firebaseUser } = useAuth();
  const {
    notes,
    mindMaps,
    selectedMindMapId,
    setSelectedMindMapId,
    notify,
    demoMode,
  } = useKnowledge();

  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [customTitle, setCustomTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [retryNotice, setRetryNotice] = useState<StudyAssistantRetryNotice | null>(null);
  const [statusBanner, setStatusBanner] = useState<MindMapStatusBanner | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [generationSource, setGenerationSource] = useState<MindMapGenerationSource | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [savedToCloud, setSavedToCloud] = useState(true);

  // Editable working copy of active MindMap
  const [workingMap, setWorkingMap] = useState<MindMap | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [newChildTitle, setNewChildTitle] = useState('');
  const [newChildDesc, setNewChildDesc] = useState('');
  const [reparentTargetId, setReparentTargetId] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Clean up any in-flight generation on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      inFlightRef.current = false;
    };
  }, []);

  // Countdown timer for transient rate-limit retries
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  // Load selected saved MindMap into editable workingMap
  useEffect(() => {
    const found = mindMaps.find((m) => m.mindMapId === selectedMindMapId) ?? mindMaps[0] ?? null;
    if (found && (!workingMap || workingMap.mindMapId !== found.mindMapId)) {
      setWorkingMap(new MindMap(found.toDTO()));
      setSelectedMindMapId(found.mindMapId);
      setSelectedNodeId(null);
      setHasUnsavedChanges(false);
      setSavedToCloud(true);
    }
    if (!found && mindMaps.length === 0 && savedToCloud) {
      setWorkingMap(null);
    }
  }, [mindMaps, selectedMindMapId, setSelectedMindMapId, workingMap, savedToCloud]);

  const selectedNodeObj = useMemo(
    () => workingMap?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [workingMap, selectedNodeId]
  );

  useEffect(() => {
    if (selectedNodeObj) {
      setEditTitle(selectedNodeObj.title);
      setEditDesc(selectedNodeObj.description);
      setReparentTargetId(selectedNodeObj.parentId);
    }
  }, [selectedNodeObj]);

  const flowData = useMemo(() => {
    if (!workingMap) return { flowNodes: [] as FlowNode[], flowEdges: [] as FlowEdge[] };

    const levelStyles: Record<number, { bg: string; border: string; width: number; accent: string }> = {
      0: { bg: '#312e81', border: '#818cf8', width: 230, accent: 'text-indigo-200' },
      1: { bg: '#172038', border: '#6366f1', width: 215, accent: 'text-indigo-300' },
      2: { bg: '#0f172a', border: '#334155', width: 200, accent: 'text-slate-400' },
      3: { bg: '#0b1424', border: '#0e7490', width: 190, accent: 'text-cyan-300/90' },
    };

    const parentMap = new Map(workingMap.nodes.map((n) => [n.id, n.parentId]));

    const flowNodes: FlowNode[] = workingMap.nodes.map((node) => {
      const styleCfg = levelStyles[node.level] ?? levelStyles[3];
      const isSelected = node.id === selectedNodeId;
      const badge = LEVEL_BADGES[node.level] ?? 'Detail';
      return {
        id: node.id,
        position: { x: node.x, y: node.y },
        data: {
          label: (
            <div className="text-left space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[9px] uppercase tracking-wider font-semibold ${styleCfg.accent}`}>
                  {badge}
                </span>
              </div>
              <p className="text-xs font-semibold text-slate-50 leading-snug">{node.title}</p>
              {node.description && (
                <p className="text-[11px] text-slate-300/85 leading-snug line-clamp-3">
                  {node.description}
                </p>
              )}
            </div>
          ),
        },
        style: {
          width: styleCfg.width,
          padding: '10px 12px',
          borderRadius: 12,
          background: styleCfg.bg,
          border: isSelected ? '2px solid #c4b5fd' : `1px solid ${styleCfg.border}`,
          boxShadow: isSelected
            ? '0 0 24px rgba(139, 92, 246, 0.45)'
            : '0 4px 12px rgba(2,6,23,0.45)',
          cursor: 'pointer',
        },
      };
    });

    const flowEdges: FlowEdge[] = workingMap.connections.map((conn) => {
      const isCrossBranch =
        parentMap.get(conn.target) !== conn.source && parentMap.get(conn.source) !== conn.target;
      return {
        id: conn.id,
        source: conn.source,
        target: conn.target,
        label: conn.label || undefined,
        type: 'smoothstep',
        animated: isCrossBranch,
        labelStyle: { fill: isCrossBranch ? '#7dd3fc' : '#94a3b8', fontSize: 10 },
        labelBgStyle: { fill: '#0b1120', fillOpacity: 0.92 },
        style: isCrossBranch
          ? { stroke: '#38bdf8', strokeWidth: 1.5, strokeDasharray: '5 4' }
          : { stroke: '#6366f1', strokeWidth: 1.8 },
      };
    });

    return { flowNodes, flowEdges };
  }, [workingMap, selectedNodeId]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<FlowNode>(flowData.flowNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<FlowEdge>(flowData.flowEdges);

  useEffect(() => {
    setRfNodes(flowData.flowNodes);
    setRfEdges(flowData.flowEdges);
  }, [flowData, setRfNodes, setRfEdges]);

  const cloneAndMutate = useCallback(
    (mutator: (map: MindMap) => void) => {
      if (!workingMap) return;
      try {
        const next = new MindMap(workingMap.toDTO());
        mutator(next);
        setWorkingMap(next);
        setHasUnsavedChanges(true);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Unable to update mind map.', 'error');
      }
    },
    [workingMap, notify]
  );

  const handleNodeClick: NodeMouseHandler = useCallback((_evt, node) => {
    setSelectedNodeId(node.id);
  }, []);

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_evt, node) => {
      cloneAndMutate((m) => m.moveNode(node.id, node.position.x, node.position.y));
    },
    [cloneAndMutate]
  );

  const toggleNoteSelection = (noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  };

  const handleCancelGeneration = useCallback(() => {
    if (!abortControllerRef.current) return;
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    inFlightRef.current = false;
    setGenerating(false);
    setRetryNotice(null);
    notify('Mind map generation cancelled.', 'info');
  }, [notify]);

  const runGeneration = useCallback(
    async (options?: { noteIds?: string[]; titleOverride?: string; forceLocal?: boolean }) => {
      if (!firebaseUser) return;
      if (inFlightRef.current || cooldownSeconds > 0) return;

      const targetIds = options?.noteIds ?? selectedNoteIds;
      const chosenNotes = notes.filter((n) => targetIds.includes(n.noteId));
      if (chosenNotes.length === 0) {
        setStatusBanner({
          type: 'error',
          title: 'No notes selected',
          message: 'Select at least one saved note above before generating a mind map.',
          canRetry: false,
          isQuotaExhausted: false,
          lastNoteIds: [],
          lastCustomTitle: '',
        });
        notify('Select at least one note to generate a mind map.', 'error');
        return;
      }

      const targetTitle = options?.titleOverride !== undefined ? options.titleOverride : customTitle;

      inFlightRef.current = true;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setGenerating(true);
      setRetryNotice(null);
      setStatusBanner(null);

      try {
        const result = await workspaceService.mindMapService.generateWithFallback(
          { userId: firebaseUser.uid },
          {
            selectedNotes: chosenNotes,
            customTitle: targetTitle,
            forceLocal: options?.forceLocal,
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

        setWorkingMap(new MindMap(result.mindMap.toDTO()));
        setSelectedMindMapId(result.mindMap.mindMapId);
        setSelectedNodeId(null);
        setGenerationSource(result.generationSource);
        setStatusLabel(result.statusLabel);
        setSavedToCloud(result.savedToCloud);
        setHasUnsavedChanges(!result.savedToCloud);

        if (options?.titleOverride === undefined) {
          setCustomTitle('');
        }

        if (result.generationSource === 'ai') {
          setCooldownSeconds(2);
        }

        if (result.generationSource === 'local_fallback' && result.fallbackInfo) {
          const info: MindMapFallbackInfo = result.fallbackInfo;
          if (info.category === 'rate_limit' && info.retryAfterSeconds) {
            setCooldownSeconds(Math.min(20, Math.max(4, info.retryAfterSeconds)));
          }
          setStatusBanner({
            type: 'fallback',
            title: info.title,
            message: info.message,
            canRetry: info.canRetry,
            isQuotaExhausted: info.category === 'quota_exhausted',
            lastNoteIds: chosenNotes.map((n) => n.noteId),
            lastCustomTitle: targetTitle,
          });
          notify(
            `Generated "${result.mindMap.title}" locally from ${chosenNotes.length} note(s).`,
            'info'
          );
        } else {
          setStatusBanner(null);
          notify(
            `${result.statusLabel} — "${result.mindMap.title}" (${result.mindMap.nodes.length} nodes).`,
            'success'
          );
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (
          err instanceof AIServiceException &&
          (err.statusCode === 499 || err.serverCode === 'CANCELLED')
        ) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Mind map generation failed.';
        setStatusBanner({
          type: 'error',
          title: 'Mind map generation failed',
          message,
          canRetry: true,
          isQuotaExhausted: false,
          lastNoteIds: chosenNotes.map((n) => n.noteId),
          lastCustomTitle: targetTitle,
        });
        notify(message, 'error');
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        inFlightRef.current = false;
        setGenerating(false);
        setRetryNotice(null);
      }
    },
    [firebaseUser, cooldownSeconds, selectedNoteIds, notes, customTitle, demoMode, setSelectedMindMapId, notify]
  );

  const handleRegenerateActive = () => {
    if (!workingMap) return;
    const activeSourceIds =
      selectedNoteIds.length > 0
        ? selectedNoteIds
        : workingMap.sourceNoteIds.filter((id) => notes.some((n) => n.noteId === id));

    if (activeSourceIds.length === 0) {
      notify('Select one or more notes above to regenerate the mind map.', 'error');
      return;
    }

    setSelectedNoteIds(activeSourceIds);
    void runGeneration({
      noteIds: activeSourceIds,
      titleOverride: customTitle.trim() || undefined,
    });
  };

  const handleSaveMap = async () => {
    if (!workingMap) return;
    setSaving(true);
    try {
      await workspaceService.mindMapService.saveEdits(workingMap, !savedToCloud);
      setHasUnsavedChanges(false);
      setSavedToCloud(true);
      notify('Mind map changes saved to Firestore.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save mind map.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExportPng = async () => {
    if (!canvasRef.current || !workingMap) return;
    setExporting(true);
    try {
      const dataUrl = await toPng(canvasRef.current, {
        backgroundColor: '#070b16',
        pixelRatio: 2,
      });
      const link = document.createElement('a');
      link.download = `${workingMap.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
      link.href = dataUrl;
      link.click();
      notify('Mind map exported as PNG image.', 'success');
    } catch {
      notify('Unable to export PNG image. Try again after adjusting zoom.', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Generator & Saved Maps Bar */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Generate Mind Map from Saved Notes
            </h2>
            <div className="flex items-center gap-2.5 text-xs">
              {notes.length > 1 && (
                <>
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => setSelectedNoteIds(notes.slice(0, 10).map((n) => n.noteId))}
                    className="text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
                  >
                    Select All
                  </button>
                  {selectedNoteIds.length > 0 && (
                    <button
                      type="button"
                      disabled={generating}
                      onClick={() => setSelectedNoteIds([])}
                      className="text-slate-400 hover:text-slate-200 disabled:opacity-40"
                    >
                      Clear
                    </button>
                  )}
                </>
              )}
              <span className="font-mono tabular-nums text-slate-400">
                {selectedNoteIds.length} selected
              </span>
            </div>
          </div>

          {notes.length === 0 ? (
            <p className="text-xs text-slate-400">
              Create notes in My Notes first to generate a mind map.
            </p>
          ) : (
            <>
              <div className="max-h-40 overflow-y-auto grid sm:grid-cols-2 gap-2 pr-1">
                {notes.map((n) => {
                  const checked = selectedNoteIds.includes(n.noteId);
                  const displayTitle = resolveNoteDisplayTitle(n);
                  return (
                    <button
                      key={n.noteId}
                      type="button"
                      disabled={generating}
                      onClick={() => toggleNoteSelection(n.noteId)}
                      title={`${displayTitle} (${n.subject})`}
                      className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors flex items-center gap-2 disabled:opacity-60 ${
                        checked
                          ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-100'
                          : 'bg-[#0b1120] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
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

              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  disabled={generating}
                  placeholder="Optional custom central topic title..."
                  className="flex-1 min-w-[200px] px-3.5 py-2 text-xs bg-[#0b1120] border border-slate-800 focus:border-indigo-500 focus:outline-none rounded-lg text-slate-100 placeholder:text-slate-500 disabled:opacity-60"
                />
                {generating ? (
                  <button
                    type="button"
                    onClick={handleCancelGeneration}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-rose-200 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={selectedNoteIds.length === 0 || cooldownSeconds > 0}
                    onClick={() => void runGeneration()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {cooldownSeconds > 0 ? (
                      <>
                        <Clock className="w-3.5 h-3.5" />
                        <span className="font-mono tabular-nums">Wait {cooldownSeconds}s</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        Generate Mind Map
                      </>
                    )}
                  </button>
                )}
              </div>

              {/* Active Loading / Retry Status Strip */}
              {generating && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#0b1120] border border-indigo-500/30 text-xs text-slate-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 shrink-0" />
                  <span>
                    {retryNotice
                      ? `AI is temporarily busy — retrying in ${retryNotice.delaySeconds}s (attempt ${retryNotice.attempt} of ${retryNotice.maxAttempts})...`
                      : `Analyzing ${selectedNoteIds.length} selected note${selectedNoteIds.length === 1 ? '' : 's'} and building hierarchical branches...`}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Saved Mind Maps */}
        <div className="lg:col-span-5 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-100">
            Saved Mind Maps ({mindMaps.length})
          </h3>
          {mindMaps.length === 0 ? (
            <p className="text-xs text-slate-400">
              Generated mind maps are saved here so you can reopen, edit, or export them anytime.
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto divide-y divide-slate-800/70 pr-1">
              {mindMaps.map((mm) => (
                <div
                  key={mm.mindMapId}
                  className={`py-2 px-2 rounded-lg flex items-center justify-between gap-2 ${
                    workingMap?.mindMapId === mm.mindMapId ? 'bg-indigo-600/18' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setWorkingMap(new MindMap(mm.toDTO()));
                      setSelectedMindMapId(mm.mindMapId);
                      setSelectedNodeId(null);
                      setHasUnsavedChanges(false);
                      setSavedToCloud(true);
                      setGenerationSource(null);
                      setStatusBanner(null);
                      if (mm.sourceNoteIds.length > 0) {
                        const existingIds = mm.sourceNoteIds.filter((id) =>
                          notes.some((n) => n.noteId === id)
                        );
                        if (existingIds.length > 0) setSelectedNoteIds(existingIds);
                      }
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="text-xs font-medium text-slate-100 truncate">{mm.title}</p>
                    <p className="text-[11px] font-mono tabular-nums text-slate-500">
                      {mm.nodes.length} nodes · {mm.sourceNoteIds.length || 1} note
                      {(mm.sourceNoteIds.length || 1) === 1 ? '' : 's'} · {mm.updatedAt.toLocaleDateString()}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await workspaceService.mindMapService.deleteMindMap(mm.mindMapId);
                      if (workingMap?.mindMapId === mm.mindMapId) setWorkingMap(null);
                      notify('Mind map deleted.', 'success');
                    }}
                    className="p-1 text-slate-500 hover:text-rose-400 shrink-0"
                    aria-label="Delete mind map"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Distinct AI Error / Local Fallback Notice Banner */}
      {statusBanner && !generating && (
        <div
          className={`rounded-xl border p-4 space-y-3 ${
            statusBanner.type === 'fallback'
              ? 'bg-amber-500/10 border-amber-500/30'
              : 'bg-rose-500/10 border-rose-500/30'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertTriangle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  statusBanner.type === 'fallback' ? 'text-amber-400' : 'text-rose-400'
                }`}
              />
              <div className="space-y-1">
                <p
                  className={`text-xs font-semibold ${
                    statusBanner.type === 'fallback' ? 'text-amber-200' : 'text-rose-200'
                  }`}
                >
                  {statusBanner.title}
                </p>
                <p
                  className={`text-xs leading-relaxed ${
                    statusBanner.type === 'fallback' ? 'text-amber-100/85' : 'text-rose-100/85'
                  }`}
                >
                  {statusBanner.message}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="p-1 text-slate-400 hover:text-slate-200 shrink-0"
              aria-label="Dismiss notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {statusBanner.canRetry && !statusBanner.isQuotaExhausted && statusBanner.lastNoteIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={cooldownSeconds > 0 || generating}
                onClick={() =>
                  void runGeneration({
                    noteIds: statusBanner.lastNoteIds,
                    titleOverride: statusBanner.lastCustomTitle,
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cooldownSeconds > 0 ? (
                  <>
                    <Clock className="w-3.5 h-3.5" />
                    <span className="font-mono tabular-nums">Retry with AI in {cooldownSeconds}s</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry with AI
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Mind Map Canvas + Node Editor */}
      {workingMap ? (
        <div className="space-y-3">
          <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-base font-semibold text-slate-50 truncate">
                  {workingMap.title}
                </h3>
                {generationSource && statusLabel ? (
                  <AIStatusBadge
                    source={generationSource}
                    label={statusLabel}
                    isQuotaOrRateLimited={Boolean(
                      statusBanner?.isQuotaExhausted ||
                        statusLabel.toLowerCase().includes('quota')
                    )}
                    compact
                  />
                ) : generationSource === 'local_fallback' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-amber-200 bg-amber-500/15 border border-amber-500/30 rounded-md whitespace-nowrap">
                    <Cpu className="w-3 h-3" />
                    Generated Locally
                  </span>
                ) : demoMode ? (
                  <AIStatusBadge
                    source="demo"
                    label="Demo Mode active"
                    compact
                  />
                ) : null}
              </div>
              <p className="text-xs text-slate-400">
                {workingMap.nodes.length} nodes · {workingMap.sourceNoteIds.length || 1} source note
                {(workingMap.sourceNoteIds.length || 1) === 1 ? '' : 's'} · Click any node to edit, add
                subtopics, reparent, or drag to rearrange.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={generating || cooldownSeconds > 0}
                onClick={handleRegenerateActive}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#0b1120] hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
                Regenerate
              </button>
              <button
                type="button"
                disabled={saving || (!hasUnsavedChanges && savedToCloud)}
                onClick={() => void handleSaveMap()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {!savedToCloud ? 'Save Mind Map' : hasUnsavedChanges ? 'Save Edits' : 'Saved'}
              </button>
              <button
                type="button"
                disabled={exporting}
                onClick={() => void handleExportPng()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0b1120] hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                {exporting ? 'Exporting...' : 'Export PNG'}
              </button>
            </div>
          </div>

          <div className="grid lg:grid-cols-12 gap-4">
            <div
              ref={canvasRef}
              className={`${
                selectedNodeObj ? 'lg:col-span-8' : 'lg:col-span-12'
              } relative h-[560px] bg-[#070b16] border border-slate-800/80 rounded-xl overflow-hidden`}
            >
              <ReactFlow
                key={workingMap.mindMapId}
                nodes={rfNodes}
                edges={rfEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleNodeClick}
                onNodeDragStop={handleNodeDragStop}
                onPaneClick={() => setSelectedNodeId(null)}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.25}
                maxZoom={2}
              >
                <Background color="#1e293b" gap={24} size={1} />
                <Controls />
                <MiniMap
                  nodeColor={(node) => {
                    const match = workingMap.nodes.find((n) => n.id === node.id);
                    if (!match) return '#334155';
                    if (match.level === 0) return '#818cf8';
                    if (match.level === 1) return '#6366f1';
                    if (match.level === 2) return '#475569';
                    return '#0891b2';
                  }}
                  maskColor="rgba(7, 11, 22, 0.72)"
                />
              </ReactFlow>

              {generating && (
                <div className="absolute inset-0 bg-[#070b16]/70 backdrop-blur-[2px] flex items-center justify-center z-10">
                  <div className="px-4 py-3 rounded-xl bg-[#0f172a] border border-indigo-500/40 flex items-center gap-3 text-xs text-slate-200 shadow-xl">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                    <span>Generating hierarchical mind map...</span>
                  </div>
                </div>
              )}
            </div>

            {selectedNodeObj && (
              <aside className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 space-y-5 h-fit max-h-[560px] overflow-y-auto">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-display text-sm font-semibold text-slate-100">
                      Edit {LEVEL_BADGES[selectedNodeObj.level] ?? 'Branch'} Node
                    </h4>
                    <button
                      type="button"
                      onClick={() => setSelectedNodeId(null)}
                      className="p-1 text-slate-400 hover:text-slate-200"
                      aria-label="Close node editor"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400">Title</label>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400">Description</label>
                    <textarea
                      rows={3}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      cloneAndMutate((m) => {
                        m.updateNode(selectedNodeObj.id, editTitle, editDesc);
                        if (selectedNodeObj.level === 0 && editTitle.trim()) {
                          m.rename(editTitle.trim());
                        }
                      })
                    }
                    className="w-full py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                  >
                    Apply Node Edit
                  </button>
                </div>

                {/* Rearrange / Reparent Branch */}
                {selectedNodeObj.level > 0 && (
                  <div className="pt-4 border-t border-slate-800 space-y-2.5">
                    <label className="block text-xs font-medium text-slate-300">
                      Move Under Parent Branch
                    </label>
                    <div className="flex gap-2">
                      <select
                        value={reparentTargetId}
                        onChange={(e) => setReparentTargetId(e.target.value)}
                        className="flex-1 px-2.5 py-1.5 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-200"
                      >
                        {workingMap.nodes
                          .filter((n) => n.id !== selectedNodeObj.id)
                          .map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.title}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          cloneAndMutate((m) => m.reparentNode(selectedNodeObj.id, reparentTargetId))
                        }
                        className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg"
                      >
                        Move
                      </button>
                    </div>
                  </div>
                )}

                {/* Add Child Branch */}
                <div className="pt-4 border-t border-slate-800 space-y-2.5">
                  <h4 className="text-xs font-semibold text-slate-300">Add Child Branch</h4>
                  <input
                    type="text"
                    value={newChildTitle}
                    onChange={(e) => setNewChildTitle(e.target.value)}
                    placeholder="New subtopic or detail title"
                    className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500"
                  />
                  <input
                    type="text"
                    value={newChildDesc}
                    onChange={(e) => setNewChildDesc(e.target.value)}
                    placeholder="Short description or example (optional)"
                    className="w-full px-3 py-2 text-xs bg-[#0b1120] border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    disabled={!newChildTitle.trim()}
                    onClick={() => {
                      cloneAndMutate((m) =>
                        m.addChildNode(selectedNodeObj.id, newChildTitle.trim(), newChildDesc.trim())
                      );
                      setNewChildTitle('');
                      setNewChildDesc('');
                    }}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-lg transition-colors disabled:opacity-40"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Subtopic
                  </button>
                </div>

                {selectedNodeObj.level > 0 && (
                  <div className="pt-4 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => {
                        cloneAndMutate((m) => m.deleteNodeAndSubtree(selectedNodeObj.id));
                        setSelectedNodeId(null);
                      }}
                      className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Branch & Subtopics
                    </button>
                  </div>
                )}
              </aside>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-12 text-center space-y-3">
          {generating ? (
            <>
              <Loader2 className="w-9 h-9 text-indigo-400 animate-spin mx-auto" />
              <h3 className="font-display text-base font-semibold text-slate-100">
                Building your hierarchical mind map...
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Extracting central topic, main branches, subtopics, and supporting details from your selected note(s).
              </p>
            </>
          ) : (
            <>
              <GitBranch className="w-9 h-9 text-slate-600 mx-auto" />
              <h3 className="font-display text-base font-semibold text-slate-100">
                Select notes above to generate a hierarchical mind map
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                MindMesh analyzes the real concepts in your selected notes, maps central topics, main branches, subtopics, and details, lets you edit or rearrange nodes, and exports crisp PNG images.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
