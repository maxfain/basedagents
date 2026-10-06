export type McpToolOutcome = 'ok' | 'tool_error' | 'api_error' | 'auth_required' | 'payment_required' | 'network_error';
/**
 * BASEDAGENTS_TELEMETRY=off is this package's documented switch;
 * BASEDAGENTS_NO_TELEMETRY=1 is honored as an alias so one opt-out covers the
 * MCP server and the CLI. Off disables optional analytics only — registrations, tasks,
 * receipts and payments still produce their required operational records.
 */
export declare function telemetryEnabled(): boolean;
/**
 * The state file lives in the platform's application-state directory —
 * deliberately NOT next to keypair files, and the id is a plain random UUID,
 * never derived from a key, hostname, email, wallet or network address. One
 * file = one installation profile; a distinct profile on the same machine
 * sets BASEDAGENTS_ATTRIBUTION_STATE_PATH.
 */
export declare function attributionStatePath(): string;
/**
 * Load — or mint once — the installation id. The first writer wins
 * atomically: the record is written to a temp file, then hard-linked to the
 * final path, which fails with EEXIST if another process got there first — in
 * which case that process's id is read and used. A linked file is always
 * complete, so an existing file that doesn't parse is genuinely corrupt and is
 * replaced. Any failure returns null: the server runs unattributed rather than
 * minting a new "installation" per launch.
 */
export declare function loadInstallationId(path?: string): Promise<string | null>;
export interface AttributionInit {
    apiUrl: string;
    version: string;
    argv?: string[];
    env?: NodeJS.ProcessEnv;
}
/**
 * Parse config and load the installation identity. Never throws and never
 * blocks startup on anything but the one state-file read/write.
 */
export declare function initAttribution(init: AttributionInit): Promise<void>;
/** The MCP client's self-reported name/version arrives at `initialize`; read lazily. */
export declare function setClientInfoProvider(fn: () => {
    name?: string;
    version?: string;
} | undefined): void;
/**
 * The optional attribution headers for one outgoing API request. Empty when
 * telemetry is off. Spread BEFORE auth headers so nothing here can ever shadow
 * Authorization/X-Timestamp/X-Nonce.
 */
export declare function attributionHeaders(): Record<string, string>;
/**
 * Let the result helpers (noAuthResult, taskErrorResult, escrowChallengeResult)
 * name the real outcome of the current tool call — an HTTP 200 carrying an MCP
 * tool error must never be reported as success, and a 402 handshake is
 * payment_required, never funding. No-op outside a tool call or when off.
 */
export declare function markOutcome(outcome: McpToolOutcome, errorCode?: string): void;
/**
 * Run one tool invocation inside its own AsyncLocalStorage context: a fresh
 * tool_call_id (stable across every internal API request/retry of this
 * invocation, distinct across concurrent calls), headers carrying tool
 * name/id, and one reported final outcome.
 */
export declare function runTool<T>(toolName: string, fn: () => Promise<T>): Promise<T>;
export declare function flushTelemetry(): Promise<void>;
/**
 * Deliver what's queued when the session ends. MCP clients end a stdio
 * server by closing its stdin (then waiting ~2 s before SIGTERM), so a short
 * session with fewer than a batch of calls still reports them. Bounded by the
 * request timeout; the in-flight request is what keeps the process alive long
 * enough to send it.
 */
export declare function installShutdownFlush(): void;
//# sourceMappingURL=attribution.d.ts.map