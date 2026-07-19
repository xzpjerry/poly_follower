export type EventDateSelector = "today" | "tomorrow" | `${number}-${number}-${number}`;

function localCalendarDate(nowMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));
  if (![year, month, day].every(Number.isInteger)) {
    throw new Error(`Could not resolve the current calendar date in ${timeZone}`);
  }
  return { year, month, day };
}

export function resolveEventDate(
  selector: EventDateSelector,
  timeZone: string,
  nowMs = Date.now(),
): string {
  if (selector !== "today" && selector !== "tomorrow") {
    return selector;
  }

  const { year, month, day } = localCalendarDate(nowMs, timeZone);
  const dayOffset = selector === "tomorrow" ? 1 : 0;
  return new Date(Date.UTC(year, month - 1, day + dayOffset)).toISOString().slice(0, 10);
}
