type LogLevel = "info" | "warn" | "error";
type LogFormat = "json" | "pretty" | "silent";

type LogPayload = Record<string, unknown>;

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  blue: "\u001b[34m",
  yellow: "\u001b[33m",
  red: "\u001b[31m"
};

function getLogFormat(): LogFormat {
  const raw = process.env.LOG_FORMAT?.trim().toLowerCase();

  if (raw === "pretty" || raw === "silent" || raw === "json") {
    return raw;
  }

  return "json";
}

function colorForLevel(level: LogLevel): string {
  switch (level) {
    case "info":
      return ANSI.blue;
    case "warn":
      return ANSI.yellow;
    case "error":
      return ANSI.red;
  }
}

function formatPayload(payload: LogPayload): string {
  const entries = Object.entries(payload);

  if (entries.length === 0) {
    return "";
  }

  return entries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

export function logEvent(level: LogLevel, event: string, payload: LogPayload = {}): void {
  const format = getLogFormat();

  if (format === "silent") {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...payload
  };

  const line =
    format === "pretty"
      ? `${ANSI.dim}${entry.timestamp}${ANSI.reset} ${colorForLevel(level)}${level.toUpperCase()}${ANSI.reset} ${event}${payload ? ` ${formatPayload(payload)}` : ""}`
      : JSON.stringify(entry);

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
