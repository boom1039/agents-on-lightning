/**
 * Tournament Manager
 *
 * Structured competitions with brackets. Agents matched on identical
 * simulated conditions. Entry is free (zero-fee ethos). Champions get
 * permanent badges, strategy publication rights, and hall-of-fame placement.
 */

import { randomBytes } from 'node:crypto';
import { BracketGenerator } from './bracket.js';

const DEFAULT_TOURNAMENT_ID = 'tourn-a11ce001';

export class TournamentManager {
  constructor(dataLayer, registry) {
    this._dataLayer = dataLayer;
    this._registry = registry;
    this._bracket = new BracketGenerator();
    this._tournamentsPath = 'data/tournaments/tournaments.json';
    this._challengesPath = 'data/tournaments/challenges.json';
    this._famePath = 'data/tournaments/hall-of-fame.json';
  }

  async _load() {
    try {
      return await this._dataLayer.readJSON(this._tournamentsPath);
    } catch {
      return { active: [], completed: [] };
    }
  }

  async _save(data) {
    await this._dataLayer.writeJSON(this._tournamentsPath, data);
  }

  async _ensureDefaultTournament(data) {
    const active = Array.isArray(data?.active) ? data.active.map((tournament) => (
      tournament?.tournament_id === 'tourn-open'
        ? { ...tournament, tournament_id: DEFAULT_TOURNAMENT_ID }
        : tournament
    )) : [];
    const completed = Array.isArray(data?.completed) ? data.completed.map((tournament) => (
      tournament?.tournament_id === 'tourn-open'
        ? { ...tournament, tournament_id: DEFAULT_TOURNAMENT_ID }
        : tournament
    )) : [];
    const alreadyPresent = [...active, ...completed].some((tournament) => tournament?.tournament_id === DEFAULT_TOURNAMENT_ID);
    if (alreadyPresent) return { active, completed };

    const seeded = {
      active: [
        {
          tournament_id: DEFAULT_TOURNAMENT_ID,
          name: 'Open Builder Sprint',
          description: 'A standing live tournament so agents can inspect a real bracket and join it.',
          type: 'round-robin',
          max_participants: 16,
          participants: [],
          bracket: null,
          status: 'registration',
          created_at: Date.now(),
          starts_at: Date.now() + 7 * 24 * 3600_000,
          ended_at: null,
          winner: null,
          results: [],
        },
        ...active,
      ],
      completed,
    };
    await this._save(seeded);
    return seeded;
  }

  /**
   * Create a new tournament.
   */
  async create({ name, description, type = 'round-robin', max_participants = 16, starts_at }) {
    const tournament = {
      tournament_id: `tourn-${randomBytes(4).toString('hex')}`,
      name,
      description: description || '',
      type, // round-robin, single-elimination, challenge
      max_participants,
      participants: [],
      bracket: null,
      status: 'registration', // registration → active → completed
      created_at: Date.now(),
      starts_at: starts_at || Date.now() + 7 * 24 * 3600_000, // default: 1 week
      ended_at: null,
      winner: null,
      results: [],
    };

    const data = await this._load();
    data.active.push(tournament);
    await this._save(data);
    return tournament;
  }

  /**
   * Enter a tournament.
   */
  async enter(tournamentId, agentId) {
    const data = await this._ensureDefaultTournament(await this._load());
    const tournament = data.active.find(t => t.tournament_id === tournamentId);

    if (!tournament) throw new Error('Tournament not found');
    if (tournament.status !== 'registration') throw new Error('Tournament registration is closed');
    if (tournament.participants.includes(agentId)) throw new Error('Already registered');
    if (tournament.participants.length >= tournament.max_participants) throw new Error('Tournament is full');

    tournament.participants.push(agentId);
    await this._save(data);

    return {
      status: 'entered',
      tournament_id: tournamentId,
      position: tournament.participants.length,
      total_participants: tournament.participants.length,
      max_participants: tournament.max_participants,
    };
  }

  /**
   * Start a tournament (generate bracket).
   */
  async start(tournamentId) {
    const data = await this._load();
    const tournament = data.active.find(t => t.tournament_id === tournamentId);
    if (!tournament) throw new Error('Tournament not found');
    if (tournament.participants.length < 2) throw new Error('Need at least 2 participants');

    tournament.status = 'active';
    tournament.bracket = this._bracket.generate(
      tournament.participants,
      tournament.type
    );
    tournament.started_at = Date.now();

    await this._save(data);
    return tournament;
  }

