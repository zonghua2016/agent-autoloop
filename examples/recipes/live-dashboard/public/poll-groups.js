// Only equivalent scheduled outcomes share a display row. Each run remains independently selectable.
export function scheduledGroup(run) {
  if (!['done', 'nothing'].includes(run.state) || run.error || run.manual || run.attempts > 0 ||
      !run.events?.length || !run.events.every(e => e.source === 'schedule' && e.type === 'schedule.tick' && !e.subject)) return null;
  return JSON.stringify([run.rule, run.agent, run.state, run.summary, run.lane]);
}
