from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.analysis import get_analysis_task_service
from app.core.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models.analysis_task import AnalysisTask
from app.db.models.user import User
from app.db.session import get_db
from app.main import app
from app.schemas.analysis import TaskOptions


class RecordingExecutor:
    def __init__(self) -> None:
        self.submit_count = 0

    def submit(self, fn: object, *args: object, **kwargs: object) -> None:
        self.submit_count += 1


class FakeAnalysisTaskService:
    def __init__(self, executor: RecordingExecutor) -> None:
        self.executor = executor
        self.tasks: dict[UUID, AnalysisTask] = {}

    def add_task(self, task: AnalysisTask) -> None:
        self.tasks[task.id] = task

    def create_draft(self, user_id: UUID, options: TaskOptions | None = None) -> AnalysisTask:
        now = datetime.now(UTC)
        task = AnalysisTask(
            id=uuid4(),
            user_id=user_id,
            status="created",
            progress=0,
            options_json=(options or TaskOptions()).model_dump(),
            input_video_path="",
            template_path="",
            created_at=now,
            updated_at=now,
        )
        self.add_task(task)
        return task

    def get_task(self, task_id: UUID, user_id: UUID) -> AnalysisTask | None:
        task = self.tasks.get(task_id)
        return task if task is not None and task.user_id == user_id else None

    def save_upload(
        self,
        task_id: UUID,
        user_id: UUID,
        upload_type: str,
        filename: str,
        content: bytes,
    ) -> AnalysisTask:
        task = self.get_task(task_id, user_id)
        if task is None:
            raise ValueError("task was not found")
        if task.status != "created":
            raise ValueError("uploads can only be changed while the task is created")
        path = f"{task.id}/input/{upload_type}_{Path(filename).name}"
        if upload_type == "video":
            task.input_video_path = path
        else:
            task.template_path = path
        return task

    def detect_template_corners(self, task_id: UUID, user_id: UUID) -> list[tuple[int, int]]:
        task = self.get_task(task_id, user_id)
        if task is None:
            raise ValueError("task was not found")
        return [(0, 0), (100, 0), (100, 50), (0, 50)]

    def save_corners(
        self,
        task_id: UUID,
        user_id: UUID,
        corners: list[tuple[int, int]],
    ) -> AnalysisTask:
        task = self.get_task(task_id, user_id)
        if task is None:
            raise ValueError("task was not found")
        if task.status != "created":
            raise ValueError("corners can only be changed while the task is created")
        task.corners_json = [list(point) for point in corners]
        return task

    def enqueue(self, task_id: UUID, user_id: UUID) -> AnalysisTask:
        task = self.get_task(task_id, user_id)
        if task is None:
            raise ValueError("task was not found")
        if task.status != "created":
            raise ValueError("only created tasks can be queued")
        if not task.input_video_path or not task.template_path or not task.corners_json:
            raise ValueError("video, template, and four corners are required before queueing")
        task.status = "queued"
        self.executor.submit(object())
        return task


@dataclass
class ApiContext:
    client: TestClient
    service: FakeAnalysisTaskService
    session_factory: sessionmaker[Session]
    owner: User
    other: User
    executor: RecordingExecutor
    storage_dir: Path

    def authenticate(self, user: User) -> None:
        app.dependency_overrides[get_current_user] = lambda: user


