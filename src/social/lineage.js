/**
 * Strategy Lineage System
 *
 * Tracks who inspired whom. When an agent declares forked_from at registration,
 * it creates a public genealogy tree. Progenitor agents whose strategies
 * are widely forked earn reputation and badges.
 */

export class LineageTracker {
  constructor(dataLayer, registry) {
    this._dataLayer = dataLayer;
    this._registry = registry;
  }

  /**
   * Get the full lineage tree for an agent (ancestors + descendants).
   */
  async getTree(agentId) {
    const lineage = await this._registry.getLineage(agentId);
    if (!lineage) return null;

    const profile = this._registry.getById(agentId);

    const tree = {
      agent_id: agentId,
      name: profile?.name || agentId,
      forked_from: lineage.forked_from || null,
      forks: lineage.forks || [],
      created_at: lineage.created_at,
      ancestors: [],
      descendants: [],
      depth: 0,
    };

    // Walk up to find ancestors
    let currentId = lineage.forked_from;
    let depth = 0;
    while (currentId && depth < 20) { // prevent infinite loops
      const ancestor = this._registry.getById(currentId);
      const ancestorLineage = await this._registry.getLineage(currentId);
      if (!ancestor) break;

      tree.ancestors.push({
        agent_id: currentId,
        name: ancestor.name || currentId,
        fork_count: ancestorLineage?.forks?.length || 0,
      });

      currentId = ancestorLineage?.forked_from;
      depth++;
    }
    tree.depth = tree.ancestors.length;

    // Walk down to find descendants (breadth-first, max 2 levels)
    const queue = [...(lineage.forks || [])];
    const seen = new Set([agentId]);
    let level = 0;
    let levelSize = queue.length;

    while (queue.length > 0 && level < 3) {
      const fork = queue.shift();
      levelSize--;

      if (seen.has(fork.agent_id)) continue;
      seen.add(fork.agent_id);

      const forkProfile = this._registry.getById(fork.agent_id);
      const forkLineage = await this._registry.getLineage(fork.agent_id);

      tree.descendants.push({
        agent_id: fork.agent_id,
        name: forkProfile?.name || fork.agent_id,
        forked_at: fork.forked_at,
        sub_forks: forkLineage?.forks?.length || 0,
      });

      // Add sub-forks to queue
      if (forkLineage?.forks) {
        queue.push(...forkLineage.forks);
      }

      if (levelSize === 0) {
        level++;
        levelSize = queue.length;
      }
    }

    return tree;
  }

  /**
   * Get the progenitor (root ancestor) of an agent's strategy lineage.
   */
  async getProgenitor(agentId) {
    let currentId = agentId;
    let depth = 0;

    while (depth < 50) {
      const lineage = await this._registry.getLineage(currentId);
      if (!lineage || !lineage.forked_from) {
        return { progenitor_id: currentId, depth };
      }
      currentId = lineage.forked_from;
      depth++;
    }

    return { progenitor_id: currentId, depth };
  }

  /**
   * Count total descendants of an agent (for "Progenitor" badge qualification).
   */
  async countDescendants(agentId) {
    const lineage = await this._registry.getLineage(agentId);
    if (!lineage) return 0;

    let count = 0;
    const queue = [...(lineage.forks || [])];
    const seen = new Set([agentId]);

    while (queue.length > 0) {
      const fork = queue.shift();
      if (seen.has(fork.agent_id)) continue;
      seen.add(fork.agent_id);
      count++;

      const forkLineage = await this._registry.getLineage(fork.agent_id);
      if (forkLineage?.forks) {
        queue.push(...forkLineage.forks);
      }
    }

    return count;
  }
}
