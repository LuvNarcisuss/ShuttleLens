from __future__ import annotations

import base64
import csv
import html
import json
import math
from pathlib import Path
from typing import Any, Iterable


PLAYERS = ("upper", "lower")


def _metric(value: float | int | None, unit: str, source: str, confidence: str = "high") -> dict[str, Any]:
    return {
        "value": value,
        "unit": unit,
        "source": source,
        "confidence": confidence,
        "available": value is not None,
    }


def _read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as source:
        payload = json.load(source)
    if not isinstance(payload, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return payload


def _read_detections(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(raw, dict):
                continue
            try:
                frame = int(raw["frame"])
                time_sec = float(raw.get("time_sec", 0.0))
            except (KeyError, TypeError, ValueError):
                continue
            raw["frame"] = frame
            raw["time_sec"] = time_sec
            records.append(raw)
    records.sort(key=lambda item: (item["frame"], item["time_sec"]))
    return records


def _court_point(record: dict[str, Any], player: str) -> tuple[float, float] | None:
    players = record.get("players")
    item = players.get(player) if isinstance(players, dict) else None
    point = item.get("court") if isinstance(item, dict) else None
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        return None
    try:
        x, y = float(point[0]), float(point[1])
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return x, y


def _split_rallies(records: list[dict[str, Any]], rally_gap_frames: int, min_rally_frames: int) -> list[list[dict[str, Any]]]:
    if not records:
        return []
    groups: list[list[dict[str, Any]]] = []
    current = [records[0]]
    for record in records[1:]:
        if record["frame"] - current[-1]["frame"] > rally_gap_frames:
            if len(current) >= min_rally_frames:
                groups.append(current)
            current = []
        current.append(record)
    if len(current) >= min_rally_frames:
        groups.append(current)
    return groups


def _player_metrics(
    records: Iterable[dict[str, Any]],
    *,
    player: str,
    fps: float,
    court_width: float,
    court_length: float,
    rally_gap_frames: int,
) -> dict[str, Any]:
    points: list[tuple[int, float, float, float, float | None]] = []
    for record in records:
        point = _court_point(record, player)
        if point is None:
            continue
        speed: float | None = None
        item = (record.get("players") or {}).get(player) if isinstance(record.get("players"), dict) else None
        if isinstance(item, dict) and isinstance(item.get("speed"), (int, float)):
            candidate = float(item["speed"])
            speed = candidate if math.isfinite(candidate) and candidate >= 0 else None
        points.append((record["frame"], record["time_sec"], point[0], point[1], speed))

    distance = 0.0
    speeds: list[float] = []
    transitions = 0
    possible_transitions = 0
    zone_counts = {"front": 0, "mid": 0, "back": 0}
    side_counts = {"left": 0, "right": 0}
    for previous, current in zip(points, points[1:]):
        if current[0] - previous[0] > rally_gap_frames:
            continue
        possible_transitions += 1
        dx = current[2] - previous[2]
        dy = current[3] - previous[3]
        segment = math.hypot(dx, dy)
        distance += segment
        dt = current[1] - previous[1]
        if dt <= 0 and fps > 0:
            dt = (current[0] - previous[0]) / fps
        if dt > 0:
            speeds.append(segment / dt)
        transitions += 1
    for _, _, x, y, _ in points:
        if court_length > 0:
            ratio = max(0.0, min(0.999999, y / court_length))
            zone_counts["front" if ratio < 1 / 3 else "mid" if ratio < 2 / 3 else "back"] += 1
        if court_width > 0:
            side_counts["left" if x < court_width / 2 else "right"] += 1

    area = 0.0
    if points and court_width > 0 and court_length > 0:
        xs = [point[2] for point in points]
        ys = [point[3] for point in points]
        area = max(0.0, (max(xs) - min(xs)) * (max(ys) - min(ys)))
    sample_count = len(points)
    zone_total = sum(zone_counts.values()) or 1
    side_total = sum(side_counts.values()) or 1
    supplied_speeds = [point[4] for point in points if point[4] is not None]
    max_speed = max(supplied_speeds or speeds, default=0.0)
    average_speed = (sum(speeds) / len(speeds)) if speeds else 0.0
    source = "detections.jsonl:court"
    return {
        "distance_m": _metric(round(distance, 2), "m", source),
        "average_speed_mps": _metric(round(average_speed, 2), "m/s", source),
        "maximum_speed_mps": _metric(round(max_speed, 2), "m/s", source),
        "court_coverage_ratio": _metric(round(min(1.0, area / (court_width * court_length)), 4), "ratio", source),
        "zones": {key: round(value / zone_total, 4) for key, value in zone_counts.items()},
        "sides": {key: round(value / side_total, 4) for key, value in side_counts.items()},
        "valid_samples": sample_count,
        "valid_transitions": transitions,
        "possible_transitions": possible_transitions,
    }


def _rally_payload(
    group: list[dict[str, Any]],
    index: int,
    *,
    fps: float,
    metrics: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    start = group[0]
    end = group[-1]
    duration = max(0.0, end["time_sec"] - start["time_sec"] + (1 / fps if fps > 0 else 0.0))
    return {
        "id": f"rally-{index}",
        "index": index,
        "start_frame": start["frame"],
        "end_frame": end["frame"],
        "start_sec": round(start["time_sec"], 3),
        "end_sec": round(end["time_sec"] + (1 / fps if fps > 0 else 0.0), 3),
        "duration_sec": round(duration, 3),
        "players": metrics,
    }


def _quality(records: list[dict[str, Any]], rallies: list[list[dict[str, Any]]], player_metrics: dict[str, dict[str, Any]]) -> dict[str, Any]:
    slots = len(records) * len(PLAYERS)
    valid = sum(player_metrics[player]["valid_samples"] for player in PLAYERS)
    valid_ratio = valid / slots if slots else 0.0
    transitions = sum(player_metrics[player]["valid_transitions"] for player in PLAYERS)
    possible = sum(player_metrics[player]["possible_transitions"] for player in PLAYERS)
    continuity = transitions / possible if possible else (1.0 if rallies else 0.0)
    confidence = "high" if valid_ratio >= 0.8 else "medium" if valid_ratio >= 0.5 else "low"
    return {
        "confidence": confidence,
        "score": round((valid_ratio + continuity) / 2, 4),
        "valid_coordinate_ratio": round(valid_ratio, 4),
        "trajectory_continuity_ratio": round(continuity, 4),
        "explanation": f"有效坐标覆盖 {valid_ratio:.0%}，回合内轨迹连续率 {continuity:.0%}。",
    }


def build_match_analytics(
    detections_path: str | Path,
    metadata_path: str | Path,
    *,
    rally_gap_frames: int = 45,
    min_rally_frames: int = 3,
) -> dict[str, Any]:
    detections_file = Path(detections_path)
    metadata = _read_json(Path(metadata_path))
    records = _read_detections(detections_file)
    video = metadata.get("video") if isinstance(metadata.get("video"), dict) else {}
    court = metadata.get("court") if isinstance(metadata.get("court"), dict) else {}
    coordinate = court.get("coordinate_system") if isinstance(court.get("coordinate_system"), dict) else {}
    fps = float(video.get("fps") or 0.0)
    duration = video.get("duration_sec")
    if not isinstance(duration, (int, float)) or duration <= 0:
        duration = (records[-1]["time_sec"] + (1 / fps if fps > 0 else 0.0)) if records else 0.0
    court_width = float(coordinate.get("width") or 6.1)
    court_length = float(coordinate.get("length") or 13.4)
    rallies_raw = _split_rallies(records, max(1, int(rally_gap_frames)), max(1, int(min_rally_frames)))
    all_metrics = {
        player: _player_metrics(records, player=player, fps=fps, court_width=court_width, court_length=court_length, rally_gap_frames=rally_gap_frames)
        for player in PLAYERS
    }
    rallies: list[dict[str, Any]] = []
    for index, group in enumerate(rallies_raw, 1):
        group_metrics = {
            player: _player_metrics(group, player=player, fps=fps, court_width=court_width, court_length=court_length, rally_gap_frames=rally_gap_frames)
            for player in PLAYERS
        }
        rallies.append(_rally_payload(group, index, fps=fps, metrics=group_metrics))

    durations = [rally["duration_sec"] for rally in rallies]
    source = "detections.jsonl:frame_gaps"
    match = {
        "duration_sec": _metric(round(float(duration), 3), "s", "metadata.json"),
        "rally_count": _metric(len(rallies), "count", source),
        "average_rally_duration_sec": _metric(round(sum(durations) / len(durations), 3) if durations else 0.0, "s", source),
        "longest_rally_duration_sec": _metric(round(max(durations), 3) if durations else 0.0, "s", source),
    }
    return {
        "schema_version": "2.0",
        "video": {key: video.get(key) for key in ("name", "fps", "total_frames", "width", "height") if key in video},
        "quality": _quality(records, rallies_raw, all_metrics),
        "match": match,
        "players": {player: {key: value for key, value in all_metrics[player].items() if key not in {"valid_transitions", "possible_transitions"}} for player in PLAYERS},
        "rallies": rallies,
        "sources": {"metadata": "metadata.json", "detections": "detections.jsonl", "court_unit": coordinate.get("unit", "meter")},
    }


def _build_highlights(analytics: dict[str, Any]) -> dict[str, Any]:
    rallies = analytics.get("rallies") or []
    if not rallies:
        return {"schema_version": "1.0", "items": []}
    max_duration = max(float(item.get("duration_sec") or 0) for item in rallies) or 1.0
    items = []
    for rally in rallies:
        players = rally.get("players") or {}
        distance = sum(float(((players.get(player) or {}).get("distance_m") or {}).get("value") or 0) for player in PLAYERS)
        max_speed = max(float(((players.get(player) or {}).get("maximum_speed_mps") or {}).get("value") or 0) for player in PLAYERS)
        duration = float(rally.get("duration_sec") or 0)
        reasons = [f"持续 {duration:.1f} 秒", f"双方合计移动 {distance:.1f} 米", f"回合最高速度 {max_speed:.1f} 米/秒"]
        items.append({
            "id": f"highlight-{rally.get('index')}",
            "rally_id": rally.get("id"),
            "source": "system_recommended",
            "score": round(min(1.0, duration / max_duration), 4),
            "start_sec": rally.get("start_sec"),
            "end_sec": rally.get("end_sec"),
            "system_start_sec": rally.get("start_sec"),
            "system_end_sec": rally.get("end_sec"),
            "selected": True,
            "reasons": reasons,
            "exchange_count": None,
            "exchange_count_reason": "击球事件识别尚未启用，暂不提供攻防往返次数。",
        })
    return {"schema_version": "1.0", "items": items}


def _write_summary_csv(path: Path, analytics: dict[str, Any]) -> None:
    rows: list[dict[str, Any]] = []
    for metric_name, metric in (analytics.get("match") or {}).items():
        rows.append({"scope": "match", "scope_id": "match", "metric": metric_name, "value": metric.get("value"), "unit": metric.get("unit"), "source": metric.get("source"), "confidence": metric.get("confidence")})
    for player, metrics in (analytics.get("players") or {}).items():
        for metric_name in ("distance_m", "average_speed_mps", "maximum_speed_mps", "court_coverage_ratio"):
            metric = metrics.get(metric_name) or {}
            rows.append({"scope": "player", "scope_id": player, "metric": metric_name, "value": metric.get("value"), "unit": metric.get("unit"), "source": metric.get("source"), "confidence": metric.get("confidence")})
    for rally in analytics.get("rallies") or []:
        rows.append({"scope": "rally", "scope_id": rally.get("id"), "metric": "duration_sec", "value": rally.get("duration_sec"), "unit": "s", "source": "detections.jsonl:frame_gaps", "confidence": "high"})
    with path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=["scope", "scope_id", "metric", "value", "unit", "source", "confidence"])
        writer.writeheader()
        writer.writerows(rows)


def _write_report(path: Path, analytics: dict[str, Any], highlights: dict[str, Any], output_dir: Path) -> None:
    name = html.escape(str((analytics.get("video") or {}).get("name") or "比赛视频"))
    duration = float((((analytics.get("match") or {}).get("duration_sec") or {}).get("value")) or 0)
    rally_count = int((((analytics.get("match") or {}).get("rally_count") or {}).get("value")) or 0)
    upper_distance = float((((analytics.get("players") or {}).get("upper") or {}).get("distance_m") or {}).get("value") or 0)
    lower_distance = float((((analytics.get("players") or {}).get("lower") or {}).get("distance_m") or {}).get("value") or 0)
    images: list[str] = []
    visualization_dir = output_dir / "position_visualizations"
    if visualization_dir.is_dir():
        for image in sorted(visualization_dir.rglob("*")):
            if image.is_file() and image.suffix.lower() in {".png", ".jpg", ".jpeg"}:
                encoded = base64.b64encode(image.read_bytes()).decode("ascii")
                mime = "image/png" if image.suffix.lower() == ".png" else "image/jpeg"
                images.append(f'<img src="data:{mime};base64,{encoded}" alt="{html.escape(image.stem)}">')
    rally_rows = "".join(f"<tr><td>{item.get('index')}</td><td>{item.get('start_sec')}</td><td>{item.get('end_sec')}</td><td>{item.get('duration_sec')}</td></tr>" for item in analytics.get("rallies") or [])
    image_html = "".join(images)
    report = (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>羽毛球分析报告</title>"
        "<style>body{font-family:sans-serif;max-width:900px;margin:40px auto;line-height:1.6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}img{max-width:100%}</style></head><body>"
        f"<h1>{name} 分析报告</h1><p>比赛时长：{duration:.1f} 秒；有效回合：{rally_count}。</p><h2>核心指标</h2>"
        f"<p>上场球员移动 {upper_distance:.2f} 米；下场球员移动 {lower_distance:.2f} 米。</p>{image_html}"
        "<h2>回合摘要</h2><table><thead><tr><th>回合</th><th>开始秒</th><th>结束秒</th><th>持续秒</th></tr></thead><tbody>"
        f"{rally_rows}</tbody></table><h2>数据质量说明</h2><p>{html.escape(str((analytics.get('quality') or {}).get('explanation') or '暂无质量说明'))}</p></body></html>"
    )
    path.write_text(report, encoding="utf-8")


def write_analysis_artifacts(
    detections_path: str | Path,
    metadata_path: str | Path,
    output_dir: str | Path,
    *,
    rally_gap_frames: int = 45,
    min_rally_frames: int = 3,
) -> dict[str, str]:
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    analytics = build_match_analytics(detections_path, metadata_path, rally_gap_frames=rally_gap_frames, min_rally_frames=min_rally_frames)
    highlights = _build_highlights(analytics)
    analytics_path = destination / "analytics.json"
    highlights_path = destination / "highlights.json"
    summary_path = destination / "summary.csv"
    report_path = destination / "report.html"
    analytics_path.write_text(json.dumps(analytics, ensure_ascii=False, indent=2), encoding="utf-8")
    highlights_path.write_text(json.dumps(highlights, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_summary_csv(summary_path, analytics)
    _write_report(report_path, analytics, highlights, destination)
    return {"analytics": str(analytics_path), "highlights": str(highlights_path), "summary_csv": str(summary_path), "report": str(report_path)}


__all__ = ["build_match_analytics", "write_analysis_artifacts"]
