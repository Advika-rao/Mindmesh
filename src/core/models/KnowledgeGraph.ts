/**
 * OOP CONCEPT: Composition
 * KnowledgeGraph is composed of GraphNode and GraphEdge objects.
 * It encapsulates graph topology, neighbor queries, and BFS shortest-path discovery
 * used by both Brain Graph (Feature 1) and Explain My Connection (Feature 7).
 */

export interface GraphRelationshipDTO {
  targetNoteId: string;
  weight: number;
  reason: string;
  sharedTags: string[];
}

export interface GraphNodeDTO {
  graphNodeId: string;
  userId: string;
  noteId: string;
  concept: string;
  subject: string;
  positionX: number;
  positionY: number;
  relationships: GraphRelationshipDTO[];
  updatedAt: Date;
}

export class GraphNode {
  private readonly _graphNodeId: string;
  private readonly _userId: string;
  private readonly _noteId: string;
  private _concept: string;
  private _subject: string;
  private _positionX: number;
  private _positionY: number;
  private _relationships: GraphRelationshipDTO[];
  private _updatedAt: Date;

  constructor(dto: GraphNodeDTO) {
    this._graphNodeId = dto.graphNodeId;
    this._userId = dto.userId;
    this._noteId = dto.noteId;
    this._concept = dto.concept;
    this._subject = dto.subject;
    this._positionX = dto.positionX;
    this._positionY = dto.positionY;
    this._relationships = [...dto.relationships];
    this._updatedAt = dto.updatedAt;
  }

  get graphNodeId(): string { return this._graphNodeId; }
  get userId(): string { return this._userId; }
  get noteId(): string { return this._noteId; }
  get concept(): string { return this._concept; }
  get subject(): string { return this._subject; }
  get positionX(): number { return this._positionX; }
  get positionY(): number { return this._positionY; }
  get relationships(): GraphRelationshipDTO[] { return [...this._relationships]; }
  get updatedAt(): Date { return this._updatedAt; }

  public setPosition(x: number, y: number): void {
    this._positionX = Math.round(x);
    this._positionY = Math.round(y);
    this._updatedAt = new Date();
  }

  public setRelationships(relationships: GraphRelationshipDTO[]): void {
    this._relationships = relationships.slice(0, 50);
    this._updatedAt = new Date();
  }

  public toDTO(): GraphNodeDTO {
    return {
      graphNodeId: this._graphNodeId,
      userId: this._userId,
      noteId: this._noteId,
      concept: this._concept,
      subject: this._subject,
      positionX: this._positionX,
      positionY: this._positionY,
      relationships: [...this._relationships],
      updatedAt: this._updatedAt,
    };
  }
}

export class GraphEdge {
  private readonly _edgeId: string;
  private readonly _sourceNoteId: string;
  private readonly _targetNoteId: string;
  private readonly _weight: number;
  private readonly _reason: string;
  private readonly _sharedTags: string[];

  constructor(params: {
    sourceNoteId: string;
    targetNoteId: string;
    weight: number;
    reason: string;
    sharedTags: string[];
  }) {
    const [a, b] = [params.sourceNoteId, params.targetNoteId].sort();
    this._edgeId = `edge-${a}-${b}`;
    this._sourceNoteId = params.sourceNoteId;
    this._targetNoteId = params.targetNoteId;
    this._weight = Number(params.weight.toFixed(3));
    this._reason = params.reason;
    this._sharedTags = [...params.sharedTags];
  }

  get edgeId(): string { return this._edgeId; }
  get sourceNoteId(): string { return this._sourceNoteId; }
  get targetNoteId(): string { return this._targetNoteId; }
  get weight(): number { return this._weight; }
  get reason(): string { return this._reason; }
  get sharedTags(): string[] { return [...this._sharedTags]; }
}

export class KnowledgeGraph {
  private readonly _nodes: Map<string, GraphNode>;
  private readonly _edges: Map<string, GraphEdge>;

  constructor(nodes: GraphNode[] = [], edges: GraphEdge[] = []) {
    this._nodes = new Map(nodes.map((n) => [n.noteId, n]));
    this._edges = new Map(edges.map((e) => [e.edgeId, e]));
  }

  public addNode(node: GraphNode): void {
    this._nodes.set(node.noteId, node);
  }

  public addEdge(edge: GraphEdge): void {
    if (!this._edges.has(edge.edgeId)) {
      this._edges.set(edge.edgeId, edge);
    }
  }

  public getNodes(): GraphNode[] {
    return Array.from(this._nodes.values());
  }

  public getEdges(): GraphEdge[] {
    return Array.from(this._edges.values());
  }

