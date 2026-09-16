const { spawn } = require('node:child_process');

class ProcessSupervisor {
  constructor({
    name,
    command,
    getArguments = () => [],
    beforeStart,
    spawnOptions = {},
    minimumRetryMs = 1000,
    maximumRetryMs = 10000,
    onOutput,
    onFatal,
    logPrefix = 'camera',
  }) {
    this.name = name;
    this.command = command;
    this.getArguments = getArguments;
    this.beforeStart = beforeStart;
    this.spawnOptions = spawnOptions;
    this.minimumRetryMs = minimumRetryMs;
    this.maximumRetryMs = maximumRetryMs;
    this.onOutput = onOutput;
    this.onFatal = onFatal;
    this.logPrefix = logPrefix;

    this.child = null;
    this.retryTimer = null;
    this.stabilityTimer = null;
    this.retryDelayMs = minimumRetryMs;
    this.shouldRun = false;
    this.starting = false;
  }

  async start() {
    this.shouldRun = true;
    await this.#launch();
  }

  async #launch() {
    if (!this.shouldRun || this.starting || this.child || this.retryTimer) {
      return;
    }

    this.starting = true;

    try {
      if (this.beforeStart) {
        await this.beforeStart();
      }

      if (!this.shouldRun) {
        return;
      }

      this.#log(`Starting ${this.name}...`);

      const child = spawn(this.command, this.getArguments(), {
        shell: false,
        windowsHide: true,
        ...this.spawnOptions,
      });

      this.child = child;
      let handled = false;

      child.once('spawn', () => {
        this.#log(`${this.name} started (PID ${child.pid})`);
        this.stabilityTimer = setTimeout(() => {
          this.stabilityTimer = null;
          this.retryDelayMs = this.minimumRetryMs;
        }, this.maximumRetryMs);
      });

      child.once('error', (error) => {
        if (handled) return;
        handled = true;
        this.child = null;
        this.#clearStabilityTimer();

        if (error.code === 'ENOENT') {
          this.shouldRun = false;
          this.#error(`Fatal: ${this.name} executable was not found: ${this.command}`);
          this.#error(`Check ${this.name === 'FFmpeg' ? 'FFMPEG_PATH' : 'MEDIAMTX_PATH'} in .env.`);
          this.onFatal?.(error);
          return;
        }

        this.#error(`${this.name} failed to start: ${error.message}`);
        this.#scheduleRestart();
      });

      child.once('exit', (code, signal) => {
        if (handled) return;
        handled = true;
        this.child = null;
        this.#clearStabilityTimer();

        if (!this.shouldRun) {
          this.#log(`${this.name} stopped`);
          return;
        }

        const detail = signal ? `signal ${signal}` : `code ${code}`;
        this.#error(`${this.name} exited unexpectedly (${detail})`);
        this.#scheduleRestart();
      });

      this.onOutput?.(child);
    } catch (error) {
      if (this.shouldRun) {
        this.#error(`${this.name} could not start: ${error.message}`);
        this.#scheduleRestart();
      }
    } finally {
      this.starting = false;
    }
  }

  #scheduleRestart() {
    if (!this.shouldRun || this.retryTimer) return;

    const delayMs = this.retryDelayMs;
    this.#log(`Restarting ${this.name} in ${delayMs / 1000} seconds...`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.#launch();
    }, delayMs);

    this.retryDelayMs = Math.min(delayMs * 2, this.maximumRetryMs);
  }

  #clearStabilityTimer() {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  #log(message) {
    console.log(`[${this.logPrefix}] ${message}`);
  }

  #error(message) {
    console.error(`[${this.logPrefix}] ${message}`);
  }

  async stop() {
    this.shouldRun = false;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.#clearStabilityTimer();

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;

    await new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);

      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });

      child.kill();
    });
  }
}

module.exports = { ProcessSupervisor };
