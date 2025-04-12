import Redis from 'ioredis';
import { Job, JobState } from '../models/job';
import { QueueXEvent } from '../lib';
import { QueueStrategy } from '../models/queue';

/**
 * Redis-based storage for jobs and events using Streams for logs.
 */
export class RedisStorage {
      private client: Redis;

      constructor(connectionString: string) {
            try {
                  this.client = new Redis(connectionString);
            } catch (err) {
                  throw new Error(
                        `Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`
                  );
            }
      }

      /**
       * Enqueues a job using the specified queue strategy.
       *
       * Strategies:
       * - FIFO: Uses RPUSH to add jobs to the end of the list
       * - LIFO: Uses LPUSH to add jobs to the beginning of the list
       * - PRIORITY: Uses ZADD with priority as score
       * - ROUND_ROBIN: Uses RPUSH with a circular buffer
       */
      async enqueueJob(job: Job, strategy: QueueStrategy = QueueStrategy.FIFO): Promise<void> {
            const key = `queue:${job.queue}:jobs`;
            try {
                  switch (strategy) {
                        case QueueStrategy.FIFO:
                              await this.client.rpush(key, JSON.stringify(job));
                              break;
                        case QueueStrategy.LIFO:
                              await this.client.lpush(key, JSON.stringify(job));
                              break;
                        case QueueStrategy.PRIORITY:
                              const priority = this.getPriorityScore(job.options.priority);
                              await this.client.zadd(key, priority, JSON.stringify(job));
                              break;
                        case QueueStrategy.ROUND_ROBIN:
                              await this.client.rpush(key, JSON.stringify(job));
                              break;
                  }

                  if (job.options.delay && job.scheduledAt && job.state === JobState.DELAYED) {
                        await this.scheduleJob(job);
                  }
            } catch (err) {
                  throw new Error(
                        `Failed to enqueue job ${job.id}: ${err instanceof Error ? err.message : String(err)}`
                  );
            }
      }

      /**
       * Gets the next job based on the queue strategy.
       */
      async getNextJob(
            queue: string,
            strategy: QueueStrategy = QueueStrategy.FIFO
      ): Promise<Job | null> {
            const key = `queue:${queue}:jobs`;
            try {
                  let jobData: string | null = null;

                  switch (strategy) {
                        case QueueStrategy.FIFO:
                              jobData = await this.client.lpop(key);
                              break;
                        case QueueStrategy.LIFO:
                              jobData = await this.client.rpop(key);
                              break;
                        case QueueStrategy.PRIORITY:
                              const results = await this.client.zrange(key, 0, 0);
                              if (results.length > 0) {
                                    jobData = results[0];
                                    await this.client.zrem(key, jobData);
                              }
                              break;
                        case QueueStrategy.ROUND_ROBIN:
                              jobData = await this.client.lpop(key);
                              if (jobData) {
                                    // Move the job to the end of the queue for round-robin
                                    await this.client.rpush(key, jobData);
                              }
                              break;
                  }

                  return jobData ? JSON.parse(jobData) : null;
            } catch (err) {
                  throw new Error(
                        `Failed to get next job from ${queue}: ${err instanceof Error ? err.message : String(err)}`
                  );
            }
      }

      /**
       * Converts priority level to a numeric score for Redis sorted sets.
       */
      private getPriorityScore(priority?: 'high' | 'medium' | 'low'): number {
            switch (priority) {
                  case 'high':
                        return 3;
                  case 'medium':
                        return 2;
                  case 'low':
                        return 1;
                  default:
                        return 2; // Default to medium priority
            }
      }

      async scheduleJob(job: Job): Promise<void> {
            const scheduledKey = `queue:${job.queue}:scheduled`;
            try {
                  await this.client.zadd(scheduledKey, job.scheduledAt!.toString(), job.id);
                  await this.client.set(
                        `job:${job.id}:data`,
                        JSON.stringify(job),
                        'EX',
                        60 * 60 * 24
                  );
            } catch (err) {
                  throw new Error(
                        `Failed to schedule job ${job.id}: ${err instanceof Error ? err.message : String(err)}`
                  );
            }
      }

      async saveJobResult(job: Job): Promise<void> {
            const resultKey = `job:${job.id}:result`;
            try {
                  await this.client.set(resultKey, JSON.stringify(job), 'EX', 60 * 60 * 24);
            } catch (err) {
                  throw new Error(
                        `Failed to save job result ${job.id}: ${err instanceof Error ? err.message : String(err)}`
                  );
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
                  throw new Error(
                        `Failed to log event for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`
                  );
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
                  throw new Error(
                        `Failed to get events for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`
                  );
            }
      }

      async getScheduledJobs(queue: string, maxScore: number): Promise<string[]> {
            const scheduledKey = `queue:${queue}:scheduled`;
            try {
                  const jobIds = await this.client.zrangebyscore(
                        scheduledKey,
                        0,
                        maxScore.toString()
                  );
                  const jobs: string[] = [];
                  for (const jobId of jobIds) {
                        const jobData = await this.client.get(`job:${jobId}:data`);
                        if (jobData) jobs.push(jobData);
                  }
                  return jobs;
            } catch (err) {
                  throw new Error(
                        `Failed to get scheduled jobs for ${queue}: ${err instanceof Error ? err.message : String(err)}`
                  );
            }
      }

      async removeScheduledJob(queue: string, jobId: string): Promise<void> {
            const scheduledKey = `queue:${queue}:scheduled`;
            try {
                  await this.client.zrem(scheduledKey, jobId);
                  await this.client.del(`job:${jobId}:data`);
            } catch (err) {
                  throw new Error(
                        `Failed to remove scheduled job ${jobId}: ${err instanceof Error ? err.message : String(err)}`
                  );
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
