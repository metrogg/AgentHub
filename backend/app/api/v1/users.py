from fastapi import APIRouter

router = APIRouter()


@router.get("/me")
async def get_current_user():
    return {"message": "获取当前用户信息 - 待实现"}
