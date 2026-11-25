export function requirementSummary(context: unknown) {
  const events = context && typeof context === "object" && "events" in context ? context.events : undefined;
  if (!Array.isArray(events)) return "未提供需求摘要";
  const text = events
    .flatMap((event: unknown) => {
      if (!event || typeof event !== "object") return [];
      return ["summary", "detail"].flatMap((key) => {
        const value = (event as Record<string, unknown>)[key];
        return typeof value === "string" ? [value] : [];
      });
    })
    .join("\n\n");
  const points = Array.from(text);
  return points.length > 6000 ? points.slice(0, 5980).join("") + "\n（需求摘要已截短）" : text;
}
