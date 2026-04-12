type LogLevel = "info" | "warn" | "error";

type LogPayload = Record<string, unknown>;

export function logEvent(level: LogLevel, event: string, payload: LogPayload = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...payload
  };

  const line = JSON.stringify(entry);

  switch (level) {
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}
