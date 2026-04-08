/**
 * Module-level Lean session singleton.
 *
 * Created once at import time (before React mounts) so that `lake serve`
 * starts and Mathlib begins importing as early as possible. The session
 * survives React StrictMode double-mounting, navigation between levels,
 * and component re-renders.
 *
 * After the LeanSessionManager refactor, this module is just a thin
 * holder for the singleton manager. Higher-level concerns (preamble,
 * level evaluation, win conditions) live in `LevelEvaluator`.
 */
import { connect as lspConnect } from './LeanLspClient';
import { LeanSessionManager } from './LeanSessionManager';
import { log, logError } from './log';

const TAG = 'LeanSession';

class LeanSessionHolder {
  private manager: LeanSessionManager | null = null;
  private connecting = false;
  private readyCallbacks: Array<(m: LeanSessionManager) => void> = [];

  /** Start the connection immediately. */
  start() {
    if (this.manager || this.connecting) return;
    this.connecting = true;

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/websocket/MathlibDemo`;

    log(TAG, 'Connecting to Lean server...');

    lspConnect(wsUrl).then((conn) => {
      const manager = new LeanSessionManager(conn);
      this.manager = manager;
      this.connecting = false;
      log(TAG, 'Session ready');
      // Expose a debug helper on `window` so the user can dump the
      // virtual filesystem state from devtools: `dumpLeanFiles()`.
      (window as unknown as { dumpLeanFiles: () => void }).dumpLeanFiles =
        () => manager.dumpFiles();
      for (const cb of this.readyCallbacks) cb(manager);
      this.readyCallbacks = [];
    }).catch((err) => {
      this.connecting = false;
      logError(TAG, 'Connection failed:', err);
    });
  }

  getManager(): LeanSessionManager | null {
    return this.manager;
  }

  /** Wait for the session to be ready. Resolves immediately if already ready. */
  whenReady(): Promise<LeanSessionManager> {
    if (this.manager) return Promise.resolve(this.manager);
    return new Promise((resolve) => {
      this.readyCallbacks.push(resolve);
    });
  }
}

export const leanSession = new LeanSessionHolder();

// Start immediately on import — this runs before React mounts.
leanSession.start();
