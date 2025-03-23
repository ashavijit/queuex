import { QueueManager } from './queue-manager';
import { Job, JobState } from '../models/job';
import { RedisStorage } from '../storage/redis';
import { QueueXEvent } from '../lib';

/**
 * Processes jobs from a queue with concurrency control.
 */
export class Worker {
  private queueManager: QueueManager;
  private storage: RedisStorage;
  private running = false;
  private concurrency: number;
  private emitEvent: (event: QueueXEvent, job: Job) => void;

  constructor(
    queueManager: QueueManager,
    storage: RedisStorage,
    concurrency = 1,
    emitEvent: (event: QueueXEvent, job: Job) => void
  ) {
    this.queueManager = queueManager;
    this.storage = storage;
    this.concurrency = concurrency;
    this.emitEvent = emitEvent;
  }

  async start(queueName: string, processor: (job: Job) => Promise<any>): Promise<void> {
    this.running = true;
    const activeJobs: Set<string> = new Set();

    while (this.running) {
      if (activeJobs.size >= this.concurrency) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const job = await this.queueManager.getJob(queueName);
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      activeJobs.add(job.id);
      job.state = JobState.ACTIVE;
      job.attempts++;
      this.emitEvent('jobStarted', job);

      try {
        const result = await processor(job);
        job.state = JobState.COMPLETED;
        job.completedAt = Date.now();
        job.logs.push(`Completed with result: ${JSON.stringify(result)}`);
        await this.storage.saveJobResult(job);
        this.emitEvent('jobCompleted', job);

        if (job.dependents?.length) {
          for (const depId of job.dependents) {
            const dependentJob = this.queueManager.getJobById(depId);
            if (dependentJob && dependentJob.state === JobState.PENDING) {
              const allDepsCompleted = dependentJob.dependencies!.every((d) => {
                const dJob = this.queueManager.getJobById(d);
                return dJob?.state === JobState.COMPLETED;
              });
              if (allDepsCompleted) {
                dependentJob.state = JobState.WAITING;
                await this.storage.enqueueJob(dependentJob);
                this.emitEvent('jobReady', dependentJob);
              }
            }
          }
        }
      } catch (error) {
        job.state = job.attempts >= (job.options.retries ?? 0) ? JobState.FAILED : JobState.WAITING;
        job.logs.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
        if (job.state === JobState.WAITING) {
          const delay = this.calculateBackoff(job.attempts);
          job.scheduledAt = Date.now() + delay;
          await this.storage.enqueueJob(job);
          this.emitEvent('jobDelayed', job);
        } else {
          await this.storage.saveJobResult(job);
          this.emitEvent('jobFailed', job);
        }
      } finally {
        activeJobs.delete(job.id);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private calculateBackoff(attempt: number): number {
    return Math.pow(2, attempt - 1) * 1000;
  }
}