(() => {
  'use strict';

  const COMMAND_TIMEOUT_MS = 8000;
  const ALLOWED_COMMANDS = new Set(['START_VIDEO', 'STOP_VIDEO', 'GET_STATUS', 'LOGOUT']);
  const ROLE_HINTS = Object.freeze({
    operator: 'Operator permissions: video and all management commands.',
    viewer: 'Viewer permissions: video, GET_STATUS, and LOGOUT.',
  });
  const hlsUrl = new URL(window.location.href);
  hlsUrl.port = '3001';
  hlsUrl.pathname = '/video/stream.m3u8';
  hlsUrl.search = '';
  hlsUrl.hash = '';

  const elements = {
    commandForm: document.getElementById('command-form'),
    commandInput: document.getElementById('command-input'),
    consoleOutput: document.getElementById('console-output'),
    currentRole: document.getElementById('current-role'),
    currentUser: document.getElementById('current-user'),
    loginButton: document.getElementById('login-button'),
    loginForm: document.getElementById('login-form'),
    loginInput: document.getElementById('login'),
    loginStatus: document.getElementById('login-status'),
    loginView: document.getElementById('login-view'),
    mainView: document.getElementById('main-view'),
    passwordInput: document.getElementById('password'),
    roleHint: document.getElementById('role-hint'),
    sendButton: document.getElementById('send-button'),
    socketStatus: document.getElementById('socket-status'),
    video: document.getElementById('video'),
    videoMessage: document.getElementById('video-message'),
    videoStatus: document.getElementById('video-status'),
  };

  const state = {
    hls: null,
    pendingRequests: new Map(),
    socket: null,
    token: null,
    user: null,
    videoRecoveryAttempts: 0,
    videoRecoveryTimer: null,
  };

  function setBadge(element, text, tone = 'neutral') {
    element.textContent = text;
    element.dataset.tone = tone;
  }

  function setVideoStatus(text, tone = 'neutral') {
    setBadge(elements.videoStatus, text, tone);
    elements.videoMessage.textContent = text;
    elements.videoMessage.hidden = text === 'Playing';
  }

  function appendConsole(text, kind = 'response') {
    const line = document.createElement('div');
    line.className = `console-line console-${kind}`;
    line.textContent = text;
    elements.consoleOutput.append(line);
    elements.consoleOutput.scrollTop = elements.consoleOutput.scrollHeight;
  }

  function setCommandAvailability(available) {
    elements.commandInput.disabled = !available;
    elements.sendButton.disabled = !available;
  }

  function clearPendingRequests(reason) {
    for (const pending of state.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      appendConsole(`< ERROR: ${reason}`, 'error');
    }
    state.pendingRequests.clear();
  }

  function destroyVideoPlayer() {
    if (state.videoRecoveryTimer) {
      clearTimeout(state.videoRecoveryTimer);
      state.videoRecoveryTimer = null;
    }
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    elements.video.pause();
    elements.video.removeAttribute('src');
    elements.video.load();
  }

  function showLogin(message = '', tone = 'neutral') {
    elements.mainView.hidden = true;
    elements.loginView.hidden = false;
    elements.loginStatus.textContent = message;
    elements.loginStatus.dataset.tone = tone;
    elements.loginButton.disabled = false;
    elements.loginInput.focus();
  }

  function endSession(message, tone = 'neutral') {
    const socket = state.socket;
    state.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    clearPendingRequests('Session ended');
    destroyVideoPlayer();
    state.token = null;
    state.user = null;
    state.videoRecoveryAttempts = 0;
    elements.currentUser.textContent = '—';
    elements.currentRole.textContent = '—';
    elements.roleHint.textContent = '';
    elements.passwordInput.value = '';
    setCommandAvailability(false);
    setBadge(elements.socketStatus, 'Disconnected', 'error');
    setVideoStatus('Not available', 'neutral');
    showLogin(message, tone);
  }

  function scheduleVideoRecovery() {
    if (!state.token || state.videoRecoveryTimer || state.videoRecoveryAttempts >= 3) return;
    const delays = [3000, 5000, 8000];
    const retryDelay = delays[state.videoRecoveryAttempts];
    state.videoRecoveryAttempts += 1;
    state.videoRecoveryTimer = setTimeout(() => {
      state.videoRecoveryTimer = null;
      initializeVideo();
    }, retryDelay);
  }

  function handleVideoError(data) {
    const statusCode = data.response?.code;
    const responseText = String(data.response?.text || '');

    if (statusCode === 401) {
      endSession('Session expired. Please sign in again.', 'error');
      return;
    }
    if (statusCode === 503 && responseText.includes('Video delivery is stopped')) {
      destroyVideoPlayer();
      setVideoStatus('Video stopped', 'warning');
      return;
    }
    if (statusCode === 503 && responseText.includes('Authorization state unavailable')) {
      setVideoStatus('Authorization unavailable', 'warning');
      scheduleVideoRecovery();
      return;
    }
    if (statusCode === 503) {
      setVideoStatus('Stream temporarily unavailable', 'warning');
      scheduleVideoRecovery();
      return;
    }
    if (!statusCode) {
      setVideoStatus('Video server unavailable', 'error');
      scheduleVideoRecovery();
      return;
    }
    setVideoStatus('Playback error', 'error');
  }

  function initializeVideo() {
    if (!state.token) return;
    destroyVideoPlayer();
    setVideoStatus('Connecting', 'neutral');

    if (!window.Hls || !window.Hls.isSupported()) {
      setVideoStatus('Browser does not support hls.js playback', 'error');
      return;
    }

    const hls = new window.Hls({
      liveSyncDurationCount: 2,
      xhrSetup(xhr) {
        if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      },
    });
    state.hls = hls;

    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      if (state.hls === hls) hls.loadSource(hlsUrl.toString());
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (state.hls !== hls) return;
      setVideoStatus('Stream ready', 'success');
      elements.video.play().catch(() => {
        setVideoStatus('Ready — press play', 'success');
      });
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (state.hls === hls && data.fatal) handleVideoError(data);
    });
    elements.video.addEventListener('playing', () => {
      if (state.hls === hls) {
        state.videoRecoveryAttempts = 0;
        setVideoStatus('Playing', 'success');
      }
    }, { once: true });
    hls.attachMedia(elements.video);
  }

  function createRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatCommandSuccess(command, result) {
    if (command === 'GET_STATUS') {
      return result?.videoRunning ? '< VIDEO_RUNNING' : '< VIDEO_STOPPED';
    }
    if (command === 'START_VIDEO') return '< OK - VIDEO_RUNNING';
    if (command === 'STOP_VIDEO') return '< OK - VIDEO_STOPPED';
    if (command === 'LOGOUT') return '< LOGGED_OUT';
    return '< OK';
  }

  function applyCommandResult(command, result) {
    if (command === 'STOP_VIDEO') {
      destroyVideoPlayer();
      setVideoStatus('Video stopped', 'warning');
      return;
    }
    if (command === 'START_VIDEO' || (command === 'GET_STATUS' && result?.videoRunning)) {
      initializeVideo();
      return;
    }
    if (command === 'GET_STATUS' && result?.videoRunning === false) {
      destroyVideoPlayer();
      setVideoStatus('Video stopped', 'warning');
    }
  }

  function handleSocketMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      appendConsole('< ERROR: Invalid response from management server', 'error');
      return;
    }

    const pending = state.pendingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    state.pendingRequests.delete(message.requestId);

    if (!message.ok) {
      const safeError = typeof message.error === 'string' ? message.error : 'Command failed';
      appendConsole(`< ERROR: ${safeError}`, 'error');
      if (safeError === 'Authentication required') {
        endSession('Session expired. Please sign in again.', 'error');
      } else if (safeError.includes('Video server')) {
        setVideoStatus('Video server unavailable', 'error');
      }
      return;
    }

    appendConsole(formatCommandSuccess(pending.command, message.result), 'response');
    applyCommandResult(pending.command, message.result);
    if (pending.command === 'LOGOUT') endSession('You have been logged out.', 'success');
  }

  function connectManagementSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = new URL(`${protocol}//${window.location.host}/ws`);
    socketUrl.searchParams.set('token', state.token);
    const socket = new WebSocket(socketUrl);
    state.socket = socket;
    setBadge(elements.socketStatus, 'Connecting', 'neutral');

    socket.addEventListener('open', () => {
      if (state.socket !== socket) return;
      setBadge(elements.socketStatus, 'Connected', 'success');
      setCommandAvailability(true);
      elements.commandInput.focus();
    });
    socket.addEventListener('message', (event) => {
      if (state.socket === socket) handleSocketMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (state.socket !== socket) return;
      setBadge(elements.socketStatus, 'Connection error', 'error');
      appendConsole('< ERROR: Management connection error', 'error');
    });
    socket.addEventListener('close', () => {
      if (state.socket !== socket) return;
      state.socket = null;
      setBadge(elements.socketStatus, 'Disconnected', 'error');
      endSession('Management connection closed. Please sign in again.', 'error');
    });
  }

  function sendCommand(command) {
    const socket = state.socket;
    appendConsole(`> ${command}`, 'command');
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendConsole('< ERROR: Management server disconnected', 'error');
      return;
    }

    const requestId = createRequestId();
    const timeout = setTimeout(() => {
      state.pendingRequests.delete(requestId);
      appendConsole(`< ERROR: ${command} timed out`, 'error');
    }, COMMAND_TIMEOUT_MS);
    state.pendingRequests.set(requestId, { command, timeout });
    socket.send(JSON.stringify({ type: 'COMMAND', requestId, command }));
  }

  elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (elements.loginButton.disabled) return;
    elements.loginButton.disabled = true;
    elements.loginStatus.textContent = 'Signing in…';
    elements.loginStatus.dataset.tone = 'neutral';

    const login = elements.loginInput.value.trim();
    const password = elements.passwordInput.value;
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Sign-in failed');
      if (typeof body.token !== 'string' || !body.user) throw new Error('Invalid login response');

      state.token = body.token;
      state.user = { login: body.user.login, role: body.user.role };
      elements.currentUser.textContent = state.user.login;
      elements.currentRole.textContent = state.user.role;
      elements.roleHint.textContent = ROLE_HINTS[state.user.role]
        || 'No management command permissions are assigned to this role.';
      elements.consoleOutput.replaceChildren();
      elements.loginView.hidden = true;
      elements.mainView.hidden = false;
      elements.loginStatus.textContent = '';
      connectManagementSocket();
      initializeVideo();
    } catch (error) {
      elements.loginStatus.textContent = error.message === 'Invalid credentials'
        ? 'Invalid login or password.'
        : 'Unable to sign in. Please try again.';
      elements.loginStatus.dataset.tone = 'error';
      elements.loginButton.disabled = false;
      elements.passwordInput.focus();
    } finally {
      elements.passwordInput.value = '';
    }
  });

  elements.passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.loginForm.requestSubmit();
    }
  });

  elements.commandForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const command = elements.commandInput.value.trim().toUpperCase();
    elements.commandInput.value = '';
    if (!command) return;
    if (!ALLOWED_COMMANDS.has(command)) {
      appendConsole(`> ${command}`, 'command');
      appendConsole('< ERROR: Supported commands are START_VIDEO, STOP_VIDEO, GET_STATUS, and LOGOUT', 'error');
      return;
    }
    sendCommand(command);
  });

  elements.commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.commandForm.requestSubmit();
    }
  });

  window.addEventListener('pagehide', () => {
    destroyVideoPlayer();
    if (state.socket && state.socket.readyState < WebSocket.CLOSING) state.socket.close();
    state.socket = null;
    state.token = null;
    state.user = null;
  });
})();
