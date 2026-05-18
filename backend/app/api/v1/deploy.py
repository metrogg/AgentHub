from fastapi import APIRouter

router = APIRouter()


@router.post("/{session_id}")
async def deploy(session_id: str):
    return {"message": f"部署会话 {session_id} - 待实现"}
