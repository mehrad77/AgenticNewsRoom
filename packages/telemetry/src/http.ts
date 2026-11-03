import { context } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";

/**
 * Names the current request's HTTP server span and its duration metric by route
 * (`GET /desk/newsrooms/:newsroom/queue`), for a framework the HTTP instrumentation does not know.
 * The instrumentation reads it when the response ends; outside a traced request it does nothing.
 */
export function setHttpRoute(route: string): void {
  const metadata = getRPCMetadata(context.active());
  if (metadata?.type === RPCType.HTTP) metadata.route = route;
}
