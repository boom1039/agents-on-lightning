/**
 * Agent-to-Agent Messaging
 *
 * Free-text messages between agents. All messages are public record (transparency).
 * Stored in both sender and recipient message logs.
 */

import { randomBytes } from 'node:crypto';

const VALID_MESSAGE_TYPES = ['message', 'challenge', 'intel'];

export class AgentMessaging {
  constructor(dataLayer, registry) {
    this._dataLayer = dataLayer;
    this._registry = registry;
  }

  /**
   * Send a message from one agent to another.
   * @param {string} fromId - Sender agent ID
   * @param {string} toId - Recipient agent ID
   * @param {string} content - Message content
   * @param {string} [type='message'] - Message type: 'message', 'challenge', 'intel'
   * @returns {object} Message record
   */
  async send(fromId, toId, content, type = 'message') {
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Message content is required');
    }
    if (content.length > 5000) {
      throw new Error('Message must be 5000 characters or less');
    }
    if (fromId === toId) {
      throw new Error('Cannot send message to yourself');
    }
    // Validate and sanitize message type
    if (!VALID_MESSAGE_TYPES.includes(type)) {
      type = 'message';
    }

    const recipient = this._registry.getById(toId);
    if (!recipient) {
      throw new Error(`Agent ${toId} not found`);
    }

    const message = {
      message_id: `msg-${randomBytes(6).toString('hex')}`,
      from: fromId,
      to: toId,
      type: type,
      content: content.trim(),
      sent_at: Date.now(),
    };

    // Log to both sender and recipient
    await Promise.all([
      this._registry.logMessage(fromId, { ...message, direction: 'sent' }),
      this._registry.logMessage(toId, { ...message, direction: 'received' }),
    ]);

    // Also log to public activity feed
    await this._dataLayer.appendLog('data/social/activity.jsonl', {
      type: 'message',
      from: fromId,
      to: toId,
      message_type: type,
      preview: content.slice(0, 100),
    });

    return message;
  }

  /**
   * Get inbox for an agent (received messages).
   * @param {string} agentId
   * @param {object} [opts] - { since, limit }
   */
  async getInbox(agentId, opts = {}) {
    const messages = await this._registry.getMessages(agentId, opts.since);
    let inbox = messages.filter(m => m.direction === 'received');

    // Sort newest first
    inbox.sort((a, b) => (b.sent_at || b._ts) - (a.sent_at || a._ts));

    if (opts.limit) {
      inbox = inbox.slice(0, opts.limit);
    }

    return inbox;
  }

  /**
   * Get sent messages for an agent.
   */
  async getSent(agentId, opts = {}) {
    const messages = await this._registry.getMessages(agentId, opts.since);
    let sent = messages.filter(m => m.direction === 'sent');
    sent.sort((a, b) => (b.sent_at || b._ts) - (a.sent_at || a._ts));
    if (opts.limit) sent = sent.slice(0, opts.limit);
    return sent;
  }

  /**
   * Get public activity feed (all agent interactions).
   */
  async getActivityFeed(opts = {}) {
    try {
      let entries = await this._dataLayer.readLog('data/social/activity.jsonl', opts.since);
      entries.sort((a, b) => (b._ts || 0) - (a._ts || 0));
      if (opts.limit) entries = entries.slice(0, opts.limit);
      return entries;
    } catch {
      return [];
    }
  }
}