@pytest.fixture
def api_context(tmp_path: Path) -> Iterator[ApiContext]:
    storage_dir = tmp_path
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
    )
    with session_factory() as session:
        from app.services.account_auth import generate_account_number
        owner_account = generate_account_number(session)
        other_account = generate_account_number(session)
        owner = User(
            openid="api-owner",
            account_number=owner_account,
            nickname="Owner",
            avatar_url="https://example.com/owner.jpg",
            phone_verified_at=datetime.now(UTC),
        )
        other = User(
            openid="api-other",
            account_number=other_account,
            nickname="Other",
            avatar_url="https://example.com/other.jpg",
            phone_verified_at=datetime.now(UTC),
        )
        session.add_all([owner, other])
        session.commit()
        session.refresh(owner)
        session.refresh(other)
        session.expunge_all()

    executor = RecordingExecutor()
    service = FakeAnalysisTaskService(executor)

    def override_db() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_analysis_task_service] = lambda: service
    app.dependency_overrides[get_settings] = lambda: Settings(
        database_url="mysql+pymysql://user:password@localhost/database",
        analysis_storage_dir=str(storage_dir),
    )
    try:
        yield ApiContext(
            client=TestClient(app),
            service=service,
            session_factory=session_factory,
            owner=owner,
            other=other,
            executor=executor,
            storage_dir=storage_dir,
        )
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def _create_task(context: ApiContext, owner_id: UUID | None = None) -> AnalysisTask:
    return context.service.create_draft(owner_id or context.owner.id)


def _upload_inputs(context: ApiContext, task_id: UUID) -> None:
    context.service.save_upload(task_id, context.owner.id, "video", "match.mp4", b"video")
    context.service.save_upload(task_id, context.owner.id, "template", "court.png", b"image")


def test_task_list_requires_authentication(api_context: ApiContext) -> None:
    response = api_context.client.get("/api/analysis/tasks")

    assert response.status_code == 401


def test_create_draft_and_upload_two_files(api_context: ApiContext) -> None:
    api_context.authenticate(api_context.owner)

    created = api_context.client.post(
        "/api/analysis/tasks",
        json={"pose_mode": "lightweight", "language": "en"},
    )
    task_id = created.json()["id"]
    video = api_context.client.post(
        f"/api/analysis/tasks/{task_id}/uploads/video",
        files={"file": ("match.mp4", b"video-data", "video/mp4")},
    )
    template = api_context.client.post(
        f"/api/analysis/tasks/{task_id}/uploads/template",
        files={"file": ("court.png", b"image-data", "image/png")},
    )

    assert created.status_code == 201
    assert created.json()["status"] == "created"
    assert created.json()["options"]["pose_mode"] == "lightweight"
    assert created.json()["options"]["language"] == "en"
    assert video.status_code == 200
    assert template.status_code == 200
    stored = api_context.service.get_task(UUID(task_id), api_context.owner.id)
    assert stored is not None
    assert stored.input_video_path.endswith("video_match.mp4")
    assert stored.template_path.endswith("template_court.png")


@pytest.mark.parametrize(
    ("upload_type", "filename", "content", "content_type"),
    [
        ("video", "match.txt", b"video", "text/plain"),
        ("template", "court.txt", b"image", "text/plain"),
        ("video", "empty.mp4", b"", "video/mp4"),
        ("template", "empty.png", b"", "image/png"),
    ],
)
def test_upload_rejects_wrong_mime_and_empty_files(
    api_context: ApiContext,
    upload_type: str,
    filename: str,
    content: bytes,
    content_type: str,
) -> None:
    api_context.authenticate(api_context.owner)
    task = _create_task(api_context)

    response = api_context.client.post(
        f"/api/analysis/tasks/{task.id}/uploads/{upload_type}",
        files={"file": (filename, content, content_type)},
    )

    assert response.status_code == 422


def test_non_owner_cannot_read_or_detect_task(api_context: ApiContext) -> None:
    task = _create_task(api_context)
    _upload_inputs(api_context, task.id)
    api_context.authenticate(api_context.other)

    detail = api_context.client.get(f"/api/analysis/tasks/{task.id}")
    detection = api_context.client.post(f"/api/analysis/tasks/{task.id}/detect-court")

    assert detail.status_code == 404
    assert detection.status_code == 404


