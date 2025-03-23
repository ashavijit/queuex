import Redis from 'ioredis';
import { Job, JobState } from '../models/job';
import { QueueXEvent } from '../lib';

/**
 * Redis-based storage for jobs and events using Streams for logs.
 */
export class RedisStorage {
  private client: Redis;

  constructor(connectionString: string) {
    try {
      this.client = new Redis(connectionString);
    } catch (err) {
      throw new Error(`Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async enqueueJob(job: Job): Promise<void> {
    const key = `queue:${job.queue}:jobs`;
    try {
      await this.client.rpush(key, JSON.stringify(job));
      if (job.options.delay && job.scheduledAt && job.state === JobState.DELAYED) {
        await this.scheduleJob(job);
      }
    } catch (err) {
      throw new Error(`Failed to enqueue job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async scheduleJob(job: Job): Promise<void> {
    const scheduledKey = `queue:${job.queue}:scheduled`;
    try {
      await this.client.zadd(scheduledKey, job.scheduledAt!.toString(), job.id);
      await this.client.set(`job:${job.id}:data`, JSON.stringify(job), 'EX', 60 * 60 * 24);
    } catch (err) {
      throw new Error(`Failed to schedule job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getNextJob(queue: string): Promise<Job | null> {
    const key = `queue:${queue}:jobs`;
    try {
      const jobData = await this.client.lpop(key);
      return jobData ? JSON.parse(jobData) : null;
    } catch (err) {
      throw new Error(`Failed to get next job from ${queue}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async saveJobResult(job: Job): Promise<void> {
    const resultKey = `job:${job.id}:result`;
    try {
      await this.client.set(resultKey, JSON.stringify(job), 'EX', 60 * 60 * 24);
    } catch (err) {
      throw new Error(`Failed to save job result ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async logEvent(event: QueueXEvent, job: Job): Promise<void> {
    const streamKey = `job:${job.id}:logs`;
    try {
      await this.client.xadd(
        streamKey,
        '*',
        'event',
        event,
        'state',
        job.state,
        'timestamp',
        Date.now().toString(),
        'message',
        job.logs[job.logs.length - 1] || event // Use latest log or event name
      );
      await this.client.expire(streamKey, 60 * 60 * 24); // TTL: 24 hours
    } catch (err) {
      throw new Error(`Failed to log event for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getEvents(jobId: string): Promise<string[]> {
    const streamKey = `job:${jobId}:logs`;
    try {
      const entries = await this.client.xrange(streamKey, '-', '+');
      return entries.map((entry) => {
        const [, fields] = entry;
        const data: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }
        return `${data.event}:${data.timestamp}:${data.state}:${data.message}`;
      });
    } catch (err) {
      throw new Error(`Failed to get events for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getScheduledJobs(queue: string, maxScore: number): Promise<string[]> {
    const scheduledKey = `queue:${queue}:scheduled`;
    try {
      const jobIds = await this.client.zrangebyscore(scheduledKey, 0, maxScore.toString());
      const jobs: string[] = [];
      for (const jobId of jobIds) {
        const jobData = await this.client.get(`job:${jobId}:data`);
        if (jobData) jobs.push(jobData);
      }
      return jobs;
    } catch (err) {
      throw new Error(`Failed to get scheduled jobs for ${queue}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async removeScheduledJob(queue: string, jobId: string): Promise<void> {
    const scheduledKey = `queue:${queue}:scheduled`;
    try {
      await this.client.zrem(scheduledKey, jobId);
      await this.client.del(`job:${jobId}:data`);
    } catch (err) {
      throw new Error(`Failed to remove scheduled job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
    } catch (err) {
      console.error('Failed to disconnect Redis:', err);
    }
  }
}