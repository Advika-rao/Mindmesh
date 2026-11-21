import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeProps,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  Network,
  Search,
  Check,
  Sparkles,
  RefreshCw,
  Loader2,
  X,
  ExternalLink,
  Link2,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
  BookOpen,
  RotateCcw,
  Clock,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useKnowledge } from '../context/KnowledgeContext';
import { workspaceService } from '../core/services/KnowledgeWorkspaceService';
import {
  ConceptBrainGraph,
  ConceptGraphEdge,
  ConceptGraphNode,
} from '../core/models/KnowledgeGraph';
import type { BrainGraphSource } from '../core/services/BrainGraphService';
import type { ConceptConnectionExplanationPayload } from '../core/interfaces/CoreInterfaces';
import type { Note } from '../core/models/Note';
import { AIStatusBadge } from '../components/AIStatusBadge';

const CATEGORY_COLORS = [
  '#818cf8', // indigo
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#34d399', // emerald
  '#fbbf24', // amber
  '#22d3ee', // cyan
  '#f472b6', // rose
];

function getCategoryColor(category: string): string {
  let hash = 0;
  const input = (category || 'Concept').toLowerCase();
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

interface ConceptNodeFlowData extends Record<string, unknown> {
  label: string;
  category: string;
  accentColor: string;
  connectionCount: number;
  sourceNoteCount: number;
  isSelected: boolean;
  isNeighbor: boolean;
  isDimmed: boolean;
}

const ConceptFlowNode: React.FC<NodeProps<FlowNode<ConceptNodeFlowData>>> = ({ data }) => {
  const {
    label,
    category,
    accentColor,
    connectionCount,
    sourceNoteCount,
    isSelected,
    isNeighbor,
    isDimmed,
  } = data;

  return (
    <div
      className="rounded-xl transition-all duration-150 select-none"
      style={{
        width: 224,
        padding: '12px 14px',
        background: isSelected ? '#172038' : '#0f172a',
        border: isSelected
          ? `2px solid ${accentColor}`
          : `1px solid ${isNeighbor ? accentColor : '#1e293b'}`,
        opacity: isDimmed ? 0.24 : 1,
        boxShadow: isSelected
          ? `0 0 0 3px ${accentColor}22, 0 10px 24px rgba(2, 6, 23, 0.55)`
          : '0 4px 14px rgba(2, 6, 23, 0.45)',
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{
          width: 8,
          height: 8,
          background: accentColor,
          border: '2px solid #0b1120',
          opacity: isDimmed ? 0.2 : 0.9,
        }}
      />

      <div className="space-y-1.5 text-left">
        <p
          className="text-[10px] font-medium tracking-wide uppercase truncate"
          style={{ color: accentColor }}
        >
          {category}
        </p>
        <p className="text-[13px] font-semibold text-slate-50 leading-snug line-clamp-2">
          {label}
        </p>
        <p className="text-[10px] font-mono tabular-nums text-slate-400 pt-0.5">
          {connectionCount} link{connectionCount === 1 ? '' : 's'} · {sourceNoteCount} note
          {sourceNoteCount === 1 ? '' : 's'}
        </p>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          width: 8,
          height: 8,
          background: accentColor,
          border: '2px solid #0b1120',
          opacity: isDimmed ? 0.2 : 0.9,
        }}
      />
    </div>
  );
};

const NODE_TYPES = {
  concept: ConceptFlowNode,
};

interface ActiveConnectionTarget {
  sourceNode: ConceptGraphNode;
  targetNode: ConceptGraphNode;
  edge: ConceptGraphEdge | null;
}

interface ExplanationCacheEntry {
  loading: boolean;
  data: ConceptConnectionExplanationPayload | null;
  error: string | null;
  source?: BrainGraphSource;
  statusLabel?: string;
  isQuotaOrRateLimited?: boolean;
}

const FitViewOnGraphChange: React.FC<{ triggerKey: string }> = ({ triggerKey }) => {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!triggerKey) return;
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.18, duration: 280 });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [triggerKey, fitView]);
  return null;
};

