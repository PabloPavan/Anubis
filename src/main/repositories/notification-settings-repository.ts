import type { DatabaseSync } from "node:sqlite";
import type { NotificationSettings } from "../../shared/app";

interface NotificationSettingsRow {
  desktop_enabled: 0 | 1;
  desktop_sound: 0 | 1;
  brainstorm_needs_answer: 0 | 1;
  brainstorm_ready_for_review: 0 | 1;
  brainstorm_failed: 0 | 1;
  execution_completed: 0 | 1;
  execution_failed: 0 | 1;
  auto_resume_after_limit: 0 | 1;
}

function toBoolean(value: 0 | 1): boolean {
  return value === 1;
}

function toSettings(row: NotificationSettingsRow): NotificationSettings {
  return {
    desktopEnabled: toBoolean(row.desktop_enabled),
    desktopSound: toBoolean(row.desktop_sound),
    brainstormNeedsAnswer: toBoolean(row.brainstorm_needs_answer),
    brainstormReadyForReview: toBoolean(row.brainstorm_ready_for_review),
    brainstormFailed: toBoolean(row.brainstorm_failed),
    executionCompleted: toBoolean(row.execution_completed),
    executionFailed: toBoolean(row.execution_failed),
    autoResumeAfterLimit: toBoolean(row.auto_resume_after_limit),
  };
}

function toInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export class NotificationSettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(): NotificationSettings {
    const row = this.database
      .prepare(`
        SELECT
          desktop_enabled,
          desktop_sound,
          brainstorm_needs_answer,
          brainstorm_ready_for_review,
          brainstorm_failed,
          execution_completed,
          execution_failed,
          auto_resume_after_limit
        FROM notification_settings
        WHERE id = 1
      `)
      .get() as NotificationSettingsRow | undefined;

    if (!row) {
      throw new Error("Notification settings were not initialized.");
    }
    return toSettings(row);
  }

  update(input: NotificationSettings): NotificationSettings {
    this.database
      .prepare(`
        UPDATE notification_settings
        SET
          desktop_enabled = ?,
          desktop_sound = ?,
          brainstorm_needs_answer = ?,
          brainstorm_ready_for_review = ?,
          brainstorm_failed = ?,
          execution_completed = ?,
          execution_failed = ?,
          auto_resume_after_limit = ?,
          updated_at = ?
        WHERE id = 1
      `)
      .run(
        toInteger(input.desktopEnabled),
        toInteger(input.desktopSound),
        toInteger(input.brainstormNeedsAnswer),
        toInteger(input.brainstormReadyForReview),
        toInteger(input.brainstormFailed),
        toInteger(input.executionCompleted),
        toInteger(input.executionFailed),
        toInteger(input.autoResumeAfterLimit),
        new Date().toISOString(),
      );
    return this.get();
  }
}
