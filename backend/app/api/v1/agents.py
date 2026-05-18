from fastapi import APIRouter

router = APIRouter()


@router.get("")
async def list_agents():
    return {"message": "获取Agent列表 - 待实现"}


@router.get("/{agent_id}")
async def get_agent(agent_id: str):
    return {"message": f"获取Agent {agent_id} - 待实现"}
