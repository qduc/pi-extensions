import { complete, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CONSOLIDATION_PROMPT, EXTRACTION_PROMPT } from "./prompts.ts";
import type { ModelInvocation, ModelInvoker } from "./types.ts";

function responseText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
}

/** Pi adapter for the portable ModelInvoker seam. Credentials stay in Pi's registry. */
export class PiModelInvoker implements ModelInvoker {
	private readonly registry: ModelRegistry;
	constructor(registry: ModelRegistry) { this.registry = registry; }

	async invoke(invocation: ModelInvocation): Promise<unknown> {
		const model = this.registry.find(invocation.model.provider, invocation.model.model);
		if (!model) throw new Error(`Memory model is unavailable: ${invocation.model.provider}/${invocation.model.model}`);
		const auth = await this.registry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(`Memory model credentials unavailable: ${auth.error}`);
		const prompt = invocation.purpose === "extract" ? EXTRACTION_PROMPT : CONSOLIDATION_PROMPT;
		const response = await complete(model as Model<any>, {
			systemPrompt: prompt,
			messages: [{ role: "user", content: JSON.stringify(invocation.input), timestamp: Date.now() }],
		}, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, temperature: 0, maxTokens: 2000, signal: invocation.signal });
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? "Memory model invocation failed");
		try { return JSON.parse(responseText(response)); }
		catch { throw new Error("Memory model returned non-JSON output"); }
	}
}

