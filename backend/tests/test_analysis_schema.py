import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.db.models.analysis_task import AnalysisTask
from app.db.models.user import User
from app.api.analysis import get_career_stats
from app.core.config import Settings
from app.schemas.analysis import CornersRequest, TaskListResponse, TaskOptions, TaskResponse


def test_task_options_match_webui_defaults() -> None:
    options = TaskOptions()
    assert options.model_dump() == {
        "pose_family": "yolo-pose",
        "pose_mode": "balanced",
        "language": "zh",
        "audio": True,
        "show_skeletons": True,
        "show_player_trajectories": True,
        "show_court_trajectory": True,
        "show_shuttlecock_trajectory": True,
        "show_player_stats": True,
        "show_pose_roi": True,
        "visualize_positions": True,
        "yolo_pose_model": "weights/yolo11n-pose.pt",
        "ball_model": "weights/yolo11s-ball.pt",
    }


def test_corners_request_requires_exactly_four_integer_coordinate_pairs() -> None:
    request = CornersRequest(corners=[(0, 0), (1, 0), (1, 1), (0, 1)])
    assert request.corners == [(0, 0), (1, 0), (1, 1), (0, 1)]
    with pytest.raises(ValidationError):
        CornersRequest(corners=[(0, 0), (1, 0), (1, 1)])
    with pytest.raises(ValidationError):
        CornersRequest(corners=[(0, 0), (1, 0), (1, 1), ("0", 1)])


def test_task_responses_expose_task_summary_without_storage_paths() -> None:
    response = TaskResponse(
        id="00000000-0000-0000-0000-000000000000",
        status="succeeded",
        progress=100,
        options=TaskOptions(),
        corners=[(0, 0), (1, 0), (1, 1), (0, 1)],
        result={"video_url": "/media/tasks/demo.mp4"},
        error_message=None,
        created_at=datetime(2026, 7, 21, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 21, tzinfo=timezone.utc),
    )
    listing = TaskListResponse(items=[response], total=1)
    assert listing.total == 1
    assert listing.items[0].status == "succeeded"
    assert "input_video_path" not in response.model_dump()
    assert "template_path" not in response.model_dump()
    invalid_payload = response.model_dump()
    invalid_payload["status"] = "completed"
    with pytest.raises(ValidationError):
        TaskResponse(**invalid_payload)


def test_analysis_task_persists_created_defaults_and_empty_upload_paths() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(openid="analysis-task-user", account_number="10000002")
        session.add(user)
        session.flush()
        task = AnalysisTask(user_id=user.id)
        session.add(task)
        session.flush()
        assert task.status == "created"
        assert task.progress == 0
        assert task.input_video_path == ""
        assert task.template_path == ""


def test_career_stats_uses_the_selected_player_and_excludes_skipped_tasks(tmp_path) -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    (tmp_path / "selected.json").write_text(json.dumps({
        "match": {"duration_sec": {"value": 120}, "rally_count": {"value": 8}},
        "players": {"lower": {
            "average_speed_mps": {"value": 2},
            "maximum_speed_mps": {"value": 4},
            "distance_m": {"value": 30},
            "court_coverage_ratio": {"value": 0.25},
        }},
    }), encoding="utf-8")
    (tmp_path / "skipped.json").write_text(json.dumps({
        "match": {"duration_sec": {"value": 999}, "rally_count": {"value": 999}},
        "players": {"upper": {"average_speed_mps": {"value": 999}}},
    }), encoding="utf-8")

    with Session(engine) as session:
        user = User(openid="career-user", account_number="10000005")
        session.add(user)
        session.flush()
        session.add_all([
            AnalysisTask(user_id=user.id, status="succeeded", player_position="lower", match_result="win", result_json={"analytics": "selected.json"}),
            AnalysisTask(user_id=user.id, status="succeeded", player_position="skip", match_result="loss", result_json={"analytics": "skipped.json"}),
        ])
        session.commit()

        stats = get_career_stats(current_user=user, db=session, settings=Settings(analysis_storage_dir=str(tmp_path)))

    assert stats.total_matches == 1
    assert stats.matched_matches == 1
    assert stats.total_duration_sec == 120
    assert stats.total_rallies == 8
    assert stats.avg_speed_mps == 2
    assert stats.max_speed_mps == 4
    assert stats.total_distance_m == 30
    assert stats.win_count == 1
    assert stats.loss_count == 0


def test_career_stats_recent_matches_follow_task_list_order(tmp_path) -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    (tmp_path / "ordered.json").write_text(json.dumps({
        "match": {"duration_sec": {"value": 1}, "rally_count": {"value": 1}},
        "players": {"lower": {"average_speed_mps": {"value": 1}}},
    }), encoding="utf-8")

    old_task_id = UUID("00000000-0000-0000-0000-000000000010")
    latest_lower_id = UUID("00000000-0000-0000-0000-000000000001")
    latest_higher_id = UUID("00000000-0000-0000-0000-000000000002")
    latest_created_at = datetime(2026, 8, 20, 8, 3, tzinfo=timezone.utc)

    with Session(engine) as session:
        user = User(openid="career-order-user", account_number="10000006")
        session.add(user)
        session.flush()
        session.add_all([
            AnalysisTask(
                id=old_task_id,
                user_id=user.id,
                status="succeeded",
                player_position="lower",
                match_result="win",
                result_json={"analytics": "ordered.json"},
                created_at=datetime(2026, 8, 19, 11, 43, tzinfo=timezone.utc),
            ),
            AnalysisTask(
                id=latest_lower_id,
                user_id=user.id,
                status="succeeded",
                player_position="lower",
                match_result="loss",
                result_json={"analytics": "ordered.json"},
                created_at=latest_created_at,
            ),
            AnalysisTask(
                id=latest_higher_id,
                user_id=user.id,
                status="succeeded",
                player_position="lower",
                match_result="draw",
                result_json={"analytics": "ordered.json"},
                created_at=latest_created_at,
            ),
        ])
        session.commit()

        stats = get_career_stats(
            current_user=user,
            db=session,
            settings=Settings(analysis_storage_dir=str(tmp_path)),
        )

    assert [match["task_id"] for match in stats.recent_matches] == [
        str(latest_higher_id),
        str(latest_lower_id),
        str(old_task_id),
    ]