def test_non_owner_cannot_probe_task_through_write_operations(api_context: ApiContext) -> None:
    task = _create_task(api_context)
    api_context.authenticate(api_context.other)

    responses = [
        api_context.client.patch(f"/api/analysis/tasks/{task.id}", json={"name": "探测"}),
        api_context.client.post(f"/api/analysis/tasks/{task.id}/cancel"),
        api_context.client.post(f"/api/analysis/tasks/{task.id}/retry"),
        api_context.client.post(f"/api/analysis/tasks/{task.id}/reanalyze"),
        api_context.client.delete(f"/api/analysis/tasks/{task.id}"),
    ]

    assert [response.status_code for response in responses] == [404, 404, 404, 404, 404]


def test_detect_court_returns_corners_and_safe_preview_identifier(api_context: ApiContext) -> None:
    task = _create_task(api_context)
    _upload_inputs(api_context, task.id)
    api_context.authenticate(api_context.owner)

    response = api_context.client.post(f"/api/analysis/tasks/{task.id}/detect-court")

    assert response.status_code == 200
    assert response.json() == {
        "corners": [[0, 0], [100, 0], [100, 50], [0, 50]],
        "preview": {"kind": "template"},
    }
    assert str(api_context.storage_dir) not in response.text


def test_calibration_candidates_are_private_and_do_not_expose_paths(
    api_context: ApiContext,
) -> None:
    candidate = api_context.storage_dir / "task" / "calibration" / "candidate_1.jpg"
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(b"jpeg-frame")
    task = _create_task(api_context)
    task.cover_path = "task/calibration/candidate_1.jpg"
    task.template_path = task.cover_path
    task.video_metadata_json = {
        "filename": "match.mp4",
        "duration_sec": 12.5,
        "width": 1280,
        "height": 720,
        "fps": 30.0,
        "size_bytes": 1024,
    }
    task.calibration_frames_json = [
        {
            "path": task.cover_path,
            "timestamp_sec": 0.625,
            "width": 1280,
            "height": 720,
        }
    ]
    api_context.authenticate(api_context.owner)

    descriptors = api_context.client.get(
        f"/api/analysis/tasks/{task.id}/calibration-frames"
    )
    image = api_context.client.get(
        f"/api/analysis/tasks/{task.id}/files/calibration?index=0"
    )
    api_context.authenticate(api_context.other)
    hidden = api_context.client.get(
        f"/api/analysis/tasks/{task.id}/files/calibration?index=0"
    )

    assert descriptors.status_code == 200
    assert descriptors.json() == {
        "items": [
            {"index": 0, "timestamp_sec": 0.625, "width": 1280, "height": 720}
        ]
    }
    assert "candidate_1.jpg" not in descriptors.text
    assert str(api_context.storage_dir) not in descriptors.text
    assert image.status_code == 200
    assert image.content == b"jpeg-frame"
    assert image.headers["content-type"] == "image/jpeg"
    assert hidden.status_code == 404


def test_corner_request_requires_exactly_four_strict_integer_pairs(api_context: ApiContext) -> None:
    task = _create_task(api_context)
    api_context.authenticate(api_context.owner)

    too_few = api_context.client.put(
        f"/api/analysis/tasks/{task.id}/corners",
        json={"corners": [[0, 0], [1, 0], [1, 1]]},
    )
    coerced = api_context.client.put(
        f"/api/analysis/tasks/{task.id}/corners",
        json={"corners": [[0, 0], [1, 0], [1, 1], ["0", 1]]},
    )

    assert too_few.status_code == 422
    assert coerced.status_code == 422


def test_run_rejects_incomplete_task(api_context: ApiContext) -> None:
    task = _create_task(api_context)
    api_context.authenticate(api_context.owner)

    response = api_context.client.post(f"/api/analysis/tasks/{task.id}/run")

    assert response.status_code == 409
    assert api_context.executor.submit_count == 0


def test_run_queues_complete_task_without_running_cv(api_context: ApiContext) -> None:
    task = _create_task(api_context)
    _upload_inputs(api_context, task.id)
    api_context.service.save_corners(
        task.id,
        api_context.owner.id,
        [(0, 0), (100, 0), (100, 50), (0, 50)],
    )
    api_context.authenticate(api_context.owner)

    response = api_context.client.post(f"/api/analysis/tasks/{task.id}/run")

    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert api_context.executor.submit_count == 1


