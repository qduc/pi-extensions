export const DELEGATE_MODE_DESCRIPTION =
	"Execution capabilities. worker: can use configured repository tools within fileScope. advisor: has no repository tools and can reason only from explicitly supplied context.";

export const EXPLORER_TOOLS = ["read", "grep", "find", "ls", "submit_delegation_result"] as const;

export const DELEGATE_PROMPT_GUIDELINES = [
	"Use delegate only when a bounded task benefits from context isolation, specialization, or parallelism more than completing it directly.",
	"Keep architecture, ambiguous decisions, coordination, integration, and final acceptance in the parent agent.",
	"Use agentType explorer for bounded repository search and inspection; it always uses the lower tier with read-only repository tools.",
	"Worker mode can inspect files and use configured tools within fileScope.",
	"Advisor mode reasons only from explicitly supplied context and has no repository tools; include all evidence it needs in context.",
	"File review, implementation, and command execution require worker mode.",
	"An explicit higher-tier request defaults to advisor mode unless mode is set to worker.",
] as const;
