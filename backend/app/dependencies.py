from fastapi import Header, HTTPException, status
from typing import Optional


async def get_current_user(authorization: Optional[str] = Header(None)) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="缺少认证信息",
        )
    # TODO: 实现 JWT 验证
    return "user-id"
