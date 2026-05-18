from fastapi import APIRouter

router = APIRouter()


@router.get("/{session_id}/messages")
async def list_messages(session_id: str):
    return {"message": f"获取会话 {session_id} 消息列表 - 待实现"}


@router.post("/{session_id}/messages")
async def send_message(session_id: str):
    return {"message": f"发送消息到会话 {session_id} - 待实现"}
