from fastapi import APIRouter

from app.api.v1 import auth, users, sessions, messages, agents, tasks, diff, preview, deploy

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["认证"])
api_router.include_router(users.router, prefix="/users", tags=["用户"])
api_router.include_router(sessions.router, prefix="/sessions", tags=["会话"])
api_router.include_router(messages.router, prefix="/messages", tags=["消息"])
api_router.include_router(agents.router, prefix="/agents", tags=["Agent"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["任务"])
api_router.include_router(diff.router, prefix="/diff", tags=["Diff"])
api_router.include_router(preview.router, prefix="/preview", tags=["预览"])
api_router.include_router(deploy.router, prefix="/deploy", tags=["部署"])
