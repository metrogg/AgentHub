from fastapi import APIRouter

router = APIRouter()


@router.get("/{session_id}/tasks")
async def list_tasks(session_id: str):
    return {"message": f"获取会话 {session_id} 任务列表 - 待实现"}


@router.post("/{task_id}/approve")
async def approve_task(task_id: str):
    return {"message": f"审批通过任务 {task_id} - 待实现"}
