from fastapi import APIRouter

router = APIRouter()


@router.get("")
async def list_sessions():
    return {"message": "获取会话列表 - 待实现"}


@router.post("")
async def create_session():
    return {"message": "创建会话 - 待实现"}


@router.get("/{session_id}")
async def get_session(session_id: str):
    return {"message": f"获取会话 {session_id} - 待实现"}
