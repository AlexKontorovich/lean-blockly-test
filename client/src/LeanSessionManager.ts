/**
 * LeanSessionManager — transport-layer wrapper around a Lean LSP
 * connection.
 *
 * Knows nothing about preambles, levels, line counts, or specific
 * Lean RPC method names. Provides three things to its callers:
 *
 *   1. Per-URI virtual file management (didOpen / didChange).
 *   2. File-progress observation (waitForProcessing + onProgress).
 *   3. A generic widget RPC call (`$/lean/rpc/call`), with the
 *      connect/keepalive/retry plumbing handled internally.
 *
 * Multi-URI is supported even though current callers use a single URI.
 * See plans/REFACTOR.md for the rationale.
 */
import type { MessageConnection } from './LeanLspClient';
import { log, logError } from './log';

const KEEPALIVE_PERIOD_MS = 10_000;
/**
 * If `waitForDiagnostics` does not see a fresh `publishDiagnostics`
 * within this many milliseconds after `waitForProcessing` resolves, it
 * gives up and resolves anyway. This handles Lean's "skip publish if
 * the diagnostic list is byte-identical to the previous batch"
 * optimization, which would otherwise hang the wait forever.
 */
const DIAGNOSTICS_WAIT_TIMEOUT_MS = 250;
const TAG = 'LeanSessionManager';

// ── Public types ─────────────────────────────────────────────────────

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface LspDiagnostic {
  range: Range;
  severity?: number;
  message: string;
  [key: string]: unknown;
}

export interface ProgressEntry {
  range: Range;
  /** 1 = Processing, 2 = FatalError (per Lean's LeanFileProgressKind) */
  kind?: number;
}

export interface Disposable {
  dispose(): void;
}

// ── Per-URI state ────────────────────────────────────────────────────

interface UriState {
  documentOpen: boolean;
  /** Highest LSP document version this client has sent for this URI. */
  latestSentVersion: number;
  /**
   * Highest version the server has finished elaborating, as inferred
   * from `$/lean/fileProgress` notifications: each `processing: []`
   * notification advances this to whatever `latestSentVersion` was at
   * the time. `waitForProcessing` resolves once this is at or past the
   * target version captured at call time.
   */
  latestProcessedVersion: number;
  /**
   * Highest version for which we have observed `publishDiagnostics`
   * from the server. If `publishDiagnostics` includes a `version`
   * field, that is used; otherwise we fall back to assuming the
   * notification corresponds to `latestSentVersion`. `waitForDiagnostics`
   * uses this to know when the cached diagnostics correspond to a
   * recent enough edit.
   */
  diagnosticsVersion: number;
  lastContent: string | null;
  diagnostics: LspDiagnostic[];
  /** Resolvers waiting for `latestProcessedVersion >= targetVersion`. */
  processingResolvers: Array<{ targetVersion: number; resolve: () => void }>;
  /** Resolvers waiting for `diagnosticsVersion >= targetVersion`. */
  diagnosticsResolvers: Array<{ targetVersion: number; resolve: () => void }>;
  progressListeners: Set<(processing: ProgressEntry[]) => void>;
  sessionId: string | null;
  keepAliveInterval: ReturnType<typeof setInterval> | null;
}

function newUriState(): UriState {
  return {
    documentOpen: false,
    latestSentVersion: 0,
    latestProcessedVersion: 0,
    diagnosticsVersion: 0,
    lastContent: null,
    diagnostics: [],
    processingResolvers: [],
    diagnosticsResolvers: [],
    progressListeners: new Set(),
    sessionId: null,
    keepAliveInterval: null,
  };
}

// ── LeanSessionManager ───────────────────────────────────────────────

export class LeanSessionManager {
  private connection: MessageConnection;
  private uriStates = new Map<string, UriState>();
  private disposables: Array<{ dispose(): void }> = [];

