import type { Proposal } from "./inbox.ts";

export function renderProposal(proposal: Proposal) {
  const labels = {
    draft: "待确认",
    clarify: "待补充",
    queued: "已派发",
    finished: "本轮已结束",
    cancelled: "已取消",
    superseded: "摘要已更新",
  };
  const buttons =
    proposal.status === "draft"
      ? [
          {
            tag: "column_set",
            flex_mode: "none",
            columns: (["confirm", "cancel"] as const).map((action) => ({
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "interactive_container",
                  width: "fill",
                  has_border: true,
                  border_color: action === "confirm" ? "blue" : "grey",
                  corner_radius: "8px",
                  padding: "8px 12px 8px 12px",
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        kind: proposal.archive ? "autoloop-archive" : "autoloop-task",
                        task: proposal.task,
                        revision: proposal.revision,
                        action,
                      },
                    },
                  ],
                  elements: [
                    {
                      tag: "div",
                      text: {
                        tag: "plain_text",
                        content:
                          action === "confirm"
                            ? proposal.archive
                              ? "确认归档"
                              : proposal.verify
                                ? "开始验收"
                                : "确认"
                            : "取消",
                      },
                    },
                  ],
                },
              ],
            })),
          },
        ]
      : [];
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: {
        tag: "plain_text",
        content: proposal.archive
          ? `任务归档 ${proposal.task}`
          : `${proposal.delivery?.title ?? labels[proposal.status]}任务 ${proposal.task}`,
      },
      template: proposal.delivery
        ? proposal.delivery.title === "已合并"
          ? "green"
          : "grey"
        : proposal.status === "draft"
          ? "blue"
          : proposal.status === "queued" || proposal.status === "finished"
            ? "green"
            : "grey",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: proposal.delivery ? proposal.text.replace(/^待确认任务 [a-f0-9]{12}\n/, "") : proposal.text,
        },
        ...(proposal.status === "draft"
          ? []
          : [
              {
                tag: "div",
                text: {
                  tag: "plain_text",
                  content: proposal.delivery
                    ? proposal.delivery.text
                    : proposal.status === "superseded"
                      ? "这份摘要已失效，请使用最新确认卡片。"
                      : `当前状态：${labels[proposal.status]}。`,
                },
              },
            ]),
        ...buttons,
      ],
    },
  };
}
