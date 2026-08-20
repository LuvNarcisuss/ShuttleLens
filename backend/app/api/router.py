from fastapi import APIRouter

from app.api.analysis import router as analysis_router
from app.api.auth import router as auth_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(analysis_router)
