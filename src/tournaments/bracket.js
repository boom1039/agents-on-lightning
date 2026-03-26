/**
 * Bracket Generator for Tournaments
 *
 * Generates single-elimination or round-robin brackets from a list of participants.
 */

export class BracketGenerator {
  /**
   * Generate a bracket.
   * @param {string[]} participants - Array of agent IDs
   * @param {string} type - 'single-elimination' or 'round-robin'
   */
  generate(participants, type = 'round-robin') {
    if (type === 'single-elimination') {
      return this._singleElimination(participants);
    }
    return this._roundRobin(participants);
  }

  /**
   * Record a match result in the bracket.
   */
  recordResult(bracket, matchId, winnerId) {
    for (const round of bracket.rounds) {
      for (const match of round.matches) {
        if (match.match_id === matchId) {
          match.winner = winnerId;
          match.status = 'completed';
          return true;
        }
      }
    }
    return false;
  }

  _roundRobin(participants) {
    const matches = [];
    let matchNum = 0;

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        matchNum++;
        matches.push({
          match_id: `match-${matchNum}`,
          player_a: participants[i],
          player_b: participants[j],
          winner: null,
          scores: null,
          status: 'pending',
        });
      }
    }

    return {
      type: 'round-robin',
      total_matches: matches.length,
      rounds: [{ round: 1, matches }],
    };
  }

  _singleElimination(participants) {
    // Pad to nearest power of 2
    const n = participants.length;
    const size = Math.pow(2, Math.ceil(Math.log2(n)));
    const padded = [...participants];
    while (padded.length < size) {
      padded.push(null); // bye
    }

    // Shuffle for fair seeding
    for (let i = padded.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [padded[i], padded[j]] = [padded[j], padded[i]];
    }

    const rounds = [];
    let currentRound = [];
    let matchNum = 0;

    // First round
    for (let i = 0; i < padded.length; i += 2) {
      matchNum++;
      const match = {
        match_id: `match-${matchNum}`,
        player_a: padded[i],
        player_b: padded[i + 1],
        winner: null,
        scores: null,
        status: 'pending',
      };

      // Auto-advance byes
      if (!match.player_b) {
        match.winner = match.player_a;
        match.status = 'bye';
      } else if (!match.player_a) {
        match.winner = match.player_b;
        match.status = 'bye';
      }

      currentRound.push(match);
    }

    rounds.push({ round: 1, matches: currentRound });

    // Generate subsequent rounds (placeholders)
    let numMatches = currentRound.length / 2;
    let roundNum = 2;
    while (numMatches >= 1) {
      const nextRound = [];
      for (let i = 0; i < numMatches; i++) {
        matchNum++;
        nextRound.push({
          match_id: `match-${matchNum}`,
          player_a: null, // TBD from previous round
          player_b: null,
          winner: null,
          scores: null,
          status: 'waiting',
        });
      }
      rounds.push({ round: roundNum, matches: nextRound });
      numMatches = numMatches / 2;
      roundNum++;
    }

    return {
      type: 'single-elimination',
      total_matches: matchNum,
      rounds,
    };
  }
}
