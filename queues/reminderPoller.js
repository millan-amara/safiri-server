import Task from '../models/Task.js';
import Organization from '../models/Organization.js';
import { notify } from '../utils/notify.js';

const POLL_INTERVAL_MS = 60 * 1000;
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REMINDER_HOURS = 24;
const STARTUP_DELAY_MS = 5000;

let timer = null;
let running = false;
let stopped = false;

async function pollAndFire() {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_WINDOW_MS);

  const candidates = await Task.find({
    dueDate: { $ne: null, $gte: staleCutoff },
    status: { $nin: ['done', 'cancelled'] },
    reminderSentAt: null,
  })
    .populate('assignedTo', 'name phone email')
    .lean();

  if (!candidates.length) return;

  const orgIds = [...new Set(candidates.map(c => String(c.organization)))];
  const orgs = await Organization.find({ _id: { $in: orgIds } })
    .select('defaults.taskReminderHours plan')
    .lean();
  const orgById = new Map(orgs.map(o => [String(o._id), o]));

  for (const task of candidates) {
    try {
      if (!task.assignedTo) continue;

      const org = orgById.get(String(task.organization));
      const hours = task.reminderHours ?? org?.defaults?.taskReminderHours ?? DEFAULT_REMINDER_HOURS;
      if (hours <= 0) continue;

      const fireAt = new Date(new Date(task.dueDate).getTime() - hours * 60 * 60 * 1000);
      if (fireAt > now) continue;
      if (fireAt < staleCutoff) continue;

      // Atomic claim — only one poller can succeed.
      const claimed = await Task.findOneAndUpdate(
        { _id: task._id, reminderSentAt: null },
        { $set: { reminderSentAt: new Date() } },
      );
      if (!claimed) continue;

      try {
        await notify({
          plan: org?.plan,
          user: task.assignedTo,
          type: 'task_reminder',
          payload: { taskTitle: task.title, dueDate: task.dueDate },
        });
      } catch (err) {
        console.error(`[ReminderPoller] notify failed for task ${task._id}:`, err.message);
      }
    } catch (err) {
      console.error(`[ReminderPoller] processing failed for task ${task._id}:`, err);
    }
  }
}

async function tick() {
  if (stopped || running) return;
  running = true;
  try {
    await pollAndFire();
  } catch (err) {
    console.error('[ReminderPoller] tick failed:', err);
  } finally {
    running = false;
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  }
}

export function startReminderPoller() {
  if (timer || stopped) return;
  console.log('[ReminderPoller] started, polling every 60s');
  timer = setTimeout(tick, STARTUP_DELAY_MS);
}

export function stopReminderPoller() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, stopReminderPoller);
}