  constructor(connection: MessageConnection) {
    this.connection = connection;

    // fileProgress notifications
    this.disposables.push(
      connection.onNotification('$/lean/fileProgress', (params: any) => {
        const uri: string | undefined = params?.textDocument?.uri;
        if (!uri) return;
        const state = this.uriStates.get(uri);
        if (!state) return;

        const processing: ProgressEntry[] = params.processing ?? [];
        if (processing.length > 0) {
          log(TAG, `fileProgress[${shortUri(uri)}]: ${processing.length} range(s) still processing`);
        } else {
          log(TAG, `fileProgress[${shortUri(uri)}]: processing complete (v${state.latestSentVersion})`);
        }

        // Notify raw listeners.
        for (const cb of state.progressListeners) {
          try { cb(processing); } catch (err) { logError(TAG, 'progress listener threw:', err); }
        }

        // When processing is fully done, advance latestProcessedVersion
        // to whatever has been sent so far, and fire any waiters whose
        // target version has now been reached.
        if (processing.length === 0) {
          state.latestProcessedVersion = state.latestSentVersion;
          const stillWaiting: typeof state.processingResolvers = [];
          for (const r of state.processingResolvers) {
            if (state.latestProcessedVersion >= r.targetVersion) {
              r.resolve();
            } else {
              stillWaiting.push(r);
            }
          }
          state.processingResolvers = stillWaiting;
        }
      }),
    );

    // publishDiagnostics notifications
    this.disposables.push(
      connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
        const uri: string | undefined = params?.uri;
        if (!uri) return;
        const state = this.getOrCreateState(uri);
        state.diagnostics = params.diagnostics ?? [];

        // LSP `publishDiagnostics` may include the document version. If
        // present we trust it; otherwise we assume the diagnostics are
        // for the latest version we have sent (best-effort fallback).
        const incomingVersion: number = typeof params.version === 'number'
          ? params.version
          : state.latestSentVersion;
        if (incomingVersion > state.diagnosticsVersion) {
          state.diagnosticsVersion = incomingVersion;
        }

        log(TAG, `diagnostics[${shortUri(uri)}] (v${incomingVersion}): ${state.diagnostics.length} item(s)`,
          state.diagnostics.map((d) => `[sev=${d.severity}] ${d.message.slice(0, 80)}`));

        // Fire any qualifying waiters.
        const stillWaiting: typeof state.diagnosticsResolvers = [];
        for (const r of state.diagnosticsResolvers) {
          if (state.diagnosticsVersion >= r.targetVersion) {
            r.resolve();
          } else {
            stillWaiting.push(r);
          }
        }
        state.diagnosticsResolvers = stillWaiting;
      }),
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Resolves once the manager is ready to accept calls. The underlying
   * LSP `initialize`/`initialized` handshake is done by `LeanLspClient.connect`
   * before the connection is handed to this constructor, so this is a
   * trivial resolve — but kept as a Promise so callers don't need to
   * special-case construction order.
   */
  whenReady(): Promise<void> {
    return Promise.resolve();
  }

  // ── Document management ─────────────────────────────────────────