def test_incomplete_onboarding_is_forbidden_from_every_analysis_write(
    api_context: ApiContext,
) -> None:
    pending = User(openid="pending-user", account_number="10000005")
    task = api_context.service.create_draft(pending.id)
    task.input_video_path = "input/video.mp4"
    task.template_path = "input/template.png"
    task.corners_json = [[0, 0], [100, 0], [100, 50], [0, 50]]
    api_context.authenticate(pending)

    responses = [
        api_context.client.post("/api/analysis/tasks", json={}),
        api_context.client.post(
            f"/api/analysis/tasks/{task.id}/uploads/video",
            files={"file": ("match.mp4", b"video", "video/mp4")},
        ),
        api_context.client.post(f"/api/analysis/tasks/{task.id}/detect-court"),
        api_context.client.put(
            f"/api/analysis/tasks/{task.id}/corners",
            json={"corners": [[0, 0], [100, 0], [100, 50], [0, 50]]},
        ),
        api_context.client.post(f"/api/analysis/tasks/{task.id}/run"),
    ]

    assert [response.status_code for response in responses] == [403, 403, 403, 403, 403]
    assert all(
        response.json()["detail"]["code"] == "ONBOARDING_INCOMPLETE"
        for response in responses
    )


def test_list_is_owner_only_newest_first_and_maps_orm_fields(api_context: ApiContext) -> None:
    now = datetime.now(UTC)
    with api_context.session_factory() as session:
        older = AnalysisTask(
            user_id=api_context.owner.id,
            options_json={"pose_mode": "lightweight"},
            corners_json=[[0, 0], [1, 0], [1, 1], [0, 1]],
            result_json={"metadata": "safe/metadata.json"},
            created_at=now - timedelta(minutes=1),
        )
        newer = AnalysisTask(user_id=api_context.owner.id, options_json={}, created_at=now)
        hidden = AnalysisTask(user_id=api_context.other.id, options_json={}, created_at=now)
        session.add_all([older, newer, hidden])
        session.commit()
        newer_id = str(newer.id)
        older_id = str(older.id)
    api_context.authenticate(api_context.owner)

    response = api_context.client.get("/api/analysis/tasks")

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert [item["id"] for item in response.json()["items"]] == [newer_id, older_id]
    assert response.json()["items"][1]["options"]["pose_mode"] == "lightweight"
    assert response.json()["items"][1]["corners"] == [[0, 0], [1, 0], [1, 1], [0, 1]]
    assert response.json()["items"][1]["result"] == {"metadata": "safe/metadata.json"}
    assert "input_video_path" not in response.text


def test_task_list_supports_status_filter_and_stable_cursor(api_context: ApiContext) -> None:
    now = datetime.now(UTC)
    with api_context.session_factory() as session:
        tasks = [
            AnalysisTask(
                user_id=api_context.owner.id,
                name=f"成功任务 {index}",
                status="succeeded",
                stage="completed",
                options_json={},
                created_at=now - timedelta(seconds=index),
            )
            for index in range(3)
        ]
        tasks.append(
            AnalysisTask(
                user_id=api_context.owner.id,
                name="失败任务",
                status="failed",
                stage="analysis",
                options_json={},
                created_at=now,
            )
        )
        session.add_all(tasks)
        session.commit()
    api_context.authenticate(api_context.owner)

    first = api_context.client.get(
        "/api/analysis/tasks", params={"status": "succeeded", "limit": 2}
    )
    assert first.status_code == 200
    first_payload = first.json()
    second = api_context.client.get(
        "/api/analysis/tasks",
        params={
            "status": "succeeded",
            "limit": 2,
            "cursor": first_payload["next_cursor"],
        },
    )

    assert second.status_code == 200
    assert len(first_payload["items"]) == 2
    assert len(second.json()["items"]) == 1
    assert first_payload["next_cursor"]
    assert second.json()["next_cursor"] is None
    assert not (
        {item["id"] for item in first_payload["items"]}
        & {item["id"] for item in second.json()["items"]}
    )
    assert all(item["status"] == "succeeded" for item in first_payload["items"])


