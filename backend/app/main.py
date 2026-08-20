from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.router import router as api_router
from app.core.config import get_settings

app = FastAPI(title="Good Badminton API")
settings = get_settings()
avatar_storage_dir = Path(settings.avatar_storage_dir)
avatar_storage_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(avatar_storage_dir.parent)), name="uploads")
app.include_router(api_router, prefix="/api")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
