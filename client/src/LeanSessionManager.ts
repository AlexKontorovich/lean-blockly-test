/**
 * LeanSessionManager — transport-layer wrapper around a Lean LSP
 * connection.
 *
 * Knows nothing about preambles, levels, line counts, or specific
 * Lean RPC method names. Provides three things to its callers:
 *
 *   1. Per-URI virtual file management (didOpen / didChange).
 *   2. A generic widget RPC call (`$/lean/rpc/call`), with the
 *      connect/keepalive/retry plumbing handled internally.
 *   3. An optional `onProgress` subscription on `$/lean/fileProgress`
 *      for callers that want raw per-range progress updates (e.g. for
 *      future per-block "checked" status indicators).
 *
 * Notably absent: any state tracking for `publishDiagnostics`, any
 * `waitForProcessing` / `waitForDiagnostics` machinery, or any
 * version-correlation between push notifications. Higher layers
 * (`LevelEvaluator`) get the data they need by calling
 * `Lean.Widget.getInteractiveDiagnostics` via `widgetRpcCall` — that
 * RPC is request/response and the server holds the response until the
 * relevant snapshot is ready, so there is no race to manage.
 *
 * Multi-URI is supported even though current callers use a single URI.
 */
import type { MessageConnection } from './LeanLspClient';
import { log, logError } from './log';

const KEEPALIVE_PERIOD_MS = 10_000;
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
   * Highest version the server has finished elaborating, inferred from
   * `$/lean/fileProgress` notifications: each `processing: []`
   * notification advances this to whatever `latestSentVersion` was at
   * the time. `waitForProcessing` resolves once this is at or past the
   * target version captured at call time.
   */
  latestProcessedVersion: number;
  lastContent: string | null;
  /** Resolvers waiting for `latestProcessedVersion >= targetVersion`. */
  processingResolvers: Array<{ targetVersion: number; resolve: () => void }>;
  progressListeners: Set<(processing: ProgressEntry[]) => void>;
  sessionId: string | null;
  keepAliveInterval: ReturnType<typeof setInterval> | null;
}

function newUriState(): UriState {
  return {
    documentOpen: false,
    latestSentVersion: 0,
    latestProcessedVersion: 0,
    lastContent: null,
    processingResolvers: [],
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

    // fileProgress notifications. Used both by `waitForProcessing` (to
    // know when the server has finished elaborating a given version)
    // and by `onProgress` subscribers (raw per-range stream for future
    // per-block status work).
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

        for (const cb of state.progressListeners) {
          try { cb(processing); } catch (err) { logError(TAG, 'progress listener threw:', err); }
        }

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

    // We deliberately do NOT subscribe to `textDocument/publishDiagnostics`.
    // The push-style diagnostics stream is unreliable for our needs (it
    // races with `fileProgress`, may be deduped by the server, etc.) and
    // we get a strictly better, request/response equivalent by calling
    // `Lean.Widget.getInteractiveDiagnostics` via `widgetRpcCall`.
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
    // after the await, multiple parallel callers with the same content
    // would each see the old value, each decide to send a didChange,
    // and the server would process N redundant edits.
    const wasOpen = state.documentOpen;
    const version = ++state.latestSentVersion;
    state.lastContent = content;
    state.documentOpen = true;

    if (!wasOpen) {
      log(TAG, `didOpen[${shortUri(uri)}] (v${version}, ${content.length} chars)`);
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'lean4', version, text: content },
      });
    } else {
      log(TAG, `didChange[${shortUri(uri)}] (v${version}, ${content.length} chars)`);
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
  }

  // ── Progress observation ────────────────────────────────────────

  /**
   * Resolves once the server has finished elaborating the document
   * version that was current at the time of the call. If processing
   * has already caught up (e.g. the caller hit the `updateFile` dedup
   * short-circuit and there is no edit in flight), resolves immediately.
   *
   * This must be awaited *between* `updateFile` and any widget RPC call
   * whose result depends on the latest edit being elaborated. Lean's
   * widget RPCs do NOT block on elaboration — they return data for the
   * most recently elaborated snapshot, which during typing is the
   * previous (often stale) version.
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

  // ── Widget RPC ──────────────────────────────────────────────────

  /**
   * Make a Lean widget RPC call. Establishes the per-URI RPC session
   * (with keepalive) on first use. Retries once on "Outdated RPC session".
   *
   * Lean's widget RPC methods (notably `Lean.Widget.getInteractiveDiagnostics`)
   * are request/response and hold the response until the relevant
   * elaboration snapshot is ready. That property is what makes the rest
   * of this class so simple — callers don't need to manually wait for
   * processing or diagnostics; the RPC call itself blocks until the
   * server has an answer.
   *
   * `position` defaults to (0,0); some Lean RPC methods are position-
   * sensitive (e.g. `getHypKinds` must be called at a position after
   * the @[server_rpc_method] declaration in the file).
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
