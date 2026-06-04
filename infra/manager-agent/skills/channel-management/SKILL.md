---
name: channel-management
description: Use when you need to manage Matrix rooms, send messages, or handle room participants.
---

## Purpose

Create and maintain Matrix rooms, send messages, and manage room participants.

## Tools

### Get Room Info
```bash
curl -s http://localhost:8000/api/rooms/{roomId} | head -20
```

### List Room Participants
```bash
curl -s http://localhost:8000/api/rooms/{roomId}/participants | head -30
```

### Get Room Timeline
```bash
curl -s "http://localhost:8000/api/rooms/{roomId}/timeline?limit=50" | head -80
```

### Send Message to Room (via your built-in Matrix tool)
Use your Matrix message tool to reply directly in the room where you received the message.

## Rules

- Matrix room timeline is the collaboration source of truth.
- All communication should be visible in the room.
- Use @mentions for directed work and status requests.
- Every room must have a clear purpose (group, task, direct message).

## Decision Pattern

1. Determine if a new room is needed or an existing one suffices.
2. Use @mentions to direct work to specific workers.
3. Ensure all communication is visible in the room timeline.
