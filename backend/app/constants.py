# 业务常量定义

class SenderType:
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


class MessageType:
    TEXT = "text"
    CODE = "code"
    IMAGE = "image"
    FILE = "file"


class MessageStatus:
    SENDING = "sending"
    SENT = "sent"
    ERROR = "error"


class SessionType:
    SINGLE = "single"
    GROUP = "group"


class TaskStatus:
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"


class ChangeStatus:
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    APPLIED = "applied"
