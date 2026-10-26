// Publisher: renders approved publications from templates, sends them to their channels and
// records each post idempotently. No agent is involved. Channels are added in milestone 4,
// the audio pipeline in milestone 5.
import { PgBoss } from "pg-boss";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error(error));
await boss.start();
console.log("publisher worker started");

const stop = async () => {
  await boss.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
