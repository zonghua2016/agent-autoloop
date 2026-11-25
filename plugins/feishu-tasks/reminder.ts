export function reminderFor(
  content: string,
  now: Date,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { at: number; when: string; text: string } | { error: string } | undefined {
  // The Feishu CLI can wrap multiline text messages in separate paragraphs.
  if (content.startsWith("<p>") && content.endsWith("</p>"))
    content = content.slice(3, -4).replace(/<\/p>\s*<p>|<br\s*\/?>/gu, "\n");
  const [heading, ...body] = content.split(/\r?\n/);
  const match =
    /^(今天|明天|后天|下?(?:周|星期)[一二三四五六日天])\s*(?:(早上|上午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分)?)\s*)?(?:的?待办[，,、：:\s]*)?(?:记得|请|帮我)?提醒我[，,：:\s]*(.*)$/u.exec(
      heading,
    );
  if (!match) return;
  const [, day, period, hours, clockMinutes, writtenMinutes, inline] = match;
  const text = [inline, ...body].join("\n").trim();
  const hour = Number(hours ?? 9);
  const minute = Number(clockMinutes ?? writtenMinutes ?? 0);
  if (!text) return { error: "请补充要提醒的内容。" };
  if (hour > 23 || minute > 59 || (period && (hour < 1 || hour > 12))) return { error: "请确认提醒时间，例如 09:30。" };
  const local = reminderSlot(now, timezone);
  const at = new Date(`${local.date}T${local.time}:00Z`);
  const isEvening = period === "下午" || period === "晚上";
  at.setUTCHours(isEvening && hour < 12 ? hour + 12 : period && !isEvening && hour === 12 ? 0 : hour, minute, 0, 0);
  if (day === "明天" || day === "后天") at.setUTCDate(at.getUTCDate() + (day === "明天" ? 1 : 2));
  else if (day !== "今天") {
    const weekday = "日一二三四五六".indexOf(day.endsWith("天") ? "日" : day.at(-1)!);
    const offset = day.startsWith("下")
      ? 8 - (at.getUTCDay() || 7) + (weekday || 7) - 1
      : (weekday - at.getUTCDay() + 7) % 7;
    at.setUTCDate(at.getUTCDate() + offset);
    if (fromZone(at.toISOString().slice(0, 16), timezone) <= now) at.setUTCDate(at.getUTCDate() + 7);
  }
  return scheduleReminder(at.toISOString().slice(0, 10), at.toISOString().slice(11, 16), text, now, timezone);
}

export function scheduleReminder(
  date: string,
  time: string | null,
  text: string,
  now: Date,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    (time !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
    !Number.isFinite(Date.parse(`${date}T${time ?? "09:00"}:00Z`))
  )
    return { error: "请再确认一下要提醒你的日期和时间。" };
  const at = fromZone(`${date}T${time ?? "09:00"}`, timezone);
  const { date: actualDate, time: actualTime } = reminderSlot(at, timezone);
  if (actualDate !== date || actualTime !== (time ?? "09:00") || at <= now)
    return { error: "这个提醒时间无效或已经过去，请告诉我新的时间。" };
  return scheduled(at, text, timezone);
}

function fromZone(wall: string, timezone: string) {
  const target = Date.parse(wall + ":00Z");
  let value = target;
  for (let i = 0; i < 3; i++) {
    const parts = reminderSlot(new Date(value), timezone);
    const actual = Date.parse(`${parts.date}T${parts.time}:00Z`);
    value += target - actual;
  }
  return new Date(value);
}
export function reminderSlot(at: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function reminderTimeChange(content: string) {
  const match =
    /^(?:改(?:为|到|成)|调(?:整)?到|挪到)\s*(?:(上午|早上|下午|晚上)\s*)?(\d{1,2})\s*(?:[:：](\d{2})|点\s*(?:(\d{1,2})\s*分?)?)\s*(?:吧|可以吗|行吗)?[。！!？?]?$/u.exec(
      content,
    );
  if (!match) return;
  const [, period, hours, clockMinutes, writtenMinutes] = match;
  const hour = Number(hours);
  const minute = Number(clockMinutes ?? writtenMinutes ?? 0);
  if (hour > 23 || minute > 59 || (period && (hour < 1 || hour > 12))) return { date: null, time: "invalid" };
  const localHour =
    (period === "下午" || period === "晚上") && hour < 12
      ? hour + 12
      : (period === "上午" || period === "早上") && hour === 12
        ? 0
        : hour;
  return { date: null, time: `${String(localHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function scheduled(at: Date, text: string, timezone: string) {
  const clock = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return {
    at: at.getTime(),
    when: `${Number(reminderSlot(at, timezone).date.slice(5, 7))}月${Number(reminderSlot(at, timezone).date.slice(8))}日 ${clock}`,
    text,
  };
}
