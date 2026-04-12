import { Queue, Worker } from 'bullmq';
import Task from '../models/Task.js';
import { notifyTaskReminder } from '../utils/whatsapp.js';

// Read env vars lazily — called after dotenv.config() has run
function getConnection() {
  return {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    // Exponential backoff — caps at 30s, so a bad host doesn't flood the log
    retryStrategy: (times) => Math.min(times * 2000, 30000),
  };
}

let _queue = null;
function getQueue() {
  if (!_queue) _queue = new Queue('task-reminders', { connection: getConnection() });
  return _queue;
}

// ─── SCHEDULE / CANCEL ───────────────────────────────────

export async function scheduleTaskReminder(taskId, dueDate, reminderHours) {
  // Always cancel first — acts as an upsert so edits replace cleanly
  await cancelTaskReminder(taskId);

  if (!dueDate || !reminderHours || reminderHours <= 0) return;

  const fireAt = new Date(new Date(dueDate).getTime() - reminderHours * 60 * 60 * 1000);
  const delay = fireAt.getTime() - Date.now();

  if (delay <= 0) return; // Reminder time already passed

  await getQueue().add(
    'send-reminder',
    { taskId: taskId.toString() },
    {
      delay,
      jobId: `task-reminder-${taskId}`,  // deterministic — easy to cancel without storing ID
      removeOnComplete: true,
      removeOnFail: { count: 3 },
    }
  );
}

export async function cancelTaskReminder(taskId) {
  try {
    const job = await getQueue().getJob(`task-reminder-${taskId}`);
    if (job) await job.remove();
  } catch {
    // Job doesn't exist — fine
  }
}

// ─── WORKER ──────────────────────────────────────────────

export function startReminderWorker() {
  const worker = new Worker(
    'task-reminders',
    async (job) => {
      const { taskId } = job.data;
      const task = await Task.findById(taskId).populate('assignedTo', 'name phone');

      if (!task) return;                                          // deleted
      if (['done', 'cancelled'].includes(task.status)) return;   // completed before reminder fired
      if (!task.dueDate) return;

      if (!task.assignedTo?.phone) {
        console.warn(`[ReminderQueue] Skipped — assignee of "${task.title}" has no phone`);
        return;
      }

      await notifyTaskReminder({
        to: task.assignedTo.phone,
        userName: task.assignedTo.name,
        taskTitle: task.title,
        dueDate: task.dueDate,
      });
    },
    { connection: getConnection() }
  );

  worker.on('failed', (job, err) => {
    console.error(`[ReminderQueue] Job ${job?.id} failed:`, err.message);
  });

  worker.on('ready', () => {
    console.log('[ReminderQueue] Worker ready');
  });

  return worker;
}