def test_result_files_require_owner_and_succeeded_status(api_context: ApiContext) -> None:
    result_file = api_context.storage_dir / "result.mp4"
    result_file.write_bytes(b"video-result")
    with api_context.session_factory() as session:
        task = AnalysisTask(
            user_id=api_context.owner.id,
            status="succeeded",
            progress=100,
            options_json={},
            result_json={"video": "result.mp4"},
        )
        unfinished = AnalysisTask(user_id=api_context.owner.id, options_json={})
        session.add_all([task, unfinished])
        session.commit()
        task_id = task.id
        unfinished_id = unfinished.id
        api_context.service.add_task(task)
        api_context.service.add_task(unfinished)

    api_context.authenticate(api_context.other)
    forbidden = api_context.client.get(f"/api/analysis/tasks/{task_id}/files/video")
    api_context.authenticate(api_context.owner)
    pending = api_context.client.get(f"/api/analysis/tasks/{unfinished_id}/files/video")
    allowed = api_context.client.get(f"/api/analysis/tasks/{task_id}/files/video")

    assert forbidden.status_code == 404
    assert pending.status_code == 409
    assert allowed.status_code == 200
    assert allowed.content == b"video-result"
    assert allowed.headers["content-type"] == "video/mp4"
    assert "attachment" in allowed.headers["content-disposition"]
    assert f"analysis-{task_id}.mp4" in allowed.headers["content-disposition"]
    assert allowed.headers["cache-control"] == "private, no-store"
    assert str(result_file) not in str(allowed.headers)


def test_visualization_file_requires_valid_index_and_stays_under_storage(
    api_context: ApiContext,
) -> None:
    chart = api_context.storage_dir / "chart.png"
    chart.write_bytes(b"png-result")
    with api_context.session_factory() as session:
        task = AnalysisTask(
            user_id=api_context.owner.id,
            status="succeeded",
            progress=100,
            options_json={},
            result_json={"visualizations": ["chart.png", "../main.py"]},
        )
        session.add(task)
        session.commit()
        task_id = task.id
        api_context.service.add_task(task)
    api_context.authenticate(api_context.owner)

    missing_index = api_context.client.get(
        f"/api/analysis/tasks/{task_id}/files/visualization"
    )
    out_of_range = api_context.client.get(
        f"/api/analysis/tasks/{task_id}/files/visualization?index=2"
    )
    traversal = api_context.client.get(
        f"/api/analysis/tasks/{task_id}/files/visualization?index=1"
    )
    allowed = api_context.client.get(
        f"/api/analysis/tasks/{task_id}/files/visualization?index=0"
    )

    assert missing_index.status_code == 422
    assert out_of_range.status_code == 404
    assert traversal.status_code == 404
    assert allowed.status_code == 200
    assert allowed.content == b"png-result"
    assert allowed.headers["content-type"] == "image/png"
    assert f"analysis-{task_id}-chart-1.png" in allowed.headers["content-disposition"]
    assert allowed.headers["cache-control"] == "private, no-store"