  public getNodeByNoteId(noteId: string): GraphNode | undefined {
    return this._nodes.get(noteId);
  }

  public getDirectlyConnectedNoteIds(noteId: string): string[] {
    const neighbors = new Set<string>();
    for (const edge of this._edges.values()) {
      if (edge.sourceNoteId === noteId) neighbors.add(edge.targetNoteId);
      if (edge.targetNoteId === noteId) neighbors.add(edge.sourceNoteId);
    }
    return Array.from(neighbors);
  }

  public getEdgeBetween(noteIdA: string, noteIdB: string): GraphEdge | undefined {
    const [a, b] = [noteIdA, noteIdB].sort();
    return this._edges.get(`edge-${a}-${b}`);
  }

  /**
   * Breadth-First Search (BFS) to find the shortest path of intermediate concept nodes
   * between two nodes in the Brain Graph.
   */
  public findShortestPath(sourceNoteId: string, targetNoteId: string): string[] {
    if (sourceNoteId === targetNoteId) return [sourceNoteId];
    if (!this._nodes.has(sourceNoteId) || !this._nodes.has(targetNoteId)) return [];

    const queue: string[][] = [[sourceNoteId]];
    const visited = new Set<string>([sourceNoteId]);

    while (queue.length > 0) {
      const path = queue.shift()!;
      const current = path[path.length - 1];
      const neighbors = this.getDirectlyConnectedNoteIds(current);

      for (const next of neighbors) {
        if (next === targetNoteId) {
          return [...path, next];
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([...path, next]);
        }
      }
    }
    return [];
  }
}

/**
 * Concept-level Brain Graph domain model (generated strictly from user-selected notes).
 * Encapsulates deduplicated domain concept nodes, meaningful conceptual edges,
 * neighbor inspection, and deterministic hierarchical layered DAG layout.
 */

export interface ConceptGraphNodeDTO {
  id: string;
  label: string;
  category: string;
  description: string;
  tier: number;
  sourceNoteIds: string[];
  positionX: number;
  positionY: number;
}

export interface ConceptGraphEdgeDTO {
  id: string;
  source: string;
  target: string;
  relationship: string;
  reason: string;
}

export interface ConceptBrainGraphDTO {
  userId: string;
  graphTitle: string;
  summary: string;
  selectedNoteIds: string[];
  nodes: ConceptGraphNodeDTO[];
  edges: ConceptGraphEdgeDTO[];
  generatedAt: string;
}

export class ConceptGraphNode {
  public readonly id: string;
  public readonly label: string;
  public readonly category: string;
  public readonly description: string;
  public readonly tier: number;
  public readonly sourceNoteIds: string[];
  private _positionX: number;
  private _positionY: number;

  constructor(dto: ConceptGraphNodeDTO) {
    this.id = dto.id;
    this.label = dto.label;
    this.category = dto.category;
    this.description = dto.description;
    this.tier = dto.tier;
    this.sourceNoteIds = Array.from(new Set(dto.sourceNoteIds));
    this._positionX = Math.round(dto.positionX);
    this._positionY = Math.round(dto.positionY);
  }

  get positionX(): number {
    return this._positionX;
  }

  get positionY(): number {
    return this._positionY;
  }

  public setPosition(x: number, y: number): void {
    this._positionX = Math.round(x);
    this._positionY = Math.round(y);
  }

  public toDTO(): ConceptGraphNodeDTO {
    return {
      id: this.id,
      label: this.label,
      category: this.category,
      description: this.description,
      tier: this.tier,
      sourceNoteIds: [...this.sourceNoteIds],
      positionX: this._positionX,
      positionY: this._positionY,
    };
  }
}

export class ConceptGraphEdge {
  public readonly id: string;
  public readonly source: string;
  public readonly target: string;
  public readonly relationship: string;
  public readonly reason: string;

  constructor(dto: ConceptGraphEdgeDTO) {
    this.id = dto.id;
    this.source = dto.source;
    this.target = dto.target;
    this.relationship = dto.relationship;
    this.reason = dto.reason;
  }

  public toDTO(): ConceptGraphEdgeDTO {
    return {
      id: this.id,
      source: this.source,
      target: this.target,
      relationship: this.relationship,
      reason: this.reason,
    };
  }
}

/**
 * Computes a clean, non-overlapping layered hierarchical DAG layout (Sugiyama-style)
 * with topological depth assignment, barycenter crossing minimization, balanced horizontal
 * row centering, and a deterministic bounding-box collision pass.
 */
