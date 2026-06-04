---
name: channel-management
description: Use when you need to manage Matrix rooms, send messages, or handle room participants.
---

## Purpose

Create and maintain Matrix rooms, send messages, and manage room participants.

## Tools

### Send a Message to a Room
Use your built-in Matrix message tool to reply directly in the room where you received the message.

### Create a Task Room
Task rooms are created automatically when you assign a task through the orchestrator.

### List Room Participants
```bash
curl -s "http://localhost:8000/api/rooms/{roomId}/participants" | jq .
```

## Rules

- Matrix room timeline is the collaboration source of truth.
- All communication should be visible in the room.
- Use @mentions for directed work and status requests.
- Every room must have a clear purpose (group, task, direct message).

## Decision Pattern

1. Determine if a new room is needed or an existing one suffices.
2. Use @mentions to direct work to specific workers.
3. Ensure all communication is visible in the room timeline.
