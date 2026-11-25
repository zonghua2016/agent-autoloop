// Budget the encoded representation, since quotes and control characters expand when serialized.
export function fitJson(fields: Record<string, string | string[] | undefined>, limit = 4000) {
  const complete = JSON.stringify(fields);
  if (complete.length <= limit) return complete;
  const encode = (size: number) =>
    JSON.stringify({
      ...Object.fromEntries(
        Object.entries(fields).map(([key, value]) => {
          const clip = (text: string) => Array.from(text).slice(0, size).join("");
          return [key, Array.isArray(value) ? value.map(clip) : value === undefined ? undefined : clip(value)];
        }),
      ),
      truncated: true,
    });
  if (encode(0).length > limit) throw new Error("结构化资料字段过多，无法放入事件详情");
  let low = 0,
    high = complete.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encode(middle).length <= limit) low = middle;
    else high = middle - 1;
  }
  return encode(low);
}
