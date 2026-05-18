from fastapi import APIRouter

router = APIRouter()


@router.get("/{message_id}/diff")
async def get_diff(message_id: str):
    return {"message": f"获取消息 {message_id} 的Diff - 待实现"}
