import { RedisStorage } from '../storage/redis';
import { Job, JobOptions, JobState } from '../models/job';
import { Queue, QueueOptions } from '../models/queue';
import { v4 as uuidv4 } from 'uuid';
import { QueueXEvent } from '../lib';
import { CronParser } from '../utils/cron-parser';

/**
 * Manages queues and job scheduling with dependency resolution and cron support.
 */
export class QueueManager {
  private storage: RedisStorage;
  private queues: Map<string, Queue> = new Map();
  private emitEvent: (event: QueueXEvent, job: Job) => void;
  private dependencyGraph: Map<string, Job> = new Map();
  private schedulerInterval: NodeJS.Timeout | null = null;

  constructor(redisConnectionString: string, emitEvent: (event: QueueXEvent, job: Job) => void) {
    this.storage = new RedisStorage(redisConnectionString);
    this.emitEvent = emitEvent;
    this.startScheduler().catch((err) => console.error('Scheduler startup failed:', err));
    this.processOverdueJobs().catch((err) => console.error('Overdue job processing failed:', err));
  }

  createQueue(name: string, options: QueueOptions = {}): Queue {
    const queue: Queue = { name, options };
    this.queues.set(name, queue);
    return queue;
  }

  async enqueue(queueName: string, data: any, options: JobOptions = {}): Promise<Job> {
    const queue = this.queues.get(queueName);
    if (!queue) throw new Error(`Queue ${queueName} not found`);

    const job: Job = {
      id: uuidv4(),
      queue: queueName,
      data,
      state: this.getInitialState(options),
      options: { priority: 'medium', retries: 3, ...options },
      attempts: 0,
      createdAt: Date.now(),
      scheduledAt: this.getScheduledAt(options),
      logs: [],
      dependencies: options.dependsOn || [],
      dependents: [],
    };

    this.dependencyGraph.set(job.id, job);

    if (job.dependencies) {
      for (const depId of job.dependencies) {
        const depJob = this.dependencyGraph.get(depId);
        if (depJob) {
          depJob.dependents = depJob.dependents || [];
          depJob.dependents.push(job.id);
          this.dependencyGraph.set(depId, depJob);
        } else {
          throw new Error(`Dependency job ${depId} not found`);
        }
      }
    }

    try {
      await this.storage.enqueueJob(job);
      if (options.cron || options.delay) this.emitEvent('jobDelayed', job);
      else if (options.dependsOn?.length) this.emitEvent('jobPending', job);
    } catch (err) {
      throw new Error(`Failed to enqueue job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return job;
  }

  private getInitialState(options: JobOptions): JobState {
    if (options.dependsOn?.length) return JobState.PENDING;
    if (options.delay || options.cron) return JobState.DELAYED;
    return JobState.WAITING;
  }

  private getScheduledAt(options: JobOptions): number | undefined {
    if (options.delay) return Date.now() + options.delay;
    if (options.cron) {
      try {
        const parser = new CronParser(options.cron);
        return parser.next().getTime();
      } catch (err) {
        throw new Error(`Invalid cron expression: ${options.cron} - ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  }

  async getJob(queueName: string): Promise<Job | null> {
    try {
      const job = await this.storage.getNextJob(queueName);
      if (!job) return null;

      if (job.dependencies?.length) {
        const allDepsCompleted = job.dependencies.every((depId) => {
          const depJob = this.dependencyGraph.get(depId);
          return depJob?.state === JobState.COMPLETED;
        });

        if (!allDepsCompleted) {
          job.state = JobState.PENDING;
          await this.storage.enqueueJob(job);
          this.emitEvent('jobPending', job);
          return null;
        }
      }
      return job;
    } catch (err) {
      throw new Error(`Failed to get job from queue ${queueName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getJobById(jobId: string): Job | undefined {
    return this.dependencyGraph.get(jobId);
  }

  async unscheduleJob(jobId: string): Promise<void> {
    const job = this.dependencyGraph.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.state !== JobState.DELAYED) throw new Error(`Job ${jobId} is not in DELAYED state`);

    try {
      await this.storage.removeScheduledJob(job.queue, jobId);
      this.dependencyGraph.delete(jobId);
      this.emitEvent('jobFailed', { ...job, state: JobState.FAILED, logs: [...job.logs, 'Job unscheduled'] });
    } catch (err) {
      throw new Error(`Failed to unschedule job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async updateJobDelay(jobId: string, newDelay: number): Promise<Job> {
    const job = this.dependencyGraph.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (![JobState.DELAYED, JobState.PENDING].includes(job.state)) {
      throw new Error(`Cannot update delay for job ${jobId} in state ${job.state}`);
    }

    try {
      job.options.delay = newDelay;
      delete job.options.cron;
      job.scheduledAt = Date.now() + newDelay;
      job.state = JobState.DELAYED;
      job.logs.push(`Delay updated to ${newDelay}ms at ${Date.now()}`);
      await this.storage.enqueueJob(job);
      this.dependencyGraph.set(jobId, job);
      this.emitEvent('jobDelayed', job);
      return job;
    } catch (err) {
      throw new Error(`Failed to update delay for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async processOverdueJobs(): Promise<void> {
    for (const queue of this.queues.values()) {
      const now = Date.now();
      const scheduledJobs = await this.storage.getScheduledJobs(queue.name, now);
      for (const jobData of scheduledJobs) {
        const job: Job = JSON.parse(jobData);
        if (job.state === JobState.DELAYED && job.scheduledAt! <= now) {
          job.state = JobState.WAITING;
          await this.storage.enqueueJob(job);
          await this.storage.removeScheduledJob(queue.name, job.id);

          // Reschedule cron jobs
          if (job.options.cron) {
            const nextJob = { ...job, id: uuidv4(), state: JobState.DELAYED, scheduledAt: this.getScheduledAt(job.options), attempts: 0, logs: [] };
            await this.storage.enqueueJob(nextJob);
            this.dependencyGraph.set(nextJob.id, nextJob);
            this.emitEvent('jobDelayed', nextJob);
          }

          this.emitEvent('jobReady', job);
          this.dependencyGraph.set(job.id, job);
        }
      }
    }
  }

  private async startScheduler(): Promise<void> {
    this.schedulerInterval = setInterval(async () => {
      try {
        await this.processOverdueJobs();
      } catch (err) {
        console.error('Scheduler iteration failed:', err);
      }
    }, 1000);
  }

  stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
  }
}