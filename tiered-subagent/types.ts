export const TIERS = ["lower", "default", "higher"] as const;
export type Tier = (typeof TIERS)[number];
export type AgentMode = "worker" | "advisor";
export type CompletionStatus =
	| "completed"
	| "completed with uncertainty"
	| "blocked"
	| "needs clarification"
	| "recommend higher tier"
	| "failed"
	| "cancelled";

export interface ModelProfile {
	provider: string;
	model: string;
	reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ExtensionConfig {
	tiers: Record<Tier, ModelProfile>;
	router?: ModelProfile;
	maxConcurrentAgents: number;
	timeoutMs: number;
	maxOutputBytes: number;
	maxDelegationDepth: number;
	workerTools: string[];
	allowedPaths: string[];
	protectedPaths: string[];
	higherTierRequiresConfirmation: boolean;
	fallbackToParentModel: boolean;
}

export interface DelegationResult {
	status: CompletionStatus;
	outcome: string;
	importantFindings: string[];
	filesInspected: string[];
	filesChanged: string[];
	commandsRun: string[];
	verification: string;
	unresolvedRisks: string[];
	uncertainty: string;
	escalationRecommendation: string;
	suggestedNextAction: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}
