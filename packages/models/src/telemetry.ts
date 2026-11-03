// LLM telemetry by the OpenTelemetry GenAI semantic conventions (D138), with @opentelemetry/api
// alone: a no-op until an SDK runs. Span and attribute names are written out here rather than
// imported from the conventions' incubating entry, which may rename them; a test pins them.
// No prompt, answer or tool argument is ever recorded: the Agent run row keeps what a person needs.
import {
  type Attributes,
  context,
  createContextKey,
  type Histogram,
  metrics,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export const GEN_AI = {
  operation: "gen_ai.operation.name",
  provider: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  tokenType: "gen_ai.token.type",
  agentName: "gen_ai.agent.name",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  errorType: "error.type",
} as const;

/** ANR's own: what a call cost, the role's chain, and every model tried with why it fell through. */
export const ANR_GEN_AI = {
  cost: "anr.cost_usd",
  chain: "anr.model.chain",
  attempts: "anr.model.attempts",
  agentRun: "anr.agent_run.id",
  node: "anr.graph.node",
} as const;

/** The conventions' provider names where one exists; others keep the catalog's name. */
const PROVIDERS: Record<string, string> = {
  gemini: "gcp.gemini",
  groq: "groq",
  mistral: "mistral_ai",
  openai: "openai",
  anthropic: "anthropic",
};
export const providerName = (catalogProvider: string): string =>
  PROVIDERS[catalogProvider] ?? catalogProvider;

const tracer = trace.getTracer("@anr/models");
const AGENT = createContextKey("anr.gen_ai.agent");

/** The role whose run is active (set by inAgent), for the attributes of its model calls. */
export const currentAgent = (): string | undefined =>
  context.active().getValue(AGENT) as string | undefined;

async function inSpan<T>(span: Span, fn: (span: Span) => Promise<T>): Promise<T> {
  try {
    return await fn(span);
  } catch (error) {
    span.setAttribute(GEN_AI.errorType, (error as Error).constructor?.name ?? "Error");
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

// Instruments are made on first use: a meter taken before the SDK starts is a no-op for good.
let instruments:
  | {
      duration: Histogram;
      tokens: Histogram;
      cost: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
      fallbacks: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
      runs: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
    }
  | undefined;
function meters() {
  if (instruments) return instruments;
  const meter = metrics.getMeter("@anr/models");
  instruments = {
    duration: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "Time of one model call, fallbacks included.",
    }),
    tokens: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Tokens one model call used.",
    }),
    cost: meter.createCounter("anr.gen_ai.cost_usd", {
      unit: "{USD}",
      description: "What model calls cost, from the catalog's prices.",
    }),
    fallbacks: meter.createCounter("anr.gen_ai.fallbacks", {
      unit: "{attempt}",
      description: "Models a call tried that did not answer.",
    }),
    runs: meter.createCounter("anr.agent.runs", {
      unit: "{run}",
      description: "Agent runs by role and how they ended.",
    }),
  };
  return instruments;
}

/** An `invoke_agent` span around one agent run; its model calls are labelled with its role. */
export function inAgent<T>(role: string, runId: string | undefined, fn: () => Promise<T>) {
  const attributes: Attributes = { [GEN_AI.operation]: "invoke_agent", [GEN_AI.agentName]: role };
  if (runId) attributes[ANR_GEN_AI.agentRun] = runId;
  return tracer.startActiveSpan(
    `invoke_agent ${role}`,
    { kind: SpanKind.INTERNAL, attributes },
    context.active().setValue(AGENT, role),
    async (span) => {
      let outcome = "error";
      try {
        const result = await inSpan(span, fn);
        outcome = "ok";
        return result;
      } finally {
        meters().runs.add(1, { [GEN_AI.agentName]: role, outcome });
      }
    },
  );
}

/** A span per LangGraph node, so a run's trace shows its steps with their model and tool calls. */
export function tracedNode<S, R>(
  graph: string,
  node: string,
  fn: (state: S) => Promise<R>,
): (state: S) => Promise<R> {
  return (state) =>
    tracer.startActiveSpan(
      `${graph}.${node}`,
      { attributes: { [ANR_GEN_AI.node]: node } },
      (span) => inSpan(span, () => fn(state)),
    );
}

