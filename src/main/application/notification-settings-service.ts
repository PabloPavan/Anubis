import type { DesktopNotificationTestKind, NotificationSettings } from "../../shared/app";
import { InputValidationError } from "../../shared/projects";
import { DesktopNotificationService } from "./desktop-notification-service";
import { NotificationSettingsRepository } from "../repositories/notification-settings-repository";

function booleanField(record: Record<string, unknown>, field: keyof NotificationSettings): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new InputValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function parseTestKind(value: unknown): DesktopNotificationTestKind {
  const kinds: DesktopNotificationTestKind[] = [
    "brainstormNeedsAnswer",
    "brainstormReadyForReview",
    "brainstormFailed",
    "executionCompleted",
    "executionFailed",
  ];
  if (typeof value !== "string" || !kinds.includes(value as DesktopNotificationTestKind)) {
    throw new InputValidationError("Notification test kind is invalid.");
  }
  return value as DesktopNotificationTestKind;
}

export class NotificationSettingsService {
  constructor(
    private readonly settings: NotificationSettingsRepository,
    private readonly desktopNotifications: DesktopNotificationService,
  ) {}

  get(): NotificationSettings {
    return this.settings.get();
  }

  update(value: unknown): NotificationSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new InputValidationError("Expected notification settings.");
    }
    const record = value as Record<string, unknown>;
    return this.settings.update({
      desktopEnabled: booleanField(record, "desktopEnabled"),
      desktopSound: booleanField(record, "desktopSound"),
      brainstormNeedsAnswer: booleanField(record, "brainstormNeedsAnswer"),
      brainstormReadyForReview: booleanField(record, "brainstormReadyForReview"),
      brainstormFailed: booleanField(record, "brainstormFailed"),
      executionCompleted: booleanField(record, "executionCompleted"),
      executionFailed: booleanField(record, "executionFailed"),
    });
  }

  testDesktopNotification(value: unknown): void {
    this.desktopNotifications.test(parseTestKind(value));
  }
}
