// Publisher: renders approved publications from templates, sends them to their channels and
// records each post idempotently. No agent is involved. Channels are added in milestone 4,
// the audio pipeline in milestone 5.
import { createBoss } from "@anr/db";
import { registerJobs } from "./jobs.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = createBoss(connectionString, "publisher");
await boss.start();
await registerJobs(boss);
console.log("publisher worker started");

const stop = async () => {
  await boss.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