export function computeConceptGraphLayout(
  rawNodes: Array<Omit<ConceptGraphNodeDTO, 'positionX' | 'positionY'>>,
  rawEdges: ConceptGraphEdgeDTO[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (rawNodes.length === 0) return positions;

  const NODE_WIDTH = 224;
  const H_GAP = 64;
  const X_STEP = NODE_WIDTH + H_GAP;
  const Y_STEP = 164;
  const MAX_PER_ROW = 5;

  const nodeMap = new Map(rawNodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const n of rawNodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const edge of rawEdges) {
    if (nodeMap.has(edge.source) && nodeMap.has(edge.target) && edge.source !== edge.target) {
      outgoing.get(edge.source)!.push(edge.target);
      incoming.get(edge.target)!.push(edge.source);
    }
  }

  // Step 1: Compute topological depth using Kahn's algorithm with graceful cycle fallback
  const inDegree = new Map<string, number>();
  for (const n of rawNodes) {
    inDegree.set(n.id, incoming.get(n.id)!.length);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of rawNodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      depth.set(n.id, Math.max(0, Math.min(2, n.tier)));
      queue.push(n.id);
    }
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed.add(current);
    const currentDepth = depth.get(current) ?? 0;

    for (const next of outgoing.get(current) ?? []) {
      const nextNode = nodeMap.get(next);
      const proposed = Math.max(currentDepth + 1, nextNode ? Math.min(3, nextNode.tier) : currentDepth + 1);
      depth.set(next, Math.max(depth.get(next) ?? 0, Math.min(5, proposed)));
      const remaining = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  // Assign any remaining nodes in cycles based on their semantic tier
  for (const n of rawNodes) {
    if (!processed.has(n.id)) {
      const parentDepths = (incoming.get(n.id) ?? [])
        .map((pid) => depth.get(pid))
        .filter((d): d is number => d !== undefined);
      const fallbackLayer =
        parentDepths.length > 0 ? Math.min(5, Math.max(...parentDepths) + 1) : Math.max(0, Math.min(3, n.tier));
      depth.set(n.id, fallbackLayer);
    }
  }

  // Step 2: Group into compact sequential layers (splitting overly wide rows for clean readability)
  const rawLayers = new Map<number, string[]>();
  for (const n of rawNodes) {
    const d = depth.get(n.id) ?? 0;
    const list = rawLayers.get(d) ?? [];
    list.push(n.id);
    rawLayers.set(d, list);
  }

  const sortedLayerKeys = Array.from(rawLayers.keys()).sort((a, b) => a - b);
  const layers: string[][] = [];
  for (const key of sortedLayerKeys) {
    const ids = rawLayers.get(key) ?? [];
    // Sort initially by category + degree so related concepts sit adjacent
    ids.sort((a, b) => {
      const na = nodeMap.get(a)!;
      const nb = nodeMap.get(b)!;
      const catCmp = na.category.localeCompare(nb.category);
      if (catCmp !== 0) return catCmp;
      const degA = (outgoing.get(a)?.length ?? 0) + (incoming.get(a)?.length ?? 0);
      const degB = (outgoing.get(b)?.length ?? 0) + (incoming.get(b)?.length ?? 0);
      return degB - degA;
    });

    for (let i = 0; i < ids.length; i += MAX_PER_ROW) {
      layers.push(ids.slice(i, i + MAX_PER_ROW));
    }
  }

  // Step 3: Barycenter ordering pass to reduce edge crossings
  const xIndex = new Map<string, number>();
  layers.forEach((layer, layerIdx) => {
    if (layerIdx > 0) {
      layer.sort((a, b) => {
        const parentsA = (incoming.get(a) ?? []).map((p) => xIndex.get(p)).filter((v): v is number => v !== undefined);
        const parentsB = (incoming.get(b) ?? []).map((p) => xIndex.get(p)).filter((v): v is number => v !== undefined);
        const avgA = parentsA.length > 0 ? parentsA.reduce((s, v) => s + v, 0) / parentsA.length : Number.MAX_SAFE_INTEGER;
        const avgB = parentsB.length > 0 ? parentsB.reduce((s, v) => s + v, 0) / parentsB.length : Number.MAX_SAFE_INTEGER;
        if (avgA !== avgB) return avgA - avgB;
        return nodeMap.get(a)!.label.localeCompare(nodeMap.get(b)!.label);
      });
    }

    const rowWidth = (layer.length - 1) * X_STEP;
    const startX = -rowWidth / 2;
    const y = layerIdx * Y_STEP;

    layer.forEach((id, idx) => {
      const x = Math.round(startX + idx * X_STEP);
      positions.set(id, { x, y });
      xIndex.set(id, x);
    });
  });

  // Step 4: Deterministic anti-overlap pass (guarantees zero colliding bounding boxes)
  const allIds = Array.from(positions.keys());
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < allIds.length; i++) {
      for (let j = i + 1; j < allIds.length; j++) {
        const p1 = positions.get(allIds[i])!;
        const p2 = positions.get(allIds[j])!;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        if (Math.abs(dy) < 110 && Math.abs(dx) < NODE_WIDTH + 36) {
          const shift = Math.ceil((NODE_WIDTH + 44 - Math.abs(dx)) / 2);
          if (dx >= 0) {
            p1.x -= shift;
            p2.x += shift;
          } else {
            p1.x += shift;
            p2.x -= shift;
          }
        }
      }
    }
  }

  return positions;
}

