from fastapi import APIRouter, HTTPException, status

router = APIRouter()


@router.post("/register")
async def register():
    return {"message": "注册接口 - 待实现"}


@router.post("/login")
async def login():
    return {"message": "登录接口 - 待实现"}


@router.post("/refresh")
async def refresh_token():
    return {"message": "刷新Token接口 - 待实现"}


@router.post("/logout")
async def logout():
    return {"message": "登出接口 - 待实现"}
