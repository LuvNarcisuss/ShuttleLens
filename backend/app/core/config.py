from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_AVATAR_STORAGE_DIR = str(Path(__file__).resolve().parents[2] / "uploads" / "avatars")
DEFAULT_ANALYSIS_STORAGE_DIR = str(Path(__file__).resolve().parents[3] / "outputs" / "tasks")


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = Field(
        description="MySQL connection URL, for example mysql+pymysql://user:password@host:3306/database"
    )
    jwt_secret: str = "development-only-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_days: int = 7
    wechat_auth_mode: str = "mock"
    wechat_app_id: str | None = None
    wechat_app_secret: str | None = None
    phone_encryption_key: str = "development-only-phone-encryption-key-change-me"
    public_base_url: str = "http://127.0.0.1:8000"
    avatar_storage_dir: str = DEFAULT_AVATAR_STORAGE_DIR
    analysis_storage_dir: str = DEFAULT_ANALYSIS_STORAGE_DIR
    max_video_upload_bytes: int = 1024 * 1024 * 1024
    max_template_upload_bytes: int = 20 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @model_validator(mode="after")
    def validate_security_settings(self) -> "Settings":
        if self.wechat_auth_mode == "live" and (
            not self.wechat_app_id or not self.wechat_app_secret
        ):
            raise ValueError("Live WeChat authentication requires AppID and AppSecret")
        if self.app_env == "production" and self.phone_encryption_key.startswith(
            "development-only-"
        ):
            raise ValueError("Production requires a dedicated phone encryption key")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
