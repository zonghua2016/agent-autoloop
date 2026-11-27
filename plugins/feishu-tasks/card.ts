import { detail, header, plain } from "../feishu/card-layout.ts";
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
    header: header(
      proposal.archive ? "任务归档" : proposal.verify ? "网页验收" : "任务跟进",
      proposal.delivery?.stage === "blocked" || proposal.status === "clarify"
        ? "orange"
        : proposal.delivery?.title === "已合并"
          ? "green"
          : proposal.status === "draft" || proposal.status === "queued"
            ? "blue"
            : "grey",
      proposal.delivery?.title ?? labels[proposal.status],
      "任务 " + proposal.task,
    ),
    body: {
      elements: [
        ...(proposal.delivery ? [plain(proposal.delivery.text), { tag: "hr" }] : []),
        ...(proposal.status === "superseded" ? [plain("请使用最新确认卡片。")] : []),
        ...detail(proposal.text.replace(/^待确认任务 [a-f0-9]{12}\n/, "")),
        ...(buttons.length ? [{ tag: "hr" }] : []),
        ...buttons,
      ],
    },
  };
}
