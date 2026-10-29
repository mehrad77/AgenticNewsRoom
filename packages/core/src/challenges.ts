// Reader challenges (charter: corrections and challenges; D114): acknowledged within 24 hours,
// answered within 48, with a reminder before each deadline.

export const ACKNOWLEDGE_HOURS = 24;
export const ANSWER_HOURS = 48;
/** How long before a deadline the owner is reminded. */
export const REMINDER_HOURS = 6;

const HOUR = 3_600_000;

export interface ChallengeDeadlines {
  acknowledgeBy: Date;
  answerBy: Date;
}

export const challengeDeadlines = (created: Date): ChallengeDeadlines => ({
  acknowledgeBy: new Date(created.getTime() + ACKNOWLEDGE_HOURS * HOUR),
  answerBy: new Date(created.getTime() + ANSWER_HOURS * HOUR),
});

export interface ChallengeStep {
  step: "acknowledge" | "answer";
  at: "due" | "overdue";
  /** When the job runs. */
  when: Date;
}

/** The four jobs a new challenge queues: a reminder before each deadline, then the deadline. */
export function challengeSteps(d: ChallengeDeadlines): ChallengeStep[] {
  const before = (t: Date) => new Date(t.getTime() - REMINDER_HOURS * HOUR);
  return [
    { step: "acknowledge", at: "due", when: before(d.acknowledgeBy) },
    { step: "acknowledge", at: "overdue", when: d.acknowledgeBy },
    { step: "answer", at: "due", when: before(d.answerBy) },
    { step: "answer", at: "overdue", when: d.answerBy },
  ];
}
