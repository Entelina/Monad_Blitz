import { MONAD_WSS_URL } from "./chain";

export type MonadCommitState = "Proposed" | "Voted" | "Finalized" | "Verified";

export interface MonadHeadUpdate {
  blockNumber: bigint;
  blockId?: string;
  commitState: MonadCommitState;
  receivedAtMs: number;
}

/**
 * Browser WebSocket client subscribing directly to Monad's `monadNewHeads`
 * to track real `Proposed -> Voted -> Finalized -> Verified` commitState transitions.
 * Falls back cleanly to standard `newHeads` if an endpoint does not emit commitState.
 */
export class MonadCommitTracker {
  private ws: WebSocket | null = null;
  private listeners = new Set<(head: MonadHeadUpdate) => void>();
  private stateListeners = new Set<(connected: boolean) => void>();
  private blockStates = new Map<string, MonadCommitState>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  connect() {
    if (typeof window === "undefined") return;
    this.closed = false;
    try {
      const ws = new WebSocket(MONAD_WSS_URL);
      this.ws = ws;

      ws.onopen = () => {
        this.emitConnected(true);
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["monadNewHeads"],
          })
        );
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg?.method === "eth_subscription" && msg?.params?.result) {
            const res = msg.params.result;
            const rawNum = res.number;
            if (!rawNum) return;
            const blockNumber = BigInt(rawNum);
            const commitState: MonadCommitState =
              res.commitState === "Proposed" ||
              res.commitState === "Voted" ||
              res.commitState === "Finalized" ||
              res.commitState === "Verified"
                ? res.commitState
                : "Proposed";

            const key = blockNumber.toString();
            const rank: Record<MonadCommitState, number> = {
              Proposed: 1,
              Voted: 2,
              Finalized: 3,
              Verified: 4,
            };
            const prev = this.blockStates.get(key);
            if (!prev || rank[commitState] >= rank[prev]) {
              this.blockStates.set(key, commitState);
              // Keep map bounded
              if (this.blockStates.size > 200) {
                const firstKey = this.blockStates.keys().next().value;
                if (firstKey) this.blockStates.delete(firstKey);
              }
            }

            const update: MonadHeadUpdate = {
              blockNumber,
              blockId: res.blockId,
              commitState,
              receivedAtMs: Date.now(),
            };
            this.listeners.forEach((fn) => fn(update));
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        this.emitConnected(false);
      };

      ws.onclose = () => {
        this.emitConnected(false);
        if (!this.closed) {
          this.reconnectTimer = setTimeout(() => this.connect(), 2500);
        }
      };
    } catch {
      this.emitConnected(false);
    }
  }

  disconnect() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getBlockState(blockNumber: string): MonadCommitState | undefined {
    return this.blockStates.get(blockNumber);
  }

  onHead(fn: (head: MonadHeadUpdate) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  onConnectionChange(fn: (connected: boolean) => void) {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  private emitConnected(val: boolean) {
    this.stateListeners.forEach((fn) => fn(val));
  }
}