/** An `execute_tool` span: the tool's name and the model's call id, never its arguments. */
export function executeTool<T>(name: string, callId: string | undefined, fn: () => Promise<T>) {
  const attributes: Attributes = {
    [GEN_AI.operation]: "execute_tool",
    [GEN_AI.toolName]: name,
    [GEN_AI.toolType]: "function",
  };
  if (callId) attributes[GEN_AI.toolCallId] = callId;
  const agent = currentAgent();
  if (agent) attributes[GEN_AI.agentName] = agent;
  return tracer.startActiveSpan(`execute_tool ${name}`, { attributes }, (span) => inSpan(span, fn));
}

export interface ChatCall {
  /** The provider and model tried first, which names the span. */
  provider: string;
  model: string;
  chain: readonly string[];
}

export interface ChatOutcome {
  provider: string;
  model: string;
  usage: { input: number; output: number };
  costUsd: number | null;
  attempts: { catalogId: string; outcome: string; detail?: string }[];
}

/** Each attempt that did not answer, as `<catalog id>: <outcome>`; a skip says why. */
export const describeAttempts = (attempts: ChatOutcome["attempts"]): string[] =>
  attempts.map((a) =>
    a.outcome === "skipped" && a.detail
      ? `${a.catalogId}: skipped (${a.detail})`
      : `${a.catalogId}: ${a.outcome}`,
  );

/**
 * A `chat` span (kind CLIENT) around one gateway call and its fallbacks, with the conventions'
 * metrics. `fn` returns the outcome, or throws with the attempts made on the error's `attempts`.
 */
export function chatSpan<T extends ChatOutcome>(call: ChatCall, fn: () => Promise<T>): Promise<T> {
  const agent = currentAgent();
  const base: Attributes = {
    [GEN_AI.operation]: "chat",
    [GEN_AI.provider]: providerName(call.provider),
    [GEN_AI.requestModel]: call.model,
  };
  if (agent) base[GEN_AI.agentName] = agent;
  const started = performance.now();
  return tracer.startActiveSpan(
    `chat ${call.model}`,
    { kind: SpanKind.CLIENT, attributes: { ...base, [ANR_GEN_AI.chain]: [...call.chain] } },
    (span) =>
      inSpan(span, async () => {
        const m = meters();
        let attempts: ChatOutcome["attempts"] = [];
        let metricAttributes: Attributes = base;
        try {
          const result = await fn();
          attempts = result.attempts;
          metricAttributes = {
            ...base,
            [GEN_AI.provider]: providerName(result.provider),
            [GEN_AI.responseModel]: result.model,
          };
          span.setAttributes({
            ...metricAttributes,
            [GEN_AI.inputTokens]: result.usage.input,
            [GEN_AI.outputTokens]: result.usage.output,
          });
          if (result.costUsd !== null) {
            span.setAttribute(ANR_GEN_AI.cost, result.costUsd);
            m.cost.add(result.costUsd, metricAttributes);
          }
          m.tokens.record(result.usage.input, { ...metricAttributes, [GEN_AI.tokenType]: "input" });
          m.tokens.record(result.usage.output, {
            ...metricAttributes,
            [GEN_AI.tokenType]: "output",
          });
          return result;
        } catch (error) {
          attempts = (error as { attempts?: ChatOutcome["attempts"] }).attempts ?? [];
          metricAttributes = { ...base, [GEN_AI.errorType]: (error as Error).constructor.name };
          throw error;
        } finally {
          // Set before inSpan ends the span: an ended span drops what is set on it.
          span.setAttribute(ANR_GEN_AI.attempts, describeAttempts(attempts));
          m.duration.record((performance.now() - started) / 1000, metricAttributes);
          for (const a of attempts)
            if (a.outcome !== "ok")
              m.fallbacks.add(1, {
                ...(agent ? { [GEN_AI.agentName]: agent } : {}),
                outcome: a.outcome,
              });
        }
      }),
  );
}
