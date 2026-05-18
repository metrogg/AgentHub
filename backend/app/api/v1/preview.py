from fastapi import APIRouter

router = APIRouter()


@router.get("/{session_id}")
async def get_preview(session_id: str):
    return {"message": f"获取会话 {session_id} 预览 - 待实现"}