const BrainGraphWorkspace: React.FC = () => {
  const { firebaseUser } = useAuth();
  const { notes, dataLoading, openNoteInEditor, setActivePage, notify, demoMode } = useKnowledge();

  // Note selection state
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [noteSearch, setNoteSearch] = useState('');
  const [selectorExpanded, setSelectorExpanded] = useState(true);
  const [initializedForUser, setInitializedForUser] = useState<string | null>(null);

  // Concept graph state
  const [conceptGraph, setConceptGraph] = useState<ConceptBrainGraph | null>(null);
  const [generating, setGenerating] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [graphStatus, setGraphStatus] = useState<{
    source: BrainGraphSource;
    label: string;
    isQuotaOrRateLimited?: boolean;
  } | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  // Node & Edge inspection state
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [activeConnection, setActiveConnection] = useState<ActiveConnectionTarget | null>(null);
  const [explanationCache, setExplanationCache] = useState<Record<string, ExplanationCacheEntry>>({});

  const inFlightRef = useRef(false);
  const genAbortRef = useRef<AbortController | null>(null);
  const explainAbortRef = useRef<AbortController | null>(null);

  const noteMap = useMemo(() => new Map<string, Note>(notes.map((n) => [n.noteId, n])), [notes]);
  const validNoteIds = useMemo(() => new Set(notes.map((n) => n.noteId)), [notes]);

  // Abort any in-flight AI requests on unmount
  useEffect(() => {
    return () => {
      genAbortRef.current?.abort();
      explainAbortRef.current?.abort();
      inFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  // Load cached concept graph scoped to the authenticated user (without auto-generating from all notes)
  useEffect(() => {
    if (!firebaseUser) {
      setConceptGraph(null);
      setSelectedNoteIds([]);
      setSelectedConceptId(null);
      setActiveConnection(null);
      setInitializedForUser(null);
      setSelectorExpanded(true);
      return;
    }

    if (dataLoading || initializedForUser === firebaseUser.uid) return;

    const cached = workspaceService.brainGraphService.loadCachedConceptGraph(
      firebaseUser.uid,
      validNoteIds
    );
    if (cached && cached.getNodes().length > 0) {
      setConceptGraph(cached);
      setSelectedNoteIds(cached.selectedNoteIds);
      setSelectorExpanded(false);
    } else {
      setConceptGraph(null);
      setSelectedNoteIds([]);
      setSelectorExpanded(true);
    }
    setInitializedForUser(firebaseUser.uid);
  }, [firebaseUser, dataLoading, initializedForUser, validNoteIds]);

  // Keep selectedNoteIds pruned if notes are deleted in another view
  useEffect(() => {
    if (dataLoading) return;
    setSelectedNoteIds((prev) => prev.filter((id) => validNoteIds.has(id)));
  }, [validNoteIds, dataLoading]);

  const filteredNotes = useMemo(() => {
    const q = noteSearch.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.subject.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)) ||
        n.content.toLowerCase().includes(q)
    );
  }, [notes, noteSearch]);

  const selectedNotes = useMemo(
    () => selectedNoteIds.map((id) => noteMap.get(id)).filter((n): n is Note => Boolean(n)),
    [selectedNoteIds, noteMap]
  );

  const selectionDiffersFromGraph = useMemo(() => {
    if (!conceptGraph) return false;
    const currentSet = new Set(selectedNoteIds);
    const graphSet = new Set(conceptGraph.selectedNoteIds);
    if (currentSet.size !== graphSet.size) return true;
    for (const id of currentSet) {
      if (!graphSet.has(id)) return true;
    }
    return false;
  }, [conceptGraph, selectedNoteIds]);

  const toggleNoteSelection = useCallback((noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  }, []);

  const handleSelectAllFiltered = useCallback(() => {
    const filteredIds = filteredNotes.map((n) => n.noteId);
    setSelectedNoteIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
  }, [filteredNotes]);

  const handleClearSelection = useCallback(() => {
    setSelectedNoteIds([]);
  }, []);

  const handleGenerateGraph = useCallback(async () => {
    if (!firebaseUser) return;
    if (inFlightRef.current || cooldownSeconds > 0) return;
    if (selectedNotes.length === 0) {
      notify('Select at least one saved note to generate your Brain Graph.', 'error');
      return;
    }

    inFlightRef.current = true;
    genAbortRef.current?.abort();
    const controller = new AbortController();
    genAbortRef.current = controller;

    setGenerating(true);
    setGenerationError(null);
    setSelectedConceptId(null);
    setActiveConnection(null);

    try {
      const result = await workspaceService.brainGraphService.generateConceptGraphWithStatus(
        { userId: firebaseUser.uid },
        { selectedNotes, demoMode, signal: controller.signal }
      );
      if (controller.signal.aborted) return;

      setConceptGraph(result.graph);
      setGraphStatus({
        source: result.source,
        label: result.statusLabel,
        isQuotaOrRateLimited: result.isQuotaOrRateLimited,
      });
      setExplanationCache({});
      setLayoutVersion((v) => v + 1);
      setSelectorExpanded(false);

      if (result.source === 'ai') {
        setCooldownSeconds(2);
      } else if (result.source === 'local_fallback' && result.isQuotaOrRateLimited) {
        setCooldownSeconds(Math.min(12, Math.max(4, result.retryAfterSeconds ?? 5)));
      }

      notify(
        `${result.statusLabel} — ${result.graph.getNodes().length} concepts and ${result.graph.getEdges().length} connections.`,
        result.source === 'local_fallback' ? 'info' : 'success'
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Unable to generate the Brain Graph right now. Please try again.';
      setGenerationError(message);
      notify(message, 'error');
    } finally {
      if (genAbortRef.current === controller) {
        genAbortRef.current = null;
        setGenerating(false);
      }
      inFlightRef.current = false;
    }
  }, [firebaseUser, cooldownSeconds, selectedNotes, demoMode, notify]);

  const handleCancelGeneration = useCallback(() => {
    genAbortRef.current?.abort();
    genAbortRef.current = null;
    inFlightRef.current = false;
    setGenerating(false);
    notify('Brain Graph generation cancelled.', 'info');
  }, [notify]);

  const handleRelayout = useCallback(() => {
    if (!conceptGraph || !firebaseUser) return;
    const relaid = conceptGraph.relayout();
    setConceptGraph(relaid);
    workspaceService.brainGraphService.saveCachedConceptGraph(firebaseUser.uid, relaid);
    setLayoutVersion((v) => v + 1);
  }, [conceptGraph, firebaseUser]);

  const getConnectionKey = useCallback(
    (sourceId: string, targetId: string) => {
      const graphStamp = conceptGraph?.generatedAt.toISOString() ?? 'none';
      return `${graphStamp}::${sourceId}-->${targetId}`;
    },
    [conceptGraph]
  );

  const requestConnectionExplanation = useCallback(
    async (target: ActiveConnectionTarget, forceRefresh = false) => {
      if (!firebaseUser || !conceptGraph) return;

      const key = getConnectionKey(target.sourceNode.id, target.targetNode.id);
      const existing = explanationCache[key];
      if (!forceRefresh && existing && (existing.data || existing.loading)) {
        return;
      }

      explainAbortRef.current?.abort();
      const controller = new AbortController();
      explainAbortRef.current = controller;

      setExplanationCache((prev) => ({
        ...prev,
        [key]: { loading: true, data: null, error: null },
      }));

      // Ground strictly in the notes used to generate the current Brain Graph
      const graphNotes = conceptGraph.selectedNoteIds
        .map((id) => noteMap.get(id))
        .filter((n): n is Note => Boolean(n));
      const contextNotes = graphNotes.length > 0 ? graphNotes : selectedNotes;

      try {
        const result = await workspaceService.brainGraphService.explainConceptEdgeWithStatus(
          { userId: firebaseUser.uid },
          {
            sourceConcept: target.sourceNode,
            targetConcept: target.targetNode,
            edge: target.edge,
            selectedNotes: contextNotes,
            demoMode,
            signal: controller.signal,
          }
        );
        if (controller.signal.aborted) return;
        setExplanationCache((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            data: result.explanation,
            error: null,
            source: result.source,
            statusLabel: result.statusLabel,
            isQuotaOrRateLimited: result.isQuotaOrRateLimited,
          },
        }));
      } catch (err) {
        if (controller.signal.aborted) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Unable to explain this connection right now. Please try again.';
        setExplanationCache((prev) => ({
          ...prev,
          [key]: { loading: false, data: null, error: message },
        }));
      } finally {
        if (explainAbortRef.current === controller) {
          explainAbortRef.current = null;
        }
      }
    },
    [firebaseUser, conceptGraph, explanationCache, getConnectionKey, noteMap, selectedNotes, demoMode]
  );

  const openConnectionPanel = useCallback(
    (sourceNode: ConceptGraphNode, targetNode: ConceptGraphNode, edge: ConceptGraphEdge | null) => {
      const target: ActiveConnectionTarget = { sourceNode, targetNode, edge };
      setActiveConnection(target);
      void requestConnectionExplanation(target, false);
    },
    [requestConnectionExplanation]
  );

  // Build React Flow nodes & edges with clean node/edge highlighting
  const computedFlow = useMemo(() => {
    if (!conceptGraph) {
      return { flowNodes: [] as FlowNode<ConceptNodeFlowData>[], flowEdges: [] as FlowEdge[] };
    }

    const activeEdgeId = activeConnection?.edge?.id ?? null;
    const focusedNodeIds = new Set<string>();
    const focusedEdgeIds = new Set<string>();

    if (activeConnection) {
      focusedNodeIds.add(activeConnection.sourceNode.id);
      focusedNodeIds.add(activeConnection.targetNode.id);
      if (activeEdgeId) focusedEdgeIds.add(activeEdgeId);
    } else if (selectedConceptId) {
      focusedNodeIds.add(selectedConceptId);
      for (const neighborId of conceptGraph.getConnectedNodeIds(selectedConceptId)) {
        focusedNodeIds.add(neighborId);
      }
      for (const edge of conceptGraph.getConnectedEdges(selectedConceptId)) {
        focusedEdgeIds.add(edge.id);
      }
    }

    const hasFocus = focusedNodeIds.size > 0;

    const flowNodes: FlowNode<ConceptNodeFlowData>[] = conceptGraph.getNodes().map((node) => {
      const accentColor = getCategoryColor(node.category);
      const isSelected = activeConnection
        ? node.id === activeConnection.sourceNode.id || node.id === activeConnection.targetNode.id
        : node.id === selectedConceptId;
      const isNeighbor = hasFocus && focusedNodeIds.has(node.id);
      const isDimmed = hasFocus && !isNeighbor;
      const connectionCount = conceptGraph.getConnectedEdges(node.id).length;

      return {
        id: node.id,
        type: 'concept',
        position: { x: node.positionX, y: node.positionY },
        data: {
          label: node.label,
          category: node.category,
          accentColor,
          connectionCount,
          sourceNoteCount: node.sourceNoteIds.length,
          isSelected,
          isNeighbor,
          isDimmed,
        },
      };
    });

    const flowEdges: FlowEdge[] = conceptGraph.getEdges().map((edge) => {
      const isHighlighted = hasFocus && focusedEdgeIds.has(edge.id);
      const isDimmed = hasFocus && !isHighlighted;
      const isActiveEdge = activeEdgeId === edge.id;

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: isHighlighted,
        interactionWidth: 26,
        label: edge.relationship,
        labelStyle: {
          fill: isActiveEdge ? '#e0e7ff' : isHighlighted ? '#c7d2fe' : '#94a3b8',
          fontSize: 10,
          fontWeight: isHighlighted ? 600 : 500,
        },
        labelBgStyle: {
          fill: isActiveEdge ? '#312e81' : '#0b1120',
          fillOpacity: isDimmed ? 0.35 : 0.94,
          stroke: isActiveEdge ? '#818cf8' : '#1e293b',
          strokeWidth: 1,
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: isActiveEdge ? '#a78bfa' : isHighlighted ? '#818cf8' : '#475569',
        },
        style: {
          stroke: isActiveEdge ? '#a78bfa' : isHighlighted ? '#818cf8' : '#334155',
          strokeWidth: isActiveEdge ? 2.6 : isHighlighted ? 2.2 : 1.5,
          opacity: isDimmed ? 0.16 : 0.92,
          cursor: 'pointer',
        },
      };
    });

    return { flowNodes, flowEdges };
  }, [conceptGraph, selectedConceptId, activeConnection]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<FlowNode<ConceptNodeFlowData>>(
    computedFlow.flowNodes
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<FlowEdge>(computedFlow.flowEdges);

  useEffect(() => {
    setRfNodes(computedFlow.flowNodes);
    setRfEdges(computedFlow.flowEdges);
  }, [computedFlow, setRfNodes, setRfEdges]);

  const handleNodeClick: NodeMouseHandler = useCallback((_evt, node) => {
    setActiveConnection(null);
    setSelectedConceptId(node.id);
  }, []);

  const handleEdgeClick: EdgeMouseHandler = useCallback(
    (_evt, edge) => {
      if (!conceptGraph) return;
      const conceptEdge = conceptGraph.getEdge(edge.id) ?? null;
      const sourceNode = conceptGraph.getNode(edge.source);
      const targetNode = conceptGraph.getNode(edge.target);
      if (!sourceNode || !targetNode) return;
      setSelectedConceptId(sourceNode.id);
      openConnectionPanel(sourceNode, targetNode, conceptEdge);
    },
    [conceptGraph, openConnectionPanel]
  );

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_evt, node) => {
      if (!conceptGraph || !firebaseUser) return;
      const targetNode = conceptGraph.getNode(node.id);
      if (!targetNode) return;
      targetNode.setPosition(node.position.x, node.position.y);
      workspaceService.brainGraphService.saveCachedConceptGraph(firebaseUser.uid, conceptGraph);
    },
    [conceptGraph, firebaseUser]
  );

  const selectedConceptNode =
    conceptGraph && selectedConceptId ? conceptGraph.getNode(selectedConceptId) ?? null : null;

  const selectedConceptConnections = useMemo(() => {
    if (!conceptGraph || !selectedConceptNode) return [];
    return conceptGraph
      .getConnectedEdges(selectedConceptNode.id)
      .map((edge) => {
        const isOutgoing = edge.source === selectedConceptNode.id;
        const otherId = isOutgoing ? edge.target : edge.source;
        const otherNode = conceptGraph.getNode(otherId);
        if (!otherNode) return null;
        return {
          edge,
          isOutgoing,
          otherNode,
          sourceNode: isOutgoing ? selectedConceptNode : otherNode,
          targetNode: isOutgoing ? otherNode : selectedConceptNode,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [conceptGraph, selectedConceptNode]);

  const activeExplanationKey = activeConnection
    ? getConnectionKey(activeConnection.sourceNode.id, activeConnection.targetNode.id)
    : null;
  const activeExplanationState: ExplanationCacheEntry | null = activeExplanationKey
    ? explanationCache[activeExplanationKey] ?? null
    : null;

  const hasSidePanel = Boolean(activeConnection || selectedConceptNode);
  const fitViewKey = conceptGraph
    ? `${conceptGraph.generatedAt.toISOString()}-${layoutVersion}`
    : '';

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      {/* Empty Workspace State (User has no saved notes at all) */}
      {!dataLoading && notes.length === 0 ? (
        <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-12 text-center space-y-4">
          <Network className="w-10 h-10 text-slate-600 mx-auto" />
          <div className="space-y-1.5 max-w-md mx-auto">
            <h3 className="font-display text-base font-semibold text-slate-100">
              No saved notes yet
            </h3>
            <p className="text-sm text-slate-400">
              Create or capture notes in My Notes first, then return here to select which notes you want to transform into a conceptual Brain Graph.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActivePage('notes')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap"
          >
            <BookOpen className="w-4 h-4" />
            Go to My Notes
          </button>
        </div>
      ) : (
        <>
          {/* Step 1: Saved Notes Selection Panel */}
          <section className="bg-[#0f172a] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="font-display text-base font-semibold text-slate-50">
                    {conceptGraph ? conceptGraph.graphTitle : 'Select Notes for Your Brain Graph'}
                  </h2>
                  <span className="text-xs font-mono tabular-nums text-indigo-300">
                    {selectedNoteIds.length} of {notes.length} selected
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {conceptGraph
                    ? conceptGraph.summary
                    : 'Choose one or more saved notes below. MindMesh will analyze their actual content to extract domain concepts and meaningful relationships.'}
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {conceptGraph && (
                  <button
                    type="button"
                    onClick={() => setSelectorExpanded((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#0b1120] hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    {selectorExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    {selectorExpanded ? 'Hide Note Picker' : `Change Notes (${selectedNoteIds.length})`}
                  </button>
                )}

                {conceptGraph && !generating && (
                  <button
                    type="button"
                    onClick={handleRelayout}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-[#0b1120] hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    Auto-Layout
                  </button>
                )}

                {generating ? (
                  <button
                    type="button"
                    onClick={handleCancelGeneration}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-rose-300 bg-rose-500/12 hover:bg-rose-500/20 border border-rose-500/30 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={selectedNoteIds.length === 0 || generating || cooldownSeconds > 0}
                    onClick={() => void handleGenerateGraph()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {cooldownSeconds > 0 ? (
                      <>
                        <Clock className="w-3.5 h-3.5" />
                        <span className="font-mono tabular-nums">Wait {cooldownSeconds}s</span>
                      </>
                    ) : (
                      <>
                        {conceptGraph ? (
                          <RefreshCw className="w-3.5 h-3.5" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        {conceptGraph
                          ? selectionDiffersFromGraph
                            ? 'Regenerate with Selection'
                            : 'Regenerate Graph'
                          : 'Generate Brain Graph'}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Expandable Saved Notes Selector Grid */}
            {selectorExpanded && (
              <div className="p-5 space-y-4 bg-[#0b1120]/55">
                {/* Search + Bulk Actions Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="relative flex-1 min-w-[220px] max-w-md">
                    <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={noteSearch}
                      onChange={(e) => setNoteSearch(e.target.value)}
                      placeholder="Search saved notes by title, subject, or content..."
                      className="w-full pl-9 pr-3 py-2 text-xs bg-[#080d1a] border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-3 text-xs">
                    <button
                      type="button"
                      onClick={handleSelectAllFiltered}
                      disabled={filteredNotes.length === 0}
                      className="font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-40 whitespace-nowrap"
                    >
                      Select All ({filteredNotes.length})
                    </button>
                    <span className="text-slate-700" aria-hidden="true">
                      ·
                    </span>
                    <button
                      type="button"
                      onClick={handleClearSelection}
                      disabled={selectedNoteIds.length === 0}
                      className="font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40 whitespace-nowrap"
                    >
                      Clear Selection
                    </button>
                  </div>
                </div>

                {/* Selected Notes Summary Line */}
                {selectedNotes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                    <span className="text-slate-300 font-medium">Selected:</span>
                    <span className="text-indigo-300">
                      {selectedNotes
                        .slice(0, 5)
                        .map((n) => n.title)
                        .join(' · ')}
                      {selectedNotes.length > 5 ? ` · +${selectedNotes.length - 5} more` : ''}
                    </span>
                  </div>
                )}

                {/* Selectable Saved Notes Grid */}
                {filteredNotes.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500">
                    No saved notes match "{noteSearch}".
                  </div>
                ) : (
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[300px] overflow-y-auto pr-1">
                    {filteredNotes.map((note) => {
                      const isChecked = selectedNoteIds.includes(note.noteId);
                      const wordCount = note.content.trim()
                        ? note.content.trim().split(/\s+/).length
                        : 0;

                      return (
                        <button
                          key={note.noteId}
                          type="button"
                          onClick={() => toggleNoteSelection(note.noteId)}
                          aria-pressed={isChecked}
                          className={`text-left p-3.5 rounded-xl border transition-colors flex items-start gap-3 ${
                            isChecked
                              ? 'bg-indigo-500/12 border-indigo-500/60'
                              : 'bg-[#0f172a] border-slate-800/80 hover:border-slate-700'
                          }`}
                        >
                          <span
                            className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 border transition-colors ${
                              isChecked
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-[#080d1a] border-slate-700 text-transparent'
                            }`}
                            aria-hidden="true"
                          >
                            <Check className="w-3 h-3" />
                          </span>

                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="text-xs font-semibold text-slate-100 truncate">
                              {note.title}
                            </p>
                            <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                              {note.getExcerpt(110)}
                            </p>
                            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono tabular-nums pt-0.5">
                              <span className="font-sans text-slate-400 truncate max-w-[120px]">
                                {note.subject}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{note.updatedAt.toLocaleDateString()}</span>
                              <span aria-hidden="true">·</span>
                              <span>{wordCount}w</span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {selectionDiffersFromGraph && !generating && (
                  <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/80 text-xs">
                    <span className="text-amber-300">
                      Your note selection changed. Regenerate to rebuild the graph from the newly selected notes.
                    </span>
                    <button
                      type="button"
                      disabled={selectedNoteIds.length === 0}
                      onClick={() => void handleGenerateGraph()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-45"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Regenerate Now
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Generation Error Banner (Never shows raw HTML/JSON; always offers Retry) */}
          {generationError && !generating && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-rose-200">
                    Brain Graph generation failed
                  </p>
                  <p className="text-xs text-rose-200/80">{generationError}</p>
                </div>
              </div>
              <button
                type="button"
                disabled={selectedNoteIds.length === 0}
                onClick={() => void handleGenerateGraph()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry
              </button>
            </div>
          )}

          {/* Step 2: Graph Viewport / Loading / Empty State + Side Inspector */}
          {generating ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-14 text-center space-y-4">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
              <div className="space-y-1.5 max-w-md mx-auto">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Extracting concepts & relationships...
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Analyzing the content of your {selectedNotes.length} selected note
                  {selectedNotes.length === 1 ? '' : 's'} to map meaningful domain concepts and conceptual connections.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCancelGeneration}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-300 bg-[#0b1120] hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors"
              >
                Cancel Generation
              </button>
            </div>
          ) : !conceptGraph ? (
            <div className="bg-[#0f172a] border border-slate-800/80 rounded-xl p-12 text-center space-y-3">
              <Network className="w-9 h-9 text-slate-600 mx-auto" />
              <div className="space-y-1 max-w-lg mx-auto">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  {selectedNoteIds.length === 0
                    ? 'Select notes above to build your Brain Graph'
                    : `Ready to map concepts from ${selectedNoteIds.length} selected note${selectedNoteIds.length === 1 ? '' : 's'}`}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Unlike a flat list of note titles, Brain Graph reads the actual content of your selected notes to extract core concepts, arrange them in a clean hierarchy, and explain how any two concepts connect.
                </p>
              </div>
              {selectedNoteIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleGenerateGraph()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Generate Brain Graph
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Compact Graph Status Strip */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-slate-400">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono tabular-nums">
                    {conceptGraph.getNodes().length} concepts · {conceptGraph.getEdges().length}{' '}
                    connections · generated from {conceptGraph.selectedNoteIds.length} note
                    {conceptGraph.selectedNoteIds.length === 1 ? '' : 's'}
                  </span>
                  {graphStatus ? (
                    <AIStatusBadge
                      source={graphStatus.source}
                      label={graphStatus.label}
                      isQuotaOrRateLimited={graphStatus.isQuotaOrRateLimited}
                      compact
                    />
                  ) : demoMode ? (
                    <AIStatusBadge
                      source="demo"
                      label="Demo Mode active"
                      compact
                    />
                  ) : null}
                </div>
                <span className="text-slate-500">
                  Click any concept node to inspect details · Click any connection line to explain how concepts relate
                </span>
              </div>

              <div className="grid lg:grid-cols-12 gap-4">
                {/* Interactive React Flow Canvas */}
                <div
                  className={`${
                    hasSidePanel ? 'lg:col-span-8' : 'lg:col-span-12'
                  } h-[600px] bg-[#070b16] border border-slate-800/80 rounded-xl overflow-hidden relative`}
                >
                  <ReactFlow
                    nodes={rfNodes}
                    edges={rfEdges}
                    nodeTypes={NODE_TYPES}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={handleNodeClick}
                    onEdgeClick={handleEdgeClick}
                    onNodeDragStop={handleNodeDragStop}
                    onPaneClick={() => {
                      setSelectedConceptId(null);
                      setActiveConnection(null);
                    }}
                    fitView
                    fitViewOptions={{ padding: 0.18 }}
                    minZoom={0.25}
                    maxZoom={1.8}
                  >
                    <FitViewOnGraphChange triggerKey={fitViewKey} />
                    <Background color="#1e293b" gap={24} size={1} />
                    <Controls />
                    <MiniMap
                      nodeColor={(n) => {
                        const d = n.data as ConceptNodeFlowData | undefined;
                        return d?.accentColor || '#6366f1';
                      }}
                      maskColor="rgba(8, 13, 26, 0.75)"
                    />
                  </ReactFlow>
                </div>

                {/* Right Inspector: Connection Explanation Panel OR Concept Details Side Panel */}
                {activeConnection ? (
                  <aside className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 flex flex-col gap-4 max-h-[600px] overflow-y-auto">
                    <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-800/80">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {selectedConceptNode && (
                            <button
                              type="button"
                              onClick={() => setActiveConnection(null)}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
                            >
                              <ArrowLeft className="w-3 h-3" />
                              Concept Details
                            </button>
                          )}
                          {!selectedConceptNode && (
                            <span className="text-[11px] font-medium text-violet-400">
                              Connection Explanation
                            </span>
                          )}
                        </div>
                        <h3 className="font-display text-sm font-semibold text-slate-50 leading-snug">
                          {activeConnection.sourceNode.label}{' '}
                          <span className="text-indigo-400">→</span>{' '}
                          {activeConnection.targetNode.label}
                        </h3>
                        {activeConnection.edge && (
                          <p className="text-xs text-slate-400">
                            Relationship:{' '}
                            <span className="text-slate-200 font-medium">
                              {activeConnection.edge.relationship}
                            </span>
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveConnection(null)}
                        className="p-1 text-slate-400 hover:text-slate-100 shrink-0"
                        aria-label="Close connection explanation"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {activeExplanationState?.loading ? (
                      <div className="py-12 text-center space-y-3">
                        <Loader2 className="w-6 h-6 animate-spin text-indigo-400 mx-auto" />
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Analyzing how{' '}
                          <span className="text-slate-200 font-medium">
                            {activeConnection.sourceNode.label}
                          </span>{' '}
                          connects to{' '}
                          <span className="text-slate-200 font-medium">
                            {activeConnection.targetNode.label}
                          </span>{' '}
                          in your selected notes...
                        </p>
                      </div>
                    ) : activeExplanationState?.error ? (
                      <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-3">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <p className="text-xs font-semibold text-rose-200">
                              Could not load connection explanation
                            </p>
                            <p className="text-xs text-rose-200/80 leading-relaxed">
                              {activeExplanationState.error}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void requestConnectionExplanation(activeConnection, true)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Retry
                        </button>
                      </div>
                    ) : activeExplanationState?.data ? (
                      <div className="space-y-4">
                        {activeExplanationState.source && activeExplanationState.statusLabel && (
                          <AIStatusBadge
                            source={activeExplanationState.source}
                            label={activeExplanationState.statusLabel}
                            isQuotaOrRateLimited={activeExplanationState.isQuotaOrRateLimited}
                            compact
                          />
                        )}
                        <p className="text-xs text-indigo-200 leading-relaxed font-medium">
                          {activeExplanationState.data.summary}
                        </p>

                        {activeExplanationState.data.whyConnected && (
                          <div className="space-y-1">
                            <h4 className="text-xs font-semibold text-slate-200">
                              Why They Are Connected
                            </h4>
                            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                              {activeExplanationState.data.whyConnected}
                            </p>
                          </div>
                        )}

                        {activeExplanationState.data.howTheyRelate && (
                          <div className="space-y-1">
                            <h4 className="text-xs font-semibold text-slate-200">
                              How {activeConnection.sourceNode.label} Relates to{' '}
                              {activeConnection.targetNode.label}
                            </h4>
                            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                              {activeExplanationState.data.howTheyRelate}
                            </p>
                          </div>
                        )}

                        {activeExplanationState.data.examples.length > 0 && (
                          <div className="space-y-1.5 pt-3 border-t border-slate-800/80">
                            <h4 className="text-xs font-semibold text-slate-200">
                              Practical Example{activeExplanationState.data.examples.length > 1 ? 's' : ''}
                            </h4>
                            <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                              {activeExplanationState.data.examples.map((ex, i) => (
                                <li key={i} className="leading-relaxed">
                                  {ex}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {activeExplanationState.data.intermediateConcepts.length > 0 && (
                          <div className="space-y-1 pt-3 border-t border-slate-800/80">
                            <h4 className="text-xs font-semibold text-slate-200">
                              Related Bridging Concepts
                            </h4>
                            <p className="text-xs text-indigo-300">
                              {activeExplanationState.data.intermediateConcepts.join(' · ')}
                            </p>
                          </div>
                        )}

                        {activeExplanationState.data.citedNoteIds.length > 0 && (
                          <div className="space-y-2 pt-3 border-t border-slate-800/80">
                            <h4 className="text-xs font-semibold text-slate-200">
                              Grounded in Your Notes
                            </h4>
                            <div className="space-y-1.5">
                              {activeExplanationState.data.citedNoteIds.map((nid) => {
                                const sourceNote = noteMap.get(nid);
                                if (!sourceNote) return null;
                                return (
                                  <button
                                    key={nid}
                                    type="button"
                                    onClick={() => openNoteInEditor(nid)}
                                    className="w-full text-left px-3 py-2 rounded-lg bg-[#0b1120] hover:bg-slate-800/80 border border-slate-800 flex items-center justify-between gap-2 transition-colors"
                                  >
                                    <span className="text-xs text-slate-200 font-medium truncate">
                                      {sourceNote.title}
                                    </span>
                                    <ExternalLink className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {activeExplanationState.data.connectionStrengthNote && (
                          <p className="text-[11px] text-slate-500 pt-1">
                            {activeExplanationState.data.connectionStrengthNote}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </aside>
                ) : selectedConceptNode ? (
                  <aside className="lg:col-span-4 bg-[#0f172a] border border-slate-800/80 rounded-xl p-5 flex flex-col gap-5 max-h-[600px] overflow-y-auto">
                    {/* Concept Header */}
                    <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-800/80">
                      <div className="min-w-0 space-y-1">
                        <p
                          className="text-[11px] font-medium uppercase tracking-wide"
                          style={{ color: getCategoryColor(selectedConceptNode.category) }}
                        >
                          {selectedConceptNode.category}
                        </p>
                        <h3 className="font-display text-lg font-semibold text-slate-50 leading-snug">
                          {selectedConceptNode.label}
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedConceptId(null)}
                        className="p-1 text-slate-400 hover:text-slate-100 shrink-0"
                        aria-label="Close concept details"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Concept Explanation */}
                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold text-slate-300">Concept Overview</h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {selectedConceptNode.description}
                      </p>
                    </div>

                    {/* Source Notes */}
                    <div className="space-y-2 pt-3 border-t border-slate-800/80">
                      <h4 className="text-xs font-semibold text-slate-300">
                        From Your Saved Notes ({selectedConceptNode.sourceNoteIds.length})
                      </h4>
                      <div className="space-y-2">
                        {selectedConceptNode.sourceNoteIds.map((nid) => {
                          const srcNote = noteMap.get(nid);
                          if (!srcNote) return null;
                          return (
                            <div
                              key={nid}
                              className="p-3 rounded-lg bg-[#0b1120] border border-slate-800 flex items-center justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-slate-100 truncate">
                                  {srcNote.title}
                                </p>
                                <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                                  {srcNote.subject} · {srcNote.updatedAt.toLocaleDateString()}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => openNoteInEditor(srcNote.noteId)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-md transition-colors whitespace-nowrap shrink-0"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Open Note
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Connected Concepts List */}
                    <div className="space-y-2.5 pt-3 border-t border-slate-800/80">
                      <h4 className="text-xs font-semibold text-slate-300">
                        Connected Concepts ({selectedConceptConnections.length})
                      </h4>
                      {selectedConceptConnections.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          This concept has no direct connections in the current graph.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {selectedConceptConnections.map(
                            ({ edge, isOutgoing, otherNode, sourceNode, targetNode }) => (
                              <div
                                key={edge.id}
                                className="p-3 rounded-lg bg-[#0b1120] border border-slate-800 space-y-2"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedConceptId(otherNode.id)}
                                    className="text-xs font-semibold text-slate-100 hover:text-indigo-300 text-left leading-snug"
                                  >
                                    {otherNode.label}
                                  </button>
                                  <span className="text-[10px] font-medium text-indigo-300 shrink-0 inline-flex items-center gap-1">
                                    {isOutgoing ? (
                                      <>
                                        <span>{edge.relationship}</span>
                                        <ArrowRight className="w-3 h-3" />
                                      </>
                                    ) : (
                                      <>
                                        <ArrowLeft className="w-3 h-3" />
                                        <span>{edge.relationship}</span>
                                      </>
                                    )}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-400 leading-relaxed">
                                  {edge.reason}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => openConnectionPanel(sourceNode, targetNode, edge)}
                                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-400 hover:text-violet-300 transition-colors"
                                >
                                  <Link2 className="w-3 h-3" />
                                  Explain Connection
                                </button>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </aside>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export const BrainGraphPage: React.FC = () => (
  <ReactFlowProvider>
    <BrainGraphWorkspace />
  </ReactFlowProvider>
);
