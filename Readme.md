# QueueX 🚀

A powerful, feature-rich job queue system for Node.js with advanced retry strategies, job chaining, and intelligent job processing.

[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Redis](https://img.shields.io/badge/Redis-Required-red.svg)](https://redis.io/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![NPM Version](https://img.shields.io/npm/v/queuex-sdk)](https://www.npmjs.com/package/queuex-sdk)

## ✨ Features

- 🔄 **Advanced Retry Strategies**
  - Exponential, Linear, and Fixed backoff
  - Configurable delays and attempts
  - Maximum retry limit

- ⏱️ **Smart Job Processing**
  - Job timeout handling
  - Time-to-live (TTL) support
  - Multiple queue processing strategies
  - Concurrent job execution

- 🔗 **Job Dependencies & Chaining**
  - Sequential job execution
  - Result passing between jobs
  - Complex workflow support
  - Dependency graph management

- 📊 **Queue Management**
  - FIFO/LIFO processing
  - Priority queues
  - Round-robin distribution
  - Rate limiting

## 🚀 Quick Start

```bash
npm install queuex-sdk
```

```typescript
import { QueueX } from 'queuex-sdk';

// Initialize QueueX
const queuex = new QueueX({ 
  redisConnection: 'redis://localhost:6379' 
});

// Create a queue
await queuex.createQueue('emailQueue', { 
  maxConcurrency: 5 
});

// Add a job with retry strategy
await queuex.enqueue('emailQueue', 
  { to: 'user@example.com', subject: 'Welcome!' },
  {
    retries: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
      maxDelay: 30000
    }
  }
);

// Process jobs
queuex.startWorker('emailQueue', async (job) => {
  await sendEmail(job.data);
  return { sent: true };
});
```

## 🔥 Advanced Features

### Retry Strategies

```typescript
// Exponential Backoff
await queuex.enqueue('queue', data, {
  retries: 5,
  backoff: { 
    type: 'exponential', 
    delay: 1000,
    maxDelay: 60000 
  }
});

// Linear Backoff
await queuex.enqueue('queue', data, {
  retries: 3,
  backoff: { 
    type: 'linear', 
    delay: 5000 
  }
});

// Fixed Delay
await queuex.enqueue('queue', data, {
  retries: 2,
  backoff: { 
    type: 'fixed', 
    delay: 10000 
  }
});
```

### Job Timeouts & TTL

```typescript
// Job with timeout
await queuex.enqueue('queue', data, {
  timeout: 5000  // 5 seconds timeout
});

// Job with TTL
await queuex.enqueue('queue', data, {
  ttl: 3600000  // 1 hour TTL
});

// Combined options
await queuex.enqueue('queue', data, {
  timeout: 5000,
  ttl: 3600000,
  retries: 3,
  backoff: { type: 'exponential', delay: 1000 }
});
```

### Job Chaining

```typescript
// Create a chain of jobs
await queuex.enqueue('videoQueue', { videoId: '123' }, {
  chain: [
    {
      data: { step: 'compress' },
      options: { 
        priority: 'high',
        timeout: 300000 
      }
    },
    {
      data: { step: 'thumbnail' },
      options: { 
        retries: 2,
        backoff: { type: 'linear', delay: 5000 }
      }
    }
  ]
});

// Access previous job's result
queuex.startWorker('videoQueue', async (job) => {
  if (job.context) {
    console.log('Previous job result:', job.context);
  }
  // Process current job...
});
```

### Queue Processing Strategies

```typescript
// FIFO Queue (default)
await queuex.createQueue('fifoQueue', { 
  strategy: QueueStrategy.FIFO 
});

// LIFO Queue
await queuex.createQueue('lifoQueue', { 
  strategy: QueueStrategy.LIFO 
});

// Priority Queue
await queuex.createQueue('priorityQueue', { 
  strategy: QueueStrategy.PRIORITY 
});

// Round Robin Queue
await queuex.createQueue('roundRobinQueue', { 
  strategy: QueueStrategy.ROUND_ROBIN 
});
```

## 📊 Event Handling

```typescript
queuex.on('jobStarted', (job) => {
  console.log(`Job ${job.id} started`);
});

queuex.on('jobCompleted', (job) => {
  console.log(`Job ${job.id} completed`);
});

queuex.on('jobFailed', (job) => {
  console.error(`Job ${job.id} failed:`, job.logs);
});

queuex.on('jobDelayed', (job) => {
  console.log(`Job ${job.id} delayed until:`, 
    new Date(job.scheduledAt!).toISOString()
  );
});
```

## 🔧 Configuration Options

### Job Options
```typescript
interface JobOptions {
  priority?: 'high' | 'medium' | 'low';
  retries?: number;
  backoff?: {
    type: 'exponential' | 'linear' | 'fixed';
    delay: number;
    maxDelay?: number;
  };
  timeout?: number;
  ttl?: number;
  delay?: number;
  concurrency?: number;
  dependsOn?: string[];
  cron?: string;
  chain?: Array<{
    data: any;
    options?: JobOptions;
  }>;
}
```

### Queue Options
```typescript
interface QueueOptions {
  maxConcurrency?: number;
  strategy?: QueueStrategy;
  rateLimit?: {
    max: number;
    interval: number;
  };
}
```

## 📚 Best Practices

1. **Retry Strategies**
   - Use exponential backoff for network operations
   - Use linear backoff for resource-intensive tasks
   - Use fixed delay for scheduled retries

2. **Timeouts & TTL**
   - Set reasonable timeouts based on operation type
   - Use TTL for time-sensitive tasks
   - Consider queue processing time in TTL calculations

3. **Job Chaining**
   - Keep chains focused and minimal
   - Handle errors appropriately in each step
   - Use context passing judiciously

4. **Queue Strategies**
   - Use FIFO for standard operations
   - Use LIFO for real-time updates
   - Use Priority for important tasks
   - Use Round Robin for fair resource distribution

