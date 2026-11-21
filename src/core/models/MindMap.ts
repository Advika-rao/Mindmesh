import { ValidationException } from '../exceptions/MindMeshExceptions';

/**
 * OOP CONCEPT: Composition
 * MindMap owns a hierarchical collection of MindMapNode and MindMapConnection objects,
 * encapsulating node editing, branch addition/deletion, reparenting, and layout geometry.
 */

export interface MindMapNodeDTO {
  id: string;
  title: string;
  description: string;
  level: number;
  parentId: string;
  x: number;
  y: number;
}

export interface MindMapConnectionDTO {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface MindMapDTO {
  mindMapId: string;
  userId: string;
  title: string;
  nodes: MindMapNodeDTO[];
  connections: MindMapConnectionDTO[];
  sourceNoteIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export class MindMapNode {
  private readonly _id: string;
  private _title: string;
  private _description: string;
  private _level: number;
  private _parentId: string;
  private _x: number;
  private _y: number;

  constructor(dto: MindMapNodeDTO) {
    this._id = dto.id;
    this._title = (dto.title || 'Untitled Concept').trim().slice(0, 100);
    this._description = (dto.description || '').trim().slice(0, 500);
    this._level = Math.max(0, Math.min(4, Math.floor(dto.level || 0)));
    this._parentId = dto.parentId || '';
    this._x = Number.isFinite(dto.x) ? dto.x : 0;
    this._y = Number.isFinite(dto.y) ? dto.y : 0;
  }

  get id(): string { return this._id; }
  get title(): string { return this._title; }
  get description(): string { return this._description; }
  get level(): number { return this._level; }
  get parentId(): string { return this._parentId; }
  get x(): number { return this._x; }
  get y(): number { return this._y; }

  public updateDetails(title: string, description: string): void {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new ValidationException('Node title cannot be empty.', 'title');
    this._title = cleanTitle.slice(0, 100);
    this._description = description.trim().slice(0, 500);
  }

  public setPosition(x: number, y: number): void {
    this._x = Math.round(x);
    this._y = Math.round(y);
  }

  public setParent(parentId: string, newLevel: number): void {
    this._parentId = parentId;
    this._level = newLevel;
  }

  public toDTO(): MindMapNodeDTO {
    return {
      id: this._id,
      title: this._title,
      description: this._description,
      level: this._level,
      parentId: this._parentId,
      x: this._x,
      y: this._y,
    };
  }
}

export class MindMap {
  private readonly _mindMapId: string;
  private readonly _userId: string;
  private _title: string;
  private _nodes: MindMapNode[];
  private _connections: MindMapConnectionDTO[];
  private readonly _sourceNoteIds: string[];
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  constructor(dto: MindMapDTO) {
    this._mindMapId = dto.mindMapId;
    this._userId = dto.userId;
    this._title = (dto.title || 'Untitled Mind Map').trim().slice(0, 200);
    this._nodes = (dto.nodes || []).map((n) => new MindMapNode(n));
    this._connections = [...(dto.connections || [])];
    this._sourceNoteIds = [...(dto.sourceNoteIds || [])].slice(0, 25);
    this._createdAt = dto.createdAt;
    this._updatedAt = dto.updatedAt;
  }

  get mindMapId(): string { return this._mindMapId; }
  get userId(): string { return this._userId; }
  get title(): string { return this._title; }
  get nodes(): MindMapNode[] { return [...this._nodes]; }
  get connections(): MindMapConnectionDTO[] { return [...this._connections]; }
  get sourceNoteIds(): string[] { return [...this._sourceNoteIds]; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }

  public rename(newTitle: string): void {
    const clean = newTitle.trim();
    if (!clean) throw new ValidationException('Mind map title cannot be empty.', 'title');
    this._title = clean.slice(0, 200);
    this._updatedAt = new Date();
  }

