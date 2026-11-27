// Keep state and user-supplied answers outside Markdown. Both card channels use the same layout.
export const plain = (content: string) => ({ tag: "div", text: { tag: "plain_text", content } });

export function header(title: string, template: string, state: string, subtitle?: string) {
  return {
    title: { tag: "plain_text", content: title },
    template,
    text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: state }, color: "neutral" }],
    ...(subtitle && { subtitle: { tag: "plain_text", content: subtitle } }),
  };
}

export function detail(text: string) {
  if (!text) return [];
  const labels: Record<string, string> = {
    测试页面: "打开测试页面",
    "缺陷详情（推荐在此操作）": "打开缺陷详情（推荐在此验收）",
    MR: "查看 MR",
  };
  const content = text
    .split("\n")
    .map((line) => {
      const match = /^(测试页面|缺陷详情（推荐在此操作）|MR)：(https?:\/\/[^\s<>\\]+)$/.exec(line);
      if (match) {
        const url = URL.parse(match[2]);
        if (url && !url.username && !url.password) {
          const href = url.href.replaceAll("(", "%28").replaceAll(")", "%29");
          return `[${labels[match[1]]}](${href}) · ${url.hostname}`;
        }
      }
      return line.replace(/^(复现步骤|预期结果|测试版本)：/, "**$1**\n");
    })
    .join("\n");
  return [{ tag: "markdown", content }];
}
