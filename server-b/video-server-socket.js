const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { MESSAGE_TYPES } = require('../shared/protocol');
const { parseJsonMessage, validateResponseMessage } = require('../shared/validation');

class VideoServerSocket {
  constructor({
    controlUrl,
    getActiveSessions = () => [],
    secret,
    commandTimeoutMs = 5000,
    minimumRetryMs = 500,
    maximumRetryMs = 10000,
    stableConnectionMs = 10000,
  }) {
    this.controlUrl = controlUrl;
    this.getActiveSessions = getActiveSessions;
    this.secret = secret;
    this.commandTimeoutMs = commandTimeoutMs;
    this.minimumRetryMs = minimumRetryMs;
    this.maximumRetryMs = maximumRetryMs;
    this.stableConnectionMs = stableConnectionMs;
    this.retryDelayMs = minimumRetryMs;
    this.socket = null;
    this.retryTimer = null;
    this.stabilityTimer = null;
    this.pendingRequests = new Map();
    this.authorizationSynchronized = false;
    this.synchronizationPromise = null;
    this.shouldRun = false;
  }

  start() {
    this.shouldRun = true;
    this.#connect();
  }

  #connect() {
    if (!this.shouldRun || this.socket || this.retryTimer) return;

    const url = new URL(this.controlUrl);
    url.searchParams.set('secret', this.secret);
    console.log('[server-b] Connecting to Server A control channel...');

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.once('open', () => {
      console.log('[server-b] Connected to Server A control channel');
      this.synchronizationPromise = this.#synchronizeSessions(socket);
    });

    socket.on('message', (data) => this.#handleMessage(data));

    socket.once('error', (error) => {
      if (this.shouldRun) {
        console.error(`[server-b] Server A control connection error: ${error.message}`);
      }
    });

    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authorizationSynchronized = false;
      this.synchronizationPromise = null;
      this.#clearStabilityTimer();
      this.#rejectPending(new Error('Video server unavailable'));

      if (this.shouldRun) {
        console.log('[server-b] Server A control channel disconnected');
        this.#scheduleReconnect();
      }
    });
  }

  #scheduleReconnect() {
    if (!this.shouldRun || this.retryTimer || this.socket) return;
    const delayMs = this.retryDelayMs;
    console.log(`[server-b] Reconnecting to Server A in ${delayMs / 1000} seconds...`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#connect();
    }, delayMs);
    this.retryDelayMs = Math.min(delayMs * 2, this.maximumRetryMs);
  }

  #handleMessage(data) {
    const parsed = parseJsonMessage(data);
    if (!parsed.ok || !validateResponseMessage(parsed.value)) return;

    const pending = this.pendingRequests.get(parsed.value.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(parsed.value.requestId);
    if (parsed.value.ok) pending.resolve(parsed.value.result);
    else pending.reject(new Error(parsed.value.error || 'Command failed'));
  }

  #rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  #clearStabilityTimer() {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  async #synchronizeSessions(socket) {
    try {
      const result = await this.#sendRequest(
        MESSAGE_TYPES.SESSION_SYNC,
        { sessions: this.getActiveSessions() },
        { socket, timeoutMessage: 'Session synchronization timed out' },
      );
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
      this.authorizationSynchronized = true;
      console.log(`[server-b] Session synchronization acknowledged: ${result.activeSessions} active sessions`);
      this.stabilityTimer = setTimeout(() => {
        this.stabilityTimer = null;
        this.retryDelayMs = this.minimumRetryMs;
      }, this.stableConnectionMs);
      return true;
    } catch (error) {
      if (this.socket === socket) {
        this.authorizationSynchronized = false;
        console.error(`[server-b] Session synchronization failed: ${error.message}`);
        socket.terminate();
      }
      return false;
    }
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  isAuthorizationSynchronized() {
    return this.isConnected() && this.authorizationSynchronized;
  }

  async waitForConnection(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.isConnected()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Server A');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async waitForAuthorizationSynchronization(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.isAuthorizationSynchronized()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for session synchronization');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  #sendRequest(type, payload, {
    socket = this.socket,
    timeoutMessage = 'Internal request timed out',
  } = {}) {
    if (!socket || socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Video server unavailable'));
    }

    const requestId = randomUUID();
    const message = { type, requestId, ...payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(timeoutMessage));
      }, this.commandTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error('Video server unavailable'));
      });
    });
  }

  sendCommand(command) {
    return this.#sendRequest(
      MESSAGE_TYPES.COMMAND,
      { command },
      { timeoutMessage: 'Video server command timed out' },
    );
  }

  async #sendSessionChange(type, payload) {
    if (!this.isConnected()) return false;

    const synchronization = this.synchronizationPromise;
    if (synchronization) await synchronization;
    if (!this.isAuthorizationSynchronized()) return false;

    const socket = this.socket;
    try {
      await this.#sendRequest(type, payload, {
        socket,
        timeoutMessage: 'Session update timed out',
      });
      return true;
    } catch (error) {
      if (this.socket === socket) {
        this.authorizationSynchronized = false;
        console.error(`[server-b] Session update failed: ${error.message}`);
        socket.terminate();
      }
      return false;
    }
  }

  activateSession(session) {
    const expiresAt = Date.parse(session.expiresAt);
    return this.#sendSessionChange(MESSAGE_TYPES.SESSION_ACTIVATE, {
      session: {
        jti: session.jti,
        login: session.login,
        role: session.role,
        expiresAt,
      },
    });
  }

  revokeSession(jti) {
    return this.#sendSessionChange(MESSAGE_TYPES.SESSION_REVOKE, { jti });
  }

  async stop() {
    this.shouldRun = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.#clearStabilityTimer();
    this.authorizationSynchronized = false;
    this.synchronizationPromise = null;
    this.#rejectPending(new Error('Video server connection stopped'));

    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;

    await new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1000);
      socket.once('close', () => {
        clearTimeout(forceTimer);
        resolve();
      });
      socket.close();
    });
  }
}

module.exports = { VideoServerSocket };