  /**
   * Set the contents of a virtual file. Sends `didOpen` the first time
   * a URI is seen, `didChange` afterward. No-ops if the content is
   * identical to the last value sent.
   */
  async updateFile(uri: string, content: string): Promise<void> {
    const state = this.getOrCreateState(uri);

    if (state.documentOpen && content === state.lastContent) {
      return;
    }

    // CRITICAL: mutate state synchronously BEFORE the first await, so
    // that concurrent calls with the same content short-circuit on the
    // identity check above. If we left `lastContent` unchanged until
    // after the await, multiple parallel `runEvaluation`s with the same
    // contribution would each see the old value, each decide to send a
    // didChange, and the server would process N redundant edits.
    const wasOpen = state.documentOpen;
    const version = ++state.latestSentVersion;
    state.lastContent = content;
    state.documentOpen = true;

    if (!wasOpen) {
      log(TAG, `didOpen[${shortUri(uri)}] (v${version}, ${content.length} chars)`);
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'lean4',
          version,
          text: content,
        },
      });
    } else {
      log(TAG, `didChange[${shortUri(uri)}] (v${version}, ${content.length} chars)`);
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version,
        },
        contentChanges: [{ text: content }],
      });
    }
  }

  // ── Processing ──────────────────────────────────────────────────

  /**
   * Resolves once the server has finished elaborating the document
   * version that was current at the time of the call. If processing has
   * already caught up (e.g. the caller hit the `updateFile` dedup
   * short-circuit and there is no edit in flight), resolves immediately.
   *
   * The version-aware design fixes a regression that occurred when only
   * the next `processing: []` notification was awaited: concurrent
   * `evaluate()` calls would arrive after the latest processing cycle
   * had already completed, then wait forever for a notification that
   * was never going to come again.
   */
  waitForProcessing(uri: string): Promise<void> {
    const state = this.getOrCreateState(uri);
    const targetVersion = state.latestSentVersion;
    if (state.latestProcessedVersion >= targetVersion) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      state.processingResolvers.push({ targetVersion, resolve });
    });
  }

  /**
   * Resolves once the cached diagnostics correspond to a document
   * version at or past the current `latestSentVersion`. If the cache
   * is already that fresh (e.g. publishDiagnostics arrived during
   * elaboration), resolves immediately. Otherwise waits for the next
   * publishDiagnostics — but with a hard timeout, because Lean skips
   * `publishDiagnostics` entirely when the new diagnostic set is
   * byte-identical to the previous one. In that case the cache is
   * already correct (the server is implicitly saying "no change") and
   * resolving on timeout is the right thing to do.
   */
  waitForDiagnostics(uri: string): Promise<void> {
    const state = this.getOrCreateState(uri);
    const targetVersion = state.latestSentVersion;
    if (state.diagnosticsVersion >= targetVersion) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let resolved = false;
      const wrapped = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      state.diagnosticsResolvers.push({ targetVersion, resolve: wrapped });
      setTimeout(wrapped, DIAGNOSTICS_WAIT_TIMEOUT_MS);
    });
  }

  /**
   * Subscribe to raw per-range progress updates for a URI. The callback
   * receives the latest `processing` array on every `$/lean/fileProgress`
   * notification (including the empty array when elaboration completes).
   */
  onProgress(uri: string, cb: (processing: ProgressEntry[]) => void): Disposable {
    const state = this.getOrCreateState(uri);
    state.progressListeners.add(cb);
    return {
      dispose: () => {
        state.progressListeners.delete(cb);
      },
    };
  }

  // ── Diagnostics ─────────────────────────────────────────────────

  /** Latest published diagnostics for a URI. */
  getDiagnostics(uri: string): LspDiagnostic[] {
    return this.uriStates.get(uri)?.diagnostics ?? [];
  }

  // ── Widget RPC ──────────────────────────────────────────────────

  /**
   * Make a Lean widget RPC call. Establishes the per-URI RPC session
   * (with keepalive) on first use. Retries once on "Outdated RPC session".
   *
   * `position` defaults to (0,0) if omitted; some Lean RPC methods are
   * position-sensitive (e.g. `getHypKinds` must be called at a position
   * after the @[server_rpc_method] declaration in the file).
   */
  async widgetRpcCall<T>(
    uri: string,
    method: string,
    params: unknown,
    position: Position = { line: 0, character: 0 },
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = await this.ensureRpcSession(uri);
      if (!sessionId) throw new Error(`Failed to establish RPC session for ${uri}`);

      try {
        const result = await this.connection.sendRequest('$/lean/rpc/call', {
          textDocument: { uri },
          position,
          sessionId,
          method,
          params,
        });
        return result as T;
      } catch (err: any) {
        if (err?.message?.includes('Outdated RPC session') && attempt === 0) {
          log(TAG, `widgetRpcCall[${method}]: outdated session, reconnecting`);
          this.disconnectRpc(uri);
          continue;
        }
        if (err?.message?.includes('closed file')) {
          // Caller will need to re-send updateFile.
          const state = this.getOrCreateState(uri);
          state.documentOpen = false;
          state.lastContent = null;
          this.disconnectRpc(uri);
        }
        throw err;
      }
    }
    throw new Error(`widgetRpcCall[${method}] failed after retries`);
  }

  // ── RPC session plumbing ────────────────────────────────────────

  private async ensureRpcSession(uri: string): Promise<string | null> {
    const state = this.getOrCreateState(uri);
    if (state.sessionId) return state.sessionId;

    log(TAG, `Connecting RPC session for ${shortUri(uri)}...`);
    try {
      const result: any = await this.connection.sendRequest('$/lean/rpc/connect', { uri });
      state.sessionId = result.sessionId;
      log(TAG, `RPC session connected, sessionId:`, state.sessionId);
      this.startKeepalive(uri);
      return state.sessionId;
    } catch (err: any) {
      logError(TAG, 'RPC connect failed:', err);
      if (err?.message?.includes('closed file')) {
        state.documentOpen = false;
        state.lastContent = null;
      }
      return null;
    }
  }

  private disconnectRpc(uri: string): void {
    const state = this.uriStates.get(uri);
    if (!state) return;
    if (state.keepAliveInterval) {
      clearInterval(state.keepAliveInterval);
      state.keepAliveInterval = null;
    }
    state.sessionId = null;
  }

  private startKeepalive(uri: string): void {
    const state = this.getOrCreateState(uri);
    if (state.keepAliveInterval) return;

    state.keepAliveInterval = setInterval(async () => {
      if (!state.sessionId) {
        if (state.keepAliveInterval) {
          clearInterval(state.keepAliveInterval);
          state.keepAliveInterval = null;
        }
        return;
      }
      try {
        await this.connection.sendNotification('$/lean/rpc/keepAlive', {
          uri,
          sessionId: state.sessionId,
        });
      } catch {
        if (state.keepAliveInterval) {
          clearInterval(state.keepAliveInterval);
          state.keepAliveInterval = null;
        }
        state.sessionId = null;
      }
    }, KEEPALIVE_PERIOD_MS);
  }

  // ── Debug ───────────────────────────────────────────────────────

  /**
   * Print the current state of the virtual filesystem to the console:
   * for each URI we've ever sent to Lean, the latest content along with
   * its version and document-open status. Intended to be called from
   * the browser devtools console.
   */
  dumpFiles(): void {
    if (this.uriStates.size === 0) {
      console.log('[LeanSessionManager] no files');
      return;
    }
    for (const [uri, state] of this.uriStates) {
      console.groupCollapsed(
        `[LeanSessionManager] ${uri}  (sent v${state.latestSentVersion}, processed v${state.latestProcessedVersion}, ${
          state.documentOpen ? 'open' : 'closed'
        }, ${state.lastContent?.length ?? 0} chars)`,
      );
      console.log(state.lastContent ?? '<no content>');
      console.groupEnd();
    }
  }

  // ── Utilities ───────────────────────────────────────────────────

  private getOrCreateState(uri: string): UriState {
    let state = this.uriStates.get(uri);
    if (!state) {
      state = newUriState();
      this.uriStates.set(uri, state);
    }
    return state;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  dispose(): void {
    for (const uri of this.uriStates.keys()) this.disconnectRpc(uri);
    this.uriStates.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function shortUri(uri: string): string {
  const i = uri.lastIndexOf('/');
  return i >= 0 ? uri.slice(i + 1) : uri;
}