  public addChildNode(parentId: string, title: string, description: string): MindMapNode {
    const parent = this._nodes.find((n) => n.id === parentId);
    if (!parent) {
      throw new ValidationException('Parent branch node does not exist.', 'parentId');
    }
    if (this._nodes.length >= 100) {
      throw new ValidationException('Maximum of 100 nodes per mind map reached.', 'nodes');
    }

    const siblings = this._nodes.filter((n) => n.parentId === parentId);
    const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newNode = new MindMapNode({
      id,
      title,
      description,
      level: Math.min(parent.level + 1, 4),
      parentId,
      x: parent.x + 280,
      y: parent.y + (siblings.length - 0.5) * 110,
    });
    this._nodes.push(newNode);
    this._connections.push({
      id: `conn-${parentId}-${id}`,
      source: parentId,
      target: id,
      label: '',
    });
    this._updatedAt = new Date();
    return newNode;
  }

  public updateNode(nodeId: string, title: string, description: string): void {
    const node = this._nodes.find((n) => n.id === nodeId);
    if (!node) throw new ValidationException('Node not found.', 'nodeId');
    node.updateDetails(title, description);
    this._updatedAt = new Date();
  }

  public moveNode(nodeId: string, x: number, y: number): void {
    const node = this._nodes.find((n) => n.id === nodeId);
    if (node) {
      node.setPosition(x, y);
      this._updatedAt = new Date();
    }
  }

  public reparentNode(nodeId: string, newParentId: string): void {
    const node = this._nodes.find((n) => n.id === nodeId);
    const newParent = this._nodes.find((n) => n.id === newParentId);
    if (!node || !newParent || node.level === 0 || nodeId === newParentId) return;

    // Prevent cycles by verifying newParent is not a descendant of node
    let cursor: MindMapNode | undefined = newParent;
    while (cursor) {
      if (cursor.id === nodeId) return;
      cursor = this._nodes.find((n) => n.id === cursor?.parentId);
    }

    node.setParent(newParentId, Math.min(newParent.level + 1, 4));
    this._connections = this._connections.filter((c) => c.target !== nodeId);
    this._connections.push({
      id: `conn-${newParentId}-${nodeId}`,
      source: newParentId,
      target: nodeId,
      label: '',
    });
    this._updatedAt = new Date();
  }

  public deleteNodeAndSubtree(nodeId: string): void {
    const target = this._nodes.find((n) => n.id === nodeId);
    if (!target || target.level === 0) {
      throw new ValidationException('Cannot delete the central root topic.', 'nodeId');
    }

    const toDelete = new Set<string>([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of this._nodes) {
        if (n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
          toDelete.add(n.id);
          changed = true;
        }
      }
    }

    this._nodes = this._nodes.filter((n) => !toDelete.has(n.id));
    this._connections = this._connections.filter((c) => !toDelete.has(c.source) && !toDelete.has(c.target));
    this._updatedAt = new Date();
  }