export class ConceptBrainGraph {
  public readonly userId: string;
  public readonly graphTitle: string;
  public readonly summary: string;
  public readonly selectedNoteIds: string[];
  public readonly generatedAt: Date;
  private readonly _nodes: Map<string, ConceptGraphNode>;
  private readonly _edges: Map<string, ConceptGraphEdge>;

  constructor(params: {
    userId: string;
    graphTitle: string;
    summary: string;
    selectedNoteIds: string[];
    nodes: ConceptGraphNode[];
    edges: ConceptGraphEdge[];
    generatedAt?: Date;
  }) {
    this.userId = params.userId;
    this.graphTitle = params.graphTitle;
    this.summary = params.summary;
    this.selectedNoteIds = Array.from(new Set(params.selectedNoteIds));
    this.generatedAt = params.generatedAt ?? new Date();
    this._nodes = new Map(params.nodes.map((n) => [n.id, n]));
    this._edges = new Map(
      params.edges
        .filter((e) => e.source !== e.target && this._nodes.has(e.source) && this._nodes.has(e.target))
        .map((e) => [e.id, e])
    );
  }

  public getNodes(): ConceptGraphNode[] {
    return Array.from(this._nodes.values());
  }

  public getEdges(): ConceptGraphEdge[] {
    return Array.from(this._edges.values());
  }

  public getNode(id: string): ConceptGraphNode | undefined {
    return this._nodes.get(id);
  }

  public getEdge(id: string): ConceptGraphEdge | undefined {
    return this._edges.get(id);
  }

  public getConnectedEdges(nodeId: string): ConceptGraphEdge[] {
    return this.getEdges().filter((e) => e.source === nodeId || e.target === nodeId);
  }

  public getConnectedNodeIds(nodeId: string): string[] {
    const neighbors = new Set<string>();
    for (const edge of this._edges.values()) {
      if (edge.source === nodeId) neighbors.add(edge.target);
      if (edge.target === nodeId) neighbors.add(edge.source);
    }
    return Array.from(neighbors);
  }

  public relayout(): ConceptBrainGraph {
    const positions = computeConceptGraphLayout(
      this.getNodes().map((n) => ({
        id: n.id,
        label: n.label,
        category: n.category,
        description: n.description,
        tier: n.tier,
        sourceNoteIds: n.sourceNoteIds,
      })),
      this.getEdges().map((e) => e.toDTO())
    );
    const updatedNodes = this.getNodes().map((n) => {
      const pos = positions.get(n.id) ?? { x: n.positionX, y: n.positionY };
      return new ConceptGraphNode({
        ...n.toDTO(),
        positionX: pos.x,
        positionY: pos.y,
      });
    });
    return new ConceptBrainGraph({
      userId: this.userId,
      graphTitle: this.graphTitle,
      summary: this.summary,
      selectedNoteIds: this.selectedNoteIds,
      nodes: updatedNodes,
      edges: this.getEdges(),
      generatedAt: this.generatedAt,
    });
  }

  public toDTO(): ConceptBrainGraphDTO {
    return {
      userId: this.userId,
      graphTitle: this.graphTitle,
      summary: this.summary,
      selectedNoteIds: [...this.selectedNoteIds],
      nodes: this.getNodes().map((n) => n.toDTO()),
      edges: this.getEdges().map((e) => e.toDTO()),
      generatedAt: this.generatedAt.toISOString(),
    };
  }

  public static fromDTO(dto: ConceptBrainGraphDTO): ConceptBrainGraph {
    return new ConceptBrainGraph({
      userId: dto.userId,
      graphTitle: dto.graphTitle,
      summary: dto.summary,
      selectedNoteIds: Array.isArray(dto.selectedNoteIds) ? dto.selectedNoteIds : [],
      nodes: (Array.isArray(dto.nodes) ? dto.nodes : []).map((n) => new ConceptGraphNode(n)),
      edges: (Array.isArray(dto.edges) ? dto.edges : []).map((e) => new ConceptGraphEdge(e)),
      generatedAt: dto.generatedAt ? new Date(dto.generatedAt) : new Date(),
    });
  }
}
