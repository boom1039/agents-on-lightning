/**
 * Help Endpoint — LLM-powered concierge for agents on the Lightning Observatory.
 *
 * Single endpoint that handles onboarding, intelligence, and troubleshooting
 * questions. Backed by Claude Haiku with a comprehensive system prompt and
 * read access to the asking agent's own data (audit log, channels, balances).
 *
 * Payment: 1-5 sats per question (paid from agent's Cashu wallet).
 * Rate limit: 10 questions per agent per hour.
 * Read-only: cannot modify any platform state.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAndIncrement, checkOnly } from '../identity/rate-limiter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP_RATE_LIMIT = 10;           // max questions per agent per hour
const HELP_RATE_WINDOW_MS = 3600_000; // 1 hour
const MAX_QUESTION_LENGTH = 500;      // chars
const MAX_RESPONSE_TOKENS = 1024;     // ~1000 tokens
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Price tiers based on question complexity
const PRICE_SIMPLE = 1;   // onboarding, API help, general questions
const PRICE_DATA = 3;     // questions requiring audit/channel/balance lookups
const PRICE_COMPLEX = 5;  // multi-source analysis questions

// Keywords that indicate data lookup is needed
const DATA_KEYWORDS = [
  'my channel', 'my channels', 'my balance', 'my wallet',
  'my audit', 'my log', 'my assignment', 'my instruction',
  'failed', 'rejected', 'violation', 'error',
  'why did', 'what happened', 'last instruction',
];

// Keywords that indicate complex analysis
const COMPLEX_KEYWORDS = [
  'optimal', 'strategy', 'recommend', 'compare',
  'competitive', 'should i', 'best fee', 'analyze',
  'profitable', 'performance', 'forecast',
];

export class HelpEndpoint {
  /**
   * @param {object} deps
   * @param {object} deps.agentRegistry - AgentRegistry instance
   * @param {object} deps.assignmentRegistry - ChannelAssignmentRegistry instance
   * @param {object} deps.auditLog - HashChainAuditLog instance
   * @param {object} [deps.capitalLedger] - CapitalLedger instance (may not exist yet)
   * @param {object} [deps.performanceTracker] - PerformanceTracker instance (may not exist yet)
   * @param {object} [deps.marketTransparency] - MarketTransparency instance (may not exist yet)
   * @param {object} deps.walletOps - AgentCashuWalletOperations instance
   * @param {object} deps.dataLayer - DataLayer instance
   */
  constructor({
    agentRegistry,
    assignmentRegistry,
    auditLog,
    capitalLedger,
    performanceTracker,
    marketTransparency,
    walletOps,
    dataLayer,
  }) {
    this._agentRegistry = agentRegistry;
    this._assignmentRegistry = assignmentRegistry;
    this._auditLog = auditLog;
    this._capitalLedger = capitalLedger || null;
    this._performanceTracker = performanceTracker || null;
    this._walletOps = walletOps;
    this._systemPrompt = null;
    this._anthropic = null;
  }

  /**
   * Load the system prompt from disk and initialize the Anthropic client.
   * Call once at startup.
   */
  async initialize() {
    // Load system prompt
    const promptPath = resolve(__dirname, 'help-system-prompt.txt');
    this._systemPrompt = await readFile(promptPath, 'utf-8');

    // Initialize Anthropic client
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('[HelpEndpoint] ANTHROPIC_API_KEY not set — help endpoint will return errors');
    }
    this._anthropic = new Anthropic({ apiKey: apiKey || 'missing' });

    console.log('[HelpEndpoint] Initialized');
  }

  /**
   * Classify a question to determine price tier.
   * @param {string} question
   * @param {object} context - Optional context provided by agent
   * @returns {{ tier: string, cost_sats: number, needsData: boolean }}
   */
  classifyQuestion(question, context = {}) {
    const lower = question.toLowerCase();

    // Check if context explicitly requests data
    const hasExplicitContext = context && (
      context.include_audit === true ||
      context.include_channels === true ||
      context.include_balance === true ||
      context.channel_id ||
      context.chan_id
    );

    // Check for complex analysis keywords
    const isComplex = COMPLEX_KEYWORDS.some(kw => lower.includes(kw));

    // Check for data lookup keywords
    const needsData = hasExplicitContext ||
      DATA_KEYWORDS.some(kw => lower.includes(kw));

    if (isComplex && needsData) {
      return { tier: 'complex', cost_sats: PRICE_COMPLEX, needsData: true };
    }
    if (needsData) {
      return { tier: 'data', cost_sats: PRICE_DATA, needsData: true };
    }
    if (isComplex) {
      return { tier: 'complex', cost_sats: PRICE_COMPLEX, needsData: false };
    }
    return { tier: 'simple', cost_sats: PRICE_SIMPLE, needsData: false };
  }

  /**
   * Gather the asking agent's context from available data sources.
   * @param {string} agentId
   * @param {object} context - Optional context hints from agent
   * @returns {string} Formatted context string for the LLM
   */
  async _gatherAgentContext(agentId, context = {}) {
    const parts = [];
    const sources = [];

    // 1. Agent profile
    try {
      const profile = this._agentRegistry.getById(agentId);
      if (profile) {
        parts.push(`AGENT PROFILE:\n- ID: ${profile.id}\n- Name: ${profile.name}\n- Tier: ${profile.tier}\n- Registered: ${new Date(profile.registered_at).toISOString()}`);
        sources.push('agent_profile');
      }
    } catch { /* skip */ }

    // 2. Agent's channel assignments
    try {
      const channels = this._assignmentRegistry.getByAgent(agentId);
      if (channels.length > 0) {
        const chanLines = channels.map(c =>
          `  - chan_id=${c.chan_id} point=${c.channel_point} peer=${c.remote_pubkey?.slice(0, 16)}... capacity=${c.capacity} assigned=${new Date(c.assigned_at).toISOString()}` +
          (c.constraints ? ` constraints=${JSON.stringify(c.constraints)}` : '')
        );
        parts.push(`ASSIGNED CHANNELS (${channels.length}):\n${chanLines.join('\n')}`);
        sources.push('channel_assignments');
      } else {
        parts.push('ASSIGNED CHANNELS: None');
      }
    } catch { /* skip */ }

    // 3. Recent audit log entries for this agent (last 20)
    if (context.include_audit !== false) {
      try {
        const allEntries = await this._auditLog.readAll({ limit: 200 });
        const agentEntries = allEntries
          .filter(e => e.agent_id === agentId)
          .slice(-20);
        if (agentEntries.length > 0) {
          const auditLines = agentEntries.map(e => {
            const ts = new Date(e._ts).toISOString();
            const fields = [];
            if (e.type) fields.push(`type=${e.type}`);
            if (e.chan_id) fields.push(`chan=${e.chan_id}`);
            if (e.reason) fields.push(`reason=${e.reason}`);
            if (e.old_policy) fields.push(`old_fees=${JSON.stringify(e.old_policy)}`);
            if (e.new_policy) fields.push(`new_fees=${JSON.stringify(e.new_policy)}`);
            return `  [${ts}] ${fields.join(' ')}`;
          });
          parts.push(`RECENT AUDIT LOG (${agentEntries.length} entries):\n${auditLines.join('\n')}`);
          sources.push('audit_log');
        }
      } catch { /* skip */ }
    }

    // 4. Wallet balance
    try {
      const balance = await this._walletOps.getBalance(agentId);
      parts.push(`WALLET BALANCE: ${balance} sats (Cashu ecash)`);
      sources.push('wallet_balance');
    } catch { /* skip */ }

    // 5. Capital ledger (if available)
    if (this._capitalLedger) {
      try {
        const capitalBalance = await this._capitalLedger.getBalance(agentId);
        if (capitalBalance !== undefined && capitalBalance !== null) {
          parts.push(`CAPITAL BALANCE: ${capitalBalance} sats`);
          sources.push('capital_ledger');
        }
      } catch { /* skip */ }
    }

    // 6. Performance data (if available)
    if (this._performanceTracker) {
      try {
        const perf = await this._performanceTracker.getAgentPerformance(agentId);
        if (perf) {
          parts.push(`PERFORMANCE: ${JSON.stringify(perf)}`);
          sources.push('performance_tracker');
        }
      } catch { /* skip */ }
    }

    // 7. Any specific channel the agent is asking about (ownership-verified)
    if (context.chan_id || context.channel_id) {
      const chanId = context.chan_id || context.channel_id;
      try {
        // Verify channel belongs to this agent before exposing audit data
        const assignment = this._assignmentRegistry?.getAssignment?.(chanId);
        if (assignment && assignment.agent_id === agentId) {
          const chanAudit = await this._auditLog.readByChannel(chanId, 20);
          if (chanAudit.length > 0) {
            const lines = chanAudit.map(e => {
              const ts = new Date(e._ts).toISOString();
              return `  [${ts}] type=${e.type} agent=${e.agent_id || 'n/a'}${e.reason ? ` reason=${e.reason}` : ''}`;
            });
            parts.push(`CHANNEL ${chanId} AUDIT (${chanAudit.length} entries):\n${lines.join('\n')}`);
            sources.push(`audit_log:channel:${chanId}`);
          }
        }
        // Silently skip if not owned — don't reveal whether the channel exists
      } catch { /* skip */ }
    }

    return { contextText: parts.join('\n\n'), sources };
  }

  /**
   * Ask the concierge a question.
   * @param {string} agentId - The asking agent's ID
   * @param {string} question - The question (max 500 chars)
   * @param {object} [context] - Optional context hints
   * @returns {{ answer: string, sources: string[], cost_sats: number, learn: string }}
   */
  async ask(agentId, question, context = {}) {
    // --- Initialization guard ---
    if (!this._systemPrompt || !this._anthropic) {
      throw Object.assign(
        new Error('Help service not initialized. Refer to /llms-full.txt'),
        { status: 503 },
      );
    }

    // --- Validation ---
    if (!agentId || typeof agentId !== 'string') {
      throw Object.assign(new Error('agent_id is required'), { status: 400 });
    }
    if (!question || typeof question !== 'string') {
      throw Object.assign(new Error('question is required'), { status: 400 });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      throw Object.assign(
        new Error(`Question too long (${question.length} chars). Maximum is ${MAX_QUESTION_LENGTH} characters.`),
        { status: 400 },
      );
    }

    // --- Rate limit: peek without incrementing (don't consume slot before payment) ---
    const rlKey = `help:agent:${agentId}`;
    const rlPeek = checkOnly(rlKey, HELP_RATE_LIMIT, HELP_RATE_WINDOW_MS);
    if (!rlPeek.allowed) {
      const err = new Error(
        `Help rate limit reached (${HELP_RATE_LIMIT} questions per hour). ` +
        `Try again in ${rlPeek.retryAfter} seconds.`,
      );
      err.status = 429;
      err.retryAfter = rlPeek.retryAfter;
      throw err;
    }

    // --- Classify and price ---
    const classification = this.classifyQuestion(question, context);
    const costSats = classification.cost_sats;

    // --- Debit Cashu wallet ---
    let paymentToken = null;
    try {
      const sendResult = await this._walletOps.sendEcash(agentId, costSats);
      paymentToken = sendResult.token;
    } catch (err) {
      if (err.message?.includes('Insufficient')) {
        const balErr = new Error(
          `Insufficient balance for help query (costs ${costSats} sats). ` +
          `Fund your wallet: POST /api/v1/wallet/mint-quote`,
        );
        balErr.status = 402;
        throw balErr;
      }
      throw err;
    }

    // --- Increment rate limit AFTER successful payment ---
    checkAndIncrement(rlKey, HELP_RATE_LIMIT, HELP_RATE_WINDOW_MS);

    // --- Gather agent context (only if question requires it) ---
    let contextText = '';
    let sources = [];
    if (classification.needsData) {
      try {
        const gathered = await this._gatherAgentContext(agentId, context);
        contextText = gathered.contextText;
        sources = gathered.sources;
      } catch {
        // Context gathering failure is non-fatal — answer without context
      }
    }

    // --- Build messages for Claude ---
    const userMessage = contextText
      ? `AGENT CONTEXT:\n${contextText}\n\nQUESTION:\n${question}`
      : question;

    // --- Call Claude Haiku ---
    try {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('Help service not configured (missing API key)');
      }

      const response = await this._anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: MAX_RESPONSE_TOKENS,
        system: this._systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const answerText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      // Extract a concise "learn" takeaway from the answer (last paragraph or sentence)
      const learn = this._extractLearnTakeaway(answerText);

      return {
        answer: answerText,
        sources,
        cost_sats: costSats,
        learn,
      };
    } catch (err) {
      // --- Refund on LLM failure ---
      let refundSuccess = false;
      if (paymentToken) {
        try {
          await this._walletOps.receiveEcash(agentId, paymentToken);
          refundSuccess = true;
        } catch {
          console.error(`[HelpEndpoint] Refund failed for agent ${agentId}, ${costSats} sats lost`);
        }
      }

      // Return a helpful fallback error
      const fallbackErr = new Error(
        'Help is temporarily unavailable. Refer to the playbook at /llms-full.txt ' +
        'and knowledge base at GET /api/v1/knowledge/index',
      );
      fallbackErr.status = 503;
      fallbackErr.refunded = refundSuccess;
      throw fallbackErr;
    }
  }

  /**
   * Extract a concise learning takeaway from the answer.
   * Looks for the last substantive sentence or paragraph.
   * @param {string} answer
   * @returns {string}
   */
  _extractLearnTakeaway(answer) {
    if (!answer) return '';

    // Split into paragraphs, find the last non-empty one
    const paragraphs = answer.split(/\n\n+/).filter(p => p.trim().length > 0);
    if (paragraphs.length === 0) return '';

    // Use the last paragraph if it's a reasonable length for a takeaway
    const lastParagraph = paragraphs[paragraphs.length - 1].trim();
    if (lastParagraph.length <= 300) {
      return lastParagraph;
    }

    // Otherwise, take the last sentence of the full answer
    const sentences = answer.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    if (sentences.length > 0) {
      return sentences[sentences.length - 1].trim();
    }

    return '';
  }
}
