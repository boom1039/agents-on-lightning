import http from 'node:http';
import https from 'node:https';

const DEFAULT_TARGET = 'http://127.0.0.1:3308/api/live-events';
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_BATCH = 200;
const DEFAULT_MAX_QUEUE = 5_000;
const DEFAULT_TIMEOUT_MS = 1_000;
const ERROR_LOG_INTERVAL_MS = 30_000;

class DashboardLivePublisher {
  constructor(options = {}) {
    this.target = new URL(options.target || process.env.AOL_DASHBOARD_LIVE_URL || DEFAULT_TARGET);
    this.flushMs = options.flushMs || DEFAULT_FLUSH_MS;
    this.maxBatch = options.maxBatch || DEFAULT_MAX_BATCH;
    this.maxQueue = options.maxQueue || DEFAULT_MAX_QUEUE;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.disabled = options.disabled ?? (process.env.AOL_DASHBOARD_LIVE_DISABLE === '1');
    this.queue = [];
    this.flushing = false;
    this.timer = null;
    this.seq = 0;
    this.dropped = 0;
    this.lastErrorLogAt = 0;

    const AgentCtor = this.target.protocol === 'https:' ? https.Agent : http.Agent;
    this.agent = new AgentCtor({ keepAlive: true, maxSockets: 1 });
  }

  publish(event) {
    if (this.disabled || !event) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push({
      ...event,
      ts: Number.isFinite(event.ts) ? event.ts : Date.now(),
      id: event.id || `journey-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`,
    });
    if (this.queue.length >= this.maxBatch) {
      this._scheduleFlush(0);
      return;
    }
    this._scheduleFlush(this.flushMs);
  }

  _scheduleFlush(delay) {
    if (this.flushing) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this._flush();
    }, delay);
    this.timer.unref?.();
  }

  async _flush() {
    if (this.flushing || this.queue.length === 0 || this.disabled) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.maxBatch);
    try {
      await this._post(batch);
    } catch (err) {
      this.dropped += batch.length;
      const now = Date.now();
      if ((now - this.lastErrorLogAt) >= ERROR_LOG_INTERVAL_MS) {
        this.lastErrorLogAt = now;
        console.warn(`[dashboard-live] dropping ${batch.length} event(s): ${err.message}`);
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) this._scheduleFlush(this.flushMs);
    }
  }

  _post(events) {
    const transport = this.target.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ events });
    return new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: this.target.protocol,
        hostname: this.target.hostname,
        port: this.target.port,
        path: this.target.pathname,
        method: 'POST',
        agent: this.agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`dashboard returned ${res.statusCode}`));
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }
}

let singleton = null;

function getPublisher() {
  if (!singleton) singleton = new DashboardLivePublisher();
  return singleton;
}

export function publishDashboardEvent(event) {
  getPublisher().publish(event);
}
