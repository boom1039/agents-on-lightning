#!/usr/bin/env python3
"""
Suggest peers for a Lightning node.

Reads JSON from stdin:
  {
    "target_pubkey": "03abc...",
    "my_peers": ["03abc...", ...],
    "candidates": [
      {"pubkey": "03def...", "alias": "...", "num_channels": 10, "total_capacity": 50000000},
      ...
    ]
  }

Writes JSON to stdout: top 20 candidates scored by capacity and channel count,
excluding nodes the operator already has channels with.
"""

import json
import sys


def score(candidate):
    """Simple scoring: capacity (70%) + channel count (30%), normalized."""
    cap = int(candidate.get("total_capacity", 0))
    chans = int(candidate.get("num_channels", 0))
    return cap * 0.7 + chans * 1_000_000 * 0.3


def main():
    data = json.load(sys.stdin)
    my_peers = set(data.get("my_peers", []))
    target = data.get("target_pubkey", "")
    candidates = data.get("candidates", [])

    # Filter out nodes we already connect to and the target itself
    filtered = [
        c for c in candidates
        if c["pubkey"] not in my_peers and c["pubkey"] != target
    ]

    # Score and rank
    ranked = sorted(filtered, key=score, reverse=True)[:20]

    result = {
        "target_pubkey": target,
        "suggestions": [
            {
                "pubkey": c["pubkey"],
                "alias": c.get("alias", ""),
                "num_channels": c.get("num_channels", 0),
                "total_capacity": c.get("total_capacity", 0),
                "score": round(score(c), 2),
            }
            for c in ranked
        ],
        "total_candidates_considered": len(filtered),
    }

    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
