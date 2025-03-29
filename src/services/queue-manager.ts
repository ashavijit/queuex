import { RedisStorage } from '../storage/redis';
import { Job, JobOptions, JobState } from '../models/job';
import { Queue, QueueOptions } from '../models/queue';
import { v4 as uuidv4 } from 'uuid';
import { QueueXEvent } from '../lib';
import { CronParser } from '../utils/cron-parser';

/**
 * Manages queues and job scheduling with dependency resolution, cron support, and job chaining.
 * 
 * Features:
 * - Queue management and job scheduling
 * - Dependency resolution between jobs
 * - Cron-based job scheduling
 * - Job chaining with context passing
 * - Concurrent job processing
 * 
 * Example:
 * ```typescript
 * // Create a queue manager
 * const queueManager = new QueueManager(redisUrl, emitEvent);
 * 
 * // Create a queue
 * await queueManager.createQueue('myQueue', { maxConcurrency: 5 });
 * 
 * // Enqueue a job with chaining
 * await queueManager.enqueue('myQueue', initialData, {
 *   chain: [
 *     {
 *       data: { step: 1 },
 *       options: { priority: 'high' }
 *     },
 *     {
 *       data: { step: 2 },
 *       options: { retries: 5 }
 *     }
 *   ]
 * });
 * ```
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

  /**
   * Creates a new queue with the specified options.
   * @param name - Name of the queue
   * @param options - Queue configuration options
   * @throws Error if queue already exists
   */
  async createQueue(name: string, options: QueueOptions = {}): Promise<void> {
    if (this.queues.has(name)) {
      throw new Error(`Queue ${name} already exists`);
    }

    const queue: Queue = {
      name,
      options: {
        maxConcurrency: 1,
        ...options,
      },
    };

    this.queues.set(name, queue);
  }

  /**
   * Enqueues a job with optional chaining and dependencies.
   * 
   * Job Chaining:
   * - The chain option allows defining subsequent jobs that will execute after the current job
   * - Each job in the chain receives the result of the previous job as context
   * - Chain jobs inherit the queue of the parent job
   * 
   * Dependencies:
   * - Jobs can depend on other jobs using dependsOn
   * - A job will only start when all its dependencies are completed
   * 
   * @param queueName - Name of the queue to enqueue the job in
   * @param data - Job data payload
   * @param options - Job configuration including chain and dependencies
   * @returns The created job
   * @throws Error if queue doesn't exist or if dependency jobs don't exist
   */
  async enqueue(queueName: string, data: any, options: JobOptions = {}): Promise<Job> {
    const queue = this.queues.get(queueName);
    if (!queue) throw new Error(`Queue ${queueName} not found`);

    const job: Job = {
      id: uuidv4(),
      queue: queueName,
      data,
      state: this.getInitialState(options),
      options: { 
        priority: 'medium', 
        retries: 3, 
        ...options,
        chain: undefined // Remove chain from options to prevent it from being passed to child jobs
      },
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

  /**
   * Gets the next available job from the queue.
   * Handles dependency resolution and job state transitions.
   * 
   * @param queueName - Name of the queue to get job from
   * @returns The next available job or null if no jobs are available
   */
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

  /**
   * Retrieves a job by its ID from the dependency graph.
   * @param jobId - ID of the job to retrieve
   * @returns The job if found, undefined otherwise
   */
  getJobById(jobId: string): Job | undefined {
    return this.dependencyGraph.get(jobId);
  }

  /**
   * Unschedules a delayed job and marks it as failed.
   * @param jobId - ID of the job to unschedule
   * @throws Error if job doesn't exist or is not in DELAYED state
   */
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

  /**
   * Updates the delay of a delayed or pending job.
   * @param jobId - ID of the job to update
   * @param newDelay - New delay in milliseconds
   * @returns The updated job
   * @throws Error if job doesn't exist or is not in DELAYED/PENDING state
   */
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

  /**
   * Determines the initial state of a job based on its options.
   * @param options - Job options
   * @returns The initial job state
   */
  private getInitialState(options: JobOptions): JobState {
    if (options.dependsOn?.length) return JobState.PENDING;
    if (options.delay || options.cron) return JobState.DELAYED;
    return JobState.WAITING;
  }

  /**
   * Calculates the scheduled execution time for a job based on its options.
   * @param options - Job options
   * @returns The scheduled timestamp or undefined if not scheduled
   * @throws Error if cron expression is invalid
   */
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

  /**
   * Processes overdue jobs from all queues.
   * Handles both delayed and cron jobs.
   */
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