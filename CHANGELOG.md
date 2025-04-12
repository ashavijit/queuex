# Changelog

All notable changes to QueueX will be documented in this file.

## [1.0.0] - 2025-12-04 🚀

### ✨ Added Features
- **Advanced Job Retry System** 🔄
  - Multiple backoff strategies:
    - `exponential`: Delay increases exponentially (2ⁿ)
    - `linear`: Delay increases linearly (n)
    - `fixed`: Constant delay
  - Configurable base delay and maximum delay
  - Detailed retry logging and attempt tracking

- **Job Timeout Management** ⏱️
  - Automatic job failure on timeout
  - Configurable timeout duration per job
  - Clean timeout handling and resource cleanup
  - Timeout event emission

- **Time-To-Live (TTL) Support** ⌛
  - Automatic job expiration
  - TTL validation against scheduled delays
  - Expired job cleanup and event emission
  - Configurable TTL per job

### 🔧 Enhanced
- **Queue Processing Strategies**
  - FIFO (First In, First Out) - Default strategy
  - LIFO (Last In, First Out) - For real-time priority
  - Priority-based processing
  - Round Robin distribution

- **Job Context & State Management**
  - Enhanced job state tracking
  - Improved error handling
  - Better context passing between chained jobs
  - More detailed job logging

### 🐛 Fixed
- Resolved race conditions in job processing
- Fixed memory leaks in timeout handling
- Improved error handling in job chains
- Better validation of job options

### 📚 Documentation
- Added comprehensive TypeScript types
- Improved JSDoc documentation
- Added code examples for all features
- Updated API documentation

## [0.9.5] - Initial Release 🎉

### ✨ Core Features
- Basic job queue functionality
- Redis-based storage
- Job dependencies
- Simple retry mechanism
- Event system
- Basic job scheduling 