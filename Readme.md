
# QueueX SDK

A lightweight, TypeScript-based queue management SDK with Redis support for job scheduling, dependency resolution, and event logging.

[![NPM Version](https://img.shields.io/npm/v/queuex-sdk)](https://www.npmjs.com/package/queuex-sdk)

## Features
- Schedule jobs with configurable delays
- Update or unschedule delayed jobs
- Dependency resolution for job execution (DAG)
- Event logging using Redis Streams
- Persistence across restarts

## Prerequisites
- **Node.js**: v20.11.1 or higher
- **Redis**: Running on `redis://localhost:6379` (default)
- **NPM**: For package installation

## Installation
Install the package via NPM:

```bash
npm i queuex-sdk
```

## Usage
### Basic Example
Create a script to use the SDK in your Node.js project:

1. Initialize a new project (if not already done):
   ```bash
   mkdir my-project
   cd my-project
   npm init -y
   npm i queuex-sdk
   ```

2. Create `index.js`:
   ```javascript
   import { QueueX } from 'queuex-sdk';

   const queuex = new QueueX({ redisConnection: 'redis://localhost:6379' });
   queuex.createQueue('my-queue');

   (async () => {
     const job = await queuex.enqueue('my-queue', { task: 'Hello' }, { delay: 2000 });
     console.log(`Job ${job.id} scheduled`);

     queuex.on('jobCompleted', (job) => console.log(`Job ${job.id} completed`));
     queuex.startWorker('my-queue', async (job) => `Processed ${job.data.task}`);
   })();
   ```

3. Update `package.json` to use ES Modules:
   ```json
   {
     "name": "my-project",
     "version": "1.0.0",
     "type": "module",
     "dependencies": {
       "queuex-sdk": "^0.2.0"
     },
     "scripts": {
       "start": "node index.js"
     }
   }
   ```

4. Run the script:
   ```bash
   npm start
   ```

### Dependency Scheduling Example
Schedule jobs where one depends on another:

```javascript
import { QueueX } from 'queuex-sdk';

const queuex = new QueueX({ redisConnection: 'redis://localhost:6379' });
queuex.createQueue('my-queue');

(async () => {
  const parentJob = await queuex.enqueue('my-queue', { task: 'Parent Task' });
  console.log(`Parent job ${parentJob.id} scheduled`);

  const childJob = await queuex.enqueue('my-queue', { task: 'Child Task' }, { dependsOn: [parentJob.id] });
  console.log(`Child job ${childJob.id} scheduled, depends on ${parentJob.id}`);

  const cronJob = await queuex.enqueue('my-queue', { task: 'Cron Task' }, { cron: '*/5 * * * * *' });
  console.log(`Cron job ${cronJob.id} scheduled to run every 5 seconds`);

  queuex.on('jobPending', (job) => console.log(`Job ${job.id} is pending`));
  queuex.on('jobReady', (job) => console.log(`Job ${job.id} is ready`));
  queuex.on('jobDelayed', (job) => console.log(`Job ${job.id} is delayed until ${new Date(job.scheduledAt!).toISOString()}`));
  queuex.on('jobCompleted', (job) => console.log(`Job ${job.id} completed: ${job.data.task}`));

  queuex.startWorker('my-queue', async (job) => {
    return `Processed ${job.data.task}`;
  });

  await new Promise((resolve) => setTimeout(resolve, 15000)); // Run for 15 seconds
  console.log('Shutting down...');
  await queuex.shutdown();
})();
```

**Explanation**:
- `parentJob` runs immediately (no delay).
- `childJob` waits until `parentJob` completes due to `dependsOn: [parentJob.id]`.
- The worker processes `parentJob` first, then `childJob` once dependencies are resolved.

**Output** (example):
```
Parent job <parent-id> scheduled
Child job <child-id> scheduled, depends on <parent-id>
Job <child-id> is pending
Job <parent-id> completed: Parent Task
Job <child-id> is ready
Job <child-id> completed: Child Task
```

### Running with Redis
Ensure Redis is running:
```bash
redis-server
```

## API Examples
### Schedule a Job
```javascript
const job = await queuex.enqueue('my-queue', { task: 'Test' }, { delay: 5000 });
console.log(`Scheduled job ${job.id}`);
```

### Update Delay
```javascript
await queuex.updateJobDelay(job.id, 10000);
console.log(`Updated delay for job ${job.id}`);
```

### Unschedule a Job
```javascript
await queuex.unscheduleJob(job.id);
console.log(`Unscheduling job ${job.id}`);
```

### Listen to Events
```javascript
queuex.on('jobDelayed', (job) => console.log(`Job ${job.id} delayed`));
queuex.on('jobCompleted', (job) => console.log(`Job ${job.id} completed`));
```

### Get Job Logs
```javascript
const logs = await queuex.getEvents(job.id);
console.log('Job logs:', logs);
```

## Troubleshooting
- **SyntaxError: Cannot use import statement outside a module**:
  - Add `"type": "module"` to your `package.json` or use `require`:
    ```javascript
    const { QueueX } = require('queuex-sdk');
    ```
- **Redis Connection Error**:
  - Ensure Redis is running on `localhost:6379` or update the connection string.
- **Module Not Found**:
  - Verify installation: `npm i queuex-sdk`.

## License
MIT
