import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations";

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const database = new DatabaseSync(filename);
  runMigrations(database);
  return database;
}