  /**
   * Record a match result.
   */
  async recordResult(tournamentId, matchId, winnerId, scores) {
    const data = await this._load();
    const tournament = data.active.find(t => t.tournament_id === tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    tournament.results.push({
      match_id: matchId,
      winner: winnerId,
      scores,
      recorded_at: Date.now(),
    });

    // Update bracket
    if (tournament.bracket) {
      this._bracket.recordResult(tournament.bracket, matchId, winnerId);
    }

    await this._save(data);
    return { status: 'recorded', match_id: matchId, winner: winnerId };
  }

  /**
   * Complete a tournament and award badges.
   */
  async complete(tournamentId, winnerId) {
    const data = await this._load();
    const idx = data.active.findIndex(t => t.tournament_id === tournamentId);
    if (idx === -1) throw new Error('Tournament not found');

    const tournament = data.active[idx];
    tournament.status = 'completed';
    tournament.ended_at = Date.now();
    tournament.winner = winnerId;

    // Move to completed
    data.completed.push(tournament);
    data.active.splice(idx, 1);
    await this._save(data);

    // Award badge
    if (winnerId) {
      await this._registry.awardBadge(winnerId, 'sprint-champion');

      // Hall of fame
      let fame;
      try {
        fame = await this._dataLayer.readJSON(this._famePath);
      } catch {
        fame = { champions: [] };
      }
      fame.champions.push({
        agent_id: winnerId,
        tournament_id: tournamentId,
        tournament_name: tournament.name,
        won_at: Date.now(),
      });
      await this._dataLayer.writeJSON(this._famePath, fame);
    }

    return tournament;
  }

  /**
   * List tournaments.
   */
  async list() {
    const data = await this._ensureDefaultTournament(await this._load());
    return [
      ...data.active.map(t => ({ ...t, bracket: undefined })), // omit full bracket from list
      ...data.completed.slice(-10).map(t => ({ ...t, bracket: undefined })),
    ];
  }

  /**
   * Get bracket for a tournament.
   */
  async getBracket(tournamentId) {
    const data = await this._ensureDefaultTournament(await this._load());
    const tournament = data.active.find(t => t.tournament_id === tournamentId) ||
                       data.completed.find(t => t.tournament_id === tournamentId);
    if (!tournament) return null;
    return {
      tournament_id: tournamentId,
      name: tournament.name,
      status: tournament.status,
      participants: tournament.participants,
      bracket: tournament.bracket,
      results: tournament.results,
      winner: tournament.winner,
    };
  }

  // =========================================================================
  // CHALLENGES (standing challenges any agent can attempt)
  // =========================================================================

  async getChallenges() {
    try {
      const data = await this._dataLayer.readJSON(this._challengesPath);
      return data.challenges || [];
    } catch {
      // Return default challenges
      return [
        {
          challenge_id: 'cold-start-50',
          name: 'Cold Start to 50th Percentile',
          description: 'Optimize a node from cold start to 50th percentile ranking.',
          metric: 'Reach 50th percentile on leaderboard within 30 days of registration.',
          difficulty: 'medium',
          badge: 'cold-starter',
          status: 'active',
        },
        {
          challenge_id: 'efficient-earner',
          name: 'Efficient Earner',
          description: 'Achieve 10,000 sats/month fee revenue with less than 500,000 sats total capacity.',
          metric: '10,000 sats monthly fee revenue with <500K sats capacity.',
          difficulty: 'hard',
          badge: 'efficient-earner',
          status: 'active',
        },
        {
          challenge_id: 'bridge-builder',
          name: 'Bridge Builder',
          description: 'Open a channel that connects two nodes on different continents with no existing direct path.',
          metric: 'Channel confirmed between two nodes separated by >5000km with no prior direct channel.',
          difficulty: 'medium',
          badge: 'bridge-builder',
          status: 'active',
        },
        {
          challenge_id: 'whale-whisperer',
          name: 'Whale Whisperer',
          description: 'Successfully manage 1 BTC or more in total channel capacity.',
          metric: 'Total channel capacity >= 100,000,000 sats.',
          difficulty: 'hard',
          badge: 'whale-whisperer',
          status: 'active',
        },
        {
          challenge_id: 'perfect-balance',
          name: 'Perfect Balance',
          description: 'Maintain all channels within 40-60% local balance for 7 consecutive days.',
          metric: 'No channel below 40% or above 60% local balance for 168 hours.',
          difficulty: 'expert',
          badge: 'perfect-balance',
          status: 'active',
        },
      ];
    }
  }

  async getHallOfFame() {
    try {
      const data = await this._dataLayer.readJSON(this._famePath);
      return data.champions || [];
    } catch {
      return [];
    }
  }
}
