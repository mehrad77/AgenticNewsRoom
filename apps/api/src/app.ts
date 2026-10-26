import { Hono } from "hono";
import type { components } from "./generated/api.ts";

type Health = components["schemas"]["Health"];

export const app = new Hono();

app.get("/healthz", (c) => c.json<Health>({ status: "ok", service: "api" }));
