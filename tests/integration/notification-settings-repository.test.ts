import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/database/database";
import { NotificationSettingsRepository } from "../../src/main/repositories/notification-settings-repository";

describe("notification settings persistence", () => {
  let database: DatabaseSync;
  let settings: NotificationSettingsRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    settings = new NotificationSettingsRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  it("loads enabled desktop notification defaults", () => {
    expect(settings.get()).toEqual({
      desktopEnabled: true,
      desktopSound: true,
      brainstormNeedsAnswer: true,
      brainstormReadyForReview: true,
      brainstormFailed: true,
      executionCompleted: true,
      executionFailed: true,
    });
  });

  it("updates all notification toggles", () => {
    const updated = settings.update({
      desktopEnabled: true,
      desktopSound: false,
      brainstormNeedsAnswer: false,
      brainstormReadyForReview: true,
      brainstormFailed: false,
      executionCompleted: true,
      executionFailed: false,
    });

    expect(updated).toEqual({
      desktopEnabled: true,
      desktopSound: false,
      brainstormNeedsAnswer: false,
      brainstormReadyForReview: true,
      brainstormFailed: false,
      executionCompleted: true,
      executionFailed: false,
    });
    expect(settings.get()).toEqual(updated);
  });
});