  /**
   * Computes a balanced radial-hierarchical tree layout supporting all 4 levels
   * (Central Topic -> Main Branches -> Subtopics -> Supporting Details/Examples)
   * with recursive subtree heights so sibling branches never overlap.
   */
  public static applyHierarchicalLayout(
    rawNodes: Array<{ id: string; title: string; description: string; level: number; parentId: string }>
  ): MindMapNodeDTO[] {
    if (rawNodes.length === 0) return [];
    const byId = new Map(rawNodes.map((n) => [n.id, n]));
    const root = rawNodes.find((n) => n.level === 0 || !n.parentId) ?? rawNodes[0];

    const childrenMap = new Map<string, typeof rawNodes>();
    for (const n of rawNodes) {
      if (n.id === root.id) continue;
      const pid = n.parentId && byId.has(n.parentId) && n.parentId !== n.id ? n.parentId : root.id;
      const list = childrenMap.get(pid) ?? [];
      list.push(n);
      childrenMap.set(pid, list);
    }

    const levelSpacingX = [0, 320, 640, 950, 1240];
    const leafUnitHeight = 112;
    const branchGap = 36;

    // Recursively compute vertical height needed by each subtree (cycle-safe)
    const heightCache = new Map<string, number>();
    const computeSubtreeHeight = (nodeId: string, visited: Set<string>): number => {
      if (heightCache.has(nodeId)) return heightCache.get(nodeId)!;
      if (visited.has(nodeId)) return leafUnitHeight;
      visited.add(nodeId);

      const children = childrenMap.get(nodeId) ?? [];
      if (children.length === 0) {
        heightCache.set(nodeId, leafUnitHeight);
        return leafUnitHeight;
      }

      const sumChildren = children.reduce(
        (acc, child) => acc + computeSubtreeHeight(child.id, visited),
        0
      );
      const total = Math.max(leafUnitHeight, sumChildren + Math.max(0, children.length - 1) * 18);
      heightCache.set(nodeId, total);
      return total;
    };

    const positioned: MindMapNodeDTO[] = [
      {
        ...root,
        level: 0,
        parentId: '',
        x: 0,
        y: 0,
      },
    ];
    const placedIds = new Set<string>([root.id]);

    const placeSubtree = (
      node: (typeof rawNodes)[number],
      parentId: string,
      depth: number,
      direction: 1 | -1,
      topY: number,
      allocatedHeight: number
    ): void => {
      if (placedIds.has(node.id)) return;
      placedIds.add(node.id);

      const clampedDepth = Math.min(4, Math.max(1, depth));
      const x = direction * (levelSpacingX[clampedDepth] ?? clampedDepth * 310);
      const centerY = Math.round(topY + allocatedHeight / 2);

      positioned.push({
        ...node,
        level: clampedDepth,
        parentId,
        x,
        y: centerY,
      });

      const children = (childrenMap.get(node.id) ?? []).filter((c) => !placedIds.has(c.id));
      if (children.length === 0) return;

      const childHeights = children.map((c) => computeSubtreeHeight(c.id, new Set(placedIds)));
      const totalChildrenHeight =
        childHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, children.length - 1) * 18;
      let cursorY = centerY - totalChildrenHeight / 2;

      children.forEach((child, idx) => {
        const h = childHeights[idx];
        placeSubtree(child, node.id, clampedDepth + 1, direction, cursorY, h);
        cursorY += h + 18;
      });
    };

    const mainBranches = childrenMap.get(root.id) ?? [];
    const half = Math.ceil(mainBranches.length / 2);

    const placeSide = (branches: typeof rawNodes, direction: 1 | -1): void => {
      if (branches.length === 0) return;
      const heights = branches.map((b) => computeSubtreeHeight(b.id, new Set([root.id])));
      const totalHeight =
        heights.reduce((sum, h) => sum + h, 0) + Math.max(0, branches.length - 1) * branchGap;
      let cursorY = -totalHeight / 2;

      branches.forEach((branch, idx) => {
        const h = heights[idx];
        placeSubtree(branch, root.id, 1, direction, cursorY, h);
        cursorY += h + branchGap;
      });
    };

    placeSide(mainBranches.slice(0, half), 1);
    placeSide(mainBranches.slice(half), -1);

    // Handle any remaining disconnected nodes safely
    rawNodes.forEach((n, idx) => {
      if (!placedIds.has(n.id)) {
        placedIds.add(n.id);
        positioned.push({
          ...n,
          level: Math.min(4, Math.max(1, n.level || 1)),
          parentId: root.id,
          x: 320,
          y: 420 + idx * 110,
        });
      }
    });

    return positioned;
  }

  public toDTO(): MindMapDTO {
    return {
      mindMapId: this._mindMapId,
      userId: this._userId,
      title: this._title,
      nodes: this._nodes.map((n) => n.toDTO()),
      connections: [...this._connections],
      sourceNoteIds: [...this._sourceNoteIds],
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
