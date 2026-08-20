from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.core.config import get_settings


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _config() -> Config:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return config


def test_product_fields_mysql_sql_has_no_json_server_defaults(monkeypatch, capsys) -> None:
    monkeypatch.setenv("DATABASE_URL", "mysql+pymysql://user:password@localhost/database")
    get_settings.cache_clear()
    command.upgrade(_config(), "004_user_phone_onboarding:005_product_task_fields", sql=True)
    sql = capsys.readouterr().out.upper()
    assert "VIDEO_METADATA_JSON JSON NOT NULL DEFAULT" not in sql
    assert "CALIBRATION_FRAMES_JSON JSON NOT NULL DEFAULT" not in sql
    assert "HIGHLIGHT_OVERRIDES_JSON JSON NOT NULL DEFAULT" not in sql


def test_upgrade_recovers_from_partially_applied_product_fields(tmp_path: Path, monkeypatch) -> None:
    database = tmp_path / "partial-migration.sqlite3"
    database_url = f"sqlite:///{database.as_posix()}"
    engine = create_engine(database_url)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id CHAR(32) PRIMARY KEY)"))
        connection.execute(text(
            "CREATE TABLE analysis_tasks ("
            "id CHAR(32) PRIMARY KEY, user_id CHAR(32) NOT NULL, "
            "status VARCHAR(32) NOT NULL, progress INTEGER NOT NULL, "
            "options_json JSON NOT NULL, corners_json JSON, "
            "input_video_path VARCHAR(1024) NOT NULL, "
            "template_path VARCHAR(1024) NOT NULL, result_json JSON, "
            "error_message TEXT, created_at DATETIME NOT NULL, "
            "updated_at DATETIME NOT NULL, "
            "name VARCHAR(160) NOT NULL DEFAULT '未命名分析', "
            "cover_path VARCHAR(1024))"
        ))
        connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL)"))
        connection.execute(text(
            "INSERT INTO alembic_version (version_num) "
            "VALUES ('004_user_phone_onboarding')"
        ))
    engine.dispose()
    monkeypatch.setenv("DATABASE_URL", database_url)
    get_settings.cache_clear()
    command.upgrade(_config(), "head")
    engine = create_engine(database_url)
    columns = {item["name"] for item in inspect(engine).get_columns("analysis_tasks")}
    with engine.connect() as connection:
        version = connection.scalar(text("SELECT version_num FROM alembic_version"))
    engine.dispose()
    assert {"name", "cover_path", "video_metadata_json", "calibration_frames_json", "highlight_overrides_json", "stage", "error_code", "recovery_hint", "deleted_at", "source_task_id"} <= columns
    assert version == "009_account_settings_lifecycle"