def test_structured_results_are_private_and_highlight_edits_preserve_system_values(
    api_context: ApiContext,
) -> None:
    analytics_path = api_context.storage_dir / "result" / "analytics.json"
    highlights_path = api_context.storage_dir / "result" / "highlights.json"
    analytics_path.parent.mkdir(parents=True)
    analytics_path.write_text(
        '{"schema_version":"2.0","match":{"duration_sec":{"value":30,"unit":"s","source":"metadata","confidence":"high"},"rally_count":{"value":1,"unit":"count","source":"detections","confidence":"high"}},"players":{},"rallies":[]}',
        encoding="utf-8",
    )
    highlights_path.write_text(
        '{"schema_version":"1.0","items":[{"id":"highlight-1","source":"system_recommended","start_sec":12.0,"end_sec":20.0,"system_start_sec":12.0,"system_end_sec":20.0,"selected":true,"reasons":["持续 8 秒"]}]}',
        encoding="utf-8",
    )
    with api_context.session_factory() as session:
        task = AnalysisTask(
            user_id=api_context.owner.id,
            status="succeeded",
            progress=100,
            options_json={},
            result_json={
                "analytics": "result/analytics.json",
                "highlights": "result/highlights.json",
            },
        )
        session.add(task)
        session.commit()
        task_id = task.id
        api_context.service.add_task(task)

    api_context.authenticate(api_context.other)
    hidden = api_context.client.get(f"/api/analysis/tasks/{task_id}/analytics")
    api_context.authenticate(api_context.owner)
    analytics = api_context.client.get(f"/api/analysis/tasks/{task_id}/analytics")
    updated = api_context.client.put(
        f"/api/analysis/tasks/{task_id}/highlights/highlight-1",
        json={"start_sec": 13.5, "end_sec": 19.0, "selected": False, "title": "我的防守回合"},
    )
    highlights = api_context.client.get(f"/api/analysis/tasks/{task_id}/highlights")

    assert hidden.status_code == 404
    assert analytics.status_code == 200
    assert analytics.json()["match"]["rally_count"]["value"] == 1
    assert str(api_context.storage_dir) not in analytics.text
    assert updated.status_code == 200
    item = highlights.json()["items"][0]
    assert item["source"] == "user_edited"
    assert item["start_sec"] == 13.5
    assert item["end_sec"] == 19.0
    assert item["selected"] is False
    assert item["title"] == "我的防守回合"
    assert item["system_start_sec"] == 12.0
    assert item["system_end_sec"] == 20.0


def test_report_share_uses_hashed_expiring_revocable_token(api_context: ApiContext) -> None:
    report = api_context.storage_dir / "result" / "report.html"
    report.parent.mkdir(parents=True)
    report.write_text("<h1>Private report</h1>", encoding="utf-8")
    with api_context.session_factory() as session:
        task = AnalysisTask(
            user_id=api_context.owner.id,
            status="succeeded",
            progress=100,
            options_json={},
            result_json={"report": "result/report.html"},
        )
        session.add(task)
        session.commit()
        task_id = task.id
        api_context.service.add_task(task)
    api_context.authenticate(api_context.owner)

    created = api_context.client.post(
        f"/api/analysis/tasks/{task_id}/shares",
        json={"resource_kind": "report", "expires_in_hours": 24},
    )
    assert created.status_code == 201
    share_path = created.json()["share_path"]
    token = share_path.rsplit("/", 1)[-1]
    shared = api_context.client.get(share_path)

    assert shared.status_code == 200
    assert b"Private report" in shared.content
    assert str(api_context.storage_dir) not in created.text
    with api_context.session_factory() as session:
        from app.db.models.share_link import ShareLink

        stored = session.get(ShareLink, UUID(created.json()["id"]))
        assert stored is not None
        assert stored.token_hash != token
        assert len(stored.token_hash) == 64

    revoked = api_context.client.delete(
        f"/api/analysis/tasks/{task_id}/shares/{created.json()['id']}"
    )
    denied = api_context.client.get(share_path)
    assert revoked.status_code == 204
    assert denied.status_code == 410

    second = api_context.client.post(
        f"/api/analysis/tasks/{task_id}/shares",
        json={"resource_kind": "report", "expires_in_hours": 1},
    )
    second_path = second.json()["share_path"]
    with api_context.session_factory() as session:
        from app.db.models.share_link import ShareLink

        expiring = session.get(ShareLink, UUID(second.json()["id"]))
        assert expiring is not None
        expiring.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.commit()
    assert api_context.client.get(second_path).status_code == 410
