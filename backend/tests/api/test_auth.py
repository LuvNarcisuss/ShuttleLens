from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from uuid import UUID

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import Settings, get_settings
from app.core.security import create_access_token
from app.db.base import Base
from app.db.models.user import User
from app.db.session import get_db
from app.main import app
from app.services.user_onboarding import normalize_phone
from app.services.wechat_auth import WechatAuthClient, WechatAuthError


class StubResponse:
    def __init__(self, payload: dict[str, object], status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://api.weixin.qq.com")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("upstream", request=request, response=response)

    def json(self) -> dict[str, object]:
        return self.payload


def live_settings() -> Settings:
    return Settings(
        database_url="mysql+pymysql://user:password@localhost/database",
        wechat_auth_mode="live",
        wechat_app_id="wx-app-id",
        wechat_app_secret="server-only-secret",
        phone_encryption_key="test-phone-encryption-key",
    )


def test_login_code_only_calls_jscode2session(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_get(url: str, **kwargs: object) -> StubResponse:
        captured.update(url=url, **kwargs)
        return StubResponse({"openid": "server-only-openid", "session_key": "server-only-key"})

    def reject_post(*args: object, **kwargs: object) -> None:
        raise AssertionError("login code must not enter the phone exchange")

    monkeypatch.setattr("app.services.wechat_auth.httpx.get", fake_get)
    monkeypatch.setattr("app.services.wechat_auth.httpx.post", reject_post)

    assert WechatAuthClient(live_settings()).code_to_openid("login-code") == "server-only-openid"
    assert captured["url"] == "https://api.weixin.qq.com/sns/jscode2session"
    assert captured["params"]["js_code"] == "login-code"  # type: ignore[index]


def test_phone_code_only_calls_get_phone_number(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def reject_get(*args: object, **kwargs: object) -> None:
        raise AssertionError("phone code must not enter jscode2session")

    def fake_post(url: str, **kwargs: object) -> StubResponse:
        calls.append((url, kwargs))
        if url.endswith("/cgi-bin/stable_token"):
            return StubResponse({"access_token": "server-only-access-token", "expires_in": 7200})
        return StubResponse(
            {
                "phone_info": {
                    "phoneNumber": "18712342735",
                    "purePhoneNumber": "18712342735",
                    "countryCode": "86",
                    "watermark": {"appid": "wx-app-id", "timestamp": 1},
                }
            }
        )

    monkeypatch.setattr("app.services.wechat_auth.httpx.get", reject_get)
    monkeypatch.setattr("app.services.wechat_auth.httpx.post", fake_post)

    info = WechatAuthClient(live_settings()).code_to_phone("phone-code")

    assert info.pure_phone_number == "18712342735"
    assert info.country_code == "86"
    assert calls[1][0].startswith("https://api.weixin.qq.com/wxa/business/getuserphonenumber")
    assert calls[1][1]["json"] == {"code": "phone-code"}
    assert "server-only-access-token" in calls[1][0]


@pytest.mark.parametrize(
    ("errcode", "expected_code"),
    [
        (40029, "WECHAT_PHONE_CODE_INVALID"),
        (40163, "WECHAT_PHONE_CODE_EXPIRED"),
        (45009, "WECHAT_PHONE_QUOTA_EXHAUSTED"),
    ],
)
def test_phone_exchange_maps_wechat_business_errors(
    monkeypatch: pytest.MonkeyPatch,
    errcode: int,
    expected_code: str,
) -> None:
    responses = iter(
        [
            StubResponse({"access_token": "server-only-access-token"}),
            StubResponse({"errcode": errcode, "errmsg": "upstream details"}),
        ]
    )
    monkeypatch.setattr(
        "app.services.wechat_auth.httpx.post", lambda *args, **kwargs: next(responses)
    )

    with pytest.raises(WechatAuthError) as captured:
        WechatAuthClient(live_settings()).code_to_phone("phone-code")

    assert captured.value.code == expected_code
    assert "phone-code" not in str(captured.value)


def test_phone_exchange_maps_timeout_without_leaking_code(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(*args: object, **kwargs: object) -> None:
        raise httpx.TimeoutException("phone-code leaked by upstream")

    monkeypatch.setattr("app.services.wechat_auth.httpx.post", timeout)

    with pytest.raises(WechatAuthError) as captured:
        WechatAuthClient(live_settings()).code_to_phone("phone-code")

    assert captured.value.code == "WECHAT_UPSTREAM_UNAVAILABLE"
    assert "phone-code" not in str(captured.value)


@dataclass
class ApiContext:
    client: TestClient
    session_factory: sessionmaker[Session]
    settings: Settings
    fake_wechat: object

    def create_user(self, openid: str) -> User:
        with self.session_factory() as session:
            from app.services.account_auth import generate_account_number
            account_number = generate_account_number(session)
            user = User(openid=openid, account_number=account_number)
            session.add(user)
            session.commit()
            session.refresh(user)
            session.expunge(user)
            return user

    def headers_for(self, user: User) -> dict[str, str]:
        token = create_access_token(user.id, self.settings)
        return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def api_context(monkeypatch: pytest.MonkeyPatch) -> Iterator[ApiContext]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    settings = Settings(
        database_url="mysql+pymysql://user:password@localhost/database",
        jwt_secret="test-jwt-secret-at-least-32-bytes-long",
        phone_encryption_key="test-phone-encryption-key",
    )
    fake_wechat = SimpleNamespace(
        code_to_openid=lambda login_code: f"openid-{login_code}",
        code_to_phone=lambda phone_code: SimpleNamespace(
            pure_phone_number="18712342735",
            country_code="86",
            watermark_appid="wx-app-id",
        ),
    )

    def override_db() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_settings] = lambda: settings
    monkeypatch.setattr("app.api.auth.WechatAuthClient", lambda _: fake_wechat)
    try:
        yield ApiContext(TestClient(app), session_factory, settings, fake_wechat)
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_wechat_login_uses_login_code_and_returns_phone_pending(api_context: ApiContext) -> None:
    response = api_context.client.post(
        "/api/auth/wechat/login", json={"login_code": "test-login-code"}
    )

    assert response.status_code == 200
    assert response.json()["user"]["onboarding_status"] == "phone_pending"
    assert response.json()["required_steps"] == ["bind_phone", "complete_profile"]
    assert "openid" not in response.text
    assert "session_key" not in response.text


def test_onboarding_resumes_at_profile_then_existing_user_logs_in_active(
    api_context: ApiContext,
) -> None:
    first_login = api_context.client.post(
        "/api/auth/wechat/login", json={"login_code": "resume-flow"}
    )
    headers = {"Authorization": f"Bearer {first_login.json()['access_token']}"}
    phone = api_context.client.post(
        "/api/auth/wechat/phone",
        json={"phone_code": "phone-code"},
        headers=headers,
    )
    profile = api_context.client.put(
        "/api/auth/me",
        json={
            "nickname": "羽球小将",
            "avatar_url": "https://cdn.example.com/avatar.jpg",
        },
        headers=headers,
    )
    current = api_context.client.get("/api/auth/me", headers=headers)
    returning_login = api_context.client.post(
        "/api/auth/wechat/login", json={"login_code": "resume-flow"}
    )

    assert phone.json()["onboarding_status"] == "profile_pending"
    assert profile.json()["onboarding_status"] == "active"
    assert current.json()["required_steps"] == []
    assert returning_login.json()["required_steps"] == []
    assert returning_login.json()["user"]["nickname"] == "羽球小将"
    assert returning_login.json()["user"]["masked_phone"] == "187****2735"


def test_phone_binding_encrypts_phone_and_returns_only_masked_value(
    api_context: ApiContext,
) -> None:
    user = api_context.create_user("phone-owner")

    response = api_context.client.post(
        "/api/auth/wechat/phone",
        json={"phone_code": "phone-code"},
        headers=api_context.headers_for(user),
    )

    assert response.status_code == 200
    assert response.json()["masked_phone"] == "187****2735"
    assert response.json()["onboarding_status"] == "profile_pending"
    assert "18712342735" not in response.text
    with api_context.session_factory() as session:
        stored = session.get(User, user.id)
        assert stored is not None
        assert stored.phone_number_encrypted not in {None, "+8618712342735", "18712342735"}
        assert stored.phone_number_hash is not None
        assert stored.phone_country_code == "86"
        assert stored.phone_verified_at is not None


def test_phone_conflict_returns_409_without_merging_accounts(api_context: ApiContext) -> None:
    first = api_context.create_user("first-openid")
    second = api_context.create_user("second-openid")
    first_response = api_context.client.post(
        "/api/auth/wechat/phone",
        json={"phone_code": "first-phone-code"},
        headers=api_context.headers_for(first),
    )

    conflict = api_context.client.post(
        "/api/auth/wechat/phone",
        json={"phone_code": "same-phone-code"},
        headers=api_context.headers_for(second),
    )

    assert first_response.status_code == 200
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "PHONE_ALREADY_BOUND"
    with api_context.session_factory() as session:
        users = session.scalars(select(User).order_by(User.openid)).all()
        assert {user.openid for user in users} == {"first-openid", "second-openid"}
        assert sum(user.phone_number_hash is not None for user in users) == 1


@pytest.mark.parametrize(
    ("error_code", "status_code"),
    [
        ("WECHAT_PHONE_CODE_INVALID", 400),
        ("WECHAT_PHONE_CODE_EXPIRED", 400),
        ("WECHAT_PHONE_QUOTA_EXHAUSTED", 429),
        ("WECHAT_UPSTREAM_UNAVAILABLE", 503),
    ],
)
def test_phone_binding_preserves_distinct_upstream_errors(
    api_context: ApiContext,
    error_code: str,
    status_code: int,
) -> None:
    user = api_context.create_user(f"openid-{error_code}")

    def fail_phone(phone_code: str) -> None:
        raise WechatAuthError(error_code, "手机号验证失败", status_code)

    api_context.fake_wechat.code_to_phone = fail_phone
    response = api_context.client.post(
        "/api/auth/wechat/phone",
        json={"phone_code": "phone-code"},
        headers=api_context.headers_for(user),
    )

    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == error_code
    assert "phone-code" not in response.text


def test_wechat_unlink_requires_a_recovery_factor(api_context: ApiContext) -> None:
    user = api_context.create_user("wechat-guarded-owner")
    response = api_context.client.post(
        "/api/auth/wechat/unbind",
        headers=api_context.headers_for(user),
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WECHAT_UNBIND_REQUIRES_RECOVERY"


def test_wechat_unlink_blocks_login_until_account_is_rebound(api_context: ApiContext) -> None:
    user = api_context.create_user("openid-wechat-lifecycle")
    headers = api_context.headers_for(user)
    password = api_context.client.post(
        "/api/auth/account/password",
        json={"password": "safe-password-123"},
        headers=headers,
    )
    unbound = api_context.client.post("/api/auth/wechat/unbind", headers=headers)
    blocked_login = api_context.client.post(
        "/api/auth/wechat/login",
        json={"login_code": "wechat-lifecycle"},
    )
    rebound = api_context.client.post(
        "/api/auth/wechat/bind",
        json={"login_code": "wechat-lifecycle"},
        headers=headers,
    )

    assert password.status_code == 200
    assert unbound.status_code == 200
    assert unbound.json()["wechat_bound"] is False
    assert blocked_login.status_code == 409
    assert blocked_login.json()["detail"]["code"] == "WECHAT_UNBOUND_REQUIRES_REBIND"
    assert rebound.status_code == 200
    assert rebound.json()["wechat_bound"] is True


def test_deactivate_soft_closes_account_and_preserves_user_row(api_context: ApiContext) -> None:
    user = api_context.create_user("openid-deactivate-owner")
    headers = api_context.headers_for(user)

    response = api_context.client.post("/api/auth/deactivate", headers=headers)
    current = api_context.client.get("/api/auth/me", headers=headers)
    login = api_context.client.post(
        "/api/auth/wechat/login",
        json={"login_code": "deactivate-owner"},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "deactivated"}
    assert current.status_code == 403
    assert current.json()["detail"]["code"] == "ACCOUNT_DEACTIVATED"
    assert login.status_code == 403
    assert login.json()["detail"]["code"] == "ACCOUNT_DEACTIVATED"
    with api_context.session_factory() as session:
        stored = session.get(User, user.id)
        assert stored is not None
        assert stored.deactivated_at is not None


def test_protected_endpoint_rejects_invalid_and_expired_tokens() -> None:
    invalid = TestClient(app).get(
        "/api/auth/me", headers={"Authorization": "Bearer invalid"}
    )
    token = jwt.encode(
        {"sub": "00000000-0000-0000-0000-000000000000", "exp": 1},
        get_settings().jwt_secret,
        algorithm=get_settings().jwt_algorithm,
    )
    expired = TestClient(app).get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )

    assert invalid.status_code == 401
    assert expired.status_code == 401


def test_mock_login_codes_map_to_stable_user_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_network(*args: object, **kwargs: object) -> None:
        raise AssertionError("Mock mode must not call the WeChat network")

    monkeypatch.setattr("app.services.wechat_auth.httpx.get", fail_network)
    monkeypatch.setattr("app.services.wechat_auth.httpx.post", fail_network)
    client = WechatAuthClient(get_settings())

    assert client.code_to_openid("first-code") == "mock_local_user"
    assert client.code_to_openid("second-code") == "mock_local_user"


def test_mock_phone_codes_map_to_stable_number_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_network(*args: object, **kwargs: object) -> None:
        raise AssertionError("Mock mode must not call the WeChat network")

    monkeypatch.setattr("app.services.wechat_auth.httpx.get", fail_network)
    monkeypatch.setattr("app.services.wechat_auth.httpx.post", fail_network)
    client = WechatAuthClient(get_settings())

    first = client.code_to_phone("first-phone-code")
    second = client.code_to_phone("second-phone-code")

    assert first.pure_phone_number == "13800138000"
    assert second.pure_phone_number == "13800138000"
    assert first.country_code == second.country_code == "86"
