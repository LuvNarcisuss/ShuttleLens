from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from app.core.config import get_settings

settings = get_settings()
engine_options: dict = {"pool_pre_ping": True}
if not settings.database_url.startswith("mysql+pymysql://"):
    raise ValueError("DATABASE_URL must use the mysql+pymysql:// scheme")

engine = create_engine(settings.database_url, **engine_options)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
