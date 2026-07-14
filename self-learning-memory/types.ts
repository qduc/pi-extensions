export const MEMORY_TYPES = ["preference", "fact", "constraint", "decision", "correction", "lesson", "procedure", "observation"] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
export const SCOPES = ["global", "user", "organization", "project", "repository", "workspace", "branch", "environment", "session"] as const;
export type ScopeKind = typeof SCOPES[number];
export interface Scope { kind: ScopeKind; value?: string; }
export const isScope = (value: unknown): value is Scope => !!value && typeof value === "object" && SCOPES.includes((value as Scope).kind) && ((value as Scope).value === undefined || typeof (value as Scope).value === "string");
export interface EvidenceRef { sessionId: string; eventIds: string[]; }
export interface SessionEvent { id: string; role: "user" | "assistant" | "tool" | "system"; text: string; timestamp?: string; }
export interface CompletedSession { id: string; request: string; events: SessionEvent[]; scope?: Scope; completedAt?: string; complexity?: "routine" | "complex" | "high-value"; model?: ModelProfile; }
export interface ModelProfile { provider: string; model: string; thinking: string; tools?: string[]; promptPrefix?: string; }
export interface MemoryCandidate { id: string; type: MemoryType; scope: Scope; statement: string; rationale: string; confidence: number; sourceSessionId: string; evidence: EvidenceRef[]; suggestedAction: "create" | "defer" | "reject" | "update" | "forget"; targetMemoryId?: string; uncertainty?: string; createdAt: string; explicit?: boolean; }
export interface CandidateOutcome { candidateId: string; action: "created" | "merged" | "updated" | "rejected" | "deferred" | "forgotten"; memoryId?: string; reason: string; decidedAt: string; }
export interface DurableMemory { id: string; type: "preference" | "fact" | "constraint" | "decision" | "lesson" | "procedure"; scope: Scope; statement: string; rationale: string; confidence: number; createdAt: string; confirmedAt: string; sourceSessionIds: string[]; evidence: EvidenceRef[]; revisions: { at: string; statement: string; reason: string }[]; archived?: boolean; }
export interface StoredSession { id: string; request: string; events: SessionEvent[]; scope: Scope; completedAt: string; complexity: "routine" | "complex" | "high-value"; model?: ModelProfile; digest: string; }
export interface ExtractionRecord { sessionId: string; status: "completed" | "empty" | "failed"; attemptedAt: string; candidateCount: number; error?: string; }
export interface MemoryState { version: 1; sessions: StoredSession[]; candidates: MemoryCandidate[]; outcomes: CandidateOutcome[]; memories: DurableMemory[]; extractions: ExtractionRecord[]; }
export interface MemoryStatus { sessions: number; durableMemories: number; pendingCandidates: number; stateBytes: number; extractions: { completed: number; empty: number; failed: number }; }
export interface RetrievalRequest { request: string; scope?: Scope; limit?: number; includeProcedures?: boolean; }
export interface RetrievalResult { memories: DurableMemory[]; references: string[]; }
export interface ModelInvocation { purpose: "extract" | "consolidate"; model: ModelProfile; input: unknown; signal?: AbortSignal; }
export interface ModelInvoker { invoke(invocation: ModelInvocation): Promise<unknown>; }
export interface ConsolidationDecision { candidateId: string; action: "create" | "merge" | "update" | "reject" | "defer" | "forget"; memoryId?: string; reason: string; }
export interface MemoryEngine { completeSession(session: CompletedSession): Promise<StoredSession>; retrieve(request: RetrievalRequest): Promise<RetrievalResult>; inspect(id: string, scope?: Scope): Promise<DurableMemory | undefined>; searchSessions(query: string, limit?: number, scope?: Scope): Promise<StoredSession[]>; propose(candidate: Omit<MemoryCandidate, "id" | "createdAt">): Promise<MemoryCandidate>; forget(memoryId: string, reason: string, scope?: Scope): Promise<MemoryCandidate>; purge(memoryId: string, scope?: Scope): Promise<boolean>; status(): Promise<MemoryStatus>; pendingCandidates(limit?: number, scope?: Scope): Promise<MemoryCandidate[]>; runExtraction(sessionId?: string, signal?: AbortSignal, scope?: Scope): Promise<MemoryCandidate[]>; runConsolidation(limit?: number, signal?: AbortSignal, scope?: Scope): Promise<CandidateOutcome[]>; }

